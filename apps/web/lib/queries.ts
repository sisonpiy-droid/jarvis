import "server-only";
import { db } from "./db";

// Read-only queries for the dashboard. Everything comes from jarvis.* — the
// same data the Telegram bot and alerts use.

type J = Record<string, unknown>;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : (d as string | null) ?? null);

export const IST = "Asia/Kolkata";
export function istDayBounds(offsetDays = 0, now = new Date()) {
  const off = 330 * 60_000;
  const ist = new Date(now.getTime() + off);
  const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + offsetDays) - off;
  return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
}

export interface AssignmentRow {
  id: string;
  title: string;
  course: string | null;
  dueAt: string | null;
  dueIst: string | null;
  status: string;
  submitAs: string | null;
  url: string;
  files: number;
  drafts: number;
  removed: boolean;
}

function toAssignment(r: J): AssignmentRow {
  const d = r.data as J;
  return {
    id: String(r.source_id),
    title: String(r.title),
    course: (d.courseTitle as string | null) ?? null,
    dueAt: (d.dueAt as string | null) ?? null,
    dueIst: (d.dueAtIst as string | null) ?? null,
    status: String(d.submissionStatus),
    submitAs: (d.submissionType as string | null) ?? null,
    url: String(d.sourceUrl),
    files: Number(r.files ?? 0),
    drafts: Number(r.drafts ?? 0),
    removed: !!r.removed_at,
  };
}

export async function assignments(): Promise<AssignmentRow[]> {
  const rows = await db()`
    select i.source_id, i.title, i.data, i.removed_at,
           (select count(*) from jarvis.item_files f where f.kind = 'assignment' and f.item_id = i.source_id and f.status = 'done') as files,
           (select count(*) from jarvis.drafts d where d.assignment_id = i.source_id and d.status = 'done') as drafts
      from jarvis.lms_items i where i.kind = 'assignment'
     order by i.removed_at nulls first, i.sort_at desc nulls last`;
  return rows.map(toAssignment);
}

export async function assignment(id: string) {
  const sql = db();
  const [row] = await sql`select source_id, title, data, removed_at, first_seen_at, changed_at from jarvis.lms_items where kind = 'assignment' and source_id = ${id}`;
  if (!row) return null;
  const files = await sql`
    select f.title, f.status, x.sha256, x.original_filename, x.mime_type, x.size_bytes, x.text_status
      from jarvis.item_files f left join jarvis.files x on x.sha256 = f.sha256
     where f.kind = 'assignment' and f.item_id = ${id}`;
  const drafts = await sql`select id, status, trigger, created_at, finished_at, summary, error, sources from jarvis.drafts where assignment_id = ${id} order by id desc`;
  const history = await sql`select type, created_at, payload from jarvis.domain_events where kind = 'assignment' and source_id = ${id} order by id desc limit 20`;
  return {
    ...toAssignment(row),
    data: row.data as J,
    firstSeen: iso(row.first_seen_at),
    changed: iso(row.changed_at),
    files: files.map((f) => ({ title: f.title as string, status: f.status as string, sha: f.sha256 as string | null, name: f.original_filename as string | null, size: Number(f.size_bytes ?? 0), text: f.text_status as string | null })),
    drafts: drafts.map((d) => ({ id: Number(d.id), status: d.status as string, trigger: d.trigger as string, at: iso(d.created_at), summary: d.summary as string | null, error: d.error as string | null })),
    history: history.map((h) => ({ type: h.type as string, at: iso(h.created_at), payload: h.payload as J })),
  };
}

export interface ClassRow {
  id: string;
  title: string;
  course: string | null;
  startAt: string;
  endAt: string | null;
  room: string | null;
  status: string | null;
  type: string | null;
  instructor: string | null;
}

export async function classesBetween(from: string, to: string): Promise<ClassRow[]> {
  const rows = await db()`
    select source_id, title, data from jarvis.lms_items
     where kind = 'event' and removed_at is null and sort_at >= ${from} and sort_at < ${to} order by sort_at`;
  return rows.map((r) => {
    const d = r.data as J;
    return {
      id: String(r.source_id),
      title: String(r.title),
      course: (d.courseName as string | null) ?? null,
      startAt: String(d.startAt),
      endAt: (d.endAt as string | null) ?? null,
      room: (d.room as string | null) ?? null,
      status: (d.status as string | null) ?? null,
      type: (d.eventType as string | null) ?? null,
      instructor: (d.instructor as string | null) ?? null,
    };
  });
}

