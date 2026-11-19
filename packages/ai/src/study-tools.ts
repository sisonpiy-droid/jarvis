import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { Tool } from "./agent";
import { markdownToDocx } from "./docx";
import type { ModelProvider } from "./model";
import { writeLectureNotes } from "./study-notes";

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
      const notes = (await db.courseNotes(sql, c.courseId)).filter(db.hasNoteContent);
      if (!notes.length) return { sent: false, reason: "that course's notes are still being written" };
      const name = `${short(c.course)} - revision notes.docx`;
      const where = await sendFile(markdownToDocx(db.revisionPackMarkdown({ course: c.course }, notes, now())), name, `📚 ${short(c.course)} — ${notes.length} session${notes.length === 1 ? "" : "s"} of revision notes`, DOCX);
      return { sent: true, file: name, sessions: notes.length, note: where };
    },
  };
}

const MIN_TRANSCRIPT_CHARS = 600;
const MAX_TRANSCRIPT_CHARS = 120_000;

/**
 * "Here is the transcript of Finance session 8": notes of what was SAID in class, from a YouTube transcript the owner
 * copied or Granola notes, sent as a shared file (.txt / .docx / PDF) or pasted. Saved next to the slide notes of that
 * session and merged into the revision pack and /notes file. JARVIS never fetches the recording itself.
 */
export function classNotesTool(sql: Sql, model: ModelProvider | null): Tool {
  return {
    name: "save_class_notes",
    effect: "write-local",
    description:
      "Turn a class transcript or the owner's own class notes (a YouTube transcript they copied, Granola notes) into notes of what was said — what the professor stressed, examples, formulas, terms, test-yourself questions — and save them with that course session. Needs the course (words from its name), the session number, and the text: file_id from a 'Shared file' line, or text pasted in the message. Ask for whatever is missing.",
    parameters: {
      type: "object",
      properties: {
        course: { type: "string", description: "Words from the course name, e.g. 'Data Driven' or 'Finance'" },
        session: { type: "integer", description: "Session number" },
        file_id: { type: "string", description: "From a 'Shared file' line (.txt, .docx, PDF)" },
        text: { type: "string", description: "The transcript or notes, if pasted in the message" },
      },
      required: ["course", "session"],
    },
    async run(a) {
      if (!model) return { saved: false, reason: "no AI key is configured" };
      const session = Number(a.session);
      if (!Number.isInteger(session) || session < 1 || session > 99) throw new Error("session must be the class's session number");
      const words = typeof a.course === "string" ? a.course.trim().split(/\s+/) : [];
      const course = await db.findCourse(sql, words);
      if (!course) return { saved: false, reason: "no course matches those words — ask which course (use words from its name)" };
      if ("candidates" in course) return { saved: false, reason: "several courses match — ask which", candidates: course.candidates };
      let text = typeof a.text === "string" ? a.text : "";
      if (typeof a.file_id === "string" && a.file_id) {
        const [f] = await sql`select text_status, text_content from jarvis.files where sha256 = ${a.file_id}`;
        if (!f || f.text_status !== "done" || !f.text_content) return { saved: false, reason: "that file has no readable text — send a .txt, .docx or a PDF with selectable text" };
        text = String(f.text_content);
      }
      text = text.trim();
      if (text.length < MIN_TRANSCRIPT_CHARS) return { saved: false, reason: "that's too short to be a class — send the whole transcript as a file (a pasted message is capped at about 4,000 characters)" };
      const lecture = await writeLectureNotes(model, short(course.course), session, text.slice(0, MAX_TRANSCRIPT_CHARS));
      const n = lecture.emphasis.length + lecture.concepts.length + lecture.formulas.length + lecture.terms.length;
      if (!n) return { saved: false, reason: "I couldn't get usable notes out of that text — is it the right transcript?" };
      await db.saveLectureNotes(sql, course, session, lecture);
      return { saved: true, course: short(course.course), session, emphasis: lecture.emphasis, ideas: lecture.concepts.length, formulas: lecture.formulas.length, terms: lecture.terms.length, questions: lecture.questions.length, note: "Saved with this session; /notes and the revision pack now include an 'In class' section. Tell the owner what the professor stressed." };
    },
  };
}
