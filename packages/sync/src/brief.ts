import * as db from "@jarvis/db";
import type { BriefFacts, BriefLine, BriefSections, CalendarEntry, FactRef, FocusItem, GoalAttention, HabitWithStatus, NotificationDraft, Sql } from "@jarvis/db";
import { focusNote, type ModelProvider } from "@jarvis/ai";
import { esc } from "@jarvis/notify";

export type { BriefLine } from "@jarvis/db";

// The morning brief (V2 Phase 5). Every line is rendered from BriefFacts (packages/db/src/brief-facts.ts) and
// carries the rows it came from, so each one can be traced back to the database. Layout, in spec order: title,
// meta line (date, classes, free time, all-day entries), TODAY'S PRIORITIES, PERSONAL, UPCOMING, GOALS, RISKS,
// then the 🧭 focus note. The push shows the title, the meta line and the numbered priorities.
// The briefs job (jobs.ts) decides when; this file decides what.

const HEADLINE = "Good morning — your day is ready";
/** The push title (the brief's first line, as plain text). */
export const BRIEF_TITLE = `☀️ ${HEADLINE}`;
/** The whole brief stays within this many characters (inbox, email and Telegram's 4,096 limit). */
export const BRIEF_MAX_CHARS = 3_500;
const TITLE_MAX = 80;
const RISK_MAX = 160;
const NOTE_MAX = 600;
const ALL_DAY_SHOWN = 3;
const NO_PRIORITIES = "Nothing pressing at work today.";

type SectionName = "priorities" | "personal" | "upcoming" | "goals" | "risks";
type Caps = Record<SectionName, number>;
const SECTION_ORDER: SectionName[] = ["priorities", "personal", "upcoming", "goals", "risks"];
const HEADINGS: Record<SectionName, string> = { priorities: "TODAY'S PRIORITIES", personal: "PERSONAL", upcoming: "UPCOMING", goals: "GOALS", risks: "RISKS" };
const CAPS: Caps = { priorities: 3, personal: 6, upcoming: 6, goals: 5, risks: 5 };
/** When the brief is too long, the section showing the most lines loses one (ties in this order). */
const TRIM_ORDER: SectionName[] = ["upcoming", "goals", "personal", "risks", "priorities"];

interface Item {
  html: string;
  refs: FactRef[];
}

