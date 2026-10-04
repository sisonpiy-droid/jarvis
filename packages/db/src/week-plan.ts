import type { Sql } from "./client";
import { fmtIstShort, fmtIstTime, type FreeTime } from "./focus";
import { getSetting, putSetting } from "./notifications";
import { dayStartIso, istDay, type Day } from "./progress";
import type { Situation } from "./situation";

// The week plan: work blocks for open tasks placed in real free gaps (the AI drafts, this file checks). One
// current plan, kept in jarvis.settings; approved blocks feed the chat briefing and the evening check-in.
// ponytail: one plan in settings, no plan history — add a table when past weeks need comparing.

export const WEEK_PLAN_KEY = "week_plan";
const MAX_CANDIDATES = 15;

export interface PlanBlock {
  taskId: number;
  title: string;
  start: string;
  minutes: number;
  why: string;
}

export interface WeekPlan {
  /** First day the plan covers (IST). */
  from: Day;
  createdAt: string;
  note: string | null;
  blocks: PlanBlock[];
  approvedAt: string | null;
}

export interface PlanInput {
  candidates: Array<{ id: number; title: string; dueAt: string | null; effortMin: number | null; priority: number; project: string | null }>;
  days: Array<{ day: Day; gaps: FreeTime["gaps"] }>;
}

/** Open tasks worth planning (due within the window, or undated P1/P2) and the free gaps from now to 7 days out. */
export function planInput(s: Situation): PlanInput {
  const end = dayStartIso(s.week[s.week.length - 1]!.day);
  const candidates = s.facts.openTasks
    .filter((t) => (t.status === "todo" || t.status === "doing") && (t.dueAt ? t.dueAt < new Date(Date.parse(end) + 86_400_000).toISOString() : t.priority <= 2))
    .sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9") || a.priority - b.priority)
    .slice(0, MAX_CANDIDATES)
    .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, effortMin: t.effortMin, priority: t.priority, project: t.projectTitle }));
  return { candidates, days: [{ day: s.facts.day, gaps: s.facts.freeTime.gaps }, ...s.week.map((d) => ({ day: d.day, gaps: d.gaps }))] };
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Keeps only blocks for listed tasks, inside a free gap, in the future, before the task's due, not overlapping. */
export function validatePlan(raw: unknown, input: PlanInput, now: Date): PlanBlock[] {
  const list = Array.isArray((raw as { blocks?: unknown })?.blocks) ? (raw as { blocks: unknown[] }).blocks : [];
  const tasks = new Map(input.candidates.map((c) => [c.id, c]));
  const out: PlanBlock[] = [];
  for (const b of list as Array<Record<string, unknown>>) {
    const task = tasks.get(Number(b.task_id));
    const day = input.days.find((d) => d.day === b.day);
    const m = HHMM.exec(String(b.start ?? ""));
    const minutes = Math.round(Number(b.minutes));
    if (!task || !day || !m || !(minutes >= 15 && minutes <= 240)) continue;
    const start = Date.parse(dayStartIso(day.day)) + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
    const end = start + minutes * 60_000;
    if (start < now.getTime()) continue;
    if (task.dueAt && end > Date.parse(task.dueAt)) continue;
    if (!day.gaps.some((g) => Date.parse(g.from) <= start && end <= Date.parse(g.to))) continue;
    if (out.some((o) => start < Date.parse(o.start) + o.minutes * 60_000 && Date.parse(o.start) < end)) continue;
    out.push({ taskId: task.id, title: task.title, start: new Date(start).toISOString(), minutes, why: String(b.why ?? "").slice(0, 160) });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export async function getWeekPlan(sql: Sql): Promise<WeekPlan | null> {
  return getSetting<WeekPlan>(sql, WEEK_PLAN_KEY).catch(() => null);
}

export async function saveWeekPlan(sql: Sql, plan: WeekPlan): Promise<void> {
  await putSetting(sql, WEEK_PLAN_KEY, plan);
}

/** Approves the plan, keeping only the blocks at `keep` (indexes); the rest are dropped. */
export async function approveWeekPlan(sql: Sql, keep: number[], now: Date): Promise<WeekPlan | null> {
  const plan = await getWeekPlan(sql);
  if (!plan) return null;
  const next = { ...plan, blocks: plan.blocks.filter((_, i) => keep.includes(i)), approvedAt: now.toISOString() };
  await saveWeekPlan(sql, next);
  return next;
}

/** "Mon 5 Oct 3:00–5:00 pm — DDDM workbook [task #5]" */
export const blockLine = (b: PlanBlock, withId = true) =>
  `${fmtIstShort(b.start)} ${fmtIstTime(b.start)}–${fmtIstTime(new Date(Date.parse(b.start) + b.minutes * 60_000).toISOString())} — ${b.title}${withId ? ` [task #${b.taskId}]` : ""}`;

/** Approved blocks that haven't ended, optionally on one IST day. */
export function upcomingBlocks(plan: WeekPlan | null, now: Date, day?: Day): PlanBlock[] {
  if (!plan?.approvedAt) return [];
  return plan.blocks.filter((b) => Date.parse(b.start) + b.minutes * 60_000 > now.getTime() && (!day || istDay(b.start) === day));
}
