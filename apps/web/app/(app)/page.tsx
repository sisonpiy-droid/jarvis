import Link from "next/link";
import { assignments, classesBetween, istDayBounds, recentUpdates, status } from "@/lib/queries";
import { EVENT_LABEL, fmtDateTime, fmtDay, fmtTime, isSubmitted, relative, shortCourse } from "@/lib/format";
import { Badge, Empty, More, Section, StatusBadge } from "./ui";

export default async function TodayPage() {
  const today = istDayBounds(0);
  const [classes, all, updates, st] = await Promise.all([classesBetween(today.from, today.to), assignments(), recentUpdates(72), status()]);
  const now = Date.now();
  const due = all
    .filter((a) => !a.removed && !isSubmitted(a.status) && a.dueAt && Date.parse(a.dueAt) > now - 3 * 86_400_000 && Date.parse(a.dueAt) < now + 7 * 86_400_000)
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  const expiresIn = st.integ?.expires ? Date.parse(st.integ.expires) - now : null;

  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">{fmtDay(new Date().toISOString())}</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Last LMS check {relative(st.runs[0]?.at)} · {st.integ?.status === "active" ? "MESA connected" : "⚠️ MESA needs sign-in"}
        {expiresIn !== null && expiresIn < 5 * 86_400_000 && <> · sign-in expires {relative(st.integ!.expires)}</>}
      </p>

      <div className="grid gap-x-4 md:grid-cols-2">
        <Section title={`Today's classes (${classes.filter((c) => c.status !== "cancelled").length})`} action={<More href="/classes">Week</More>}>
          {classes.length ? (
            <ul className="space-y-2.5">
              {classes.map((c) => (
                <li key={c.id} className={`flex gap-3 ${c.status === "cancelled" ? "opacity-50 line-through" : ""}`}>
                  <span className="w-20 shrink-0 text-sm tabular-nums text-[var(--color-muted)]">{fmtTime(c.startAt)}</span>
                  <span className="min-w-0">
                    <span className="block font-medium">{shortCourse(c.course ?? c.title)}</span>
                    <span className="block text-sm text-[var(--color-muted)]">
                      {[c.title !== c.course ? c.title : null, c.room].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No classes today.</Empty>
          )}
        </Section>

        <Section title={`Due soon, not submitted (${due.length})`} action={<More href="/assignments">All</More>}>
          {due.length ? (
            <ul className="space-y-3">
              {due.map((a) => (
                <li key={a.id}>
                  <Link href={`/assignments/${a.id}`} className="font-medium text-[var(--color-ink)] no-underline hover:underline">
                    {a.title}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]">
                    <StatusBadge status={a.status} dueAt={a.dueAt} />
                    <span>
                      {fmtDateTime(a.dueAt)} ({relative(a.dueAt)})
                    </span>
                    <span>· {shortCourse(a.course)}</span>
                    {a.drafts > 0 && <Badge tone="good">Draft ready</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing unsubmitted is due in the next 7 days. ✅</Empty>
          )}
        </Section>
      </div>

      <Section title="What changed (last 3 days)">
        {updates.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {updates.map((u, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm">
                <span className="w-28 shrink-0 text-[var(--color-muted)]">{relative(u.at)}</span>
                <span className="font-medium">{EVENT_LABEL[u.type] ?? u.type}</span>
                {u.kind === "assignment" && u.id ? (
                  <Link href={`/assignments/${u.id}`} className="min-w-0 truncate">
                    {u.title}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-[var(--color-muted)]">{u.title}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No changes on the LMS in the last 3 days.</Empty>
        )}
      </Section>
    </main>
  );
}
