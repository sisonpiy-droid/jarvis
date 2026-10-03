import type { Sql } from "./client";
import { goalAttention, slipsFrom, type GoalAttention, type HabitSlip } from "./attention";
import { deferCandidates, freeTime, fmtMinutes, rankFocus, whenLabel, type FocusCtx, type FocusItem, type FreeTime } from "./focus";
import { habitsWithStatus, listHabits, type HabitWithStatus } from "./goals";
import { unreadCount } from "./notifications";
import { addDays, dayStartIso, istDay, type Day } from "./progress";
import { getIntegration } from "./repo";
import type { Risk } from "./risk";
import { listProjects, listTasks, nextActionFrom, type Project, type Task } from "./work";

// The facts behind the daily brief, the command center and the get_focus chat tool — one loader, so they
// never disagree. Every fact carries a ref to the row it came from (FactRef), so each brief line can be
// traced back to the database. Edge-safe: postgres.js only, no Node APIs.

export type FactRef =
  | { t: "task" | "goal" | "habit" | "project"; id: number }
  | { t: "lms"; kind: "assignment" | "event" | "gcal_event"; id: string } // lms_items.source_id
  | { t: "integration"; id: "mesa" };

/** A stable string for a ref (dedupe, set membership). */
export const refKey = (r: FactRef): string => (r.t === "lms" ? `lms:${r.kind}:${r.id}` : `${r.t}:${r.id}`);

export interface CalendarEntry {
  ref: FactRef;
  title: string;
  course: string | null;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  /** From the personal Google Calendar (gcal_event) rather than MESA. */
  personal: boolean;
  cancelled: boolean;
  room: string | null;
  type: string | null;
}

export interface LmsDue {
  ref: FactRef;
  id: string;
  title: string;
  course: string | null;
  dueAt: string;
  status: string;
}

export interface Deadline {
  ref: FactRef;
  kind: "task" | "assignment" | "project" | "event";
  title: string;
  at: string;
  dateOnly: boolean;
  when: string;
  href: string;
  mesa: boolean;
  context: string | null;
}

export interface RiskItem {
  kind: "overdue" | "soon" | "goal" | "neglect" | "habit" | "effort" | "session" | "stale";
  severity: 1 | 2 | 3;
  /** Plain text; the renderer escapes it. */
  text: string;
  refs: FactRef[];
  href: string;
}

export interface BriefFacts {
  v: 1;
  day: Day;
  at: string;
  /** "Thursday, 1 October" */
  label: string;
  /** Sent after 10:00 without fresh MESA data. */
  stale: boolean;
  /** listTasks view 'today' (same predicate as /tasks). */
  tasksToday: Task[];
  /** listTasks view 'open'. */
  openTasks: Task[];
  /** rankFocus(todo | doing), top 40. */
  focus: FocusItem[];
  defer: Array<FocusItem & { deferReason: string }>;
  freeTime: FreeTime;
  /** Habits due or answered today. */
  habits: HabitWithStatus[];
  /** IST today: all-day first, then by start. */
  calendar: CalendarEntry[];
  /** Tomorrow .. +7 days. */
  calendarWeek: CalendarEntry[];
  lmsDue: LmsDue[];
  /** (IST end of today, +7 days], one line per entity. */
  upcoming: Deadline[];
  /** All active goals. */
  goals: GoalAttention[];
  slipping: HabitSlip[];
  /** todo | doing, due before now. */
  overdue: Task[];
  /** Open projects with their next action. */
  projects: Array<Project & { next: Task | null }>;
  unread: number;
  doneToday: number;
  mesa: { status: string | null; lastSuccessAt: string | null; sessionExpiresAt: string | null };
}

export interface BriefSections {
  /** Top 3 professional focus items with a positive score. */
  priorities: FocusItem[];
  /** Habits due or answered today; top 3 personal focus items. */
  personal: { habits: HabitWithStatus[]; tasks: FocusItem[] };
  upcoming: Deadline[];
  /** Goals with a target: off track, at risk, on track, met; then priority, id. */
  goals: GoalAttention[];
  /** Severity desc (stable). */
  risks: RiskItem[];
}

/** One rendered line of a brief, with the rows it came from. */
export interface BriefLine {
  kind: "title" | "meta" | "heading" | "item" | "more" | "note" | "blank";
  html: string;
  refs: FactRef[];
}

