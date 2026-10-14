import * as db from "@jarvis/db";
import type { Attendance, Grade, NotificationDraft, Sql } from "@jarvis/db";
import { esc } from "@jarvis/notify";
import type { Logger } from "@jarvis/shared";

// MESA Nexus (the school's read-only MCP server): grades and attendance. The `nexus` job (every 30 min) copies them
// into jarvis.grades / jarvis.attendance and alerts on two things: marks newly released (with the written
// feedback), and a course's attendance dropping under the owner's threshold. Only read tools are ever called —
// never delete_notification. The token is a header, never part of a URL or an error message.

export const NEXUS_URL = "https://students.mesaschool.co.in/mcp";

export class NexusClient {
  private session: string | null = null;
  private id = 0;
  private ready = false;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly url = NEXUS_URL,
  ) {}

  private async rpc(method: string, params: Record<string, unknown>, notification = false): Promise<unknown> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++this.id }), method, params }),
      signal: AbortSignal.timeout(25_000),
    });
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    if (!res.ok) throw new Error(`Nexus HTTP ${res.status}${res.status === 401 || res.status === 403 ? " — the token was rejected or has expired" : ""}`);
    if (notification) return null;
    const text = await res.text();
    // The server may answer as plain JSON or as a server-sent event.
    const body = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() : text;
    const json = JSON.parse(body || "null") as { result?: unknown; error?: { message?: string } } | null;
    if (json?.error) throw new Error(`Nexus: ${(json.error.message ?? "error").slice(0, 160)}`);
    return json?.result;
  }

  /** Calls one tool and returns its JSON result. */
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.ready) {
      await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "jarvis", version: "1" } });
      await this.rpc("notifications/initialized", {}, true);
      this.ready = true;
    }
    const r = (await this.rpc("tools/call", { name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
    const text = (r?.content ?? []).map((c) => c.text ?? "").join("");
    if (r?.isError) throw new Error(`Nexus ${name} failed: ${text.slice(0, 160)}`);
    return JSON.parse(text) as T;
  }
}

interface RawGrade {
  assignmentId: string;
  assignment: string;
  course: string;
  marks: string | number | null;
  maxMarks: string | number | null;
  feedback: string | null;
  releasedAt: string | null;
}
interface RawAttendance {
  course: string;
  term?: string | null;
  attended: number;
  total: number;
  percentage: number;
}

const n = (v: string | number | null | undefined) => (v == null || v === "" ? null : Number(v));
/** "The Art of Selling with Prof. Rishabh Ladha" → "The Art of Selling". */
const shortCourse = (c: string) => c.replace(/\s+with\s+.*$/i, "");
const FEEDBACK_MAX = 700;

export function gradeAlert(g: Grade, now: Date): NotificationDraft {
  const fb = g.feedback ? `\n\n<b>Feedback</b>\n${esc(g.feedback.length > FEEDBACK_MAX ? `${g.feedback.slice(0, FEEDBACK_MAX).trimEnd()}…` : g.feedback)}` : "";
  return {
    dedupeKey: `grade.released:${g.assignmentId}`,
    priority: "high",
    text: `📊 <b>New marks</b> · ${esc(shortCourse(g.course))}\n${esc(g.assignment)}: <b>${db.fmtMarks(g)}</b>${fb}`,
    scheduledFor: now.toISOString(),
  };
}

export function attendanceAlert(a: Attendance, threshold: number, now: Date): NotificationDraft {
  const room = db.attendanceRoom(a, threshold);
  return {
    // One alert per change in the record: another missed class under the line alerts again.
    dedupeKey: `attendance.low:${a.course}:${a.attended}/${a.total}`,
    priority: "high",
    text: `⚠️ <b>Attendance: ${esc(shortCourse(a.course))}</b> is ${a.percentage}% (${a.attended} of ${a.total}), under your ${threshold}% line.\nAttend the next ${room.needToAttend} class${room.needToAttend === 1 ? "" : "es"} in a row to get back to ${threshold}%.`,
    scheduledFor: now.toISOString(),
  };
}

export interface NexusSummary {
  grades: number;
  newGrades: number;
  courses: number;
  attendanceAlerts: number;
  queued: number;
}

export async function runNexus(sql: Sql, token: string, now: Date, log?: Logger, fetchImpl: typeof fetch = fetch): Promise<NexusSummary> {
  const client = new NexusClient(token, fetchImpl);
  const [gradesRes, attRes] = await Promise.all([client.call<{ assignmentMarks?: RawGrade[] }>("get_grades"), client.call<{ courses?: RawAttendance[] }>("get_attendance_summary")]);

  const grades: Grade[] = (gradesRes.assignmentMarks ?? []).map((g) => ({ assignmentId: g.assignmentId, assignment: g.assignment, course: g.course, marks: n(g.marks), maxMarks: n(g.maxMarks), feedback: g.feedback ?? null, releasedAt: g.releasedAt ?? null }));
  const fresh = await db.upsertGrades(sql, grades);

  const threshold = await db.attendanceThreshold(sql);
  const attendance: Attendance[] = (attRes.courses ?? []).map((a) => ({ course: a.course, term: a.term ?? null, attended: a.attended, total: a.total, percentage: a.percentage }));
  const low = (await db.upsertAttendance(sql, attendance)).filter((a) => a.percentage < threshold);

  const drafts = [...fresh.map((g) => gradeAlert(g, now)), ...low.map((a) => attendanceAlert(a, threshold, now))];
  const queued = drafts.length ? await db.enqueueNotifications(sql, drafts) : 0;
  await db.markGradesAnnounced(sql, fresh.map((g) => g.assignmentId));
  if (drafts.length) log?.info("nexus alerts", { newGrades: fresh.length, attendance: low.length });
  return { grades: grades.length, newGrades: fresh.length, courses: attendance.length, attendanceAlerts: low.length, queued };
}
