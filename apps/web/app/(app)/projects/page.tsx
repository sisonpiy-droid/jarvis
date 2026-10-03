import Link from "next/link";
import { getMemory } from "@jarvis/ai";
import { listProjects } from "@jarvis/db";
import { sql } from "@/lib/passkey";
import { Section } from "../ui";
import { addProject } from "../tasks/actions";
import { button, field, FormError, KIND_LABEL } from "../tasks/task-ui";
import { ProjectRow } from "./project-ui";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ closed?: string; error?: string; from_memory?: string }> }) {
  const { closed, error, from_memory } = await searchParams;
  const showClosed = closed === "1";
  // "Make it a project" from /settings/memory: only the note's id travels in the URL; its text is read here.
  // Only an old note still waiting for review prefills (nothing else would be marked as converted).
  const found = !showClosed && from_memory ? await getMemory(sql(), Number(from_memory)).catch(() => null) : null;
  const fromMemory = found?.legacy ? found : null;
  const back = fromMemory ? `/projects?from_memory=${fromMemory.id}` : "/projects";
  const projects = await listProjects(sql(), { status: showClosed ? "closed" : "open" });
  const mesa = projects.filter((p) => p.source === "mesa");
  const own = projects.filter((p) => p.source !== "mesa");
  return (
    <main>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Link href={showClosed ? "/projects" : "/projects?closed=1"} className="text-sm no-underline">
          {showClosed ? "Open projects" : "Finished projects"} →
        </Link>
      </div>

      {!showClosed && (
        <details className="card mt-4 p-4" open={!!fromMemory || !!error}>
          <summary className="cursor-pointer font-medium">New project</summary>
          {fromMemory && (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              From your old note #{fromMemory.id}. Add a deadline if it has one and create the project; the note is then marked as converted.
            </p>
          )}
          <form action={addProject} className="mt-3 grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="back" value={back} />
            {fromMemory && <input type="hidden" name="from_memory" value={fromMemory.id} />}
            <input
              name="title"
              required
              maxLength={300}
              defaultValue={fromMemory?.content.slice(0, 300)}
              placeholder="e.g. Spinny case competition"
              className={`${field} sm:col-span-2`}
              aria-label="Title"
            />
            <textarea name="objective" rows={2} placeholder="What does done look like?" className={`${field} sm:col-span-2`} aria-label="Objective" />
            <select name="kind" defaultValue="other" className={field} aria-label="Kind">
              {Object.entries(KIND_LABEL)
                .filter(([k]) => k !== "mesa_assignment" && k !== "exam")
                .map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
            </select>
            <select name="domain" defaultValue="professional" className={field} aria-label="Personal or professional">
              <option value="professional">Professional</option>
              <option value="personal">Personal</option>
            </select>
            <input name="area" maxLength={40} placeholder="Area (career, fitness, startup…)" className={field} aria-label="Area" />
            <label className="text-xs text-[var(--color-muted)]">
              Deadline (optional)
              <input type="date" name="deadline_date" className={`${field} mt-0.5 block w-full`} />
            </label>
            <div className="sm:col-span-2">
              <button className={button}>Create project</button>
            </div>
          </form>
          <FormError error={error} />
        </details>
      )}

      <Section title={`${showClosed ? "Finished" : "Your projects"} (${own.length})`}>
        {own.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {own.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">{showClosed ? "None yet." : "No projects of your own yet. Create one above, or ask JARVIS in Chat."}</p>
        )}
      </Section>

      <Section title={`MESA (${mesa.length})`}>
        {mesa.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {mesa.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">{showClosed ? "None yet." : "Open assignments and upcoming exams appear here after the next LMS check."}</p>
        )}
      </Section>
    </main>
  );
}
