import { addDays, fmtIstTime, fmtMinutes, istDay, WorkInputError, type BriefFacts, type BriefSections, type CalendarEntry, type FactRef, type RiskItem, type StoredBrief, type Task } from "@jarvis/db";

// Pure helpers behind the command center (/). Every count and label here comes from BriefFacts, the brief's
// sections or a loaded row — the page only lays them out, so it can't disagree with the brief or chat.

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const istHour = (now: Date) => new Date(now.getTime() + IST_MS).getUTCHours();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type DayMode = "morning" | "day" | "evening";

/** IST: morning before 12:00, day 12:00–17:59, evening from 18:00. */
export function dayMode(now: Date): DayMode {
  const h = istHour(now);
  return h < 12 ? "morning" : h < 18 ? "day" : "evening";
}

const GREETING: Record<DayMode, string> = { morning: "Good morning", day: "Good afternoon", evening: "Good evening" };
export const greeting = (now: Date): string => GREETING[dayMode(now)];

// ── glance chips ──────────────────────────────────────────────────────────────

export type ChipTone = "good" | "warn" | "bad" | "muted";
export interface GlanceChip {
  label: string;
  href: string;
  tone: ChipTone;
}

/** MESA classes today that still run (timed, not cancelled). */
export const classesToday = (f: Pick<BriefFacts, "calendar">): CalendarEntry[] => f.calendar.filter((e) => !e.personal && !e.allDay && !e.cancelled);

/** Habits due or answered today: how many are done. */
export const habitsDone = (f: Pick<BriefFacts, "habits">) => ({ done: f.habits.filter((h) => h.status.today === "done").length, total: f.habits.length });

/** Open tasks due later today (overdue ones are counted separately). */
export const dueToday = (f: Pick<BriefFacts, "openTasks" | "day" | "at">): Task[] =>
  f.openTasks.filter((t) => (t.status === "todo" || t.status === "doing") && t.dueAt != null && Date.parse(t.dueAt) >= Date.parse(f.at) && istDay(t.dueAt) === f.day);

/** The one-line summary under the header. Zero counts are left out. */
export function glanceChips(f: BriefFacts, s: BriefSections): GlanceChip[] {
  const habits = habitsDone(f);
  const chips: Array<GlanceChip | null> = [
    f.overdue.length ? { label: `${f.overdue.length} overdue`, href: "/tasks?view=today", tone: "bad" } : null,
    dueToday(f).length ? { label: `${dueToday(f).length} due today`, href: "/tasks?view=today", tone: "muted" } : null,
    habits.total ? { label: `${habits.done}/${habits.total} habits`, href: "#habits", tone: habits.done === habits.total ? "good" : "muted" } : null,
    s.risks.length ? { label: `${s.risks.length} at risk`, href: "#risks", tone: "warn" } : null,
    classesToday(f).length ? { label: plural(classesToday(f).length, "class", "classes"), href: "#calendar", tone: "muted" } : null,
    f.unread ? { label: `${f.unread} unread`, href: "/inbox", tone: "muted" } : null,
    f.freeTime.freeMin ? { label: `${fmtMinutes(f.freeTime.freeMin)} free`, href: "#calendar", tone: "muted" } : null,
  ];
  return chips.filter((c): c is GlanceChip => c != null);
}

// ── header ────────────────────────────────────────────────────────────────────

/** MESA state for the header: whether it is connected, and the sign-in expiry when it is under 5 days away. */
export function mesaHeader(f: Pick<BriefFacts, "mesa" | "at">): { lastCheck: string | null; connected: boolean; expiresSoon: string | null; expired: boolean } {
  const exp = f.mesa.sessionExpiresAt;
  const left = exp ? Date.parse(exp) - Date.parse(f.at) : Infinity;
  return {
    lastCheck: f.mesa.lastSuccessAt,
    connected: f.mesa.status === "active",
    expiresSoon: exp && left < 5 * DAY_MS ? exp : null,
    expired: left <= 0,
  };
}

// ── focus note ────────────────────────────────────────────────────────────────

/**
 * Today's stored brief note, unless there is no brief yet or a task it names has since been closed — then the
 * live deterministic note (fallbackFocusNote over the current facts). Never calls a model.
 */
export function chooseNote(brief: Pick<StoredBrief, "note" | "noteRefs" | "createdAt"> | null, f: Pick<BriefFacts, "openTasks">, live: () => { text: string }): { text: string; caption: string } {
  const open = new Set(f.openTasks.map((t) => t.id));
  const closed = (r: FactRef) => r.t === "task" && !open.has(r.id);
  if (brief?.note && !brief.noteRefs.some(closed)) return { text: brief.note, caption: `${fmtIstTime(brief.createdAt)} brief` };
  return { text: live().text, caption: "live" };
}

