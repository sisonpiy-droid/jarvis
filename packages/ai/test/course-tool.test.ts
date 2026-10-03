import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { jarvisTools } from "../src/tools";

// get_course against the real migrations (in-process Postgres), seeded like a real MESA course.

const NOW = new Date("2026-10-03T04:30:00.000Z");
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());

const item = (kind: string, id: string, title: string, data: Record<string, unknown>, sortAt: string | null, courseId: string | null) =>
  t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, course_id, title, sort_at)
        values (${kind}, ${id}, ${id}, ${t.sql.json({ sourceId: id, title, ...data } as never)}, ${courseId}, ${title}, ${sortAt})`;

beforeEach(async () => {
  await t.sql`truncate jarvis.lms_items cascade`;
  await item("course", "c1", "Data Driven Decision Making with Prof. Vinay Sharma", { shortName: "DDDM", instructor: "Prof. Vinay Sharma", termName: "Term 1" }, null, "c1");
  await item("course", "c2", "Crafting Marketing Strategies with Prof. Siddarth Menon", { shortName: "CMS", instructor: "Prof. Siddarth Menon" }, null, "c2");
  await item("event", "e1", "Data Driven Decision Making with Vinay Sharma", { startAtIst: "Mon, 28 Sep, 2:00 pm", eventType: "session", descriptionText: "Pivot tables and cohort analysis" }, "2026-09-28T08:30:00Z", "c1");
  await item("event", "e2", "Data Driven Decision Making with Vinay Sharma", { startAtIst: "Mon, 5 Oct, 2:00 pm", eventType: "session" }, "2026-10-05T08:30:00Z", "c1");
  await item("recording", "r1", "Session 3 recording", {}, "2026-09-21T08:30:00Z", "c1");
  await item("material", "m1", "Session 3 Nykaa Workbook", { topicTitle: "Resources" }, "2026-09-20T08:30:00Z", "c1");
  await item("material", "m2", "PreRead_Session 8_Groww", { topicTitle: "Pre-Reads" }, "2026-09-30T08:30:00Z", "c1");
  await item("assignment", "a1", "Session 1 Rapido Workbook", { dueAtIst: "Fri, 18 Sep, 11:59 pm", submissionStatus: "submitted" }, "2026-09-18T18:29:00Z", "c1");
});

const run = (query: string) => jarvisTools(t.sql, () => NOW).find((x) => x.name === "get_course")!.run({ query }) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("get_course", () => {
  it("finds a course by the professor's name and shows what was taught", async () => {
    const r = await run("Prof. Vinay");
    expect(r).toMatchObject({ course: "Data Driven Decision Making with Prof. Vinay Sharma", short: "DDDM", instructor: "Prof. Vinay Sharma" });
    expect(r.classes_held).toEqual([expect.objectContaining({ when: "Mon, 28 Sep, 2:00 pm", about: "Pivot tables and cohort analysis" })]);
    expect(r.classes_upcoming).toHaveLength(1);
    expect(r.recordings.map((x: { title: string }) => x.title)).toEqual(["Session 3 recording"]);
    expect(Object.keys(r.materials_by_folder).sort()).toEqual(["Pre-Reads", "Resources"]);
    expect(r.assignments).toEqual([expect.objectContaining({ title: "Session 1 Rapido Workbook", status: "submitted" })]);
  });

  it("also finds by short name or course words, and asks when ambiguous", async () => {
    expect((await run("dddm")).course).toContain("Data Driven");
    expect((await run("marketing strategies")).instructor).toBe("Prof. Siddarth Menon");
    expect((await run("with")).found).toBe("multiple");
    expect((await run("astrophysics")).found).toBe(false);
  });
});
