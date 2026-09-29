import { describe, expect, it } from "vitest";
import { eventsBetween, parseIcs, zonedToUtc } from "../src/ics";
import { normalizeInstance } from "../src/index";
import { calendarRules, headsUps } from "../../sync/src/calendar";
import { diffItems } from "../../sync/src/diff";

// Synthetic feeds only.
const cal = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((e) => `BEGIN:VEVENT\r\n${e.trim().split("\n").map((l) => l.trim()).join("\r\n")}\r\nEND:VEVENT`).join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const D = (s: string) => Date.parse(s);
const WIN = [D("2026-09-01T00:00:00Z"), D("2026-10-31T00:00:00Z")] as const;
const iso = (ms: number) => new Date(ms).toISOString();

describe("parsing", () => {
  it("unfolds lines, unescapes text and ignores VALARMs", () => {
    // Built by hand: a folded line continues with a leading space, which the helper would trim.
    const raw = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:a",
      "SUMMARY:Long title that is",
      "  folded",
      "DTSTART:20260930T090000Z",
      "BEGIN:VALARM",
      "SUMMARY:alarm-should-be-ignored",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [e] = parseIcs(raw);
    expect(e!.props.filter((p) => p.name === "SUMMARY").map((p) => p.value)).toEqual(["Long title that is folded"]);
    const inst = eventsBetween(cal(`UID:a\nSUMMARY:x\nDESCRIPTION:Line 1\\nLine 2\\, with comma\nDTSTART:20260930T090000Z`), ...WIN);
    expect(inst[0]!.description).toBe("Line 1\nLine 2, with comma");
  });
  it("converts zoned, UTC, floating and all-day times", () => {
    expect(iso(zonedToUtc(2026, 8, 30, 9, 30, 0, "Asia/Kolkata"))).toBe("2026-09-30T04:00:00.000Z");
    expect(iso(zonedToUtc(2026, 6, 1, 9, 0, 0, "Europe/London"))).toBe("2026-07-01T08:00:00.000Z"); // BST
    const ev = eventsBetween(
      cal(
        "UID:z\nSUMMARY:zoned\nDTSTART;TZID=Asia/Colombo:20260930T093000\nDTEND;TZID=Asia/Colombo:20260930T103000",
        "UID:u\nSUMMARY:utc\nDTSTART:20260930T040000Z",
        "UID:f\nSUMMARY:floating\nDTSTART:20260930T093000",
        "UID:d\nSUMMARY:all day\nDTSTART;VALUE=DATE:20261002\nDTEND;VALUE=DATE:20261003",
      ),
      ...WIN,
    );
    const by = Object.fromEntries(ev.map((e) => [e.uid, e]));
    expect(iso(by.z!.startMs)).toBe("2026-09-30T04:00:00.000Z");
    expect(by.z!.endMs - by.z!.startMs).toBe(3_600_000);
    expect(iso(by.u!.startMs)).toBe("2026-09-30T04:00:00.000Z");
    expect(iso(by.f!.startMs)).toBe("2026-09-30T04:00:00.000Z"); // floating → IST
    expect(by.d!.allDay).toBe(true);
    expect(iso(by.d!.startMs)).toBe("2026-10-01T18:30:00.000Z");
  });
  it("keeps only events overlapping the window", () => {
    expect(eventsBetween(cal("UID:old\nSUMMARY:x\nDTSTART:19700101T000000Z"), ...WIN)).toEqual([]);
  });
});

