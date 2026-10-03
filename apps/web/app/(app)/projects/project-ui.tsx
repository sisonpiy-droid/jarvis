import Link from "next/link";
import { whenLabel, type Project, type Task } from "@jarvis/db";
import { fmtDateTime, relative } from "@/lib/format";
import { KIND_LABEL } from "@/lib/work-format";
import { Badge } from "../ui";

// Shared by /projects and Today.

/** One project: kind, status, deadline and task count — plus its next action when given (Today). */
export function ProjectRow({ p, next, now }: { p: Project; next?: Task | null; now?: Date }) {
  const total = p.openTasks + p.doneTasks;
  return (
    <li className="py-2.5">
      <Link href={`/projects/${p.id}`} className="font-medium break-words text-[var(--color-ink)] no-underline hover:underline">
        {p.title}
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <Badge>{KIND_LABEL[p.kind] ?? p.kind}</Badge>
        {p.status === "on_hold" && <Badge tone="warn">On hold</Badge>}
        {p.status === "done" && <Badge tone="good">Done</Badge>}
        {p.status === "cancelled" && <Badge>Cancelled</Badge>}
        {p.deadline && (
          <span>
            {fmtDateTime(p.deadline)}
            {p.status === "active" && ` (${relative(p.deadline)})`}
          </span>
        )}
        {total > 0 && (
          <span>
            · {p.doneTasks}/{total} tasks done
          </span>
        )}
        {p.area && p.source !== "mesa" && <span>· {p.area}</span>}
      </div>
      {next && (
        <p className="mt-1 text-sm break-words text-[var(--color-muted)]">
          Next: {next.title}
          {next.dueAt && ` · ${whenLabel(next.dueAt, next.dueIsDateOnly, now ?? new Date())}`}
        </p>
      )}
    </li>
  );
}
