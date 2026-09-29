import Link from "next/link";
import { notFound } from "next/navigation";
import { extractOfficeText } from "@jarvis/files";
import { db } from "@/lib/db";
import { fmtDateTime, relative, shortCourse } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { storage } from "@/lib/storage";
import { StatusBadge } from "../../ui";
import { RedraftButton } from "./redraft-button";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const [d] = await db()`
    select d.id, d.status, d.created_at, d.markdown, d.storage_path, d.sources, d.assignment_id,
           i.title, i.data ->> 'courseTitle' as course, i.data ->> 'dueAt' as due_at, i.data ->> 'submissionStatus' as sub, i.data ->> 'sourceUrl' as url
      from jarvis.drafts d join jarvis.lms_items i on i.kind = 'assignment' and i.source_id = d.assignment_id
     where d.id = ${Number(id)} and d.status = 'done'`;
  if (!d) notFound();

  // Older drafts kept only the .docx; read its text back when there's no stored Markdown.
  let body: string;
  if (d.markdown) body = renderMarkdown(String(d.markdown));
  else {
    const text = extractOfficeText(await storage().download(String(d.storage_path)), "docx");
    body = `<pre class="whitespace-pre-wrap">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
  }
  const sources = (d.sources as Array<{ label: string }> | null) ?? [];
  const at = d.created_at instanceof Date ? d.created_at.toISOString() : String(d.created_at);

  return (
    <main>
      <Link href="/drafts" className="text-sm no-underline">
        ← Drafts
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{String(d.title)}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]">
        <StatusBadge status={String(d.sub)} dueAt={d.due_at as string | null} />
        <span>{shortCourse(d.course as string | null)}</span>
        <span>
          · due {fmtDateTime(d.due_at as string | null)} ({relative(d.due_at as string | null)})
        </span>
        <span>· drafted {fmtDateTime(at)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <a href={`/api/drafts/${d.id}/docx`} className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 font-medium text-white no-underline">
          Download .docx
        </a>
        <a href={String(d.url)} target="_blank" rel="noreferrer" className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 no-underline">
          Open in MESA LMS ↗
        </a>
        <RedraftButton assignmentId={String(d.assignment_id)} />
      </div>
      {sources.length > 0 && <p className="mt-3 text-xs text-[var(--color-muted)]">Read: {sources.map((s) => s.label).join(" · ")}</p>}
      <p className="mt-1 text-xs text-[var(--color-muted)]">A starting point: verify anything marked [verify], fill placeholders, and make it your own before submitting.</p>
      <article className="draft card mt-4 p-5 sm:p-7" dangerouslySetInnerHTML={{ __html: body }} />
    </main>
  );
}
