import type { Sql } from "@jarvis/db";
import type { MesaClient } from "@jarvis/mesa";

// When each assignment was really submitted, and its grade: the LMS list says only "submitted" / "submitted late",
// so this reads /assignments/{id}/submissions (read-only GET) once per submitted assignment, a few per sync, until
// every one is known. A re-submission (status changed) is read again. Feeds the owner's work patterns.

export const SUBMISSIONS_PER_RUN = 5;

type Raw = { data?: { submission?: { status?: unknown; submittedAt?: unknown; grade?: unknown } | null } };

export async function fetchSubmissionTimes(sql: Sql, client: Pick<MesaClient, "get">, max = SUBMISSIONS_PER_RUN): Promise<{ fetched: number; pending: number }> {
  const todo = await sql`
    select i.source_id, i.data ->> 'submissionStatus' as status
      from jarvis.lms_items i
      left join jarvis.submissions s on s.assignment_id = i.source_id
     where i.kind = 'assignment' and i.removed_at is null and i.data ->> 'submissionStatus' like 'submitted%'
       and (s.assignment_id is null or s.status is distinct from i.data ->> 'submissionStatus')
     order by i.sort_at desc nulls last`;
  let fetched = 0;
  for (const t of todo.slice(0, max)) {
    const id = String(t.source_id);
    const r = await client.get<Raw>(`/assignments/${encodeURIComponent(id)}/submissions`);
    const sub = r?.data?.submission ?? null;
    const at = typeof sub?.submittedAt === "string" && !Number.isNaN(Date.parse(sub.submittedAt)) ? new Date(sub.submittedAt).toISOString() : null;
    const grade = sub?.grade == null ? null : sub.grade;
    await sql`
      insert into jarvis.submissions (assignment_id, status, submitted_at, grade)
      values (${id}, ${String(t.status)}, ${at}, ${grade == null ? null : sql.json(grade as never)})
      on conflict (assignment_id) do update set status = excluded.status, submitted_at = excluded.submitted_at, grade = excluded.grade, fetched_at = now()`;
    fetched++;
  }
  return { fetched, pending: Math.max(0, todo.length - fetched) };
}
