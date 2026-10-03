import Link from "next/link";
import { listProjects, listTasks, taskCounts } from "@jarvis/db";
import { sql } from "@/lib/passkey";
import { Section } from "../ui";
import { FormError, QuickAdd, TaskList } from "./task-ui";

export const dynamic = "force-dynamic";

const VIEWS = [
  ["today", "Today"],
  ["upcoming", "Upcoming"],
  ["waiting", "Waiting"],
  ["done", "Done"],
] as const;
type View = (typeof VIEWS)[number][0];

const EMPTY: Record<View, string> = {
  today: "Nothing due today. Add a task above, or pick something from Upcoming.",
  upcoming: "Nothing scheduled after today.",
  waiting: "Nothing waiting on anyone. Set a task to “Waiting on someone” to track it here.",
  done: "Nothing completed yet.",
};

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ view?: string; error?: string }> }) {
  const { view: v, error } = await searchParams;
  const view: View = VIEWS.some(([k]) => k === v) ? (v as View) : "today";
  const db = sql();
  const [tasks, counts, projects] = await Promise.all([listTasks(db, { view, limit: view === "done" ? 50 : 200 }), taskCounts(db), listProjects(db)]);
  const back = `/tasks?view=${view}`;
  const count: Record<View, number | null> = { today: counts.today, upcoming: counts.upcoming, waiting: counts.waiting, done: null };
  return (
    <main>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <Link href="/projects" className="text-sm no-underline">
          Projects →
        </Link>
      </div>
      {counts.overdue > 0 && <p className="mt-1 text-sm text-[var(--color-bad)]">{counts.overdue} overdue</p>}
      <div className="mt-4">
        <QuickAdd back={back} projects={projects} />
        <FormError error={error} />
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {VIEWS.map(([k, label]) => (
          <Link
            key={k}
            href={`/tasks?view=${k}`}
            className={`rounded-full px-3 py-1 text-sm no-underline ${k === view ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-line)] text-[var(--color-muted)]"}`}
          >
            {label}
            {count[k] ? ` · ${count[k]}` : ""}
          </Link>
        ))}
      </div>
      <Section title={VIEWS.find(([k]) => k === view)![1]}>
        <TaskList tasks={tasks} back={back} projects={projects} empty={EMPTY[view]} />
      </Section>
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        MESA assignments and exams appear here automatically and close when you submit on the LMS. You can also tell JARVIS in Chat: “add call the bank by Friday”.
      </p>
    </main>
  );
}
