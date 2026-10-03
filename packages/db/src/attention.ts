import type { Sql } from "./client";
import { getGoal, goalsWithProgress, habitsWithStatus, listGoals, listHabits, updateGoal, type GoalWithProgress, type Habit, type HabitWithStatus } from "./goals";
import { addDays, istDay, type Day } from "./progress";
import { goalNeglect, goalRisk, missedInARow, NEGLECT_DAYS, type NeglectResult, type RiskResult } from "./risk";
import { WorkInputError } from "./work";

// What needs attention: goal risk and neglect, slipping habits, and which tasks are due a reminder. Shared by
// the engine job, the dashboard and the chat. All numbers come from risk.ts / progress.ts (deterministic).

export interface GoalAttention extends GoalWithProgress {
  risk: RiskResult;
  neglect: NeglectResult;
  lastEntry: Day | null;
}

/** Every active goal with its risk and neglect state. Pass `habits` (active ones, from listHabits) if already loaded. */
export async function goalAttention(sql: Sql, now = new Date(), o: { habits?: Habit[] } = {}): Promise<GoalAttention[]> {
  const goals = (await listGoals(sql)).filter((g) => g.status === "active");
  if (!goals.length) return [];
  const today = istDay(now);
  const ids = goals.map((g) => g.id);
  const [withP, last, habits, snoozes] = await Promise.all([
    goalsWithProgress(sql, goals, now),
    sql`select goal_id, max(day) as last, bool_or(kind <> 'habit') as free from jarvis.activities where goal_id in ${sql(ids)} and status = 'done' group by goal_id`,
    o.habits ?? listHabits(sql),
    sql`select id, attention_snoozed_until from jarvis.goals where id in ${sql(ids)}`,
  ]);
  const lastBy = new Map(last.map((r) => [Number(r.goal_id), { last: r.last ? new Date(r.last as string).toISOString().slice(0, 10) : null, free: Boolean(r.free) }]));
  const snoozeBy = new Map(snoozes.map((r) => [Number(r.id), r.attention_snoozed_until ? new Date(r.attention_snoozed_until as string).toISOString().slice(0, 10) : null]));
  return withP.map((g) => {
    const feeders = habits.filter((h) => h.goalId === g.id);
    const l = lastBy.get(g.id);
    // Only habit check-ins feed it → at most one per habit per day; free entries can add any amount.
    const capacity = g.metric === "count" && feeders.length && !l?.free ? feeders.length : null;
    return {
      ...g,
      lastEntry: l?.last ?? null,
      risk: goalRisk(g, g.progress, today, capacity),
      neglect: goalNeglect(g, l?.last ?? null, today, snoozeBy.get(g.id) ?? null),
    };
  });
}

export interface HabitSlip {
  habit: HabitWithStatus;
  missed: number;
  /** First day of the current run of misses (stable while the run continues — used to alert once). */
  since: Day;
}

/** Active fixed-schedule habits missed `min`+ scheduled days in a row (skips and today don't count). */
export async function habitSlips(sql: Sql, now = new Date(), min = 3): Promise<HabitSlip[]> {
  return slipsFrom(await habitsWithStatus(sql, await listHabits(sql), now), istDay(now), min);
}

/** habitSlips() over habits whose status is already loaded (pure). */
export function slipsFrom(habits: HabitWithStatus[], today: Day, min = 3): HabitSlip[] {
  const out: HabitSlip[] = [];
  for (const h of habits) {
    if ("times" in h.schedule) continue; // flexible habits have no fixed days to miss
    const missed = missedInARow(h.status.week, today);
    if (missed < min) continue;
    const missedDays = h.status.week.filter((d) => d.day < today && d.state === "missed").map((d) => d.day);
    out.push({ habit: h, missed, since: missedDays[missedDays.length - missed] ?? missedDays[0]! });
  }
  return out;
}

export interface AttentionSummary {
  goals: GoalAttention[]; // at risk, off track or neglected
  habits: HabitSlip[];
  overdueTasks: number;
}

export async function attentionSummary(sql: Sql, now = new Date()): Promise<AttentionSummary> {
  const [goals, habits, [over]] = await Promise.all([
    goalAttention(sql, now),
    habitSlips(sql, now),
    sql`select count(*)::int as n from jarvis.tasks where status in ('todo', 'doing') and due_at < ${now.toISOString()}`,
  ]);
  return {
    goals: goals.filter((g) => g.risk.risk === "at_risk" || g.risk.risk === "off_track" || g.neglect.neglected),
    habits,
    overdueTasks: Number(over?.n ?? 0),
  };
}

