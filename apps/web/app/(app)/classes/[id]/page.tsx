import Link from "next/link";
import { notFound } from "next/navigation";
import { classPrep } from "@jarvis/db";
import { fmtDateTime, fmtDay, fmtTime, relative, shortCourse } from "@/lib/format";
import { sql } from "@/lib/passkey";
import { Badge, Empty, Section } from "../../ui";

// One MESA class and what to prepare for it — where the pre-class push opens. The session number and the
// matching pre-reads come from @jarvis/db (classPrep); key points are the stored ones from the prep job.

export default async function ClassPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = new Date();
  const p = await classPrep(sql(), decodeURIComponent(id), now);
  if (!p) notFound();
  const e = p.event;
  const name = e.short ?? shortCourse(e.course ?? e.title);
  const ask = `What should I prepare for ${name}${p.session != null ? ` session ${p.session}` : ""} on ${fmtDateTime(e.startAt)}?`;
  return (
    <main>
      <Link href="/classes" className="text-sm no-underline">
        ← Classes
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {name}
        {p.session != null && <span className="text-[var(--color-muted)]"> · Session {p.session}</span>}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {fmtDay(e.startAt)} · {fmtTime(e.startAt)}
        {e.endAt ? `–${fmtTime(e.endAt)}` : ""} ({relative(e.startAt, now.getTime())}){e.room ? ` · ${e.room}` : ""}
      </p>
      <p className="mt-1 text-sm">
        {e.course && e.course !== e.title && <span className="text-[var(--color-muted)]">{e.title}</span>}
        {e.meetingLink && (
          <>
            {e.course && e.course !== e.title ? " · " : ""}
            <a href={e.meetingLink} target="_blank" rel="noreferrer">
              Join link ↗
            </a>
          </>
        )}
        {e.status === "cancelled" && <Badge tone="bad">Cancelled</Badge>}
      </p>

      <Section title={p.match === "recent" ? "New for this course" : "Prepare"}>
        {p.match === "recent" && <p className="mb-3 text-sm text-[var(--color-muted)]">The session number couldn&apos;t be worked out, so these are the course&apos;s newest materials, not confirmed as this class&apos;s pre-read.</p>}
        {p.items.length ? (
          <ul className="space-y-4">
            {p.items.map((i) => (
              <li key={`${i.title}:${i.fileId ?? i.url ?? ""}`} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {i.fileId ? (
                    <a href={`/files/${i.fileId}`} className="font-medium">
                      {i.title}
                    </a>
                  ) : i.url ? (
                    <a href={i.url} target="_blank" rel="noreferrer" className="font-medium">
                      {i.title} ↗
                    </a>
                  ) : (
                    <span className="font-medium">{i.title}</span>
                  )}
                  {p.match === "session" && <Badge tone={i.preRead ? "warn" : "muted"}>{i.preRead ? "Pre-read" : "Material"}</Badge>}
                  {i.folder && <span className="text-xs text-[var(--color-muted)]">{i.folder}</span>}
                </div>
                {i.points?.length ? (
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[var(--color-ink)]">
                    {i.points.map((pt) => (
                      <li key={pt}>{pt}</li>
                    ))}
                  </ul>
                ) : i.preRead && i.hasText ? (
                  <p className="mt-1 text-xs text-[var(--color-muted)]">Key points are written about a day before class.</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{p.session != null ? `No session ${p.session} pre-read or material on the LMS yet.` : "No pre-read found on the LMS for this class."}</Empty>
        )}
      </Section>

      {p.due.length > 0 && (
        <Section title="Due around this class">
          <ul className="space-y-1.5 text-sm">
            {p.due.map((a) => (
              <li key={a.id}>
                <Link href={`/assignments/${encodeURIComponent(a.id)}`}>{a.title}</Link> <span className="text-[var(--color-muted)]">· {fmtDateTime(a.dueAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/chat?q=${encodeURIComponent(ask)}`} className="inline-flex min-h-11 items-center rounded-full bg-[var(--color-accent)] px-4 text-sm font-medium text-white no-underline">
          Ask JARVIS about this class
        </Link>
        {e.courseId && (
          <Link href={`/courses/${encodeURIComponent(e.courseId)}`} className="inline-flex min-h-11 items-center rounded-full border border-[var(--color-line)] px-4 text-sm no-underline">
            All course materials
          </Link>
        )}
      </div>
    </main>
  );
}
