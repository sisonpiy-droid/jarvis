import { prepPoints, type ModelProvider } from "@jarvis/ai";
import * as db from "@jarvis/db";
import type { ClassPrep, NotificationDraft, Sql } from "@jarvis/db";
import type { Logger } from "@jarvis/shared";

// The prep job (every 5 min): key points for the pre-reads of the next day and a half of classes (at most two
// AI calls a run, each pre-read summarised once ever) and a push ~30 minutes before each MESA session with its
// pre-read and points. Tomorrow's pre-reads are listed in the evening check-in (evening.ts). Each push's dedupe
// key names the class, so it is sent once.

/** The push goes out when a class starts within this window. */
export const PREP_LEAD_MS = 35 * 60_000;
/** Pre-reads of classes this far ahead get their key points written in advance. */
const SUMMARY_AHEAD_MS = 36 * 3_600_000;
const SUMMARIES_PER_RUN = 2;

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

export interface PrepSummary {
  upcoming: number;
  summarized: number;
  summaryErrors: number;
  alerts: number;
  queued: number;
}

export async function runClassPrep(sql: Sql, now: Date, model: ModelProvider | null, log?: Logger): Promise<PrepSummary> {
  const ahead = await db.sessionsBetween(sql, now, new Date(now.getTime() + SUMMARY_AHEAD_MS));
  const preps = (await Promise.all(ahead.map((s) => db.classPrep(sql, s.id, now)))).filter((p): p is ClassPrep => !!p);
  const out: PrepSummary = { upcoming: preps.length, summarized: 0, summaryErrors: 0, alerts: 0, queued: 0 };

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
  out.queued = drafts.length ? await db.enqueueNotifications(sql, drafts) : 0;
  return out;
}
