import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as w from "../src/work";
import { createTestDb, type TestDb } from "./harness";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.tasks, jarvis.projects, jarvis.project_items restart identity cascade`;
});

const NOW = new Date("2026-10-01T03:30:00.000Z"); // Thu 1 Oct, 09:00 IST

describe("parseDue", () => {
  it("reads a bare date as the end of that day in IST", () => {
    expect(w.parseDue("2026-10-02")).toEqual({ dueAt: "2026-10-02T18:29:00.000Z", dateOnly: true });
    expect(w.parseDue("2026-10-02T15:00:00+05:30")).toEqual({ dueAt: "2026-10-02T09:30:00.000Z", dateOnly: false });
    expect(w.parseDue("")).toEqual({ dueAt: null, dateOnly: false });
    expect(() => w.parseDue("next friday")).toThrow(w.WorkInputError);
  });
});

describe("tasks", () => {
  it("creates, inherits the project's domain, completes and reopens", async () => {
    const p = await w.createProject(t.sql, { title: "Marathon training", kind: "personal", area: "fitness" });
    expect(p).toMatchObject({ domain: "personal", status: "active", openTasks: 0 });
    const task = await w.createTask(t.sql, { title: "  Buy   running shoes ", projectId: p.id, due: "2026-10-03" });
    expect(task).toMatchObject({ title: "Buy running shoes", domain: "personal", area: "fitness", projectTitle: "Marathon training", status: "todo" });
    const done = await w.updateTask(t.sql, task.id, { status: "done" });
    expect(done?.completedAt).not.toBeNull();
    const reopened = await w.updateTask(t.sql, task.id, { status: "todo" });
    expect(reopened?.completedAt).toBeNull();
    expect((await w.getProject(t.sql, p.id))?.openTasks).toBe(1);
  });

  it("rejects bad input", async () => {
    await expect(w.createTask(t.sql, { title: "   " })).rejects.toThrow("title is required");
    await expect(w.createTask(t.sql, { title: "x", priority: 9 })).rejects.toThrow("priority");
    await expect(w.createTask(t.sql, { title: "x", projectId: 999 })).rejects.toThrow("not found");
    await expect(w.createProject(t.sql, { title: "x", kind: "exam" })).rejects.toThrow("automatically");
  });

  it("sorts work into today / upcoming / waiting / done", async () => {
    const mk = (title: string, o: Partial<w.NewTask> = {}) => w.createTask(t.sql, { title, ...o });
    await mk("overdue", { due: "2026-09-30T10:00:00+05:30" });
    await mk("today", { due: "2026-10-01" });
    await mk("next action", { isNextAction: true });
    await mk("later", { due: "2026-10-05" });
    await mk("someday");
    await mk("chasing", { status: "waiting" });
    await mk("finished", { status: "done" });
    const titles = async (view: w.TaskFilter["view"]) => (await w.listTasks(t.sql, { view }, NOW)).map((x) => x.title);
    expect(await titles("today")).toEqual(["overdue", "today", "next action"]);
    expect(await titles("upcoming")).toEqual(["later", "someday"]);
    expect(await titles("waiting")).toEqual(["chasing"]);
    expect(await titles("done")).toEqual(["finished"]);
    expect(await w.taskCounts(t.sql, NOW)).toEqual({ today: 3, overdue: 1, upcoming: 2, waiting: 1 });
  });

  it("filters by due and completion ranges, half-open", async () => {
    const mk = (title: string, o: Partial<w.NewTask> = {}) => w.createTask(t.sql, { title, ...o });
    await mk("mon", { due: "2026-09-28T10:00:00+05:30" });
    await mk("sun", { due: "2026-10-04" });
    await mk("next mon", { due: "2026-10-05T00:00:00+05:30" });
    await mk("undated");
    const week = { dueFrom: "2026-09-27T18:30:00.000Z", dueTo: "2026-10-04T18:30:00.000Z" }; // Mon 28 Sep – Sun 4 Oct IST
    expect((await w.listTasks(t.sql, { view: "all", ...week }, NOW)).map((x) => x.title)).toEqual(["mon", "sun"]);
    expect((await w.listTasks(t.sql, { view: "all", dueFrom: week.dueTo }, NOW)).map((x) => x.title)).toEqual(["next mon"]);

    const [a, b] = await t.sql`
      insert into jarvis.tasks (title, status, completed_at)
      values ('done mon', 'done', '2026-09-28T05:00:00Z'), ('done last week', 'done', '2026-09-27T18:29:00Z') returning id`;
    const done = await w.listTasks(t.sql, { view: "done", doneFrom: week.dueFrom, doneTo: week.dueTo }, NOW);
    expect(done.map((x) => x.id)).toEqual([Number(a!.id)]);
    expect((await w.listTasks(t.sql, { view: "done", doneTo: week.dueFrom }, NOW)).map((x) => x.id)).toEqual([Number(b!.id)]);
  });

  it("maps updatedAt, and edits move it", async () => {
    const task = await w.createTask(t.sql, { title: "x" });
    await t.sql`update jarvis.tasks set updated_at = '2026-09-01T00:00:00Z' where id = ${task.id}`;
    expect((await w.getTask(t.sql, task.id))!.updatedAt).toBe("2026-09-01T00:00:00.000Z");
    const edited = await w.updateTask(t.sql, task.id, { notes: "touched" });
    expect(Date.parse(edited!.updatedAt)).toBeGreaterThan(Date.parse("2026-09-01T00:00:00Z"));
  });

  it("never deletes a task MESA manages", async () => {
    const [row] = await t.sql`insert into jarvis.tasks (title, source, source_ref) values ('Submit x', 'mesa', 'mesa:submit:x') returning id`;
    expect(await w.deleteTask(t.sql, Number(row!.id))).toBe(false);
    const mine = await w.createTask(t.sql, { title: "mine" });
    expect(await w.deleteTask(t.sql, mine.id)).toBe(true);
  });
});

describe("projects", () => {
  it("tracks the next action, items and closing", async () => {
    const p = await w.createProject(t.sql, { title: "Case competition", kind: "case_comp", deadline: "2026-10-20" });
    await w.createTask(t.sql, { title: "Draft the deck", projectId: p.id, due: "2026-10-10" });
    await w.createTask(t.sql, { title: "Pick the team", projectId: p.id, due: "2026-10-03" });
    expect((await w.nextAction(t.sql, p.id))?.title).toBe("Pick the team");
    const flagged = await w.createTask(t.sql, { title: "Read the brief", projectId: p.id, isNextAction: true });
    expect((await w.nextAction(t.sql, p.id))?.id).toBe(flagged.id);

    const q = await w.addProjectItem(t.sql, p.id, { kind: "question", body: "Is the deck limit 10 slides?" });
    await w.setProjectItemResolved(t.sql, q.id, true);
    expect((await w.projectItems(t.sql, p.id))[0]?.resolvedAt).not.toBeNull();
    await expect(w.addProjectItem(t.sql, p.id, { kind: "nonsense" as never, body: "x" })).rejects.toThrow("kind");

    const closed = await w.updateProject(t.sql, p.id, { status: "done" });
    expect(closed?.completedAt).not.toBeNull();
    expect((await w.listProjects(t.sql)).length).toBe(0);
    expect((await w.listProjects(t.sql, { status: "closed" })).map((x) => x.title)).toEqual(["Case competition"]);
  });

  it("nextActionFrom picks the same task as nextAction", async () => {
    const p = await w.createProject(t.sql, { title: "P" });
    const q = await w.createProject(t.sql, { title: "Q" });
    const empty = await w.createProject(t.sql, { title: "Empty" });
    const mk = (title: string, o: Partial<w.NewTask>) => w.createTask(t.sql, { title, ...o });
    const check = async () => {
      const open = await w.listTasks(t.sql, { view: "open", limit: 500 }, NOW);
      for (const id of [p.id, q.id, empty.id]) expect(w.nextActionFrom(open, id)?.id ?? null).toBe((await w.nextAction(t.sql, id))?.id ?? null);
    };
    await mk("p undated", { projectId: p.id, priority: 1 });
    await mk("p later", { projectId: p.id, due: "2026-10-09", priority: 3 });
    await mk("p sooner", { projectId: p.id, due: "2026-10-03", priority: 4 });
    await mk("p same time, P2", { projectId: p.id, due: "2026-10-03", priority: 2 });
    await mk("q waiting", { projectId: q.id, status: "waiting", due: "2026-10-01" });
    await mk("q undated P3", { projectId: q.id, priority: 3 });
    await mk("q undated P3 again", { projectId: q.id, priority: 3 });
    await check();
    const doing = await mk("p in progress", { projectId: p.id, status: "doing" });
    await check();
    expect(w.nextActionFrom(await w.listTasks(t.sql, { view: "open" }, NOW), p.id)?.id).toBe(doing.id);
    const flagged = await mk("p flagged", { projectId: p.id, isNextAction: true, priority: 4 });
    await check();
    expect(w.nextActionFrom(await w.listTasks(t.sql, { view: "open" }, NOW), p.id)?.id).toBe(flagged.id);
  });
});
