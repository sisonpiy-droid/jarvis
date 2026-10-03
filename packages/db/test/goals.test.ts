import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { goalAttention, habitSlips, slipsFrom } from "../src/attention";
import * as g from "../src/goals";
import { createTask, updateTask, WorkInputError } from "../src/work";
import { createTestDb, type TestDb } from "./harness";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.activities, jarvis.habits, jarvis.goals, jarvis.tasks, jarvis.projects restart identity cascade`;
});

const NOW = new Date("2026-10-01T03:30:00.000Z"); // Thu 1 Oct, 09:00 IST

describe("goals", () => {
  it("creates a measurable goal and validates it", async () => {
    const goal = await g.createGoal(t.sql, { title: "Workout", metric: "count", targetValue: 4, unit: "workouts", period: "week" }, NOW);
    expect(goal).toMatchObject({ title: "Workout", targetValue: 4, period: "week", startDate: "2026-10-01", status: "active", domain: "personal" });
    await expect(g.createGoal(t.sql, { title: "x", metric: "count" })).rejects.toThrow("target is required");
    await expect(g.createGoal(t.sql, { title: "x", targetValue: -1 })).rejects.toThrow("positive");
    await expect(g.createGoal(t.sql, { title: "x", targetValue: 1, period: "fortnight" as never })).rejects.toThrow(WorkInputError);
    await expect(g.createGoal(t.sql, { title: "x", targetValue: 1, startDate: "2026-10-10", targetDate: "2026-10-01" })).rejects.toThrow("before");
    expect((await g.createGoal(t.sql, { title: "Track weight", metric: "value", unit: "kg" })).targetValue).toBeNull();
  });

  it("progress comes from habit check-ins and free logs", async () => {
    const goal = await g.createGoal(t.sql, { title: "Workout", targetValue: 4, period: "week", startDate: "2026-09-28" }, NOW);
    const habit = await g.createHabit(t.sql, { name: "Work out", goalId: goal.id, schedule: { freq: "weekly", times: 4 } }, NOW);
    await g.logHabit(t.sql, habit.id, { day: "2026-09-29" }, NOW);
    await g.logHabit(t.sql, habit.id, {}, NOW);
    await g.logHabit(t.sql, habit.id, {}, NOW); // same day again: still one entry
    await g.logGoal(t.sql, goal.id, { value: 1, note: "extra swim" }, NOW);
    const [withP] = await g.goalsWithProgress(t.sql, [goal], NOW);
    expect(withP!.progress).toMatchObject({ current: 3, target: 4, met: false });
    const detail = await g.goalDetail(t.sql, goal.id, NOW);
    expect(detail!.activities).toHaveLength(3);
    expect(detail!.habits.map((h) => h.name)).toEqual(["Work out"]);
  });

  it("a habit check-in can be changed to a skip, or undone", async () => {
    const habit = await g.createHabit(t.sql, { name: "Read" }, NOW);
    await g.logHabit(t.sql, habit.id, {}, NOW);
    expect((await g.logHabit(t.sql, habit.id, { status: "skipped" }, NOW)).status).toBe("skipped");
    expect((await t.sql`select count(*)::int as n from jarvis.activities`)[0]!.n).toBe(1);
    expect(await g.unlogHabit(t.sql, habit.id, "2026-10-01")).toBe(true);
    await expect(g.logHabit(t.sql, habit.id, { day: "2026-10-02" }, NOW)).rejects.toThrow("future");
  });

  it("a completed task linked to a goal counts once, and stops counting if reopened", async () => {
    const goal = await g.createGoal(t.sql, { title: "Job applications", targetValue: 10, unit: "applications", period: "month", domain: "professional" }, NOW);
    const task = await createTask(t.sql, { title: "Apply to Bain", goalId: goal.id });
    await updateTask(t.sql, task.id, { status: "done" });
    await updateTask(t.sql, task.id, { notes: "sent via referral" }); // no double count
    let [p] = await g.goalsWithProgress(t.sql, [goal]);
    expect(p!.progress.current).toBe(1);
    await updateTask(t.sql, task.id, { status: "todo" });
    [p] = await g.goalsWithProgress(t.sql, [goal]);
    expect(p!.progress.current).toBe(0);
  });
});

describe("habits", () => {
  it("validates schedules and reminder times", async () => {
    await expect(g.createHabit(t.sql, { name: "x", schedule: { freq: "weekly", days: [9] } })).rejects.toThrow("weekly days");
    await expect(g.createHabit(t.sql, { name: "x", reminderTime: "25:00" })).rejects.toThrow("HH:MM");
    const h = await g.createHabit(t.sql, { name: "Meditate", reminderTime: "07:30" }, NOW);
    expect(h).toMatchObject({ reminderTime: "07:30", schedule: { freq: "daily" } });
    const paused = await g.updateHabit(t.sql, h.id, { active: false, schedule: { freq: "weekly", days: [6, 7] } });
    expect(paused).toMatchObject({ active: false, schedule: { freq: "weekly", days: [6, 7] } });
  });

  it("reminds within two hours after the reminder time, only while still due", async () => {
    const early = await g.createHabit(t.sql, { name: "Meditate", reminderTime: "08:30", startDate: "2026-09-01" });
    await g.createHabit(t.sql, { name: "Too old", reminderTime: "06:00", startDate: "2026-09-01" }); // 3 h ago
    await g.createHabit(t.sql, { name: "Later", reminderTime: "21:00", startDate: "2026-09-01" });
    await g.createHabit(t.sql, { name: "Weekend only", reminderTime: "08:00", schedule: { freq: "weekly", days: [6, 7] }, startDate: "2026-09-01" });
    expect((await g.habitsToRemind(t.sql, NOW)).map((h) => h.name)).toEqual(["Meditate"]);
    await g.logHabit(t.sql, early.id, {}, NOW);
    expect(await g.habitsToRemind(t.sql, NOW)).toEqual([]);
  });
});

describe("attention over preloaded rows", () => {
  const seed = async () => {
    const workout = await g.createGoal(t.sql, { title: "Workout", targetValue: 4, period: "week", startDate: "2026-09-01" }, NOW);
    const gym = await g.createHabit(t.sql, { name: "Gym", goalId: workout.id, schedule: { freq: "weekly", times: 4 }, startDate: "2026-09-01" }, NOW);
    await g.logHabit(t.sql, gym.id, { day: "2026-09-28" }, NOW);
    await g.createHabit(t.sql, { name: "Meditate", startDate: "2026-09-20" }, NOW); // missed every day
    const stretch = await g.createHabit(t.sql, { name: "Stretch", startDate: "2026-09-20" }, NOW);
    await g.logHabit(t.sql, stretch.id, { day: "2026-09-29" }, NOW); // only 1 missed since
    await g.createHabit(t.sql, { name: "Weekends", schedule: { freq: "weekly", days: [6, 7] }, startDate: "2026-09-01" }, NOW);
    const read = await g.createGoal(t.sql, { title: "Read", targetValue: 50, period: "week", startDate: "2026-09-01" }, NOW);
    await g.logGoal(t.sql, read.id, { value: 10, day: "2026-09-28" }, NOW);
  };

  it("slipsFrom matches habitSlips", async () => {
    await seed();
    const habits = await g.habitsWithStatus(t.sql, await g.listHabits(t.sql), NOW);
    const slips = slipsFrom(habits, "2026-10-01");
    expect(slips).toEqual(await habitSlips(t.sql, NOW));
    expect(slips.map((s) => [s.habit.name, s.missed, s.since])).toEqual([["Meditate", 6, "2026-09-25"]]);
  });

  it("goalAttention with preloaded habits matches the version that loads them", async () => {
    await seed();
    const pre = await goalAttention(t.sql, NOW, { habits: await g.listHabits(t.sql) });
    expect(pre).toEqual(await goalAttention(t.sql, NOW));
    expect(pre.map((x) => [x.title, x.risk.risk])).toEqual([
      ["Workout", "off_track"],
      ["Read", "off_track"],
    ]);
  });
});
