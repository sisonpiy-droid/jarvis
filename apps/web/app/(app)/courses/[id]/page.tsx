import Link from "next/link";
import { notFound } from "next/navigation";
import { courseDetail } from "@/lib/queries";
import { fmtDateTime } from "@/lib/format";
import { Badge, Empty, Section } from "../../ui";

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await courseDetail(id);
  if (!c) notFound();
  const topics = new Map<string, typeof c.items>();
  for (const it of c.items) {
    const k = it.kind === "recording" ? "Recordings" : (it.topic ?? "Materials");
    topics.set(k, [...(topics.get(k) ?? []), it]);
  }
  return (
    <main>
      <Link href="/classes" className="text-sm no-underline">
        ← Classes
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{c.title}</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {String(c.data.instructor ?? "")} · <a href={String(c.data.sourceUrl)} target="_blank" rel="noreferrer">Open in MESA LMS ↗</a>
      </p>
      {topics.size === 0 && (
        <Section title="Materials">
          <Empty>No materials yet.</Empty>
        </Section>
      )}
      {[...topics.entries()].map(([topic, items]) => (
        <Section key={topic} title={`${topic} (${items.length})`}>
          <ul className="space-y-1.5 text-sm">
            {items.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                {m.sha ? <a href={`/files/${m.sha}`}>{m.title}</a> : m.link ? <a href={m.link} target="_blank" rel="noreferrer">{m.title} ↗</a> : <span>{m.title}</span>}
                {m.type && <Badge>{m.type}</Badge>}
                <span className="text-[var(--color-muted)]">{fmtDateTime(m.at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </main>
  );
}
