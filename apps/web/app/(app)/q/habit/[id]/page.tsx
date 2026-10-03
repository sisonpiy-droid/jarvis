import Link from "next/link";
import { notFound } from "next/navigation";
import { getHabit, habitsWithStatus, isDay, istDay } from "@jarvis/db";
import { sql } from "@/lib/passkey";
import { checkHabit } from "../../../goals/actions";
import { WeekDots } from "../../../goals/goal-ui";

export const dynamic = "force-dynamic";

// One-tap check-in, opened from a habit reminder (iPhone ignores notification buttons, so taps land here).

export default async function QuickHabitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ d?: string }> }) {
  const [{ id: raw }, { d }] = await Promise.all([params, searchParams]);
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = sql();
  const habit = await getHabit(db, id);
  if (!habit) notFound();
  const today = istDay(new Date());
  const day = isDay(d) && d <= today ? d : today;
  const [h] = await habitsWithStatus(db, [habit]);
  const state = h!.status.week.find((w) => w.day === day)?.state;
  const logged = state === "done" || state === "skipped" ? state : null;
  const back = `/q/habit/${id}?d=${day}`;
  const label = day === today ? "today" : new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" }).format(new Date(`${day}T00:00:00Z`));

  const Btn = ({ status, children, primary }: { status: string; children: React.ReactNode; primary?: boolean }) => (
    <form action={checkHabit} className="flex-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="day" value={day} />
      <input type="hidden" name="status" value={status} />
      <input type="hidden" name="back" value={back} />
      <button className={`w-full rounded-lg py-4 text-lg ${primary ? "bg-[var(--color-accent)] font-medium text-white" : "border border-[var(--color-line)] text-[var(--color-muted)]"}`}>{children}</button>
    </form>
  );

  return (
    <main className="mx-auto max-w-sm pt-6">
      <div className="card p-6 text-center">
        <p className="text-sm text-[var(--color-muted)]">Check-in for {label}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{habit.name}</h1>
        <div className="mt-3 flex justify-center">
          <WeekDots week={h!.status.week} />
        </div>
        {h!.status.streak > 1 && <p className="mt-2 text-sm">🔥 {h!.status.streak} in a row</p>}
        {logged ? (
          <>
            <p className="mt-6 text-lg">{logged === "done" ? "✅ Logged as done" : "⏭️ Skipped"}</p>
            <div className="mt-4 flex gap-2">
              <Btn status="undo">Undo</Btn>
            </div>
          </>
        ) : (
          <div className="mt-6 flex gap-2">
            <Btn status="done" primary>
              ✅ Done
            </Btn>
            <Btn status="skipped">Skip</Btn>
          </div>
        )}
        <Link href={habit.goalId ? `/goals/${habit.goalId}` : "/goals"} className="mt-6 inline-block text-sm no-underline">
          {habit.goalTitle ? `${habit.goalTitle} →` : "All habits →"}
        </Link>
      </div>
    </main>
  );
}
