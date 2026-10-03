-- Job health. Every scheduled job (one pg_cron entry each) keeps its live state
-- in `jobs` — a heartbeat that is updated on every run, including idle ones — and
-- writes a `job_runs` row whenever it does work, fails or is skipped. Idle runs
-- (nothing to do) only touch the heartbeat, so the history stays small.

create table jarvis.jobs (
  name                 text primary key,
  description          text not null,
  cadence_minutes      int  not null check (cadence_minutes > 0),
  enabled              boolean not null default true,
  last_started_at      timestamptz,
  last_finished_at     timestamptz,
  last_success_at      timestamptz,             -- success, partial or idle
  last_failure_at      timestamptz,
  last_status          text check (last_status in ('success', 'partial', 'idle', 'failed', 'skipped')),
  consecutive_failures int  not null default 0,
  last_error           text,
  last_duration_ms     int,
  updated_at           timestamptz not null default now()
);

create table jarvis.job_runs (
  id          bigint generated always as identity primary key,
  job         text not null references jarvis.jobs (name),
  trigger     text not null check (trigger in ('schedule', 'manual')),
  status      text not null check (status in ('running', 'success', 'partial', 'failed', 'skipped')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int,
  stats       jsonb not null default '{}',
  error       text
);
create index job_runs_job_started on jarvis.job_runs (job, started_at desc);

-- Owner settings (notification routing, quiet hours, budgets …), one JSON value per key.
create table jarvis.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into jarvis.jobs (name, description, cadence_minutes) values
  ('mesa',     'MESA LMS sync, change alerts, deadline reminders, file downloads', 5),
  ('calendar', 'Personal Google Calendar (iCal) sync and heads-ups',             5),
  ('notify',   'Deliver queued notifications',                                   1),
  ('briefs',   'Morning brief',                                                  15),
  ('drafts',   'Assignment drafting backlog',                                    10),
  ('health',   'Job health check and history cleanup',                           15)
on conflict (name) do nothing;

-- A job is stale when it hasn't succeeded for 3 of its cadences.
create view jarvis.job_health as
select j.*,
       case
         when not j.enabled then 'disabled'
         when j.last_success_at is null and j.last_failure_at is null then 'never_run'
         when j.last_success_at is null or j.last_success_at < now() - 3 * j.cadence_minutes * interval '1 minute' then 'stale'
         when j.consecutive_failures > 0 then 'failing'
         else 'ok'
       end as health
  from jarvis.jobs j;

alter table jarvis.jobs     enable row level security;
alter table jarvis.job_runs enable row level security;
alter table jarvis.settings enable row level security;
