import * as db from "@jarvis/db";
import type { GoalAttention, HabitSlip, NotificationDraft, Sql, TaskReminder } from "@jarvis/db";

// The engine job: goal risk and neglect, slipping habits, and task due reminders → notifications. Every
// alert's dedupe key names its window, so each fires at most once per period (and again only if it gets
// worse). Deterministic: the numbers come from @jarvis/db (risk.ts / progress.ts), no AI. It also makes the
// one-time offer to review old goal/project memories (memory.review:v1).

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtDue = (iso: string, dateOnly = false) =>
  new Intl.DateTimeFormat("en-IN", dateOnly ? { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" } : { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));

/** Risk alerts wait until the last 3 days of a period (or off track), so early-week slowness isn't nagged. */
const RISK_ALERT_DAYS_LEFT = 3;

const draft = (dedupeKey: string, priority: db.Priority, text: string, now: Date): NotificationDraft => ({ dedupeKey, priority, text, scheduledFor: now.toISOString() });

export function riskAlert(g: GoalAttention, now: Date): NotificationDraft | null {
  const r = g.risk;
  if (r.risk !== "at_risk" && r.risk !== "off_track") return null;
  if (g.period === "day") return null; // daily goals are covered by habit reminders
  const daysLeft = g.progress.daysLeft ?? Infinity;
  if (r.risk === "at_risk" && daysLeft > RISK_ALERT_DAYS_LEFT) return null;
  const window = db.riskWindowKey(g, g.progress);
  const unit = g.metric === "duration_min" ? "min" : (g.unit ?? "");
  const need = r.remaining != null ? `${r.remaining} ${unit} to go`.replace(/\s+/g, " ") : "";
  const pace = r.perDay != null && daysLeft > 1 ? ` — about ${r.perDay} a day` : "";
  return draft(
    `goal.risk:${g.id}:${window}:${r.risk}`,
    r.risk === "off_track" ? "high" : "normal",
    `${r.risk === "off_track" ? "🔴" : "🟠"} <b>${esc(g.title)}</b> is ${r.risk === "off_track" ? "off track" : "at risk"}\n${esc(r.reason)}. ${esc(need)}${esc(pace)}.`,
    now,
  );
}

export function neglectAlert(g: GoalAttention, now: Date): NotificationDraft | null {
  if (!g.neglect.neglected) return null;
  // Once per quiet stretch: the key names the last entry (or the start, if never logged).
  return draft(
    `goal.neglect:${g.id}:${g.lastEntry ?? `start-${g.startDate}`}`,
    "normal",
    `💤 <b>${esc(g.title)}</b>: nothing logged for ${g.neglect.quietDays} days\nKeep going, pause it, change the target, or archive it?`,
    now,
  );
}

export function slipAlert(s: HabitSlip, now: Date): NotificationDraft {
  return draft(`habit.slipping:${s.habit.id}:${s.since}`, "normal", `⚠️ <b>${esc(s.habit.name)}</b> missed ${s.missed} times in a row\nOne check-in today restarts it.`, now);
}

export function taskAlert(t: TaskReminder, now: Date): NotificationDraft {
  const where = t.projectTitle ? ` · ${esc(t.projectTitle)}` : "";
  return t.kind === "prep"
    ? draft(`task.prep:${t.id}:${t.dueAt}`, "high", `📚 <b>${esc(t.title)}</b>\nExam ${fmtDue(t.dueAt)}${where}`, now)
    : draft(`task.due:${t.id}:${t.dueAt}`, "normal", `☑️ <b>${esc(t.title)}</b>\nDue ${fmtDue(t.dueAt)}${where}`, now);
}

/**
 * A one-time offer to review the old 'goal' / 'project' memories (saved before goals and projects were tracked).
 * The fixed dedupe key makes it fire once ever; nothing is converted unless the owner chooses on /settings/memory.
 */
export async function legacyMemoryNudge(sql: Sql, now: Date): Promise<NotificationDraft | null> {
  const [r] = await sql`select count(*)::int as n from jarvis.memories where active and kind in ('goal', 'project') and reviewed_at is null`;
  const n = Number(r?.n ?? 0);
  if (n <= 0) return null;
  const text = `🧠 <b>${n} old ${n === 1 ? "note" : "notes"} could become real goals or projects</b>\nReview them once — nothing changes unless you choose.`;
  return { ...draft("memory.review:v1", "normal", text, now), url: "/settings/memory" };
}

export interface EngineSummary {
  goals: number;
  atRisk: number;
  offTrack: number;
  neglected: number;
  slipping: number;
  tasks: number;
  queued: number;
}

export async function runEngine(sql: Sql, now: Date): Promise<EngineSummary> {
  const [goals, slips, tasks, nudge] = await Promise.all([db.goalAttention(sql, now), db.habitSlips(sql, now), db.tasksToRemind(sql, now), legacyMemoryNudge(sql, now)]);
  const drafts: NotificationDraft[] = [];
  for (const g of goals) {
    const risk = riskAlert(g, now);
    // Getting better within a window never re-alerts: skip "at risk" if "off track" was already sent.
    const worse = risk?.dedupeKey.endsWith(":at_risk") ? risk.dedupeKey.replace(/:at_risk$/, ":off_track") : null;
    const alreadyWorse = worse ? (await sql`select 1 from jarvis.notifications where dedupe_key = ${worse}`).length > 0 : false;
    if (risk && !alreadyWorse) drafts.push(risk);
    const neglect = neglectAlert(g, now);
    if (neglect) drafts.push(neglect);
  }
  drafts.push(...slips.map((s) => slipAlert(s, now)), ...tasks.map((t) => taskAlert(t, now)));
  if (nudge) drafts.push(nudge);
  const queued = drafts.length ? await db.enqueueNotifications(sql, drafts) : 0;
  return {
    goals: goals.length,
    atRisk: goals.filter((g) => g.risk.risk === "at_risk").length,
    offTrack: goals.filter((g) => g.risk.risk === "off_track").length,
    neglected: goals.filter((g) => g.neglect.neglected).length,
    slipping: slips.length,
    tasks: tasks.length,
    queued,
  };
}
