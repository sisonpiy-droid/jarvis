import * as db from "@jarvis/db";
import type { PendingDelivery, RoutableNotification, Sql } from "@jarvis/db";
import type { Logger } from "@jarvis/shared";
import { emailHtml, sendEmail, type EmailConfig } from "./email";
import { planMessages, type Channel } from "./index";
import { pushBudget, route, telegramFallbackOnPushFailure, type ChannelAvailability } from "./policy";
import { renderNotification, toPlainText } from "./render";
import { LEARNED_KEY, parseSettings, SETTINGS_KEY, type Level, type NotificationSettings } from "./settings";
import { sendPush, type PushMessage, type VapidKeys } from "./webpush";

// The notification service. Runs inside the `notify` job (every minute):
//   1. route  — due queued notifications become inbox items (status 'sent') + one delivery per external channel
//   2. escalate — unread critical items get an email after N minutes
//   3. deliver — push (capped, digested), email, and legacy Telegram; retries; Telegram fallback for failed pushes
// Deterministic throughout: no AI involved in deciding or sending.

export interface NotifyChannels {
  /** Absolute dashboard origin, for links in pushes and emails. */
  baseUrl: string;
  vapid?: VapidKeys | null;
  email?: EmailConfig | null;
  /** Legacy channel, kept for rollback until Phase 11. */
  telegram?: Channel | null;
  /** Loads an attached file (sha256) for Telegram; null when it can't be sent (missing, too big). */
  file?: ((sha256: string) => Promise<{ bytes: Uint8Array; name: string; mime: string } | null>) | null;
}

export interface DispatchStats {
  routed: number;
  deferred: number;
  escalated: number;
  push: { sent: number; failed: number; skipped: number };
  email: { sent: number; failed: number };
  telegram: { sent: number; failed: number };
}

const PUSH_MAX_ATTEMPTS = 3;
const EMAIL_MAX_ATTEMPTS = 3;
const TELEGRAM_MAX_ATTEMPTS = 5;
const DIGEST_OVER = 3;

const HABIT_ACTIONS = [
  { action: "habit-done", title: "✅ Done" },
  { action: "habit-skip", title: "Skip today" },
];

const CHECKIN_ACTIONS = [{ action: "checkin-move", title: "Move the rest to tomorrow" }];

const URGENCY: Record<Level, PushMessage["urgency"]> = { urgent: "high", high: "high", normal: "normal", low: "low" };

