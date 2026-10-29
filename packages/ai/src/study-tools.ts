import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { Tool } from "./agent";
import { markdownToDocx } from "./docx";
import { isEmptyNotes } from "./study-notes";

// "Revision notes for <course>" on demand (Telegram /notes, or just asking in chat): the same Word file the automatic
// pack before an exam sends, built from the study notes already saved — instant, and no AI at this moment.

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const short = (c: string) => c.replace(/\s+with\s+.*$/i, "");

export function revisionNotesTool(sql: Sql, now: () => Date, sendFile: (bytes: Uint8Array, filename: string, caption: string, mime?: string) => Promise<string>): Tool {
  return {
    name: "get_revision_notes",
    effect: "write-local",
    description:
      "Send the owner their revision notes for a course as a Word file: per session the key ideas, formulas, terms and test-yourself questions, each citing the file and slide/page. Pass words from the course name (e.g. 'Entrepreneurship', 'DDDM' won't match — use 'Data Driven'). Use for '/notes <course>', 'notes for Finance', 'revision pack'. Built from saved notes; if none exist yet for a course it says so.",
    parameters: { type: "object", properties: { course: { type: "string", description: "Words from the course name; empty lists the courses that have notes" } }, required: [] },
    async run(a) {
      const words = typeof a.course === "string" ? a.course.trim().split(/\s+/).filter(Boolean) : [];
      const all = await db.coursesWithNotes(sql);
      const match = words.length ? await db.coursesWithNotes(sql, words) : [];
      if (match.length !== 1) {
        return { sent: false, reason: match.length ? "several courses match — ask which" : words.length ? "no notes for that course yet (they are written from class decks over time)" : "which course?", courses: (match.length ? match : all).map((c) => ({ course: short(c.course), sessions_with_notes: c.sessions })) };
      }
      const c = match[0]!;
      const notes = (await db.courseNotes(sql, c.courseId)).filter((n) => !isEmptyNotes(n.notes));
      if (!notes.length) return { sent: false, reason: "that course's notes are still being written" };
      const name = `${short(c.course)} - revision notes.docx`;
      const where = await sendFile(markdownToDocx(db.revisionPackMarkdown({ course: c.course }, notes, now())), name, `📚 ${short(c.course)} — ${notes.length} session${notes.length === 1 ? "" : "s"} of revision notes`, DOCX);
      return { sent: true, file: name, sessions: notes.length, note: where };
    },
  };
}
