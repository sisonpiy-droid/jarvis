import Link from "next/link";
import { classesBetween, courses, istDayBounds } from "@/lib/queries";
import { fmtDay, fmtTime, shortCourse } from "@/lib/format";
import { Badge, Empty, Section } from "../ui";

export default async function ClassesPage() {
  const from = istDayBounds(-7).from;
  const to = istDayBounds(14).to;
  const [events, cs] = await Promise.all([classesBetween(from, to), courses()]);
  const todayStart = istDayBounds(0).from;
  const upcoming = events.filter((e) => e.startAt >= todayStart);
  const past = events.filter((e) => e.startAt < todayStart).reverse();

  const byDay = (rows: typeof events) => {
    const groups = new Map<string, typeof events>();
    for (const e of rows) {
      const k = fmtDay(e.startAt);
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    return [...groups.entries()];
  };
  const list = (rows: typeof events) =>
    rows.length ? (
      <div className="space-y-4">
        {byDay(rows).map(([day, items]) => (
          <div key={day}>
            <h3 className="text-sm font-semibold">{day}</h3>
            <ul className="mt-1.5 space-y-1.5">
              {items.map((c) => (
                <li key={c.id} className={`flex gap-3 text-sm ${c.status === "cancelled" ? "opacity-50 line-through" : ""}`}>
                  <span className="w-28 shrink-0 tabular-nums text-[var(--color-muted)]">
                    {c.allDay ? "All day" : `${fmtTime(c.startAt)}–${fmtTime(c.endAt)}`}
                  </span>
                  <span className="min-w-0">
                    {!c.personal && c.type === "session" ? (
                      <Link href={`/classes/${encodeURIComponent(c.id)}`} className="font-medium">
                        {shortCourse(c.course ?? c.title)}
                      </Link>
                    ) : (
                      <b className="font-medium">{c.personal ? c.title : shortCourse(c.course ?? c.title)}</b>
                    )}
                    {!c.personal && c.title !== c.course && <span className="text-[var(--color-muted)]"> · {c.title}</span>}
                    {c.personal && (
                      <span className="ml-2">
                        <Badge>Personal</Badge>
                      </span>
                    )}
                    {c.room && <span className="text-[var(--color-muted)]"> · {c.room}</span>}
                    {c.type === "exam" && (
                      <span className="ml-2">
                        <Badge tone="warn">Exam</Badge>
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ) : (
      <Empty>Nothing scheduled.</Empty>
    );

  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Classes</h1>
      <Section title="Next 14 days">{list(upcoming)}</Section>
      <Section title="Courses & materials">
        <ul className="grid gap-2 sm:grid-cols-2">
          {cs.map((c) => (
            <li key={c.id}>
              <Link href={`/courses/${c.id}`} className="block rounded-lg border border-[var(--color-line)] p-3 no-underline hover:bg-[var(--color-line)]">
                <span className="block font-medium text-[var(--color-ink)]">{c.title}</span>
                <span className="text-sm text-[var(--color-muted)]">
                  {c.term ?? ""} · {c.materials} materials · {c.recordings} recordings
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Last 7 days">{list(past)}</Section>
    </main>
  );
}
