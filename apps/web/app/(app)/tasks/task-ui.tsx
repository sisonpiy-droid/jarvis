import Link from "next/link";
import type { Project, Task } from "@jarvis/db";
import { canDefer } from "@/lib/command";
import { fmtDateTime, relative } from "@/lib/format";
import { fmtDate, istParts, sourceLink } from "@/lib/work-format";
import { Badge } from "../ui";
import { addTask, deferTask, editTask, removeTask, setTaskStatus } from "./actions";

export { istParts, KIND_LABEL } from "@/lib/work-format";

// Shared by /tasks, /projects/[id] and Today. Plain forms: work without client JavaScript.

export const field = "rounded-lg border border-[var(--color-line)] bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";
export const button = "rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white";
export const quiet = "rounded-lg border border-[var(--color-line)] px-2.5 py-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]";


function DueBadge({ t }: { t: Task }) {
  if (!t.dueAt) return null;
  const open = t.status === "todo" || t.status === "doing";
  const ms = Date.parse(t.dueAt) - Date.now();
  const tone = !open ? "muted" : ms < 0 ? "bad" : ms < 36 * 3_600_000 ? "warn" : "muted";
  return (
    <Badge tone={tone}>
      {ms < 0 && open ? "Overdue · " : ""}
      {t.dueIsDateOnly ? fmtDate(t.dueAt) : fmtDateTime(t.dueAt)}
      {open && !t.dueIsDateOnly && ` (${relative(t.dueAt)})`}
    </Badge>
  );
}

/**
 * One task. `hint` is a muted line of reasons (the focus score's); `rank` shows a large numeral (Today's
 * priorities); `menu` turns "Edit" into a ⋯ menu that also offers Move to tomorrow and Open project.
 */
