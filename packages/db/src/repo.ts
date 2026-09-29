import type { Sql, Tx } from "./client";

// Thin, explicit SQL. Every write here is idempotent: re-running a sync over
// unchanged data only bumps last_seen_at.

export type ItemKind = "course" | "material" | "recording" | "assignment" | "event" | "announcement";

export interface StoredItem {
  sourceId: string;
  contentHash: string;
  data: Record<string, unknown>;
  removedAt: string | null;
  sortAt: string | null;
}

export interface ItemRow {
  kind: ItemKind;
  sourceId: string;
  contentHash: string;
  data: object;
  courseId: string | null;
  title: string;
  sortAt: string | null;
}

export interface EventDraft {
  type: string;
  kind: ItemKind | null;
  sourceId: string | null;
  payload: object;
  dedupeKey: string;
}

export type Priority = "urgent" | "high" | "normal" | "low";

export interface NotificationDraft {
  dedupeKey: string;
  priority: Priority;
  text: string;
  scheduledFor: string;
  /** Recorded but never sent — reserves the dedupe key (e.g. a reminder made redundant by a "new assignment" alert). */
  suppressed?: boolean;
}

export interface Integration {
  provider: string;
  status: "active" | "needs_login" | "error";
  secretSealed: string | null;
  sessionExpiresAt: string | null;
  baselinedKinds: string[];
  lastSuccessAt: string | null;
  lastFullAt: string | null;
  consecutiveFailures: number;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

// ── integrations ──────────────────────────────────────────────────────────────

export async function getIntegration(sql: Sql, provider: string): Promise<Integration | null> {
  const [r] = await sql`select * from jarvis.integrations where provider = ${provider}`;
  if (!r) return null;
  return {
    provider: r.provider,
    status: r.status,
    secretSealed: r.secret_sealed,
    sessionExpiresAt: iso(r.session_expires_at),
    baselinedKinds: r.baselined_kinds ?? [],
    lastSuccessAt: iso(r.last_success_at),
    lastFullAt: iso(r.last_full_at),
    consecutiveFailures: r.consecutive_failures,
  };
}

/** Saves a (possibly rotated) sealed session and marks the integration healthy. */
export async function saveSession(sql: Sql, provider: string, sealed: string, expiresAt: string | null): Promise<void> {
  await sql`
    insert into jarvis.integrations (provider, secret_sealed, session_expires_at, status, updated_at)
    values (${provider}, ${sealed}, ${expiresAt}, 'active', now())
    on conflict (provider) do update
      set secret_sealed = excluded.secret_sealed, session_expires_at = excluded.session_expires_at,
          status = 'active', updated_at = now()`;
}

export async function recordSuccess(sql: Sql | Tx, provider: string, opts: { full: boolean; baselined: string[] }): Promise<void> {
  await sql`
    update jarvis.integrations
       set last_success_at = now(), consecutive_failures = 0, last_error = null, status = 'active',
           last_full_at = case when ${opts.full} then now() else last_full_at end,
           baselined_kinds = (select array(select distinct unnest(baselined_kinds || ${opts.baselined}::text[]))),
           updated_at = now()
     where provider = ${provider}`;
}

export async function recordFailure(sql: Sql, provider: string, error: string, needsLogin: boolean): Promise<number> {
  const [r] = await sql`
    update jarvis.integrations
       set consecutive_failures = consecutive_failures + 1, last_error = ${error.slice(0, 500)},
           status = case when ${needsLogin} then 'needs_login' else status end, updated_at = now()
     where provider = ${provider}
     returning consecutive_failures`;
  return r?.consecutive_failures ?? 1;
}

// ── lock ──────────────────────────────────────────────────────────────────────

/** Lease lock: succeeds if free or expired. Survives crashes (the lease just lapses). */
export async function acquireLock(sql: Sql, name: string, holder: string, ttlMs: number): Promise<boolean> {
  const rows = await sql`
    insert into jarvis.locks (name, holder, locked_until)
    values (${name}, ${holder}, now() + ${ttlMs} * interval '1 millisecond')
    on conflict (name) do update set holder = excluded.holder, locked_until = excluded.locked_until
      where jarvis.locks.locked_until < now()
    returning holder`;
  return rows.length === 1;
}

export async function releaseLock(sql: Sql, name: string, holder: string): Promise<void> {
  await sql`delete from jarvis.locks where name = ${name} and holder = ${holder}`;
}

// ── items ─────────────────────────────────────────────────────────────────────

export async function loadItems(sql: Sql, kind: ItemKind): Promise<Map<string, StoredItem>> {
  const rows = await sql`select source_id, content_hash, data, removed_at, sort_at from jarvis.lms_items where kind = ${kind}`;
  return new Map(
    rows.map((r) => [
      r.source_id as string,
      { sourceId: r.source_id, contentHash: r.content_hash, data: r.data, removedAt: iso(r.removed_at), sortAt: iso(r.sort_at) },
    ]),
  );
}

export async function instructorByCourse(sql: Sql): Promise<Map<string, string | null>> {
  const rows = await sql`select source_id, data ->> 'instructor' as instructor from jarvis.lms_items where kind = 'course'`;
  return new Map(rows.map((r) => [r.source_id as string, (r.instructor as string | null) ?? null]));
}

export interface ChangeSet {
  upserts: ItemRow[];          // created, changed or reappeared
  versions: ItemRow[];         // created or content-changed
  touched: Array<{ kind: ItemKind; sourceIds: string[] }>; // seen, unchanged
  removed: Array<{ kind: ItemKind; sourceIds: string[] }>;
  events: EventDraft[];
  notifications: NotificationDraft[];
}

/** Applies one sync's results atomically: items, history, events and notifications commit together or not at all. */
export async function applyChanges(sql: Sql, cs: ChangeSet): Promise<{ newNotifications: number }> {
  return sql.begin(async (tx) => {
    for (const r of cs.upserts) {
      await tx`
        insert into jarvis.lms_items (kind, source_id, content_hash, data, course_id, title, sort_at)
        values (${r.kind}, ${r.sourceId}, ${r.contentHash}, ${tx.json(r.data as never)}, ${r.courseId}, ${r.title}, ${r.sortAt})
        on conflict (kind, source_id) do update
          set content_hash = excluded.content_hash, data = excluded.data, course_id = excluded.course_id,
              title = excluded.title, sort_at = excluded.sort_at, last_seen_at = now(), removed_at = null,
              changed_at = case when jarvis.lms_items.content_hash <> excluded.content_hash then now() else jarvis.lms_items.changed_at end`;
    }
    for (const r of cs.versions) {
      await tx`
        insert into jarvis.item_versions (kind, source_id, content_hash, data)
        values (${r.kind}, ${r.sourceId}, ${r.contentHash}, ${tx.json(r.data as never)})
        on conflict do nothing`;
    }
    for (const t of cs.touched) {
      if (t.sourceIds.length) await tx`update jarvis.lms_items set last_seen_at = now() where kind = ${t.kind} and source_id = any(${t.sourceIds})`;
    }
    for (const t of cs.removed) {
      if (t.sourceIds.length) {
        await tx`update jarvis.lms_items set removed_at = now() where kind = ${t.kind} and source_id = any(${t.sourceIds}) and removed_at is null`;
      }
    }
    for (const e of cs.events) {
      await tx`
        insert into jarvis.domain_events (type, kind, source_id, payload, dedupe_key)
        values (${e.type}, ${e.kind}, ${e.sourceId}, ${tx.json(e.payload as never)}, ${e.dedupeKey})
        on conflict (dedupe_key) do nothing`;
    }
    let newNotifications = 0;
    for (const n of cs.notifications) {
      const rows = await tx`
        insert into jarvis.notifications (dedupe_key, priority, text, scheduled_for, status)
        values (${n.dedupeKey}, ${n.priority}, ${n.text}, ${n.scheduledFor}, ${n.suppressed ? "suppressed" : "queued"})
        on conflict (dedupe_key) do nothing
        returning id`;
      if (rows.length && !n.suppressed) newNotifications++;
    }
    return { newNotifications };
  });
}

/** Inserts standalone notifications (session warnings, failures) with the same dedupe guarantee. */
export async function enqueueNotifications(sql: Sql, drafts: NotificationDraft[]): Promise<number> {
  return applyChanges(sql, { upserts: [], versions: [], touched: [], removed: [], events: [], notifications: drafts }).then((r) => r.newNotifications);
}

// ── notification dispatch ─────────────────────────────────────────────────────

export interface QueuedNotification {
  id: number;
  priority: Priority;
  text: string;
}

export async function dueNotifications(sql: Sql): Promise<QueuedNotification[]> {
  const rows = await sql`
    select id, priority, text from jarvis.notifications
     where status = 'queued' and scheduled_for <= now()
     order by case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, created_at, id
     limit 50`;
  return rows.map((r) => ({ id: Number(r.id), priority: r.priority, text: r.text }));
}

export async function markSent(sql: Sql, ids: number[], providerMessageId: string): Promise<void> {
  if (ids.length) await sql`update jarvis.notifications set status = 'sent', sent_at = now(), provider_message_id = ${providerMessageId} where id = any(${ids})`;
}

export async function markAttemptFailed(sql: Sql, ids: number[], error: string, maxAttempts = 5): Promise<void> {
  if (!ids.length) return;
  await sql`
    update jarvis.notifications
       set attempts = attempts + 1, last_error = ${error.slice(0, 300)},
           status = case when attempts + 1 >= ${maxAttempts} then 'failed' else 'queued' end
     where id = any(${ids})`;
}

// ── sync runs ─────────────────────────────────────────────────────────────────

export async function startRun(sql: Sql, provider: string, kind: string, trigger: string): Promise<number> {
  const [r] = await sql`insert into jarvis.sync_runs (provider, kind, trigger) values (${provider}, ${kind}, ${trigger}) returning id`;
  return Number(r!.id);
}

export async function finishRun(
  sql: Sql,
  id: number,
  f: { status: "success" | "partial" | "failed" | "skipped"; requestCount?: number; counts?: object; changes?: object; notifications?: number; warnings?: unknown[]; error?: string },
): Promise<void> {
  await sql`
    update jarvis.sync_runs
       set status = ${f.status}, finished_at = now(), request_count = ${f.requestCount ?? null},
           counts = ${f.counts ? sql.json(f.counts as never) : null}, changes = ${f.changes ? sql.json(f.changes as never) : null},
           notifications = ${f.notifications ?? null},
           warnings = ${f.warnings?.length ? sql.json(f.warnings.slice(0, 50) as never) : null}, error = ${f.error?.slice(0, 1000) ?? null}
     where id = ${id}`;
}
