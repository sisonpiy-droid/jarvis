import { draftWeekPlan, learnFromMessages, ownerMessagesBetween, type ModelProvider } from "@jarvis/ai";
import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { Logger } from "@jarvis/shared";

// The evening job (every 15 min): the 20:30 check-in, then from 22:30 the day's learning — lasting facts from
// today's chats (one AI call, only if the owner chatted) and alert kinds the owner keeps ignoring. Each happens
// once a day: the check-in by its dedupe key, the learning by a day marker in jarvis.settings.

export const CHECKIN_FROM_MIN = 20 * 60 + 30;
const CHECKIN_UNTIL_MIN = 23 * 60;
export const LEARN_FROM_MIN = 22 * 60 + 30;
export const PLAN_FROM_MIN = 19 * 60;
const LEARN_MARK_KEY = "learning.last_day";

const istMinutes = (now: Date) => Math.floor(((now.getTime() / 60_000 + 330) % 1440 + 1440) % 1440);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The Sunday push: the first few blocks; the whole plan is on /plan. */
export function planText(p: db.WeekPlan): string {
  const lines = p.blocks.slice(0, 5).map((b) => `- ${esc(db.blockLine(b, false))}`);
  const more = p.blocks.length > 5 ? [`+${p.blocks.length - 5} more`] : [];
  return [`🗓️ <b>Your plan for the week: ${p.blocks.length} work block${p.blocks.length === 1 ? "" : "s"}</b>`, ...(p.note ? [esc(p.note)] : []), ...lines, ...more, "Approve or change it in JARVIS."].join("\n");
}

export interface EveningSummary {
  checkin: boolean;
  learned: boolean;
  memories: number;
  rejected: number;
  quietened: string[];
  planned: number | null;
  errors: string[];
}

export async function runEvening(sql: Sql, now: Date, model: ModelProvider | null, log?: Logger): Promise<EveningSummary> {
  const out: EveningSummary = { checkin: false, learned: false, memories: 0, rejected: 0, quietened: [], planned: null, errors: [] };
  const m = istMinutes(now);
  const day = db.istDay(now);

  if (m >= CHECKIN_FROM_MIN && m < CHECKIN_UNTIL_MIN) {
    const [sent] = await sql`select 1 from jarvis.notifications where dedupe_key = ${`checkin:${day}`}`;
    if (!sent) {
      const c = await db.loadCheckin(sql, now);
      out.checkin = (await db.enqueueNotifications(sql, [{ dedupeKey: `checkin:${day}`, priority: "normal", text: db.checkinText(c), scheduledFor: now.toISOString() }])) > 0;
    }
  }

  // Sunday 19:00: next week's plan, drafted once (any plan made today counts) and offered for approval.
  if (model && db.weekday(day) === 7 && m >= PLAN_FROM_MIN) {
    const cur = await db.getWeekPlan(sql);
    if (!cur || db.istDay(cur.createdAt) !== day) {
      try {
        const plan = await draftWeekPlan(model, await db.loadSituation(sql, now), now);
        await db.saveWeekPlan(sql, plan);
        out.planned = plan.blocks.length;
        await db.enqueueNotifications(sql, [{ dedupeKey: `plan:${day}`, priority: "normal", text: planText(plan), scheduledFor: now.toISOString() }]);
      } catch (err) {
        out.errors.push(`plan: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
    }
  }

  if (m >= LEARN_FROM_MIN && (await db.getSetting<string>(sql, LEARN_MARK_KEY)) !== day) {
    // Marked first: a failure isn't retried every 15 minutes (it costs AI calls); tomorrow runs again.
    await db.putSetting(sql, LEARN_MARK_KEY, day);
    out.learned = true;
    if (model) {
      try {
        const msgs = await ownerMessagesBetween(sql, db.dayStartIso(day), db.dayStartIso(db.addDays(day, 1)));
        const r = await learnFromMessages(sql, model, msgs);
        out.memories = r.saved.length;
        out.rejected = r.rejected.length;
        if (r.saved.length)
          await db.enqueueNotifications(sql, [
            {
              dedupeKey: `learned.memory:${day}`,
              priority: "low",
              text: `🧠 <b>Learned ${r.saved.length} thing${r.saved.length > 1 ? "s" : ""} about you today</b>\n${r.saved.map((x) => `- ${esc(x.content)}`).join("\n")}\nWrong? Forget it in Settings → Memory.`,
              scheduledFor: now.toISOString(),
            },
          ]);
      } catch (err) {
        out.errors.push(`memories: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
        log?.warn("learning from chat failed", { error: err });
      }
    }
    try {
      out.quietened = (await db.learnAlertHabits(sql, now)).filter((c) => c.action === "quiet").map((c) => c.category);
    } catch (err) {
      out.errors.push(`alerts: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
  }
  return out;
}
