import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attentionSummary } from "../src/attention";
import { briefSections, loadBriefFacts, refKey, type FactRef } from "../src/brief-facts";
import * as g from "../src/goals";
import * as w from "../src/work";
import { createTestDb, type TestDb } from "./harness";

// The brief's facts against the real migrations: one line per entity, risks with the rows behind them.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.notifications, jarvis.activities, jarvis.habits, jarvis.goals, jarvis.tasks, jarvis.projects, jarvis.lms_items, jarvis.integrations restart identity cascade`;
});

const NOW = new Date("2026-10-01T02:35:00.000Z"); // Thu 1 Oct, 08:05 IST

const item = (kind: string, sourceId: string, title: string, sortAt: string, data: Record<string, unknown>) =>
  t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title, sort_at)
        values (${kind}, ${sourceId}, 'h', ${t.sql.json({ title, ...data } as never)}, ${title}, ${sortAt})`;
const event = (sourceId: string, title: string, startAt: string, endAt: string | null, data: Record<string, unknown> = {}) =>
  item("event", sourceId, title, startAt, { startAt, endAt, status: "scheduled", eventType: "class", courseName: title, ...data });
const gcal = (sourceId: string, title: string, startAt: string, endAt: string, data: Record<string, unknown> = {}) =>
  item("gcal_event", sourceId, title, startAt, { source: "gcal", startAt, endAt, allDay: false, status: "confirmed", eventType: "personal", ...data });
const assignment = (sourceId: string, title: string, dueAt: string, submissionStatus = "not_submitted") =>
  item("assignment", sourceId, title, dueAt, { dueAt, submissionStatus, courseTitle: "Marketing" });

async function seed() {
  // Work.
  const spinny = await w.createTask(t.sql, { title: "Finish Spinny presentation", priority: 1, due: "2026-10-01T18:00:00+05:30" });
  const recruiter = await w.createTask(t.sql, { title: "Send recruiter follow-up", priority: 2, due: "2026-09-30T10:00:00+05:30" });
  const callHome = await w.createTask(t.sql, { title: "Call home", domain: "personal", priority: 2, due: "2026-10-01" });
  const report = await w.createTask(t.sql, { title: "Write the annual report", priority: 3, due: "2026-10-01", effortMin: 900 });
  const side = await w.createProject(t.sql, { title: "Side project", kind: "startup", deadline: "2026-10-06" });
  await w.createTask(t.sql, { title: "Sketch the landing page", projectId: side.id, priority: 3 });
  await w.createTask(t.sql, { title: "Pick a name", projectId: side.id, priority: 2, due: "2026-10-04" });
  await t.sql`insert into jarvis.tasks (title, status, completed_at) values ('Done today', 'done', '2026-10-01T02:00:00Z'), ('Done yesterday', 'done', '2026-09-30T10:00:00Z')`;

  // A MESA assignment with its project and "Submit" task, and one with no task (yet).
  const [mp] = await t.sql`
    insert into jarvis.projects (title, kind, source, source_ref, deadline, priority)
    values ('Framework Case', 'mesa_assignment', 'mesa', 'assignment:A1', '2026-10-02T18:29:00Z', 1) returning id`;
  const [submit] = await t.sql`
    insert into jarvis.tasks (title, project_id, priority, due_at, is_next_action, source, source_ref)
    values ('Submit Framework Case', ${mp!.id}, 1, '2026-10-02T18:29:00Z', true, 'mesa', 'mesa:submit:A1') returning id`;
  await assignment("A1", "Framework Case", "2026-10-02T18:29:00.000Z");
  await assignment("A2", "Brand audit reflection", "2026-10-03T18:29:00.000Z");
  await assignment("A3", "Already handed in", "2026-10-02T18:29:00.000Z", "submitted");

  // An exam: its project and the prep task due at the exam's start.
  const [ep] = await t.sql`
    insert into jarvis.projects (title, kind, source, source_ref, deadline, priority)
    values ('Marketing mid-term', 'exam', 'mesa', 'exam:E1', '2026-10-05T04:00:00Z', 1) returning id`;
  await t.sql`
    insert into jarvis.tasks (title, project_id, priority, due_at, is_next_action, source, source_ref)
    values ('Prepare for Marketing mid-term', ${ep!.id}, 1, '2026-10-05T04:00:00Z', true, 'mesa', 'mesa:prep:E1')`;
  await event("E1", "Marketing mid-term", "2026-10-05T04:00:00.000Z", "2026-10-05T06:00:00.000Z", { eventType: "exam" });

  // Calendar: today's class and a cancelled one, an event just after IST midnight, an all-day entry,
  // tomorrow's class, a personal interview in 2 days and a personal dinner.
  await event("C1", "Strategy", "2026-10-01T04:30:00.000Z", "2026-10-01T06:00:00.000Z", { room: "R1" });
  await event("C2", "Economics", "2026-10-01T08:30:00.000Z", "2026-10-01T10:00:00.000Z", { status: "cancelled" });
  await event("C0", "Night lab", "2026-09-30T18:45:00.000Z", "2026-09-30T19:15:00.000Z");
  await gcal("G2", "Dussehra", "2026-09-30T18:30:00.000Z", "2026-10-01T18:30:00.000Z", { allDay: true });
  await event("C3", "Strategy", "2026-10-02T04:30:00.000Z", "2026-10-02T06:00:00.000Z");
  await gcal("G1", "Interview", "2026-10-03T08:30:00.000Z", "2026-10-03T09:30:00.000Z");
  await gcal("G3", "Dinner with Asha", "2026-10-03T14:00:00.000Z", "2026-10-03T16:00:00.000Z");

  // Habits and goals: a daily habit missed all week, a 4-a-week habit feeding an on-pace goal, a goal
  // behind pace and a monthly goal nobody has logged for three weeks.
  const read = await g.createHabit(t.sql, { name: "Read 30 minutes", startDate: "2026-09-20" }, NOW);
  const workout = await g.createGoal(t.sql, { title: "Workout", targetValue: 4, period: "week", startDate: "2026-09-01" }, NOW);
  const gym = await g.createHabit(t.sql, { name: "Workout", goalId: workout.id, schedule: { freq: "weekly", times: 4 }, startDate: "2026-09-01" }, NOW);
  for (const day of ["2026-09-28", "2026-09-29"]) await g.logHabit(t.sql, gym.id, { day }, NOW);
  const reading = await g.createGoal(t.sql, { title: "Reading", targetValue: 10, unit: "chapters", period: "week", startDate: "2026-09-01" }, NOW);
  await g.logGoal(t.sql, reading.id, { value: 4, day: "2026-09-29" }, NOW);
  const journal = await g.createGoal(t.sql, { title: "Journal", targetValue: 4, period: "month", startDate: "2026-08-01" }, NOW);
  await g.logGoal(t.sql, journal.id, { day: "2026-09-10" }, NOW);

  // MESA sign-in expiring in 3 days; two unread notifications and one read.
  await t.sql`insert into jarvis.integrations (provider, status, session_expires_at, last_success_at) values ('mesa', 'active', '2026-10-04T04:30:00Z', '2026-10-01T02:30:00Z')`;
  await t.sql`insert into jarvis.notifications (dedupe_key, priority, text, status) values ('n1', 'normal', 'a', 'sent'), ('n2', 'normal', 'b', 'sent')`;
  await t.sql`insert into jarvis.notifications (dedupe_key, priority, text, status, read_at) values ('n3', 'normal', 'c', 'sent', now())`;

  return { spinny, recruiter, callHome, report, side, submitId: Number(submit!.id), examProject: Number(ep!.id), read, reading, journal };
}

describe("loadBriefFacts", () => {
  it("lists each deadline once: the Submit task stands for its assignment, the exam isn't doubled, MESA classes stay out", async () => {
    const s = await seed();
    const f = await loadBriefFacts(t.sql, NOW);
    const up = f.upcoming.map((d) => [d.kind, d.title, refKey(d.ref), d.when, d.href]);
    expect(up).toEqual([
      ["assignment", "Submit Framework Case", `task:${s.submitId}`, "tomorrow 11:59 pm", "/assignments/A1"],
      ["event", "Interview", "lms:gcal_event:G1", "Sat 3 Oct, 2:00 pm", "/classes"],
      ["assignment", "Brand audit reflection", "lms:assignment:A2", "Sat 3 Oct, 11:59 pm", "/assignments/A2"],
      ["task", "Pick a name", expect.stringMatching(/^task:/), "Sun 4 Oct", `/projects/${s.side.id}`],
      ["task", "Prepare for Marketing mid-term", expect.stringMatching(/^task:/), "Mon 5 Oct, 9:30 am", `/projects/${s.examProject}`],
      ["project", "Side project", `project:${s.side.id}`, "Tue 6 Oct", `/projects/${s.side.id}`],
    ]);
    expect(f.upcoming.filter((d) => /mid-term/.test(d.title))).toHaveLength(1);
    expect(f.upcoming.some((d) => d.ref.t === "lms" && d.ref.kind === "event")).toBe(false);
  });

  it("collects today's calendar, free time, habits, counts and MESA state", async () => {
    await seed();
    const f = await loadBriefFacts(t.sql, NOW);
    expect(f).toMatchObject({ v: 1, day: "2026-10-01", label: "Thursday, 1 October", stale: false, unread: 2, doneToday: 1 });
    // All-day first; an event at 18:45Z on 30 Sep is 00:15 IST on 1 Oct.
    expect(f.calendar.map((e) => [e.title, e.allDay, e.cancelled, e.personal])).toEqual([
      ["Dussehra", true, false, true],
      ["Night lab", false, false, false],
      ["Strategy", false, false, false],
      ["Economics", false, true, false],
    ]);
    expect(f.calendarWeek.map((e) => e.title)).toEqual(["Strategy", "Interview", "Dinner with Asha", "Marketing mid-term"]);
    expect(f.freeTime.freeMin).toBe(835 - 90); // 08:05–22:00 IST minus the 10:00–11:30 class
    expect(f.habits.map((h) => h.name)).toEqual(["Read 30 minutes", "Workout"]);
    expect(f.slipping.map((s) => [s.habit.name, s.missed])).toEqual([["Read 30 minutes", 6]]);
    expect(f.lmsDue.map((a) => a.id)).toEqual(["A1", "A2"]);
    expect(f.mesa).toEqual({ status: "active", lastSuccessAt: "2026-10-01T02:30:00.000Z", sessionExpiresAt: "2026-10-04T04:30:00.000Z" });
    expect(f.focus.map((i) => i.task.title).slice(0, 4)).toEqual(["Finish Spinny presentation", "Send recruiter follow-up", "Submit Framework Case", "Call home"]);
  });

  it("names the rows behind every risk", async () => {
    const s = await seed();
    const f = await loadBriefFacts(t.sql, NOW);
    const risks = briefSections(f).risks.map((r) => [r.kind, r.severity, r.text, r.refs.map(refKey), r.href]);
    expect(risks).toEqual([
      ["overdue", 3, "Overdue: Send recruiter follow-up (overdue since Wed 30 Sep)", [`task:${s.recruiter.id}`], "/tasks?view=today"],
      ["soon", 2, "Finish Spinny presentation due today 6:00 pm, not started", [`task:${s.spinny.id}`], "/tasks?view=today"],
      ["soon", 2, "Call home due today, not started", [`task:${s.callHome.id}`], "/tasks?view=today"],
      ["soon", 2, "Submit Framework Case due tomorrow 11:59 pm, not started", [`task:${s.submitId}`], "/assignments/A1"],
      ["goal", 2, "Reading: 4 of 10 with 4 days left", [`goal:${s.reading.id}`], `/goals/${s.reading.id}`],
      ["effort", 2, "Write the annual report needs 15 h, 12 h 25 min free today", [`task:${s.report.id}`], "/tasks?view=today"],
      ["session", 2, "MESA sign-in expires Sun 4 Oct, 10:00 am", ["integration:mesa"], "/status"],
      ["habit", 2, "Read 30 minutes: missed 6 days in a row", [`habit:${s.read.id}`], "/goals"],
      ["neglect", 1, "Journal: nothing logged for 21 days", [`goal:${s.journal.id}`], `/goals/${s.journal.id}`],
    ]);
  });

  it("adds overdue assignments without a task, folds extra overdue items into one line, and flags stale data", async () => {
    await w.createTask(t.sql, { title: "Old one", due: "2026-09-28" });
    await w.createTask(t.sql, { title: "Older one", due: "2026-09-27" });
    await assignment("A9", "Late case", "2026-09-30T18:29:00.000Z");
    await t.sql`insert into jarvis.integrations (provider, last_success_at) values ('mesa', '2026-09-30T14:35:00Z')`;
    const f = await loadBriefFacts(t.sql, NOW, { stale: true });
    const risks = briefSections(f).risks;
    expect(risks.filter((r) => r.kind === "overdue").map((r) => [r.text, r.refs.map(refKey)])).toEqual([
      ["Overdue: Older one (overdue since Sun 27 Sep)", ["task:2"]],
      ["Overdue: Old one (overdue since Mon 28 Sep)", ["task:1"]],
      ["+1 more overdue", ["lms:assignment:A9"]],
    ]);
    expect(risks.at(-1)).toMatchObject({ kind: "stale", severity: 1, text: "LMS data last updated 12 h ago — deadlines may be out of date", refs: [{ t: "integration", id: "mesa" }] });
  });

  it("agrees with the SQL helpers it replaces", async () => {
    await seed();
    const f = await loadBriefFacts(t.sql, NOW);
    for (const p of f.projects) expect(p.next?.id ?? null).toBe((await w.nextAction(t.sql, p.id))?.id ?? null);
    expect(f.projects.length).toBeGreaterThanOrEqual(3);
    expect(f.overdue.length).toBe((await attentionSummary(t.sql, NOW)).overdueTasks);
  });
});

describe("briefSections", () => {
  it("picks professional priorities, personal items, upcoming without the priorities, and goals by risk", async () => {
    const s = await seed();
    const f = await loadBriefFacts(t.sql, NOW);
    const sec = briefSections(f);
    expect(sec.priorities.map((i) => [i.task.title, i.score, i.reasons])).toEqual([
      ["Finish Spinny presentation", 59, ["due today 6:00 pm", "P1"]],
      ["Send recruiter follow-up", 55, ["overdue since Wed 30 Sep", "P2"]],
      ["Submit Framework Case", 55, ["due tomorrow 11:59 pm", "P1", "next action"]],
    ]);
    expect(sec.personal.tasks.map((i) => i.task.title)).toEqual(["Call home"]);
    expect(sec.personal.habits.map((h) => h.name)).toEqual(["Read 30 minutes", "Workout"]);
    const shown = new Set(sec.upcoming.map((d) => refKey(d.ref)));
    expect(shown.has(`task:${s.submitId}`)).toBe(false);
    expect(sec.upcoming.map((d) => d.title)).toContain("Interview");
    expect(sec.goals.map((g) => [g.title, g.risk.risk])).toEqual([
      ["Reading", "at_risk"],
      ["Workout", "on_track"],
      ["Journal", "on_track"],
    ]);
  });

  it("every fact ref points at a real row", async () => {
    await seed();
    const f = await loadBriefFacts(t.sql, NOW);
    const sec = briefSections(f);
    const refs: FactRef[] = [...sec.upcoming.map((d) => d.ref), ...sec.risks.flatMap((r) => r.refs), ...f.calendar.map((e) => e.ref), ...f.lmsDue.map((a) => a.ref)];
    for (const r of refs) {
      const rows =
        r.t === "lms" ? await t.sql`select 1 from jarvis.lms_items where kind = ${r.kind} and source_id = ${r.id}` :
        r.t === "integration" ? await t.sql`select 1 from jarvis.integrations where provider = ${r.id}` :
        await t.sql`select 1 from ${t.sql(`jarvis.${r.t}s`)} where id = ${r.id}`;
      expect(rows.length, refKey(r)).toBe(1);
    }
  });
});
