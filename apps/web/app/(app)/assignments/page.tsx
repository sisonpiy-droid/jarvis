import Link from "next/link";
import { assignments } from "@/lib/queries";
import { fmtDateTime, isSubmitted, relative, shortCourse } from "@/lib/format";
import { Badge, Section, StatusBadge } from "../ui";

export default async function AssignmentsPage() {
  const all = (await assignments()).filter((a) => !a.removed);
  const now = Date.now();
  const open = all.filter((a) => !isSubmitted(a.status) && (!a.dueAt || Date.parse(a.dueAt) > now)).sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~"));
  const overdue = all.filter((a) => !isSubmitted(a.status) && a.dueAt && Date.parse(a.dueAt) <= now);
  const done = all.filter((a) => isSubmitted(a.status));

  const table = (rows: typeof all) => (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-left text-[var(--color-muted)]">
          <tr>
            <th className="py-2 pl-4 pr-3 font-medium sm:pl-0">Assignment</th>
            <th className="px-3 py-2 font-medium">Course</th>
            <th className="px-3 py-2 font-medium">Deadline</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="py-2 pl-3 pr-4 font-medium sm:pr-0">Files</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="py-2.5 pl-4 pr-3 sm:pl-0">
                <Link href={`/assignments/${a.id}`} className="font-medium text-[var(--color-ink)] no-underline hover:underline">
                  {a.title}
                </Link>
                {a.drafts > 0 && (
                  <span className="ml-2">
                    <Badge tone="good">Draft</Badge>
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5 text-[var(--color-muted)]">{shortCourse(a.course)}</td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                {fmtDateTime(a.dueAt)}
                <div className="text-xs text-[var(--color-muted)]">{relative(a.dueAt)}</div>
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={a.status} dueAt={a.dueAt} />
              </td>
              <td className="py-2.5 pl-3 pr-4 text-[var(--color-muted)] sm:pr-0">{a.files || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Assignments</h1>
      <Section title={`Open (${open.length})`}>{open.length ? table(open) : <p className="text-sm text-[var(--color-muted)]">Nothing open. 🎉</p>}</Section>
      {overdue.length > 0 && <Section title={`Past deadline, not submitted (${overdue.length})`}>{table(overdue)}</Section>}
      <Section title={`Submitted (${done.length})`}>{table(done)}</Section>
    </main>
  );
}