describe("recurrence", () => {
  it("expands weekly BYDAY with COUNT, honouring EXDATE", () => {
    const ev = eventsBetween(
      cal(`UID:gym
        SUMMARY:Gym
        DTSTART;TZID=Asia/Kolkata:20260907T070000
        DTEND;TZID=Asia/Kolkata:20260907T080000
        RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5
        EXDATE;TZID=Asia/Kolkata:20260909T070000`),
      ...WIN,
    );
    // Mon 7, (Wed 9 excluded), Mon 14, Wed 16, Mon 21 → COUNT counts the excluded one too
    expect(ev.map((e) => iso(e.startMs).slice(0, 10))).toEqual(["2026-09-07", "2026-09-14", "2026-09-16", "2026-09-21"]);
    expect(ev.every((e) => iso(e.startMs).endsWith("T01:30:00.000Z"))).toBe(true);
    expect(new Set(ev.map((e) => e.instanceId)).size).toBe(4);
  });
  it("stops at UNTIL and respects INTERVAL", () => {
    const ev = eventsBetween(cal("UID:x\nSUMMARY:x\nDTSTART:20260901T100000Z\nRRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20260910T235959Z"), ...WIN);
    expect(ev.map((e) => iso(e.startMs).slice(8, 10))).toEqual(["01", "04", "07", "10"]);
  });
  it("supports monthly nth weekday and yearly", () => {
    const m = eventsBetween(cal("UID:m\nSUMMARY:x\nDTSTART:20260908T100000Z\nRRULE:FREQ=MONTHLY;BYDAY=2TU"), ...WIN);
    expect(m.map((e) => iso(e.startMs).slice(0, 10))).toEqual(["2026-09-08", "2026-10-13"]);
    const y = eventsBetween(cal("UID:y\nSUMMARY:bday\nDTSTART;VALUE=DATE:20001005\nRRULE:FREQ=YEARLY"), ...WIN);
    expect(y).toHaveLength(1);
    expect(y[0]!.allDay).toBe(true);
  });
  it("applies RECURRENCE-ID overrides (moved and cancelled instances)", () => {
    const ev = eventsBetween(
      cal(
        "UID:s\nSUMMARY:Standup\nDTSTART:20260901T040000Z\nDTEND:20260901T043000Z\nRRULE:FREQ=DAILY;COUNT=3",
        "UID:s\nRECURRENCE-ID:20260902T040000Z\nSUMMARY:Standup (moved)\nDTSTART:20260902T060000Z\nDTEND:20260902T063000Z",
        "UID:s\nRECURRENCE-ID:20260903T040000Z\nSUMMARY:Standup\nSTATUS:CANCELLED\nDTSTART:20260903T040000Z",
      ),
      ...WIN,
    );
    expect(ev.map((e) => [iso(e.startMs), e.title, e.status])).toEqual([
      ["2026-09-01T04:00:00.000Z", "Standup", "confirmed"],
      ["2026-09-02T06:00:00.000Z", "Standup (moved)", "confirmed"],
      ["2026-09-03T04:00:00.000Z", "Standup", "cancelled"],
    ]);
    // The moved instance keeps its original identity so a move is a change, not delete + create.
    expect(ev[1]!.instanceId).toBe("s@2026-09-02T04:00:00.000Z");
  });
});

describe("calendar rules", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  const one = (o: string) => normalizeInstance(eventsBetween(cal(`UID:e\nSUMMARY:Dentist\nLOCATION:Clinic\n${o}`), ...WIN)[0]!);
  const stored = (e: ReturnType<typeof one>) => new Map([[e.sourceId, { sourceId: e.sourceId, contentHash: e.contentHash, data: e as never, removedAt: null, sortAt: e.startAt }]]);

  it("announces new one-off events this week, and moves keyed by the new time", () => {
    const e = one("DTSTART:20261001T050000Z");
    expect(calendarRules(diffItems(new Map(), [e], { enabled: true }), now).notifications.map((n) => n.dedupeKey)).toEqual(["gcal.created:e"]);
    const moved = one("DTSTART:20261001T070000Z");
    const r = calendarRules(diffItems(stored(e), [moved], { enabled: true }), now);
    expect(r.notifications[0]).toMatchObject({ dedupeKey: `gcal.moved:e:${moved.startAt}`, priority: "high" });
  });
  it("gives an urgent heads-up 30–35 minutes before timed events only", () => {
    const soon = one("DTSTART:20260929T103200Z");
    const later = one("DTSTART:20260929T120000Z");
    const allDay = one("DTSTART;VALUE=DATE:20260929");
    expect(headsUps([soon, later, allDay], now).map((n) => [n.dedupeKey, n.priority])).toEqual([[`gcal.soon:e:${soon.startAt}`, "urgent"]]);
  });
  it("skips recurring routines unless asked", () => {
    const routine = { ...one("DTSTART:20260929T103200Z"), recurring: true };
    expect(headsUps([routine], now)).toEqual([]);
    expect(headsUps([routine], now, true)).toHaveLength(1);
  });
});