export async function recentUpdates(hours = 72) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = await db()`
    select e.type, e.created_at, e.kind, e.source_id, i.title
      from jarvis.domain_events e left join jarvis.lms_items i on i.kind = e.kind and i.source_id = e.source_id
     where e.created_at >= ${since} order by e.id desc limit 25`;
  return rows.map((r) => ({ type: r.type as string, at: iso(r.created_at)!, kind: r.kind as string | null, id: r.source_id as string | null, title: r.title as string | null }));
}

export async function courses() {
  const rows = await db()`
    select c.source_id, c.title, c.data ->> 'instructor' as instructor, c.data ->> 'termName' as term,
           count(m.*) filter (where m.kind = 'material') as materials,
           count(m.*) filter (where m.kind = 'recording') as recordings
      from jarvis.lms_items c
      left join jarvis.lms_items m on m.course_id = c.source_id and m.kind in ('material', 'recording') and m.removed_at is null
     where c.kind = 'course' and c.removed_at is null
     group by c.source_id, c.title, c.data
     order by c.data ->> 'termName' desc, c.title`;
  return rows.map((r) => ({ id: String(r.source_id), title: String(r.title), instructor: r.instructor as string | null, term: r.term as string | null, materials: Number(r.materials), recordings: Number(r.recordings) }));
}

export async function courseDetail(id: string) {
  const sql = db();
  const [c] = await sql`select source_id, title, data from jarvis.lms_items where kind = 'course' and source_id = ${id}`;
  if (!c) return null;
  const items = await sql`
    select m.kind, m.source_id, m.title, m.sort_at, m.data, f.status as file_status, x.sha256, x.original_filename
      from jarvis.lms_items m
      left join jarvis.item_files f on f.kind = 'material' and f.item_id = m.source_id
      left join jarvis.files x on x.sha256 = f.sha256
     where m.course_id = ${id} and m.kind in ('material', 'recording') and m.removed_at is null
     order by m.sort_at desc nulls last`;
  return {
    id,
    title: String(c.title),
    data: c.data as J,
    items: items.map((m) => {
      const d = m.data as J;
      return {
        kind: m.kind as string,
        id: String(m.source_id),
        title: String(m.title),
        topic: (d.topicTitle as string | null) ?? null,
        type: (d.mimeOrType as string | null) ?? (d.provider as string | null) ?? null,
        at: iso(m.sort_at),
        link: (d.videoUrl as string | null) ?? (d.kind === "link" ? (d.url as string | null) : null),
        sha: m.sha256 as string | null,
        fileName: m.original_filename as string | null,
      };
    }),
  };
}

export async function status() {
  const sql = db();
  const [integ] = await sql`select status, session_expires_at, last_success_at, last_full_at, consecutive_failures, last_error from jarvis.integrations where provider = 'mesa'`;
  const runs = await sql`select id, kind, trigger, status, started_at, finished_at, request_count, notifications, changes, error from jarvis.sync_runs order by id desc limit 30`;
  const notes = await sql`select id, priority, status, scheduled_for, sent_at, left(text, 160) as text from jarvis.notifications order by id desc limit 25`;
  const files = await sql`select status, count(*)::int as n from jarvis.item_files group by status`;
  const [stored] = await sql`select count(*)::int as n, coalesce(sum(size_bytes), 0)::bigint as bytes from jarvis.files`;
  return {
    integ: integ && { status: integ.status as string, expires: iso(integ.session_expires_at), lastSuccess: iso(integ.last_success_at), lastFull: iso(integ.last_full_at), failures: Number(integ.consecutive_failures), error: integ.last_error as string | null },
    runs: runs.map((r) => ({ id: Number(r.id), kind: r.kind as string, trigger: r.trigger as string, status: r.status as string, at: iso(r.started_at)!, secs: r.finished_at ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000) : null, requests: r.request_count as number | null, notifications: r.notifications as number | null, changes: r.changes as J | null, error: r.error as string | null })),
    notes: notes.map((n) => ({ id: Number(n.id), priority: n.priority as string, status: n.status as string, at: iso(n.sent_at ?? n.scheduled_for)!, text: String(n.text).replace(/<[^>]+>/g, "") })),
    files: Object.fromEntries(files.map((f) => [f.status as string, f.n as number])) as Record<string, number>,
    stored: { count: Number(stored?.n ?? 0), bytes: Number(stored?.bytes ?? 0) },
  };
}