/** A brief as stored in jarvis.briefs (migration 0018). */
export interface StoredBrief {
  day: Day;
  lines: BriefLine[];
  text: string;
  note: string | null;
  noteSource: "ai" | "fallback";
  noteDetail: string | null;
  noteRefs: FactRef[];
  createdAt: string;
}

type R = Record<string, unknown>;
const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;
const iso = (v: unknown): string | null => (v == null || v === "" ? null : new Date(v as string).toISOString());
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayLabel = (d: Day) => {
  const x = new Date(`${d}T00:00:00Z`);
  return `${WEEKDAYS_LONG[x.getUTCDay()]}, ${x.getUTCDate()} ${MONTHS_LONG[x.getUTCMonth()]}`;
};
/** A deadline stored as "end of that day" (23:59 IST) — shown without a time. */
const endOfIstDay = (at: string) => new Date(Date.parse(at) + IST_MS).toISOString().slice(11, 16) === "23:59";

// ── SQL ───────────────────────────────────────────────────────────────────────

/** MESA classes/events and personal calendar entries starting in [from, to). */
export async function calendarBetween(sql: Sql, fromIso: string, toIso: string): Promise<CalendarEntry[]> {
  const rows = await sql`
    select kind, source_id, title, data, sort_at from jarvis.lms_items
     where kind in ('event', 'gcal_event') and removed_at is null and sort_at >= ${fromIso} and sort_at < ${toIso}
     order by sort_at, kind, source_id`;
  return rows.map((r) => {
    const d = (r.data ?? {}) as R;
    const kind = r.kind as "event" | "gcal_event";
    return {
      ref: { t: "lms", kind, id: String(r.source_id) },
      title: str(d.title) ?? String(r.title),
      course: str(d.courseName),
      startAt: iso(d.startAt) ?? iso(r.sort_at)!,
      endAt: iso(d.endAt),
      allDay: Boolean(d.allDay),
      personal: kind === "gcal_event",
      cancelled: d.status === "cancelled",
      room: str(d.room),
      type: str(d.eventType),
    };
  });
}

/** Unsubmitted MESA assignments due in [from, to). */
export async function lmsAssignmentsDue(sql: Sql, fromIso: string, toIso: string): Promise<LmsDue[]> {
  const rows = await sql`
    select source_id, title, data, sort_at from jarvis.lms_items
     where kind = 'assignment' and removed_at is null and sort_at >= ${fromIso} and sort_at < ${toIso}
       and coalesce(data ->> 'submissionStatus', '') not in ('submitted', 'submitted_late')
     order by sort_at, source_id`;
  return rows.map((r) => {
    const d = (r.data ?? {}) as R;
    const id = String(r.source_id);
    return { ref: { t: "lms", kind: "assignment", id }, id, title: str(d.title) ?? String(r.title), course: str(d.courseTitle), dueAt: iso(d.dueAt) ?? iso(r.sort_at)!, status: str(d.submissionStatus) ?? "" };
  });
}

// ── stored briefs ─────────────────────────────────────────────────────────────

const toStoredBrief = (r: R): StoredBrief => ({
  day: String(r.day),
  lines: (r.lines ?? []) as BriefLine[],
  text: String(r.text),
  note: str(r.note),
  noteSource: r.note_source === "ai" ? "ai" : "fallback",
  noteDetail: str(r.note_detail),
  noteRefs: (r.note_refs ?? []) as FactRef[],
  createdAt: iso(r.created_at)!,
});

/** The daily brief for an IST day, as it was rendered and queued. */
export async function getBrief(sql: Sql, day: Day): Promise<StoredBrief | null> {
  const [r] = await sql`
    select day::text as day, lines, text, note, note_source, note_detail, note_refs, created_at
      from jarvis.briefs where kind = 'daily' and day = ${day}`;
  return r ? toStoredBrief(r) : null;
}

/**
 * Stores the day's brief. The note is written once: a second save for the same day (a rebuild after a run that
 * stored the brief but never queued it) only refreshes the lines and text, so `text` is always what was queued.
 */
