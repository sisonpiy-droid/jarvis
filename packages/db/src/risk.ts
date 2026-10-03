// Pure goal risk and neglect rules — deterministic, table-tested, no SQL, no AI. Inputs are the derived
// progress (progress.ts) and the activity log; outputs are labels the engine job and the dashboard share.

import { addDays, daysBetween, periodWindow, type Day, type GoalFact, type GoalProgress, type Period } from "./progress";

export type Risk = "met" | "on_track" | "at_risk" | "off_track" | "untracked";

export interface RiskResult {
  risk: Risk;
  /** Share of the period gone, today included (0–1). */
  elapsed: number;
  /** What should be done by now at an even pace. */
  expected: number | null;
  /** Still to do, and per remaining day (today included). */
  remaining: number | null;
  perDay: number | null;
  /** One line, for cards and notifications. */
  reason: string;
}

/** Below these shares of the even pace a goal is at risk / off track, once enough of the period has passed. */
const AT_RISK_PACE = 0.8;
const OFF_TRACK_PACE = 0.5;
/** Too early in a period to judge (a Monday with nothing logged isn't "behind"). */
const MIN_ELAPSED = 0.3;

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Pace check for the current period. `dailyCapacity` is how much can still be done per day when only habit
 * check-ins feed the goal (one per habit per day); null when free entries can add any amount.
 */
export function goalRisk(g: GoalFact, p: GoalProgress, today: Day, dailyCapacity: number | null = null): RiskResult {
  const none = (reason: string): RiskResult => ({ risk: "untracked", elapsed: 0, expected: null, remaining: null, perDay: null, reason });
  if (g.metric === "value" || p.target == null || p.current == null) return none("No target pace to check");
  // A "total" goal needs an end date to have a pace.
  const window = g.period === "total" ? (g.targetDate ? { from: g.startDate, to: addDays(g.targetDate, 1) } : null) : p.window;
  if (!window) return none("No end date, so no pace to check");

  // A goal started mid-period is judged from its start, against a target scaled to the days it had.
  const from = window.from < g.startDate ? g.startDate : window.from;
  const total = Math.max(1, daysBetween(from, window.to));
  const share = total / Math.max(1, daysBetween(window.from, window.to));
  const gone = Math.min(total, Math.max(1, daysBetween(from, today) + 1));
  const elapsed = gone / total;
  const remaining = Math.max(0, p.target - p.current);
  const daysLeft = Math.max(1, total - gone + 1);
  const perDay = remaining / daysLeft;
  const expected = p.target * share * elapsed;
  const base = { elapsed, expected: round(expected), remaining: round(remaining), perDay: round(perDay) };

  if (remaining <= 0) return { ...base, risk: "met", reason: "Target reached" };
  if (dailyCapacity != null && remaining > dailyCapacity * daysLeft)
    return { ...base, risk: "off_track", reason: `${round(remaining)} still to do but only ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` };
  if (elapsed < MIN_ELAPSED && g.period !== "day") return { ...base, risk: "on_track", reason: "Early in the period" };
  const pace = expected > 0 ? p.current / expected : 1;
  const behind = `${round(p.current)} of ${round(p.target)} with ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
  if (pace < OFF_TRACK_PACE && elapsed >= 0.5) return { ...base, risk: "off_track", reason: behind };
  if (pace < AT_RISK_PACE) return { ...base, risk: "at_risk", reason: behind };
  return { ...base, risk: "on_track", reason: `On pace (${round(p.current)} of ${round(p.target)})` };
}

/** How long without any entry before a goal counts as neglected, by period. */
export const NEGLECT_DAYS: Record<Period, number> = { day: 3, week: 7, month: 14, quarter: 30, year: 45, total: 21 };

export interface NeglectResult {
  neglected: boolean;
  /** Days since the last entry (or since the goal started, if never logged). */
  quietDays: number;
  threshold: number;
}

/**
 * Neglect: nothing logged for the period's threshold. A goal younger than the threshold isn't neglected yet,
 * and a "Continue" answer snoozes it until `snoozedUntil`.
 */
export function goalNeglect(g: Pick<GoalFact, "period" | "startDate">, lastEntry: Day | null, today: Day, snoozedUntil: Day | null = null): NeglectResult {
  const threshold = NEGLECT_DAYS[g.period];
  const since = lastEntry ?? g.startDate;
  const quietDays = Math.max(0, daysBetween(since, today));
  const snoozed = !!snoozedUntil && snoozedUntil >= today;
  return { neglected: !snoozed && quietDays >= threshold, quietDays, threshold };
}

/** Consecutive scheduled days missed, ending yesterday (today is still open). From habitStatus().week. */
export function missedInARow(week: Array<{ day: Day; state: string }>, today: Day): number {
  let n = 0;
  for (let i = week.length - 1; i >= 0; i--) {
    const d = week[i]!;
    if (d.day >= today || d.state === "rest") continue;
    if (d.state === "missed") n++;
    else break;
  }
  return n;
}

/** The window id used to send a goal alert at most once per period (and again only if it gets worse). */
export const riskWindowKey = (g: GoalFact, p: GoalProgress) => (g.period === "total" ? g.startDate : periodWindow(g.period, p.window.from, g.startDate).from);
