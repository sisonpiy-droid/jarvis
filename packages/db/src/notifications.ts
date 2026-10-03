import type { Sql } from "./client";
import { notificationMeta } from "./notification-meta";
import type { Priority } from "./repo";

// SQL for the notification service: routing queued rows, per-channel deliveries, the in-app inbox,
// push subscriptions and owner settings. Decisions live in @jarvis/notify (pure); this file only stores them.

export type DeliveryChannel = "push" | "email" | "telegram";

export interface RoutableNotification {
  id: number;
  dedupeKey: string;
  priority: Priority;
  text: string;
  category: string;
  url: string;
  createdAt: string;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

const toRoutable = (r: Record<string, unknown>): RoutableNotification => {
  const meta = notificationMeta(String(r.dedupe_key));
  return {
    id: Number(r.id),
    dedupeKey: String(r.dedupe_key),
    priority: r.priority as Priority,
    text: String(r.text),
    category: (r.category as string | null) ?? meta.category,
    url: (r.url as string | null) ?? meta.url,
    createdAt: iso(r.created_at)!,
  };
};

/** Queued notifications whose time has come, most urgent first. */
export async function dueForRouting(sql: Sql, limit = 50): Promise<RoutableNotification[]> {
  const rows = await sql`
    select id, dedupe_key, priority, text, category, url, created_at from jarvis.notifications
     where status = 'queued' and scheduled_for <= now()
     order by case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, created_at, id
     limit ${limit}`;
  return rows.map(toRoutable);
}

/** Marks a notification routed (visible in the inbox) and creates its external deliveries — atomically. */
export async function markRouted(sql: Sql, n: RoutableNotification, deliveries: Array<{ channel: DeliveryChannel; reason: string }>): Promise<void> {
  await sql.begin(async (tx) => {
    const done = await tx`
      update jarvis.notifications set status = 'sent', sent_at = now(), category = ${n.category}, url = ${n.url}
       where id = ${n.id} and status = 'queued' returning id`;
    if (!done.length) return; // someone else routed it
    for (const d of deliveries) {
      await tx`
        insert into jarvis.notification_deliveries (notification_id, channel, reason)
        values (${n.id}, ${d.channel}, ${d.reason}) on conflict (notification_id, channel) do nothing`;
    }
  });
}

/** Adds one more delivery for an already-routed notification (escalation or fallback). Returns false if it already existed. */
export async function addDelivery(sql: Sql, notificationId: number, channel: DeliveryChannel, reason: string): Promise<boolean> {
  const rows = await sql`
    insert into jarvis.notification_deliveries (notification_id, channel, reason)
    values (${notificationId}, ${channel}, ${reason}) on conflict (notification_id, channel) do nothing returning id`;
  return rows.length === 1;
}

export interface PendingDelivery {
  id: number;
  attempts: number;
  reason: string | null;
  notification: RoutableNotification;
}

export async function pendingDeliveries(sql: Sql, channel: DeliveryChannel, limit = 50): Promise<PendingDelivery[]> {
  const rows = await sql`
    select d.id as delivery_id, d.attempts, d.reason, n.id, n.dedupe_key, n.priority, n.text, n.category, n.url, n.created_at
      from jarvis.notification_deliveries d join jarvis.notifications n on n.id = d.notification_id
     where d.channel = ${channel} and d.status = 'pending'
     order by case n.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, d.id
     limit ${limit}`;
  return rows.map((r) => ({ id: Number(r.delivery_id), attempts: Number(r.attempts), reason: r.reason ?? null, notification: toRoutable(r) }));
}

export async function markDeliveriesSent(sql: Sql, ids: number[], providerId: string): Promise<void> {
  if (ids.length) await sql`update jarvis.notification_deliveries set status = 'sent', sent_at = now(), provider_id = ${providerId.slice(0, 200)}, attempts = attempts + 1 where id = any(${ids})`;
}

export async function markDeliveriesSkipped(sql: Sql, ids: number[], reason: string): Promise<void> {
  if (ids.length) await sql`update jarvis.notification_deliveries set status = 'skipped', reason = ${reason} where id = any(${ids})`;
}

/** Counts an attempt; after `maxAttempts` the delivery is failed for good. Returns the ids that are now failed. */
export async function markDeliveriesAttemptFailed(sql: Sql, ids: number[], error: string, maxAttempts: number): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await sql`
    update jarvis.notification_deliveries
       set attempts = attempts + 1, last_error = ${error.slice(0, 300)},
           status = case when attempts + 1 >= ${maxAttempts} then 'failed' else 'pending' end
     where id = any(${ids}) returning id, status`;
  return rows.filter((r) => r.status === "failed").map((r) => Number(r.id));
}

export async function pushSentSince(sql: Sql, since: Date): Promise<number> {
  const [r] = await sql`select count(*)::int as n from jarvis.notification_deliveries where channel = 'push' and status = 'sent' and sent_at >= ${since.toISOString()}`;
  return Number(r?.n ?? 0);
}

/** Routed critical items nobody has opened, older than the cutoff, not yet escalated. */
export async function unreadCriticalBefore(sql: Sql, cutoff: Date): Promise<RoutableNotification[]> {
  const rows = await sql`
    select id, dedupe_key, priority, text, category, url, created_at from jarvis.notifications
     where status = 'sent' and priority = 'urgent' and read_at is null and dismissed_at is null and escalated_at is null
       and sent_at < ${cutoff.toISOString()} and sent_at > ${new Date(cutoff.getTime() - 24 * 3_600_000).toISOString()}
     order by id limit 20`;
  return rows.map(toRoutable);
}

