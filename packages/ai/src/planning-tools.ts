import * as db from "@jarvis/db";
import type { BriefFacts, Day, Deadline, FocusCtx, FocusItem, GoalWithProgress, HabitWithStatus, Sql, Task } from "@jarvis/db";
import type { Tool } from "./agent";

// The chief-of-staff questions: what to focus on, how the week looks, what got done, what the owner promised.
// Every answer is computed by @jarvis/db (the same focus formula and deadline rules as the brief and the
// command center); the model only reads and quotes it. Every date comes as an IST label and as `*_iso`.

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/** "Thu 1 Oct, 9:02 am" (IST). */
const stamp = (iso: string) => `${db.fmtIstShort(iso)}, ${db.fmtIstTime(iso)}`;
/** "Mon 28 Sep" for an IST day. */
const dayShort = (d: Day) => db.fmtIstShort(db.dayStartIso(d));
const rangeLabel = (from: Day, to: Day) => (from === to ? dayShort(from) : `${dayShort(from)} – ${dayShort(to)}`);

const due = (t: Pick<Task, "dueAt" | "dueIsDateOnly">, now: Date) => (t.dueAt ? db.whenLabel(t.dueAt, t.dueIsDateOnly, now) : null);
const taskBrief = (t: Task, now: Date) => ({ id: t.id, title: t.title, due: due(t, now), due_iso: t.dueAt, project: t.projectTitle ?? undefined });

/** The focus context loadBriefFacts ranks with, rebuilt from its facts (so a full re-rank agrees with it). */
const focusCtx = (f: BriefFacts, now: Date): FocusCtx => ({
  now,
  today: f.day,
  goals: new Map(f.goals.map((g) => [g.id, { title: g.title, risk: g.risk.risk, neglected: g.neglect.neglected, quietDays: g.neglect.quietDays }])),
  freeMin: f.freeTime.freeMin,
});

const focusOut = (i: FocusItem, rank: number, now: Date) => ({
  rank,
  id: i.task.id,
  title: i.task.title,
  project: i.task.projectTitle ?? undefined,
  project_id: i.task.projectId ?? undefined,
  priority: i.task.priority,
  status: i.task.status,
  due: due(i.task, now),
  due_iso: i.task.dueAt,
  overdue: i.bucket === "overdue" || undefined,
  effort_min: i.task.effortMin ?? undefined,
  score: i.score,
  reasons: i.reasons,
});

const thisPeriod = (h: HabitWithStatus) => (h.status.periodTarget != null ? `${h.status.periodDone}/${h.status.periodTarget}` : undefined);

/** "2/4 this week", "72.4 kg (latest)", or "nothing logged". */
function progressLabel(g: GoalWithProgress): string {
  const p = g.progress;
  if (p.target != null) return `${p.current ?? 0}/${p.target}${g.unit ? ` ${g.unit}` : ""} ${db.PERIOD_LABEL[g.period]}`;
  return p.current != null ? `${p.current}${g.unit ? ` ${g.unit}` : ""} (latest)` : "nothing logged";
}

const deadlineOut = (d: Deadline) => ({
  kind: d.kind,
  id: d.ref.id,
  title: d.title,
  due: d.when,
  due_iso: d.at,
  ...(d.kind === "task" && d.context ? { project: d.context } : {}),
  ...(d.kind === "assignment" && d.context ? { course: d.context } : {}),
  mesa: d.mesa || undefined,
});

const ACCOMPLISHED_PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month"] as const;
type AccomplishedPeriod = (typeof ACCOMPLISHED_PERIODS)[number];
const MAX_RANGE_DAYS = 92;

