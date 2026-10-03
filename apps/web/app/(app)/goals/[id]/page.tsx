import Link from "next/link";
import { notFound } from "next/navigation";
import { goalAttention, goalDecisions, goalDetail, habitsWithStatus, istDay, PERIOD_LABEL } from "@jarvis/db";
import { fmtDateTime } from "@/lib/format";
import { sql } from "@/lib/passkey";
import { Badge, Section } from "../../ui";
import { button, field, FormError } from "../../tasks/task-ui";
import { editGoal, editHabit, logGoalEntry, removeActivity, removeGoal, removeHabit } from "../actions";
import { DecisionButtons, HabitRow, ProgressBar, progressText, RiskBadge, ScheduleFields, targetText } from "../goal-ui";

export const dynamic = "force-dynamic";

const fmtDay = (d: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${d}T00:00:00Z`));

export default async function GoalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id: raw }, { error }] = await Promise.all([params, searchParams]);
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = sql();
  const d = await goalDetail(db, id);
  if (!d) notFound();
  const { goal: g, progress: p, history } = d;
  const [habits, attention, decisions] = await Promise.all([habitsWithStatus(db, d.habits), goalAttention(db), goalDecisions(db, id)]);
  const att = attention.find((a) => a.id === id);
  const back = `/goals/${id}`;
  const maxHist = Math.max(1, ...history.map((h) => h.current ?? 0), p.target ?? 0);

  return (
    <main>
      <Link href="/goals" className="text-sm no-underline">
        ← Goals
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{g.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-[var(--color-muted)]">
        <Badge>{targetText(g)}</Badge>
        {g.status !== "active" && <Badge tone={g.status === "completed" ? "good" : g.status === "paused" ? "warn" : "muted"}>{g.status}</Badge>}
        <span>
          {g.domain === "personal" ? "Personal" : "Professional"}
          {g.area ? ` · ${g.area}` : ""}
          {g.targetDate ? ` · by ${fmtDay(g.targetDate)}` : ""}
        </span>
      </div>
      {g.description && <p className="mt-3 whitespace-pre-wrap">{g.description}</p>}
      <FormError error={error} />

      <Section title={`Progress ${PERIOD_LABEL[g.period]}`}>
        <ProgressBar ratio={p.ratio} met={p.met} />
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {progressText(g, p)}
          {att && <RiskBadge risk={att.risk.risk} />}
        </p>
        {att && (att.risk.risk === "at_risk" || att.risk.risk === "off_track") && (
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {att.risk.reason}
            {att.risk.perDay != null && (p.daysLeft ?? 0) > 1 && ` · about ${att.risk.perDay} a day to catch up`}
          </p>
        )}
        {att?.neglect.neglected && (
          <div className="mt-3 rounded-lg border border-[var(--color-warn)] p-3">
            <p className="text-sm">Nothing logged for {att.neglect.quietDays} days. What would you like to do?</p>
            <DecisionButtons g={g} reason="neglect" back={back} />
          </div>
        )}
        {history.length > 1 && (
          <div className="mt-4 flex items-end gap-1.5" aria-label="Previous periods">
            {history.map((h) => (
              <div key={h.from} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-16 w-full items-end">
                  <div
                    className={`w-full rounded-t ${h.met ? "bg-[var(--color-good)]" : "bg-[var(--color-accent)] opacity-60"}`}
                    style={{ height: `${Math.max(4, ((h.current ?? 0) / maxHist) * 100)}%` }}
                    title={`${h.current ?? 0}`}
                  />
                </div>
                <span className="text-[10px] text-[var(--color-muted)]">{fmtDay(h.from)}</span>
              </div>
            ))}
          </div>
        )}
        <form action={logGoalEntry} className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="goal_id" value={id} />
          <input type="hidden" name="back" value={back} />
          {g.metric === "duration_min" ? (
            <input type="number" name="duration" min={1} max={1440} required placeholder="Minutes" className={`${field} w-28`} aria-label="Minutes" />
          ) : g.metric !== "boolean" ? (
            <input type="number" name="value" step="any" min={0} defaultValue={g.metric === "count" ? 1 : undefined} required className={`${field} w-24`} aria-label={g.unit ?? "Value"} />
          ) : null}
          <input type="date" name="day" defaultValue={istDay(new Date())} className={field} aria-label="Day" />
          <input name="note" maxLength={1000} placeholder="Note (optional)" className={`${field} min-w-0 flex-[1_1_10rem]`} aria-label="Note" />
          <button className={button}>Log</button>
        </form>
      </Section>

      <Section title={`Habits (${habits.length})`}>
        {habits.length ? (
          <ul className="divide-y divide-[var(--color-line)]">
            {habits.map((h) => (
              <li key={h.id}>
                <ul>
                  <HabitRow h={h} back={back} />
                </ul>
                <details className="mb-2">
                  <summary className="cursor-pointer text-xs text-[var(--color-muted)]">Edit habit</summary>
                  <form action={editHabit} className="mt-2 space-y-2">
                    <input type="hidden" name="id" value={h.id} />
                    <input type="hidden" name="back" value={back} />
                    <input name="name" defaultValue={h.name} required maxLength={200} className={`${field} w-full`} aria-label="Name" />
                    <ScheduleFields defaults={h.schedule} />
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                        Remind me at
                        <input type="time" name="reminder" defaultValue={h.reminderTime ?? ""} className={field} />
                      </label>
                      <select name="active" defaultValue={h.active ? "1" : "0"} className={field} aria-label="Active">
                        <option value="1">Active</option>
                        <option value="0">Paused</option>
                      </select>
                      <button className={button}>Save</button>
                    </div>
                  </form>
                  <form action={removeHabit} className="mt-2">
                    <input type="hidden" name="id" value={h.id} />
                    <input type="hidden" name="back" value={back} />
                    <button className="text-xs text-[var(--color-bad)]">Delete habit and its check-ins</button>
                  </form>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">
            No habit feeds this goal. Add one on the <Link href="/goals">Goals page</Link> and pick this goal.
          </p>
        )}
      </Section>

      {d.tasks.length > 0 && (
        <Section title="Linked tasks">
          <ul className="space-y-1 text-sm">
            {d.tasks.map((t) => (
              <li key={t.id} className={t.status === "done" || t.status === "cancelled" ? "text-[var(--color-muted)] line-through" : ""}>
                {t.title}
                {t.dueAt && <span className="text-[var(--color-muted)]"> · {fmtDateTime(t.dueAt)}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Log">
        {d.activities.length ? (
          <ul className="divide-y divide-[var(--color-line)] text-sm">
            {d.activities.map((a) => (
              <li key={a.id} className="flex items-baseline gap-3 py-1.5">
                <span className="w-16 shrink-0 text-[var(--color-muted)]">{fmtDay(a.day)}</span>
                <span className="min-w-0 flex-1">
                  {a.status === "skipped" ? "Skipped" : a.kind === "task_done" ? "Task done" : a.durationMin != null ? `${a.durationMin} min` : `${a.value}${g.unit ? ` ${g.unit}` : ""}`}
                  {a.kind === "habit" && " · habit"}
                  {a.note && <span className="text-[var(--color-muted)]"> · {a.note}</span>}
                </span>
                <form action={removeActivity}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="back" value={back} />
                  <button aria-label="Delete entry" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-bad)]">
                    ✕
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">Nothing logged yet.</p>
        )}
      </Section>

      {decisions.length > 0 && (
        <Section title="Your decisions">
          <ul className="space-y-1 text-sm">
            {decisions.map((x, i) => (
              <li key={i}>
                <span className="text-[var(--color-muted)]">{fmtDateTime(x.at)} · </span>
                {x.choice === "continue" ? `Kept going${x.detail?.until ? ` (quiet until ${String(x.detail.until)})` : ""}` : x.choice === "change_target" ? `Changed target ${String(x.detail?.from ?? "")} → ${String(x.detail?.to ?? "")}` : x.choice === "pause" ? "Paused" : "Archived"}
                <span className="text-[var(--color-muted)]"> ({x.reason})</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Goal settings">
        <form action={editGoal} className="grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="back" value={back} />
          <input name="title" defaultValue={g.title} required maxLength={300} className={`${field} sm:col-span-2`} aria-label="Title" />
          <textarea name="description" defaultValue={g.description ?? ""} rows={2} placeholder="Why it matters" className={`${field} sm:col-span-2`} aria-label="Description" />
          {g.metric !== "boolean" && (
            <div className="flex items-center gap-2 sm:col-span-2">
              <input type="number" name="target" step="any" min={0} defaultValue={g.targetValue ?? ""} className={`${field} w-24`} aria-label="Target" />
              <input name="unit" defaultValue={g.unit ?? ""} maxLength={40} placeholder="unit" className={`${field} w-32`} aria-label="Unit" />
              <select name="period" defaultValue={g.period} className={field} aria-label="Per">
                <option value="day">per day</option>
                <option value="week">per week</option>
                <option value="month">per month</option>
                <option value="quarter">per quarter</option>
                <option value="year">per year</option>
                <option value="total">in total</option>
              </select>
            </div>
          )}
          <label className="text-xs text-[var(--color-muted)]">
            By
            <input type="date" name="target_date" defaultValue={g.targetDate ?? ""} className={`${field} mt-0.5 block w-full`} />
          </label>
          <label className="text-xs text-[var(--color-muted)]">
            Status
            <select name="status" defaultValue={g.status} className={`${field} mt-0.5 block w-full`}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option value="abandoned">Abandoned</option>
            </select>
          </label>
          <div className="sm:col-span-2">
            <button className={button}>Save</button>
          </div>
        </form>
        <form action={removeGoal} className="mt-3">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="back" value={back} />
          <button className="text-xs text-[var(--color-bad)]">Delete goal and its log</button>
        </form>
      </Section>
    </main>
  );
}
