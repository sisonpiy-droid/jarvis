import type { NotificationDraft, Sql } from "@jarvis/db";
import { esc } from "@jarvis/notify";
import { istHour, relative } from "./time";

// The 8 am daily brief. Built from the database *after* the sync, so it is
// current; queued by whichever run first passes 08:00 IST (dedupe key = date),
// so a missed run just means it arrives a few minutes later.

const IST_OFFSET_MS = 330 * 60_000;
export const BRIEF_HOUR = 8;

/** Start and end (UTC ISO) of the IST calendar day containing `now`, plus its label. */
export function istDay(now: Date) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
  return {
    key: ist.toISOString().slice(0, 10),
    start: start.toISOString(),
    end: new Date(start.getTime() + 86_400_000).toISOString(),
    label: new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" }).format(now),
  };
}

const time = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));

export interface BriefData {
  classes: Array<{ title: string; course: string | null; startAt: string; room: string | null; status: string | null }>;
  due: Array<{ title: string; course: string | null; dueAt: string; dueIst: string | null }>;
  newSince: { announcements: number; materials: number; recordings: number; assignments: number };
  sessionExpiresAt: string | null;
}

export function renderBrief(d: BriefData, now: Date): string {
  const day = istDay(now);
  const short = (c: string | null) => (c ? c.replace(/\s+with\s+.*$/i, "") : null);
  const lines = [`☀️ <b>Good morning — ${esc(day.label)}</b>`, ""];
  const live = d.classes.filter((c) => c.status !== "cancelled");
  lines.push(live.length ? `🏫 <b>Today's classes (${live.length})</b>` : "🏫 No classes today.");
  for (const c of live) lines.push(`• ${time(c.startAt)} — ${esc(short(c.course) ?? c.title)}${c.course && c.title !== c.course ? `: ${esc(c.title)}` : ""}${c.room ? ` <i>(${esc(c.room)})</i>` : ""}`);
  const cancelled = d.classes.filter((c) => c.status === "cancelled");
  if (cancelled.length) lines.push(`❌ Cancelled: ${cancelled.map((c) => esc(c.title)).join(", ")}`);
  lines.push("");
  if (d.due.length) {
    lines.push(`📌 <b>Due in the next 3 days, not submitted (${d.due.length})</b>`);
    for (const a of d.due) lines.push(`• ${esc(a.dueIst ?? "")} (${relative(a.dueAt, now)}) — ${esc(a.title)}${a.course ? ` <i>(${esc(short(a.course))})</i>` : ""}`);
  } else lines.push("📌 Nothing unsubmitted is due in the next 3 days. ✅");
  const n = d.newSince;
  const bits = [
    n.assignments && `${n.assignments} assignment${n.assignments > 1 ? "s" : ""}`,
    n.announcements && `${n.announcements} announcement${n.announcements > 1 ? "s" : ""}`,
    n.materials && `${n.materials} material${n.materials > 1 ? "s" : ""}`,
    n.recordings && `${n.recordings} recording${n.recordings > 1 ? "s" : ""}`,
  ].filter(Boolean);
  if (bits.length) lines.push("", `🆕 Since yesterday: ${bits.join(", ")}`);
  if (d.sessionExpiresAt && Date.parse(d.sessionExpiresAt) - now.getTime() < 5 * 86_400_000) {
    lines.push("", `🔑 MESA sign-in expires ${relative(d.sessionExpiresAt, now)} — run <code>npm run mesa:login</code> soon.`);
  }
  return lines.join("\n");
}

export async function loadBriefData(sql: Sql, now: Date): Promise<BriefData> {
  const day = istDay(now);
  const nowIso = now.toISOString();
  const in72h = new Date(now.getTime() + 72 * 3_600_000).toISOString();
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const classes = await sql`
    select title, data ->> 'courseName' as course, data ->> 'startAt' as start_at, data ->> 'room' as room, data ->> 'status' as status
      from jarvis.lms_items
     where kind = 'event' and removed_at is null and sort_at >= ${day.start} and sort_at < ${day.end}
     order by sort_at`;
  const due = await sql`
    select title, data ->> 'courseTitle' as course, data ->> 'dueAt' as due_at, data ->> 'dueAtIst' as due_ist
      from jarvis.lms_items
     where kind = 'assignment' and removed_at is null and sort_at > ${nowIso} and sort_at <= ${in72h}
       and data ->> 'submissionStatus' not in ('submitted', 'submitted_late')
     order by sort_at`;
  const counts = await sql`
    select kind, count(*)::int as n from jarvis.lms_items
     where first_seen_at >= ${since} and kind in ('announcement', 'material', 'recording', 'assignment')
       and first_seen_at > (select min(first_seen_at) + interval '1 hour' from jarvis.lms_items)  -- exclude the initial import
     group by kind`;
  const c = Object.fromEntries(counts.map((r) => [r.kind as string, r.n as number]));
  const [integ] = await sql`select session_expires_at from jarvis.integrations where provider = 'mesa'`;
  return {
    classes: classes.map((r) => ({ title: r.title, course: r.course, startAt: r.start_at, room: r.room, status: r.status })),
    due: due.map((r) => ({ title: r.title, course: r.course, dueAt: r.due_at, dueIst: r.due_ist })),
    newSince: { announcements: c.announcement ?? 0, materials: c.material ?? 0, recordings: c.recording ?? 0, assignments: c.assignment ?? 0 },
    sessionExpiresAt: integ?.session_expires_at ? new Date(integ.session_expires_at).toISOString() : null,
  };
}

/** Today's brief as a notification draft, or null if it's before 08:00 IST. */
export async function morningBrief(sql: Sql, now: Date): Promise<NotificationDraft | null> {
  if (istHour(now) < BRIEF_HOUR) return null;
  const day = istDay(now);
  return { dedupeKey: `brief:${day.key}`, priority: "normal", text: renderBrief(await loadBriefData(sql, now), now), scheduledFor: now.toISOString() };
}
