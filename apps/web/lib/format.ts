// Display helpers (IST everywhere). Safe for server and client.

const IST = "Asia/Kolkata";

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) : "—";

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) : "—";

export const fmtDay = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso)) : "—";

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const h = 3_600_000;
  const t = abs < h ? `${Math.max(1, Math.round(abs / 60_000))} min` : abs < 48 * h ? `${Math.round(abs / h)} h` : `${Math.round(abs / (24 * h))} days`;
  return ms >= 0 ? `in ${t}` : `${t} ago`;
}

export const shortCourse = (c: string | null | undefined) => (c ? c.replace(/\s+with\s+.*$/i, "") : "General");

export const isSubmitted = (status: string) => status.startsWith("submitted");

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const EVENT_LABEL: Record<string, string> = {
  "assignment.created": "New assignment",
  "assignment.updated": "Assignment updated",
  "assignment.deadline_changed": "Deadline changed",
  "assignment.material_added": "File added to assignment",
  "assignment.submission_changed": "Submission status changed",
  "assignment.removed": "Assignment removed",
  "class.created": "Class added",
  "class.rescheduled": "Class rescheduled",
  "class.cancelled": "Class cancelled",
  "class.updated": "Class details changed",
  "class.removed": "Class removed",
  "announcement.created": "Announcement",
  "material.added": "New material",
  "material.updated": "Material updated",
  "recording.added": "New recording",
  "course.created": "New course",
};
