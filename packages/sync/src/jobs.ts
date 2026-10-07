import * as db from "@jarvis/db";
import type { JobStatus, JobTrigger, NotificationDraft, Sql } from "@jarvis/db";
import { runNotificationService } from "@jarvis/notify";
import type { Logger } from "@jarvis/shared";
import { dailyBrief } from "./brief";
import { runClassPrep } from "./class-prep";
import { runEngine } from "./engine";
import { runEvening } from "./evening";
import { syncCalendar } from "./calendar";
import { mesaSync, nextToDraft, type SyncDeps, type SyncOptions, type SyncSummary } from "./run";
import { istHour } from "./time";

// Scheduled jobs. pg_cron calls the `jarvis-tick` Edge Function once per job on its own cadence; each job runs
// under its own lease lock and reports to jarvis.jobs (heartbeat) and jarvis.job_runs (history). A failure in
// one job never blocks the others.

/** Telegram bots can send documents up to 50 MB. */
const TELEGRAM_FILE_MAX = 45_000_000;

/** A stored file (class deck, pre-read) for Telegram, or null when it's missing or too big to send. */
async function storedFile(deps: SyncDeps, sha: string) {
  if (!deps.storage?.download) return null;
  const [f] = await deps.sql`select storage_path, mime_type, original_filename, size_bytes from jarvis.files where sha256 = ${sha}`;
  if (!f || Number(f.size_bytes) > TELEGRAM_FILE_MAX) return null;
  return { bytes: await deps.storage.download(String(f.storage_path)), name: String(f.original_filename || `${sha.slice(0, 12)}.bin`), mime: String(f.mime_type || "application/octet-stream") };
}

export const JOB_NAMES = ["mesa", "calendar", "notify", "briefs", "drafts", "habits", "engine", "prep", "evening", "health"] as const;
export type JobName = (typeof JOB_NAMES)[number];
export const isJobName = (s: string): s is JobName => (JOB_NAMES as readonly string[]).includes(s);

/** pg_cron schedules; must match the cadences seeded in migrations 0012, 0016, 0017, 0020 and 0021. */
export const JOB_SCHEDULES: Record<JobName, string> = {
  mesa: "*/5 * * * *",
  calendar: "*/5 * * * *", // 5 min: the 30-minute heads-up window needs it
  notify: "* * * * *",
  briefs: "*/15 * * * *",
  drafts: "*/10 * * * *",
  habits: "*/5 * * * *",
  engine: "*/5 * * * *",
  prep: "*/5 * * * *",
  evening: "*/15 * * * *",
  health: "*/15 * * * *",
};

/** Lease length per job — longer than the job can take, shorter than its cadence where possible. */
const LEASE_MS: Record<JobName, number> = {
  mesa: 4 * 60_000,
  calendar: 2 * 60_000,
  notify: 55_000,
  briefs: 2 * 60_000,
  drafts: 2 * 60_000,
  habits: 2 * 60_000,
  engine: 2 * 60_000,
  prep: 2 * 60_000,
  evening: 3 * 60_000,
  health: 2 * 60_000,
};

/** History older than this is deleted by the health job. */
export const JOB_HISTORY_DAYS = 30;
/** The brief waits for MESA data at most this old, so it's normally never built from a stale LMS picture… */
const BRIEF_FRESHNESS_MS = 30 * 60_000;
/** …from 08:00 IST until 10:00; after that it goes out anyway, with a stale-data risk line. */
export const BRIEF_HOUR = 8;
const BRIEF_STALE_HOUR = 10;
/** No brief after noon: a morning brief that arrives in the afternoon is noise (the day's is skipped). */
const BRIEF_LAST_HOUR = 12;

export interface JobResult {
  status: JobStatus;
  stats?: Record<string, unknown>;
  error?: string;
}