/** An IST day range, both ends included. */
export function accomplishedRange(period: AccomplishedPeriod, today: Day): { from: Day; to: Day } {
  const last = (w: { from: Day; to: Day }) => ({ from: w.from, to: db.addDays(w.to, -1) });
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: db.addDays(today, -1), to: db.addDays(today, -1) };
    case "this_week":
      return last(db.periodWindow("week", today));
    case "last_week":
      return last(db.periodWindow("week", db.addDays(db.periodWindow("week", today).from, -1)));
    case "this_month":
      return last(db.periodWindow("month", today));
    case "last_month":
      return last(db.periodWindow("month", db.addDays(db.periodWindow("month", today).from, -1)));
  }
}

/** Open tasks that read like something owed to someone else. */
export const OWE_RE = /\b(send|email|mail|reply|respond|follow[- ]?up|call|text|message|share|intro(duce)?|deliver|return|pay|get back to|confirm|promised?)\b/i;
export const COMMITMENTS_CAVEAT = "JARVIS has no people tracker yet; this comes from your tasks and notes.";

export function planningTools(sql: Sql, now: () => Date = () => new Date()): Tool[] {
  return [
    {
      name: "get_focus",
      effect: "read",
      description:
        "What to work on today, ranked by JARVIS's fixed focus formula (due date, priority, goal risk, fit with today's free time, neglect): professional and personal lists with the reasons, today's free time between classes, what could be deferred, and habits still due today. For 'what should I focus on', 'my priorities', 'what can I defer'.",
      parameters: obj({
        domain: { type: "string", enum: ["professional", "personal", "all"], description: "Default all" },
        limit: { type: "integer", description: "Items per list, 1–10 (default 5)" },
      }),
      async run(a) {
        const t = now();
        const f = await db.loadBriefFacts(sql, t);
        const domain = a.domain === "professional" || a.domain === "personal" ? a.domain : "all";
        const limit = clampInt(a.limit, 1, 10, 5);
        const ranked = db.rankFocus(f.openTasks, focusCtx(f, t));
        const list = (d: db.Domain) => ranked.filter((i) => i.task.domain === d).slice(0, limit).map((i, n) => focusOut(i, n + 1, t));
        const inDomain = (x: Task) => domain === "all" || x.domain === domain;
        return {
          today: f.day,
          now: stamp(t.toISOString()),
          free_today: {
            minutes: f.freeTime.freeMin,
            largest_gap_min: f.freeTime.largestMin,
            gaps: f.freeTime.gaps.map((g) => ({ from: db.fmtIstTime(g.from), to: db.fmtIstTime(g.to), minutes: g.min })),
            basis: "MESA classes + Google Calendar, 8 am–10 pm IST",
          },
          ...(domain !== "personal" ? { professional: list("professional") } : {}),
          ...(domain !== "professional" ? { personal: list("personal") } : {}),
          defer_candidates: f.defer.filter((i) => inDomain(i.task)).map((i) => ({ id: i.task.id, title: i.task.title, due: due(i.task, t), due_iso: i.task.dueAt, reason: i.deferReason })),
          habits_due_today: f.habits.filter((h) => h.status.dueToday).map((h) => ({ id: h.id, name: h.name, this_period: thisPeriod(h) })),
          waiting_count: f.openTasks.filter((x) => x.status === "waiting" && inDomain(x)).length,
          rule: "Ranked by a fixed formula (due date, priority, goal risk, fit with free time, neglect). Quote it; re-rank only if asked.",
        };
      },
    },
    {
      name: "get_week",
      effect: "read",
      description:
        "One IST week (Monday–Sunday) day by day: MESA classes, personal calendar events, deadlines (tasks, MESA assignments, project deadlines, key events — one line each), tasks done; plus goal progress, habits and what is overdue. For 'what is due this week', 'how does my week look', week reviews.",
      parameters: obj({ which: { type: "string", enum: ["this", "next", "last"], description: "Default this" } }),
      async run(a) {
        const t = now();
        const today = db.istDay(t);
        const shift = a.which === "next" ? 7 : a.which === "last" ? -7 : 0;
        const w = db.periodWindow("week", today);
        const from = db.addDays(w.from, shift);
        const end = db.addDays(w.to, shift); // exclusive
        const fromIso = db.dayStartIso(from);
        const toIso = db.dayStartIso(end);
        const [openTasks, projects, lmsDue, cal, done, goals, habits] = await Promise.all([
          db.listTasks(sql, { view: "open", limit: 500 }, t),
          db.listProjects(sql, { status: "open" }),
          db.lmsAssignmentsDue(sql, fromIso, toIso),
          db.calendarBetween(sql, fromIso, toIso),
          db.listTasks(sql, { view: "done", doneFrom: fromIso, doneTo: toIso, limit: 500 }, t),
          db.goalAttention(sql, t),
          db.listHabits(sql).then((h) => db.habitsWithStatus(sql, h, t)),
        ]);
        const deadlines = db.upcomingFrom({ openTasks, projects: projects.map((p) => ({ ...p, next: null })), lmsDue, calendarWeek: cal }, t, fromIso, toIso);
        const asDeadline = new Set(deadlines.map((d) => db.refKey(d.ref)));
        const onDay = (iso: string, d: Day) => db.istDay(iso) === d;
        const days = Array.from({ length: 7 }, (_, i) => {
          const d = db.addDays(from, i);
          return {
            date: d,
            label: dayShort(d),
            is_today: d === today,
            classes: cal
              .filter((e) => !e.personal && onDay(e.startAt, d))
              .map((e) => ({ time: e.allDay ? "all day" : db.fmtIstTime(e.startAt), title: e.title, course: e.course ?? undefined, room: e.room ?? undefined, cancelled: e.cancelled || undefined })),
            events: cal
              .filter((e) => e.personal && !e.cancelled && onDay(e.startAt, d) && !asDeadline.has(db.refKey(e.ref)))
              .map((e) => ({ time: e.allDay ? "all day" : db.fmtIstTime(e.startAt), title: e.title })),
            deadlines: deadlines.filter((x) => onDay(x.at, d)).map(deadlineOut),
            done: done.filter((x) => x.completedAt && onDay(x.completedAt, d)).length,
          };
        });
        return {
          week: { from, to: db.addDays(end, -1), label: rangeLabel(from, db.addDays(end, -1)) },
          today,
          days,
          goals: goals.map((g) => ({ id: g.id, title: g.title, progress: progressLabel(g), risk: g.risk.risk, why: g.risk.reason })),
          habits: habits.map((h) => ({ id: h.id, name: h.name, this_period: thisPeriod(h), last_7_days: h.status.week.map((x) => `${x.day}:${x.state}`).join(" ") })),
          overdue: openTasks.filter((x) => (x.status === "todo" || x.status === "doing") && x.dueAt != null && Date.parse(x.dueAt) < t.getTime()).map((x) => ({ id: x.id, title: x.title, due: due(x, t), due_iso: x.dueAt })),
          totals: { classes: cal.filter((e) => !e.personal && !e.cancelled).length, deadlines: deadlines.length, tasks_done: done.length },
        };
      },
    },
    {
      name: "get_accomplished",
      effect: "read",
      description:
        "What the owner got done in a period: completed tasks, MESA submissions, finished projects, habit check-ins, logged goal entries and current goal progress. For 'what did I accomplish', 'what got done', week and month reviews.",
      parameters: obj({
        period: { type: "string", enum: [...ACCOMPLISHED_PERIODS], description: "Default this_week (weeks run Monday–Sunday, IST)" },
        from: { type: "string", description: "Optional first day YYYY-MM-DD (overrides period)" },
        to: { type: "string", description: "Optional last day YYYY-MM-DD, inclusive (default today); at most 92 days after from" },
      }),
      async run(a) {
        const t = now();
        const today = db.istDay(t);
        let range: { from: Day; to: Day };
        if (str(a.from) || str(a.to)) {
          const from = str(a.from);
          const to = str(a.to) || today;
          if (!db.isDay(from) || !db.isDay(to)) throw new db.WorkInputError("from and to must be dates (YYYY-MM-DD)");
          if (to < from) throw new db.WorkInputError("to is before from");
          if (db.daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new db.WorkInputError(`a range can be at most ${MAX_RANGE_DAYS} days`);
          range = { from, to };
        } else {
          range = accomplishedRange(ACCOMPLISHED_PERIODS.find((p) => p === a.period) ?? "this_week", today);
        }
        const end = db.addDays(range.to, 1);
        const fromIso = db.dayStartIso(range.from);
        const toIso = db.dayStartIso(end);
        const [done, summary, closed, goals] = await Promise.all([
          db.listTasks(sql, { view: "done", doneFrom: fromIso, doneTo: toIso, limit: 500 }, t),
          db.activitySummary(sql, range.from, end),
          db.listProjects(sql, { status: "closed" }),
          db.listGoals(sql).then((gs) => db.goalsWithProgress(sql, gs.filter((g) => g.status === "active"), t)),
        ]);
        return {
          range: { ...range, label: rangeLabel(range.from, range.to) },
          tasks_done: {
            count: done.length,
            items: done.slice(0, 40).map((x) => ({ id: x.id, title: x.title, project: x.projectTitle ?? undefined, completed: x.completedAt ? stamp(x.completedAt) : null, completed_iso: x.completedAt })),
          },
          mesa_submitted: done.filter((x) => x.sourceRef?.startsWith("mesa:submit:")).map((x) => ({ id: x.id, title: x.title })),
          projects_completed: closed
            .filter((p) => p.status === "done" && p.completedAt != null && p.completedAt >= fromIso && p.completedAt < toIso)
            .map((p) => ({ id: p.id, title: p.title, completed_iso: p.completedAt })),
          habit_checkins: summary.habits,
          goal_logs: summary.goals.map((g) => ({ id: g.id, title: g.title, total: g.total, unit: g.unit ?? undefined, entries: g.entries })),
          goals_progress: goals.map((g) => ({ id: g.id, title: g.title, progress: progressLabel(g), met: g.progress.met })),
        };
      },
    },
    {
      name: "get_commitments",
      effect: "read",
      description:
        "What the owner owes other people and is waiting on: open tasks that read like a promise (send, reply, follow up, call, share …), tasks waiting on someone, notes about people, and people / open questions recorded on projects. There is no people tracker yet — always say so.",
      parameters: obj({}),
      async run() {
        const t = now();
        const [open, notes, items] = await Promise.all([
          db.listTasks(sql, { view: "open", limit: 500 }, t),
          sql`select id, subject_id, subject_label, content from jarvis.memories where active and scope = 'person' order by subject_id, id limit 40`,
          sql`
            select i.project_id, p.title, i.kind, i.body from jarvis.project_items i join jarvis.projects p on p.id = i.project_id
             where i.resolved_at is null and i.kind in ('person', 'question') and p.status in ('active', 'on_hold')
             order by p.id, i.created_at limit 40`,
        ]);
        return {
          caveat: COMMITMENTS_CAVEAT,
          you_owe: open.filter((x) => (x.status === "todo" || x.status === "doing") && x.source !== "mesa" && OWE_RE.test(x.title)).map((x) => taskBrief(x, t)),
          waiting_on_others: open.filter((x) => x.status === "waiting").map((x) => ({ id: x.id, title: x.title, since_iso: x.updatedAt, due: due(x, t), due_iso: x.dueAt })),
          people_notes: notes.map((r) => ({ memory_id: Number(r.id), person: String(r.subject_label ?? r.subject_id), content: String(r.content) })),
          project_people: items.map((r) => ({ project_id: Number(r.project_id), project: String(r.title), kind: String(r.kind), body: String(r.body) })),
        };
      },
    },
  ];
}
