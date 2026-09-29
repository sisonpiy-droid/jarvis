// Writes an iCalendar (RFC 5545) feed of LMS classes that Google Calendar can subscribe to.

export interface FeedEvent {
  sourceId: string;
  title: string;
  startAt: string;
  endAt: string | null;
  courseName?: string | null;
  instructor?: string | null;
  eventType?: string | null;
  status?: string | null;
  room?: string | null;
  meetingLink?: string | null;
  descriptionText?: string | null;
  attendanceRequired?: boolean;
  updatedAt?: string | null;
}

const HOUR = 3_600_000;

/** 20260929T083000Z */
const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Fold lines longer than 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const cancelled = (s: string | null | undefined) => !!s && /cancel/i.test(s);

export function buildClassFeed(events: FeedEvent[], opts: { name?: string; now?: Date } = {}): string {
  const now = stamp((opts.now ?? new Date()).toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JARVIS//MESA classes//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(opts.name ?? "MESA classes")}`,
    "X-WR-TIMEZONE:Asia/Kolkata",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of events) {
    const start = new Date(e.startAt);
    if (Number.isNaN(start.getTime())) continue;
    const end = e.endAt && new Date(e.endAt) > start ? e.endAt : new Date(start.getTime() + HOUR).toISOString();
    const title = e.title;
    const desc = [
      e.courseName && `Course: ${e.courseName}`,
      e.instructor && `Instructor: ${e.instructor}`,
      e.eventType && `Type: ${e.eventType}`,
      e.attendanceRequired && "Attendance required",
      e.meetingLink && `Join: ${e.meetingLink}`,
      e.descriptionText,
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:mesa-event-${e.sourceId}@jarvis`,
      `DTSTAMP:${now}`,
      ...(e.updatedAt ? [`LAST-MODIFIED:${stamp(e.updatedAt)}`] : []),
      `DTSTART:${stamp(start.toISOString())}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${icsText((cancelled(e.status) ? "[Cancelled] " : "") + title)}`,
      ...(desc ? [`DESCRIPTION:${icsText(desc)}`] : []),
      ...(e.room || e.meetingLink ? [`LOCATION:${icsText(e.room || e.meetingLink!)}`] : []),
      ...(e.meetingLink ? [`URL:${e.meetingLink}`] : []),
      `STATUS:${cancelled(e.status) ? "CANCELLED" : "CONFIRMED"}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