export interface JobRun extends Omit<JobResult, "status"> {
  job: JobName;
  status: JobStatus | "skipped" | "disabled";
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs one job under its lease lock and records the outcome. Never throws for a job failure. */
export async function runJob(
  sql: Sql,
  log: Logger,
  job: JobName,
  trigger: JobTrigger,
  fn: () => Promise<JobResult>,
  clock: () => Date = () => new Date(),
): Promise<JobRun> {
  if (!(await db.isJobEnabled(sql, job))) return { job, status: "disabled" };
  const holder = crypto.randomUUID();
  const startedAt = clock();
  if (!(await db.acquireLock(sql, `job:${job}`, holder, LEASE_MS[job]))) {
    log.info("job already running; skipping", { job });
    await db.recordJobSkipped(sql, job, trigger, startedAt);
    return { job, status: "skipped" };
  }
  try {
    await db.markJobStarted(sql, job, startedAt);
    const t0 = performance.now();
    let result: JobResult;
    try {
      result = await fn();
    } catch (err) {
      log.error("job failed", { job, error: err });
      result = { status: "failed", error: message(err) };
    }
    const durationMs = Math.round(performance.now() - t0);
    await db.finishJob(sql, job, { ...result, trigger, startedAt, durationMs });
    return { job, ...result };
  } finally {
    await db.releaseLock(sql, `job:${job}`, holder).catch(() => {});
  }
}

const mesaResult = (s: SyncSummary): JobResult => ({
  status: s.status === "failed" ? "failed" : s.status === "partial" ? "partial" : "success",
  stats: { kind: s.kind, runId: s.runId, requests: s.requestCount, changes: s.changes, queued: s.queued, files: s.files, work: s.work },
  ...(s.error ? { error: s.error } : {}),
});

/** The body of each job. Exposed for tests; production goes through runScheduledJob. */
export const jobBodies: Record<JobName, (deps: SyncDeps, opts: SyncOptions, now: Date) => Promise<JobResult>> = {
  async mesa(deps, opts) {
    return mesaResult(await mesaSync(deps, opts));
  },

  async calendar(deps, _opts, now) {
    if (!deps.icsUrl) return { status: "idle", stats: { configured: false } };
    const r = await syncCalendar(deps.sql, deps.icsUrl, now, deps.log, deps.fetch);
    return { status: "success", stats: { ...r } };
  },

  async notify(deps, opts, now) {
    if (opts.send === false) return { status: "idle", stats: { sending: false } };
    const s = await runNotificationService(
      deps.sql,
      { baseUrl: deps.notify?.baseUrl ?? "", vapid: deps.notify?.vapid ?? null, email: deps.notify?.email ?? null, telegram: deps.channel, file: (sha) => storedFile(deps, sha) },
      { now, log: deps.log, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
    );
    const sent = s.push.sent + s.email.sent + s.telegram.sent;
    const failed = s.push.failed + s.email.failed + s.telegram.failed;
    if (!s.routed && !s.escalated && !sent && !failed && !s.push.skipped) return { status: "idle", ...(s.deferred ? { stats: { deferred: s.deferred } } : {}) };
    const stats = { ...s, sent, failed };
    if (!failed) return { status: "success", stats };
    return { status: sent || s.routed ? "partial" : "failed", stats, error: `${failed} delivery attempt(s) failed` };
  },

  async briefs(deps, _opts, now) {
    const h = istHour(now);
    if (h < BRIEF_HOUR) return { status: "idle" };
    const [sent] = await deps.sql`select 1 from jarvis.notifications where dedupe_key = ${`brief:${db.istDay(now)}`}`;
    if (sent) return { status: "idle" }; // already queued today: no facts, no AI
    if (h >= BRIEF_LAST_HOUR) return { status: "idle", stats: { missedWindow: true } };
    const integ = await db.getIntegration(deps.sql, "mesa");
    const fresh = !!integ?.lastSuccessAt && now.getTime() - Date.parse(integ.lastSuccessAt) <= BRIEF_FRESHNESS_MS;
    if (!fresh && h < BRIEF_STALE_HOUR) return { status: "idle", stats: { waitingForFreshLmsData: true } };
    const { draft, stats } = await dailyBrief(deps.sql, now, { model: deps.model ?? null, stale: !fresh });
    const queued = await db.enqueueNotifications(deps.sql, [draft]);
    return queued ? { status: "success", stats: { queued, ...stats, lmsStale: !fresh } } : { status: "idle" };
  },

  async drafts(deps, _opts, now) {
    if (!deps.onNewAssignments) return { status: "idle", stats: { configured: false } };
    // Every open, unsubmitted assignment gets a draft — earliest deadline first, one per run (free AI quota).
    const next = await nextToDraft(deps.sql, now);
    if (!next.length) return { status: "idle" };
    await deps.onNewAssignments(next);
    return { status: "success", stats: { requested: next } };
  },

  async habits(deps, _opts, now) {
    const due = await db.habitsToRemind(deps.sql, now);
    if (!due.length) return { status: "idle" };
    const today = db.istDay(now);
    const queued = await db.enqueueNotifications(deps.sql, due.map((h) => habitReminder(h, today, now)));
    return queued ? { status: "success", stats: { queued, habits: due.map((h) => h.id) } } : { status: "idle" };
  },

  async engine(deps, _opts, now) {
    const s = await runEngine(deps.sql, now);
    if (!s.queued) return { status: "idle", ...(s.goals ? { stats: { ...s } } : {}) };
    return { status: "success", stats: { ...s } };
  },

  async prep(deps, _opts, now) {
    const s = await runClassPrep(deps.sql, now, deps.model ?? null, deps.log);
    const worked = s.queued || s.summarized || s.summaryErrors;
    if (!worked) return { status: "idle", ...(s.upcoming ? { stats: { ...s } } : {}) };
    return { status: s.summaryErrors && !s.summarized && !s.queued ? "failed" : "success", stats: { ...s }, ...(s.summaryErrors ? { error: `${s.summaryErrors} pre-read summary call(s) failed` } : {}) };
  },

  async evening(deps, _opts, now) {
    const s = await runEvening(deps.sql, now, deps.model ?? null, deps.log);
    if (!s.checkin && !s.learned && s.planned == null) return { status: "idle" };
    return { status: s.errors.length ? "partial" : "success", stats: { ...s }, ...(s.errors.length ? { error: s.errors.join("; ") } : {}) };
  },

  async health(deps) {
    const jobs = await db.jobHealth(deps.sql);
    const unhealthy = jobs.filter((j) => j.name !== "health" && (j.health === "stale" || j.health === "failing")).map((j) => `${j.name}:${j.health}`);
    const pruned = await db.pruneJobRuns(deps.sql, JOB_HISTORY_DAYS);
    if (unhealthy.length) deps.log.warn("unhealthy jobs", { unhealthy });
    // Visible on the dashboard's Status page. Alerts on new channels arrive with Phase 1's notification service.
    return { status: unhealthy.length || pruned ? "success" : "idle", stats: { unhealthy, pruned } };
  },
};

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One check-in prompt per habit per day; the push carries Done / Skip buttons (see @jarvis/notify). */
export function habitReminder(h: db.HabitWithStatus, today: string, now: Date): NotificationDraft {
  const st = h.status;
  const progress =
    st.periodTarget != null
      ? `${st.periodDone} of ${st.periodTarget} ${h.schedule.freq === "monthly" ? "this month" : "this week"}`
      : st.streak > 0
        ? `🔥 ${st.streak}-day streak — keep it going`
        : db.describeSchedule(h.schedule);
  return {
    dedupeKey: `habit.reminder:${h.id}:${today}`,
    priority: "normal",
    text: `🔁 <b>${escHtml(h.name)}</b>\n${escHtml(progress)}${h.goalTitle ? ` · ${escHtml(h.goalTitle)}` : ""}`,
    scheduledFor: now.toISOString(),
  };
}

/** Runs one scheduled job — what `jarvis-tick?job=<name>` does. */
export async function runScheduledJob(job: JobName, deps: SyncDeps, opts: SyncOptions): Promise<JobRun> {
  const clock = () => deps.now?.() ?? new Date();
  return runJob(deps.sql, deps.log, job, opts.trigger, () => jobBodies[job](deps, opts, clock()), clock);
}

/**
 * Everything in one call — the pre-job behaviour, kept for `npm run sync:mesa`, the Telegram /sync command and
 * the `mesa-sync` Edge Function: calendar → MESA → brief → send → drafting. Each step is still its own job.
 */
export async function runMesaSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncSummary & { jobs: JobRun[] }> {
  const jobs: JobRun[] = [];
  if (deps.icsUrl) jobs.push(await runScheduledJob("calendar", deps, opts));

  let summary: SyncSummary | null = null;
  const clock = () => deps.now?.() ?? new Date();
  const mesa = await runJob(deps.sql, deps.log, "mesa", opts.trigger, async () => mesaResult((summary = await mesaSync(deps, opts))), clock);
  jobs.push(mesa);

  for (const job of ["briefs", "notify", "drafts"] as const) jobs.push(await runScheduledJob(job, deps, opts));
  const notify = jobs.find((j) => j.job === "notify");
  const sent = Number((notify?.stats as { sent?: number } | undefined)?.sent ?? 0);

  const base: SyncSummary =
    summary ??
    (mesa.status === "skipped" || mesa.status === "disabled" ? { status: "skipped" } : { status: "failed", ...(mesa.error ? { error: mesa.error } : {}) });
  return { ...base, sent, jobs };
}
