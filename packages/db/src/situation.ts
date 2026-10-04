import type { Sql } from "./client";
import { briefSections, loadBriefFacts, type BriefFacts, type CalendarEntry } from "./brief-facts";
import { fmtIstShort, fmtIstTime, fmtMinutes, freeTime, type FreeTime } from "./focus";
import { workPatterns, type WorkPatterns } from "./patterns";
import { blockLine, getWeekPlan, upcomingBlocks, type PlanBlock, type WeekPlan } from "./week-plan";
import { addDays, dayStartIso, istDay, type Day } from "./progress";

// The chief of staff's picture of the owner's situation, rebuilt from the database for every chat turn and the
// evening check-in: today (time left, priorities, overdue, habits), the next 7 days day by day (classes,
// deadlines, free time), what's at risk, what can wait, and how the owner works. Deterministic text; the model
// reads it as already-looked-up facts and reasons over it.

export interface DayLoad {
  day: Day;
  /** MESA sessions (lectures). */
  classes: CalendarEntry[];
  /** Other MESA blocks (study block, building time, doubt sessions). */
  blocks: CalendarEntry[];
  personal: CalendarEntry[];
  deadlines: Array<{ title: string; at: string; kind: string; context: string | null }>;
  freeMin: number;
  gaps: FreeTime["gaps"];
}

export interface Situation {
  at: string;
  facts: BriefFacts;
  week: DayLoad[];
  patterns: WorkPatterns;
  plan: WeekPlan | null;
  text: string;
}

const MAX_LIST = 5;
/** "Mon 5 Oct". */
const weekdayLabel = (d: Day) => fmtIstShort(dayStartIso(d));
const courseName = (e: CalendarEntry) => (e.course ?? e.title).replace(/\s+with\s+.*$/i, "");
/** MESA event types that are teaching (exams and other blocks are listed separately). */
const isClass = (e: CalendarEntry) => e.type === "session" || e.type === "masterclass";
const more = (n: number) => (n > 0 ? ` (+${n} more)` : "");

/** Classes, personal events, deadlines and free time for each of the next `days` days after today. */
export function weekLoad(f: BriefFacts, days = 7): DayLoad[] {
  const out: DayLoad[] = [];
  for (let i = 1; i <= days; i++) {
    const day = addDays(f.day, i);
    const events = f.calendarWeek.filter((e) => istDay(e.startAt) === day && !e.cancelled);
    const timed = events.filter((e) => !e.allDay);
    out.push({
      day,
      classes: timed.filter((e) => !e.personal && isClass(e)),
      blocks: timed.filter((e) => !e.personal && !isClass(e)),
      personal: events.filter((e) => e.personal),
      deadlines: f.upcoming.filter((d) => istDay(d.at) === day).map((d) => ({ title: d.title, at: d.at, kind: d.kind, context: d.context })),
      ...(({ freeMin, gaps }) => ({ freeMin, gaps }))(freeTime(timed, new Date(dayStartIso(day)))),
    });
  }
  return out;
}

