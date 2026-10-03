import { prepPoints, type ModelProvider } from "@jarvis/ai";
import * as db from "@jarvis/db";
import type { ClassPrep, NotificationDraft, Sql } from "@jarvis/db";
import type { Logger } from "@jarvis/shared";
import { istHour } from "./time";

// The prep job (every 5 min): key points for the pre-reads of the next day and a half of classes (at most two
// AI calls a run, each pre-read summarised once ever), a push ~30 minutes before each MESA session with its
// pre-read and points, and at 20:00 IST a list of tomorrow's classes and their pre-reads. Each alert's dedupe
// key names the class (or the day), so it is sent once.

/** The push goes out when a class starts within this window. */
export const PREP_LEAD_MS = 35 * 60_000;
/** Pre-reads of classes this far ahead get their key points written in advance. */
const SUMMARY_AHEAD_MS = 36 * 3_600_000;
const SUMMARIES_PER_RUN = 2;
/** The evening list: from 20:00 until 23:00 IST (before quiet hours). */
export const EVENING_HOUR = 20;
const EVENING_LAST_HOUR = 23;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtTime = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
const courseName = (p: ClassPrep) => p.event.short ?? p.event.course ?? p.event.title;
const sessionLabel = (p: ClassPrep) => (p.session != null ? ` · Session ${p.session}` : "");

/** "Pre-read: PreRead_Session 8_Groww" lines for a class, with the key points of its first summarised pre-read. */
function prepLines(p: ClassPrep): string[] {
  if (p.match === "none") return [];
  const lines: string[] = [];
  const shown = p.items.slice(0, 3);
  let pointsShown = false;
  for (const i of shown) {
    const label = p.match === "session" ? (i.preRead ? "Pre-read" : "Material") : "New";
    lines.push(`${label}: ${esc(i.title)}${i.kind === "link" ? " (link)" : ""}`);
    // One pre-read's points keep the push short; the class page has all of them.
    if (!pointsShown && p.match === "session" && i.preRead && i.points?.length) {
      lines.push(...i.points.map((pt) => `• ${esc(pt)}`));
      pointsShown = true;
    }
  }
  if (p.items.length > shown.length) lines.push(`+${p.items.length - shown.length} more`);
  return lines;
}

/** The ~30-minute push for one class. */
export function prepAlert(p: ClassPrep, now: Date): NotificationDraft {
  const head = `📖 <b>${esc(courseName(p))}${sessionLabel(p)}</b> at ${fmtTime(p.event.startAt)}${p.event.room ? ` · ${esc(p.event.room)}` : ""}`;
  const lines = prepLines(p);
  const due = p.due.map((a) => `⏰ Due ${fmtTime(a.dueAt)}: ${esc(a.title)}`);
  const text = [head, ...(lines.length ? lines : ["No pre-read found on the LMS for this class."]), ...due].join("\n");
  return { dedupeKey: `class.prep:${p.event.id}:${p.event.startAt}`, priority: "high", text, scheduledFor: now.toISOString() };
}

/** The 20:00 list of tomorrow's classes with their pre-reads (null when tomorrow has none). */
export function eveningList(day: db.Day, preps: ClassPrep[], now: Date): NotificationDraft | null {
  if (!preps.length) return null;
  const withReads = preps.filter((p) => p.items.some((i) => i.preRead) && p.match === "session").length;
  const head = `🌙 <b>Tomorrow: ${preps.length} ${preps.length === 1 ? "class" : "classes"}</b>${withReads ? ` · ${withReads} with a pre-read` : ""}`;
  const blocks = preps.map((p) => {
    const reads = p.match === "session" ? p.items.filter((i) => i.preRead) : [];
    const what = reads.length ? reads.map((i) => `   ${esc(i.title)}${i.kind === "link" ? " (link)" : ""}`).join("\n") : "   No pre-read on the LMS";
    return `${fmtTime(p.event.startAt)} ${esc(courseName(p))}${sessionLabel(p)}\n${what}`;
  });
  return { dedupeKey: `class.eve:${day}`, priority: "normal", text: [head, ...blocks].join("\n"), scheduledFor: now.toISOString() };
}

export interface PrepSummary {
  upcoming: number;
  summarized: number;
  summaryErrors: number;
  alerts: number;
  evening: boolean;
  queued: number;
}

export async function runClassPrep(sql: Sql, now: Date, model: ModelProvider | null, log?: Logger): Promise<PrepSummary> {
  const ahead = await db.sessionsBetween(sql, now, new Date(now.getTime() + SUMMARY_AHEAD_MS));
  const preps = (await Promise.all(ahead.map((s) => db.classPrep(sql, s.id, now)))).filter((p): p is ClassPrep => !!p);
  const out: PrepSummary = { upcoming: preps.length, summarized: 0, summaryErrors: 0, alerts: 0, evening: false, queued: 0 };

  // 1. Key points for pre-reads that have text and none yet — soonest class first.
  if (model) {
    const todo = new Map<string, string>();
    for (const p of preps) for (const i of p.items) if (p.match === "session" && i.preRead && i.noteKey && i.hasText && !i.points && !todo.has(i.noteKey)) todo.set(i.noteKey, i.title);
    for (const [key, title] of [...todo].slice(0, SUMMARIES_PER_RUN)) {
      try {
        const text = await db.prepSourceText(sql, key);
        if (!text) continue;
        const points = await prepPoints(model, title, text);
        // Saved even when empty, so a document the model can't summarise isn't retried every 5 minutes.
        await db.savePrepNote(sql, key, title, points, model.name);
        for (const p of preps) for (const i of p.items) if (i.noteKey === key) i.points = points;
        out.summarized++;
      } catch (err) {
        out.summaryErrors++;
        log?.warn("prep note failed", { key, error: err });
      }
    }
  }

  const drafts: NotificationDraft[] = [];
  // 2. The push, for classes starting within the lead window.
  for (const p of preps) {
    const ms = Date.parse(p.event.startAt) - now.getTime();
    if (ms > 0 && ms <= PREP_LEAD_MS) drafts.push(prepAlert(p, now));
  }
  out.alerts = drafts.length;

  // 3. The evening list of tomorrow's classes.
  const h = istHour(now);
  if (h >= EVENING_HOUR && h < EVENING_LAST_HOUR) {
    const tomorrow = db.addDays(db.istDay(now), 1);
    const [sent] = await sql`select 1 from jarvis.notifications where dedupe_key = ${`class.eve:${tomorrow}`}`;
    if (!sent) {
      const list = eveningList(tomorrow, preps.filter((p) => db.istDay(p.event.startAt) === tomorrow), now);
      if (list) {
        drafts.push(list);
        out.evening = true;
      }
    }
  }
  out.queued = drafts.length ? await db.enqueueNotifications(sql, drafts) : 0;
  return out;
}
