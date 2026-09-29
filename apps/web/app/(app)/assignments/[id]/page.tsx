import Link from "next/link";
import { notFound } from "next/navigation";
import { assignment } from "@/lib/queries";
import { EVENT_LABEL, bytes, fmtDateTime, relative, shortCourse } from "@/lib/format";
import { Badge, Empty, Section, StatusBadge } from "../../ui";
import { summarize } from "@jarvis/assist";
import { DraftButton } from "./draft-button";

export default async function AssignmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await assignment(id);
  if (!a) notFound();
  const d = a.data;
  const links = (d.links as string[] | undefined) ?? [];

  return (
    <main>
      <Link href="/assignments" className="text-sm no-underline">
        ← Assignments
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{a.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]">
        <StatusBadge status={a.status} dueAt={a.dueAt} />
        <span>{shortCourse(a.course)}</span>
        {typeof d.instructor === "string" && <span>· {d.instructor}</span>}
        <span>
          · Due <b className="text-[var(--color-ink)]">{fmtDateTime(a.dueAt)}</b> ({relative(a.dueAt)})
        </span>
        {a.submitAs && <span>· Submit as {a.submitAs}</span>}
        {d.isGroup === true && <Badge>Group</Badge>}
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        <a href={a.url} target="_blank" rel="noreferrer" className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm no-underline">
          Open in MESA LMS ↗
        </a>
        <DraftButton assignmentId={a.id} />
      </div>

      <Section title="Drafts by JARVIS">
        {a.drafts.length ? (
          <ul className="space-y-3">
            {a.drafts.map((dr) => (
              <li key={dr.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={dr.status === "done" ? "good" : dr.status === "failed" ? "bad" : "warn"}>{dr.status}</Badge>
                  <span className="text-[var(--color-muted)]">
                    {fmtDateTime(dr.at)} · {dr.trigger === "auto" ? "automatic" : "requested"}
                  </span>
                  {dr.status === "done" && (
                    <>
                      <a href={`/drafts/${dr.id}`}>Read</a>
                      <a href={`/api/drafts/${dr.id}/docx`}>Download .docx</a>
                    </>
                  )}
                </div>
                {dr.error && <p className="mt-1 text-[var(--color-bad)]">{dr.error}</p>}
                {dr.summary && <p className="mt-1 whitespace-pre-line text-[var(--color-muted)]">{summarize(dr.summary, 600)}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No drafts yet. Use “Draft with JARVIS”, or send /draft on Telegram.</Empty>
        )}
        <p className="mt-3 text-xs text-[var(--color-muted)]">Drafts are a starting point: verify anything marked [verify] and make the work your own before submitting.</p>
      </Section>

      <Section title="Brief">
        {typeof d.descriptionText === "string" ? <p className="whitespace-pre-line text-sm leading-relaxed">{d.descriptionText}</p> : <Empty>No brief text on the LMS — see the attachments.</Empty>}
        {typeof d.instructionsText === "string" && (
          <>
            <h3 className="mt-4 text-sm font-semibold">Instructions</h3>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{d.instructionsText}</p>
          </>
        )}
        {links.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold">Links</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {links.map((l) => (
                <li key={l} className="truncate">
                  <a href={l} target="_blank" rel="noreferrer">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Attachments">
        {a.files.length ? (
          <ul className="space-y-2 text-sm">
            {a.files.map((f, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                {f.sha ? <a href={`/files/${f.sha}`}>{f.name ?? f.title}</a> : <span>{f.title}</span>}
                <span className="text-[var(--color-muted)]">{f.size ? bytes(f.size) : ""}</span>
                <Badge tone={f.status === "done" ? "good" : f.status === "failed" ? "bad" : "muted"}>{f.status === "done" ? "saved" : f.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No attachments.</Empty>
        )}
      </Section>

      <Section title="History">
        <ul className="space-y-1 text-sm">
          {a.history.map((h, i) => (
            <li key={i}>
              <span className="text-[var(--color-muted)]">{fmtDateTime(h.at)}</span> — {EVENT_LABEL[h.type] ?? h.type}
            </li>
          ))}
          <li>
            <span className="text-[var(--color-muted)]">{fmtDateTime(a.firstSeen)}</span> — First seen by JARVIS
          </li>
        </ul>
      </Section>
    </main>
  );
}