export async function saveBrief(sql: Sql, b: Omit<StoredBrief, "createdAt">): Promise<StoredBrief> {
  await sql`
    insert into jarvis.briefs (kind, day, lines, text, note, note_source, note_detail, note_refs)
    values ('daily', ${b.day}, ${sql.json(b.lines as never)}, ${b.text}, ${b.note || null}, ${b.noteSource}, ${b.noteDetail}, ${sql.json(b.noteRefs as never)})
    on conflict (kind, day) do update set lines = excluded.lines, text = excluded.text`;
  return (await getBrief(sql, b.day))!;
}

// ── the loader ────────────────────────────────────────────────────────────────

export async function loadBriefFacts(sql: Sql, now: Date, o: { stale?: boolean } = {}): Promise<BriefFacts> {
  const today = istDay(now);
  const horizon = dayStartIso(addDays(today, 8));
  const [tasksToday, openTasks, [allHabits, goals], projects, cal, lmsDue, integ, unread, [done]] = await Promise.all([
    listTasks(sql, { view: "today", limit: 50 }, now),
    listTasks(sql, { view: "open", limit: 500 }, now),
    listHabits(sql).then((habits) => Promise.all([habitsWithStatus(sql, habits, now), goalAttention(sql, now, { habits })] as const)),
    listProjects(sql, { status: "open" }),
    calendarBetween(sql, dayStartIso(today), horizon),
    lmsAssignmentsDue(sql, new Date(now.getTime() - 3 * DAY_MS).toISOString(), horizon),
    getIntegration(sql, "mesa"),
    unreadCount(sql),
    sql`select count(*)::int as n from jarvis.tasks where status = 'done' and completed_at >= ${dayStartIso(today)}`,
  ]);

  const calendar = cal.filter((e) => istDay(e.startAt) === today).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt.localeCompare(b.startAt));
  const calendarWeek = cal.filter((e) => istDay(e.startAt) > today);
  const free = freeTime(calendar, now);
  const ctx: FocusCtx = {
    now,
    today,
    goals: new Map(goals.map((g) => [g.id, { title: g.title, risk: g.risk.risk, neglected: g.neglect.neglected, quietDays: g.neglect.quietDays }])),
    freeMin: free.freeMin,
  };
  const ranked = rankFocus(openTasks, ctx);
  const base = { openTasks, projects: projects.map((p) => ({ ...p, next: nextActionFrom(openTasks, p.id) })), lmsDue, calendarWeek };

  return {
    v: 1,
    day: today,
    at: now.toISOString(),
    label: dayLabel(today),
    stale: o.stale ?? false,
    tasksToday,
    ...base,
    focus: ranked.slice(0, 40),
    defer: deferCandidates(ranked, ctx, 5),
    freeTime: free,
    habits: allHabits.filter((h) => h.status.dueToday || h.status.today !== null),
    calendar,
    upcoming: upcomingFrom(base, now, dayStartIso(addDays(today, 1)), horizon),
    goals,
    slipping: slipsFrom(allHabits, today),
    overdue: openTasks.filter((t) => (t.status === "todo" || t.status === "doing") && t.dueAt != null && Date.parse(t.dueAt) < now.getTime()),
    unread,
    doneToday: Number(done?.n ?? 0),
    mesa: { status: integ?.status ?? null, lastSuccessAt: integ?.lastSuccessAt ?? null, sessionExpiresAt: integ?.sessionExpiresAt ?? null },
  };
}

// ── deadlines ─────────────────────────────────────────────────────────────────

/** Personal calendar entries worth listing as deadlines (MESA classes never are). */
export const KEY_EVENT_RE = /\b(interview|exam|mid-?term|end-?term|quiz|viva|presentation|deadline|submission|pitch)\b/i;

const submitId = (t: Task) => (t.sourceRef?.startsWith("mesa:submit:") ? t.sourceRef.slice("mesa:submit:".length) : null);

/**
 * Deadlines in [from, to), one line per entity: open tasks (a MESA "Submit" task stands for its assignment);
 * assignments without a task; open projects whose deadline isn't already a task's due time (exam prep); and
 * key personal calendar entries (interviews, exams …). Sorted by time, then title.
 */