export async function markEscalated(sql: Sql, id: number): Promise<void> {
  await sql`update jarvis.notifications set escalated_at = now() where id = ${id}`;
}

// ── push subscriptions ───────────────────────────────────────────────────────

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
}

const toSub = (r: Record<string, unknown>): PushSubscriptionRow => ({
  id: Number(r.id),
  endpoint: String(r.endpoint),
  p256dh: String(r.p256dh),
  auth: String(r.auth),
  deviceLabel: (r.device_label as string | null) ?? null,
  userAgent: (r.user_agent as string | null) ?? null,
  createdAt: iso(r.created_at)!,
  lastSuccessAt: iso(r.last_success_at),
  lastFailureAt: iso(r.last_failure_at),
  consecutiveFailures: Number(r.consecutive_failures),
});

export async function activePushSubscriptions(sql: Sql): Promise<PushSubscriptionRow[]> {
  return (await sql`select * from jarvis.push_subscriptions where disabled_at is null order by id`).map(toSub);
}

export async function savePushSubscription(sql: Sql, s: { endpoint: string; p256dh: string; auth: string; deviceLabel?: string | null; userAgent?: string | null }): Promise<number> {
  const [r] = await sql`
    insert into jarvis.push_subscriptions (endpoint, p256dh, auth, device_label, user_agent)
    values (${s.endpoint}, ${s.p256dh}, ${s.auth}, ${s.deviceLabel ?? null}, ${s.userAgent?.slice(0, 300) ?? null})
    on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
      device_label = coalesce(excluded.device_label, jarvis.push_subscriptions.device_label), user_agent = excluded.user_agent,
      disabled_at = null, consecutive_failures = 0
    returning id`;
  return Number(r!.id);
}

export async function removePushSubscription(sql: Sql, by: { id?: number; endpoint?: string }): Promise<void> {
  if (by.id !== undefined) await sql`delete from jarvis.push_subscriptions where id = ${by.id}`;
  else if (by.endpoint) await sql`delete from jarvis.push_subscriptions where endpoint = ${by.endpoint}`;
}

export async function recordPushResult(sql: Sql, id: number, outcome: "ok" | "gone" | "error"): Promise<void> {
  if (outcome === "ok") await sql`update jarvis.push_subscriptions set last_success_at = now(), consecutive_failures = 0 where id = ${id}`;
  else if (outcome === "gone") await sql`update jarvis.push_subscriptions set disabled_at = now(), last_failure_at = now() where id = ${id}`;
  else await sql`update jarvis.push_subscriptions set last_failure_at = now(), consecutive_failures = consecutive_failures + 1 where id = ${id}`;
}

// ── in-app inbox ─────────────────────────────────────────────────────────────

export interface InboxItem {
  id: number;
  priority: Priority;
  category: string;
  url: string;
  text: string;
  at: string;
  readAt: string | null;
}

export async function inbox(sql: Sql, opts: { unreadOnly?: boolean; category?: string | null; limit?: number } = {}): Promise<InboxItem[]> {
  const rows = await sql`
    select id, dedupe_key, priority, text, category, url, created_at, sent_at, read_at from jarvis.notifications
     where status = 'sent' and dismissed_at is null
       ${opts.unreadOnly ? sql`and read_at is null` : sql``}
       ${opts.category ? sql`and category = ${opts.category}` : sql``}
     order by id desc limit ${opts.limit ?? 100}`;
  return rows.map((r) => {
    const n = toRoutable(r);
    return { id: n.id, priority: n.priority, category: n.category, url: n.url, text: n.text, at: iso(r.sent_at ?? r.created_at)!, readAt: iso(r.read_at) };
  });
}

export async function unreadCount(sql: Sql): Promise<number> {
  const [r] = await sql`select count(*)::int as n from jarvis.notifications where status = 'sent' and read_at is null and dismissed_at is null`;
  return Number(r?.n ?? 0);
}

export async function markRead(sql: Sql, ids: number[] | "all"): Promise<void> {
  if (ids === "all") await sql`update jarvis.notifications set read_at = now() where status = 'sent' and read_at is null`;
  else if (ids.length) await sql`update jarvis.notifications set read_at = coalesce(read_at, now()) where id = any(${ids})`;
}

export async function dismiss(sql: Sql, ids: number[]): Promise<void> {
  if (ids.length) await sql`update jarvis.notifications set dismissed_at = now(), read_at = coalesce(read_at, now()) where id = any(${ids})`;
}

// ── settings ─────────────────────────────────────────────────────────────────

export async function getSetting<T = unknown>(sql: Sql, key: string): Promise<T | null> {
  const [r] = await sql`select value from jarvis.settings where key = ${key}`;
  return (r?.value as T | undefined) ?? null;
}

export async function putSetting(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql`
    insert into jarvis.settings (key, value) values (${key}, ${sql.json(value as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

export interface ChannelStats {
  channel: DeliveryChannel;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  lastSentAt: string | null;
}

/** Delivery counts per channel over the last day (Status page). */
export async function deliveryStats(sql: Sql): Promise<ChannelStats[]> {
  const rows = await sql`
    select channel,
           count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status = 'skipped')::int as skipped, count(*) filter (where status = 'pending')::int as pending,
           max(sent_at) as last_sent
      from jarvis.notification_deliveries where created_at > now() - interval '24 hours' group by channel order by channel`;
  return rows.map((r) => ({ channel: r.channel, sent: r.sent, failed: r.failed, skipped: r.skipped, pending: r.pending, lastSentAt: iso(r.last_sent) }));
}