/** The push for one notification. Pure (exported for tests). */
export function pushMessage(n: RoutableNotification, abs: (path: string) => string): PushMessage {
  const r = renderNotification(n.text);
  return {
    title: r.title,
    body: r.body,
    url: abs(n.url),
    tag: `jarvis-${n.id}`,
    ids: [n.id],
    urgency: URGENCY[n.priority as Level],
    ttl: n.priority === "urgent" ? 6 * 3600 : 24 * 3600,
    // Habit check-ins can be answered from the notification itself (Android; iPhone opens the page).
    ...(n.dedupeKey.startsWith("habit.reminder:") ? { actions: HABIT_ACTIONS, ttl: 6 * 3600 } : {}),
    // The evening check-in offers one tap to move today's unfinished tasks to tomorrow (when there are some).
    ...(n.dedupeKey.startsWith("checkin:") && n.text.includes("Still open") ? { actions: CHECKIN_ACTIONS, ttl: 6 * 3600 } : {}),
  };
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function loadNotificationSettings(sql: Sql): Promise<NotificationSettings> {
  const [stored, learned] = await Promise.all([db.getSetting(sql, SETTINGS_KEY).catch(() => null), db.getSetting<{ quiet?: Record<string, unknown> }>(sql, LEARNED_KEY).catch(() => null)]);
  return { ...parseSettings(stored), learnedQuiet: Object.keys(learned?.quiet ?? {}) };
}

export async function runNotificationService(
  sql: Sql,
  ch: NotifyChannels,
  opts: { now?: Date; log?: Logger; fetch?: typeof fetch } = {},
): Promise<DispatchStats> {
  const now = opts.now ?? new Date();
  const log = opts.log;
  const settings = await loadNotificationSettings(sql);
  const subs = ch.vapid ? await db.activePushSubscriptions(sql) : [];
  const avail: ChannelAvailability = { push: !!ch.vapid && subs.length > 0, email: !!ch.email, telegram: !!ch.telegram };
  const stats: DispatchStats = { routed: 0, deferred: 0, escalated: 0, push: { sent: 0, failed: 0, skipped: 0 }, email: { sent: 0, failed: 0 }, telegram: { sent: 0, failed: 0 } };
  const abs = (url: string) => (/^https?:\/\//.test(url) ? url : `${ch.baseUrl.replace(/\/+$/, "")}${url}`);

  // 1. Route
  for (const n of await db.dueForRouting(sql)) {
    const d = route({ priority: n.priority, category: n.category }, settings, now, avail);
    if (d.defer) {
      stats.deferred++;
      continue;
    }
    await db.markRouted(sql, n, d.deliveries);
    stats.routed++;
  }

  // 2. Escalate unread critical items
  if (settings.routes.urgent.email === "escalate" && (avail.email || (avail.telegram && settings.telegram !== "off"))) {
    const cutoff = new Date(now.getTime() - settings.escalateAfterMinutes * 60_000);
    for (const n of await db.unreadCriticalBefore(sql, cutoff)) {
      const channel = avail.email ? "email" : "telegram";
      await db.addDelivery(sql, n.id, channel, "escalation");
      await db.markEscalated(sql, n.id);
      stats.escalated++;
    }
  }

  // 3a. Push
  const pushes = await db.pendingDeliveries(sql, "push");
  if (pushes.length) {
    const fallback = async (failed: PendingDelivery[], why: string) => {
      for (const p of failed) {
        if (telegramFallbackOnPushFailure(p.notification.priority as Level, settings, avail.telegram)) await db.addDelivery(sql, p.notification.id, "telegram", `fallback:${why}`);
      }
    };
    if (!avail.push) {
      await db.markDeliveriesSkipped(sql, pushes.map((p) => p.id), "no_device");
      stats.push.skipped += pushes.length;
      await fallback(pushes, "no_device");
    } else {
      let budget = pushBudget(await db.pushSentSince(sql, new Date(now.getTime() - 3_600_000)), settings);
      // The morning brief ("Your day is ready") is always pushed on its own: outside the hourly cap and the digest.
      const briefs = pushes.filter((p) => p.notification.category === "brief");
      const send: PendingDelivery[] = [];
      const capped: PendingDelivery[] = [];
      for (const p of pushes) {
        if (p.notification.category === "brief") continue;
        if (p.notification.priority === "urgent") send.push(p);
        else if (budget > 0) {
          send.push(p);
          budget--;
        } else capped.push(p);
      }
      if (capped.length) {
        await db.markDeliveriesSkipped(sql, capped.map((p) => p.id), "rate_limited");
        stats.push.skipped += capped.length;
      }
      type Batch = { items: PendingDelivery[]; msg: PushMessage };
      const one = (p: PendingDelivery): Batch => ({ items: [p], msg: pushMessage(p.notification, abs) });
      const digest = (items: PendingDelivery[]): Batch => ({
        items,
        msg: {
          title: `JARVIS · ${items.length} updates`,
          body: items.slice(0, 4).map((p) => renderNotification(p.notification.text).title).join("\n") + (items.length > 4 ? `\n+${items.length - 4} more` : ""),
          url: abs("/inbox"),
          tag: "jarvis-digest",
          ids: items.map((p) => p.notification.id),
          urgency: items.some((p) => p.notification.priority === "urgent") ? "high" : "normal",
        },
      });
      const batches: Batch[] = [...briefs.map(one), ...(send.length > DIGEST_OVER ? [digest(send)] : send.map(one))];
      for (const b of batches) {
        let ok = 0;
        let lastError = "";
        for (const s of subs) {
          const res = await sendPush(s, b.msg, ch.vapid!, opts.fetch);
          if (res.ok) ok++;
          else lastError = res.error;
          await db.recordPushResult(sql, s.id, res.ok ? "ok" : res.gone ? "gone" : "error");
        }
        const ids = b.items.map((p) => p.id);
        if (ok) {
          await db.markDeliveriesSent(sql, ids, `${ok}/${subs.length} devices`);
          stats.push.sent += ids.length;
        } else {
          log?.warn("push failed on every device", { error: lastError });
          const dead = new Set(await db.markDeliveriesAttemptFailed(sql, ids, lastError || "no device accepted", PUSH_MAX_ATTEMPTS));
          stats.push.failed += ids.length;
          await fallback(b.items.filter((p) => dead.has(p.id)), "push_failed");
        }
      }
    }
  }

  // 3b. Email
  const emails = await db.pendingDeliveries(sql, "email");
  if (emails.length) {
    if (!ch.email) {
      await db.markDeliveriesSkipped(sql, emails.map((e) => e.id), "not_configured");
    } else {
      const groups = emails.length > DIGEST_OVER ? [emails] : emails.map((e) => [e]);
      for (const g of groups) {
        const ids = g.map((e) => e.id);
        const one = g.length === 1 ? renderNotification(g[0]!.notification.text) : null;
        const subject = one ? one.title : `JARVIS · ${g.length} updates`;
        const html = one
          ? emailHtml(subject, one.html, abs(g[0]!.notification.url))
          : emailHtml(subject, g.map((e) => `<div style="margin:0 0 16px">${renderNotification(e.notification.text).html}</div>`).join(""), abs("/inbox"));
        const text = g.map((e) => `${toPlainText(e.notification.text)}\n${abs(e.notification.url)}`).join("\n\n———\n\n");
        try {
          const id = await sendEmail(ch.email, { subject, html, text }, opts.fetch);
          await db.markDeliveriesSent(sql, ids, id);
          stats.email.sent += ids.length;
        } catch (err) {
          log?.warn("email failed", { error: err });
          await db.markDeliveriesAttemptFailed(sql, ids, message(err), EMAIL_MAX_ATTEMPTS);
          stats.email.failed += ids.length;
        }
      }
    }
  }

  // 3c. Telegram (legacy) — same digest behaviour as before Phase 1
  const tgs = await db.pendingDeliveries(sql, "telegram");
  if (tgs.length) {
    if (!ch.telegram || settings.telegram === "off") {
      await db.markDeliveriesSkipped(sql, tgs.map((t) => t.id), ch.telegram ? "telegram_off" : "not_configured");
    } else {
      const byNotification = new Map(tgs.map((t) => [t.notification.id, t]));
      for (const m of planMessages(tgs.map((t) => ({ id: t.notification.id, text: t.notification.text })))) {
        const ids = m.ids.map((nid) => byNotification.get(nid)!.id);
        try {
          const id = await ch.telegram.send(m.text);
          await db.markDeliveriesSent(sql, ids, id);
          stats.telegram.sent += ids.length;
        } catch (err) {
          log?.warn("telegram send failed", { error: err });
          await db.markDeliveriesAttemptFailed(sql, ids, message(err), TELEGRAM_MAX_ATTEMPTS);
          stats.telegram.failed += ids.length;
          continue;
        }
        // Attached files follow the message. Best effort: the message is already out, so a failed file isn't retried.
        for (const sha of new Set(m.ids.flatMap((nid) => byNotification.get(nid)!.notification.files ?? []))) {
          try {
            const f = await ch.file?.(sha);
            if (f && ch.telegram.sendFile) await ch.telegram.sendFile(f.bytes, f.name, f.mime);
          } catch (err) {
            log?.warn("telegram file failed", { error: err });
          }
        }
      }
    }
  }
  return stats;
}
