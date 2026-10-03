import * as db from "@jarvis/db";
import type { Goal, GoalProgress, HabitWithStatus, Sql } from "@jarvis/db";
import type { Tool } from "./agent";

// Goals, habits and logging for the chat. Numbers (progress, streaks) are computed by @jarvis/db from the
// activity log — the model only reads them. Every write echoes exactly what was stored for a read-back.

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const numOrNull = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
/** get_attention calls the MESA data stale when the last successful LMS check is older than this. */
const LMS_STALE_MS = 3 * 3_600_000;

const SCHEDULE = {
  type: "object",
  description: 'How often: {"freq":"daily"} | {"freq":"weekly","days":[1,3,5]} (Mon=1…Sun=7) | {"freq":"weekly","times":4} | {"freq":"monthly","times":2}',
  properties: {
    freq: { type: "string", enum: ["daily", "weekly", "monthly"] },
    days: { type: "array", items: { type: "integer" } },
    times: { type: "integer" },
  },
  required: ["freq"],
};

const goalOut = (g: Goal, p?: GoalProgress) => ({
  id: g.id,
  title: g.title,
  target: g.metric === "boolean" ? `once ${db.PER_LABEL[g.period]}` : g.targetValue != null ? `${g.targetValue} ${g.unit ?? ""} ${db.PER_LABEL[g.period]}`.replace(/\s+/g, " ") : `track ${g.unit ?? "value"}`,
  metric: g.metric,
  status: g.status,
  domain: g.domain,
  area: g.area,
  starts: g.startDate,
  by: g.targetDate,
  ...(p
    ? {
        progress: {
          period: `${p.window.from} to ${db.addDays(p.window.to, -1)}`,
          current: p.current,
          target: p.target,
          percent: p.ratio == null ? null : Math.round(p.ratio * 100),
          met: p.met,
          days_left: p.daysLeft,
        },
      }
    : {}),
});

const habitOut = (h: HabitWithStatus) => ({
  id: h.id,
  name: h.name,
  schedule: db.describeSchedule(h.schedule),
  goal: h.goalTitle,
  reminder: h.reminderTime,
  active: h.active,
  today: h.status.today ?? (h.status.dueToday ? "not done yet" : "not due"),
  ...(h.status.periodTarget != null ? { this_period: `${h.status.periodDone}/${h.status.periodTarget}` } : {}),
  streak: h.status.streak,
  last_7_days: h.status.week.map((d) => `${d.day}:${d.state}`).join(" "),
});

async function resolveGoal(sql: Sql, v: unknown): Promise<number | null> {
  if (v === undefined || v === null || v === "") return null;
  const id = int(v);
  if (id) return id;
  const found = await db.listGoals(sql, { status: "all", search: String(v) });
  const open = found.filter((g) => g.status === "active" || g.status === "paused");
  const pick = open.length ? open : found;
  if (pick.length === 1) return pick[0]!.id;
  if (!pick.length) throw new db.WorkInputError(`no goal matches "${String(v)}"`);
  throw new db.WorkInputError(`several goals match: ${pick.slice(0, 6).map((g) => `${g.id} "${g.title}"`).join(", ")} — ask which one`);
}

async function resolveHabit(sql: Sql, v: unknown): Promise<number> {
  const id = int(v);
  if (id) return id;
  const q = str(v).toLowerCase();
  if (!q) throw new db.WorkInputError("habit is required");
  const all = await db.listHabits(sql, { includeInactive: true });
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  const hits = all.filter((h) => words.every((w) => h.name.toLowerCase().includes(w)));
  const pick = hits.filter((h) => h.active).length ? hits.filter((h) => h.active) : hits;
  if (pick.length === 1) return pick[0]!.id;
  if (!pick.length) throw new db.WorkInputError(`no habit matches "${str(v)}"`);
  throw new db.WorkInputError(`several habits match: ${pick.slice(0, 6).map((h) => `${h.id} "${h.name}"`).join(", ")} — ask which one`);
}

