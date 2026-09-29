import { contentHash } from "@jarvis/shared";
import { eventsBetween, type CalendarInstance } from "./ics";

export * from "./ics";

/** A Google Calendar occurrence, shaped like an LMS event so schedules can mix both. */
export interface GcalEvent {
  source: "gcal";
  sourceId: string;
  title: string;
  eventType: "personal";
  courseName: null;
  instructor: null;
  startAt: string;
  endAt: string;
  startAtIst: string;
  allDay: boolean;
  room: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  recurring: boolean;
  contentHash: string;
}

const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
const IST_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });

export function normalizeInstance(i: CalendarInstance): GcalEvent {
  const fields = {
    title: i.title,
    startAt: new Date(i.startMs).toISOString(),
    endAt: new Date(i.endMs).toISOString(),
    allDay: i.allDay,
    room: i.location,
    description: i.description,
    status: i.status,
  };
  return {
    source: "gcal",
    sourceId: i.instanceId,
    eventType: "personal",
    courseName: null,
    instructor: null,
    ...fields,
    startAtIst: i.allDay ? `${IST_DAY.format(new Date(i.startMs))} (all day)` : IST.format(new Date(i.startMs)),
    recurring: i.recurring,
    contentHash: contentHash(fields),
  };
}

export interface CalendarRead {
  events: GcalEvent[];
  window: { from: string; to: string };
}

/** Fetches the private iCal feed and returns occurrences in [now - pastDays, now + futureDays]. */
export async function readCalendar(icsUrl: string, now: Date, opts: { pastDays?: number; futureDays?: number; fetch?: typeof fetch } = {}): Promise<CalendarRead> {
  const from = now.getTime() - (opts.pastDays ?? 1) * 86_400_000;
  const to = now.getTime() + (opts.futureDays ?? 30) * 86_400_000;
  const res = await (opts.fetch ?? fetch)(icsUrl, { headers: { Accept: "text/calendar" } });
  // Never echo the URL: it is a secret.
  if (!res.ok) throw new Error(`Calendar feed HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith("BEGIN:VCALENDAR")) throw new Error("Calendar feed did not return iCalendar data");
  return { events: eventsBetween(text, from, to).map(normalizeInstance), window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
}
export * from "./feed";