export function situationText(f: BriefFacts, week: DayLoad[], patterns: WorkPatterns, plan: PlanBlock[] = []): string {
  const now = new Date(f.at);
  const s = briefSections(f);
  const L: string[] = [];
  L.push(`LIVE SITUATION — computed from the owner's data at ${fmtIstTime(f.at)} IST, ${weekdayLabel(f.day)}. Treat it as already looked up.`);

  // Today
  const left = f.calendar.filter((e) => !e.cancelled && !e.allDay && Date.parse(e.endAt ?? e.startAt) > now.getTime());
  const gap = f.freeTime.gaps.reduce<(typeof f.freeTime.gaps)[number] | null>((a, g) => (!a || g.min > a.min ? g : a), null);
  L.push(
    `Today: ${left.length ? `${left.length} class/event${left.length > 1 ? "s" : ""} left (${left.map((e) => `${fmtIstTime(e.startAt)} ${e.personal ? e.title : courseName(e)}`).join(", ")})` : "no more classes or events"}; ` +
      `free time left before 10 pm: ${fmtMinutes(f.freeTime.freeMin)}${gap ? ` (biggest gap ${fmtIstTime(gap.from)}–${fmtIstTime(gap.to)})` : ""}; done today: ${f.doneToday} task${f.doneToday === 1 ? "" : "s"}.`,
  );
  const top = f.focus.filter((i) => i.score >= 1).slice(0, MAX_LIST);
  if (top.length) {
    L.push("Priorities now (JARVIS focus ranking, best first):");
    top.forEach((i, n) => L.push(`${n + 1}. ${i.task.title} [task #${i.task.id}] — ${i.reasons.join(", ") || "no due date"}${i.task.effortMin ? `; needs ~${fmtMinutes(i.task.effortMin)}` : ""}${i.task.domain === "personal" ? "; personal" : ""}`));
  } else L.push("Priorities now: nothing open with a due date or priority.");
  if (f.overdue.length) L.push(`Overdue: ${f.overdue.slice(0, MAX_LIST).map((t) => `${t.title} [task #${t.id}] (due ${fmtIstShort(t.dueAt!)})`).join("; ")}${more(f.overdue.length - MAX_LIST)}.`);
  if (f.habits.length)
    L.push(`Habits today: ${f.habits.map((h) => `${h.name} — ${h.status.today === "done" ? "done" : h.status.today === "skipped" ? "skipped" : "not yet"}${h.status.periodTarget != null ? ` (${h.status.periodDone}/${h.status.periodTarget} this period)` : h.status.streak ? ` (${h.status.streak}-day streak)` : ""}`).join("; ")}.`);

  // The week
  // A personal entry on most days (a daily reminder) is listed once, not on every line.
  const label = (e: CalendarEntry) => (e.allDay ? e.title : `${fmtIstTime(e.startAt)} ${e.title}`);
  const seen = new Map<string, number>();
  for (const d of week) for (const k of new Set(d.personal.map(label))) seen.set(k, (seen.get(k) ?? 0) + 1);
  const daily = new Set([...seen].filter(([, n]) => n >= Math.min(4, week.length)).map(([k]) => k));
  L.push("Next 7 days:");
  if (daily.size) L.push(`- Every day (personal calendar): ${[...daily].join("; ")}`);
  for (const d of week) {
    const parts: string[] = [];
    parts.push(d.classes.length ? `${d.classes.length} class${d.classes.length > 1 ? "es" : ""} (${d.classes.map((e) => `${fmtIstTime(e.startAt)} ${courseName(e)}`).join(", ")})` : "no classes");
    if (d.blocks.length) parts.push(`also: ${d.blocks.map((e) => `${fmtIstTime(e.startAt)} ${e.type === "exam" ? "EXAM " : ""}${e.title}`).join(", ")}`);
    const own = d.personal.map(label).filter((k) => !daily.has(k));
    if (own.length) parts.push(`personal: ${own.join(", ")}`);
    if (d.deadlines.length) parts.push(`due: ${d.deadlines.map((x) => `${x.title}${x.context && !x.title.includes(x.context) ? ` (${x.context})` : ""} ${fmtIstTime(x.at)}`).join("; ")}`);
    parts.push(`~${fmtMinutes(d.freeMin)} free 8 am–10 pm`);
    L.push(`- ${weekdayLabel(d.day)}: ${parts.join(" · ")}`);
  }
  const heavy = week.filter((d) => d.deadlines.length >= 2 || (d.deadlines.length >= 1 && d.freeMin < 180));
  if (heavy.length) L.push(`Crunch days: ${heavy.map((d) => weekdayLabel(d.day)).join(", ")} (deadlines with little free time) — work on them earlier.`);

  // Risks, what can wait, patterns
  const risks = s.risks.filter((r) => r.kind !== "overdue").slice(0, MAX_LIST);
  if (risks.length) L.push(`At risk: ${risks.map((r) => r.text).join("; ")}.`);
  if (plan.length) L.push(`Approved week plan, blocks still ahead: ${plan.slice(0, 8).map((b) => blockLine(b)).join("; ")}${more(plan.length - 8)}.`);
  if (f.defer.length) L.push(`Can wait: ${f.defer.slice(0, 3).map((d) => `${d.task.title} [task #${d.task.id}] (${d.deferReason})`).join("; ")}.`);
  if (patterns.lines.length) {
    L.push("How the owner works (from their own history):");
    for (const p of patterns.lines) L.push(`- ${p}`);
  } else L.push("How the owner works: not enough history yet to say.");
  return L.join("\n");
}

export async function loadSituation(sql: Sql, now: Date): Promise<Situation> {
  const [facts, patterns, plan] = await Promise.all([loadBriefFacts(sql, now), workPatterns(sql, now), getWeekPlan(sql)]);
  const week = weekLoad(facts);
  return { at: now.toISOString(), facts, week, patterns, plan, text: situationText(facts, week, patterns, upcomingBlocks(plan, now)) };
}
