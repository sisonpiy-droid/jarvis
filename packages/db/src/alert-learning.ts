import type { Sql } from "./client";
import { getSetting, putSetting } from "./notifications";
import { enqueueNotifications } from "./repo";
import { istDay } from "./progress";

// Alerts that learn: a kind of push the owner never opens stops pushing (it still lands in the inbox). Counted
// over two weeks from real deliveries — a tap on the push, or Done / Skip, or logging that habit the same day,
// counts as opened; "mark all read" doesn't. High and urgent items always push, deadlines and classes are never
// quietened, the owner can turn a kind back on (then it is never quietened again), and a quiet kind gets another
// chance after a month.

/** jarvis.settings key; @jarvis/notify reads the same key (LEARNED_KEY) when routing. */
export const ALERT_LEARNING_KEY = "notifications.learned";
export const LEARN_WINDOW_DAYS = 14;
export const LEARN_MIN_PUSHES = 6;
export const QUIET_RETRY_DAYS = 30;
/** Never quietened: things with a cost if missed, things the owner asked for, and system warnings. */
export const PROTECTED_CATEGORIES = ["deadline", "assignment", "class", "brief", "draft", "reminder", "system"];

export const CATEGORY_LABEL: Record<string, string> = {
  habit: "Habit reminders",
  goal: "Goal nudges",
  task: "Task reminders",
  announcement: "Announcements",
  material: "New class material",
  calendar: "Calendar heads-ups",
};
export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? `${c[0]?.toUpperCase() ?? ""}${c.slice(1)} alerts`;

export interface LearnedRouting {
  quiet: Record<string, { since: string; ignored: number }>;
  /** Kinds the owner turned back on: never quietened again. */
  keep: string[];
}

export interface Engagement {
  category: string;
  pushed: number;
  opened: number;
}

export async function getLearnedRouting(sql: Sql): Promise<LearnedRouting> {
  const v = await getSetting<Partial<LearnedRouting>>(sql, ALERT_LEARNING_KEY).catch(() => null);
  return { quiet: v?.quiet && typeof v.quiet === "object" ? v.quiet : {}, keep: Array.isArray(v?.keep) ? v.keep.map(String) : [] };
}

/** Normal/low pushes sent per category in the window, and how many were opened (or acted on). */
export async function pushEngagement(sql: Sql, now: Date): Promise<Engagement[]> {
  const since = new Date(now.getTime() - LEARN_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await sql`
    select n.category,
           count(*)::int as pushed,
           count(*) filter (where n.opened_at is not null or exists (
             select 1 from jarvis.activities a
              where n.dedupe_key like 'habit.reminder:%'
                and a.habit_id::text = split_part(n.dedupe_key, ':', 2)
                and a.day::text = split_part(n.dedupe_key, ':', 3)))::int as opened
      from jarvis.notification_deliveries d
      join jarvis.notifications n on n.id = d.notification_id
     where d.channel = 'push' and d.status = 'sent' and d.sent_at >= ${since}
       and n.priority in ('normal', 'low') and n.category is not null
     group by n.category`;
  return rows.map((r) => ({ category: String(r.category), pushed: Number(r.pushed), opened: Number(r.opened) }));
}

export interface LearningChange {
  category: string;
  action: "quiet" | "retry";
  ignored: number;
}

/** Pure: the next learned routing and what changed. */
export function decideAlertLearning(stats: Engagement[], cur: LearnedRouting, now: Date): { next: LearnedRouting; changes: LearningChange[] } {
  const next: LearnedRouting = { quiet: { ...cur.quiet }, keep: [...cur.keep] };
  const changes: LearningChange[] = [];
  for (const [c, q] of Object.entries(next.quiet)) {
    if (now.getTime() - Date.parse(q.since) >= QUIET_RETRY_DAYS * 86_400_000) {
      delete next.quiet[c];
      changes.push({ category: c, action: "retry", ignored: q.ignored });
    }
  }
  for (const s of stats) {
    if (PROTECTED_CATEGORIES.includes(s.category) || next.keep.includes(s.category) || next.quiet[s.category] || changes.some((x) => x.category === s.category)) continue;
    if (s.pushed >= LEARN_MIN_PUSHES && s.opened === 0) {
      next.quiet[s.category] = { since: now.toISOString(), ignored: s.pushed };
      changes.push({ category: s.category, action: "quiet", ignored: s.pushed });
    }
  }
  return { next, changes };
}

/** Runs the learning and tells the owner (in the inbox only) about each kind that went quiet. */
export async function learnAlertHabits(sql: Sql, now: Date): Promise<LearningChange[]> {
  const [stats, cur] = await Promise.all([pushEngagement(sql, now), getLearnedRouting(sql)]);
  const { next, changes } = decideAlertLearning(stats, cur, now);
  if (!changes.length) return [];
  await putSetting(sql, ALERT_LEARNING_KEY, next);
  const day = istDay(now);
  const quiet = changes.filter((c) => c.action === "quiet");
  if (quiet.length)
    await enqueueNotifications(
      sql,
      quiet.map((c) => ({
        dedupeKey: `learned.quiet:${c.category}:${day}`,
        priority: "low" as const,
        text: `🔕 <b>${categoryLabel(c.category)} now go to your inbox only</b>\nYou didn't open the last ${c.ignored}. Urgent ones still reach your phone. Turn them back on in Settings.`,
        scheduledFor: now.toISOString(),
      })),
    );
  return changes;
}

/** "Turn back on": push again and never quieten this kind. */
export async function keepAlertCategory(sql: Sql, category: string): Promise<void> {
  const cur = await getLearnedRouting(sql);
  delete cur.quiet[category];
  if (!cur.keep.includes(category)) cur.keep.push(category);
  await putSetting(sql, ALERT_LEARNING_KEY, cur);
}

/** A push was tapped (or answered with a button): the engagement signal. */
export async function markOpened(sql: Sql, ids: number[]): Promise<void> {
  if (ids.length) await sql`update jarvis.notifications set opened_at = coalesce(opened_at, now()), read_at = coalesce(read_at, now()) where id = any(${ids})`;
}
