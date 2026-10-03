import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { goalTools } from "../src/goal-tools";
import { accomplishedRange, COMMITMENTS_CAVEAT, planningTools } from "../src/planning-tools";
import { jarvisTools } from "../src/tools";
import { seedPlanningWorld as seed, truncatePlanningWorld } from "./planning-world";

// The chief-of-staff tools against the brief's fixture world (real migrations, in-process Postgres).

const NOW = new Date("2026-10-01T03:30:00.000Z"); // Thu 1 Oct, 09:00 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await truncatePlanningWorld(t.sql);
});

const seedPlanningWorld = () => seed(t.sql);

const tools = () => Object.fromEntries([...planningTools(t.sql, () => NOW), ...goalTools(t.sql, () => NOW)].map((x) => [x.name, x]));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON
const call = (name: string, args: Record<string, unknown> = {}) => tools()[name]!.run(args) as Promise<Record<string, any>>;

describe("planning tools", () => {
  it("are reads, and part of JARVIS's tool set", () => {
    const names = jarvisTools(t.sql).map((x) => x.name);
    for (const x of planningTools(t.sql)) {
      expect(names).toContain(x.name);
      expect(x.effect).toBe("read");
    }
    expect(names.filter((n) => n.startsWith("get_")).length).toBe(new Set(names.filter((n) => n.startsWith("get_"))).size);
  });

  it("get_focus: the brief's ranking and reasons, per domain, with defer candidates and free time", async () => {
    const w = await seedPlanningWorld();
    const f = await db.loadBriefFacts(t.sql, NOW);
    const r = await call("get_focus");
    const expected = (d: db.Domain) => f.focus.filter((i) => i.task.domain === d).slice(0, 5);
    expect(r.professional.map((x: { id: number }) => x.id)).toEqual(expected("professional").map((i) => i.task.id));
    expect(r.professional.map((x: { reasons: string[] }) => x.reasons)).toEqual(expected("professional").map((i) => i.reasons));
    expect(r.professional.map((x: { rank: number }) => x.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.professional[0]).toMatchObject({ id: w.spinny.id, title: "Finish Spinny presentation", priority: 1, due: "today 6:00 pm", due_iso: "2026-10-01T12:30:00.000Z" });
    expect(r.personal.map((x: { id: number }) => x.id)).toEqual(expected("personal").map((i) => i.task.id));
    expect(r.defer_candidates).toEqual([{ id: w.tidy.id, title: "Tidy the reading list", due: null, due_iso: null, reason: "no due date · P3" }]);
    expect(r.free_today).toMatchObject({ minutes: f.freeTime.freeMin, basis: expect.stringContaining("8 am–10 pm IST") });
    expect(r.free_today.gaps[0]).toEqual({ from: "9:00 am", to: "10:00 am", minutes: 60 });
    expect(r).toMatchObject({ today: "2026-10-01", now: "Thu 1 Oct, 9:00 am", waiting_count: 1, rule: expect.stringContaining("re-rank only if asked") });
    expect(r.habits_due_today.map((h: { name: string }) => h.name)).toEqual(["Read 30 minutes", "Workout"]);
    expect(r.habits_due_today[1].this_period).toBe("2/4");

    const pro = await call("get_focus", { domain: "professional", limit: 2 });
    expect(pro.personal).toBeUndefined();
    expect(pro.professional).toHaveLength(2);
    const personal = await call("get_focus", { domain: "personal" });
    expect(personal.professional).toBeUndefined();
    expect(personal.personal.every((x: { id: number }) => x.id === w.callHome.id)).toBe(true);
    expect(personal.defer_candidates).toEqual([]);
  });

  it("get_week: Monday to Sunday, each deadline once on its IST day; next and last shift by 7 days", async () => {
    const w = await seedPlanningWorld();
    const r = await call("get_week");
    expect(r.week).toEqual({ from: "2026-09-28", to: "2026-10-04", label: "Mon 28 Sep – Sun 4 Oct" });
    expect(r.days.map((d: { date: string }) => d.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    const byDay = Object.fromEntries(r.days.map((d: { date: string; deadlines: Array<{ title: string }> }) => [d.date, d.deadlines.map((x) => x.title)]));
    expect(byDay).toEqual({
      "2026-09-28": [],
      "2026-09-29": [],
      "2026-09-30": ["Send recruiter follow-up"],
      "2026-10-01": ["Finish Spinny presentation", "Call home"],
      "2026-10-02": ["Quiz reflection", "Submit Framework Case"],
      "2026-10-03": ["Interview", "Brand audit reflection", "Slides from Riya"],
      "2026-10-04": ["Pick a name"],
    });
    const all = r.days.flatMap((d: { deadlines: unknown[] }) => d.deadlines);
    expect(all.filter((x: { title: string }) => /Framework/.test(x.title))).toHaveLength(1);
    expect(all.find((x: { title: string }) => x.title === "Submit Framework Case")).toMatchObject({ kind: "assignment", id: w.submitId, due: "tomorrow 11:59 pm", due_iso: "2026-10-02T18:29:00.000Z", mesa: true });
    expect(all.find((x: { title: string }) => x.title === "Brand audit reflection")).toMatchObject({ kind: "assignment", id: "A2", course: "Marketing", due: "Sat 3 Oct, 11:59 pm" });
    const today = r.days[3];
    expect(today).toMatchObject({ is_today: true, label: "Thu 1 Oct" });
    expect(today.classes).toEqual([
      { time: "10:00 am", title: "Strategy", course: "Strategy", room: "R1" },
      { time: "2:00 pm", title: "Economics", course: "Economics", cancelled: true },
    ]);
    expect(today.events).toEqual([{ time: "all day", title: "Dussehra" }]);
    expect(r.days[5].events).toEqual([]); // the interview is a deadline, not listed twice
    expect(r.days[1].done).toBe(1);
    expect(r.days[2].done).toBe(1);
    expect(r.totals).toEqual({ classes: 2, deadlines: 9, tasks_done: 2 });
    expect(r.overdue).toEqual([{ id: w.recruiter.id, title: "Send recruiter follow-up", due: "overdue since Wed 30 Sep", due_iso: "2026-09-30T04:30:00.000Z" }]);
    expect(r.goals.map((g: { title: string; progress: string }) => [g.title, g.progress])).toEqual([
      ["Workout", "2/4 this week"],
      ["Reading", "4/10 chapters this week"],
      ["Journal", "0/4 this month"],
    ]);
    expect(r.habits.map((h: { name: string }) => h.name)).toEqual(["Read 30 minutes", "Workout"]);

    const next = await call("get_week", { which: "next" });
    expect(next.week).toMatchObject({ from: "2026-10-05", to: "2026-10-11" });
    const nextTitles = next.days.flatMap((d: { deadlines: Array<{ title: string }> }) => d.deadlines.map((x) => x.title));
    expect(nextTitles).toEqual(["Prepare for Marketing mid-term", "Side project"]);
    expect(next.days[0].classes).toEqual([{ time: "9:30 am", title: "Marketing mid-term", course: "Marketing mid-term" }]);
    const last = await call("get_week", { which: "last" });
    expect(last.week).toMatchObject({ from: "2026-09-21", to: "2026-09-27", label: "Mon 21 Sep – Sun 27 Sep" });
    expect(last.totals).toEqual({ classes: 0, deadlines: 0, tasks_done: 1 });
  });

  it("get_accomplished: this week, last month, and an explicit range", async () => {
    const w = await seedPlanningWorld();
    expect(accomplishedRange("this_week", "2026-10-01")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(accomplishedRange("last_week", "2026-10-01")).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(accomplishedRange("last_month", "2026-10-01")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(accomplishedRange("yesterday", "2026-10-01")).toEqual({ from: "2026-09-30", to: "2026-09-30" });

    const week = await call("get_accomplished");
    expect(week.range).toEqual({ from: "2026-09-28", to: "2026-10-04", label: "Mon 28 Sep – Sun 4 Oct" });
    expect(week.tasks_done.count).toBe(2);
    expect(week.tasks_done.items.map((x: { id: number }) => x.id)).toEqual([w.submitted, w.doneThisWeek]);
    expect(week.tasks_done.items[1]).toMatchObject({ title: "Book the venue", completed: "Tue 29 Sep, 11:30 am", completed_iso: "2026-09-29T06:00:00.000Z" });
    expect(week.mesa_submitted).toEqual([{ id: w.submitted, title: "Submit Ethics essay" }]);
    expect(week.habit_checkins).toEqual([{ id: expect.any(Number), name: "Workout", done: 2, skipped: 0 }]);
    expect(week.goal_logs).toEqual([{ id: w.reading.id, title: "Reading", total: 4, unit: "chapters", entries: 1 }]);
    expect(week.goals_progress.find((g: { title: string }) => g.title === "Reading")).toEqual({ id: w.reading.id, title: "Reading", progress: "4/10 chapters this week", met: false });

    const month = await call("get_accomplished", { period: "last_month" });
    expect(month.range).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(month.tasks_done.count).toBe(3);
    expect(month.goal_logs.map((g: { title: string; total: number }) => [g.title, g.total])).toEqual([
      ["Reading", 4],
      ["Journal", 1],
    ]);

    const custom = await call("get_accomplished", { from: "2026-09-24", to: "2026-09-24" });
    expect(custom.range).toEqual({ from: "2026-09-24", to: "2026-09-24", label: "Thu 24 Sep" });
    expect(custom.tasks_done.items.map((x: { id: number }) => x.id)).toEqual([w.doneLastWeek]);
    await expect(call("get_accomplished", { from: "2026-01-01", to: "2026-06-30" })).rejects.toThrow(/at most 92 days/);
    await expect(call("get_accomplished", { from: "2026-09-30", to: "2026-09-01" })).rejects.toThrow(/before/);
  });

  it("get_week and get_accomplished split done work on IST day boundaries, not UTC", async () => {
    await seedPlanningWorld();
    // Sun 27 Sep 23:45 IST (last week) and Mon 28 Sep 00:15 IST (this week) — both on 27 Sep in UTC.
    const [late] = await t.sql`insert into jarvis.tasks (title, status, completed_at) values ('Late Sunday', 'done', '2026-09-27T18:15:00Z') returning id`;
    const [early] = await t.sql`insert into jarvis.tasks (title, status, completed_at) values ('Early Monday', 'done', '2026-09-27T18:45:00Z') returning id`;
    const week = await call("get_accomplished", { period: "this_week" });
    expect(week.tasks_done.items.map((x: { id: number }) => x.id)).toContain(Number(early!.id));
    expect(week.tasks_done.items.map((x: { id: number }) => x.id)).not.toContain(Number(late!.id));
    const last = await call("get_accomplished", { period: "last_week" });
    expect(last.tasks_done.items.map((x: { id: number }) => x.id)).toContain(Number(late!.id));
    const r = await call("get_week");
    expect(r.days[0]).toMatchObject({ date: "2026-09-28", done: 1 });
    expect(r.totals.tasks_done).toBe(3);
  });

  it("get_commitments: promise-like tasks, waiting tasks, notes about people, project people — and the caveat", async () => {
    const w = await seedPlanningWorld();
    const r = await call("get_commitments");
    expect(r.caveat).toBe(COMMITMENTS_CAVEAT);
    expect(r.caveat).toMatch(/no people tracker/);
    expect(r.you_owe.map((x: { id: number }) => x.id)).toEqual([w.recruiter.id, w.callHome.id]);
    expect(r.you_owe[0]).toMatchObject({ title: "Send recruiter follow-up", due: "overdue since Wed 30 Sep", due_iso: "2026-09-30T04:30:00.000Z" });
    expect(r.waiting_on_others).toEqual([{ id: w.waiting.id, title: "Slides from Riya", since_iso: expect.any(String), due: "Sat 3 Oct", due_iso: "2026-10-03T18:29:00.000Z" }]);
    expect(r.people_notes).toEqual([{ memory_id: w.riyaNote, person: "Riya", content: "Riya prefers WhatsApp over email" }]);
    expect(r.project_people).toEqual([
      { project_id: w.side.id, project: "Side project", kind: "person", body: "Asha helps with the design" },
      { project_id: w.side.id, project: "Side project", kind: "question", body: "Which domain do we buy?" },
    ]);
  });

  it("get_attention: adds the overdue list, deadlines at risk by tomorrow, and the MESA data state", async () => {
    const w = await seedPlanningWorld();
    const r = await call("get_attention");
    const s = await db.attentionSummary(t.sql, NOW);
    expect(r.overdue_tasks).toBe(s.overdueTasks);
    expect(r.goals.map((g: { id: number }) => g.id)).toEqual(s.goals.map((g) => g.id));
    expect(r.habits_slipping.map((h: { id: number }) => h.id)).toEqual(s.habits.map((h) => h.habit.id));
    expect(r.overdue_list).toEqual([{ id: w.recruiter.id, title: "Send recruiter follow-up", due: "overdue since Wed 30 Sep", due_iso: "2026-09-30T04:30:00.000Z" }]);
    expect(r.deadlines_at_risk.map((d: { kind: string; id: unknown }) => [d.kind, d.id])).toEqual([
      ["assignment", "A9"],
      ["task", w.spinny.id],
      ["task", w.callHome.id],
      ["task", w.submitId],
    ]);
    expect(r.deadlines_at_risk[0]).toMatchObject({ title: "Quiz reflection", due: "tomorrow 3:30 pm", due_iso: "2026-10-02T10:00:00.000Z", why: "not submitted" });
    expect(r.system).toEqual({
      mesa_sign_in_expires: "Sun 4 Oct, 10:00 am",
      mesa_sign_in_expires_iso: "2026-10-04T04:30:00.000Z",
      lms_last_updated: "Thu 1 Oct, 8:00 am",
      lms_last_updated_iso: "2026-10-01T02:30:00.000Z",
      lms_stale: false,
    });
  });
});