// ── answers to a neglect / risk prompt ───────────────────────────────────────

export type GoalChoice = "continue" | "pause" | "change_target" | "archive";

/**
 * Continue → quiet the prompt for one neglect period; Pause → goal paused; Archive → abandoned (kept, with
 * its log); Change target → new target. Every answer is recorded in goal_decisions.
 */
export async function decideGoal(sql: Sql, goalId: number, choice: GoalChoice, o: { reason?: "neglect" | "risk"; target?: number } = {}, now = new Date()): Promise<void> {
  const g = await getGoal(sql, goalId);
  if (!g) throw new WorkInputError(`goal ${goalId} not found`);
  let detail: Record<string, unknown> | null = null;
  switch (choice) {
    case "continue": {
      const until = addDays(istDay(now), NEGLECT_DAYS[g.period]);
      await sql`update jarvis.goals set attention_snoozed_until = ${until}, updated_at = now() where id = ${goalId}`;
      detail = { until };
      break;
    }
    case "pause":
      await updateGoal(sql, goalId, { status: "paused" });
      break;
    case "archive":
      await updateGoal(sql, goalId, { status: "abandoned" });
      break;
    case "change_target":
      if (o.target == null) throw new WorkInputError("a new target is required");
      await updateGoal(sql, goalId, { targetValue: o.target });
      detail = { from: g.targetValue, to: o.target };
      break;
    default:
      throw new WorkInputError("choice must be continue, pause, change_target or archive");
  }
  await sql`
    insert into jarvis.goal_decisions (goal_id, reason, choice, detail)
    values (${goalId}, ${o.reason ?? "neglect"}, ${choice}, ${detail ? sql.json(detail as never) : null})`;
}

export async function goalDecisions(sql: Sql, goalId: number) {
  const rows = await sql`select reason, choice, detail, created_at from jarvis.goal_decisions where goal_id = ${goalId} order by id desc limit 20`;
  return rows.map((r) => ({ reason: String(r.reason), choice: String(r.choice) as GoalChoice, detail: (r.detail as Record<string, unknown> | null) ?? null, at: new Date(r.created_at as string).toISOString() }));
}

// ── task reminders ────────────────────────────────────────────────────────────

export interface TaskReminder {
  id: number;
  title: string;
  dueAt: string;
  kind: "due" | "prep";
  projectTitle: string | null;
}

const PREP_LEAD_MS = 48 * 3_600_000;
const EXACT_LEAD_MS = 60 * 60_000;
const MORNING_IST = 9; // date-only tasks: a nudge from 09:00 IST on the day

/**
 * Open tasks due a reminder now. MESA "Submit" tasks are skipped (the LMS deadline reminders cover them).
 * - exam prep: from 48 h before the exam;
 * - a task with an exact time: from 1 h before;
 * - a date-only task (and draft reviews): from 09:00 IST on its day.
 * Overdue tasks get no reminder here (they show as overdue on Today).
 */
export async function tasksToRemind(sql: Sql, now = new Date()): Promise<TaskReminder[]> {
  const rows = await sql`
    select t.id, t.title, t.due_at, t.due_is_date_only, t.source_ref, p.title as project_title
      from jarvis.tasks t left join jarvis.projects p on p.id = t.project_id
     where t.status in ('todo', 'doing') and t.due_at is not null
       and t.due_at > ${now.toISOString()} and t.due_at <= ${new Date(now.getTime() + PREP_LEAD_MS + 86_400_000).toISOString()}
       and coalesce(t.source_ref, '') not like 'mesa:submit:%'`;
  const today = istDay(now);
  const istHour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
  const out: TaskReminder[] = [];
  for (const r of rows) {
    const due = new Date(r.due_at as string);
    const ref = String(r.source_ref ?? "");
    const left = due.getTime() - now.getTime();
    let kind: TaskReminder["kind"] | null;
    if (ref.startsWith("mesa:prep:")) kind = left <= PREP_LEAD_MS ? "prep" : null;
    else if (r.due_is_date_only || ref.startsWith("mesa:review:")) kind = istDay(due) === today && istHour >= MORNING_IST ? "due" : null;
    else kind = left <= EXACT_LEAD_MS ? "due" : null;
    if (kind) out.push({ id: Number(r.id), title: String(r.title), dueAt: due.toISOString(), kind, projectTitle: (r.project_title as string | null) ?? null });
  }
  return out;
}
