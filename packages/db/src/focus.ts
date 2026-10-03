// What to work on today: a deterministic focus score, today's free time between classes, and what could
// wait. Pure — no SQL, no AI. The brief, the command center and the get_focus chat tool all rank with this,
// so they always agree. Points are integers bucketed by IST calendar day, so "due tomorrow" always matches
// the bucket that scored it.

import { daysBetween, dayStartIso, istDay, type Day } from "./progress";
import type { Risk } from "./risk";
import type { Task } from "./work";

export const DAY_START_HOUR = 8, DAY_END_HOUR = 22, MIN_GAP_MIN = 15, DEFAULT_EVENT_MIN = 60;

const IST_MS = 330 * 60_000;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

// ── IST formatting (by hand, so the output doesn't depend on the runtime's ICU data) ──

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ist = (iso: string) => new Date(Date.parse(iso) + IST_MS);

/** "5:00 pm" (IST). */
export const fmtIstTime = (iso: string): string => {
  const d = ist(iso);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

/** "Thu 3 Oct" (IST). */
export const fmtIstShort = (iso: string): string => {
  const d = ist(iso);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
};

/** "45 min" | "2 h" | "2 h 30 min". */
export function fmtMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

/**
 * When something is due, in IST: "today" / "today 5:00 pm", "tomorrow" / "tomorrow 9:00 am",
 * "Thu 3 Oct" / "Thu 3 Oct, 2:00 pm", or "overdue since Tue 29 Sep". A date-only value never shows a time.
 */
export function whenLabel(iso: string, dateOnly: boolean, now: Date): string {
  if (Date.parse(iso) < now.getTime()) return `overdue since ${fmtIstShort(iso)}`;
  const d = daysBetween(istDay(now), istDay(iso));
  const day = d === 0 ? "today" : d === 1 ? "tomorrow" : fmtIstShort(iso);
  if (dateOnly) return day;
  return d <= 1 ? `${day} ${fmtIstTime(iso)}` : `${day}, ${fmtIstTime(iso)}`;
}

// ── free time ─────────────────────────────────────────────────────────────────

export interface BusyEvent {
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  cancelled: boolean;
}

export interface FreeTime {
  freeMin: number;
  largestMin: number;
  gaps: Array<{ from: string; to: string; min: number }>;
}

/**
 * Free time left today between now (or 08:00 IST) and 22:00 IST, around every timed event that isn't
 * cancelled (MESA classes and the personal calendar). An event with no end counts as 60 minutes; gaps
 * under 15 minutes don't count.
 */
export function freeTime(events: BusyEvent[], now: Date): FreeTime {
  const start = Date.parse(dayStartIso(istDay(now)));
  const from = Math.max(now.getTime(), start + DAY_START_HOUR * 3_600_000);
  const to = start + DAY_END_HOUR * 3_600_000;
  if (from >= to) return { freeMin: 0, largestMin: 0, gaps: [] };

  const busy = events
    .filter((e) => !e.cancelled && !e.allDay && Number.isFinite(Date.parse(e.startAt)))
    .map((e) => {
      const s = Date.parse(e.startAt);
      const end = e.endAt ? Date.parse(e.endAt) : NaN;
      return [Math.max(from, s), Math.min(to, Number.isFinite(end) && end > s ? end : s + DEFAULT_EVENT_MIN * MIN_MS)] as const;
    })
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  const gaps: FreeTime["gaps"] = [];
  const gap = (a: number, b: number) => {
    const min = Math.floor((b - a) / MIN_MS);
    if (min >= MIN_GAP_MIN) gaps.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), min });
  };
  let cursor = from;
  for (const [s, e] of busy) {
    if (s > cursor) gap(cursor, s);
    cursor = Math.max(cursor, e);
  }
  if (to > cursor) gap(cursor, to);
  return { freeMin: gaps.reduce((n, g) => n + g.min, 0), largestMin: Math.max(0, ...gaps.map((g) => g.min)), gaps };
}

// ── focus score ───────────────────────────────────────────────────────────────

export interface GoalCtx {
  title: string;
  risk: Risk;
  neglected: boolean;
  quietDays: number;
}

export interface FocusCtx {
  now: Date;
  today: Day;
  /** Active goals by id (for tasks linked to a goal). */
  goals: Map<number, GoalCtx>;
  /** Free minutes left today; null when unknown (then effort doesn't count). */
  freeMin: number | null;
}

export type DueBucket = "overdue" | "today" | "tomorrow" | "soon" | "week" | "later" | "none";

export interface FocusItem {
  task: Task;
  score: number;
  /** One per non-zero part, in a fixed order; shown as-is by the brief, the command center and chat. */
  reasons: string[];
  bucket: DueBucket;
  parts: { due: number; priority: number; goal: number; effort: number; neglect: number; momentum: number };
}

const DUE_POINTS: Record<DueBucket, number> = { overdue: 40, today: 34, tomorrow: 26, soon: 18, week: 10, later: 4, none: 0 };
const PRIORITY_POINTS = [0, 25, 15, 7, 0]; // by priority 1..4

/** Due proximity in IST calendar days: today, tomorrow, 2–3 days (soon), 4–7 days (week), later. */
export function dueBucket(t: Pick<Task, "dueAt">, now: Date): DueBucket {
  if (!t.dueAt) return "none";
  if (Date.parse(t.dueAt) < now.getTime()) return "overdue";
  const d = daysBetween(istDay(now), istDay(t.dueAt));
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : d <= 3 ? "soon" : d <= 7 ? "week" : "later";
}

