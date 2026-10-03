import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { planWork, syncWork, type AssignmentFact, type WorkState } from "../src/work";

// MESA → projects and tasks: the pure plan, then the real thing against the migrations (in-process Postgres).

const NOW = new Date("2026-10-01T03:30:00.000Z"); // 09:00 IST
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const assignment = (o: Partial<AssignmentFact> = {}): AssignmentFact => ({ id: "a1", title: "Case write-up", course: "Strategy", dueAt: days(3), submitted: false, removed: false, ...o });
const state = (o: Partial<WorkState> = {}): WorkState => ({ assignments: [], exams: [], drafts: new Map(), projects: new Map(), tasks: new Map(), ...o });

describe("planWork (pure)", () => {
  it("creates a project and a Submit task for a new open assignment", () => {
    const ops = planWork(state({ assignments: [assignment()] }), NOW);
    expect(ops.map((o) => o.op)).toEqual(["createProject", "createTask"]);
    expect(ops[1]).toMatchObject({ title: "Submit Case write-up", dueAt: days(3), nextAction: true, projectRef: "assignment:a1" });
  });

  it("skips submitted, removed and long-overdue assignments on backfill", () => {
    const ops = planWork(state({ assignments: [assignment({ submitted: true }), assignment({ id: "a2", removed: true }), assignment({ id: "a3", dueAt: days(-30) })] }), NOW);
    expect(ops).toEqual([]);
  });

  it("takes an undated assignment only if it was posted recently", () => {
    const undated = (createdAt: string) => assignment({ id: createdAt, dueAt: null, createdAt });
    const ops = planWork(state({ assignments: [undated(days(-3)), undated(days(-45))] }), NOW);
    expect(ops.filter((o) => o.op === "createProject").map((o) => o.ref)).toEqual([`assignment:${days(-3)}`]);
  });

  it("adds a review task when a draft exists", () => {
    const ops = planWork(state({ assignments: [assignment()], drafts: new Map([["a1", 9]]) }), NOW);
    expect(ops.find((o) => o.op === "createTask" && o.ref === "mesa:review:a1")).toMatchObject({ notes: "Draft: /drafts/9", dueAt: days(2) });
  });

  it("does nothing when the LMS facts haven't changed", () => {
    const fact = { title: "Case write-up", dueAt: days(3), submitted: false, removed: false };
    const s = state({
      assignments: [assignment()],
      projects: new Map([["assignment:a1", { id: 1, status: "active", sourceData: fact }]]),
      tasks: new Map([["mesa:submit:a1", { id: 1, status: "todo", sourceData: fact }]]),
    });
    expect(planWork(s, NOW)).toEqual([]);
  });

  it("creates a prep task for an upcoming exam, and nothing for a past one", () => {
    const exam = { id: "e1", title: "End Term Exam", course: "Exams", startAt: days(10), cancelled: false, removed: false };
    expect(planWork(state({ exams: [exam] }), NOW).map((o) => o.op)).toEqual(["createProject", "createTask"]);
    expect(planWork(state({ exams: [{ ...exam, startAt: days(-1) }] }), NOW)).toEqual([]);
  });
});

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.tasks, jarvis.projects, jarvis.project_items, jarvis.lms_items, jarvis.drafts restart identity cascade`;
});

async function putAssignment(id: string, o: { title?: string; dueAt?: string | null; status?: string; removed?: boolean } = {}) {
  const data = { sourceId: id, title: o.title ?? "Case write-up", courseTitle: "Strategy", dueAt: o.dueAt === undefined ? days(3) : o.dueAt, submissionStatus: o.status ?? "not_submitted" };
  await t.sql`
    insert into jarvis.lms_items (kind, source_id, content_hash, data, title, sort_at, removed_at)
    values ('assignment', ${id}, ${JSON.stringify(data)}, ${t.sql.json(data)}, ${data.title}, ${data.dueAt}, ${o.removed ? NOW.toISOString() : null})
    on conflict (kind, source_id) do update set data = excluded.data, title = excluded.title, sort_at = excluded.sort_at, removed_at = excluded.removed_at, content_hash = excluded.content_hash`;
}
async function putExam(id: string, startAt: string, status = "scheduled") {
  const data = { sourceId: id, title: "End Term Exam", eventType: "exam", courseName: "Exams", startAt, status };
  await t.sql`
    insert into jarvis.lms_items (kind, source_id, content_hash, data, title, sort_at)
    values ('event', ${id}, ${status + startAt}, ${t.sql.json(data)}, ${data.title}, ${startAt})
    on conflict (kind, source_id) do update set data = excluded.data, sort_at = excluded.sort_at`;
}
const tasks = () => t.sql`select title, status, due_at, is_next_action, source_ref from jarvis.tasks order by id`;
const projects = () => t.sql`select title, status, kind, deadline from jarvis.projects order by id`;

describe("syncWork (database)", () => {
  it("backfills once and is idempotent", async () => {
    await putAssignment("a1");
    await putAssignment("old", { dueAt: days(-30) });
    await putAssignment("done", { status: "submitted" });
    expect(await syncWork(t.sql, NOW)).toEqual({ projectsCreated: 1, tasksCreated: 1, updated: 0 });
    expect(await syncWork(t.sql, NOW)).toEqual({ projectsCreated: 0, tasksCreated: 0, updated: 0 });
    expect(await tasks()).toMatchObject([{ title: "Submit Case write-up", status: "todo", is_next_action: true, source_ref: "mesa:submit:a1" }]);
    expect((await db.listTasks(t.sql, { view: "upcoming" }, NOW)).length).toBe(1);
  });

  it("follows a deadline change, then closes everything when submitted", async () => {
    await putAssignment("a1");
    await syncWork(t.sql, NOW);
    await putAssignment("a1", { dueAt: days(5) });
    await syncWork(t.sql, NOW);
    const [task] = await tasks();
    expect(new Date(task!.due_at).toISOString()).toBe(days(5));
    await putAssignment("a1", { dueAt: days(5), status: "submitted" });
    await syncWork(t.sql, NOW);
    expect(await tasks()).toMatchObject([{ status: "done", is_next_action: false }]);
    expect(await projects()).toMatchObject([{ status: "done" }]);
  });

  it("keeps your own edits until the LMS changes again", async () => {
    await putAssignment("a1");
    await syncWork(t.sql, NOW);
    const [row] = await t.sql`select id from jarvis.tasks`;
    await db.updateTask(t.sql, Number(row!.id), { due: "2026-10-02" }); // plan to finish early
    await syncWork(t.sql, NOW);
    const [kept] = await tasks();
    expect(new Date(kept!.due_at).toISOString()).toBe("2026-10-02T18:29:00.000Z"); // 23:59 IST
  });

  it("cancels on removal and adds the draft review step", async () => {
    await putAssignment("a1");
    await syncWork(t.sql, NOW);
    await t.sql`insert into jarvis.drafts (assignment_id, assignment_hash, trigger, status) values ('a1', 'h', 'auto', 'done')`;
    await syncWork(t.sql, NOW);
    expect((await tasks()).map((x) => x.source_ref)).toEqual(["mesa:submit:a1", "mesa:review:a1"]);
    await putAssignment("a1", { removed: true });
    await syncWork(t.sql, NOW);
    expect((await tasks()).map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
    expect(await projects()).toMatchObject([{ status: "cancelled" }]);
  });

  it("turns an upcoming exam into a project with a prep task, closed once it starts", async () => {
    await putExam("e1", days(10));
    await syncWork(t.sql, NOW);
    expect(await projects()).toMatchObject([{ title: "End Term Exam", kind: "exam", status: "active" }]);
    expect(await tasks()).toMatchObject([{ title: "Prepare for End Term Exam", status: "todo" }]);
    await syncWork(t.sql, new Date(Date.parse(days(10)) + 60_000));
    expect(await projects()).toMatchObject([{ status: "done" }]);
    expect(await tasks()).toMatchObject([{ status: "done" }]);
  });

  it("cancels an exam MESA cancels", async () => {
    await putExam("e1", days(10));
    await syncWork(t.sql, NOW);
    await putExam("e1", days(10), "cancelled");
    await syncWork(t.sql, NOW);
    expect(await projects()).toMatchObject([{ status: "cancelled" }]);
  });
});
