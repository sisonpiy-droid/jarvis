import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { eventId, googleCalendarFromEnv } from "../src/google-calendar";
import { jarvisTools } from "../src/tools";

// "I tell it to block time or add a session to my calendar and it does it, immediately." — on request only.

const NOW = new Date("2026-10-09T05:00:00.000Z"); // Fri 9 Oct, 10:30 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.lms_items restart identity cascade`;
});

const ENV = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_REFRESH_TOKEN: "rt" };
const session = (id: string, title: string, startAt: string, endAt: string) =>
  t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, course_id, title, sort_at)
        values ('event', ${id}, 'h', ${t.sql.json({ title, startAt, endAt, eventType: "session", status: "scheduled" } as never)}, 'c1', ${title}, ${startAt})`;

function fakeGoogle(eventStatus = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "at-1" });
    return eventStatus === 409 ? new Response("{}", { status: 409 }) : Response.json({ id: JSON.parse(String(init.body)).id, htmlLink: "https://calendar.google.com/event?eid=x" });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const add = (cal: ReturnType<typeof googleCalendarFromEnv>, a: Record<string, unknown>) =>
  jarvisTools(t.sql, () => NOW, { calendar: cal }).find((x) => x.name === "add_calendar_event")!.run(a) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("add_calendar_event", () => {
  it("is not connected until all three Google secrets exist — nothing is sent anywhere", async () => {
    const net = vi.fn();
    vi.stubGlobal("fetch", net);
    try {
      expect(googleCalendarFromEnv({ ...ENV, GOOGLE_REFRESH_TOKEN: undefined })).toBeNull();
      const r = await add(null, { title: "DDDM revision", start: "2026-10-10T15:00:00+05:30" });
      expect(r).toMatchObject({ added: false });
      expect(String(r.reason)).toContain("google:auth");
      expect(net).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adds the event straight away: refreshes a token, creates it in IST with a stable id", async () => {
    const g = fakeGoogle();
    const r = await add(googleCalendarFromEnv(ENV, g.f), { title: "DDDM revision", start: "2026-10-10T15:00:00+05:30", minutes: 90, notes: "Workbook 9" });
    expect(r).toMatchObject({ added: true, already_there: false, title: "DDDM revision", link: "https://calendar.google.com/event?eid=x" });
    expect(g.calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token", "https://www.googleapis.com/calendar/v3/calendars/primary/events"]);
    expect(String(g.calls[0]!.init.body)).toContain("grant_type=refresh_token");
    expect((g.calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
    const body = JSON.parse(String(g.calls[1]!.init.body));
    expect(body).toMatchObject({ summary: "DDDM revision", description: "Workbook 9", start: { dateTime: "2026-10-10T09:30:00.000Z", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-10-10T11:00:00.000Z" } });
    expect(body.id).toBe(await eventId("DDDM revision", "2026-10-10T09:30:00.000Z", "2026-10-10T11:00:00.000Z"));
    expect(body.id).toMatch(/^[a-v0-9]{5,}$/); // Google's event-id alphabet
  });

  it("asking twice for the same slot is not a second event", async () => {
    const r = await add(googleCalendarFromEnv(ENV, fakeGoogle(409).f), { title: "DDDM revision", start: "2026-10-10T15:00:00+05:30" });
    expect(r).toMatchObject({ added: true, already_there: true });
  });

  it("won't double-book a class without being told to", async () => {
    await session("e1", "Entrepreneurship 101", "2026-10-12T04:00:00Z", "2026-10-12T05:30:00Z"); // Mon 9:30–11:00 IST
    const g = fakeGoogle();
    const cal = googleCalendarFromEnv(ENV, g.f);
    const clash = await add(cal, { title: "Deep work", start: "2026-10-12T10:00:00+05:30", end: "2026-10-12T12:00:00+05:30" });
    expect(clash).toMatchObject({ added: false, clashes: [{ title: "Entrepreneurship 101" }] });
    expect(g.calls).toHaveLength(0);
    expect(await add(cal, { title: "Deep work", start: "2026-10-12T11:00:00+05:30", end: "2026-10-12T12:00:00+05:30" })).toMatchObject({ added: true }); // starts as the class ends
    expect(await add(cal, { title: "Deep work", start: "2026-10-12T10:00:00+05:30", end: "2026-10-12T12:00:00+05:30", allow_overlap: true })).toMatchObject({ added: true });
  });

  it("rejects times that make no sense", async () => {
    const cal = googleCalendarFromEnv(ENV, fakeGoogle().f);
    await expect(add(cal, { title: "x", start: "tomorrow-ish" })).rejects.toThrow(/ISO/);
    await expect(add(cal, { title: "x", start: "2026-10-10T15:00:00+05:30", end: "2026-10-10T14:00:00+05:30" })).rejects.toThrow(/after start/);
    await expect(add(cal, { title: "x", start: "2026-10-01T15:00:00+05:30" })).rejects.toThrow(/between now/);
    await expect(add(cal, { title: "x", start: "2026-10-10T08:00:00+05:30", end: "2026-10-10T22:00:00+05:30" })).rejects.toThrow(/12 hours/);
  });
});