export function upcomingFrom(f: Pick<BriefFacts, "openTasks" | "projects" | "lmsDue" | "calendarWeek">, now: Date, from: string, to: string): Deadline[] {
  const inWindow = (at: string | null): at is string => !!at && at >= from && at < to;
  const out: Deadline[] = [];
  const submitTasks = new Set(f.openTasks.map(submitId).filter((x): x is string => x != null));

  for (const t of f.openTasks) {
    if (!inWindow(t.dueAt)) continue;
    const sub = submitId(t);
    out.push({
      ref: { t: "task", id: t.id },
      kind: sub ? "assignment" : "task",
      title: t.title,
      at: t.dueAt,
      dateOnly: t.dueIsDateOnly,
      when: whenLabel(t.dueAt, t.dueIsDateOnly, now),
      href: sub ? `/assignments/${sub}` : t.projectId != null ? `/projects/${t.projectId}` : "/tasks?view=upcoming",
      mesa: !!sub,
      context: sub ? null : t.projectTitle,
    });
  }
  for (const a of f.lmsDue) {
    if (!inWindow(a.dueAt) || submitTasks.has(a.id)) continue;
    out.push({ ref: a.ref, kind: "assignment", title: a.title, at: a.dueAt, dateOnly: false, when: whenLabel(a.dueAt, false, now), href: `/assignments/${a.id}`, mesa: true, context: a.course });
  }
  for (const p of f.projects) {
    if (!inWindow(p.deadline) || p.kind === "mesa_assignment") continue;
    if (f.openTasks.some((t) => t.projectId === p.id && t.dueAt === p.deadline)) continue;
    const dateOnly = endOfIstDay(p.deadline);
    out.push({ ref: { t: "project", id: p.id }, kind: "project", title: p.title, at: p.deadline, dateOnly, when: whenLabel(p.deadline, dateOnly, now), href: `/projects/${p.id}`, mesa: p.source === "mesa", context: null });
  }
  for (const e of f.calendarWeek) {
    if (!e.personal || e.cancelled || !inWindow(e.startAt) || !KEY_EVENT_RE.test(e.title)) continue;
    out.push({ ref: e.ref, kind: "event", title: e.title, at: e.startAt, dateOnly: e.allDay, when: whenLabel(e.startAt, e.allDay, now), href: "/classes", mesa: false, context: e.room });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.title.localeCompare(b.title));
}

// ── risks ─────────────────────────────────────────────────────────────────────

const SESSION_WARN_MS = 5 * DAY_MS;
const TASKS_TODAY = "/tasks?view=today";

