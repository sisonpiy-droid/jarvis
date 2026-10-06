import type { Sql } from "./client";
import { addDays, istDay, type Day } from "./progress";

// What to prepare for a MESA class: the session's pre-read and materials, plus anything of that course due soon.
// Deterministic — no AI. MESA calendar events don't carry a session number ("Data Driven Decision Making with
// Vinay Sharma"), but recordings do ("Session 7", recorded on a date) and so do materials ("PreRead_Session 8_Groww").
// So the class's number is the latest recorded session before it, plus the course's sessions held after that
// recording up to this class. Only a known number links materials; otherwise the course's newest materials are
// shown as such ("New for this course"), never as "the pre-read".

export type PrepMatch = "session" | "recent" | "none";

export interface PrepItem {
  title: string;
  folder: string | null;
  kind: "file" | "text" | "link";
  preRead: boolean;
  /** Stored file (sha256), when downloaded. */
  fileId: string | null;
  /** External link (Google Doc, YouTube, article) for link materials. */
  url: string | null;
  hasText: boolean;
  /** prep_notes key when the item has text worth summarising. */
  noteKey: string | null;
  points: string[] | null;
}

export interface PrepEvent {
  id: string;
  title: string;
  course: string | null;
  courseId: string | null;
  short: string | null;
  startAt: string;
  endAt: string | null;
  room: string | null;
  meetingLink: string | null;
  status: string | null;
}

export interface ClassPrep {
  event: PrepEvent;
  /** Estimated session number, or null when it can't be worked out. */
  session: number | null;
  match: PrepMatch;
  items: PrepItem[];
  /** Open assignments of this course due from now until a day after the class. */
  due: Array<{ id: string; title: string; dueAt: string }>;
  /** This session's recording, once it is on the LMS (needs a known session number). */
  recording: { title: string; url: string | null } | null;
}

