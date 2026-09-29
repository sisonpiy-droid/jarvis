-- JARVIS V1 schema. Lives in a private "jarvis" schema that Supabase's Data API
-- does not expose, so the publishable key cannot read it. RLS is enabled with
-- no policies as a second lock: only the postgres role (worker / edge fn) reads.
-- Single-user by design; add user_id if JARVIS ever serves more than one person.

create schema if not exists jarvis;
revoke all on schema jarvis from public, anon, authenticated;

-- One row per external integration ("mesa", later "gmail", "gcal").
create table jarvis.integrations (
  provider             text primary key,
  status               text not null default 'active' check (status in ('active', 'needs_login', 'error')),
  secret_sealed        text,                       -- AES-256-GCM, key only in env
  session_expires_at   timestamptz,
  baselined_kinds      text[] not null default '{}', -- kinds whose first complete read was recorded silently
  last_success_at      timestamptz,
  last_full_at         timestamptz,
  consecutive_failures int not null default 0,
  last_error           text,
  updated_at           timestamptz not null default now()
);

-- Every LMS record, normalized. data = the full normalized record; a few
-- columns are lifted out for querying. Idempotent upserts key on (kind, source_id).
create table jarvis.lms_items (
  kind          text not null check (kind in ('course', 'material', 'recording', 'assignment', 'event', 'announcement')),
  source_id     text not null,
  content_hash  text not null,
  data          jsonb not null,
  course_id     text,
  title         text not null,
  sort_at       timestamptz,          -- due_at / start_at / created_at, by kind
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  changed_at    timestamptz not null default now(),
  removed_at    timestamptz,
  primary key (kind, source_id)
);
create index lms_items_kind_sort on jarvis.lms_items (kind, sort_at) where removed_at is null;
create index lms_items_course on jarvis.lms_items (course_id, kind) where removed_at is null;

-- Full history: a row per distinct content version of an item.
create table jarvis.item_versions (
  id           bigint generated always as identity primary key,
  kind         text not null,
  source_id    text not null,
  content_hash text not null,
  data         jsonb not null,
  seen_at      timestamptz not null default now(),
  unique (kind, source_id, content_hash)
);

-- Outbox of meaningful changes. dedupe_key makes re-detection a no-op.
create table jarvis.domain_events (
  id         bigint generated always as identity primary key,
  type       text not null,
  kind       text,
  source_id  text,
  payload    jsonb not null default '{}',
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);

-- Outgoing messages. dedupe_key UNIQUE is the "never say the same thing twice" guarantee.
create table jarvis.notifications (
  id                  bigint generated always as identity primary key,
  dedupe_key          text not null unique,
  priority            text not null check (priority in ('urgent', 'high', 'normal', 'low')),
  text                text not null,
  status              text not null default 'queued' check (status in ('queued', 'sent', 'suppressed', 'failed')),
  scheduled_for       timestamptz not null default now(),
  attempts            int not null default 0,
  sent_at             timestamptz,
  provider_message_id text,
  last_error          text,
  created_at          timestamptz not null default now()
);
create index notifications_due on jarvis.notifications (scheduled_for) where status = 'queued';

create table jarvis.sync_runs (
  id            bigint generated always as identity primary key,
  provider      text not null,
  kind          text not null,              -- light | full
  trigger       text not null,              -- schedule | manual
  status        text not null default 'running' check (status in ('running', 'success', 'partial', 'failed', 'skipped')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  request_count int,
  counts        jsonb,                      -- discovered per collection
  changes       jsonb,                      -- created / changed / removed per collection
  notifications int,
  warnings      jsonb,
  error         text
);
create index sync_runs_recent on jarvis.sync_runs (provider, started_at desc);

-- Lease-style lock so overlapping cron invocations never sync concurrently
-- (the session cookie can rotate; two refreshers would log each other out).
create table jarvis.locks (
  name         text primary key,
  holder       text not null,
  locked_until timestamptz not null
);

alter table jarvis.integrations  enable row level security;
alter table jarvis.lms_items     enable row level security;
alter table jarvis.item_versions enable row level security;
alter table jarvis.domain_events enable row level security;
alter table jarvis.notifications enable row level security;
alter table jarvis.sync_runs     enable row level security;
alter table jarvis.locks         enable row level security;

-- Readable views for the dashboard and for ad-hoc SQL.
create view jarvis.assignments as
select source_id as id,
       data ->> 'courseTitle'      as course,
       title,
       (data ->> 'dueAt')::timestamptz as due_at,
       data ->> 'dueAtIst'         as due_ist,
       data ->> 'submissionStatus' as submission_status,
       data ->> 'submissionType'   as submission_type,
       jsonb_array_length(data -> 'materials') as files,
       data ->> 'sourceUrl'        as url,
       first_seen_at, changed_at
from jarvis.lms_items
where kind = 'assignment' and removed_at is null;

create view jarvis.upcoming_classes as
select source_id as id, title, data ->> 'courseName' as course, sort_at as start_at,
       data ->> 'startAtIst' as start_ist, data ->> 'room' as room, data ->> 'status' as status
from jarvis.lms_items
where kind = 'event' and removed_at is null and sort_at >= now()
order by sort_at;