export function TaskRow({ t, back, projects, showProject = true, hint, rank, menu = false }: { t: Task; back: string; projects: Project[]; showProject?: boolean; hint?: string; rank?: number; menu?: boolean }) {
  const done = t.status === "done" || t.status === "cancelled";
  const due = istParts(t.dueAt);
  const src = sourceLink(t);
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-3">
        {rank != null && <span className="-mt-1 w-5 shrink-0 text-2xl leading-none font-semibold tabular-nums text-[var(--color-muted)]">{rank}</span>}
        <form action={setTaskStatus}>
          <input type="hidden" name="id" value={t.id} />
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="status" value={done ? "todo" : "done"} />
          {/* A 44 px tap target around the 20 px circle; the negative margin keeps the row's layout. */}
          <button aria-label={done ? `Reopen ${t.title}` : `Complete ${t.title}`} className="group -m-3 flex h-11 w-11 items-center justify-center">
            <span
              className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border text-xs ${done ? "border-[var(--color-good)] bg-[var(--color-good)] text-white" : "border-[var(--color-muted)] group-hover:border-[var(--color-good)]"}`}
            >
              {done ? "✓" : ""}
            </span>
          </button>
        </form>
        <div className="min-w-0 flex-1">
          <div className={`font-medium break-words ${done ? "text-[var(--color-muted)] line-through" : ""}`}>{t.title}</div>
          {hint && <p className="mt-0.5 text-xs text-[var(--color-muted)]">{hint}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
            <DueBadge t={t} />
            {t.status === "doing" && <Badge tone="good">In progress</Badge>}
            {t.status === "waiting" && <Badge tone="warn">Waiting</Badge>}
            {t.status === "cancelled" && <Badge>Cancelled</Badge>}
            {t.priority === 1 && !done && <Badge tone="bad">P1</Badge>}
            {t.isNextAction && !done && <Badge tone="good">Next</Badge>}
            {showProject && t.projectId && (
              <Link href={`/projects/${t.projectId}`} className="no-underline">
                {t.projectTitle}
              </Link>
            )}
            {src && (
              <Link href={src.href} className="no-underline">
                {src.label} →
              </Link>
            )}
            {t.domain === "personal" && <span>Personal</span>}
          </div>
          {t.notes && <p className="mt-1 text-sm whitespace-pre-wrap text-[var(--color-muted)]">{t.notes}</p>}
          <details className="mt-1">
            {menu ? (
              <summary aria-label={`More actions for ${t.title}`} className="inline-flex min-h-8 min-w-11 cursor-pointer items-center text-base leading-none text-[var(--color-muted)]">
                ⋯
              </summary>
            ) : (
              <summary className="cursor-pointer text-xs text-[var(--color-muted)]">Edit</summary>
            )}
            {menu && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {canDefer(t, new Date()) && !done && (
                  <form action={deferTask}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="back" value={back} />
                    <button className={quiet}>Move to tomorrow</button>
                  </form>
                )}
                {t.projectId && (
                  <Link href={`/projects/${t.projectId}`} className="text-sm no-underline">
                    Open project →
                  </Link>
                )}
              </div>
            )}
            <form action={editTask} className="mt-2 grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="id" value={t.id} />
              <input type="hidden" name="back" value={back} />
              <input name="title" defaultValue={t.title} required maxLength={300} className={`${field} sm:col-span-2`} aria-label="Title" />
              <label className="text-xs text-[var(--color-muted)]">
                Due date
                <input type="date" name="due_date" defaultValue={due.date} className={`${field} mt-0.5 block w-full`} />
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                Time (optional)
                <input type="time" name="due_time" defaultValue={t.dueIsDateOnly ? "" : due.time} className={`${field} mt-0.5 block w-full`} />
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                Status
                <select name="status" defaultValue={t.status} className={`${field} mt-0.5 block w-full`}>
                  <option value="todo">To do</option>
                  <option value="doing">In progress</option>
                  <option value="waiting">Waiting on someone</option>
                  <option value="done">Done</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                Priority
                <select name="priority" defaultValue={t.priority} className={`${field} mt-0.5 block w-full`}>
                  <option value={1}>P1 · highest</option>
                  <option value={2}>P2</option>
                  <option value={3}>P3</option>
                  <option value={4}>P4 · lowest</option>
                </select>
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                Effort (min)
                <input type="number" name="effort_min" inputMode="numeric" min={1} max={600} step={1} defaultValue={t.effortMin ?? ""} className={`${field} mt-0.5 block w-full`} />
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                Project
                <select name="project_id" defaultValue={t.projectId ?? ""} className={`${field} mt-0.5 block w-full`}>
                  <option value="">None</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
              <textarea name="notes" defaultValue={t.notes ?? ""} rows={2} placeholder="Notes" className={`${field} sm:col-span-2`} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="next_action" defaultChecked={t.isNextAction} /> Next action for its project
              </label>
              <div className="flex items-center gap-2 sm:justify-end">
                <button className={button}>Save</button>
              </div>
            </form>
            {t.source !== "mesa" && (
              <form action={removeTask} className="mt-2">
                <input type="hidden" name="id" value={t.id} />
                <input type="hidden" name="back" value={back} />
                <button className="text-xs text-[var(--color-bad)]">Delete task</button>
              </form>
            )}
          </details>
        </div>
      </div>
    </li>
  );
}

export function TaskList({ tasks, back, projects, showProject = true, empty }: { tasks: Task[]; back: string; projects: Project[]; showProject?: boolean; empty: React.ReactNode }) {
  if (!tasks.length) return <p className="text-sm text-[var(--color-muted)]">{empty}</p>;
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {tasks.map((t) => (
        <TaskRow key={t.id} t={t} back={back} projects={projects} showProject={showProject} />
      ))}
    </ul>
  );
}

export function QuickAdd({ back, projects, projectId }: { back: string; projects: Project[]; projectId?: number }) {
  return (
    <form action={addTask} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="back" value={back} />
      <input name="title" required maxLength={300} placeholder={projectId ? "Add a task to this project…" : "Add a task, e.g. Email Prof. Menon about the viva slot"} className={`${field} min-w-0 flex-[1_1_16rem]`} aria-label="New task" />
      <button className={button}>Add</button>
      <details className="w-full text-sm">
        <summary className="cursor-pointer py-1 text-[var(--color-muted)]">Due date, effort, project…</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
      <input type="date" name="due_date" className={field} aria-label="Due date" />
      <input type="time" name="due_time" className={`${field} w-28`} aria-label="Due time (optional)" />
      <input type="number" name="effort_min" inputMode="numeric" min={1} max={600} step={1} placeholder="Effort (min)" className={`${field} w-32`} aria-label="Effort (min)" />
      {projectId ? (
        <input type="hidden" name="project_id" value={projectId} />
      ) : (
        <select name="project_id" defaultValue="" className={`${field} max-w-[12rem]`} aria-label="Project">
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      )}
      {!projectId && (
        <select name="domain" defaultValue="professional" className={field} aria-label="Personal or professional">
          <option value="professional">Work</option>
          <option value="personal">Personal</option>
        </select>
      )}
        </div>
      </details>
    </form>
  );
}

export function FormError({ error }: { error?: string }) {
  if (!error) return null;
  return <p className="mt-3 rounded-lg bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] px-3 py-2 text-sm text-[var(--color-bad)]">Not saved: {error}</p>;
}
