import type { Sql } from "./client";

// Job health: the live heartbeat per job (jarvis.jobs) and the run history (jarvis.job_runs).

export type JobStatus = "success" | "partial" | "idle" | "failed";
export type JobTrigger = "schedule" | "manual";

export interface JobOutcome {
  status: JobStatus;
  trigger: JobTrigger;
  startedAt: Date;
  durationMs: number;
  stats?: Record<string, unknown>;
  error?: string;
}

export async function markJobStarted(sql: Sql, job: string, at: Date): Promise<void> {
  await sql`update jarvis.jobs set last_started_at = ${at.toISOString()}, updated_at = now() where name = ${job}`;
}

/** Updates the heartbeat, and keeps a history row unless the run was idle. */
export async function finishJob(sql: Sql, job: string, o: JobOutcome): Promise<void> {
  const ok = o.status !== "failed";
  const finished = new Date(o.startedAt.getTime() + o.durationMs).toISOString();
  const error = o.error?.slice(0, 1000) ?? null;
  await sql`
    update jarvis.jobs set
      last_finished_at     = ${finished},
      last_status          = ${o.status},
      last_duration_ms     = ${o.durationMs},
      last_success_at      = case when ${ok} then ${finished}::timestamptz else last_success_at end,
      last_failure_at      = case when ${ok} then last_failure_at else ${finished}::timestamptz end,
      consecutive_failures = case when ${ok} then 0 else consecutive_failures + 1 end,
      last_error           = case when ${ok} then last_error else ${error} end,
      updated_at           = now()
    where name = ${job}`;
  if (o.status === "idle") return;
  await sql`
    insert into jarvis.job_runs (job, trigger, status, started_at, finished_at, duration_ms, stats, error)
    values (${job}, ${o.trigger}, ${o.status}, ${o.startedAt.toISOString()}, ${finished}, ${o.durationMs}, ${sql.json((o.stats ?? {}) as never)}, ${error})`;
}

/** Another run of the same job still holds the lock. Recorded in history only; the heartbeat is untouched. */
export async function recordJobSkipped(sql: Sql, job: string, trigger: JobTrigger, at: Date): Promise<void> {
  await sql`
    insert into jarvis.job_runs (job, trigger, status, started_at, finished_at, duration_ms)
    values (${job}, ${trigger}, 'skipped', ${at.toISOString()}, ${at.toISOString()}, 0)`;
}

export interface JobHealth {
  name: string;
  description: string;
  cadenceMinutes: number;
  enabled: boolean;
  health: "ok" | "failing" | "stale" | "never_run" | "disabled";
  lastStatus: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastStartedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastDurationMs: number | null;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export async function jobHealth(sql: Sql): Promise<JobHealth[]> {
  const rows = await sql`select * from jarvis.job_health order by cadence_minutes, name`;
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    cadenceMinutes: Number(r.cadence_minutes),
    enabled: r.enabled,
    health: r.health,
    lastStatus: r.last_status ?? null,
    lastSuccessAt: iso(r.last_success_at),
    lastFailureAt: iso(r.last_failure_at),
    lastStartedAt: iso(r.last_started_at),
    consecutiveFailures: Number(r.consecutive_failures),
    lastError: r.last_error ?? null,
    lastDurationMs: r.last_duration_ms === null ? null : Number(r.last_duration_ms),
  }));
}

export async function isJobEnabled(sql: Sql, job: string): Promise<boolean> {
  const [r] = await sql`select enabled from jarvis.jobs where name = ${job}`;
  if (!r) throw new Error(`Unknown job "${job}" — is migration 0012 applied?`);
  return r.enabled === true;
}

/** Drops history older than `days`; the heartbeat in jarvis.jobs is kept forever. */
export async function pruneJobRuns(sql: Sql, days: number): Promise<number> {
  const rows = await sql`delete from jarvis.job_runs where started_at < now() - ${days} * interval '1 day' returning id`;
  return rows.length;
}
