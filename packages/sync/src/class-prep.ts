import { prepPoints, type ModelProvider } from "@jarvis/ai";
import * as db from "@jarvis/db";
import type { ClassPrep, NotificationDraft, PrepItem, Sql } from "@jarvis/db";
import type { Logger } from "@jarvis/shared";

// The prep job (every 5 min), before and after every MESA session:
// - before: key points for the pre-reads of the next day and a half of classes, and a push ~30 minutes before each
//   class with its material — the files themselves go along (Telegram sends them as documents).
// - after: a recap once the class is over and its recording is up (or a few hours later without one): revision
//   points from the session's deck, the deck itself and the recording link. Only for a known session with material.
// At most two AI calls a run; each document is summarised once ever (prep_notes). Each push's dedupe key names
// the class, so it is sent once. Tomorrow's pre-reads are also listed in the evening check-in (evening.ts).

/** The push goes out when a class starts within this window. */
export const PREP_LEAD_MS = 35 * 60_000;
/** Pre-reads of classes this far ahead get their key points written in advance. */
const SUMMARY_AHEAD_MS = 36 * 3_600_000;
const SUMMARIES_PER_RUN = 2;
/** Without a recording, the recap goes out this long after class. */
export const RECAP_WAIT_MS = 6 * 3_600_000;
/** Classes that ended longer ago than this get no recap (so a deploy doesn't send old ones). */
const RECAP_WINDOW_MS = 24 * 3_600_000;
/** Files sent with one push. */
const MAX_FILES = 3;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtTime = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
const courseName = (p: ClassPrep) => p.event.short ?? p.event.course ?? p.event.title;
const sessionLabel = (p: ClassPrep) => (p.session != null ? ` · Session ${p.session}` : "");
const itemName = (i: PrepItem) => (i.kind === "link" && i.url ? `<a href="${esc(i.url)}">${esc(i.title)}</a>` : esc(i.title));
const filesOf = (items: PrepItem[]) => [...new Set(items.map((i) => i.fileId).filter((f): f is string => !!f))].slice(0, MAX_FILES);
const endOf = (p: ClassPrep) => Date.parse(p.event.endAt ?? "") || Date.parse(p.event.startAt) + 90 * 60_000;
const recapKey = (p: ClassPrep) => `class.recap:${p.event.id}:${p.event.startAt}`;

/** "Pre-read: PreRead_Session 8_Groww" lines for a class, with the key points of its first summarised pre-read. */
function prepLines(p: ClassPrep): string[] {
  if (p.match === "none") return [];
  const lines: string[] = [];
  const shown = p.items.slice(0, 3);
  let pointsShown = false;
  for (const i of shown) {
    const label = p.match === "session" ? (i.preRead ? "Pre-read" : "Material") : "New";
    lines.push(`${label}: ${itemName(i)}`);
    // One pre-read's points keep the push short; the class page has all of them.
    if (!pointsShown && p.match === "session" && i.preRead && i.points?.length) {
      lines.push(...i.points.map((pt) => `• ${esc(pt)}`));
      pointsShown = true;
    }
  }
  if (p.items.length > shown.length) lines.push(`+${p.items.length - shown.length} more`);
  return lines;
}

/** The ~30-minute push for one class, with its material attached. */
export function prepAlert(p: ClassPrep, now: Date): NotificationDraft {
  const head = `📖 <b>${esc(courseName(p))}${sessionLabel(p)}</b> at ${fmtTime(p.event.startAt)}${p.event.room ? ` · ${esc(p.event.room)}` : ""}`;
  const lines = prepLines(p);
  const due = p.due.map((a) => `⏰ Due ${fmtTime(a.dueAt)}: ${esc(a.title)}`);
  const text = [head, ...(lines.length ? lines : ["No pre-read found on the LMS for this class."]), ...due].join("\n");
  const files = p.match === "none" ? [] : filesOf(p.items);
  return { dedupeKey: `class.prep:${p.event.id}:${p.event.startAt}`, priority: "high", text, scheduledFor: now.toISOString(), ...(files.length ? { files } : {}) };
}

/** The document a recap is written from: the session's first non-pre-read item with text (the deck), else any. */
const recapSource = (p: ClassPrep) => p.items.find((i) => i.noteKey && !i.preRead) ?? p.items.find((i) => i.noteKey) ?? null;

