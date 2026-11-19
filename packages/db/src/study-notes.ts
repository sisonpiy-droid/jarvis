import type { Sql } from "./client";
import { sessionNumber, isPreRead } from "./class-prep";

// Study notes per class session and the revision packs built from them (migration 0028). The AI writes the notes
// (@jarvis/ai study-notes.ts); this file finds which sessions need them, stores them, and finds the exams a pack is for.

export interface StudyNotes {
  concepts: string[];
  formulas: string[];
  terms: Array<{ term: string; meaning: string }>;
  questions: string[];
}

/** Notes from what was said in class: the usual lists plus what the professor stressed. */
export interface LectureNotes extends StudyNotes {
  emphasis: string[];
}

export interface SessionSource {
  courseId: string;
  course: string;
  session: number;
  /** Files with readable text, the deck / reading first. */
  files: Array<{ sha: string; name: string; preRead: boolean }>;
  /** Names the files; the notes are rewritten when it changes. */
  sourceKey: string;
}

export interface StoredNotes {
  courseId: string;
  course: string;
  session: number;
  notes: StudyNotes;
  lecture: LectureNotes | null;
}

const noneIn = (n: StudyNotes) => !n.concepts.length && !n.formulas.length && !n.terms.length && !n.questions.length;
/** A session worth including in a pack: it has slide notes or notes from class. */
export const hasNoteContent = (n: StoredNotes) => !noneIn(n.notes) || (!!n.lecture && (!noneIn(n.lecture) || n.lecture.emphasis.length > 0));

/** Assessments a revision pack is for. */
export const EXAM_RE = /\b(end[\s-]?term|mid[\s-]?term|final|exam|quiz|viva)\b/i;

/** Every (course, session) that has material with readable text, from the downloaded LMS files. */
export async function sessionSources(sql: Sql): Promise<SessionSource[]> {
  const rows = await sql`
    select m.course_id, c.title as course, m.title, m.data ->> 'topicTitle' as folder, x.sha256, x.original_filename
      from jarvis.lms_items m
      join jarvis.lms_items c on c.kind = 'course' and c.source_id = m.course_id
      join jarvis.item_files f on f.kind = 'material' and f.item_id = m.source_id and f.status = 'done'
      join jarvis.files x on x.sha256 = f.sha256 and x.text_status = 'done'
     where m.kind = 'material' and m.removed_at is null and m.course_id is not null`;
  const by = new Map<string, SessionSource>();
  for (const r of rows) {
    const n = sessionNumber(String(r.title)) ?? sessionNumber(String(r.original_filename ?? ""));
    if (n == null) continue;
    const key = `${r.course_id}:${n}`;
    const s = by.get(key) ?? { courseId: String(r.course_id), course: String(r.course), session: n, files: [], sourceKey: "" };
    if (!s.files.some((f) => f.sha === r.sha256)) s.files.push({ sha: String(r.sha256), name: String(r.original_filename ?? r.title), preRead: isPreRead(String(r.title), (r.folder as string | null) ?? null) });
    by.set(key, s);
  }
  return [...by.values()].map((s) => ({ ...s, files: s.files.sort((a, b) => Number(a.preRead) - Number(b.preRead) || a.name.localeCompare(b.name)), sourceKey: s.files.map((f) => f.sha).sort().join(",") }));
}

/** The text a session's notes are written from: each file's text under its name, within `maxChars` (shared fairly). */
export async function sessionSourceText(sql: Sql, s: SessionSource, maxChars = 24_000): Promise<string> {
  const rows = await sql`select sha256, original_filename, text_content from jarvis.files where sha256 = any(${s.files.map((f) => f.sha)})`;
  const by = new Map(rows.map((r) => [String(r.sha256), r]));
  const each = Math.floor(maxChars / Math.max(1, s.files.length));
  return s.files
    .map((f) => by.get(f.sha))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => `=== ${r.original_filename} ===\n${String(r.text_content ?? "").slice(0, each)}`)
    .join("\n\n");
}

/** Sessions whose notes are missing or were written from different files. Courses in `urgent` go first, then newest session first. */
export async function pendingSessionNotes(sql: Sql, urgent: string[] = [], limit = 1): Promise<SessionSource[]> {
  const have = new Map((await sql`select course_id, session, source_key from jarvis.session_notes`).map((r) => [`${r.course_id}:${r.session}`, String(r.source_key)]));
  return (await sessionSources(sql))
    .filter((s) => have.get(`${s.courseId}:${s.session}`) !== s.sourceKey)
    .sort((a, b) => Number(urgent.includes(b.courseId)) - Number(urgent.includes(a.courseId)) || b.session - a.session)
    .slice(0, limit);
}

export async function saveSessionNotes(sql: Sql, s: SessionSource, notes: StudyNotes, model: string | null): Promise<void> {
  await sql`
    insert into jarvis.session_notes (course_id, session, course, source_key, notes, model)
    values (${s.courseId}, ${s.session}, ${s.course}, ${s.sourceKey}, ${sql.json(notes as never)}, ${model})
    on conflict (course_id, session) do update set course = excluded.course, source_key = excluded.source_key, notes = excluded.notes, model = excluded.model, created_at = now()`;
}

/** A course's notes in session order. */
export async function courseNotes(sql: Sql, courseId: string): Promise<StoredNotes[]> {
  return (await sql`select course_id, course, session, notes, lecture from jarvis.session_notes where course_id = ${courseId} order by session`).map((r) => ({ courseId: String(r.course_id), course: String(r.course), session: Number(r.session), notes: r.notes as StudyNotes, lecture: (r.lecture as LectureNotes | null) ?? null }));
}

