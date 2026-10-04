import type { Sql } from "./client";
import { classPrep, sessionsBetween } from "./class-prep";
import { fmtIstShort, fmtIstTime, fmtMinutes, rankFocus, whenLabel, type FocusItem } from "./focus";
import { addDays, dayStartIso, istDay, type Day } from "./progress";
import { loadSituation, type DayLoad, type Situation } from "./situation";
import { getTask, updateTask, type Task } from "./work";
import { upcomingBlocks, type PlanBlock } from "./week-plan";

// The evening check-in (20:30 IST): what got done, what's still open from today (one tap moves it to tomorrow),
// MESA work due tonight, tomorrow at a glance with its pre-reads, tomorrow's top 3, and at most one nudge drawn
// from the owner's own patterns. Deterministic — the same facts as chat and the brief.

export interface Checkin {
  day: Day;
  done: string[];
  /** The owner's own tasks due today and not done — movable. */
  stillOpen: Task[];
  /** MESA assignments due later today and not submitted (they can't be moved). */
  dueTonight: Array<{ title: string; dueAt: string }>;
  tomorrow: DayLoad;
  prereads: Array<{ course: string; session: number | null; titles: string[] }>;
  top: FocusItem[];
  /** Tomorrow's blocks from the approved week plan. */
  planned: PlanBlock[];
  /** Things others owe the owner that are past due (waiting tasks with a person). */
  chase: Task[];
  nudge: string | null;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const list = (xs: string[], n = 3) => `${xs.slice(0, n).join("; ")}${xs.length > n ? ` (+${xs.length - n} more)` : ""}`;
const short = (s: string) => s.replace(/\s+with\s+.*$/i, "");

const isOpen = (t: Task) => t.status === "todo" || t.status === "doing";

export function stillOpenToday(tasks: Task[], day: Day): Task[] {
  return tasks.filter((t) => isOpen(t) && t.source !== "mesa" && !!t.dueAt && istDay(t.dueAt) <= day);
}

/** One line of advice from the owner's patterns or the week's shape; null when nothing stands out. */
export function checkinNudge(s: Situation, tomorrow: DayLoad): string | null {
  const tight = s.patterns.submissions.tightest;
  if (tight && tomorrow.deadlines.some((d) => (d.context ?? d.title).toLowerCase().includes(tight.course.toLowerCase().slice(0, 12))))
    return `You usually submit ${tight.course} close to the wire — start tomorrow's one in the morning, not at night.`;
  const crunch = s.week.slice(1, 4).find((d) => d.deadlines.length >= 2 && d.freeMin < 240);
  if (crunch) return `${fmtIstShort(dayStartIso(crunch.day))} is tight: ${crunch.deadlines.length} deadlines and ${fmtMinutes(crunch.freeMin)} free — finish one of them tomorrow.`;
  const pushed = s.patterns.postponed[0];
  if (pushed && pushed.times >= 3) return `"${pushed.title}" has been moved ${pushed.times} times — do it first tomorrow, or drop it.`;
  return null;
}

export async function loadCheckin(sql: Sql, now: Date): Promise<Checkin> {
  const day = istDay(now);
  const tomorrowDay = addDays(day, 1);
  const s = await loadSituation(sql, now);
  const f = s.facts;
  const [doneRows, sessions] = await Promise.all([
    sql`select title from jarvis.tasks where status = 'done' and completed_at >= ${dayStartIso(day)} order by completed_at`,
    sessionsBetween(sql, new Date(dayStartIso(tomorrowDay)), new Date(dayStartIso(addDays(tomorrowDay, 1)))),
  ]);
  const preps = (await Promise.all(sessions.map((x) => classPrep(sql, x.id, now)))).filter((p) => !!p);
  const tomorrow = s.week[0]!;
  const tomorrow8 = new Date(Date.parse(dayStartIso(tomorrowDay)) + 8 * 3_600_000);
  const top = rankFocus(
    f.openTasks.filter(isOpen),
    { now: tomorrow8, today: tomorrowDay, goals: new Map(f.goals.map((g) => [g.id, { title: g.title, risk: g.risk.risk, neglected: g.neglect.neglected, quietDays: g.neglect.quietDays }])), freeMin: tomorrow.freeMin },
  )
    .filter((i) => i.score >= 1)
    .slice(0, 3)
    // Ranked as of tomorrow 08:00, but read tonight: the due label is said relative to now ("tomorrow 11:59 pm").
    .map((i) => (i.task.dueAt ? { ...i, reasons: [Date.parse(i.task.dueAt) < now.getTime() ? whenLabel(i.task.dueAt, i.task.dueIsDateOnly, now) : `due ${whenLabel(i.task.dueAt, i.task.dueIsDateOnly, now)}`, ...i.reasons.slice(1)] } : i));
  return {
    day,
    done: doneRows.map((r) => String(r.title)),
    stillOpen: stillOpenToday(f.openTasks, day),
    dueTonight: f.lmsDue.filter((a) => istDay(a.dueAt) === day && Date.parse(a.dueAt) > now.getTime() && !a.status.startsWith("submitted")).map((a) => ({ title: a.title, dueAt: a.dueAt })),
    tomorrow,
    prereads: preps.map((p) => ({ course: p!.event.short ?? short(p!.event.course ?? p!.event.title), session: p!.session, titles: p!.match === "session" ? p!.items.filter((i) => i.preRead).map((i) => i.title) : [] })),
    top,
    planned: upcomingBlocks(s.plan, now, tomorrowDay),
    chase: f.openTasks.filter((t) => t.status === "waiting" && t.person && t.dueAt && Date.parse(t.dueAt) < now.getTime()),
    nudge: checkinNudge(s, tomorrow),
  };
}

export function checkinText(c: Checkin): string {
  const L = [`🌙 <b>Evening check-in</b>`];
  L.push(c.done.length ? `✅ Done today: ${esc(list(c.done))}` : "✅ Nothing marked done today.");
  if (c.stillOpen.length) L.push(`⏳ Still open from today: ${esc(list(c.stillOpen.map((t) => t.title)))} — move ${c.stillOpen.length === 1 ? "it" : "them"} to tomorrow?`);
  for (const a of c.dueTonight) L.push(`⚠️ Not submitted yet: ${esc(a.title)} — due ${fmtIstTime(a.dueAt)}`);
  const t = c.tomorrow;
  const parts = [t.classes.length ? `${t.classes.length} class${t.classes.length > 1 ? "es" : ""} from ${fmtIstTime(t.classes[0]!.startAt)}` : "no classes", `${fmtMinutes(t.freeMin)} free`];
  if (t.deadlines.length) parts.push(`due: ${list(t.deadlines.map((d) => `${d.title} ${fmtIstTime(d.at)}`), 2)}`);
  L.push(`📅 Tomorrow (${fmtIstShort(dayStartIso(t.day))}): ${esc(parts.join(" · "))}`);
  if (c.prereads.length)
    L.push(`📖 Pre-reads: ${esc(c.prereads.map((p) => `${p.course}${p.session != null ? ` S${p.session}` : ""} — ${p.titles.length ? p.titles.join(", ") : "none on the LMS"}`).join("; "))}`);
  if (c.planned.length) L.push(`🗓️ Planned: ${esc(c.planned.map((b) => `${fmtIstTime(b.start)} ${b.title}`).join("; "))}`);
  else if (c.top.length) L.push(`🎯 Tomorrow's top ${c.top.length}: ${esc(c.top.map((i, n) => `${n + 1}. ${i.task.title}`).join("  "))}`);
  for (const t of c.chase.slice(0, 3)) L.push(`📨 ${esc(t.person!)} still owes you: ${esc(t.title)} (due ${fmtIstShort(t.dueAt!)}) — nudge them?`);
  if (c.nudge) L.push(`💡 ${esc(c.nudge)}`);
  return L.join("\n");
}

/** Moves the owner's tasks still open from today to the same time tomorrow (date-only tasks: tomorrow's date). */
export async function moveOpenToTomorrow(sql: Sql, now: Date): Promise<number> {
  const day = istDay(now);
  const rows = await sql`
    select id from jarvis.tasks
     where status in ('todo', 'doing') and source <> 'mesa' and due_at is not null and due_at < ${dayStartIso(addDays(day, 1))}`;
  let moved = 0;
  for (const r of rows) {
    const t = await getTask(sql, Number(r.id));
    if (!t?.dueAt) continue;
    const due = t.dueIsDateOnly ? addDays(day, 1) : new Date(Math.max(Date.parse(t.dueAt), Date.parse(dayStartIso(day))) + 86_400_000).toISOString();
    await updateTask(sql, t.id, { due });
    moved++;
  }
  return moved;
}
