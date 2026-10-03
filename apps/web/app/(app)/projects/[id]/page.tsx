import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject, listProjects, listTasks, nextAction, projectItems, PROJECT_ITEM_KINDS } from "@jarvis/db";
import { fmtDateTime, relative } from "@/lib/format";
import { sql } from "@/lib/passkey";
import { Badge, Section } from "../../ui";
import { addItem, editProject, removeItem, toggleItem } from "../../tasks/actions";
import { button, field, FormError, istParts, KIND_LABEL, QuickAdd, TaskList } from "../../tasks/task-ui";

export const dynamic = "force-dynamic";

const ITEM_LABEL: Record<string, string> = { decision: "Decision", question: "Open question", blocker: "Blocker", note: "Note", document: "Document", person: "Person" };

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; done?: string }> }) {
  const [{ id: raw }, { error, done }] = await Promise.all([params, searchParams]);
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = sql();
  const p = await getProject(db, id);
  if (!p) notFound();
  const [open, finished, items, next, projects] = await Promise.all([
    listTasks(db, { projectId: id, view: "open" }),
    listTasks(db, { projectId: id, view: "done", limit: done === "1" ? 200 : 5 }),
    projectItems(db, id),
    nextAction(db, id),
    listProjects(db),
  ]);
  const back = `/projects/${id}`;
  const mesa = p.source === "mesa";
  const assignmentId = mesa && p.sourceRef?.startsWith("assignment:") ? p.sourceRef.slice("assignment:".length) : null;
  const deadline = istParts(p.deadline);

  return (
    <main>
      <Link href="/projects" className="text-sm no-underline">
        ← Projects
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{p.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-[var(--color-muted)]">
        <Badge>{KIND_LABEL[p.kind] ?? p.kind}</Badge>
        {p.status !== "active" && <Badge tone={p.status === "done" ? "good" : p.status === "on_hold" ? "warn" : "muted"}>{p.status.replace("_", " ")}</Badge>}
        {p.deadline && (
          <span>
            Deadline {fmtDateTime(p.deadline)}
            {p.status === "active" && ` (${relative(p.deadline)})`}
          </span>
        )}
        {assignmentId && (
          <Link href={`/assignments/${assignmentId}`} className="no-underline">
            · Assignment and drafts →
          </Link>
        )}
      </div>
      {p.objective && <p className="mt-3 whitespace-pre-wrap">{p.objective}</p>}
      <FormError error={error} />

      {next && p.status === "active" && (
        <div className="card mt-4 border-l-4 border-l-[var(--color-accent)] p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Next action</div>
          <div className="mt-1 font-medium">{next.title}</div>
          {next.dueAt && <div className="text-sm text-[var(--color-muted)]">{fmtDateTime(next.dueAt)} ({relative(next.dueAt)})</div>}
        </div>
      )}

      <Section title={`Tasks (${open.length} open)`}>
        <QuickAdd back={back} projects={projects} projectId={id} />
        <div className="mt-3">
          <TaskList tasks={open} back={back} projects={projects} showProject={false} empty="No open tasks." />
        </div>
        {finished.length > 0 && (
          <details className="mt-3" open={done === "1"}>
            <summary className="cursor-pointer text-sm text-[var(--color-muted)]">Done ({p.doneTasks})</summary>
            <TaskList tasks={finished} back={back} projects={projects} showProject={false} empty="" />
            {p.doneTasks > finished.length && (
              <Link href={`${back}?done=1`} className="text-sm no-underline">
                Show all →
              </Link>
            )}
          </details>
        )}
      </Section>

      <Section title="Decisions, questions, blockers and notes">
        {items.length > 0 && (
          <ul className="mb-3 divide-y divide-[var(--color-line)]">
            {items.map((i) => (
              <li key={i.id} className={`flex items-start gap-3 py-2 ${i.resolvedAt ? "opacity-60" : ""}`}>
                <Badge tone={i.kind === "blocker" && !i.resolvedAt ? "bad" : i.kind === "question" && !i.resolvedAt ? "warn" : "muted"}>{ITEM_LABEL[i.kind]}</Badge>
                <div className="min-w-0 flex-1 text-sm">
                  <div className={`whitespace-pre-wrap ${i.resolvedAt ? "line-through" : ""}`}>{i.body}</div>
                  {i.ref && (
                    <a href={i.ref} className="break-all text-xs" target={i.ref.startsWith("/") ? undefined : "_blank"} rel="noreferrer">
                      {i.ref}
                    </a>
                  )}
                </div>
                {(i.kind === "question" || i.kind === "blocker") && (
                  <form action={toggleItem}>
                    <input type="hidden" name="id" value={i.id} />
                    <input type="hidden" name="back" value={back} />
                    <input type="hidden" name="resolved" value={i.resolvedAt ? "0" : "1"} />
                    <button className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]">{i.resolvedAt ? "Reopen" : "Resolved"}</button>
                  </form>
                )}
                <form action={removeItem}>
                  <input type="hidden" name="id" value={i.id} />
                  <input type="hidden" name="back" value={back} />
                  <button aria-label="Delete" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-bad)]">
                    ✕
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={addItem} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="project_id" value={id} />
          <input type="hidden" name="back" value={back} />
          <select name="kind" defaultValue="note" className={field} aria-label="Kind">
            {PROJECT_ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {ITEM_LABEL[k]}
              </option>
            ))}
          </select>
          <input name="body" required maxLength={4000} placeholder="What was decided, asked, blocking…" className={`${field} min-w-0 flex-[1_1_14rem]`} aria-label="Text" />
          <input name="ref" maxLength={1000} placeholder="Link (optional)" className={`${field} flex-[0_1_12rem]`} aria-label="Link" />
          <button className={button}>Add</button>
        </form>
      </Section>

      <Section title="Project settings">
        <form action={editProject} className="grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="back" value={back} />
          {!mesa && (
            <>
              <input name="title" defaultValue={p.title} required maxLength={300} className={`${field} sm:col-span-2`} aria-label="Title" />
              <label className="text-xs text-[var(--color-muted)]">
                Deadline
                <input type="date" name="deadline_date" defaultValue={deadline.date} className={`${field} mt-0.5 block w-full`} />
              </label>
              <label className="text-xs text-[var(--color-muted)]">
                Time (optional)
                <input type="time" name="deadline_time" defaultValue={deadline.time === "23:59" ? "" : deadline.time} className={`${field} mt-0.5 block w-full`} />
              </label>
              <input name="area" defaultValue={p.area ?? ""} maxLength={40} placeholder="Area" className={field} aria-label="Area" />
            </>
          )}
          <textarea name="objective" defaultValue={p.objective ?? ""} rows={2} placeholder="Objective" className={`${field} sm:col-span-2`} aria-label="Objective" />
          <label className="text-xs text-[var(--color-muted)]">
            Status
            <select name="status" defaultValue={p.status} className={`${field} mt-0.5 block w-full`}>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="text-xs text-[var(--color-muted)]">
            Priority
            <select name="priority" defaultValue={p.priority} className={`${field} mt-0.5 block w-full`}>
              <option value={1}>P1 · highest</option>
              <option value={2}>P2</option>
              <option value={3}>P3</option>
              <option value={4}>P4 · lowest</option>
            </select>
          </label>
          <div className="sm:col-span-2">
            <button className={button}>Save</button>
            {mesa && <span className="ml-3 text-xs text-[var(--color-muted)]">Title and deadline follow the LMS.</span>}
          </div>
        </form>
      </Section>
    </main>
  );
}