export interface ExamDue {
  assignmentId: string;
  title: string;
  courseId: string;
  course: string;
  dueAt: string;
}

/** Unsubmitted exam-like assessments due within the next `withinHours`. */
export async function examsDue(sql: Sql, now: Date, withinHours = 72): Promise<ExamDue[]> {
  const rows = await sql`
    select a.source_id, a.title, a.course_id, a.sort_at, c.title as course
      from jarvis.lms_items a
      join jarvis.lms_items c on c.kind = 'course' and c.source_id = a.course_id
     where a.kind = 'assignment' and a.removed_at is null and a.course_id is not null
       and a.sort_at > ${now.toISOString()} and a.sort_at <= ${new Date(now.getTime() + withinHours * 3_600_000).toISOString()}
       and coalesce(a.data ->> 'submissionStatus', '') not like 'submitted%'
     order by a.sort_at`;
  return rows
    .filter((r) => EXAM_RE.test(String(r.title)))
    .map((r) => ({ assignmentId: String(r.source_id), title: String(r.title), courseId: String(r.course_id), course: String(r.course), dueAt: new Date(r.sort_at as string).toISOString() }));
}

const shortCourse = (c: string) => c.replace(/\s+with\s+.*$/i, "");

/** The pack as Markdown (turned into a Word file by @jarvis/ai markdownToDocx). Plain assembly of the stored notes. */
export function revisionPackMarkdown(exam: { course: string; title?: string; dueAt?: string }, notes: StoredNotes[], now: Date): string {
  const due = exam.dueAt ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(exam.dueAt)) : null;
  const out: string[] = [
    `# ${shortCourse(exam.course)} — revision pack`,
    `${exam.title && due ? `For: ${exam.title}, due ${due} IST. ` : "General revision. "}Built from your own course material: the file and slide or page each point came from is in brackets.`,
    `${notes.length} session${notes.length === 1 ? "" : "s"} covered.`,
  ];
  for (const n of notes) {
    out.push(`## Session ${n.session}`);
    if (n.notes.concepts.length) out.push("**Key ideas**", ...n.notes.concepts.map((c) => `- ${c}`));
    if (n.notes.formulas.length) out.push("**Formulas**", ...n.notes.formulas.map((f) => `- ${f}`));
    if (n.notes.terms.length) out.push("**Terms**", ...n.notes.terms.map((t) => `- **${t.term}**: ${t.meaning}`));
    const l = n.lecture;
    if (l) {
      out.push("**In class (what was said)**");
      if (l.emphasis.length) out.push(...l.emphasis.map((e) => `- ${e}`));
      if (l.concepts.length) out.push("Ideas from the discussion", ...l.concepts.map((c) => `- ${c}`));
      if (l.formulas.length) out.push("Formulas used in class", ...l.formulas.map((f) => `- ${f}`));
      if (l.terms.length) out.push("Terms used in class", ...l.terms.map((t) => `- **${t.term}**: ${t.meaning}`));
    }
  }
  const formulas = notes.flatMap((n) => [...n.notes.formulas, ...(n.lecture?.formulas ?? [])].map((f) => `- ${f} (session ${n.session})`));
  if (formulas.length) out.push("## All formulas in one place", ...formulas);
  const questions = notes.flatMap((n) => [...n.notes.questions, ...(n.lecture?.questions ?? [])].map((q) => `- ${q} (session ${n.session})`));
  if (questions.length) out.push("## Test yourself", ...questions);
  out.push(`_Prepared ${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" }).format(now)}._`);
  return out.join("\n\n");
}

/** Courses that have saved notes, optionally those whose title has all the given words. */
export async function coursesWithNotes(sql: Sql, words: string[] = []): Promise<Array<{ courseId: string; course: string; sessions: number }>> {
  const rows = await sql`select course_id, course, count(*)::int as sessions from jarvis.session_notes group by 1, 2 order by 2`;
  const w = words.map((x) => x.toLowerCase()).filter(Boolean);
  return rows.filter((r) => w.every((x) => String(r.course).toLowerCase().includes(x))).map((r) => ({ courseId: String(r.course_id), course: String(r.course), sessions: Number(r.sessions) }));
}

/** Stores notes written from a class transcript. Slide notes of the same session are left alone, and a later rewrite of them keeps these. */
export async function saveLectureNotes(sql: Sql, c: { courseId: string; course: string }, session: number, lecture: LectureNotes): Promise<void> {
  const none = { concepts: [], formulas: [], terms: [], questions: [] };
  await sql`
    insert into jarvis.session_notes (course_id, session, course, source_key, notes, lecture)
    values (${c.courseId}, ${session}, ${c.course}, '', ${sql.json(none as never)}, ${sql.json(lecture as never)})
    on conflict (course_id, session) do update set lecture = excluded.lecture`;
}

/** The LMS course whose title has all the words (null when none or several match — the caller asks which). */
export async function findCourse(sql: Sql, words: string[]): Promise<{ courseId: string; course: string } | { candidates: string[] } | null> {
  const w = words.map((x) => x.toLowerCase()).filter(Boolean);
  if (!w.length) return null;
  const rows = (await sql`select source_id, title from jarvis.lms_items where kind = 'course' and removed_at is null`).filter((r) => w.every((x) => String(r.title).toLowerCase().includes(x)));
  if (rows.length === 1) return { courseId: String(rows[0]!.source_id), course: String(rows[0]!.title) };
  return rows.length ? { candidates: rows.map((r) => shortCourse(String(r.title))) } : null;
}
