import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { Tool } from "./agent";
import { cleanedCsv, cleanTable, MAX_ROWS, readTable } from "./clean-data";
import { markdownToDocx } from "./docx";
import { emailTools } from "./email-tools";
import { goalTools } from "./goal-tools";
import { nexusTools } from "./nexus-tools";
import { eventId, type GoogleCalendar } from "./google-calendar";
import { findPassages, searchTerms } from "./material-search";
import { revisionNotesTool } from "./study-tools";
import { planningTools } from "./planning-tools";
import { workTools } from "./work-tools";

// JARVIS's tools over the database. Small, typed, bounded outputs: the model
// asks for what it needs instead of being handed every record.

const IST = "Asia/Kolkata";
const fmt = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) : null;
const short = (s: string | null | undefined, n: number) => (!s ? null : s.length > n ? `${s.slice(0, n)}…` : s);
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
/** Every word must appear somewhere in the title (order and punctuation don't matter). */
const titleWords = (q: string) => {
  const w = q.split(/[\s:,–—-]+/).filter((x) => x.length > 1);
  return (w.length ? w : [q]).map(like);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

/** IST calendar day [start, end) for "today" | "tomorrow" | YYYY-MM-DD, spanning `days`. */
export function istRange(date: string, days: number, now: Date): { from: string; to: string } {
  const off = 330 * 60_000;
  const ist = new Date(now.getTime() + off);
  let y = ist.getUTCFullYear(),
    m = ist.getUTCMonth(),
    d = ist.getUTCDate();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
  else if (date === "tomorrow") d += 1;
  else if (date === "yesterday") d -= 1;
  const start = Date.UTC(y, m, d) - off;
  return { from: new Date(start).toISOString(), to: new Date(start + days * 86_400_000).toISOString() };
}

export type Resolved = { one: Record<string, unknown> } | { candidates: Array<Record<string, unknown>> } | { none: true };

/** Finds the assignment a user means: by id, else by title words, preferring upcoming unsubmitted work. */
export async function resolveAssignment(sql: Sql, query: string, now: Date = new Date()): Promise<Resolved> {
  const q = query.trim();
  if (!q) return { none: true };
  const rows = UUID.test(q)
    ? await sql`select data from jarvis.lms_items where kind = 'assignment' and source_id = ${q}`
    : await sql`select data from jarvis.lms_items where kind = 'assignment' and removed_at is null and title ilike all(${titleWords(q)}) order by sort_at desc limit 8`;
  const all = rows.map((r) => r.data as Record<string, unknown>);
  if (!all.length) return { none: true };
  if (all.length === 1) return { one: all[0]! };
  const live = all.filter((d) => !String(d.submissionStatus).startsWith("submitted") && Date.parse(String(d.dueAt)) > now.getTime());
  if (live.length === 1) return { one: live[0]! };
  return { candidates: all.map((d) => ({ id: d.sourceId, title: d.title, course: d.courseTitle, due: d.dueAtIst, status: d.submissionStatus })) };
}

export interface ToolOptions {
  /** Starts drafting an assignment in the background (it appears on the Drafts page; the owner gets a notification). */
  requestDraft?: (assignmentId: string) => Promise<void>;
  /** Saves a standing instruction for an assignment and re-does it (it appears on the Drafts page; the owner gets a notification). */
  requestRevision?: (assignmentId: string, instruction: string) => Promise<void>;
  /** Hands the owner a file on this surface (a Telegram document, or a download link on the web); returns what to tell them. */
  sendFile?: (bytes: Uint8Array, filename: string, caption: string, mime?: string) => Promise<string>;
  /** Reads a stored file by file_id (for cleaning); null when it isn't there. */
  readFile?: (fileId: string) => Promise<{ bytes: Uint8Array; name: string } | null>;
  /** The owner's Google Calendar, once connected (null/absent until then). */
  calendar?: GoogleCalendar | null;
}

export function jarvisTools(sql: Sql, now: () => Date = () => new Date(), opts: ToolOptions = {}): Tool[] {
  const tools: Tool[] = [
    {
      name: "get_upcoming_assignments",
      effect: "read",
      description: "MESA assignments due in the next N days (and recently overdue ones), with course, deadline (IST), submission status and LMS link.",
      parameters: obj({
        days: { type: "integer", description: "Look-ahead window in days (default 7, max 60)" },
        include_submitted: { type: "boolean", description: "Include ones already submitted (default false)" },
      }),
      async run(a) {
        const days = clampInt(a.days, 1, 60, 7);
        const t = now();
        const rows = await sql`
          select source_id, title, data from jarvis.lms_items
           where kind = 'assignment' and removed_at is null
             and sort_at > ${new Date(t.getTime() - 7 * 86_400_000).toISOString()}
             and sort_at <= ${new Date(t.getTime() + days * 86_400_000).toISOString()}
           order by sort_at`;
        return rows
          .map((r) => r.data as Record<string, unknown>)
          .filter((d) => a.include_submitted === true || !String(d.submissionStatus).startsWith("submitted"))
          .map((d) => ({
            id: d.sourceId,
            course: d.courseTitle,
            title: d.title,
            due: d.dueAtIst,
            overdue: Date.parse(String(d.dueAt)) < t.getTime(),
            status: d.submissionStatus,
            submit_as: d.submissionType,
            attachments: (d.materials as unknown[] | undefined)?.length ?? 0,
            url: d.sourceUrl,
          }));
      },
    },
    {
      name: "get_assignment",
      effect: "read",
      description: "Full details of one assignment: brief, instructions, links, attachments (and whether their text is available). Look up by id or by words from the title.",
      parameters: obj({ query: { type: "string", description: "Assignment id, or words from its title" } }, ["query"]),
      async run(a) {
        const q = str(a.query);
        if (!q) throw new Error("query is required");
        const rows = UUID.test(q)
          ? await sql`select data from jarvis.lms_items where kind = 'assignment' and source_id = ${q}`
          : await sql`select data from jarvis.lms_items where kind = 'assignment' and removed_at is null and title ilike all(${titleWords(q)}) order by sort_at desc limit 5`;
        if (!rows.length) return { found: false };
        if (rows.length > 1) return { found: "multiple", candidates: rows.map((r) => ({ id: r.data.sourceId, title: r.data.title, course: r.data.courseTitle, due: r.data.dueAtIst, status: r.data.submissionStatus })), hint: "Ask which one, or pick the upcoming unsubmitted one if the user clearly means that." };
        const d = rows[0]!.data as Record<string, unknown>;
        const files = await sql`
          select f.attachment_id, f.title, f.status, x.text_status, x.sha256, x.original_filename
            from jarvis.item_files f left join jarvis.files x on x.sha256 = f.sha256
           where f.kind = 'assignment' and f.item_id = ${String(d.sourceId)}`;
        return {
          id: d.sourceId,
          title: d.title,
          course: d.courseTitle,
          instructor: d.instructor,
          due: d.dueAtIst,
          late_cutoff: fmt(d.cutoffAt as string | null),
          allow_late: d.allowLate,
          submit_as: d.submissionType,
          group: d.isGroup,
          max_marks: d.maxMarks,
          status: d.submissionStatus,
          brief: d.descriptionText,
          instructions: d.instructionsText,
          links: d.links,
          attachments: ((d.materials as Array<Record<string, unknown>>) ?? []).map((m) => {
            const f = files.find((x) => x.attachment_id === m.sourceId);
            return { title: m.title, kind: m.kind, downloaded: f?.status === "done", file_id: f?.sha256 ?? null, text: f?.text_status ?? null };
          }),
          url: d.sourceUrl,
        };
      },
    },
    {
      name: "get_schedule",
      effect: "read",
      description: "Schedule for a day (IST): MESA classes/events and personal Google Calendar events (source 'google'). Time, course, title, room/location, status.",
      parameters: obj({
        date: { type: "string", description: "'today', 'tomorrow', 'yesterday' or YYYY-MM-DD (default today)" },
        days: { type: "integer", description: "Number of days from that date (default 1, max 14)" },
      }),
      async run(a) {
        const r = istRange(str(a.date) || "today", clampInt(a.days, 1, 14, 1), now());
        const rows = await sql`
          select data from jarvis.lms_items
           where kind in ('event', 'gcal_event') and removed_at is null and sort_at >= ${r.from} and sort_at < ${r.to}
           order by sort_at`;
        return rows.map(({ data: d }) => ({ source: d.source === "gcal" ? "google" : "mesa", when: d.startAtIst, ends: d.allDay ? null : fmt(d.endAt), course: d.courseName, title: d.title, type: d.eventType, room: d.room, status: d.status, instructor: d.instructor }));
      },
    },
    {
      name: "search_lms",
      effect: "read",
      description: "Search across assignments, class materials, recordings, announcements and the extracted text of downloaded Word/PowerPoint/Excel files.",
      parameters: obj({ query: { type: "string" }, limit: { type: "integer", description: "Max results (default 10, max 25)" } }, ["query"]),
      async run(a) {
        const q = str(a.query);
        if (q.length < 2) throw new Error("query too short");
        const limit = clampInt(a.limit, 1, 25, 10);
        const items = await sql`
          select kind, source_id, title, course_id, data ->> 'courseTitle' as course_title, data ->> 'topicTitle' as topic, sort_at
            from jarvis.lms_items
           where removed_at is null and (title ilike ${like(q)} or data::text ilike ${like(q)})
           order by sort_at desc nulls last limit ${limit}`;
        const files = await sql`
          select original_filename, sha256, substring(text_content from greatest(1, position(lower(${q}) in lower(text_content)) - 150) for 400) as snippet
            from jarvis.files where text_content ilike ${like(q)} limit ${limit}`;
        return {
          items: items.map((r) => ({ kind: r.kind, id: r.source_id, title: r.title, course: r.course_title, topic: r.topic, date: fmt(r.sort_at?.toISOString?.() ?? r.sort_at) })),
          file_matches: files.map((f) => ({ file: f.original_filename, file_id: f.sha256, snippet: f.snippet })),
        };
      },
    },
    {
      name: "find_in_materials",
      effect: "read",
      description:
        "Find where the owner's course material (slides, readings, workbooks, files they shared) answers a question or covers a topic. Returns the matching passages with the file name and the page / slide / sheet. Use FIRST for any question about what was taught or what a document says. If found is false, the material doesn't cover it: say so and stop.",
      parameters: obj({ query: { type: "string", description: "The question or the key terms, e.g. 'CAC payback formula'" } }, ["query"]),
      async run(a) {
        const terms = searchTerms(str(a.query));
        if (!terms.length) throw new Error("query has no searchable words — ask what exactly to look for");
        const rows = await sql`
          select f.sha256, f.original_filename, f.text_content,
                 (select c.title from jarvis.item_files i
                    join jarvis.lms_items m on m.kind = 'material' and m.source_id = i.item_id
                    join jarvis.lms_items c on c.kind = 'course' and c.source_id = m.course_id
                   where i.sha256 = f.sha256 limit 1) as course
            from jarvis.files f
           where f.text_status = 'done' and f.text_content ilike any(${terms.map(like)})
           limit 80`;
        const passages = findPassages(
          rows.map((r) => ({ fileId: String(r.sha256), name: String(r.original_filename ?? "file"), course: (r.course as string | null) ?? null, text: String(r.text_content) })),
          terms,
        );
        if (!passages.length) {
          return { found: false, searched_terms: terms, note: "Not in the owner's course material. Tell them it isn't there and stop — no general-knowledge answer, no guess." };
        }
        return { found: true, passages: passages.map((p) => ({ file: p.file, location: p.location, course: p.course, text: p.text, file_id: p.fileId })) };
      },
    },
    {
      name: "get_course_materials",
      effect: "read",
      description: "Materials (slides, readings, files, links) and recordings for a course, newest first.",
      parameters: obj({ course: { type: "string", description: "Words from the course name" }, limit: { type: "integer", description: "default 25, max 60" } }, ["course"]),
      async run(a) {
        const c = str(a.course);
        const limit = clampInt(a.limit, 1, 60, 25);
        const rows = await sql`
          select m.kind, m.title, m.data ->> 'topicTitle' as topic, m.data ->> 'mimeOrType' as type, m.sort_at, c.title as course,
                 f.status as file_status, x.text_status, x.sha256
            from jarvis.lms_items m
            join jarvis.lms_items c on c.kind = 'course' and c.source_id = m.course_id
            left join jarvis.item_files f on f.kind = 'material' and f.item_id = m.source_id
            left join jarvis.files x on x.sha256 = f.sha256
           where m.kind in ('material', 'recording') and m.removed_at is null and c.title ilike ${like(c)}
           order by m.sort_at desc nulls last limit ${limit}`;
        return rows.map((r) => ({ course: r.course, kind: r.kind, topic: r.topic, title: r.title, type: r.type, date: fmt(r.sort_at?.toISOString?.()), downloaded: r.file_status === "done", file_id: r.sha256, text: r.text_status }));
      },
    },
    {
      name: "query_assignments",
      effect: "read",
      description:
        "Filter and COUNT across ALL MESA assignments (past and future): by course / professor / short name, submission status (open = not submitted, submitted, late = submitted late, overdue = not submitted and past due), and due-date range. Returns exact totals, a breakdown (by course, professor or status) and the matching list. Use this for any counting, comparison or 'which/how many' question instead of adding up partial lists.",
      parameters: obj({
        course: { type: "string", description: "Optional course words, short name (DDDM) or professor name" },
        status: { type: "string", enum: ["all", "open", "submitted", "late", "overdue"], description: "Default all" },
        due_from: { type: "string", description: "Optional YYYY-MM-DD (IST), inclusive" },
        due_to: { type: "string", description: "Optional YYYY-MM-DD (IST), inclusive" },
        group_by: { type: "string", enum: ["course", "professor", "status", "none"], description: "Breakdown to return (default course)" },
      }),
      async run(a) {
        const course = str(a.course).replace(/^(prof\.?|professor|dr\.?)\s+/i, "");
        const status = (["all", "open", "submitted", "late", "overdue"] as const).find((s) => s === a.status) ?? "all";
        const day = (v: unknown, end: boolean) => {
          const s = str(v);
          if (!s) return null;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("dates must be YYYY-MM-DD");
          return istRange(s, 1, now())[end ? "to" : "from"];
        };
        const from = day(a.due_from, false);
        const to = day(a.due_to, true);
        const t = now().toISOString();
        const words = course ? titleWords(course) : null;
        const rows = await sql`
          select i.source_id, i.title, i.sort_at, i.data, c.data ->> 'instructor' as professor, c.data ->> 'shortName' as short
            from jarvis.lms_items i
            left join jarvis.lms_items c on c.kind = 'course' and c.source_id = i.course_id
           where i.kind = 'assignment' and i.removed_at is null
             ${words ? sql`and (coalesce(i.data ->> 'courseTitle', '') ilike all(${words}) or coalesce(c.data ->> 'instructor', '') ilike all(${words}) or c.data ->> 'shortName' ilike ${course})` : sql``}
             ${from ? sql`and i.sort_at >= ${from}` : sql``}
             ${to ? sql`and i.sort_at < ${to}` : sql``}
           order by i.sort_at nulls last`;
        const statusOf = (d: Record<string, unknown>, due: string | null) => {
          const s = String(d.submissionStatus ?? "");
          if (s === "submitted_late") return "late";
          if (s.startsWith("submitted")) return "submitted";
          return due && due < t ? "overdue" : "open";
        };
        const all = rows.map((r) => {
          const due = r.sort_at instanceof Date ? r.sort_at.toISOString() : (r.sort_at as string | null);
          return { id: String(r.source_id), title: String(r.title), course: (r.data.courseTitle as string | null) ?? null, professor: (r.professor as string | null) ?? (r.data.instructor as string | null) ?? null, due: (r.data.dueAtIst as string | null) ?? fmt(due), status: statusOf(r.data, due) };
        });
        const matched = all.filter((x) => status === "all" || x.status === status || (status === "open" && x.status === "overdue"));
        const key = (["course", "professor", "status", "none"] as const).find((g) => g === a.group_by) ?? "course";
        const breakdown: Record<string, number> = {};
        if (key !== "none") for (const x of matched) breakdown[String(x[key] ?? "unknown")] = (breakdown[String(x[key] ?? "unknown")] ?? 0) + 1;
        return {
          total: matched.length,
          ...(key !== "none" ? { [`by_${key}`]: Object.fromEntries(Object.entries(breakdown).sort((p, q) => q[1] - p[1])) } : {}),
          assignments: matched.slice(0, 80),
          ...(matched.length > 80 ? { note: `${matched.length - 80} more not listed; totals above are complete` } : {}),
        };
      },
    },
    {
      name: "get_course",
      effect: "read",
      description:
        "Everything about one MESA course, found by course name, short name (e.g. DDDM) or the professor's name (e.g. 'Vinay'): instructor, classes held so far and upcoming, recordings, materials by folder (session workbooks, pre-reads, outlines — with file_id to read their text), and assignments with deadlines and status. Use for 'what has <professor> taught', 'what did we cover in <course>', 'what's left in <course>'.",
      parameters: obj({ query: { type: "string", description: "Course name words, short name, or professor name" } }, ["query"]),
      async run(a) {
        const q = str(a.query).replace(/^(prof\.?|professor|dr\.?)\s+/i, "");
        if (q.length < 2) throw new Error("query is required");
        const courses = await sql`
          select source_id, title, data from jarvis.lms_items
           where kind = 'course' and removed_at is null
             and (title ilike all(${titleWords(q)}) or data ->> 'shortName' ilike ${q} or data ->> 'instructor' ilike all(${titleWords(q)}))
           order by title limit 6`;
        if (!courses.length) return { found: false, hint: "No course matches; try search_lms with the same words." };
        if (courses.length > 1) return { found: "multiple", candidates: courses.map((c) => ({ course: c.title, short: c.data.shortName, instructor: c.data.instructor })) };
        const c = courses[0]!;
        const t = now().toISOString();
        const [events, recordings, materials, assignments] = await Promise.all([
          sql`select title, sort_at, data from jarvis.lms_items where kind = 'event' and course_id = ${c.source_id} and removed_at is null order by sort_at`,
          sql`select title, sort_at from jarvis.lms_items where kind = 'recording' and course_id = ${c.source_id} and removed_at is null order by sort_at`,
          sql`
            select m.title, m.sort_at, m.data ->> 'topicTitle' as folder, x.sha256, x.text_status
              from jarvis.lms_items m
              left join jarvis.item_files f on f.kind = 'material' and f.item_id = m.source_id
              left join jarvis.files x on x.sha256 = f.sha256
             where m.kind = 'material' and m.course_id = ${c.source_id} and m.removed_at is null
             order by m.sort_at nulls last limit 80`,
          sql`select source_id, title, data from jarvis.lms_items where kind = 'assignment' and course_id = ${c.source_id} and removed_at is null order by sort_at nulls last`,
        ]);
        const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
        const session = (e: (typeof events)[number]) => ({ when: e.data.startAtIst ?? fmt(iso(e.sort_at)), title: e.title, type: e.data.eventType, status: e.data.status, about: short(e.data.descriptionText, 300) });
        const folders: Record<string, Array<{ title: string; date: string | null; file_id?: string; has_text: boolean }>> = {};
        for (const m of materials) (folders[String(m.folder ?? "Other")] ??= []).push({ title: String(m.title), date: fmt(iso(m.sort_at)), ...(m.sha256 ? { file_id: String(m.sha256) } : {}), has_text: m.text_status === "done" });
        return {
          course: c.title,
          short: c.data.shortName,
          instructor: c.data.instructor,
          term: c.data.termName,
          about: short(c.data.descriptionText, 600),
          url: c.data.sourceUrl,
          classes_held: events.filter((e) => iso(e.sort_at)! < t).map(session),
          classes_upcoming: events.filter((e) => iso(e.sort_at)! >= t).map(session),
          recordings: recordings.map((r) => ({ title: r.title, date: fmt(iso(r.sort_at)) })),
          materials_by_folder: folders,
          assignments: assignments.map((x) => ({ id: x.source_id, title: x.title, due: x.data.dueAtIst, status: x.data.submissionStatus })),
          hint: "Session titles, recordings, workbooks and assignment case names show what was taught; read an outline or workbook with read_file_text(file_id) for detail.",
        };
      },
    },
    {
      name: "get_class_prep",
      effect: "read",
      description:
        "What to prepare for upcoming MESA classes: the session number (worked out from recordings and the timetable), that session's pre-reads and materials (file_id to read their text, or a link), stored key points of each pre-read, and the course's assignments due around the class. Use for 'what should I prepare for tomorrow', 'what's the pre-read for DDDM', 'prep for my next class'.",
      parameters: obj({
        course: { type: "string", description: "Optional course words, short name (DDDM) or professor name; omit for all classes" },
        date: { type: "string", description: "Optional 'today' | 'tomorrow' | YYYY-MM-DD (IST); default: the next 7 days" },
        limit: { type: "integer", description: "Classes to return (default 3, max 8)" },
      }),
      async run(a) {
        const date = str(a.date);
        if (date && date !== "today" && date !== "tomorrow" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be today, tomorrow or YYYY-MM-DD");
        const range = date ? istRange(date, 1, now()) : { from: now().toISOString(), to: new Date(now().getTime() + 7 * 86_400_000).toISOString() };
        const from = new Date(Math.max(Date.parse(range.from), date === "today" || !date ? now().getTime() - 60 * 60_000 : 0));
        const course = str(a.course).replace(/^(prof\.?|professor|dr\.?)\s+/i, "");
        const words = course ? titleWords(course) : null;
        const rows = await sql`
          select e.source_id from jarvis.lms_items e
            left join jarvis.lms_items c on c.kind = 'course' and c.source_id = e.course_id
           where e.kind = 'event' and e.removed_at is null and e.course_id is not null
             and e.data ->> 'eventType' = 'session' and coalesce(e.data ->> 'status', '') <> 'cancelled'
             and e.sort_at >= ${from.toISOString()} and e.sort_at < ${range.to}
             ${words ? sql`and (coalesce(c.title, e.title) ilike all(${words}) or e.title ilike all(${words}) or c.data ->> 'shortName' ilike ${course} or coalesce(c.data ->> 'instructor', '') ilike all(${words}))` : sql``}
           order by e.sort_at limit ${clampInt(a.limit, 1, 8, 3)}`;
        const preps = (await Promise.all(rows.map((r) => db.classPrep(sql, String(r.source_id), now())))).filter((p): p is db.ClassPrep => !!p);
        if (!preps.length) return { classes: [], note: `No MESA classes${course ? ` for "${course}"` : ""} in that window.` };
        return {
          classes: preps.map((p) => ({
            when: fmt(p.event.startAt),
            course: p.event.course,
            short: p.event.short,
            title: p.event.title,
            room: p.event.room,
            session: p.session,
            materials_basis: p.match === "session" ? `matched to session ${p.session}` : p.match === "recent" ? "session number unknown — these are the course's newest materials, not confirmed as this class's pre-read" : "nothing found",
            materials: p.items.map((i) => ({ title: i.title, folder: i.folder, pre_read: i.preRead, ...(i.fileId ? { file_id: i.fileId } : {}), ...(i.url ? { link: i.url } : {}), has_text: i.hasText, ...(i.points?.length ? { key_points: i.points } : {}) })),
            due_soon: p.due.map((d) => ({ id: d.id, title: d.title, due: fmt(d.dueAt) })),
            page: `/classes/${p.event.id}`,
          })),
        };
      },
    },
    {
      name: "read_file_text",
      effect: "read",
      description: "Extracted text of a stored file — PDFs, Word/PowerPoint/Excel, and images or files shared to JARVIS (by file_id from other tools or from a 'Shared file' line). Scanned PDFs have no text.",
      parameters: obj({ file_id: { type: "string" }, max_chars: { type: "integer", description: "default 12000, max 30000" } }, ["file_id"]),
      async run(a) {
        const [f] = await sql`select original_filename, text_status, text_content from jarvis.files where sha256 = ${str(a.file_id)}`;
        if (!f) return { found: false };
        if (f.text_status !== "done") return { file: f.original_filename, text: null, note: f.text_status === "original" ? "Stored as the original PDF/image; no extracted text yet." : `No text (${f.text_status}).` };
        return { file: f.original_filename, text: short(f.text_content, clampInt(a.max_chars, 500, 30_000, 12_000)) };
      },
    },
    {
      name: "get_announcements",
      effect: "read",
      description:
        "MESA announcements, newest first. Filter by look-back window (days) and by keywords — an announcement matches if it contains ANY of the keywords (e.g. ['exam','viva','deadline','postponed']). Returns the total that matched as well as the items.",
      parameters: obj({
        keywords: { type: "array", items: { type: "string" }, description: "Optional; matches any of them in the title or text" },
        query: { type: "string", description: "Optional single phrase (older form of keywords)" },
        days: { type: "integer", description: "Look-back window in days (default: no limit, max 365)" },
        limit: { type: "integer", description: "default 10, max 30" },
      }),
      async run(a) {
        const kws = [...(Array.isArray(a.keywords) ? a.keywords : []), a.query].map(str).filter((k) => k.length > 1).slice(0, 12);
        const limit = clampInt(a.limit, 1, 30, 10);
        const since = a.days != null ? new Date(now().getTime() - clampInt(a.days, 1, 365, 14) * 86_400_000).toISOString() : null;
        const rows = await sql`
          select data, count(*) over () as total from jarvis.lms_items
           where kind = 'announcement' and removed_at is null
             ${since ? sql`and sort_at >= ${since}` : sql``}
             ${kws.length ? sql`and (title ilike any(${kws.map(like)}) or coalesce(data ->> 'bodyText', '') ilike any(${kws.map(like)}))` : sql``}
           order by sort_at desc limit ${limit}`;
        return {
          total: Number(rows[0]?.total ?? 0),
          announcements: rows.map(({ data: d }) => ({ title: d.title, from: d.author, course: d.courseName, posted: fmt(d.createdAt), text: short(d.bodyText, 1200), attachments: (d.attachments ?? []).map((x: { fileName?: string }) => x.fileName) })),
        };
      },
    },
    {
      name: "get_recent_updates",
      effect: "read",
      description: "What changed on the LMS recently: new/changed assignments, deadline moves, new materials, announcements, class changes.",
      parameters: obj({ hours: { type: "integer", description: "Look-back window (default 48, max 336)" } }),
      async run(a) {
        const since = new Date(now().getTime() - clampInt(a.hours, 1, 336, 48) * 3_600_000).toISOString();
        const rows = await sql`
          select e.type, e.created_at, e.payload, i.title
            from jarvis.domain_events e left join jarvis.lms_items i on i.kind = e.kind and i.source_id = e.source_id
           where e.created_at >= ${since} order by e.created_at desc limit 40`;
        return rows.map((r) => ({ what: r.type, item: r.title, when: fmt(r.created_at?.toISOString?.() ?? r.created_at), detail: r.payload }));
      },
    },
    {
      name: "get_status",
      effect: "read",
      description: "JARVIS health: last LMS sync, MESA sign-in expiry, file download progress, queued notifications.",
      parameters: obj({}),
      async run() {
        const [run] = await sql`select kind, status, started_at, error from jarvis.sync_runs order by id desc limit 1`;
        const [integ] = await sql`select status, session_expires_at, last_success_at, last_full_at from jarvis.integrations where provider = 'mesa'`;
        const files = await sql`select status, count(*)::int as n from jarvis.item_files group by status`;
        const [q] = await sql`select count(*)::int as n from jarvis.notifications where status = 'queued'`;
        return {
          last_sync: run && { kind: run.kind, status: run.status, at: fmt(run.started_at?.toISOString?.()), error: run.error },
          mesa: integ && { status: integ.status, sign_in_expires: fmt(integ.session_expires_at?.toISOString?.()), last_success: fmt(integ.last_success_at?.toISOString?.()), last_full_scan: fmt(integ.last_full_at?.toISOString?.()) },
          files: Object.fromEntries(files.map((f) => [f.status, f.n])),
          queued_notifications: q?.n ?? 0,
        };
      },
    },
    {
      name: "create_reminder",
      effect: "write-local",
      description: "Schedule a reminder notification to the owner (inbox and push). Delivered within ~5 minutes of the requested time.",
      parameters: obj(
        {
          text: { type: "string", description: "What to remind about" },
          at: { type: "string", description: "When, as an ISO 8601 timestamp with timezone (the owner is in IST, +05:30)" },
        },
        ["text", "at"],
      ),
      async run(a) {
        const text = str(a.text).slice(0, 1000);
        const at = Date.parse(str(a.at));
        const t = now().getTime();
        if (!text) throw new Error("text is required");
        if (!Number.isFinite(at)) throw new Error("'at' must be an ISO timestamp");
        if (at < t - 60_000) throw new Error("that time is in the past");
        if (at > t + 366 * 86_400_000) throw new Error("reminders can be at most a year ahead");
        const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        // Through the normal queue: category 'reminder' (from the user.* key), routed to the inbox and push.
        const scheduledFor = new Date(at).toISOString();
        await db.enqueueNotifications(sql, [{ dedupeKey: `user.reminder:${crypto.randomUUID()}`, priority: "high", text: `⏰ <b>Reminder</b>\n${esc}`, scheduledFor, url: "/inbox" }]);
        return { scheduled_for: fmt(scheduledFor), scheduled_for_iso: scheduledFor };
      },
    },
    {
      name: "get_costs",
      effect: "read",
      description: "What JARVIS's own AI calls cost (estimated at paid prices; the free tier is free): spend today, last 7 days and overall, each by task, and the most expensive task. Use for 'what have I spent today?', 'what's my most expensive task?'.",
      parameters: obj({}),
      async run() {
        const s = await db.costSummary(sql, now());
        const win = (w: db.CostWindow) => ({ calls: w.calls, tokens: w.tokens, usd: Number(w.usd.toFixed(4)), by_task: w.byTask.map((t) => ({ task: t.task, calls: t.calls, tokens: t.inputTokens + t.outputTokens, usd: Number(t.usd.toFixed(4)) })) });
        return { today: win(s.today), last_7_days: win(s.week), all_time: win(s.all), most_expensive_task: s.topTask ? { task: s.topTask.task, usd: Number(s.topTask.usd.toFixed(4)) } : null, since: s.since };
      },
    },
    ...emailTools(sql),
    ...nexusTools(sql, now),
    ...workTools(sql, now),
    ...goalTools(sql, now),
    ...planningTools(sql, now),
  ];
  if (opts.requestDraft) {
    const requestDraft = opts.requestDraft;
    tools.push({
      name: "draft_assignment",
      effect: "write-local",
      description:
        "Start writing a full first draft of an assignment (reads the original brief, attachments and class slides). In 1–3 minutes the Word document appears on the Drafts page; you'll get a notification. Use when the owner asks you to do, draft, write or solve an assignment.",
      parameters: obj({ query: { type: "string", description: "Assignment id or words from its title" } }, ["query"]),
      async run(a) {
        const r = await resolveAssignment(sql, str(a.query), now());
        if ("none" in r) return { started: false, reason: "no matching assignment" };
        if ("candidates" in r) return { started: false, reason: "several match — ask which one", candidates: r.candidates };
        await requestDraft(String(r.one.sourceId));
        return { started: true, assignment: r.one.title, note: "In 1–3 minutes the draft (a Word document) appears on the Drafts page; you'll get a notification." };
      },
    });
  }
  if (opts.requestRevision) {
    const requestRevision = opts.requestRevision;
    tools.push({
      name: "revise_assignment",
      effect: "write-local",
      description:
        "Change or correct an assignment JARVIS is doing: pass the owner's instruction (e.g. 'our startup is Snitch', 'use Pune not Delhi', 'make the recommendation shorter', 'add a slide on pricing'). It is remembered for that assignment and the deliverables are redone (in 1–3 min they appear on the Drafts page; you'll get a notification). Use whenever the owner gives information or feedback about a specific assignment's draft.",
      parameters: obj(
        {
          query: { type: "string", description: "Assignment id or words from its title" },
          instruction: { type: "string", description: "The owner's instruction, in their words, self-contained" },
        },
        ["query", "instruction"],
      ),
      async run(a) {
        const instruction = str(a.instruction).slice(0, 4000);
        if (instruction.length < 2) throw new Error("instruction is required");
        const r = await resolveAssignment(sql, str(a.query), now());
        if ("none" in r) return { started: false, reason: "no matching assignment" };
        if ("candidates" in r) return { started: false, reason: "several match — ask which one", candidates: r.candidates };
        await requestRevision(String(r.one.sourceId), instruction);
        return { started: true, assignment: r.one.title, note: "Saved for this assignment. In 1–3 minutes the revised deliverables appear on the Drafts page; you'll get a notification." };
      },
    });
  }
  tools.push({
    name: "add_calendar_event",
    effect: "write-calendar",
    description:
      "Add an event to the owner's own Google Calendar right now: block time, add a study session or meeting. ONLY when the owner explicitly asks you to block time or add something to their calendar — never on your own initiative. start/end are ISO date-times with +05:30; give end or minutes (default 60). It checks for clashes with their classes and events first.",
    parameters: obj(
      {
        title: { type: "string" },
        start: { type: "string", description: "ISO date-time, e.g. 2026-10-12T15:00:00+05:30" },
        end: { type: "string", description: "ISO date-time (or use minutes)" },
        minutes: { type: "integer", description: "Length if no end (default 60, max 720)" },
        notes: { type: "string" },
        allow_overlap: { type: "boolean", description: "Only after the owner confirmed they want it despite the clash" },
      },
      ["title", "start"],
    ),
    async run(a) {
      const title = str(a.title).slice(0, 200);
      const start = new Date(str(a.start));
      if (!title) throw new Error("title is required");
      if (Number.isNaN(start.getTime())) throw new Error("start must be an ISO date-time like 2026-10-12T15:00:00+05:30");
      const end = a.end ? new Date(str(a.end)) : new Date(start.getTime() + clampInt(a.minutes, 15, 720, 60) * 60_000);
      if (Number.isNaN(end.getTime()) || end <= start) throw new Error("end must be after start");
      if (end.getTime() - start.getTime() > 12 * 3_600_000) throw new Error("an event can be at most 12 hours");
      if (start.getTime() < now().getTime() - 5 * 60_000 || start.getTime() > now().getTime() + 366 * 86_400_000) throw new Error("start must be between now and a year ahead");
      if (!opts.calendar) {
        return { added: false, reason: "Google Calendar isn't connected yet. One-time setup on the owner's laptop: add a Google OAuth client to .env, run `npm run google:auth`, then `npm run deploy:cloud` (see docs/GOOGLE_CALENDAR.md). Tell them this; nothing was added." };
      }
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      if (a.allow_overlap !== true) {
        const near = await db.calendarBetween(sql, new Date(start.getTime() - 8 * 3_600_000).toISOString(), endIso);
        const clashes = near.filter((e) => !e.cancelled && !e.allDay && e.startAt < endIso && (e.endAt ?? new Date(Date.parse(e.startAt) + 3_600_000).toISOString()) > startIso);
        if (clashes.length) {
          return { added: false, clashes: clashes.map((e) => ({ title: e.title, starts: fmt(e.startAt), ends: e.endAt ? fmt(e.endAt) : null })), note: "That overlaps. Tell the owner what it clashes with and ask; only call again with allow_overlap if they confirm." };
        }
      }
      const r = await opts.calendar.createEvent({ id: await eventId(title, startIso, endIso), title, startIso, endIso, ...(str(a.notes) ? { notes: str(a.notes).slice(0, 2000) } : {}) });
      return { added: true, already_there: r.duplicate, title, starts: fmt(startIso), ends: fmt(endIso), link: r.link };
    },
  });
  if (opts.sendFile) {
    const sendFile = opts.sendFile;
    tools.push(revisionNotesTool(sql, now, sendFile));
    tools.push({
      name: "make_document",
      effect: "write-local",
      description:
        "Turn notes, a summary, a cheat sheet or any answer into a Word document and give it to the owner. Use when they ask for a doc, PDF, file or something to download/print. Pass the FULL content as Markdown (headings, bullets, tables), not a pointer to an earlier message. Word only — it opens on any phone and can be saved as PDF from there.",
      parameters: obj(
        {
          title: { type: "string", description: "Short document title, e.g. 'DDDM Excel formulas'" },
          markdown: { type: "string", description: "The complete document body in Markdown" },
        },
        ["title", "markdown"],
      ),
      async run(a) {
        const title = str(a.title).replace(/[\\/:*?"<>|\0\s]+/g, " ").trim().slice(0, 80) || "JARVIS notes";
        const md = str(a.markdown);
        if (md.trim().length < 20) throw new Error("markdown is required: pass the full document content");
        const note = await sendFile(markdownToDocx(`# ${title}\n\n${md}`), `${title}.docx`, `📄 ${title}`);
        return { sent: true, file: `${title}.docx`, note };
      },
    });
  }
  if (opts.readFile && opts.sendFile) {
    const { readFile, sendFile } = opts;
    tools.push({
      name: "clean_data",
      effect: "write-local",
      description:
        "Clean a spreadsheet or CSV the owner shared (by file_id): fixes spacing, case, dates, numbers, emails and phone numbers, removes blank rows and exact duplicates, and FLAGS every row it isn't sure about instead of guessing. Sends the cleaned file back with a 'needs review' column. Use for 'clean this up', 'tidy this sheet', 'fix this data'.",
      parameters: obj({ file_id: { type: "string", description: "From the 'Shared file' line" } }, ["file_id"]),
      async run(a) {
        const f = await readFile(str(a.file_id));
        if (!f) return { cleaned: false, reason: "no such file" };
        const table = readTable(f.bytes, f.name);
        if (!table) return { cleaned: false, reason: "I can clean CSV and Excel (.xlsx) files; this is a different kind of file." };
        if (table.length > MAX_ROWS + 1) return { cleaned: false, reason: `That's ${table.length - 1} rows; I clean up to ${MAX_ROWS} at a time. Split the file.` };
        const res = cleanTable(table);
        if (!res.rows.length) return { cleaned: false, reason: "There are no data rows under the header." };
        const base = f.name.replace(/\.[a-z0-9]+$/i, "");
        const flagged = res.rows.filter((r) => r.flags.length);
        await sendFile(new TextEncoder().encode(cleanedCsv(res)), `${base}-cleaned.csv`, `🧹 ${base}: ${res.rows.length} rows, ${flagged.length} need a look`, "text/csv");
        return {
          cleaned: true,
          file: `${base}-cleaned.csv`,
          rows_in: res.rowsIn,
          rows_out: res.rows.length,
          blank_rows_removed: res.blankRemoved,
          exact_duplicates_removed: res.duplicatesRemoved.slice(0, 10),
          cells_changed: res.cellsChanged,
          flagged_rows: flagged.length,
          flagged: flagged.slice(0, 25).map((r) => ({ row: r.row, why: r.flags })),
          note: "The cleaned file was sent; flagged rows are marked in its 'needs review' column. Report the counts, then list the flagged rows (row number and reason). Never guess the right value for a flagged cell.",
        };
      },
    });
  }
  return tools;
}