// ── sections ──────────────────────────────────────────────────────────────────

/** "Done today: 3 tasks · 2/4 habits" (evening mode). */
export function doneTodayLine(f: Pick<BriefFacts, "doneToday" | "habits">): string {
  const h = habitsDone(f);
  return `Done today: ${plural(f.doneToday, "task")}${h.total ? ` · ${h.done}/${h.total} habits` : ""}`;
}

/** Today's tasks not already shown as professional or personal priorities. */
export function otherTasks(f: Pick<BriefFacts, "tasksToday">, s: Pick<BriefSections, "priorities" | "personal">): Task[] {
  const shown = new Set([...s.priorities, ...s.personal.tasks].map((i) => i.task.id));
  return f.tasksToday.filter((t) => !shown.has(t.id));
}

/** Active projects of your own (not MESA assignment projects): deadline first (undated last), then priority. */
export function homeProjects(f: Pick<BriefFacts, "projects">, n = 5): BriefFacts["projects"] {
  return f.projects
    .filter((p) => p.status === "active" && p.kind !== "mesa_assignment")
    .sort((a, b) => (a.deadline ?? "￿").localeCompare(b.deadline ?? "￿") || a.priority - b.priority || a.id - b.id)
    .slice(0, n);
}

/** Risks that aren't goals or habits (those go to the attention list with their decision buttons). */
export const otherRisks = (s: Pick<BriefSections, "risks">): RiskItem[] => s.risks.filter((r) => r.kind !== "goal" && r.kind !== "neglect" && r.kind !== "habit");

/** Goals behind pace or gone quiet. */
export const attentionGoals = (f: Pick<BriefFacts, "goals">) => f.goals.filter((g) => g.risk.risk === "at_risk" || g.risk.risk === "off_track" || g.neglect.neglected);

export type CalendarRow = { kind: "event"; at: string; e: CalendarEntry } | { kind: "gap"; at: string; to: string; label: string };

/** Today's timed entries with the free gaps of `minGap`+ minutes between them, in time order (all-day entries are chips). */
export function calendarRows(f: Pick<BriefFacts, "calendar" | "freeTime">, minGap = 45): CalendarRow[] {
  const rows: CalendarRow[] = [
    ...f.calendar.filter((e) => !e.allDay).map((e) => ({ kind: "event" as const, at: e.startAt, e })),
    ...f.freeTime.gaps.filter((g) => g.min >= minGap).map((g) => ({ kind: "gap" as const, at: g.from, to: g.to, label: `Free · ${fmtMinutes(g.min)}` })),
  ];
  return rows.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === "event" ? -1 : 1));
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface StripDay {
  day: string;
  /** "Fri 2" */
  label: string;
  classes: number;
  deadlines: number;
}

/** The next `n` days: "Fri 2" with how many classes and deadlines each holds. */
export function dayStrip(f: Pick<BriefFacts, "day" | "calendarWeek" | "upcoming">, n = 6): StripDay[] {
  return Array.from({ length: n }, (_, i) => {
    const day = addDays(f.day, i + 1);
    const d = new Date(`${day}T00:00:00Z`);
    return {
      day,
      label: `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()}`,
      classes: f.calendarWeek.filter((e) => !e.personal && !e.allDay && !e.cancelled && istDay(e.startAt) === day).length,
      deadlines: f.upcoming.filter((u) => istDay(u.at) === day).length,
    };
  });
}

// ── form input ────────────────────────────────────────────────────────────────

/** Whether "Move to tomorrow" applies: not a MESA task, and not already due after today (that would pull it earlier). */
export const canDefer = (t: Pick<Task, "source" | "dueAt">, now: Date): boolean => t.source !== "mesa" && !(t.dueAt && istDay(t.dueAt) > istDay(now));

/** "Move to tomorrow": date-only or undated → tomorrow (IST, date-only); an exact time keeps its time. MESA deadlines can't move. */
export function deferredDue(t: Pick<Task, "source" | "dueAt" | "dueIsDateOnly">, now: Date): string {
  if (t.source === "mesa") throw new WorkInputError("MESA deadlines can't be moved");
  if (!canDefer(t, now)) throw new WorkInputError("it's already due after today");
  const tomorrow = addDays(istDay(now), 1);
  if (!t.dueAt || t.dueIsDateOnly) return tomorrow;
  return `${tomorrow}T${new Date(Date.parse(t.dueAt) + IST_MS).toISOString().slice(11, 16)}:00+05:30`;
}

/** The Effort (min) field: empty → null; otherwise a whole number of minutes, 1–600. */
export function parseEffort(v: unknown): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 600) throw new WorkInputError("effort must be a whole number of minutes, 1 to 600");
  return n;
}
