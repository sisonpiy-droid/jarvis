import { markdownToDocx, writeStudyNotes, type ModelProvider } from "@jarvis/ai";
import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { BlobStorage } from "@jarvis/files";
import { esc } from "@jarvis/notify";
import type { Logger } from "@jarvis/shared";

// Part of the `prep` job (every 5 min):
// 1. Study notes: one class session per run gets its notes written from its material (decks, readings, workbooks),
//    once; they are rewritten only if the session's files change. Courses with an exam coming up go first.
// 2. Revision packs: about three days before an end-term, mid-term, quiz or viva, the course's notes are assembled
//    into one Word file and sent (Telegram gets the file; the inbox links to it). Once per exam. No AI at pack time.

/** The pack goes out when the exam is due within this many hours. */
export const PACK_AHEAD_H = 72;
/** Closer than this, the pack goes even if some sessions' notes are still being written. */
const PACK_NO_WAIT_H = 24;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const shortCourse = (c: string) => c.replace(/\s+with\s+.*$/i, "");

/** Stores a generated file like any other (content-addressed in Storage + a jarvis.files row) and returns its sha256. */
async function storeFile(sql: Sql, storage: BlobStorage, bytes: Uint8Array, name: string): Promise<string> {
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const path = `packs/${sha}.docx`;
  await storage.upload(path, bytes, DOCX);
  await sql`
    insert into jarvis.files (sha256, storage_path, mime_type, size_bytes, original_filename, text_status)
    values (${sha}, ${path}, ${DOCX}, ${bytes.length}, ${name}, 'unsupported') on conflict (sha256) do nothing`;
  return sha;
}

export interface StudyNotesSummary {
  written: number;
  errors: number;
  packs: number;
}

export async function runStudyNotes(sql: Sql, now: Date, model: ModelProvider | null, storage: BlobStorage | null, log?: Logger): Promise<StudyNotesSummary> {
  const out: StudyNotesSummary = { written: 0, errors: 0, packs: 0 };
  const exams = await db.examsDue(sql, now, PACK_AHEAD_H);

  // 1. Notes: one session per run (the free AI quota is shared with chat), exam courses first.
  if (model) {
    for (const s of await db.pendingSessionNotes(sql, exams.map((e) => e.courseId), 1)) {
      try {
        const material = await db.sessionSourceText(sql, s);
        if (!material.trim()) continue;
        const notes = await writeStudyNotes(model, shortCourse(s.course), s.session, material);
        // Saved even when empty, so a deck the model can't use isn't retried every 5 minutes.
        await db.saveSessionNotes(sql, s, notes, model.name);
        out.written++;
      } catch (err) {
        out.errors++;
        log?.warn("study notes failed", { course: s.course, session: s.session, error: err });
      }
    }
  }

  // 2. Packs.
  for (const exam of exams) {
    const key = `revision.pack:${exam.assignmentId}`;
    const [sent] = await sql`select 1 from jarvis.notifications where dedupe_key = ${key}`;
    if (sent || !storage) continue;
    const notes = (await db.courseNotes(sql, exam.courseId)).filter(db.hasNoteContent);
    if (!notes.length) continue;
    const stillWriting = (await db.pendingSessionNotes(sql, [], 1000)).some((s) => s.courseId === exam.courseId);
    if (stillWriting && Date.parse(exam.dueAt) - now.getTime() > PACK_NO_WAIT_H * 3_600_000) continue; // a few more runs and the pack is complete
    const name = `${shortCourse(exam.course)} - revision pack.docx`;
    const sha = await storeFile(sql, storage, markdownToDocx(db.revisionPackMarkdown(exam, notes, now)), name);
    const when = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(exam.dueAt));
    await db.enqueueNotifications(sql, [
      {
        dedupeKey: key,
        priority: "high",
        text: `📚 <b>Revision pack: ${esc(shortCourse(exam.course))}</b>\n${esc(exam.title)} is due ${esc(when)}.\n${notes.length} session${notes.length === 1 ? "" : "s"} of notes — key ideas, formulas, terms and test-yourself questions — attached.`,
        scheduledFor: now.toISOString(),
        url: `/files/${sha}`,
        files: [sha],
      },
    ]);
    out.packs++;
  }
  return out;
}
