import * as db from "@jarvis/db";
import type { ModelProvider } from "@jarvis/ai";
import type { ChangeSet, EventDraft, ItemKind, ItemRow, NotificationDraft, Sql } from "@jarvis/db";
import {
  MesaAuthError,
  MesaClient,
  TokenProvider,
  extractLight,
  extractSnapshot,
  type CollectionName,
  type MesaAssignment,
  type MesaSnapshot,
} from "@jarvis/mesa";
import { fetchSubmissionTimes } from "./submissions";
import { fetchPendingFiles, type BlobStorage, type FetchResult } from "@jarvis/files";
import type { Channel, NotifyChannels } from "@jarvis/notify";
import type { Logger } from "@jarvis/shared";
import { dbSessionStore } from "./db-session";
import { diffItems, type Diff, type Keyed } from "./diff";
import {
  announcementRules,
  assignmentRules,
  baselineSummary,
  courseRules,
  eventRules,
  materialRules,
  recordingRules,
  reminderRules,
  type RuleContext,
  type RuleOutput,
} from "./rules";
import { deliveryTime } from "./time";
import { syncWork, type WorkSummary } from "./work";

const PROVIDER = "mesa";
const FULL_EVERY_MS = 6 * 3_600_000;
const SESSION_WARN_MS = 3 * 86_400_000;

export interface SyncDeps {
  sql: Sql;
  sessionKey: string;
  /** Legacy Telegram channel (rollback until Phase 11). Optional: push, email and the inbox work without it. */
  channel: Channel | null;
  /** Push / email configuration for the notification service (the in-app inbox needs none). */
  notify?: Omit<NotifyChannels, "telegram"> | null;
  /** Called with open, unsubmitted assignments that still need a draft (the `drafts` job, at most one per run). */
  onNewAssignments?: (ids: string[]) => Promise<void>;
  /** Private Google Calendar iCal URL; when set, the `calendar` job syncs it. */
  icsUrl?: string | null;
  /** MESA Nexus read-only token (NEXUS_TOKEN); when set, the `nexus` job syncs grades and attendance. */
  nexusToken?: string | null;
  /** When set, each MESA sync also downloads a few pending LMS files into Storage. */
  storage?: BlobStorage | null;
  /** Writes the brief's focus note (one call a day). Without it the brief uses the fixed-template note. */
  model?: ModelProvider | null;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
  maxConcurrency?: number;
  minGapMs?: number;
}

export interface SyncOptions {
  trigger: "schedule" | "manual";
  force?: "full" | "light";
  /** false = compute and store, but don't send anything (queued items go out next run). */
  send?: boolean;
}

export interface SyncSummary {
  status: "success" | "partial" | "failed" | "skipped";
  kind?: "full" | "light";
  runId?: number;
  requestCount?: number;
  counts?: Record<string, number>;
  changes?: Record<string, { created: number; changed: number; removed: number }>;
  queued?: number;
  sent?: number;
  files?: FetchResult;
  work?: WorkSummary;
  error?: string;
}

const KIND: Record<CollectionName, ItemKind> = {
  courses: "course",
  materials: "material",
  recordings: "recording",
  assignments: "assignment",
  events: "event",
  announcements: "announcement",
};

type AnyItem = Keyed & { title: string; courseId?: string | null };

function toRow(kind: ItemKind, item: AnyItem): ItemRow {
  const x = item as AnyItem & Record<string, unknown>;
  const sortAt =
    kind === "assignment" ? (x.dueAt as string | null) :
    kind === "event" ? (x.startAt as string) :
    kind === "announcement" ? (x.createdAt as string) :
    kind === "material" ? (x.lmsCreatedAt as string | null) :
    kind === "recording" ? (x.recordedOn as string | null) : null;
  return {
    kind,
    sourceId: item.sourceId,
    contentHash: item.contentHash,
    data: item,
    courseId: kind === "course" ? item.sourceId : (item.courseId ?? null),
    title: item.title,
    sortAt: sortAt ?? null,
  };
}