export function goalTools(sql: Sql, now: () => Date = () => new Date()): Tool[] {
  return [
    {
      name: "list_goals",
      effect: "read",
      description: "The user's goals with this period's progress (computed from what they logged), plus their habits with today's state, streaks and the last 7 days.",
      parameters: obj({ status: { type: "string", enum: ["open", "closed", "all"], description: "Default open" } }),
      async run(a) {
        const status = (["open", "closed", "all"] as const).find((s) => s === a.status) ?? "open";
        const goals = await db.goalsWithProgress(sql, await db.listGoals(sql, { status }), now());
        const habits = await db.habitsWithStatus(sql, await db.listHabits(sql), now());
        return { today: db.istDay(now()), goals: goals.map((g) => goalOut(g, g.progress)), habits: habits.map(habitOut) };
      },
    },
    {
      name: "get_goal",
      effect: "read",
      description: "One goal in full: progress this period, previous periods, its habits, linked tasks and recent log entries.",
      parameters: obj({ goal: { type: "string", description: "Goal id or title words" } }, ["goal"]),
      async run(a) {
        const id = await resolveGoal(sql, a.goal);
        const d = id ? await db.goalDetail(sql, id, now()) : null;
        if (!d) return { found: false };
        return {
          ...goalOut(d.goal, d.progress),
          description: d.goal.description,
          previous_periods: d.history.map((h) => ({ from: h.from, value: h.current, met: h.met })),
          habits: (await db.habitsWithStatus(sql, d.habits, now())).map(habitOut),
          tasks: d.tasks,
          recent_log: d.activities.slice(0, 15).map((x) => ({ day: x.day, kind: x.kind, status: x.status, value: x.value, minutes: x.durationMin, note: x.note })),
        };
      },
    },
    {
      name: "create_goal",
      effect: "write-local",
      description:
        "Create a measurable goal, e.g. 'work out 4 times a week' → metric count, target 4, unit workouts, period week; 'read 12 books this year' → count, 12, books, year; 'spend 5 hours on the startup weekly' → duration_min, 300, period week. For a repeated action, also pass habit so check-ins count toward it. Read back exactly what was stored.",
      parameters: obj(
        {
          title: { type: "string" },
          metric: { type: "string", enum: ["count", "duration_min", "boolean", "value"] },
          target: { type: "number", description: "Target per period (minutes for duration_min). Omit for boolean." },
          unit: { type: "string" },
          period: { type: "string", enum: ["day", "week", "month", "quarter", "year", "total"] },
          domain: { type: "string", enum: ["personal", "professional"] },
          area: { type: "string", description: "fitness, reading, career, startup, relationships, finance …" },
          by: { type: "string", description: "Optional end date YYYY-MM-DD" },
          start: { type: "string", description: "Optional start date YYYY-MM-DD (default today)" },
          description: { type: "string" },
          habit: { type: "string", description: "Optional name of a habit that feeds this goal, e.g. 'Work out'" },
          habit_schedule: SCHEDULE,
          habit_reminder: { type: "string", description: "Optional reminder time HH:MM (IST) for the habit" },
        },
        ["title"],
      ),
      async run(a) {
        const goal = await db.createGoal(
          sql,
          {
            title: str(a.title),
            ...(typeof a.metric === "string" ? { metric: a.metric as db.Metric } : {}),
            targetValue: numOrNull(a.target),
            unit: str(a.unit) || null,
            ...(typeof a.period === "string" ? { period: a.period as db.Period } : {}),
            ...(a.domain === "personal" || a.domain === "professional" ? { domain: a.domain } : {}),
            area: str(a.area) || null,
            targetDate: str(a.by) || null,
            startDate: str(a.start) || null,
            description: str(a.description) || null,
            source: "chat",
          },
          now(),
        );
        let habit = null;
        if (str(a.habit)) {
          const h = await db.createHabit(sql, { name: str(a.habit), goalId: goal.id, schedule: a.habit_schedule ?? { freq: "daily" }, reminderTime: str(a.habit_reminder) || null }, now());
          habit = habitOut((await db.habitsWithStatus(sql, [h], now()))[0]!);
        }
        const [withP] = await db.goalsWithProgress(sql, [goal], now());
        return { created: goalOut(goal, withP!.progress), habit };
      },
    },
    {
      name: "update_goal",
      effect: "write-local",
      description: "Change a goal: target, unit, period, end date, title, or status (active, paused, completed, abandoned).",
      parameters: obj(
        {
          goal: { type: "string", description: "Goal id or title words" },
          target: { type: "number" },
          unit: { type: "string" },
          period: { type: "string", enum: ["day", "week", "month", "quarter", "year", "total"] },
          by: { type: "string", description: "YYYY-MM-DD; empty string clears it" },
          title: { type: "string" },
          status: { type: "string", enum: ["active", "paused", "completed", "abandoned"] },
        },
        ["goal"],
      ),
      async run(a) {
        const id = await resolveGoal(sql, a.goal);
        if (!id) throw new db.WorkInputError("goal is required");
        const p: db.GoalPatch = {};
        if (a.target !== undefined) p.targetValue = numOrNull(a.target);
        if (typeof a.unit === "string") p.unit = a.unit;
        if (typeof a.period === "string") p.period = a.period as db.Period;
        if (typeof a.by === "string") p.targetDate = str(a.by) || null;
        if (typeof a.title === "string") p.title = a.title;
        if (typeof a.status === "string") p.status = a.status as db.GoalStatus;
        const g = await db.updateGoal(sql, id, p);
        if (!g) return { updated: false, reason: `goal ${id} not found` };
        const [withP] = await db.goalsWithProgress(sql, [g], now());
        return { updated: goalOut(g, withP!.progress) };
      },
    },
    {
      name: "create_habit",
      effect: "write-local",
      description: "Create a recurring habit (optionally counting toward a goal), with an optional daily reminder that has Done / Skip buttons.",
      parameters: obj(
        {
          name: { type: "string" },
          schedule: SCHEDULE,
          goal: { type: "string", description: "Optional goal id or title words it counts toward" },
          reminder: { type: "string", description: "Optional HH:MM (IST)" },
        },
        ["name"],
      ),
      async run(a) {
        const h = await db.createHabit(sql, { name: str(a.name), schedule: a.schedule ?? { freq: "daily" }, goalId: await resolveGoal(sql, a.goal), reminderTime: str(a.reminder) || null }, now());
        return { created: habitOut((await db.habitsWithStatus(sql, [h], now()))[0]!) };
      },
    },
    {
      name: "update_habit",
      effect: "write-local",
      description: "Change a habit's schedule, reminder time, name, goal, or pause/resume it.",
      parameters: obj(
        {
          habit: { type: "string", description: "Habit id or name words" },
          schedule: SCHEDULE,
          reminder: { type: "string", description: "HH:MM (IST); empty string removes the reminder" },
          name: { type: "string" },
          goal: { type: "string", description: "Goal id or title words; empty string unlinks" },
          active: { type: "boolean" },
        },
        ["habit"],
      ),
      async run(a) {
        const id = await resolveHabit(sql, a.habit);
        const p: db.HabitPatch = {};
        if (a.schedule !== undefined) p.schedule = a.schedule;
        if (typeof a.reminder === "string") p.reminderTime = str(a.reminder) || null;
        if (typeof a.name === "string") p.name = a.name;
        if (typeof a.goal === "string") p.goalId = str(a.goal) ? await resolveGoal(sql, a.goal) : null;
        if (typeof a.active === "boolean") p.active = a.active;
        const h = await db.updateHabit(sql, id, p);
        if (!h) return { updated: false, reason: `habit ${id} not found` };
        return { updated: habitOut((await db.habitsWithStatus(sql, [h], now()))[0]!) };
      },
    },
    {
      name: "get_attention",
      effect: "read",
      description:
        "What the owner is falling behind on / what is at risk: goals at risk or off track this period (with what's still needed and per-day pace), goals with nothing logged for a while, habits missed several times in a row, overdue tasks, deadlines due by tomorrow that aren't started or submitted, and whether the MESA data is current. All computed from their data — quote it, don't re-estimate.",
      parameters: obj({}),
      async run() {
        const t = now();
        // The brief's facts: the same goals, slips and overdue tasks as attentionSummary, plus its deadline risks.
        const f = await db.loadBriefFacts(sql, t);
        const at = (iso: string, dateOnly: boolean) => db.whenLabel(iso, dateOnly, t);
        const exp = f.mesa.sessionExpiresAt;
        const last = f.mesa.lastSuccessAt;
        return {
          today: f.day,
          goals: f.goals
            .filter((g) => g.risk.risk === "at_risk" || g.risk.risk === "off_track" || g.neglect.neglected)
            .map((g) => ({
              ...goalOut(g, g.progress),
              risk: g.risk.risk,
              why: g.risk.reason,
              still_needed: g.risk.remaining,
              per_day_to_catch_up: g.risk.perDay,
              quiet_days: g.neglect.neglected ? g.neglect.quietDays : undefined,
            })),
          habits_slipping: f.slipping.map((h) => ({ id: h.habit.id, name: h.habit.name, missed_in_a_row: h.missed, since: h.since })),
          overdue_tasks: f.overdue.length,
          overdue_list: [...f.overdue]
            .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!) || a.id - b.id)
            .slice(0, 10)
            .map((x) => ({ id: x.id, title: x.title, due: at(x.dueAt!, x.dueIsDateOnly), due_iso: x.dueAt, project: x.projectTitle ?? undefined })),
          deadlines_at_risk: db.risksFrom(f).flatMap((r): Array<{ kind: "task" | "assignment"; id: number | string; title: string; due: string; due_iso: string; why: string }> => {
            if (r.kind !== "soon") return [];
            const ref = r.refs[0];
            if (ref?.t === "task") {
              const x = f.openTasks.find((o) => o.id === ref.id);
              return x?.dueAt ? [{ kind: "task" as const, id: x.id, title: x.title, due: at(x.dueAt, x.dueIsDateOnly), due_iso: x.dueAt, why: "not started" }] : [];
            }
            if (ref?.t === "lms") {
              const x = f.lmsDue.find((o) => o.id === ref.id);
              return x ? [{ kind: "assignment" as const, id: x.id, title: x.title, due: at(x.dueAt, false), due_iso: x.dueAt, why: "not submitted" }] : [];
            }
            return [];
          }),
          system: {
            mesa_sign_in_expires: exp ? (Date.parse(exp) <= t.getTime() ? `expired ${db.fmtIstShort(exp)}` : at(exp, false)) : null,
            mesa_sign_in_expires_iso: exp,
            lms_last_updated: last ? `${db.fmtIstShort(last)}, ${db.fmtIstTime(last)}` : null,
            lms_last_updated_iso: last,
            lms_stale: !last || t.getTime() - Date.parse(last) > LMS_STALE_MS,
          },
        };
      },
    },
    {
      name: "respond_to_goal",
      effect: "write-local",
      description:
        "Record the user's answer about a neglected or slipping goal: continue (keep it, stop the reminder for a while), pause, change_target (with target), or archive (keeps the history). Only when the user has said which.",
      parameters: obj(
        {
          goal: { type: "string", description: "Goal id or title words" },
          choice: { type: "string", enum: ["continue", "pause", "change_target", "archive"] },
          target: { type: "number", description: "New target, for change_target" },
        },
        ["goal", "choice"],
      ),
      async run(a) {
        const id = await resolveGoal(sql, a.goal);
        if (!id) throw new db.WorkInputError("goal is required");
        const choice = a.choice as db.GoalChoice;
        await db.decideGoal(sql, id, choice, { ...(choice === "change_target" && a.target != null ? { target: Number(a.target) } : {}) }, now());
        const g = (await db.getGoal(sql, id))!;
        return { recorded: choice, goal: goalOut(g) };
      },
    },
    {
      name: "log_activity",
      effect: "write-local",
      description:
        "Record something the user did: a habit check-in ('worked out', 'skip reading today') or an entry toward a goal ('read 30 pages', 'spent 90 min on the deck', 'weighed 72.4'). Use habit for check-ins, goal for amounts. Defaults to today (IST); past days allowed, future days not.",
      parameters: obj({
        habit: { type: "string", description: "Habit id or name words (check-in)" },
        goal: { type: "string", description: "Goal id or title words (amount)" },
        status: { type: "string", enum: ["done", "skipped"], description: "Habits only; default done" },
        value: { type: "number", description: "Amount for a goal (pages, km, kg…); default 1" },
        minutes: { type: "integer", description: "Time spent, for duration goals" },
        day: { type: "string", description: "YYYY-MM-DD, default today" },
        note: { type: "string" },
      }),
      async run(a) {
        const day = str(a.day) || undefined;
        if (str(a.habit) || int(a.habit)) {
          const id = await resolveHabit(sql, a.habit);
          const act = await db.logHabit(sql, id, { status: a.status === "skipped" ? "skipped" : "done", ...(day ? { day } : {}), note: str(a.note) || null, durationMin: a.minutes == null ? null : Number(a.minutes), source: "chat" }, now());
          const h = (await db.habitsWithStatus(sql, [(await db.getHabit(sql, id))!], now()))[0]!;
          return { logged: { habit: h.name, day: act.day, status: act.status }, habit_now: habitOut(h) };
        }
        const goalId = await resolveGoal(sql, a.goal);
        if (!goalId) throw new db.WorkInputError("pass a habit (check-in) or a goal (amount)");
        const act = await db.logGoal(sql, goalId, { ...(a.value != null ? { value: Number(a.value) } : {}), durationMin: a.minutes == null ? null : Number(a.minutes), ...(day ? { day } : {}), note: str(a.note) || null, source: "chat" }, now());
        const g = (await db.getGoal(sql, goalId))!;
        const [withP] = await db.goalsWithProgress(sql, [g], now());
        return { logged: { goal: g.title, day: act.day, value: act.value, minutes: act.durationMin }, goal_now: goalOut(g, withP!.progress) };
      },
    },
  ];
}
