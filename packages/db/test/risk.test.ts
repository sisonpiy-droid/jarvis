import { describe, expect, it } from "vitest";
import { goalProgress, type ActivityFact, type GoalFact } from "../src/progress";
import { goalNeglect, goalRisk, missedInARow } from "../src/risk";

const acts = (days: string[]): ActivityFact[] => days.map((day) => ({ day, occurredAt: `${day}T06:00:00Z`, status: "done", value: 1, durationMin: null }));
const weekly: GoalFact = { metric: "count", targetValue: 4, period: "week", startDate: "2026-09-01", targetDate: null };
// Week of Mon 28 Sep – Sun 4 Oct 2026.
const riskOn = (g: GoalFact, done: string[], today: string, capacity: number | null = null) => goalRisk(g, goalProgress(g, acts(done), today), today, capacity);

describe("goal risk (pace vs. time left)", () => {
  it.each([
    // [what, done this week, today, expected risk]
    ["Monday, nothing yet: too early to judge", [], "2026-09-28", "on_track"],
    ["Thursday, 2 of 4: on pace", ["2026-09-28", "2026-09-30"], "2026-10-01", "on_track"],
    ["Saturday, 2 of 4 (2 days left): at risk", ["2026-09-28", "2026-09-30"], "2026-10-03", "at_risk"],
    ["Saturday, 1 of 4: off track", ["2026-09-28"], "2026-10-03", "off_track"],
    ["Wednesday, 0 of 4: at risk, not yet off track", [], "2026-09-30", "at_risk"],
    ["4 of 4: met", ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"], "2026-10-01", "met"],
  ] as const)("%s", (_what, done, today, risk) => {
    expect(riskOn(weekly, [...done], today).risk).toBe(risk);
  });

  it("explains the gap and the pace needed", () => {
    const r = riskOn(weekly, ["2026-09-28", "2026-09-30"], "2026-10-03");
    expect(r).toMatchObject({ remaining: 2, perDay: 1, reason: "2 of 4 with 2 days left" });
  });

  it("is off track when habit check-ins alone can no longer make it", () => {
    // Sunday, 1 of 4, one habit = one check-in a day: 3 needed, 1 day left.
    expect(riskOn(weekly, ["2026-09-28"], "2026-10-04", 1)).toMatchObject({ risk: "off_track", reason: "3 still to do but only 1 day left" });
    // Sunday, 2 of 4: one habit can't do 2 in a day → off track; with free entries allowed it's pace-based (at risk).
    expect(riskOn(weekly, ["2026-09-28", "2026-09-30"], "2026-10-04", 1).risk).toBe("off_track");
    expect(riskOn(weekly, ["2026-09-28", "2026-09-30"], "2026-10-04").risk).toBe("at_risk");
  });

  it("judges a goal that started mid-week from its start", () => {
    const fresh = { ...weekly, startDate: "2026-10-02" }; // started Friday: 3 of 7 days → about 1.7 expected
    expect(riskOn(fresh, ["2026-10-02"], "2026-10-03").risk).toBe("on_track"); // 1 by Saturday is on pace for that share
    expect(riskOn(fresh, [], "2026-10-04").risk).toBe("off_track"); // nothing by Sunday
  });

  it("uses the end date for 'total' goals, and leaves untargeted ones alone", () => {
    const books: GoalFact = { metric: "count", targetValue: 12, period: "total", startDate: "2026-01-01", targetDate: "2026-12-31" };
    expect(riskOn(books, ["2026-02-01", "2026-03-01", "2026-04-01"], "2026-10-01").risk).toBe("off_track"); // 3 of 12, 75% gone
    expect(riskOn({ ...books, targetDate: null }, [], "2026-10-01").risk).toBe("untracked");
    expect(riskOn({ ...weekly, metric: "value" }, [], "2026-10-01").risk).toBe("untracked");
  });
});

describe("neglect", () => {
  it("flags a goal after the period's quiet threshold, not before", () => {
    expect(goalNeglect(weekly, "2026-09-25", "2026-10-01")).toEqual({ neglected: false, quietDays: 6, threshold: 7 });
    expect(goalNeglect(weekly, "2026-09-24", "2026-10-01").neglected).toBe(true);
    expect(goalNeglect({ period: "month", startDate: "2026-09-01" }, "2026-09-20", "2026-10-01").neglected).toBe(false); // 11 < 14
  });

  it("counts from the start when never logged, and honours a 'keep going' snooze", () => {
    expect(goalNeglect({ ...weekly, startDate: "2026-09-29" }, null, "2026-10-01").neglected).toBe(false);
    expect(goalNeglect(weekly, null, "2026-10-01").neglected).toBe(true);
    expect(goalNeglect(weekly, null, "2026-10-01", "2026-10-05").neglected).toBe(false);
  });

  it("counts scheduled days missed in a row, ignoring rest days and today", () => {
    const week = [
      { day: "2026-09-25", state: "done" },
      { day: "2026-09-26", state: "missed" },
      { day: "2026-09-27", state: "rest" },
      { day: "2026-09-28", state: "missed" },
      { day: "2026-09-29", state: "missed" },
      { day: "2026-09-30", state: "missed" },
      { day: "2026-10-01", state: "open" },
    ];
    expect(missedInARow(week, "2026-10-01")).toBe(4);
    expect(missedInARow([...week.slice(0, 5), { day: "2026-09-30", state: "skipped" }, week[6]!], "2026-10-01")).toBe(0);
  });
});
