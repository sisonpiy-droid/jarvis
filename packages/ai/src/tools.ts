import type { Sql } from "@jarvis/db";
import type { Tool } from "./agent";

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
  /** Starts drafting an assignment in the background (result arrives on Telegram). */
  requestDraft?: (assignmentId: string) => Promise<void>;
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
      name: "read_file_text",
      effect: "read",
      description: "Extracted text of a downloaded Word/PowerPoint/Excel file (by file_id from other tools). PDFs are stored as originals and have no text here.",
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
      description: "Recent MESA announcements (newest first), optionally filtered by words.",
      parameters: obj({ query: { type: "string" }, limit: { type: "integer", description: "default 5, max 15" } }),
      async run(a) {
        const q = str(a.query);
        const limit = clampInt(a.limit, 1, 15, 5);
        const rows = q
          ? await sql`select data from jarvis.lms_items where kind = 'announcement' and (title ilike ${like(q)} or data ->> 'bodyText' ilike ${like(q)}) order by sort_at desc limit ${limit}`
          : await sql`select data from jarvis.lms_items where kind = 'announcement' order by sort_at desc limit ${limit}`;
        return rows.map(({ data: d }) => ({ title: d.title, from: d.author, course: d.courseName, posted: fmt(d.createdAt), text: short(d.bodyText, 1200), attachments: (d.attachments ?? []).map((x: { fileName?: string }) => x.fileName) }));
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
      description: "Schedule a Telegram reminder to the user (only to the user). Delivered within ~5 minutes of the requested time.",
      parameters: obj(
        {
          text: { type: "string", description: "What to remind about" },
          at: { type: "string", description: "When, as an ISO 8601 timestamp with timezone (the user is in IST, +05:30)" },
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
        await sql`
          insert into jarvis.notifications (dedupe_key, priority, text, scheduled_for)
          values (${`user.reminder:${crypto.randomUUID()}`}, 'high', ${`⏰ <b>Reminder</b>\n${esc}`}, ${new Date(at).toISOString()})`;
        return { scheduled_for: fmt(new Date(at).toISOString()) };
      },
    },
  ];
  if (opts.requestDraft) {
    const requestDraft = opts.requestDraft;
    tools.push({
      name: "draft_assignment",
      effect: "write-local",
      description:
        "Start writing a full first draft of an assignment (reads the original brief, attachments and class slides). The Word document arrives on Telegram in 1–3 minutes. Use when the user asks you to do, draft, write or solve an assignment.",
      parameters: obj({ query: { type: "string", description: "Assignment id or words from its title" } }, ["query"]),
      async run(a) {
        const r = await resolveAssignment(sql, str(a.query), now());
        if ("none" in r) return { started: false, reason: "no matching assignment" };
        if ("candidates" in r) return { started: false, reason: "several match — ask which one", candidates: r.candidates };
        await requestDraft(String(r.one.sourceId));
        return { started: true, assignment: r.one.title, note: "The draft will arrive as a Word document on Telegram in 1–3 minutes." };
      },
    });
  }
  return tools;
}