const cut = (s: string, max = TITLE_MAX) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const title = (s: string) => esc(cut(s));
const num = (n: number) => String(Math.round(n * 10) / 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : word.endsWith("s") ? "es" : "s"}`;
const dueText = (i: FocusItem, now: Date) => (i.task.dueAt ? ` — ${db.whenLabel(i.task.dueAt, i.task.dueIsDateOnly, now)}` : "");
const taskRef = (i: FocusItem): FactRef => ({ t: "task", id: i.task.id });

/** "Thursday, 1 October · 1 class from 10:00 am (1 cancelled) · 3 h 30 min free · All day: Dussehra" */
function metaLine(f: BriefFacts): Item {
  const timed = (e: CalendarEntry) => !e.allDay;
  const classes = f.calendar.filter((e) => timed(e) && !e.personal && !e.cancelled);
  const cancelled = f.calendar.filter((e) => timed(e) && !e.personal && e.cancelled);
  const events = f.calendar.filter((e) => timed(e) && e.personal && !e.cancelled);
  const allDay = f.calendar.filter((e) => e.allDay && !e.cancelled);

  const parts = [f.label];
  const cls = classes.length ? `${plural(classes.length, "class")} from ${db.fmtIstTime(classes[0]!.startAt)}` : "No classes";
  parts.push(cancelled.length ? `${cls} (${cancelled.length} cancelled)` : cls);
  if (events.length) parts.push(plural(events.length, "event"));
  if (f.freeTime.freeMin > 0) parts.push(`${db.fmtMinutes(f.freeTime.freeMin)} free`);
  if (allDay.length) {
    const shown = allDay.slice(0, ALL_DAY_SHOWN).map((e) => cut(e.title, 40));
    parts.push(`All day: ${shown.join(", ")}${allDay.length > ALL_DAY_SHOWN ? ` +${allDay.length - ALL_DAY_SHOWN} more` : ""}`);
  }
  const refs: FactRef[] = [...classes, ...cancelled, ...events, ...allDay].map((e) => e.ref);
  if (f.stale) refs.push({ t: "integration", id: "mesa" });
  return { html: parts.map((p) => esc(p)).join(" · "), refs };
}

/** "Workout (2 of 4 this week)", "Read 30 minutes ✓", "Meditate — skipped". */
function habitItem(h: HabitWithStatus): Item {
  const st = h.status;
  const detail = st.periodTarget != null ? ` (${st.periodDone} of ${st.periodTarget} ${h.schedule.freq === "monthly" ? "this month" : "this week"})` : "";
  const mark = st.today === "done" ? " ✓" : st.today === "skipped" ? " — skipped" : "";
  return { html: `- ${title(h.name)}${esc(detail)}${mark}`, refs: [{ t: "habit", id: h.id }] };
}

/** "Workout: 2/4 this week"; value goals "Weight: 72 kg (target 70)". */
function goalItem(g: GoalAttention): Item {
  const p = g.progress;
  const text =
    g.metric === "value"
      ? `${p.current != null ? `${num(p.current)}${g.unit ? ` ${g.unit}` : ""}` : "no entry yet"} (target ${num(p.target ?? 0)})`
      : `${num(p.current ?? 0)}/${num(p.target ?? 0)} ${db.PERIOD_LABEL[g.period]}`;
  return { html: `${title(g.title)}: ${esc(text)}`, refs: [{ t: "goal", id: g.id }] };
}

/** Each section's items in order, uncapped (a "+N more" line carries the refs of what isn't shown). */
function sectionItems(f: BriefFacts, s: BriefSections): Record<SectionName, Item[]> {
  const now = new Date(f.at);
  // briefSections stops at 3 priorities; the rest of the professional queue only feeds "+N more".
  const top = new Set(s.priorities.map((i) => i.task.id));
  const priorities = [...s.priorities, ...f.focus.filter((i) => i.task.domain === "professional" && i.score >= 1 && !top.has(i.task.id))];
  return {
    priorities: priorities.map((i, n) => ({ html: `${n + 1}. ${title(i.task.title)}${esc(dueText(i, now))}`, refs: [taskRef(i)] })),
    personal: [
      ...s.personal.habits.map(habitItem),
      ...s.personal.tasks.map((i) => ({ html: `- ${title(i.task.title)}${esc(dueText(i, now))}`, refs: [taskRef(i)] })),
    ],
    upcoming: s.upcoming.map((d) => ({ html: `- ${title(d.title)} — ${esc(d.when)}`, refs: [d.ref] })),
    goals: s.goals.map(goalItem),
    // A brief built from stale LMS data says so first: at severity 1 a busy day's "+N more" would hide it.
    risks: [...s.risks.filter((r) => r.kind === "stale"), ...s.risks.filter((r) => r.kind !== "stale")].map((r) => ({ html: `- ${esc(cut(r.text, RISK_MAX))}`, refs: r.refs })),
  };
}

function layout(meta: Item, items: Record<SectionName, Item[]>, note: Item | null, caps: Caps): BriefLine[] {
  const lines: BriefLine[] = [
    { kind: "title", html: `☀️ <b>${HEADLINE}</b>`, refs: [] },
    { kind: "meta", html: meta.html, refs: meta.refs },
  ];
  for (const name of SECTION_ORDER) {
    const all = items[name];
    if (!all.length && name !== "priorities") continue; // empty sections are left out, except the priorities
    if (name !== "priorities") lines.push({ kind: "blank", html: "", refs: [] }); // the meta line runs straight into the priorities
    lines.push({ kind: "heading", html: `<b>${HEADINGS[name]}</b>`, refs: [] });
    if (!all.length) lines.push({ kind: "item", html: NO_PRIORITIES, refs: [] });
    const shown = all.slice(0, caps[name]);
    for (const i of shown) lines.push({ kind: "item", html: i.html, refs: i.refs });
    const hidden = all.slice(shown.length);
    if (hidden.length) lines.push({ kind: "more", html: `+${hidden.length} more`, refs: hidden.flatMap((i) => i.refs) });
  }
  if (note) lines.push({ kind: "blank", html: "", refs: [] }, { kind: "note", html: note.html, refs: note.refs });
  return lines;
}

const joined = (lines: BriefLine[]) => lines.map((l) => l.html).join("\n");

/**
 * The brief as notification text (Telegram's HTML subset, every value escaped) and as lines with their refs.
 * Sections over their cap end in "+N more"; if the whole is still over 3,500 characters, sections give up
 * whole lines (never part of one, so no tag is ever cut) until it fits.
 */
export function renderBrief(f: BriefFacts, s: BriefSections, note: { text: string; refs: FactRef[] }): { text: string; lines: BriefLine[] } {
  const meta = metaLine(f);
  const items = sectionItems(f, s);
  const noteItem = note.text ? { html: `🧭 <i>${esc(cut(note.text, NOTE_MAX))}</i>`, refs: note.refs } : null;
  const caps = { ...CAPS };
  const shown = (n: SectionName) => Math.min(caps[n], items[n].length);
  let lines = layout(meta, items, noteItem, caps);
  while (joined(lines).length > BRIEF_MAX_CHARS) {
    const most = TRIM_ORDER.filter((n) => shown(n) > 1).sort((a, b) => shown(b) - shown(a))[0];
    if (!most) break;
    caps[most] = shown(most) - 1;
    lines = layout(meta, items, noteItem, caps);
  }
  // Every line is bounded, so this can't happen with the caps above; kept so the limit holds whatever changes.
  if (joined(lines).length > BRIEF_MAX_CHARS && noteItem) lines = layout(meta, items, null, caps);
  return { text: joined(lines), lines };
}

/**
 * Today's brief: facts → focus note → lines → jarvis.briefs → the notification draft. The note is written once a
 * day: if this day's brief was already stored (say the run crashed before queueing it), its note is reused and
 * the model isn't called again.
 */
export async function dailyBrief(
  sql: Sql,
  now: Date,
  o: { model: ModelProvider | null; stale: boolean },
): Promise<{ draft: NotificationDraft; stats: { focusNote: "ai" | "fallback"; detail: string | null; lines: number } }> {
  const f = await db.loadBriefFacts(sql, now, { stale: o.stale });
  const s = db.briefSections(f);
  const existing = await db.getBrief(sql, f.day);
  const note = existing
    ? { text: existing.note ?? "", refs: existing.noteRefs, source: existing.noteSource, detail: existing.noteDetail }
    : await focusNote(o.model, f, s);
  const { text, lines } = renderBrief(f, s, note);
  await db.saveBrief(sql, { day: f.day, lines, text, note: note.text || null, noteSource: note.source, noteDetail: note.detail, noteRefs: note.refs });
  return {
    draft: { dedupeKey: `brief:${f.day}`, priority: "normal", text, scheduledFor: now.toISOString(), url: "/" },
    stats: { focusNote: note.source, detail: note.detail, lines: lines.length },
  };
}