const SESSION_RE = /(?:^|[^a-z])sess(?:ion)?[\s_.#-]*0*(\d{1,3})(?!\d)/i;
const PRE_READ_RE = /pre[\s_-]?(?:read|prep|class|work)|reading/i;
/** Without a session number: course materials posted this recently count as "new for this course". */
const RECENT_DAYS = 5;

/** "PreRead_Session 8_Groww" → 8; "Session 13 Deck" → 13; "Pre-Read FOF1" → null. */
export function sessionNumber(title: string | null | undefined): number | null {
  const m = SESSION_RE.exec(title ?? "");
  return m ? Number(m[1]) : null;
}

export const isPreRead = (title: string, folder: string | null) => PRE_READ_RE.test(folder ?? "") || PRE_READ_RE.test(title);

/**
 * The class's session number. `recordings` are the course's recordings (title + IST day recorded); `sessionStarts`
 * the start instants of the course's scheduled (not cancelled) sessions that the LMS calendar still lists.
 * The anchor is the highest-numbered recording before the class's day; classes on later days up to and including
 * this one are counted on top (distinct start times, so a slot listed twice counts once). If the calendar doesn't
 * reach back to the anchor's day, sessions in between are unknown, so the answer is null rather than a guess.
 */
export function estimateSession(
  event: { title: string; startAt: string },
  recordings: Array<{ title: string; day: Day }>,
  sessionStarts: string[],
): number | null {
  const own = sessionNumber(event.title);
  if (own != null) return own;
  const day = istDay(event.startAt);
  let anchor: { n: number; day: Day } | null = null;
  for (const r of recordings) {
    const n = sessionNumber(r.title);
    if (n == null || r.day >= day) continue;
    if (!anchor || n > anchor.n) anchor = { n, day: r.day };
  }
  if (!anchor) return null;
  const known = sessionStarts.map((s) => new Date(s).toISOString());
  const earliest = known.reduce<string | null>((a, s) => (a == null || s < a ? s : a), null);
  // The calendar must cover the day after the anchor, or sessions in between may be missing.
  if (!earliest || istDay(earliest) > addDays(anchor.day, 1)) return null;
  const after = new Set(known.filter((s) => istDay(s) > anchor!.day && s <= new Date(event.startAt).toISOString()));
  return after.size ? anchor.n + after.size : null;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Everything to prepare for one class (a MESA event). Null if the event doesn't exist or has no course. */
export async function classPrep(sql: Sql, eventId: string, now: Date): Promise<ClassPrep | null> {
  const [e] = await sql`
    select e.source_id, e.title, e.sort_at, e.data, e.course_id, c.title as course_title, c.data ->> 'shortName' as short
      from jarvis.lms_items e
      left join jarvis.lms_items c on c.kind = 'course' and c.source_id = e.course_id
     where e.kind = 'event' and e.source_id = ${eventId}`;
  if (!e) return null;
  const d = e.data as Record<string, unknown>;
  const event: PrepEvent = {
    id: String(e.source_id),
    title: String(e.title),
    course: str(e.course_title) ?? str(d.courseName),
    courseId: str(e.course_id),
    short: str(e.short),
    startAt: iso(e.sort_at) ?? String(d.startAt),
    endAt: str(d.endAt),
    room: str(d.room),
    meetingLink: str(d.meetingLink),
    status: str(d.status),
  };
  if (!event.courseId) return { event, session: null, match: "none", items: [], due: [], recording: null };

  const [recordings, sessions, materials, due] = await Promise.all([
    sql`
      select title, data ->> 'videoUrl' as url, coalesce(data ->> 'recordedOn', to_char(sort_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD')) as day
        from jarvis.lms_items where kind = 'recording' and course_id = ${event.courseId} and removed_at is null`,
    sql`
      select sort_at from jarvis.lms_items
       where kind = 'event' and course_id = ${event.courseId} and removed_at is null
         and data ->> 'eventType' = 'session' and coalesce(data ->> 'status', '') <> 'cancelled'`,
    sql`
      select m.source_id, m.content_hash, m.title, m.sort_at, m.data, x.sha256, x.text_status
        from jarvis.lms_items m
        left join jarvis.item_files f on f.kind = 'material' and f.item_id = m.source_id and f.status = 'done'
        left join jarvis.files x on x.sha256 = f.sha256
       where m.kind = 'material' and m.course_id = ${event.courseId} and m.removed_at is null
       order by m.sort_at desc nulls last`,
    sql`
      select source_id, title, sort_at from jarvis.lms_items
       where kind = 'assignment' and course_id = ${event.courseId} and removed_at is null
         and sort_at >= ${now.toISOString()} and sort_at <= ${new Date(Date.parse(event.startAt) + 86_400_000).toISOString()}
         and coalesce(data ->> 'submissionStatus', '') not like 'submitted%'
       order by sort_at`,
  ]);

  const session = estimateSession(
    event,
    recordings.filter((r) => r.day).map((r) => ({ title: String(r.title), day: String(r.day) })),
    sessions.map((s) => iso(s.sort_at)!).filter(Boolean),
  );

  const toItem = (m: (typeof materials)[number]): PrepItem => {
    const md = m.data as Record<string, unknown>;
    const folder = str(md.topicTitle);
    const kind: PrepItem["kind"] = md.kind === "link" ? "link" : md.kind === "text" ? "text" : "file";
    const fileText = !!m.sha256 && m.text_status === "done";
    const inlineText = kind === "text" && !!str(md.textContent);
    return {
      title: String(m.title),
      folder,
      kind,
      preRead: isPreRead(String(m.title), folder),
      fileId: str(m.sha256),
      url: kind === "link" ? str(md.url) : null,
      hasText: fileText || inlineText,
      noteKey: fileText ? `file:${m.sha256}` : inlineText ? `text:${m.source_id}:${m.content_hash}` : null,
      points: null,
    };
  };

  let match: PrepMatch = "none";
  let picked: Array<(typeof materials)[number]> = [];
  if (session != null) {
    picked = materials.filter((m) => sessionNumber(String(m.title)) === session);
    if (picked.length) match = "session";
  }
  if (!picked.length) {
    const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
    // Another session's numbered material (last week's deck) is never shown as new for this class.
    picked = materials.filter((m) => (iso(m.sort_at) ?? "") >= since && (session == null || sessionNumber(String(m.title)) == null)).slice(0, 6);
    if (picked.length) match = "recent";
  }
  const items = picked.map(toItem).sort((a, b) => Number(b.preRead) - Number(a.preRead));

  const rec = session != null ? recordings.find((r) => sessionNumber(String(r.title)) === session) : undefined;

  const keys = items.map((i) => i.noteKey).filter((k): k is string => !!k);
  if (keys.length) {
    const notes = await sql`select key, points from jarvis.prep_notes where key = any(${keys})`;
    const byKey = new Map(notes.map((n) => [String(n.key), (n.points as unknown[]).map(String)]));
    for (const i of items) if (i.noteKey) i.points = byKey.get(i.noteKey) ?? null;
  }

  return {
    event,
    session,
    match,
    items,
    due: due.map((a) => ({ id: String(a.source_id), title: String(a.title), dueAt: iso(a.sort_at)! })),
    recording: rec ? { title: String(rec.title), url: str(rec.url) } : null,
  };
}

/** MESA sessions (with a course, not cancelled) starting in [from, to). */
export async function sessionsBetween(sql: Sql, from: Date, to: Date): Promise<Array<{ id: string; startAt: string }>> {
  const rows = await sql`
    select source_id, sort_at from jarvis.lms_items
     where kind = 'event' and removed_at is null and course_id is not null
       and data ->> 'eventType' = 'session' and coalesce(data ->> 'status', '') <> 'cancelled'
       and sort_at >= ${from.toISOString()} and sort_at < ${to.toISOString()}
     order by sort_at`;
  return rows.map((r) => ({ id: String(r.source_id), startAt: iso(r.sort_at)! }));
}

/** The text a prep note is written from: extracted file text, or a text material's own body. */
export async function prepSourceText(sql: Sql, key: string): Promise<string | null> {
  const [kind, id] = key.split(":");
  if (kind === "file") {
    const [f] = await sql`select text_content from jarvis.files where sha256 = ${id ?? ""} and text_status = 'done'`;
    return str(f?.text_content);
  }
  if (kind === "text") {
    const [m] = await sql`select data ->> 'textContent' as t from jarvis.lms_items where kind = 'material' and source_id = ${id ?? ""}`;
    return str(m?.t);
  }
  return null;
}

export async function savePrepNote(sql: Sql, key: string, title: string, points: string[], model: string | null): Promise<void> {
  await sql`
    insert into jarvis.prep_notes (key, title, points, model) values (${key}, ${title}, ${sql.json(points)}, ${model})
    on conflict (key) do update set points = excluded.points, model = excluded.model, created_at = now()`;
}
