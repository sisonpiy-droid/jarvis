import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";

// A full Phase 5 world for the brief tests (the same one as packages/db/test/brief-facts.test.ts): professional
// and personal tasks, a MESA assignment with its project and Submit task, an assignment with no task, an exam
// with its prep task, today's class and a cancelled one, an all-day entry, a personal interview, habits, an
// at-risk and a quiet goal, and an overdue task. Built for NOW = 2026-10-01T02:35Z (Thu 1 Oct, 08:05 IST).

export const BRIEF_NOW = new Date("2026-10-01T02:35:00.000Z");

/** Everything the brief reads (and the briefs table itself). */
export const truncateBriefWorld = (sql: Sql) =>
  sql`truncate jarvis.briefs, jarvis.notifications, jarvis.notification_deliveries, jarvis.activities, jarvis.habits, jarvis.goals,
      jarvis.tasks, jarvis.projects, jarvis.lms_items, jarvis.integrations restart identity cascade`;

export async function seedBriefWorld(sql: Sql, o: { lastSuccessAt?: string | null } = {}) {
  const now = BRIEF_NOW;
  const item = (kind: string, sourceId: string, title: string, sortAt: string, data: Record<string, unknown>) =>
    sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title, sort_at)
        values (${kind}, ${sourceId}, 'h', ${sql.json({ title, ...data } as never)}, ${title}, ${sortAt})`;
  const event = (sourceId: string, title: string, startAt: string, endAt: string | null, data: Record<string, unknown> = {}) =>
    item("event", sourceId, title, startAt, { startAt, endAt, status: "scheduled", eventType: "class", courseName: title, ...data });
  const gcal = (sourceId: string, title: string, startAt: string, endAt: string, data: Record<string, unknown> = {}) =>
    item("gcal_event", sourceId, title, startAt, { source: "gcal", startAt, endAt, allDay: false, status: "confirmed", eventType: "personal", ...data });
  const assignment = (sourceId: string, title: string, dueAt: string, submissionStatus = "not_submitted") =>
    item("assignment", sourceId, title, dueAt, { dueAt, submissionStatus, courseTitle: "Marketing" });

  const spinny = await db.createTask(sql, { title: "Finish Spinny presentation", priority: 1, due: "2026-10-01T18:00:00+05:30" });
  const recruiter = await db.createTask(sql, { title: "Send recruiter follow-up", priority: 2, due: "2026-09-30T10:00:00+05:30" });
  const callHome = await db.createTask(sql, { title: "Call home", domain: "personal", priority: 2, due: "2026-10-01" });
  const side = await db.createProject(sql, { title: "Side project", kind: "startup", deadline: "2026-10-06" });
  await db.createTask(sql, { title: "Pick a name", projectId: side.id, priority: 2, due: "2026-10-04" });

  const [mp] = await sql`
    insert into jarvis.projects (title, kind, source, source_ref, deadline, priority)
    values ('Framework Case', 'mesa_assignment', 'mesa', 'assignment:A1', '2026-10-02T18:29:00Z', 1) returning id`;
  const [submit] = await sql`
    insert into jarvis.tasks (title, project_id, priority, due_at, is_next_action, source, source_ref)
    values ('Submit Framework Case', ${mp!.id}, 1, '2026-10-02T18:29:00Z', true, 'mesa', 'mesa:submit:A1') returning id`;
  await assignment("A1", "Framework Case", "2026-10-02T18:29:00.000Z");
  await assignment("A2", "Brand audit reflection", "2026-10-03T18:29:00.000Z");

  const [ep] = await sql`
    insert into jarvis.projects (title, kind, source, source_ref, deadline, priority)
    values ('Marketing mid-term', 'exam', 'mesa', 'exam:E1', '2026-10-05T04:00:00Z', 1) returning id`;
  await sql`
    insert into jarvis.tasks (title, project_id, priority, due_at, is_next_action, source, source_ref)
    values ('Prepare for Marketing mid-term', ${ep!.id}, 1, '2026-10-05T04:00:00Z', true, 'mesa', 'mesa:prep:E1')`;
  await event("E1", "Marketing mid-term", "2026-10-05T04:00:00.000Z", "2026-10-05T06:00:00.000Z", { eventType: "exam" });

  await event("C1", "Strategy", "2026-10-01T04:30:00.000Z", "2026-10-01T06:00:00.000Z", { room: "R1" });
  await event("C2", "Economics", "2026-10-01T08:30:00.000Z", "2026-10-01T10:00:00.000Z", { status: "cancelled" });
  await gcal("G2", "Dussehra", "2026-09-30T18:30:00.000Z", "2026-10-01T18:30:00.000Z", { allDay: true });
  await event("C3", "Strategy", "2026-10-02T04:30:00.000Z", "2026-10-02T06:00:00.000Z");
  await gcal("G1", "Interview", "2026-10-03T08:30:00.000Z", "2026-10-03T09:30:00.000Z");

  const read = await db.createHabit(sql, { name: "Read 30 minutes", startDate: "2026-09-20" }, now);
  const workout = await db.createGoal(sql, { title: "Workout", targetValue: 4, period: "week", startDate: "2026-09-01" }, now);
  const gym = await db.createHabit(sql, { name: "Workout", goalId: workout.id, schedule: { freq: "weekly", times: 4 }, startDate: "2026-09-01" }, now);
  for (const day of ["2026-09-28", "2026-09-29"]) await db.logHabit(sql, gym.id, { day }, now);
  const reading = await db.createGoal(sql, { title: "Reading", targetValue: 10, unit: "chapters", period: "week", startDate: "2026-09-01" }, now);
  await db.logGoal(sql, reading.id, { value: 4, day: "2026-09-29" }, now);
  const journal = await db.createGoal(sql, { title: "Journal", targetValue: 4, period: "month", startDate: "2026-08-01" }, now);
  await db.logGoal(sql, journal.id, { day: "2026-09-10" }, now);

  const last = o.lastSuccessAt === undefined ? "2026-10-01T02:30:00Z" : o.lastSuccessAt;
  await sql`insert into jarvis.integrations (provider, status, session_expires_at, last_success_at) values ('mesa', 'active', '2026-10-04T04:30:00Z', ${last})`;

  return { spinny, recruiter, callHome, side, submitId: Number(submit!.id), read, reading, journal };
}
