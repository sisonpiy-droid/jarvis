import Link from "next/link";
import { getMemory } from "@jarvis/ai";
import { goalAttention, goalsWithProgress, habitsWithStatus, listGoals, listHabits } from "@jarvis/db";
import { sql } from "@/lib/passkey";
import { Section } from "../ui";
import { button, field, FormError } from "../tasks/task-ui";
import { addGoal, addHabit } from "./actions";
import { GoalCard, HabitRow, ScheduleFields } from "./goal-ui";

export const dynamic = "force-dynamic";

export default async function GoalsPage({ searchParams }: { searchParams: Promise<{ closed?: string; error?: string; from_memory?: string }> }) {
  const { closed, error, from_memory } = await searchParams;
  const showClosed = closed === "1";
  const db = sql();
  // "Make it a goal" from /settings/memory: only the note's id travels in the URL; its text is read here.
  // Only an old note still waiting for review prefills (nothing else would be marked as converted).
  const found = !showClosed && from_memory ? await getMemory(db, Number(from_memory)).catch(() => null) : null;
  const fromMemory = found?.legacy ? found : null;
  const back = fromMemory ? `/goals?from_memory=${fromMemory.id}` : "/goals";
  const [goals, habits] = await Promise.all([listGoals(db, { status: showClosed ? "closed" : "open" }), listHabits(db, { includeInactive: true })]);
  const [withProgress, withStatus, attention] = await Promise.all([goalsWithProgress(db, goals), habitsWithStatus(db, habits), goalAttention(db)]);
  const att = new Map(attention.map((a) => [a.id, a]));
  const openGoals = goals.filter((g) => g.status === "active" || g.status === "paused");

  return (
    <main>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Goals and habits</h1>
        <Link href={showClosed ? "/goals" : "/goals?closed=1"} className="text-sm no-underline">
          {showClosed ? "Current goals" : "Finished goals"} →
        </Link>
      </div>
      <FormError error={error} />

      {!showClosed && (
        <Section title={`Habits (${withStatus.filter((h) => h.active).length})`}>
          {withStatus.length ? (
            <ul className="divide-y divide-[var(--color-line)]">
              {withStatus.map((h) => (
                <HabitRow key={h.id} h={h} back="/goals" />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">No habits yet. Add one below, or tell JARVIS in Chat: “I want to work out 4 times a week”.</p>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">New habit</summary>
            <form action={addHabit} className="mt-2 space-y-2">
              <input type="hidden" name="back" value="/goals" />
              <input name="name" required maxLength={200} placeholder="e.g. Read 20 pages" className={`${field} w-full`} aria-label="Habit" />
              <ScheduleFields />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                  Remind me at
                  <input type="time" name="reminder" className={field} />
                </label>
                <select name="goal_id" defaultValue="" className={field} aria-label="Counts toward goal">
                  <option value="">No goal</option>
                  {openGoals.map((g) => (
                    <option key={g.id} value={g.id}>
                      Counts toward: {g.title}
                    </option>
                  ))}
                </select>
                <button className={button}>Add habit</button>
              </div>
            </form>
          </details>
        </Section>
      )}

      <Section title={`${showClosed ? "Finished goals" : "Goals"} (${withProgress.length})`}>
        {withProgress.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {withProgress.map((g) => (
              <GoalCard key={g.id} g={g} p={g.progress} risk={att.get(g.id)?.risk.risk} neglected={att.get(g.id)?.neglect.neglected} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">{showClosed ? "None yet." : "No goals yet."}</p>
        )}
        {!showClosed && (
          <details className="mt-3" open={!!fromMemory}>
            <summary className="cursor-pointer text-sm font-medium">New goal</summary>
            {fromMemory && (
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                From your old note #{fromMemory.id}. Set the target and create the goal; the note is then marked as converted.
              </p>
            )}
            <form action={addGoal} className="mt-2 grid gap-2 sm:grid-cols-2">
              <input type="hidden" name="back" value={back} />
              {fromMemory && <input type="hidden" name="from_memory" value={fromMemory.id} />}
              <input
                name="title"
                required
                maxLength={300}
                defaultValue={fromMemory?.content.slice(0, 300)}
                placeholder="e.g. Get fitter"
                className={`${field} sm:col-span-2`}
                aria-label="Goal"
              />
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <select name="metric" defaultValue="count" className={field} aria-label="Measured by">
                  <option value="count">Count (times, pages, applications…)</option>
                  <option value="duration_min">Minutes spent</option>
                  <option value="boolean">Done or not</option>
                  <option value="value">A number to track (weight, score…)</option>
                </select>
                <input type="number" name="target" step="any" min={0} placeholder="Target" className={`${field} w-24`} aria-label="Target" />
                <input name="unit" maxLength={40} placeholder="unit, e.g. workouts" className={`${field} w-36`} aria-label="Unit" />
                <select name="period" defaultValue="week" className={field} aria-label="Per">
                  <option value="day">per day</option>
                  <option value="week">per week</option>
                  <option value="month">per month</option>
                  <option value="quarter">per quarter</option>
                  <option value="year">per year</option>
                  <option value="total">in total</option>
                </select>
              </div>
              <select name="domain" defaultValue="personal" className={field} aria-label="Personal or professional">
                <option value="personal">Personal</option>
                <option value="professional">Professional</option>
              </select>
              <input name="area" maxLength={40} placeholder="Area (fitness, reading, career…)" className={field} aria-label="Area" />
              <label className="text-xs text-[var(--color-muted)]">
                By (optional)
                <input type="date" name="target_date" className={`${field} mt-0.5 block w-full`} />
              </label>
              <div className="rounded-lg border border-dashed border-[var(--color-line)] p-3 sm:col-span-2">
                <div className="mb-2 text-xs text-[var(--color-muted)]">Optional: a habit that counts toward it</div>
                <input name="habit_name" maxLength={200} placeholder="e.g. Work out" className={`${field} mb-2 w-full`} aria-label="Habit name" />
                <ScheduleFields />
                <label className="mt-2 flex items-center gap-1 text-xs text-[var(--color-muted)]">
                  Remind me at
                  <input type="time" name="reminder" className={field} />
                </label>
              </div>
              <div className="sm:col-span-2">
                <button className={button}>Create goal</button>
              </div>
            </form>
          </details>
        )}
      </Section>
    </main>
  );
}