/**
 * score = due + priority + goal + effort + neglect + momentum (integers, about −10 … 97):
 * - due: overdue 40, today 34, tomorrow 26, 2–3 days 18, 4–7 days 10, later 4, none 0
 * - priority: P1 25, P2 15, P3 7, P4 0
 * - goal (linked goal, highest applies): off track 15, at risk 10, neglected 6
 * - effort (effort and free time both known): fits +5; doesn't fit −10, or 0 when overdue / due today
 * - neglect (undated only, by last edit): untouched 14+ days +8, 7–13 days +4
 * - momentum: in progress +6, next action +4
 */
export function focusScore(t: Task, ctx: FocusCtx): FocusItem {
  const reasons: string[] = [];
  const bucket = dueBucket(t, ctx.now);

  const due = DUE_POINTS[bucket];
  if (t.dueAt) reasons.push(bucket === "overdue" ? whenLabel(t.dueAt, t.dueIsDateOnly, ctx.now) : `due ${whenLabel(t.dueAt, t.dueIsDateOnly, ctx.now)}`);

  const priority = PRIORITY_POINTS[t.priority] ?? 0;
  if (t.priority <= 2) reasons.push(`P${t.priority}`);

  let goal = 0;
  const g = t.goalId != null ? ctx.goals.get(t.goalId) : undefined;
  if (g?.risk === "off_track") {
    goal = 15;
    reasons.push(`goal “${g.title}” off track`);
  } else if (g?.risk === "at_risk") {
    goal = 10;
    reasons.push(`goal “${g.title}” at risk`);
  } else if (g?.neglected) {
    goal = 6;
    reasons.push(`goal “${g.title}” quiet ${g.quietDays} days`);
  }

  let effort = 0;
  if (t.effortMin != null && ctx.freeMin != null) {
    if (t.effortMin <= ctx.freeMin) {
      effort = 5;
      reasons.push(`fits today's free time (${t.effortMin} of ${ctx.freeMin} min)`);
    } else {
      // Due now regardless: no penalty (the brief shows an effort risk instead).
      effort = bucket === "overdue" || bucket === "today" ? 0 : -10;
      reasons.push(`needs ${t.effortMin} min, ${ctx.freeMin} free today`);
    }
  }

  let neglect = 0;
  if (!t.dueAt) {
    const quiet = Math.floor((ctx.now.getTime() - Date.parse(t.updatedAt)) / DAY_MS);
    neglect = quiet >= 14 ? 8 : quiet >= 7 ? 4 : 0;
    if (neglect) reasons.push(`untouched ${quiet} days`);
  }

  let momentum = 0;
  if (t.status === "doing") {
    momentum += 6;
    reasons.push("in progress");
  }
  if (t.isNextAction) {
    momentum += 4;
    reasons.push("next action");
  }

  return { task: t, score: due + priority + goal + effort + neglect + momentum, reasons, bucket, parts: { due, priority, goal, effort, neglect, momentum } };
}

/** Score desc, then due asc (no date last), priority, id — a total order, so input order never matters. */
const byFocus = (a: FocusItem, b: FocusItem) =>
  b.score - a.score || (a.task.dueAt ?? "￿").localeCompare(b.task.dueAt ?? "￿") || a.task.priority - b.task.priority || a.task.id - b.task.id;

/** Open tasks to do (todo / doing — waiting tasks are someone else's move), best first. */
export function rankFocus(tasks: Task[], ctx: FocusCtx): FocusItem[] {
  return tasks.filter((t) => t.status === "todo" || t.status === "doing").map((t) => focusScore(t, ctx)).sort(byFocus);
}

const PREP_SOON_MS = 2 * DAY_MS;

/**
 * Tasks that could reasonably wait: not started, not P1, not a MESA submission or an exam prep due within
 * 2 days, due in 2+ days (or undated), and either low priority (P3/P4) or too big for today's free time.
 * Lowest score first, at most `n`.
 */
export function deferCandidates(ranked: FocusItem[], ctx: FocusCtx, n = 5): Array<FocusItem & { deferReason: string }> {
  const out: Array<FocusItem & { deferReason: string }> = [];
  for (const it of ranked) {
    const t = it.task;
    if (t.status !== "todo" || t.priority === 1) continue;
    const ref = t.sourceRef ?? "";
    if (ref.startsWith("mesa:submit:")) continue;
    if (ref.startsWith("mesa:prep:") && t.dueAt && Date.parse(t.dueAt) - ctx.now.getTime() <= PREP_SOON_MS) continue;
    if (t.dueAt && daysBetween(ctx.today, istDay(t.dueAt)) < 2) continue;
    const low = t.priority >= 3;
    const tooBig = t.effortMin != null && ctx.freeMin != null && t.effortMin > ctx.freeMin;
    if (!low && !tooBig) continue;
    const why = [t.dueAt ? `not due until ${fmtIstShort(t.dueAt)}` : "no due date"];
    if (low) why.push(`P${t.priority}`);
    if (tooBig) why.push(`won't fit today (${t.effortMin} of ${ctx.freeMin} min free)`);
    out.push({ ...it, deferReason: why.join(" · ") });
  }
  return out.sort((a, b) => a.score - b.score || a.task.id - b.task.id).slice(0, n);
}