/** The after-class recap: revision points, the session's material (attached) and the recording. */
export function recapAlert(p: ClassPrep, points: string[], now: Date): NotificationDraft {
  const lines = [
    `📝 <b>${esc(courseName(p))}${sessionLabel(p)} — recap</b>`,
    ...points.map((pt) => `• ${esc(pt)}`),
    ...p.items.slice(0, 3).map((i) => `📎 ${itemName(i)}`),
    ...(p.recording ? [p.recording.url ? `🎥 <a href="${esc(p.recording.url)}">Recording: ${esc(p.recording.title)}</a>` : `🎥 Recording: ${esc(p.recording.title)}`] : []),
  ];
  const files = filesOf(p.items);
  return { dedupeKey: recapKey(p), priority: "normal", text: lines.join("\n"), scheduledFor: now.toISOString(), ...(files.length ? { files } : {}) };
}

export interface PrepSummary {
  upcoming: number;
  summarized: number;
  summaryErrors: number;
  alerts: number;
  recaps: number;
  queued: number;
}

export async function runClassPrep(sql: Sql, now: Date, model: ModelProvider | null, log?: Logger): Promise<PrepSummary> {
  const t = now.getTime();
  const load = async (from: number, to: number) =>
    (await Promise.all((await db.sessionsBetween(sql, new Date(from), new Date(to))).map((s) => db.classPrep(sql, s.id, now)))).filter((p): p is ClassPrep => !!p);
  const preps = await load(t, t + SUMMARY_AHEAD_MS);
  // Sessions with material that ended within the window and whose recap hasn't gone out.
  const ended = (await load(t - RECAP_WINDOW_MS - 4 * 3_600_000, t)).filter((p) => p.match === "session" && endOf(p) <= t && endOf(p) > t - RECAP_WINDOW_MS);
  const sent = new Set(ended.length ? (await sql`select dedupe_key from jarvis.notifications where dedupe_key = any(${ended.map(recapKey)})`).map((r) => String(r.dedupe_key)) : []);
  // Ready once the recording is up, or after a wait without one.
  const due = ended.filter((p) => !sent.has(recapKey(p)) && (p.recording || t - endOf(p) >= RECAP_WAIT_MS));
  const out: PrepSummary = { upcoming: preps.length, summarized: 0, summaryErrors: 0, alerts: 0, recaps: 0, queued: 0 };
  let budget = model ? SUMMARIES_PER_RUN : 0;

  /** One AI call: points for a document, saved (even when empty, so it isn't retried every 5 minutes). Null on failure. */
  const summarise = async (key: string, source: string, title: string, kind: "pre" | "recap"): Promise<string[] | null> => {
    budget--;
    try {
      const text = await db.prepSourceText(sql, source);
      if (!text) return null;
      const points = await prepPoints(model!, title, text, kind);
      await db.savePrepNote(sql, key, title, points, model!.name);
      out.summarized++;
      return points;
    } catch (err) {
      out.summaryErrors++;
      log?.warn("prep note failed", { key, error: err });
      return null;
    }
  };

  const drafts: NotificationDraft[] = [];
  // 1. After class: revision points from the deck, then the recap. Without points yet (out of AI calls, or the call
  //    failed) it waits for the next run — unless the class ended long ago, then it goes without them.
  for (const p of due) {
    const src = recapSource(p);
    let points: string[] = [];
    if (src?.noteKey) {
      const key = `recap:${src.noteKey}`;
      const [saved] = await sql`select points from jarvis.prep_notes where key = ${key}`;
      const got = saved ? (saved.points as unknown[]).map(String) : budget > 0 ? await summarise(key, src.noteKey, src.title, "recap") : null;
      if (got == null && model && t - endOf(p) < 2 * RECAP_WAIT_MS) continue;
      points = got ?? [];
    }
    drafts.push(recapAlert(p, points, now));
    out.recaps++;
  }

  // 2. Key points for pre-reads that have text and none yet — soonest class first.
  const todo = new Map<string, string>();
  for (const p of preps) for (const i of p.items) if (p.match === "session" && i.preRead && i.noteKey && i.hasText && !i.points && !todo.has(i.noteKey)) todo.set(i.noteKey, i.title);
  for (const [key, title] of todo) {
    if (budget <= 0) break;
    const points = await summarise(key, key, title, "pre");
    if (points) for (const p of preps) for (const i of p.items) if (i.noteKey === key) i.points = points;
  }

  // 3. The before-class push, for classes starting within the lead window.
  for (const p of preps) {
    const ms = Date.parse(p.event.startAt) - t;
    if (ms > 0 && ms <= PREP_LEAD_MS) {
      drafts.push(prepAlert(p, now));
      out.alerts++;
    }
  }
  out.queued = drafts.length ? await db.enqueueNotifications(sql, drafts) : 0;
  return out;
}
