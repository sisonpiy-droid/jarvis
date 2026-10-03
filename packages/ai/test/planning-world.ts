import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import { seedBriefWorld, truncateBriefWorld } from "../../sync/test/brief-world";
import { saveMemory } from "../src/memory";

// The brief's fixture world (packages/sync/test/brief-world.ts) plus what the chief-of-staff tools look at beyond
// it: done work this week, last week and a MESA submission, a P3 task that could wait, a task waiting on someone,
// an unsubmitted assignment due tomorrow, a note about a person and people / questions on a project.
// Built for Thu 1 Oct 2026 (NOW 03:30Z or 02:35Z both work).

export const truncatePlanningWorld = async (sql: Sql) => {
  await truncateBriefWorld(sql);
  await sql`truncate jarvis.memories, jarvis.project_items, jarvis.chat_messages restart identity cascade`;
};

export async function seedPlanningWorld(sql: Sql) {
  const w = await seedBriefWorld(sql);
  const tidy = await db.createTask(sql, { title: "Tidy the reading list", priority: 3 });
  const waiting = await db.createTask(sql, { title: "Slides from Riya", status: "waiting", due: "2026-10-03" });
  const [doneThisWeek] = await sql`insert into jarvis.tasks (title, status, completed_at) values ('Book the venue', 'done', '2026-09-29T06:00:00Z') returning id`;
  const [doneLastWeek] = await sql`insert into jarvis.tasks (title, status, completed_at) values ('Renew the gym pass', 'done', '2026-09-24T06:00:00Z') returning id`;
  const [submitted] = await sql`
    insert into jarvis.tasks (title, status, completed_at, source, source_ref)
    values ('Submit Ethics essay', 'done', '2026-09-30T12:00:00Z', 'mesa', 'mesa:submit:A0') returning id`;
  await sql`
    insert into jarvis.lms_items (kind, source_id, content_hash, data, title, sort_at)
    values ('assignment', 'A9', 'h', ${sql.json({ title: "Quiz reflection", dueAt: "2026-10-02T10:00:00.000Z", submissionStatus: "not_submitted", courseTitle: "Strategy" } as never)},
            'Quiz reflection', '2026-10-02T10:00:00.000Z')`;
  const riya = await saveMemory(sql, { kind: "fact", content: "Riya prefers WhatsApp over email", scope: "person", subjectId: "riya", subjectLabel: "Riya" });
  const person = await db.addProjectItem(sql, w.side.id, { kind: "person", body: "Asha helps with the design" });
  const question = await db.addProjectItem(sql, w.side.id, { kind: "question", body: "Which domain do we buy?" });
  const resolved = await db.addProjectItem(sql, w.side.id, { kind: "question", body: "Old question" });
  await db.setProjectItemResolved(sql, resolved.id, true);
  return {
    ...w,
    tidy,
    waiting,
    doneThisWeek: Number(doneThisWeek!.id),
    doneLastWeek: Number(doneLastWeek!.id),
    submitted: Number(submitted!.id),
    riyaNote: riya.id!,
    person,
    question,
  };
}
