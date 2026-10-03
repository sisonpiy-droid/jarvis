import type { Sql } from "./client";
import {
  addDays,
  goalHistory,
  goalProgress,
  habitStatus,
  isDay,
  istDay,
  parseSchedule,
  periodWindow,
  ScheduleError,
  type ActivityFact,
  type Day,
  type GoalProgress,
  type HabitStatus,
  type Metric,
  type Period,
  type Schedule,
} from "./progress";
import { WorkInputError, type Domain } from "./work";

// Goals, habits and the activity log (migration 0016). Storage and validation here; the maths is in
// progress.ts (pure). Used by the dashboard, the chat tools and the habits job.

export const GOAL_METRICS = ["count", "duration_min", "boolean", "value"] as const;
export const GOAL_PERIODS = ["day", "week", "month", "quarter", "year", "total"] as const;
export const GOAL_STATUSES = ["active", "completed", "paused", "abandoned"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Goal {
  id: number;
  title: string;
  description: string | null;
  domain: Domain;
  area: string | null;
  parentGoalId: number | null;
  metric: Metric;
  targetValue: number | null;
  unit: string | null;
  period: Period;
  startDate: Day;
  targetDate: Day | null;
  status: GoalStatus;
  priority: number;
  createdAt: string;
}

export interface Habit {
  id: number;
  goalId: number | null;
  goalTitle: string | null;
  name: string;
  description: string | null;
  schedule: Schedule;
  reminderTime: string | null; // HH:MM IST
  startDate: Day;
  endDate: Day | null;
  active: boolean;
}

export interface Activity extends ActivityFact {
  id: number;
  kind: "habit" | "task_done" | "log" | "auto";
  goalId: number | null;
  habitId: number | null;
  taskId: number | null;
  note: string | null;
  source: string;
}

type R = Record<string, unknown>;
const day = (v: unknown): Day | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const oneOf = <T extends string>(list: readonly T[], v: unknown, field: string): T => {
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  throw new WorkInputError(`${field} must be one of: ${list.join(", ")}`);
};
const dayOrNull = (v: unknown, field: string): Day | null => {
  if (v === undefined || v === null || v === "") return null;
  if (!isDay(v)) throw new WorkInputError(`${field} must be a date (YYYY-MM-DD)`);
  return v;
};

const toGoal = (r: R): Goal => ({
  id: Number(r.id),
  title: String(r.title),
  description: (r.description as string | null) ?? null,
  domain: r.domain as Domain,
  area: (r.area as string | null) ?? null,
  parentGoalId: r.parent_goal_id == null ? null : Number(r.parent_goal_id),
  metric: r.metric as Metric,
  targetValue: r.target_value == null ? null : Number(r.target_value),
  unit: (r.unit as string | null) ?? null,
  period: r.period as Period,
  startDate: day(r.start_date)!,
  targetDate: day(r.target_date),
  status: r.status as GoalStatus,
  priority: Number(r.priority),
  createdAt: iso(r.created_at)!,
});

const toHabit = (r: R): Habit => ({
  id: Number(r.id),
  goalId: r.goal_id == null ? null : Number(r.goal_id),
  goalTitle: (r.goal_title as string | null) ?? null,
  name: String(r.name),
  description: (r.description as string | null) ?? null,
  schedule: parseSchedule(r.schedule),
  reminderTime: r.reminder_time ? String(r.reminder_time).slice(0, 5) : null,
  startDate: day(r.start_date)!,
  endDate: day(r.end_date),
  active: Boolean(r.active),
});

const toActivity = (r: R): Activity => ({
  id: Number(r.id),
  day: day(r.day)!,
  occurredAt: iso(r.occurred_at)!,
  kind: r.kind as Activity["kind"],
  status: r.status as "done" | "skipped",
  goalId: r.goal_id == null ? null : Number(r.goal_id),
  habitId: r.habit_id == null ? null : Number(r.habit_id),
  taskId: r.task_id == null ? null : Number(r.task_id),
  value: Number(r.value),
  durationMin: r.duration_min == null ? null : Number(r.duration_min),
  note: (r.note as string | null) ?? null,
  source: String(r.source),
});

// ── goals ─────────────────────────────────────────────────────────────────────

export interface NewGoal {
  title: string;
  description?: string | null;
  domain?: Domain;
  area?: string | null;
  parentGoalId?: number | null;
  metric?: Metric;
  targetValue?: number | null;
  unit?: string | null;
  period?: Period;
  startDate?: Day | null;
  targetDate?: Day | null;
  priority?: number;
  source?: "manual" | "chat" | "rule";
}

function validTarget(metric: Metric, v: unknown): number | null {
  if (metric === "boolean") return null;
  if (v === undefined || v === null || v === "") {
    if (metric === "value") return null; // e.g. "track my weight" without a goal number
    throw new WorkInputError("target is required (e.g. 4 for 4 workouts a week)");
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new WorkInputError("target must be a positive number");
  return n;
}

export async function createGoal(sql: Sql, input: NewGoal, now = new Date()): Promise<Goal> {
  const title = clean(input.title, 300);
  if (!title) throw new WorkInputError("title is required");
  const metric = input.metric ? oneOf(GOAL_METRICS, input.metric, "metric") : "count";
  const period = input.period ? oneOf(GOAL_PERIODS, input.period, "period") : "week";
  const startDate = dayOrNull(input.startDate, "start date") ?? istDay(now);
  const targetDate = dayOrNull(input.targetDate, "target date");
  if (targetDate && targetDate < startDate) throw new WorkInputError("target date is before the start date");
  if (input.parentGoalId != null && !(await sql`select 1 from jarvis.goals where id = ${input.parentGoalId}`).length) throw new WorkInputError(`goal ${input.parentGoalId} not found`);
  const priority = input.priority == null ? 2 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) throw new WorkInputError("priority must be 1 (highest) to 4");
  const [r] = await sql`
    insert into jarvis.goals (title, description, domain, area, parent_goal_id, metric, target_value, unit, period, start_date, target_date, priority, source)
    values (${title}, ${text(input.description, 4000) || null}, ${input.domain ? oneOf(["personal", "professional"] as const, input.domain, "domain") : "personal"},
            ${clean(input.area, 40) || null}, ${input.parentGoalId ?? null}, ${metric}, ${validTarget(metric, input.targetValue)},
            ${clean(input.unit, 40) || (metric === "duration_min" ? "minutes" : null)}, ${period}, ${startDate}, ${targetDate}, ${priority}, ${input.source ?? "manual"})
    returning *`;
  return toGoal(r!);
}

export async function getGoal(sql: Sql, id: number): Promise<Goal | null> {
  const [r] = await sql`select * from jarvis.goals where id = ${id}`;
  return r ? toGoal(r) : null;
}

export async function listGoals(sql: Sql, f: { status?: "open" | "closed" | "all"; search?: string } = {}): Promise<Goal[]> {
  const status = f.status ?? "open";
  const search = f.search ? `%${f.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await sql`
    select * from jarvis.goals where true
      ${status === "open" ? sql`and status in ('active', 'paused')` : status === "closed" ? sql`and status in ('completed', 'abandoned')` : sql``}
      ${search ? sql`and title ilike ${search}` : sql``}
     order by status = 'paused', priority, id`;
  return rows.map(toGoal);
}

export interface GoalPatch {
  title?: string;
  description?: string | null;
  targetValue?: number | null;
  unit?: string | null;
  period?: Period;
  targetDate?: Day | null;
  status?: GoalStatus;
  priority?: number;
  area?: string | null;
}

export async function updateGoal(sql: Sql, id: number, p: GoalPatch): Promise<Goal | null> {
  const cur = await getGoal(sql, id);
  if (!cur) return null;
  const title = p.title !== undefined ? clean(p.title, 300) : cur.title;
  if (!title) throw new WorkInputError("title can't be empty");
  const period = p.period !== undefined ? oneOf(GOAL_PERIODS, p.period, "period") : cur.period;
  const target = p.targetValue !== undefined ? validTarget(cur.metric, p.targetValue) : cur.targetValue;
  const targetDate = p.targetDate !== undefined ? dayOrNull(p.targetDate, "target date") : cur.targetDate;
  const priority = p.priority !== undefined ? Number(p.priority) : cur.priority;
  if (!Number.isInteger(priority) || priority < 1 || priority > 4) throw new WorkInputError("priority must be 1 (highest) to 4");
  await sql`
    update jarvis.goals set title = ${title},
           description = ${p.description !== undefined ? text(p.description, 4000) || null : cur.description},
           target_value = ${target}, unit = ${p.unit !== undefined ? clean(p.unit, 40) || null : cur.unit},
           period = ${period}, target_date = ${targetDate}, priority = ${priority},
           status = ${p.status !== undefined ? oneOf(GOAL_STATUSES, p.status, "status") : cur.status},
           area = ${p.area !== undefined ? clean(p.area, 40) || null : cur.area}, updated_at = now()
     where id = ${id}`;
  return getGoal(sql, id);
}

export async function deleteGoal(sql: Sql, id: number): Promise<void> {
  await sql`delete from jarvis.goals where id = ${id}`;
}

/** A goal's activity, including its habits' check-ins (they carry the goal id too). */
export async function goalActivities(sql: Sql, goalId: number, since?: Day): Promise<Activity[]> {
  const rows = await sql`
    select * from jarvis.activities where goal_id = ${goalId} ${since ? sql`and day >= ${since}` : sql``}
     order by occurred_at desc, id desc limit 2000`;
  return rows.map(toActivity);
}

export interface GoalWithProgress extends Goal {
  progress: GoalProgress;
}

/** Goals with this period's progress, computed from the log (one query for all of them). */
export async function goalsWithProgress(sql: Sql, goals: Goal[], now = new Date()): Promise<GoalWithProgress[]> {
  if (!goals.length) return [];
  const today = istDay(now);
  // The earliest window start any of them needs.
  const since = goals.map((g) => periodWindow(g.period, today, g.startDate).from).sort()[0]!;
  const rows = await sql`select * from jarvis.activities where goal_id in ${sql(goals.map((g) => g.id))} and day >= ${since}`;
  const acts = rows.map(toActivity);
  return goals.map((g) => ({ ...g, progress: goalProgress(g, acts.filter((a) => a.goalId === g.id), today) }));
}

export interface ActivitySummary {
  /** Habit check-ins per habit in the range (habits with none are left out). */
  habits: Array<{ id: number; name: string; done: number; skipped: number }>;
  /** Free entries ("read 30 pages") per goal: their total (minutes for duration goals) and how many. */
  goals: Array<{ id: number; title: string; unit: string | null; total: number; entries: number }>;
}

/** What was logged on IST days [from, toExclusive): habit check-ins and free goal entries (get_accomplished). */
export async function activitySummary(sql: Sql, from: Day, toExclusive: Day): Promise<ActivitySummary> {
  const [habits, goals] = await Promise.all([
    sql`
      select h.id, h.name, count(*) filter (where a.status = 'done')::int as done, count(*) filter (where a.status = 'skipped')::int as skipped
        from jarvis.activities a join jarvis.habits h on h.id = a.habit_id
       where a.kind = 'habit' and a.day >= ${from} and a.day < ${toExclusive}
       group by h.id, h.name order by h.id`,
    sql`
      select g.id, g.title, g.unit, count(*)::int as entries,
             sum(case when g.metric = 'duration_min' then coalesce(a.duration_min, a.value) else a.value end) as total
        from jarvis.activities a join jarvis.goals g on g.id = a.goal_id
       where a.kind = 'log' and a.status = 'done' and a.day >= ${from} and a.day < ${toExclusive}
       group by g.id, g.title, g.unit order by g.id`,
  ]);
  return {
    habits: habits.map((r) => ({ id: Number(r.id), name: String(r.name), done: Number(r.done), skipped: Number(r.skipped) })),
    goals: goals.map((r) => ({ id: Number(r.id), title: String(r.title), unit: (r.unit as string | null) ?? null, total: Number(r.total ?? 0), entries: Number(r.entries) })),
  };
}

export async function goalDetail(sql: Sql, id: number, now = new Date()) {
  const g = await getGoal(sql, id);
  if (!g) return null;
  const today = istDay(now);
  const acts = await goalActivities(sql, id);
  const [habits, tasks] = await Promise.all([
    listHabits(sql, { goalId: id, includeInactive: true }),
    sql`select id, title, status, due_at from jarvis.tasks where goal_id = ${id} order by status in ('done', 'cancelled'), due_at nulls last limit 50`,
  ]);
  return {
    goal: g,
    progress: goalProgress(g, acts, today),
    history: goalHistory(g, acts, today, 8),
    activities: acts.slice(0, 50),
    habits,
    tasks: tasks.map((t) => ({ id: Number(t.id), title: String(t.title), status: String(t.status), dueAt: iso(t.due_at) })),
  };
}

// ── habits ────────────────────────────────────────────────────────────────────

export interface NewHabit {
  name: string;
  description?: string | null;
  goalId?: number | null;
  schedule?: unknown;
  reminderTime?: string | null;
  startDate?: Day | null;
  endDate?: Day | null;
}

const reminderOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(:00)?$/.exec(String(v).trim());
  if (!m) throw new WorkInputError("reminder time must be HH:MM (24-hour, IST)");
  return `${m[1]}:${m[2]}`;
};
const scheduleOf = (v: unknown): Schedule => {
  try {
    return parseSchedule(v ?? { freq: "daily" });
  } catch (err) {
    throw new WorkInputError(err instanceof ScheduleError ? err.message : "schedule is invalid");
  }
};

export async function createHabit(sql: Sql, input: NewHabit, now = new Date()): Promise<Habit> {
  const name = clean(input.name, 200);
  if (!name) throw new WorkInputError("name is required");
  if (input.goalId != null && !(await sql`select 1 from jarvis.goals where id = ${input.goalId}`).length) throw new WorkInputError(`goal ${input.goalId} not found`);
  const startDate = dayOrNull(input.startDate, "start date") ?? istDay(now);
  const [r] = await sql`
    insert into jarvis.habits (goal_id, name, description, schedule, reminder_time, start_date, end_date)
    values (${input.goalId ?? null}, ${name}, ${text(input.description, 2000) || null}, ${sql.json(scheduleOf(input.schedule) as never)},
            ${reminderOf(input.reminderTime)}, ${startDate}, ${dayOrNull(input.endDate, "end date")})
    returning id`;
  return (await getHabit(sql, Number(r!.id)))!;
}

export async function getHabit(sql: Sql, id: number): Promise<Habit | null> {
  const [r] = await sql`select h.*, g.title as goal_title from jarvis.habits h left join jarvis.goals g on g.id = h.goal_id where h.id = ${id}`;
  return r ? toHabit(r) : null;
}

export async function listHabits(sql: Sql, f: { goalId?: number; includeInactive?: boolean } = {}): Promise<Habit[]> {
  const rows = await sql`
    select h.*, g.title as goal_title from jarvis.habits h left join jarvis.goals g on g.id = h.goal_id
     where true ${f.includeInactive ? sql`` : sql`and h.active`} ${f.goalId != null ? sql`and h.goal_id = ${f.goalId}` : sql``}
     order by h.active desc, h.reminder_time nulls last, h.id`;
  return rows.map(toHabit);
}

export interface HabitPatch {
  name?: string;
  goalId?: number | null;
  schedule?: unknown;
  reminderTime?: string | null;
  active?: boolean;
  endDate?: Day | null;
}

export async function updateHabit(sql: Sql, id: number, p: HabitPatch): Promise<Habit | null> {
  const cur = await getHabit(sql, id);
  if (!cur) return null;
  const name = p.name !== undefined ? clean(p.name, 200) : cur.name;
  if (!name) throw new WorkInputError("name can't be empty");
  if (p.goalId != null && !(await sql`select 1 from jarvis.goals where id = ${p.goalId}`).length) throw new WorkInputError(`goal ${p.goalId} not found`);
  await sql`
    update jarvis.habits set name = ${name},
           goal_id = ${p.goalId !== undefined ? p.goalId : cur.goalId},
           schedule = ${sql.json((p.schedule !== undefined ? scheduleOf(p.schedule) : cur.schedule) as never)},
           reminder_time = ${p.reminderTime !== undefined ? reminderOf(p.reminderTime) : cur.reminderTime},
           active = ${p.active ?? cur.active},
           end_date = ${p.endDate !== undefined ? dayOrNull(p.endDate, "end date") : cur.endDate}, updated_at = now()
     where id = ${id}`;
  return getHabit(sql, id);
}

export async function deleteHabit(sql: Sql, id: number): Promise<void> {
  await sql`delete from jarvis.habits where id = ${id}`;
}

export interface HabitWithStatus extends Habit {
  status: HabitStatus;
}

/** Habits with today's state, streak and the last 7 days (one query for all of them). */
export async function habitsWithStatus(sql: Sql, habits: Habit[], now = new Date()): Promise<HabitWithStatus[]> {
  if (!habits.length) return [];
  const today = istDay(now);
  const rows = await sql`select * from jarvis.activities where habit_id in ${sql(habits.map((h) => h.id))} and day >= ${addDays(today, -400)}`;
  const acts = rows.map(toActivity);
  return habits.map((h) => ({ ...h, status: habitStatus(h, acts.filter((a) => a.habitId === h.id), today) }));
}

// ── logging ───────────────────────────────────────────────────────────────────

export type LogSource = "push_action" | "ui" | "chat" | "rule" | "calendar";

/**
 * Checks a habit in (or skips it) for an IST day — one entry per habit per day; logging again changes it.
 * The entry also counts toward the habit's goal.
 */
export async function logHabit(
  sql: Sql,
  habitId: number,
  o: { status?: "done" | "skipped"; day?: Day; value?: number; durationMin?: number | null; note?: string | null; source?: LogSource } = {},
  now = new Date(),
): Promise<Activity> {
  const h = await getHabit(sql, habitId);
  if (!h) throw new WorkInputError(`habit ${habitId} not found`);
  const d = o.day ?? istDay(now);
  if (!isDay(d)) throw new WorkInputError("day must be YYYY-MM-DD");
  if (d > istDay(now)) throw new WorkInputError("can't log a future day");
  const status = o.status ?? "done";
  const value = o.value ?? 1;
  if (!Number.isFinite(value) || value < 0) throw new WorkInputError("value must be a positive number");
  const occurredAt = d === istDay(now) ? now.toISOString() : new Date(Date.parse(`${d}T12:00:00+05:30`)).toISOString();
  const [r] = await sql`
    insert into jarvis.activities (occurred_at, day, kind, status, goal_id, habit_id, value, duration_min, note, source, dedupe_key)
    values (${occurredAt}, ${d}, 'habit', ${status}, ${h.goalId}, ${habitId}, ${value}, ${o.durationMin ?? null}, ${text(o.note, 1000) || null}, ${o.source ?? "ui"}, ${`habit:${habitId}:${d}`})
    on conflict (dedupe_key) do update set status = excluded.status, value = excluded.value, duration_min = excluded.duration_min,
      note = coalesce(excluded.note, jarvis.activities.note), source = excluded.source, goal_id = excluded.goal_id
    returning *`;
  return toActivity(r!);
}

/** Removes a habit's check-in for a day (undo). */
export async function unlogHabit(sql: Sql, habitId: number, d: Day): Promise<boolean> {
  return (await sql`delete from jarvis.activities where dedupe_key = ${`habit:${habitId}:${d}`} returning id`).length === 1;
}

/** A free entry toward a goal: "read 30 pages", "ran 5 km", "weighed 72.4". */
export async function logGoal(
  sql: Sql,
  goalId: number,
  o: { value?: number; durationMin?: number | null; day?: Day; note?: string | null; source?: LogSource } = {},
  now = new Date(),
): Promise<Activity> {
  const g = await getGoal(sql, goalId);
  if (!g) throw new WorkInputError(`goal ${goalId} not found`);
  const d = o.day ?? istDay(now);
  if (!isDay(d)) throw new WorkInputError("day must be YYYY-MM-DD");
  if (d > istDay(now)) throw new WorkInputError("can't log a future day");
  const duration = o.durationMin == null ? null : Math.round(Number(o.durationMin));
  if (duration != null && (!Number.isFinite(duration) || duration < 0 || duration > 1440)) throw new WorkInputError("duration must be 0–1440 minutes");
  const value = o.value ?? (g.metric === "duration_min" && duration != null ? duration : 1);
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new WorkInputError("value must be a positive number");
  const occurredAt = d === istDay(now) ? now.toISOString() : new Date(Date.parse(`${d}T12:00:00+05:30`)).toISOString();
  const [r] = await sql`
    insert into jarvis.activities (occurred_at, day, kind, goal_id, value, duration_min, note, source, dedupe_key)
    values (${occurredAt}, ${d}, 'log', ${goalId}, ${value}, ${duration}, ${text(o.note, 1000) || null}, ${o.source ?? "ui"}, ${`log:${crypto.randomUUID()}`})
    returning *`;
  return toActivity(r!);
}

export async function deleteActivity(sql: Sql, id: number): Promise<void> {
  await sql`delete from jarvis.activities where id = ${id}`;
}

// ── reminders (the habits job) ────────────────────────────────────────────────

/** How long after its reminder time a habit can still be reminded (a late job run, or one just created). */
const REMIND_WITHIN_MIN = 120;

/** Active habits whose reminder time passed in the last two hours (IST, same day) and that are still due today. */
export async function habitsToRemind(sql: Sql, now = new Date()): Promise<HabitWithStatus[]> {
  const today = istDay(now);
  const ist = new Date(now.getTime() + 330 * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const rows = await sql`
    select h.*, g.title as goal_title from jarvis.habits h left join jarvis.goals g on g.id = h.goal_id
     where h.active and h.reminder_time is not null and (g.id is null or g.status = 'active')`;
  const due = rows.map(toHabit).filter((h) => {
    const [hh, mm] = h.reminderTime!.split(":").map(Number);
    const since = minutes - (hh! * 60 + mm!);
    return since >= 0 && since <= REMIND_WITHIN_MIN && h.startDate <= today;
  });
  return (await habitsWithStatus(sql, due, now)).filter((h) => h.status.dueToday);
}
