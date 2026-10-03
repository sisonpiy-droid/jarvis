import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import { createLogger } from "@jarvis/shared";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { runEngine } from "../src/engine";
import { runScheduledJob } from "../src/jobs";
import type { SyncDeps } from "../src/run";

// The engine against the real migrations (in-process Postgres): attention, answers, reminders, once-only alerts.

vi.spyOn(console, "log").mockImplementation(() => {});
const log = createLogger("test");
const SAT = new Date("2026-10-03T04:30:00.000Z"); // Sat 3 Oct, 10:00 IST (week Mon 28 Sep – Sun 4 Oct)

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.notifications, jarvis.activities, jarvis.habits, jarvis.goal_decisions, jarvis.goals, jarvis.tasks, jarvis.projects, jarvis.job_runs, jarvis.memories restart identity cascade`;
});

const keys = async () => (await t.sql`select dedupe_key from jarvis.notifications order by id`).map((r) => String(r.dedupe_key));
const workoutGoal = async (logged: string[], start = "2026-09-01") => {
  const g = await db.createGoal(t.sql, { title: "Workout", targetValue: 4, unit: "workouts", period: "week", startDate: start });
  const h = await db.createHabit(t.sql, { name: "Work out", goalId: g.id, schedule: { freq: "weekly", times: 4 }, startDate: start });
  for (const d of logged) await db.logHabit(t.sql, h.id, { day: d }, SAT);
  return { g, h };
};

describe("attention", () => {
  it("rates goals by pace and spots quiet ones", async () => {
    await workoutGoal(["2026-09-28", "2026-09-30"]);
    const quiet = await db.createGoal(t.sql, { title: "Read", targetValue: 50, unit: "pages", period: "week", startDate: "2026-09-01" });
    await db.logGoal(t.sql, quiet.id, { value: 50, day: "2026-09-20" }, SAT);
    const a = await db.goalAttention(t.sql, SAT);
    expect(a.map((g) => [g.title, g.risk.risk, g.neglect.neglected])).toEqual([
      ["Workout", "at_risk", false],
      ["Read", "off_track", true],
    ]);
    const s = await db.attentionSummary(t.sql, SAT);
    expect(s.goals).toHaveLength(2);
  });

  it("records each answer and acts on it", async () => {
    const g = await db.createGoal(t.sql, { title: "Read", targetValue: 50, period: "week", startDate: "2026-09-01" });
    await db.decideGoal(t.sql, g.id, "continue", {}, SAT);
    expect((await db.goalAttention(t.sql, SAT))[0]!.neglect.neglected).toBe(false); // quiet for a week
    await db.decideGoal(t.sql, g.id, "change_target", { target: 30 }, SAT);
    expect((await db.getGoal(t.sql, g.id))!.targetValue).toBe(30);
    await db.decideGoal(t.sql, g.id, "pause", {}, SAT);
    expect((await db.getGoal(t.sql, g.id))!.status).toBe("paused");
    expect((await db.goalDecisions(t.sql, g.id)).map((d) => d.choice)).toEqual(["pause", "change_target", "continue"]);
    await expect(db.decideGoal(t.sql, g.id, "change_target", {}, SAT)).rejects.toThrow("target");
  });

  it("finds habits missed 3+ scheduled days in a row", async () => {
    const h = await db.createHabit(t.sql, { name: "Meditate", startDate: "2026-09-20" });
    await db.logHabit(t.sql, h.id, { day: "2026-09-29" }, SAT);
    // Done on the 29th, then missed 30 Sep, 1 and 2 Oct (today, the 3rd, is still open).
    expect((await db.habitSlips(t.sql, SAT)).map((s) => [s.habit.name, s.missed, s.since])).toEqual([["Meditate", 3, "2026-09-30"]]);
    await db.logHabit(t.sql, h.id, { day: "2026-10-01", status: "skipped" }, SAT);
    expect(await db.habitSlips(t.sql, SAT)).toEqual([]); // a skip breaks the run of misses
  });
});

describe("task reminders", () => {
  it("picks tasks by kind: exact time 1 h before, date-only from 09:00, exam prep 48 h before; never MESA submissions", async () => {
    const exact = await db.createTask(t.sql, { title: "Call the bank", due: "2026-10-03T11:00:00+05:30" }); // in 1 h
    await db.createTask(t.sql, { title: "Later today", due: "2026-10-03T18:00:00+05:30" });
    const dateOnly = await db.createTask(t.sql, { title: "Pay rent", due: "2026-10-03" });
    await db.createTask(t.sql, { title: "Tomorrow", due: "2026-10-04" });
    await t.sql`insert into jarvis.tasks (title, source, source_ref, due_at) values
      ('Prepare for End Term Exam', 'mesa', 'mesa:prep:e1', '2026-10-05T04:00:00Z'),
      ('Submit case', 'mesa', 'mesa:submit:a1', '2026-10-03T05:00:00Z')`;
    const r = await db.tasksToRemind(t.sql, SAT);
    expect(r.map((x) => [x.title, x.kind])).toEqual(
      expect.arrayContaining([
        ["Call the bank", "due"],
        ["Pay rent", "due"],
        ["Prepare for End Term Exam", "prep"],
      ]),
    );
    expect(r).toHaveLength(3);
    expect([exact.id, dateOnly.id].every((id) => r.some((x) => x.id === id))).toBe(true);
  });
});

describe("engine job", () => {
  it("alerts once per period, never re-alerts on improvement, and handles quiet goals and tasks", async () => {
    const { h } = await workoutGoal(["2026-09-28"]); // 1 of 4 on Saturday → off track
    await db.createTask(t.sql, { title: "Pay rent", due: "2026-10-03" });
    const s = await runEngine(t.sql, SAT);
    expect(s).toMatchObject({ goals: 1, offTrack: 1, tasks: 1, queued: 2 });
    expect(await keys()).toEqual(["goal.risk:1:2026-09-28:off_track", `task.due:1:${new Date("2026-10-03T18:29:00Z").toISOString()}`]);
    // Improves to "at risk": no new alert in this window. Running again: nothing new either.
    await db.logHabit(t.sql, h.id, { day: "2026-10-02" }, SAT);
    expect((await runEngine(t.sql, SAT)).queued).toBe(0);
    const [n] = await t.sql`select text, priority, category, url from jarvis.notifications where dedupe_key like 'goal.risk:%'`;
    expect(n).toMatchObject({ priority: "high" });
    expect(String(n!.text)).toContain("<b>Workout</b> is off track");
  });

  it("doesn't nag about 'at risk' early in the week", async () => {
    await workoutGoal([], "2026-09-01");
    const wed = new Date("2026-09-30T04:30:00.000Z"); // 0 of 4 on Wednesday: at risk, 5 days left
    expect((await db.goalAttention(t.sql, wed))[0]!.risk.risk).toBe("at_risk");
    expect((await runEngine(t.sql, wed)).queued).toBe(1); // only the neglect prompt (never logged since 1 Sep)
    expect(await keys()).toEqual(["goal.neglect:1:start-2026-09-01"]);
  });

  it("runs as the scheduled 'engine' job", async () => {
    const deps: SyncDeps = { sql: t.sql, sessionKey: "k".repeat(43), channel: null, log, now: () => SAT };
    expect((await runScheduledJob("engine", deps, { trigger: "schedule" })).status).toBe("idle");
    await workoutGoal(["2026-09-28"]);
    expect(await runScheduledJob("engine", deps, { trigger: "schedule" })).toMatchObject({ status: "success", stats: { queued: 1 } });
    expect(db.notificationMeta("goal.risk:1:2026-09-28:off_track")).toEqual({ category: "goal", url: "/goals/1" });
    expect(db.notificationMeta("task.due:4:x")).toEqual({ category: "task", url: "/tasks" });
  });
});

describe("old goal/project memories", () => {
  const counts = async () => {
    const [r] = await t.sql`select (select count(*) from jarvis.goals)::int as goals, (select count(*) from jarvis.projects)::int as projects`;
    return { goals: Number(r!.goals), projects: Number(r!.projects) };
  };

  it("never nudges without pending old notes", async () => {
    await t.sql`insert into jarvis.memories (kind, content) values ('fact', 'Lives in Gurgaon'), ('preference', 'Prefers short answers')`;
    await t.sql`insert into jarvis.memories (kind, content, reviewed_at, converted_to) values ('fact', 'Read 12 books', now(), 'kept')`;
    await runEngine(t.sql, SAT);
    expect(await keys()).toEqual([]);
  });

  it("offers the review exactly once while notes are pending, and converts nothing", async () => {
    await t.sql`insert into jarvis.memories (kind, content) values ('goal', 'Read 12 books this year'), ('project', 'Launch the side project'), ('fact', 'Lives in Gurgaon')`;
    const before = await counts();
    expect((await runEngine(t.sql, SAT)).queued).toBe(1);
    expect((await runEngine(t.sql, new Date(SAT.getTime() + 86_400_000))).queued).toBe(0);
    expect(await keys()).toEqual(["memory.review:v1"]);
    const [n] = await t.sql`select text, priority, category, url from jarvis.notifications`;
    expect(n).toMatchObject({ priority: "normal", category: "system", url: "/settings/memory" });
    expect(String(n!.text)).toBe("🧠 <b>2 old notes could become real goals or projects</b>\nReview them once — nothing changes unless you choose.");
    expect(await counts()).toEqual(before);
    const rows = await t.sql`select kind, active, reviewed_at, converted_to from jarvis.memories order by id`;
    expect(rows.every((r) => r.active && r.reviewed_at == null && r.converted_to == null)).toBe(true);
    expect(rows.map((r) => r.kind)).toEqual(["goal", "project", "fact"]);
    expect(db.notificationMeta("memory.review:v1")).toEqual({ category: "system", url: "/settings/memory" });
  });
});
