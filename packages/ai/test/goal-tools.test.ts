import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { goalTools } from "../src/goal-tools";
import { jarvisTools } from "../src/tools";

// Goal, habit and logging tools against the real migrations (in-process Postgres).

const NOW = new Date("2026-10-01T03:30:00.000Z"); // Thu 1 Oct, 09:00 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.activities, jarvis.habits, jarvis.goal_decisions, jarvis.goals restart identity cascade`;
});

const tools = () => Object.fromEntries(goalTools(t.sql, () => NOW).map((x) => [x.name, x]));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON
const call = (name: string, args: Record<string, unknown>) => tools()[name]!.run(args) as Promise<Record<string, any>>;

describe("goal tools", () => {
  it("are local reads/writes and part of JARVIS's tool set", () => {
    const names = jarvisTools(t.sql).map((x) => x.name);
    for (const x of goalTools(t.sql)) {
      expect(names).toContain(x.name);
      expect(["read", "write-local"]).toContain(x.effect);
    }
  });

  it("'work out 4 times a week' → goal + habit, a check-in moves progress to 1/4", async () => {
    const c = await call("create_goal", { title: "Workout", metric: "count", target: 4, unit: "workouts", period: "week", habit: "Work out", habit_schedule: { freq: "weekly", times: 4 } });
    expect(c.created).toMatchObject({ title: "Workout", target: "4 workouts a week", starts: "2026-10-01", progress: { current: 0, target: 4 } });
    expect(c.habit).toMatchObject({ name: "Work out", schedule: "4× a week", this_period: "0/4" });
    const l = await call("log_activity", { habit: "work out" });
    expect(l.logged).toMatchObject({ habit: "Work out", day: "2026-10-01", status: "done" });
    const list = await call("list_goals", {});
    expect(list.goals[0].progress).toMatchObject({ current: 1, target: 4, percent: 25, days_left: 4 });
    expect(list.habits[0]).toMatchObject({ today: "done", this_period: "1/4" });
  });

  it("logs amounts toward a goal and refuses the future", async () => {
    await call("create_goal", { title: "Reading", target: 100, unit: "pages", period: "week" });
    const l = await call("log_activity", { goal: "reading", value: 30, note: "Atomic Habits" });
    expect(l.goal_now.progress).toMatchObject({ current: 30, target: 100 });
    await expect(call("log_activity", { goal: "reading", value: 5, day: "2026-10-03" })).rejects.toThrow("future");
    await expect(call("log_activity", {})).rejects.toThrow("habit");
  });

  it("answers 'what am I behind on?' and records the user's decision", async () => {
    await call("create_goal", { title: "Reading", target: 100, unit: "pages", period: "week", start: "2026-09-01" });
    const a = await call("get_attention", {});
    expect(a.goals[0]).toMatchObject({ title: "Reading", risk: "off_track", still_needed: 100, quiet_days: 30 });
    expect((await call("respond_to_goal", { goal: "reading", choice: "change_target", target: 60 })).goal.target).toBe("60 pages a week");
    await call("respond_to_goal", { goal: "reading", choice: "continue" });
    expect((await call("get_attention", {})).goals[0].quiet_days).toBeUndefined();
  });

  it("pauses a habit and changes a goal's target", async () => {
    await call("create_goal", { title: "Meditation", metric: "duration_min", target: 70, period: "week" });
    await call("create_habit", { name: "Meditate", goal: "meditation", reminder: "07:00" });
    expect((await call("update_habit", { habit: "meditate", active: false })).updated).toMatchObject({ active: false, today: "not due" });
    expect((await call("update_goal", { goal: "meditation", target: 100 })).updated.target).toBe("100 minutes a week");
  });
});