const ago = (at: string, now: Date) => {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** What could go wrong today, most severe first. Every item names the rows it is about. */
export function risksFrom(f: BriefFacts): RiskItem[] {
  const now = new Date(f.at);
  const out: RiskItem[] = [];
  const submitTasks = new Set(f.openTasks.map(submitId).filter((x): x is string => x != null));
  const orphanLms = f.lmsDue.filter((a) => !submitTasks.has(a.id));

  // 1. Overdue: tasks, and unsubmitted assignments with no task — two by name, then "+N more".
  const overdue = [
    ...f.overdue.map((t) => ({ at: t.dueAt!, title: t.title, when: whenLabel(t.dueAt!, t.dueIsDateOnly, now), ref: { t: "task", id: t.id } as FactRef, href: TASKS_TODAY })),
    ...orphanLms.filter((a) => Date.parse(a.dueAt) < now.getTime()).map((a) => ({ at: a.dueAt, title: a.title, when: whenLabel(a.dueAt, false, now), ref: a.ref, href: `/assignments/${a.id}` })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.title.localeCompare(b.title));
  for (const o of overdue.slice(0, 2)) out.push({ kind: "overdue", severity: 3, text: `Overdue: ${o.title} (${o.when})`, refs: [o.ref], href: o.href });
  if (overdue.length > 2) out.push({ kind: "overdue", severity: 3, text: `+${overdue.length - 2} more overdue`, refs: overdue.slice(2).map((o) => o.ref), href: TASKS_TODAY });

  // 2. Due by the end of tomorrow and not started (P1/P2 tasks) or not submitted (assignments with no task).
  const soonEnd = dayStartIso(addDays(f.day, 2));
  const soon = (at: string | null): at is string => !!at && Date.parse(at) >= now.getTime() && at < soonEnd;
  for (const a of orphanLms.filter((a) => soon(a.dueAt))) out.push({ kind: "soon", severity: 3, text: `${a.title} due ${whenLabel(a.dueAt, false, now)}, not submitted`, refs: [a.ref], href: `/assignments/${a.id}` });
  for (const t of f.openTasks.filter((t) => t.status === "todo" && t.priority <= 2 && soon(t.dueAt))) {
    const sub = submitId(t);
    out.push({ kind: "soon", severity: 2, text: `${t.title} due ${whenLabel(t.dueAt!, t.dueIsDateOnly, now)}, not started`, refs: [{ t: "task", id: t.id }], href: sub ? `/assignments/${sub}` : TASKS_TODAY });
  }

  // 3. Goals behind pace.
  const goalRisk: Partial<Record<Risk, 2 | 3>> = { off_track: 3, at_risk: 2 };
  const listed = new Set<number>();
  for (const g of f.goals) {
    const severity = goalRisk[g.risk.risk];
    if (!severity) continue;
    listed.add(g.id);
    out.push({ kind: "goal", severity, text: `${g.title}: ${g.risk.reason}`, refs: [{ t: "goal", id: g.id }], href: `/goals/${g.id}` });
  }

  // 4. Due now but bigger than today's free time.
  const freeMin = f.freeTime.freeMin;
  for (const t of f.openTasks) {
    if ((t.status !== "todo" && t.status !== "doing") || t.effortMin == null || t.effortMin <= freeMin || !t.dueAt || t.dueAt >= dayStartIso(addDays(f.day, 1))) continue;
    out.push({ kind: "effort", severity: 2, text: `${t.title} needs ${fmtMinutes(t.effortMin)}, ${fmtMinutes(freeMin)} free today`, refs: [{ t: "task", id: t.id }], href: TASKS_TODAY });
  }

  // 5. MESA sign-in about to expire.
  const exp = f.mesa.sessionExpiresAt;
  if (exp && Date.parse(exp) - now.getTime() < SESSION_WARN_MS) {
    const text = Date.parse(exp) <= now.getTime() ? "MESA sign-in has expired" : `MESA sign-in expires ${whenLabel(exp, false, now)}`;
    out.push({ kind: "session", severity: 2, text, refs: [{ t: "integration", id: "mesa" }], href: "/status" });
  }

  // 6. Habits slipping.
  for (const s of f.slipping) out.push({ kind: "habit", severity: 2, text: `${s.habit.name}: missed ${s.missed} days in a row`, refs: [{ t: "habit", id: s.habit.id }], href: "/goals" });

  // 7. Quiet goals not already listed.
  for (const g of f.goals) {
    if (!g.neglect.neglected || listed.has(g.id)) continue;
    out.push({ kind: "neglect", severity: 1, text: `${g.title}: nothing logged for ${g.neglect.quietDays} days`, refs: [{ t: "goal", id: g.id }], href: `/goals/${g.id}` });
  }

  // 8. Sent without fresh LMS data.
  if (f.stale) {
    const last = f.mesa.lastSuccessAt;
    out.push({ kind: "stale", severity: 1, text: `LMS data ${last ? `last updated ${ago(last, now)}` : "not updated yet"} — deadlines may be out of date`, refs: [{ t: "integration", id: "mesa" }], href: "/status" });
  }

  return out.sort((a, b) => b.severity - a.severity);
}

// ── sections ──────────────────────────────────────────────────────────────────

const GOAL_ORDER: Record<Risk, number> = { off_track: 0, at_risk: 1, on_track: 2, met: 3, untracked: 4 };

/** The brief's sections, in spec order (the renderer and the command center both use these). */
export function briefSections(f: BriefFacts): BriefSections {
  const priorities = f.focus.filter((i) => i.task.domain === "professional" && i.score >= 1).slice(0, 3);
  const shown = new Set(priorities.map((i) => i.task.id));
  return {
    priorities,
    personal: { habits: f.habits, tasks: f.focus.filter((i) => i.task.domain === "personal" && i.score >= 1).slice(0, 3) },
    upcoming: f.upcoming.filter((d) => !(d.ref.t === "task" && shown.has(d.ref.id))),
    goals: f.goals
      .filter((g) => g.progress.target != null)
      .sort((a, b) => GOAL_ORDER[a.risk.risk] - GOAL_ORDER[b.risk.risk] || a.priority - b.priority || a.id - b.id),
    risks: risksFrom(f),
  };
}
