import { describe, expect, it } from "vitest";
import {
  addDays,
  describeSchedule,
  goalHistory,
  goalProgress,
  habitStatus,
  istDay,
  parseSchedule,
  periodWindow,
  weekday,
  type ActivityFact,
  type GoalFact,
  type HabitFact,
} from "../src/progress";

const act = (day: string, o: Partial<ActivityFact> = {}): ActivityFact => ({ day, occurredAt: `${day}T06:00:00.000Z`, status: "done", value: 1, durationMin: null, ...o });

describe("IST days and periods", () => {
  it("puts a log at 23:59 IST on that day and 00:00 IST on the next", () => {
    expect(istDay("2026-10-04T18:29:59.000Z")).toBe("2026-10-04"); // Sun 23:59:59 IST
    expect(istDay("2026-10-04T18:30:00.000Z")).toBe("2026-10-05"); // Mon 00:00 IST
  });

  it("starts weeks on Monday", () => {
    expect(weekday("2026-10-05")).toBe(1);
    expect(weekday("2026-10-04")).toBe(7);
    expect(periodWindow("week", "2026-10-04")).toEqual({ from: "2026-09-28", to: "2026-10-05" });
    expect(periodWindow("week", "2026-10-05")).toEqual({ from: "2026-10-05", to: "2026-10-12" });
  });

  it("handles month, quarter, year and total windows", () => {
    expect(periodWindow("month", "2026-12-15")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    expect(periodWindow("quarter", "2026-11-03")).toEqual({ from: "2026-10-01", to: "2027-01-01" });
    expect(periodWindow("year", "2026-02-28")).toEqual({ from: "2026-01-01", to: "2027-01-01" });
    expect(periodWindow("total", "2026-10-01", "2026-09-01").from).toBe("2026-09-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("goal progress (derived from the log)", () => {
  const weekly: GoalFact = { metric: "count", targetValue: 4, period: "week", startDate: "2026-09-01", targetDate: null };

  it("counts this week's done entries only; skips and last week don't count", () => {
    const acts = [act("2026-09-27"), act("2026-09-28"), act("2026-09-30"), act("2026-10-01", { status: "skipped" })];
    const p = goalProgress(weekly, acts, "2026-10-01"); // Thu
    expect(p).toMatchObject({ current: 2, target: 4, ratio: 0.5, met: false, daysLeft: 4, window: { from: "2026-09-28", to: "2026-10-05" } });
    expect(goalProgress(weekly, [...acts, act("2026-10-02", { value: 2 })], "2026-10-02").met).toBe(true);
  });

  it("ignores entries before the goal started", () => {
    expect(goalProgress({ ...weekly, startDate: "2026-09-30" }, [act("2026-09-28"), act("2026-09-30")], "2026-10-01").current).toBe(1);
  });

  it("sums minutes, treats boolean as once, and uses the latest value", () => {
    const mins: GoalFact = { metric: "duration_min", targetValue: 300, period: "week", startDate: "2026-09-01", targetDate: null };
    expect(goalProgress(mins, [act("2026-09-29", { durationMin: 90 }), act("2026-09-30", { value: 60 })], "2026-10-01").current).toBe(150);
    const once: GoalFact = { metric: "boolean", targetValue: null, period: "month", startDate: "2026-09-01", targetDate: null };
    expect(goalProgress(once, [act("2026-10-01"), act("2026-10-01")], "2026-10-01")).toMatchObject({ current: 1, target: 1, met: true });
    const weight: GoalFact = { metric: "value", targetValue: 70, period: "total", startDate: "2026-09-01", targetDate: "2026-12-31" };
    const p = goalProgress(weight, [act("2026-09-10", { value: 74, occurredAt: "2026-09-10T02:00:00Z" }), act("2026-09-30", { value: 72.5, occurredAt: "2026-09-30T02:00:00Z" })], "2026-10-01");
    expect(p).toMatchObject({ current: 72.5, daysLeft: 92 });
  });

  it("builds per-period history oldest first, stopping at the start", () => {
    const h = goalHistory({ ...weekly, startDate: "2026-09-14" }, [act("2026-09-15"), act("2026-09-22"), act("2026-09-23"), act("2026-09-24"), act("2026-09-25")], "2026-10-01");
    expect(h).toEqual([
      { from: "2026-09-14", current: 1, met: false },
      { from: "2026-09-21", current: 4, met: true },
      { from: "2026-09-28", current: 0, met: false },
    ]);
  });
});

describe("habit schedules", () => {
  it("validates and describes schedules", () => {
    expect(parseSchedule({ freq: "weekly", days: [5, 1, 3, 3] })).toEqual({ freq: "weekly", days: [1, 3, 5] });
    expect(describeSchedule(parseSchedule({ freq: "weekly", days: [1, 2, 3, 4, 5] }))).toBe("Weekdays");
    expect(describeSchedule(parseSchedule({ freq: "weekly", times: 4 }))).toBe("4× a week");
    expect(() => parseSchedule({ freq: "weekly", days: [8] })).toThrow();
    expect(() => parseSchedule({ freq: "weekly", times: 9 })).toThrow();
    expect(() => parseSchedule({ freq: "hourly" })).toThrow();
  });

  const daily: HabitFact = { schedule: { freq: "daily" }, startDate: "2026-09-20", endDate: null, active: true };

  it("daily: streak counts back over done days, skips don't break it, a miss does", () => {
    const acts = [act("2026-09-25"), act("2026-09-27"), act("2026-09-28"), act("2026-09-29", { status: "skipped" }), act("2026-09-30")];
    const s = habitStatus(daily, acts, "2026-10-01");
    expect(s).toMatchObject({ dueToday: true, today: null, streak: 3 }); // 30, (29 skipped), 28, 27 — 26 missed
    expect(s.week.map((w) => w.state)).toEqual(["done", "missed", "done", "done", "skipped", "done", "open"]); // 25 Sep … 1 Oct
    expect(habitStatus(daily, [...acts, act("2026-10-01")], "2026-10-01")).toMatchObject({ dueToday: false, today: "done", streak: 4 });
  });

  it("fixed days: only scheduled days can be missed", () => {
    const mwf: HabitFact = { ...daily, schedule: { freq: "weekly", days: [1, 3, 5] } };
    const s = habitStatus(mwf, [act("2026-09-28")], "2026-10-01"); // Thu
    expect(s.dueToday).toBe(false);
    expect(s.week.map((w) => w.state)).toEqual(["missed", "rest", "rest", "done", "rest", "missed", "rest"]); // Fri 25 … Thu 1
    expect(s.streak).toBe(0);
  });

  it("N times a week: due until the quota is met; streak counts completed weeks", () => {
    const fourX: HabitFact = { ...daily, startDate: "2026-09-14", schedule: { freq: "weekly", times: 2 } };
    const acts = [act("2026-09-15"), act("2026-09-17"), act("2026-09-22"), act("2026-09-24"), act("2026-09-29")];
    const s = habitStatus(fourX, acts, "2026-10-01");
    expect(s).toMatchObject({ dueToday: true, periodDone: 1, periodTarget: 2, streak: 2 });
    expect(habitStatus(fourX, [...acts, act("2026-09-30")], "2026-10-01")).toMatchObject({ dueToday: false, periodDone: 2, streak: 3 });
  });

  it("isn't due before it starts, after it ends, or when paused", () => {
    expect(habitStatus({ ...daily, startDate: "2026-10-02" }, [], "2026-10-01").dueToday).toBe(false);
    expect(habitStatus({ ...daily, endDate: "2026-09-30" }, [], "2026-10-01").dueToday).toBe(false);
    expect(habitStatus({ ...daily, active: false }, [], "2026-10-01").dueToday).toBe(false);
  });
});
