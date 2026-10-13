import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { chat } from "../src/jarvis";
import { nexusTools } from "../src/nexus-tools";
import { call, calls, say, scripted } from "./scripted";

// "How are my grades?" and "can I skip tomorrow's Finance class?" answered from the synced Nexus data.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.grades, jarvis.attendance, jarvis.settings, jarvis.chat_messages restart identity cascade`;
  await db.upsertGrades(t.sql, [
    { assignmentId: "a", assignment: "Mid-Term Assignment", course: "The Art of Selling with Prof. Rishabh Ladha", marks: 97, maxMarks: 100, feedback: null, releasedAt: "2026-10-10T11:42:00Z" },
    { assignmentId: "b", assignment: "Mid-Term Assessment", course: "Fundamentals of Finance with Prof. Narahari", marks: 29, maxMarks: null, feedback: "Ratios were right; the DuPont split was missing.", releasedAt: "2026-10-10T11:41:00Z" },
  ]);
  await db.upsertAttendance(t.sql, [
    { course: "Fundamentals of Finance with Prof. Narahari", term: "Term 1", attended: 11, total: 13, percentage: 84.6 },
    { course: "AI and its Application", term: "Term 1", attended: 18, total: 18, percentage: 100 },
  ]);
});

const tool = (name: string) => nexusTools(t.sql, () => new Date("2026-10-13T07:00:00Z")).find((x) => x.name === name)!;

describe("nexus tools", () => {
  it("get_grades: newest first, short course names, percent only when MESA published a maximum, feedback kept", async () => {
    const r = (await tool("get_grades").run({})) as { grades: Array<Record<string, unknown>> };
    expect(r.grades.map((g) => [g.course, g.marks, g.out_of, g.percent])).toEqual([["The Art of Selling", 97, 100, 97], ["Fundamentals of Finance", 29, null, null]]);
    expect(r.grades[1]!.feedback).toBe("Ratios were right; the DuPont split was missing.");
    const fin = (await tool("get_grades").run({ course: "finance" })) as { grades: unknown[] };
    expect(fin.grades).toHaveLength(1);
  });

  it("get_attendance: against the threshold, with classes you can still miss or must attend", async () => {
    const r = (await tool("get_attendance").run({})) as { threshold_percent: number; courses: Array<Record<string, unknown>> };
    expect(r.threshold_percent).toBe(85);
    expect(r.courses).toEqual([
      { course: "Fundamentals of Finance", attended: 11, total: 13, percent: 84.6, status: "below", can_still_miss: 0, must_attend_in_a_row: 1 },
      { course: "AI and its Application", attended: 18, total: 18, percent: 100, status: "ok", can_still_miss: 3, must_attend_in_a_row: 0 },
    ]);
  });

  it("set_attendance_threshold changes the line, and rejects nonsense", async () => {
    expect(await tool("set_attendance_threshold").run({ percent: 75 })).toEqual({ threshold_percent: 75 });
    const r = (await tool("get_attendance").run({})) as { courses: Array<Record<string, unknown>> };
    expect(r.courses[0]).toMatchObject({ status: "ok", can_still_miss: 1 });
    await expect(tool("set_attendance_threshold").run({ percent: 0 })).rejects.toThrow(/between 1 and 100/);
  });

  it("chat answers a skipping question from the tool, and the prompt names the tools", async () => {
    const { model, requests } = scripted(calls(call("get_attendance")), say("Not Finance — you're at 84.6% and need the next class. AI and its Application: you can miss 3."));
    const res = await chat({ sql: t.sql, model, channel: "telegram", situation: false }, "can I skip tomorrow's classes?");
    expect(res.toolCalls.map((c) => c.name)).toEqual(["get_attendance"]);
    expect(requests[0]!.system).toContain("get_grades");
    expect(res.text).toContain("84.6%"); // grounded: the number is in the tool result
    expect(res.guard.ok).toBe(true);
  });
});
