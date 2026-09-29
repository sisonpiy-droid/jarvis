import { status } from "@/lib/queries";
import { bytes, fmtDateTime, relative } from "@/lib/format";
import { calendarFeedUrl } from "@/lib/auth";
import { Badge, Section } from "../ui";
import { CopyLink } from "./copy-link";

export default async function StatusPage() {
  const [s, feed] = await Promise.all([status(), calendarFeedUrl()]);
  const tone = (st: string) => (st === "success" || st === "sent" ? "good" : st === "partial" || st === "queued" || st === "skipped" ? "warn" : st === "failed" ? "bad" : "muted");
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
      <Section title="MESA connection">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-[var(--color-muted)]">State</dt>
          <dd>
            <Badge tone={s.integ?.status === "active" ? "good" : "bad"}>{s.integ?.status ?? "not connected"}</Badge>
          </dd>
          <dt className="text-[var(--color-muted)]">Sign-in expires</dt>
          <dd>
            {fmtDateTime(s.integ?.expires)} ({relative(s.integ?.expires)})
          </dd>
          <dt className="text-[var(--color-muted)]">Last success</dt>
          <dd>{relative(s.integ?.lastSuccess)}</dd>
          <dt className="text-[var(--color-muted)]">Last full scan</dt>
          <dd>{relative(s.integ?.lastFull)}</dd>
          <dt className="text-[var(--color-muted)]">Files</dt>
          <dd>
            {s.stored.count} stored ({bytes(s.stored.bytes)}) · {s.files.pending ?? 0} pending · {s.files.failed ?? 0} failed
          </dd>
        </dl>
        {s.integ?.error && <p className="mt-2 text-sm text-[var(--color-bad)]">Last error: {s.integ.error}</p>}
      </Section>

      <Section title="Classes in Google Calendar">
        <p className="mb-2 text-sm text-[var(--color-muted)]">A private feed of your MESA classes. Keep this link to yourself: anyone with it can see your timetable.</p>
        <CopyLink url={feed} />
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          <li>
            On a computer, open <a href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl">Google Calendar → Add calendar → From URL</a> (use your personal account).
          </li>
          <li>Paste the link and click <b>Add calendar</b>. "MESA classes" appears in your calendar list, on your phone too.</li>
          <li>Google re-reads it every few hours, so new, moved and cancelled classes show up by themselves.</li>
        </ol>
      </Section>

      <Section title="Recent syncs">
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-[var(--color-muted)]">
              <tr>
                <th className="py-1.5 pl-4 font-medium sm:pl-0">When</th>
                <th className="font-medium">Kind</th>
                <th className="font-medium">Status</th>
                <th className="font-medium">Requests</th>
                <th className="font-medium">Changes</th>
                <th className="pr-4 font-medium sm:pr-0">Alerts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {s.runs.map((r) => {
                const changes = Object.values((r.changes ?? {}) as Record<string, { created: number; changed: number; removed: number }>).reduce((n, c) => n + c.created + c.changed + c.removed, 0);
                return (
                  <tr key={r.id}>
                    <td className="py-1.5 pl-4 whitespace-nowrap sm:pl-0">{fmtDateTime(r.at)}</td>
                    <td>
                      {r.kind} <span className="text-[var(--color-muted)]">· {r.trigger}</span>
                    </td>
                    <td>
                      <Badge tone={tone(r.status)}>{r.status}</Badge>
                      {r.error && <span className="ml-2 text-[var(--color-bad)]">{r.error.slice(0, 60)}</span>}
                    </td>
                    <td>{r.requests ?? "—"}</td>
                    <td>{changes || "—"}</td>
                    <td className="pr-4 sm:pr-0">{r.notifications ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Recent notifications">
        <ul className="divide-y divide-[var(--color-line)] text-sm">
          {s.notes.map((n) => (
            <li key={n.id} className="flex flex-wrap items-baseline gap-2 py-1.5">
              <Badge tone={tone(n.status)}>{n.status}</Badge>
              <span className="text-[var(--color-muted)]">{fmtDateTime(n.at)}</span>
              <span className="min-w-0 flex-1 truncate">{n.text.split("\n")[0]}</span>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}
