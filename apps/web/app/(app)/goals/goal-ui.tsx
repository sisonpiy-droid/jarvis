import Link from "next/link";
import { describeSchedule, PERIOD_LABEL, PER_LABEL, type Goal, type GoalAttention, type GoalProgress, type HabitSlip, type HabitWithStatus, type RiskResult } from "@jarvis/db";
import { Badge } from "../ui";
import { button, field } from "../tasks/task-ui";
import { checkHabit, decide } from "./actions";

// Shared by /goals, /goals/[id], the quick check-in page and Today. Plain forms: no client JavaScript needed.

const fmtNum = (v: number | null) => (v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));

export function targetText(g: Pick<Goal, "metric" | "targetValue" | "unit" | "period">): string {
  if (g.metric === "boolean") return `Once ${PER_LABEL[g.period]}`;
  if (g.targetValue == null) return `Track ${g.unit ?? "value"}`;
  return `${fmtNum(g.targetValue)} ${g.unit ?? (g.metric === "duration_min" ? "minutes" : "")} ${PER_LABEL[g.period]}`.replace(/\s+/g, " ").trim();
}

export function ProgressBar({ ratio, met }: { ratio: number | null; met: boolean }) {
  const pct = Math.round((ratio ?? 0) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-line)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${met ? "bg-[var(--color-good)]" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function progressText(g: Pick<Goal, "metric" | "unit" | "period">, p: GoalProgress): string {
  if (g.metric === "value") return p.current == null ? "No entries yet" : `Latest: ${fmtNum(p.current)}${g.unit ? ` ${g.unit}` : ""}${p.target ? ` (goal ${fmtNum(p.target)})` : ""}`;
  const unit = g.metric === "duration_min" ? "min" : (g.unit ?? "");
  const left = p.daysLeft != null && g.period !== "day" ? ` · ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left` : "";
  return `${fmtNum(p.current)} of ${fmtNum(p.target)} ${unit} ${PERIOD_LABEL[g.period]}${left}`.replace(/\s+/g, " ");
}

export function RiskBadge({ risk }: { risk: RiskResult["risk"] }) {
  if (risk === "at_risk") return <Badge tone="warn">At risk</Badge>;
  if (risk === "off_track") return <Badge tone="bad">Off track</Badge>;
  return null;
}

export function GoalCard({ g, p, risk, neglected }: { g: Goal; p: GoalProgress; risk?: RiskResult["risk"]; neglected?: boolean }) {
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <Link href={`/goals/${g.id}`} className="font-medium text-[var(--color-ink)] no-underline hover:underline">
          {g.title}
        </Link>
        <span className="shrink-0 text-xs text-[var(--color-muted)]">{targetText(g)}</span>
      </div>
      <div className="mt-2">
        <ProgressBar ratio={p.ratio} met={p.met} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <span>{progressText(g, p)}</span>
        {p.met && <Badge tone="good">Done {PERIOD_LABEL[g.period]}</Badge>}
        {risk && <RiskBadge risk={risk} />}
        {neglected && <Badge tone="warn">Quiet</Badge>}
        {g.status === "paused" && <Badge tone="warn">Paused</Badge>}
        {g.area && <span>· {g.area}</span>}
      </div>
    </li>
  );
}

const DOT: Record<string, string> = {
  done: "bg-[var(--color-good)]",
  skipped: "bg-[var(--color-warn)]",
  missed: "border border-[var(--color-bad)]",
  open: "border border-[var(--color-accent)]",
  rest: "bg-[var(--color-line)]",
  future: "bg-transparent",
};
const STATE_LABEL: Record<string, string> = { done: "done", skipped: "skipped", missed: "missed", open: "due", rest: "not scheduled", future: "" };

export function WeekDots({ week }: { week: HabitWithStatus["status"]["week"] }) {
  return (
    <span className="inline-flex gap-1" aria-label="Last 7 days">
      {week.map((d) => (
        <span key={d.day} title={`${d.day}: ${STATE_LABEL[d.state]}`} className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[d.state]}`} />
      ))}
    </span>
  );
}

function CheckButton({ habitId, status, label, back, tone }: { habitId: number; status: "done" | "skipped" | "undo"; label: string; back: string; tone: "primary" | "quiet" }) {
  return (
    <form action={checkHabit}>
      <input type="hidden" name="id" value={habitId} />
      <input type="hidden" name="status" value={status} />
      <input type="hidden" name="back" value={back} />
      <button className={tone === "primary" ? `${button} px-2.5 py-1` : "rounded-lg border border-[var(--color-line)] px-2.5 py-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]"}>{label}</button>
    </form>
  );
}

export function HabitRow({ h, back }: { h: HabitWithStatus; back: string }) {
  const st = h.status;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={`font-medium ${st.today === "done" ? "text-[var(--color-muted)]" : ""}`}>
          {st.today === "done" && "✅ "}
          {st.today === "skipped" && "⏭️ "}
          {h.name}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          <WeekDots week={st.week} />
          <span>{describeSchedule(h.schedule)}</span>
          {st.periodTarget != null && (
            <span>
              · {st.periodDone}/{st.periodTarget} {h.schedule.freq === "monthly" ? "this month" : "this week"}
            </span>
          )}
          {st.streak > 1 && <span>· 🔥 {st.streak}</span>}
          {h.reminderTime && <span>· ⏰ {h.reminderTime}</span>}
          {h.goalId && (
            <Link href={`/goals/${h.goalId}`} className="no-underline">
              · {h.goalTitle}
            </Link>
          )}
          {!h.active && <Badge>Paused</Badge>}
        </div>
      </div>
      {h.active && (
        <div className="flex gap-1.5">
          {st.today ? (
            <CheckButton habitId={h.id} status="undo" label="Undo" back={back} tone="quiet" />
          ) : (
            <>
              <CheckButton habitId={h.id} status="done" label="Done" back={back} tone="primary" />
              <CheckButton habitId={h.id} status="skipped" label="Skip" back={back} tone="quiet" />
            </>
          )}
        </div>
      )}
    </li>
  );
}

const WEEKDAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;

/** The schedule inputs used by the new-goal, new-habit and edit-habit forms (read by scheduleFrom). */
export function ScheduleFields({ defaults }: { defaults?: HabitWithStatus["schedule"] }) {
  const freq = !defaults || defaults.freq === "daily" ? "daily" : "days" in defaults ? "days" : defaults.freq;
  const times = defaults && "times" in defaults ? defaults.times : 3;
  const days = defaults && "days" in defaults ? defaults.days : [1, 3, 5];
  return (
    <fieldset className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <select name="freq" defaultValue={freq} className={field} aria-label="How often">
          <option value="daily">Every day</option>
          <option value="days">On these days</option>
          <option value="weekly">N times a week</option>
          <option value="monthly">N times a month</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
          N =
          <input type="number" name="times" min={1} max={31} defaultValue={times} className={`${field} w-16`} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {WEEKDAYS.map(([d, label]) => (
          <label key={d} className="flex items-center gap-1">
            <input type="checkbox" name="days" value={d} defaultChecked={days.includes(d)} /> {label}
          </label>
        ))}
        <span className="text-[var(--color-muted)]">(days apply to “On these days”)</span>
      </div>
    </fieldset>
  );
}

/** Continue / Pause / Change target / Archive — the answers to a neglect or risk prompt (each is recorded). */
export function DecisionButtons({ g, reason, back }: { g: Goal; reason: "neglect" | "risk"; back: string }) {
  const hidden = (
    <>
      <input type="hidden" name="id" value={g.id} />
      <input type="hidden" name="reason" value={reason} />
      <input type="hidden" name="back" value={back} />
    </>
  );
  const quiet = "rounded-lg border border-[var(--color-line)] px-2.5 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)]";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {(["continue", "pause", "archive"] as const).map((choice) => (
        <form key={choice} action={decide}>
          {hidden}
          <input type="hidden" name="choice" value={choice} />
          <button className={choice === "continue" ? `${button} px-2.5 py-1 text-xs` : quiet}>{choice === "continue" ? "Keep going" : choice === "pause" ? "Pause" : "Archive"}</button>
        </form>
      ))}
      {g.metric !== "boolean" && g.metric !== "value" && (
        <form action={decide} className="flex items-center gap-1">
          {hidden}
          <input type="hidden" name="choice" value="change_target" />
          <input type="number" name="target" step="any" min={0} required defaultValue={g.targetValue ?? undefined} className={`${field} w-16 py-1 text-xs`} aria-label="New target" />
          <button className={quiet}>Change target</button>
        </form>
      )}
    </div>
  );
}

/** The "Needs attention" list: goals at risk / off track / gone quiet, and habits slipping. `fold` tucks the decision buttons into a "Decide" fold (Today). */
export function AttentionList({ goals, habits, back, fold = false }: { goals: GoalAttention[]; habits: HabitSlip[]; back: string; fold?: boolean }) {
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {goals.map((g) => (
        <li key={`g${g.id}`} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/goals/${g.id}`} className="font-medium text-[var(--color-ink)] no-underline hover:underline">
              {g.title}
            </Link>
            <RiskBadge risk={g.risk.risk} />
            {g.neglect.neglected && <Badge tone="warn">Nothing logged for {g.neglect.quietDays} days</Badge>}
          </div>
          {(g.risk.risk === "at_risk" || g.risk.risk === "off_track") && (
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {g.risk.reason}
              {g.risk.perDay != null && (g.progress.daysLeft ?? 0) > 1 && ` · about ${g.risk.perDay} a day to catch up`}
            </p>
          )}
          {g.neglect.neglected &&
            (fold ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-[var(--color-muted)]">Decide</summary>
                <DecisionButtons g={g} reason="neglect" back={back} />
              </details>
            ) : (
              <DecisionButtons g={g} reason="neglect" back={back} />
            ))}
        </li>
      ))}
      {habits.map((s) => (
        <li key={`h${s.habit.id}`} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.habit.name}</span>
            <Badge tone="warn">Missed {s.missed} in a row</Badge>
          </div>
          <ul>
            <HabitRow h={s.habit} back={back} />
          </ul>
        </li>
      ))}
    </ul>
  );
}
