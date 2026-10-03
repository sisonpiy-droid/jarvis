// Pure, deterministic progress maths for goals and habits — no SQL, no AI. Everything is in IST calendar
// days ("YYYY-MM-DD"); weeks start on Monday. Progress, streaks and "missed" are derived from the activity
// log every time, never stored.

export type Day = string; // YYYY-MM-DD (IST)
export type Period = "day" | "week" | "month" | "quarter" | "year" | "total";
export type Metric = "count" | "duration_min" | "boolean" | "value";

const IST_MS = 330 * 60_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The IST calendar day of an instant. */
export function istDay(at: Date | string | number): Day {
  return new Date(new Date(at).getTime() + IST_MS).toISOString().slice(0, 10);
}

const toUtc = (d: Day) => {
  const m = DAY_RE.exec(d);
  if (!m) throw new Error(`not a day: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const fromUtc = (ms: number): Day => new Date(ms).toISOString().slice(0, 10);

export const isDay = (s: unknown): s is Day => typeof s === "string" && DAY_RE.test(s) && fromUtc(toUtc(s)) === s;
export const addDays = (d: Day, n: number): Day => fromUtc(toUtc(d) + n * 86_400_000);
export const daysBetween = (a: Day, b: Day) => Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
/** ISO weekday: Monday = 1 … Sunday = 7. */
export const weekday = (d: Day) => ((new Date(toUtc(d)).getUTCDay() + 6) % 7) + 1;

/** Start of an IST instant's day, as an ISO timestamp (for SQL ranges). */
export const dayStartIso = (d: Day) => new Date(toUtc(d) - IST_MS).toISOString();

export interface Window {
  from: Day; // inclusive
  to: Day; // exclusive
}

/** The period containing `day`. "total" runs from the goal's start with no end. */
export function periodWindow(period: Period, day: Day, start: Day = day): Window {
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  switch (period) {
    case "day":
      return { from: day, to: addDays(day, 1) };
    case "week": {
      const from = addDays(day, 1 - weekday(day));
      return { from, to: addDays(from, 7) };
    }
    case "month":
      return { from: fromUtc(Date.UTC(y, m - 1, 1)), to: fromUtc(Date.UTC(y, m, 1)) };
    case "quarter": {
      const q = Math.floor((m - 1) / 3) * 3;
      return { from: fromUtc(Date.UTC(y, q, 1)), to: fromUtc(Date.UTC(y, q + 3, 1)) };
    }
    case "year":
      return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
    case "total":
      return { from: start, to: "9999-12-31" };
  }
}

export const PERIOD_LABEL: Record<Period, string> = { day: "today", week: "this week", month: "this month", quarter: "this quarter", year: "this year", total: "in total" };
export const PER_LABEL: Record<Period, string> = { day: "a day", week: "a week", month: "a month", quarter: "a quarter", year: "a year", total: "in total" };

// ── goals ─────────────────────────────────────────────────────────────────────

export interface ActivityFact {
  day: Day;
  occurredAt: string;
  status: "done" | "skipped";
  value: number;
  durationMin: number | null;
}

export interface GoalFact {
  metric: Metric;
  targetValue: number | null;
  period: Period;
  startDate: Day;
  targetDate: Day | null;
}

export interface GoalProgress {
  window: Window;
  current: number | null;
  target: number | null;
  /** 0–1 (capped); null without a target. */
  ratio: number | null;
  met: boolean;
  /** Days left in the period including today (null for open-ended "total" goals without a target date). */
  daysLeft: number | null;
}

function measure(metric: Metric, acts: ActivityFact[]): number | null {
  const done = acts.filter((a) => a.status === "done");
  switch (metric) {
    case "count":
      return done.reduce((s, a) => s + a.value, 0);
    case "duration_min":
      return done.reduce((s, a) => s + (a.durationMin ?? a.value), 0);
    case "boolean":
      return done.length ? 1 : 0;
    case "value": {
      const last = [...done].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1);
      return last ? last.value : null;
    }
  }
}

/** Progress in the period containing `today`. Activities outside the window (or before the start) don't count. */
export function goalProgress(g: GoalFact, acts: ActivityFact[], today: Day): GoalProgress {
  const window = periodWindow(g.period, today, g.startDate);
  const inWindow = acts.filter((a) => a.day >= window.from && a.day < window.to && a.day >= g.startDate);
  const current = measure(g.metric, inWindow);
  const target = g.metric === "boolean" ? 1 : g.targetValue;
  const ratio = target && current != null ? Math.min(1, current / target) : null;
  const end = g.period === "total" ? (g.targetDate ? addDays(g.targetDate, 1) : null) : window.to;
  return {
    window,
    current,
    target,
    ratio,
    met: !!target && current != null && current >= target,
    daysLeft: end ? Math.max(0, daysBetween(today, end)) : null,
  };
}

/** The last `n` periods (oldest first), for history bars. "total" goals have no history. */
export function goalHistory(g: GoalFact, acts: ActivityFact[], today: Day, n = 8): Array<{ from: Day; current: number | null; met: boolean }> {
  if (g.period === "total") return [];
  const out: Array<{ from: Day; current: number | null; met: boolean }> = [];
  let w = periodWindow(g.period, today, g.startDate);
  for (let i = 0; i < n && w.to > g.startDate; i++) {
    const p = goalProgress(g, acts, w.from);
    out.unshift({ from: w.from, current: p.current, met: p.met });
    w = periodWindow(g.period, addDays(w.from, -1), g.startDate);
  }
  return out;
}

// ── habits ────────────────────────────────────────────────────────────────────

export type Schedule = { freq: "daily" } | { freq: "weekly"; days: number[] } | { freq: "weekly"; times: number } | { freq: "monthly"; times: number };

export class ScheduleError extends Error {}

/** Validates a schedule from the database, a form or the model. */
export function parseSchedule(v: unknown): Schedule {
  const s = (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown> | null;
  if (!s || typeof s !== "object") throw new ScheduleError("schedule is required");
  const intIn = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
  if (s.freq === "daily") return { freq: "daily" };
  if (s.freq === "weekly" && Array.isArray(s.days)) {
    const days = [...new Set(s.days.map(Number))].sort();
    if (!days.length || !days.every((d) => intIn(d, 1, 7))) throw new ScheduleError("weekly days must be 1 (Mon) to 7 (Sun)");
    return { freq: "weekly", days };
  }
  if ((s.freq === "weekly" || s.freq === "monthly") && s.times !== undefined) {
    const times = Number(s.times);
    if (!intIn(times, 1, s.freq === "weekly" ? 7 : 31)) throw new ScheduleError(`times must be 1 to ${s.freq === "weekly" ? 7 : 31}`);
    return s.freq === "weekly" ? { freq: "weekly", times } : { freq: "monthly", times };
  }
  throw new ScheduleError('schedule must be daily, weekly on days, weekly N times, or monthly N times');
}

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function describeSchedule(s: Schedule): string {
  if (s.freq === "daily") return "Every day";
  if ("days" in s) return s.days.length === 5 && s.days.join() === "1,2,3,4,5" ? "Weekdays" : s.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${s.times}× a ${s.freq === "weekly" ? "week" : "month"}`;
}

export interface HabitFact {
  schedule: Schedule;
  startDate: Day;
  endDate: Day | null;
  active: boolean;
}

export type DayState = "done" | "skipped" | "missed" | "open" | "rest" | "future";

export interface HabitStatus {
  /** Should it be done today (scheduled day, or a flexible quota not met yet)? */
  dueToday: boolean;
  today: "done" | "skipped" | null;
  /** Flexible habits: done so far this period and the quota. */
  periodDone: number;
  periodTarget: number | null;
  /** Consecutive scheduled days (or periods, for "N times") kept up. Skips don't break it; misses do. */
  streak: number;
  /** Last 7 days, oldest first. */
  week: Array<{ day: Day; state: DayState }>;
}

type Flexible = Extract<Schedule, { times: number }>;
const flexible = (s: Schedule): s is Flexible => "times" in s;
const inRange = (h: HabitFact, d: Day) => d >= h.startDate && (!h.endDate || d <= h.endDate);

/** Is `day` one of the habit's fixed scheduled days? (Flexible habits have no fixed days.) */
export function isScheduledDay(h: HabitFact, d: Day): boolean {
  if (!inRange(h, d)) return false;
  if (h.schedule.freq === "daily") return true;
  if ("days" in h.schedule) return h.schedule.days.includes(weekday(d));
  return false;
}

export function habitStatus(h: HabitFact, acts: ActivityFact[], today: Day): HabitStatus {
  const byDay = new Map<Day, "done" | "skipped">();
  for (const a of acts) byDay.set(a.day, a.status);
  const s = h.schedule;
  const todayState = byDay.get(today) ?? null;

  let periodDone = 0;
  let periodTarget: number | null = null;
  let dueToday: boolean;
  let streak = 0;

  if (flexible(s)) {
    const per: Period = s.freq === "weekly" ? "week" : "month";
    const doneIn = (w: Window) => [...byDay].filter(([d, st]) => st === "done" && d >= w.from && d < w.to).length;
    const w = periodWindow(per, today);
    periodDone = doneIn(w);
    periodTarget = s.times;
    dueToday = h.active && inRange(h, today) && periodDone < s.times && todayState === null;
    // Current period counts once met; an unfinished current period doesn't break the streak.
    if (periodDone >= s.times) streak++;
    let prev = periodWindow(per, addDays(w.from, -1));
    while (prev.to > h.startDate && doneIn(prev) >= s.times) {
      streak++;
      prev = periodWindow(per, addDays(prev.from, -1));
    }
  } else {
    dueToday = h.active && isScheduledDay(h, today) && todayState === null;
    if (byDay.get(today) === "done") streak++;
    for (let d = addDays(today, -1); d >= h.startDate && daysBetween(d, today) <= 400; d = addDays(d, -1)) {
      if (!isScheduledDay(h, d)) continue;
      const st = byDay.get(d);
      if (st === "done") streak++;
      else if (st === "skipped") continue;
      else break;
    }
  }

  const week: HabitStatus["week"] = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const st = byDay.get(d);
    let state: DayState;
    if (st) state = st;
    else if (!inRange(h, d)) state = d > today ? "future" : "rest";
    else if (flexible(s)) state = "rest";
    else if (!isScheduledDay(h, d)) state = "rest";
    else state = d === today ? "open" : "missed";
    week.push({ day: d, state });
  }
  return { dueToday, today: todayState, periodDone, periodTarget, streak, week };
}
