import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import { createLogger } from "@jarvis/shared";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { NexusClient, runNexus } from "../src/nexus";

// Grades and attendance from MESA Nexus (a fake MCP server here): quiet on the first sync, alerts after that.

vi.spyOn(console, "log").mockImplementation(() => {});
const log = createLogger("test");
const NOW = new Date("2026-10-13T07:00:00.000Z");
const TOKEN = "mesa_pat_TESTTOKEN0123456789abcdefghijklmnopqrstuv";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.grades, jarvis.attendance, jarvis.notifications, jarvis.settings restart identity cascade`;
});

const FEEDBACK = "Problem: crisp statement. Market: no market size. GTM: JTBD and channel reasoning are missing.";
const grade = (id: string, assignment: string, course: string, marks: string, maxMarks: string | null, feedback: string | null = null) => ({ assignmentId: id, assignment, course, marks, maxMarks, feedback, releasedAt: "2026-10-10T11:42:20.104Z" });
const course = (name: string, attended: number, total: number) => ({ course: name, term: "Term 1", attended, total, percentage: Math.round((attended / total) * 1000) / 10 });
const AOS = "The Art of Selling with Prof. Rishabh Ladha";
const FIN = "Fundamentals of Finance with Prof. Narahari";
const E101 = "Entrepreneurship 101 with Abhishek";

/** A fake Nexus MCP server: initialize → session id, tool calls → JSON text. Records what was called and with which header. */
function fakeNexus(state: { grades: unknown[]; courses: unknown[] }, o: { status?: number; sse?: boolean } = {}) {
  const tools: string[] = [];
  const urls: string[] = [];
  let auth = "";
  const f = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    auth = String((init.headers as Record<string, string>).authorization);
    if (o.status) return new Response("nope", { status: o.status });
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name?: string } };
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "mesa-lms" } } }, { headers: { "mcp-session-id": "s1" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    tools.push(body.params!.name!);
    const payload = body.params!.name === "get_grades" ? { reportCards: [], assignmentMarks: state.grades } : { courses: state.courses };
    const result = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
    return o.sse ? new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(result);
  }) as unknown as typeof fetch;
  return { f, tools, urls, auth: () => auth };
}

const alerts = async () => await t.sql`select dedupe_key, priority, text from jarvis.notifications order by id`;

describe("attendanceRoom", () => {
  it("how many classes can still be missed, or must be attended in a row", () => {
    expect(db.attendanceRoom({ attended: 18, total: 18 }, 85)).toEqual({ canMiss: 3, needToAttend: 0 });
    expect(db.attendanceRoom({ attended: 12, total: 13 }, 85)).toEqual({ canMiss: 1, needToAttend: 0 });
    expect(db.attendanceRoom({ attended: 11, total: 13 }, 85)).toEqual({ canMiss: 0, needToAttend: 1 });
    expect(db.attendanceRoom({ attended: 11, total: 14 }, 85)).toEqual({ canMiss: 0, needToAttend: 6 });
    expect(db.attendanceRoom({ attended: 0, total: 0 }, 85)).toEqual({ canMiss: 0, needToAttend: 0 });
  });
});

describe("the nexus job", () => {
  it("first sync: stores everything, announces no old marks, warns once about a course already under the line", async () => {
    const nx = fakeNexus({ grades: [grade("g1", "Mid-Term Assignment", AOS, "97.00", "100.00")], courses: [course(AOS, 12, 13), course(FIN, 11, 13), course("AI and its Application", 18, 18)] });
    const s = await runNexus(t.sql, TOKEN, NOW, log, nx.f);
    expect(s).toMatchObject({ grades: 1, newGrades: 0, courses: 3, attendanceAlerts: 1, queued: 1 });
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]!.dedupe_key).toBe("attendance.low:" + FIN + ":11/13");
    expect(String(a[0]!.text)).toBe("⚠️ <b>Attendance: Fundamentals of Finance</b> is 84.6% (11 of 13), under your 85% line.\nAttend the next 1 class in a row to get back to 85%.");
    expect(db.notificationMeta(String(a[0]!.dedupe_key))).toEqual({ category: "class", url: "/classes" });
    // Read-only, header auth only: the token is never in the URL, and the one write tool is never called.
    expect(nx.tools.sort()).toEqual(["get_attendance_summary", "get_grades"]);
    expect(nx.auth()).toBe(`Bearer ${TOKEN}`);
    expect(nx.urls.every((u) => !u.includes(TOKEN))).toBe(true);
  });

  it("nothing new, nothing sent; then new marks (with the feedback) and another missed class each alert once", async () => {
    const state = { grades: [grade("g1", "Mid-Term Assignment", AOS, "97.00", "100.00")], courses: [course(FIN, 11, 13)] };
    await runNexus(t.sql, TOKEN, NOW, log, fakeNexus(state).f);
    expect((await runNexus(t.sql, TOKEN, NOW, log, fakeNexus(state).f)).queued).toBe(0); // same data: silent

    state.grades.push(grade("g2", "Entrepreneurship 101 Mid-Term Assignment", E101, "51.00", "100.00", FEEDBACK));
    state.courses = [course(FIN, 11, 14)]; // missed another
    const s = await runNexus(t.sql, TOKEN, NOW, log, fakeNexus(state, { sse: true }).f); // also works over server-sent events
    expect(s).toMatchObject({ newGrades: 1, attendanceAlerts: 1, queued: 2 });
    const a = await alerts();
    expect(a.map((x) => x.dedupe_key)).toEqual(["attendance.low:" + FIN + ":11/13", "grade.released:g2", "attendance.low:" + FIN + ":11/14"]);
    expect(String(a[1]!.text)).toBe(`📊 <b>New marks</b> · Entrepreneurship 101\nEntrepreneurship 101 Mid-Term Assignment: <b>51/100</b>\n\n<b>Feedback</b>\n${FEEDBACK}`);
    expect(a[1]!.priority).toBe("high");
    expect(String(a[2]!.text)).toContain("78.6% (11 of 14)");
    expect(String(a[2]!.text)).toContain("Attend the next 6 classes in a row");
    expect(db.notificationMeta("grade.released:g2")).toEqual({ category: "assignment", url: "/assignments" });
    expect(await db.listGrades(t.sql)).toHaveLength(2);
    expect((await t.sql`select count(*)::int n from jarvis.grades where notified_at is null`)[0]!.n).toBe(0);
  });

  it("a different threshold changes who is warned; a course above the line never is", async () => {
    await db.setAttendanceThreshold(t.sql, 70);
    const nx = fakeNexus({ grades: [], courses: [course(FIN, 11, 13), course(AOS, 12, 13)] });
    expect((await runNexus(t.sql, TOKEN, NOW, log, nx.f)).attendanceAlerts).toBe(0);
    expect(await db.attendanceThreshold(t.sql)).toBe(70);
    expect(await db.setAttendanceThreshold(t.sql, 500)).toBe(100);
  });

  it("a rejected token says so — and the token is not in the message", async () => {
    const err = await runNexus(t.sql, TOKEN, NOW, log, fakeNexus({ grades: [], courses: [] }, { status: 401 }).f).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain("Nexus HTTP 401");
    expect(String((err as Error).message)).toContain("expired");
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(new NexusClient(TOKEN)).toBeTruthy();
  });
});
