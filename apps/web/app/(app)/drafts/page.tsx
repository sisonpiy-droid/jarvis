import Link from "next/link";
import { summarize } from "@jarvis/assist";
import { db } from "@/lib/db";
import { fmtDateTime, isSubmitted, relative, shortCourse } from "@/lib/format";
import { Badge, Empty, Section, StatusBadge } from "../ui";
import { ReviseBox } from "./[id]/redraft-button";

export default async function DraftsPage() {
  const rows = await db()`
    select distinct on (d.assignment_id)
           d.id, d.status, d.trigger, d.created_at, d.summary, d.error, d.assignment_id, d.questions,
           i.title, i.data ->> 'courseTitle' as course, i.data ->> 'dueAt' as due_at, i.data ->> 'submissionStatus' as sub,
           (select string_agg(kind, ',' order by kind) from jarvis.draft_files f where f.draft_id = d.id) as kinds
      from jarvis.drafts d join jarvis.lms_items i on i.kind = 'assignment' and i.source_id = d.assignment_id
     order by d.assignment_id, (d.status = 'done') desc, d.id desc`;
  const [pending] = await db()`
    select count(*)::int as n from jarvis.lms_items i
     where i.kind = 'assignment' and i.removed_at is null
       and i.data ->> 'submissionStatus' not in ('submitted', 'submitted_late')
       and (i.sort_at is null or i.sort_at > now())
       and not exists (select 1 from jarvis.drafts d where d.assignment_id = i.source_id and d.status = 'done')`;
  const drafts = rows
    .map((r) => ({
      id: Number(r.id),
      status: r.status as string,
      at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      summary: r.summary as string | null,
      error: r.error as string | null,
      assignmentId: String(r.assignment_id),
      title: String(r.title),
      course: r.course as string | null,
      dueAt: r.due_at as string | null,
      sub: String(r.sub),
      kinds: String(r.kinds ?? "docx").split(","),
      questions: (r.questions as Array<{ question: string }> | null) ?? [],
    }))
    // Open work first, soonest deadline first, undated last (plain string order: ISO dates sort correctly).
    .sort((a, b) => (isSubmitted(a.sub) ? 1 : 0) - (isSubmitted(b.sub) ? 1 : 0) || ((a.dueAt ?? "9999") < (b.dueAt ?? "9999") ? -1 : (a.dueAt ?? "9999") > (b.dueAt ?? "9999") ? 1 : 0));

  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Drafts</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        JARVIS completes every open assignment — a document, plus a filled workbook and slides when the assignment needs them.{" "}
        {(pending?.n ?? 0) > 0 ? `${pending!.n} still in the queue.` : "All open assignments have a draft."}
      </p>
      <Section title={`All drafts (${drafts.length})`}>
        {drafts.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {drafts.map((d) => (
              <li key={d.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {d.status === "done" ? (
                    <Link href={`/drafts/${d.id}`} className="font-medium text-[var(--color-ink)] no-underline hover:underline">
                      {d.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{d.title}</span>
                  )}
                  <StatusBadge status={d.sub} dueAt={d.dueAt} />
                  {d.status === "done" && d.kinds.includes("xlsx") && <Badge tone="good">📊 workbook</Badge>}
                  {d.status === "done" && d.kinds.includes("pptx") && <Badge tone="good">📽️ slides</Badge>}
                  {d.status !== "done" && (
                    <Badge tone={d.status === "failed" ? "bad" : "warn"}>{d.status === "failed" ? "draft failed" : d.status === "needs_input" ? "❓ needs your input" : "drafting…"}</Badge>
                  )}
                </div>
                <div className="mt-0.5 text-sm text-[var(--color-muted)]">
                  {shortCourse(d.course)} · due {fmtDateTime(d.dueAt)} {d.dueAt ? `(${relative(d.dueAt)})` : ""} · drafted {relative(d.at)}
                </div>
                {d.summary && <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-sm">{summarize(d.summary, 500).replace(/^1\.\s*What's being asked\s*/i, "")}</p>}
                {d.error && <p className="mt-1 text-sm text-[var(--color-bad)]">{d.error}</p>}
                {d.status === "needs_input" && (
                  <>
                    <ul className="mt-1.5 list-disc pl-5 text-sm">
                      {d.questions.map((q, i) => (
                        <li key={i}>{q.question}</li>
                      ))}
                    </ul>
                    <ReviseBox assignmentId={d.assignmentId} placeholder="Answer here, e.g. Our assigned startup is …" />
                  </>
                )}
                {d.status === "done" && (
                  <div className="mt-2 flex gap-4 text-sm">
                    <Link href={`/drafts/${d.id}`}>Read draft</Link>
                    <Link href={`/drafts/${d.id}`}>Downloads</Link>
                    <Link href={`/assignments/${d.assignmentId}`}>Assignment</Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No drafts yet — the first ones arrive within minutes.</Empty>
        )}
      </Section>
    </main>
  );
}