/**
 * One MESA sync: extract → diff → rules → one atomic write, then a few file downloads (they need this run's
 * signed URLs). Locking, notification delivery, the brief and drafting are separate jobs (see jobs.ts).
 */
export async function mesaSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncSummary> {
  const { sql, log } = deps;
  const now = deps.now?.() ?? new Date();
  const integ = await db.getIntegration(sql, PROVIDER);
  if (!integ?.secretSealed) throw new MesaAuthError("No MESA session in the database — run `npm run mesa:login`", "NO_SESSION");

  const due = !integ.lastFullAt || now.getTime() - Date.parse(integ.lastFullAt) >= FULL_EVERY_MS;
  const kind = opts.force ?? (due ? "full" : "light");
  const runId = await db.startRun(sql, PROVIDER, kind, opts.trigger);
  const client = new MesaClient({
    tokens: new TokenProvider(dbSessionStore(sql, deps.sessionKey)),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    maxConcurrency: deps.maxConcurrency ?? 3,
    minGapMs: deps.minGapMs ?? 150,
  });

  let snap: MesaSnapshot;
  try {
    snap =
      kind === "full"
        ? await extractSnapshot(client, { now, log })
        : await extractLight(client, { now, log, instructorByCourse: await db.instructorByCourse(sql) });
  } catch (err) {
    return await handleFailure(deps, runId, kind, err, now);
  }

  const cs = await buildChangeSet(sql, snap, integ.baselinedKinds, now);
  const after = await db.getIntegration(sql, PROVIDER);
  const sessionWarning = sessionExpiryWarning(after?.sessionExpiresAt ?? null, now);
  if (sessionWarning) cs.changeSet.notifications.push(sessionWarning);

  const { newNotifications } = await db.applyChanges(sql, cs.changeSet);
  await db.recordSuccess(sql, PROVIDER, { full: kind === "full", baselined: cs.newlyBaselined });
  const status = snap.meta.warnings.length ? "partial" : "success";
  await db.finishRun(sql, runId, {
    status,
    requestCount: snap.meta.requestCount,
    counts: snap.meta.counts,
    changes: cs.stats,
    notifications: newNotifications,
    warnings: snap.meta.warnings,
  });

  // Assignments and exams → projects and tasks. Never fails the sync: the next run retries.
  let work: WorkSummary | undefined;
  try {
    work = await syncWork(sql, now);
  } catch (err) {
    log.warn("task sync failed", { error: err });
  }

  // Real submission times (a few per run until all are known). Never fails the sync.
  try {
    await fetchSubmissionTimes(sql, client);
  } catch (err) {
    log.warn("submission times failed", { error: err });
  }

  // Files last: alerts are never delayed by downloads, and a download problem never fails the sync.
  let files: FetchResult | undefined;
  if (deps.storage) {
    try {
      files = await fetchPendingFiles({ sql, client, storage: deps.storage, signedUrls: snap.transient?.signedUrls ?? {}, log, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    } catch (err) {
      log.warn("file fetch failed", { error: err });
    }
  }
  log.info("sync finished", { kind, status, requests: client.requestCount, queued: newNotifications, files, work });
  return { status, kind, runId, requestCount: client.requestCount, counts: snap.meta.counts, changes: cs.stats, queued: newNotifications, ...(files ? { files } : {}), ...(work ? { work } : {}) };
}

async function handleFailure(deps: SyncDeps, runId: number, kind: "full" | "light", err: unknown, now: Date): Promise<SyncSummary> {
  const { sql, log } = deps;
  const auth = err instanceof MesaAuthError;
  const message = err instanceof Error ? err.message : String(err);
  log.error("sync failed", { error: err });
  const failures = await db.recordFailure(sql, PROVIDER, message, auth);
  const day = now.toISOString().slice(0, 10);
  const drafts: NotificationDraft[] = [];
  if (auth) {
    drafts.push({
      dedupeKey: `mesa.session_expired:${day}`,
      priority: "urgent",
      text: `🔑 <b>JARVIS can't reach MESA: your sign-in has expired</b>\n\nOn your laptop, run:\n<code>npm run mesa:login</code>\nand sign in. Monitoring resumes automatically.`,
      scheduledFor: deliveryTime("urgent", now).toISOString(),
    });
  } else if (failures >= 3) {
    drafts.push({
      dedupeKey: `mesa.sync_failing:${day}`,
      priority: "high",
      text: `⚠️ <b>MESA sync has failed ${failures} times in a row</b>\n\nLast error: ${message.slice(0, 200).replace(/</g, "&lt;")}\nI'll keep retrying.`,
      scheduledFor: deliveryTime("high", now).toISOString(),
    });
  }
  if (drafts.length) await db.enqueueNotifications(sql, drafts);
  await db.finishRun(sql, runId, { status: "failed", error: message });
  return { status: "failed", kind, runId, error: message };
}

function sessionExpiryWarning(expiresAt: string | null, now: Date): NotificationDraft | null {
  if (!expiresAt) return null;
  const left = Date.parse(expiresAt) - now.getTime();
  if (left > SESSION_WARN_MS || left <= 0) return null;
  const when = new Date(expiresAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  return {
    dedupeKey: `mesa.session_expiring:${expiresAt}`,
    priority: "high",
    text: `🔑 <b>Your MESA sign-in expires ${when}</b>\n\nTo keep JARVIS watching, run this on your laptop before then:\n<code>npm run mesa:login</code>`,
    scheduledFor: deliveryTime("high", now).toISOString(),
  };
}

/**
 * The next assignment that needs a draft: open (not submitted, deadline in the future or unset), no finished
 * draft for its current content, no attempt in the last 20 minutes, and fewer than 2 failures for this version.
 */
export async function nextToDraft(sql: Sql, now: Date, limit = 1): Promise<string[]> {
  const rows = await sql`
    select i.source_id from jarvis.lms_items i
     where i.kind = 'assignment' and i.removed_at is null
       and i.data ->> 'submissionStatus' not in ('submitted', 'submitted_late')
       and (i.sort_at is null or i.sort_at > ${now.toISOString()})
       and not exists (select 1 from jarvis.drafts d where d.assignment_id = i.source_id and d.assignment_hash = i.content_hash and d.status = 'done' and d.pipeline = 'v2')
       and not exists (select 1 from jarvis.drafts d where d.assignment_id = i.source_id and d.created_at > ${new Date(now.getTime() - 20 * 60_000).toISOString()})
       and (select count(*) from jarvis.drafts d where d.assignment_id = i.source_id and d.assignment_hash = i.content_hash and d.status = 'failed') < 2
       -- waiting on the student: skip until they add an instruction after the question was asked
       and not exists (select 1 from jarvis.drafts d where d.assignment_id = i.source_id and d.assignment_hash = i.content_hash and d.status = 'needs_input'
                        and d.created_at > coalesce((select max(n.created_at) from jarvis.assignment_notes n where n.assignment_id = i.source_id), '-infinity'::timestamptz))
     order by i.sort_at asc nulls last
     limit ${limit}`;
  return rows.map((r) => String(r.source_id));
}

interface Built {
  changeSet: ChangeSet;
  newlyBaselined: string[];
  stats: Record<string, { created: number; changed: number; removed: number }>;
}

/** Diffs every collection this snapshot fetched and turns the result into one atomic change set. */
export async function buildChangeSet(sql: Sql, snap: MesaSnapshot, baselinedKinds: string[], now: Date): Promise<Built> {
  const existing = new Map<ItemKind, Map<string, db.StoredItem>>();
  for (const col of Object.keys(snap.meta.complete) as CollectionName[]) existing.set(KIND[col], await db.loadItems(sql, KIND[col]));
  const courseTitles = new Map<string, string>();
  for (const c of snap.courses) courseTitles.set(c.sourceId, c.title);
  if (!courseTitles.size) for (const [id, c] of await db.loadItems(sql, "course")) courseTitles.set(id, String(c.data.title));
  return planChangeSet(snap, existing, baselinedKinds, now, (id) => (id ? courseTitles.get(id) ?? null : null));
}

/** Pure core of buildChangeSet (unit-tested without a database). */
export function planChangeSet(
  snap: MesaSnapshot,
  existing: Map<ItemKind, Map<string, db.StoredItem>>,
  baselinedKinds: string[],
  now: Date,
  courseTitle: (id: string | null | undefined) => string | null,
): Built {
  const ctx: RuleContext = { now, courseTitle };
  const cs: ChangeSet = { upserts: [], versions: [], touched: [], removed: [], events: [], notifications: [] };
  const stats: Built["stats"] = {};
  const newlyBaselined: string[] = [];
  let assignmentDiff: Diff<MesaAssignment> | null = null;

  for (const col of Object.keys(snap.meta.complete) as CollectionName[]) {
    const kind = KIND[col];
    const complete = snap.meta.complete[col] === true;
    const stored = existing.get(kind) ?? new Map();
    const items = snap[col] as unknown as AnyItem[];
    const window = snap.meta.eventsWindow;
    const diff = diffItems(stored, items, {
      // Announcements are paginated, so absence proves nothing; events only within the requested window.
      enabled: complete && col !== "announcements",
      ...(col === "events" ? { inScope: (s: db.StoredItem) => !!s.sortAt && s.sortAt >= window.from && s.sortAt <= window.to } : {}),
    });
    stats[col] = { created: diff.created.length, changed: diff.changed.length, removed: diff.removed.length };

    cs.upserts.push(...[...diff.created, ...diff.changed.map((c) => c.after), ...diff.reappeared].map((i) => toRow(kind, i)));
    cs.versions.push(...[...diff.created, ...diff.changed.map((c) => c.after)].map((i) => toRow(kind, i)));
    cs.touched.push({ kind, sourceIds: diff.unchanged.map((i) => i.sourceId) });
    cs.removed.push({ kind, sourceIds: diff.removed.map((r) => r.sourceId) });

    const baselined = baselinedKinds.includes(kind);
    if (!baselined) {
      // First complete read of this kind: record silently instead of announcing everything that already exists.
      if (complete) newlyBaselined.push(kind);
      continue;
    }
    const out: RuleOutput =
      col === "assignments" ? assignmentRules((assignmentDiff = diff as unknown as Diff<MesaAssignment>), ctx) :
      col === "events" ? eventRules(diff as never, ctx) :
      col === "announcements" ? announcementRules(diff as never, ctx) :
      col === "materials" ? materialRules(diff as never, ctx) :
      col === "recordings" ? recordingRules(diff as never, ctx) :
      courseRules(diff as never, ctx);
    cs.events.push(...(out.events as EventDraft[]));
    cs.notifications.push(...out.notifications);
  }

  if (snap.meta.complete.assignments !== undefined) {
    const justAnnounced = new Set((assignmentDiff?.created ?? []).map((a) => a.sourceId));
    cs.notifications.push(...reminderRules(snap.assignments, ctx, justAnnounced));
    if (newlyBaselined.includes("assignment")) {
      const upcoming = snap.events.filter((e) => Date.parse(e.startAt) >= now.getTime() && e.status !== "cancelled").length;
      const courses = snap.courses.length || [...(existing.get("course")?.values() ?? [])].filter((c) => !c.removedAt).length;
      cs.notifications.push(baselineSummary({ courses, assignments: snap.assignments, upcomingClasses: upcoming }, ctx));
    }
  }
  return { changeSet: cs, newlyBaselined, stats };
}
