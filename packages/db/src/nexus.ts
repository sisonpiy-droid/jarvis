import type { Sql } from "./client";
import { getSetting, putSetting } from "./notifications";

// Grades and attendance copied from MESA Nexus (migration 0027). Reads for chat, writes for the `nexus` job.

export interface Grade {
  assignmentId: string;
  assignment: string;
  course: string;
  marks: number | null;
  maxMarks: number | null;
  feedback: string | null;
  releasedAt: string | null;
}

export interface Attendance {
  course: string;
  term: string | null;
  attended: number;
  total: number;
  percentage: number;
}

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

const toGrade = (r: Record<string, unknown>): Grade => ({
  assignmentId: String(r.assignment_id),
  assignment: String(r.assignment),
  course: String(r.course),
  marks: num(r.marks),
  maxMarks: num(r.max_marks),
  feedback: (r.feedback as string | null) ?? null,
  releasedAt: iso(r.released_at),
});

/**
 * Stores the grades Nexus returned. Returns the ones never seen before. On the very first sync (empty table) they are
 * all stored as already announced, so connecting doesn't produce a flood of "new marks" alerts.
 */
export async function upsertGrades(sql: Sql, grades: Grade[]): Promise<Grade[]> {
  const [{ n }] = (await sql`select count(*)::int as n from jarvis.grades`) as unknown as [{ n: number }];
  const baseline = n === 0;
  const fresh: Grade[] = [];
  for (const g of grades) {
    const rows = await sql`
      insert into jarvis.grades (assignment_id, assignment, course, marks, max_marks, feedback, released_at, notified_at)
      values (${g.assignmentId}, ${g.assignment}, ${g.course}, ${g.marks}, ${g.maxMarks}, ${g.feedback}, ${g.releasedAt}, ${baseline ? new Date().toISOString() : null})
      on conflict (assignment_id) do update set marks = excluded.marks, max_marks = excluded.max_marks, feedback = excluded.feedback, released_at = excluded.released_at
      returning (xmax = 0) as inserted`;
    if (rows[0]?.inserted && !baseline) fresh.push(g);
  }
  return fresh;
}

export async function markGradesAnnounced(sql: Sql, ids: string[]): Promise<void> {
  if (ids.length) await sql`update jarvis.grades set notified_at = now() where assignment_id = any(${ids})`;
}

/** Newest first; optionally one course (words from its name). */
export async function listGrades(sql: Sql, course?: string): Promise<Grade[]> {
  const rows = course
    ? await sql`select * from jarvis.grades where course ilike ${`%${course}%`} order by released_at desc nulls last`
    : await sql`select * from jarvis.grades order by released_at desc nulls last`;
  return rows.map(toGrade);
}

/**
 * Stores attendance. Returns each course whose percentage went DOWN since the last sync (a class was missed) or that
 * is new, with the previous percentage (null when new) — the job decides which of them are worth an alert.
 */
export async function upsertAttendance(sql: Sql, rows: Attendance[]): Promise<Array<Attendance & { previous: number | null }>> {
  const changed: Array<Attendance & { previous: number | null }> = [];
  for (const a of rows) {
    const [prev] = await sql`select percentage from jarvis.attendance where course = ${a.course}`;
    const before = prev ? Number(prev.percentage) : null;
    await sql`
      insert into jarvis.attendance (course, term, attended, total, percentage) values (${a.course}, ${a.term}, ${a.attended}, ${a.total}, ${a.percentage})
      on conflict (course) do update set term = excluded.term, attended = excluded.attended, total = excluded.total, percentage = excluded.percentage, updated_at = now()`;
    if (before == null || a.percentage < before) changed.push({ ...a, previous: before });
  }
  return changed;
}

export async function listAttendance(sql: Sql): Promise<Attendance[]> {
  return (await sql`select * from jarvis.attendance order by percentage, course`).map((r) => ({ course: String(r.course), term: (r.term as string | null) ?? null, attended: Number(r.attended), total: Number(r.total), percentage: Number(r.percentage) }));
}

export const ATTENDANCE_THRESHOLD_KEY = "attendance.threshold";
export const DEFAULT_ATTENDANCE_THRESHOLD = 85;

export async function attendanceThreshold(sql: Sql): Promise<number> {
  const v = await getSetting<number>(sql, ATTENDANCE_THRESHOLD_KEY).catch(() => null);
  return typeof v === "number" && v >= 1 && v <= 100 ? v : DEFAULT_ATTENDANCE_THRESHOLD;
}

export async function setAttendanceThreshold(sql: Sql, percent: number): Promise<number> {
  const p = Math.max(1, Math.min(100, Math.round(percent)));
  await putSetting(sql, ATTENDANCE_THRESHOLD_KEY, p);
  return p;
}

/**
 * Where a course stands against the threshold: `canMiss` more classes and still be at or above it (0 if exactly
 * there), or `needToAttend` classes in a row to climb back to it when below. Assumes every remaining class counts.
 */
export function attendanceRoom(a: Pick<Attendance, "attended" | "total">, thresholdPercent: number): { canMiss: number; needToAttend: number } {
  const t = thresholdPercent / 100;
  if (a.total === 0) return { canMiss: 0, needToAttend: 0 };
  // Missing m more classes keeps attended/(total+m) >= t  →  m <= attended/t - total.
  const canMiss = Math.floor(a.attended / t - a.total + 1e-9);
  if (canMiss >= 0) return { canMiss, needToAttend: 0 };
  // Attending k more in a row reaches (attended+k)/(total+k) >= t  →  k >= (t*total - attended)/(1-t).
  return { canMiss: 0, needToAttend: t >= 1 ? 0 : Math.ceil((t * a.total - a.attended) / (1 - t) - 1e-9) };
}

export const fmtMarks = (g: Pick<Grade, "marks" | "maxMarks">) => `${g.marks ?? "—"}${g.maxMarks != null ? `/${g.maxMarks}` : ""}`;
