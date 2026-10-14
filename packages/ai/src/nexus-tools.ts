import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { Tool } from "./agent";

// Chat tools over the grades and attendance the `nexus` job copied from MESA Nexus. Read from the database, so they
// answer instantly and never need the Nexus token at chat time.

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const short = (c: string) => c.replace(/\s+with\s+.*$/i, "");

export function nexusTools(sql: Sql, now: () => Date = () => new Date()): Tool[] {
  return [
    {
      name: "get_grades",
      effect: "read",
      description: "The owner's released marks, newest first, with the instructor's written feedback. Optionally for one course (words from its name). Use for 'how are my grades?', 'what did I get in Finance?', 'why did I lose marks?'.",
      parameters: obj({ course: { type: "string", description: "Words from the course name" } }),
      async run(a) {
        const grades = await db.listGrades(sql, typeof a.course === "string" && a.course.trim() ? a.course.trim() : undefined);
        if (!grades.length) return { grades: [], note: "No marks are released yet, or the Nexus sync hasn't run." };
        return {
          grades: grades.map((g) => ({
            assignment: g.assignment,
            course: short(g.course),
            marks: g.marks,
            out_of: g.maxMarks,
            percent: g.marks != null && g.maxMarks ? Math.round((g.marks / g.maxMarks) * 100) : null,
            feedback: g.feedback,
            released: g.releasedAt,
          })),
          note: "A null out_of means MESA published no maximum — don't invent one. Quote feedback faithfully.",
        };
      },
    },
    {
      name: "get_attendance",
      effect: "read",
      description: "Attendance per course (attended / total, percentage), the owner's alert threshold, and for each course how many more classes can be missed while staying at or above it, or how many must be attended in a row to get back. Use for 'what's my attendance?', 'can I skip tomorrow's class?'.",
      parameters: obj({}),
      async run() {
        const [rows, threshold] = await Promise.all([db.listAttendance(sql), db.attendanceThreshold(sql)]);
        if (!rows.length) return { courses: [], note: "No attendance yet — the Nexus sync hasn't run." };
        return {
          threshold_percent: threshold,
          courses: rows.map((a) => {
            const room = db.attendanceRoom(a, threshold);
            return { course: short(a.course), attended: a.attended, total: a.total, percent: a.percentage, status: a.percentage < threshold ? "below" : "ok", can_still_miss: room.canMiss, must_attend_in_a_row: room.needToAttend };
          }),
          note: "The counts assume every remaining class counts toward attendance; MESA's own policy line may differ from the owner's threshold.",
          as_of: now().toISOString(),
        };
      },
    },
    {
      name: "set_attendance_threshold",
      effect: "write-local",
      description: "Change the attendance percentage under which JARVIS sends a warning (default 85). Only when the owner asks.",
      parameters: obj({ percent: { type: "integer", description: "1–100" } }, ["percent"]),
      async run(a) {
        const p = Number(a.percent);
        if (!Number.isFinite(p) || p < 1 || p > 100) throw new Error("percent must be between 1 and 100");
        return { threshold_percent: await db.setAttendanceThreshold(sql, p) };
      },
    },
  ];
}
