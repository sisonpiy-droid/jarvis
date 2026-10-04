-- Chief of staff v1: what JARVIS learns about how the owner works, and the evening rhythm.

-- 1. Tasks the owner keeps pushing: each move of a due date later counts (never MESA's own deadline changes).
alter table jarvis.tasks
  add column postponed_count   int not null default 0,
  add column last_postponed_at timestamptz;

-- 2. When each MESA assignment was really submitted (and its grade), read once per assignment from the LMS's
--    submission endpoint. Feeds "how early do I usually submit" — the LMS list only says submitted / late.
create table jarvis.submissions (
  assignment_id text primary key,
  status        text,
  submitted_at  timestamptz,
  grade         jsonb,
  fetched_at    timestamptz not null default now()
);

-- 3. Pushes the owner opened or acted on (tap, Done / Skip). "Mark all read" sets only read_at, so opened_at is the
--    honest signal for learning which alerts are ignored.
alter table jarvis.notifications add column opened_at timestamptz;
create index notifications_category_sent on jarvis.notifications (category, sent_at) where status = 'sent';

-- 4. The evening job: 20:30 check-in, then at night what JARVIS learned (memories from the day's chat, quieter
--    alert types).
insert into jarvis.jobs (name, description, cadence_minutes) values ('evening', 'Evening check-in, learning from the day (memories, alert habits)', 15)
on conflict (name) do nothing;

alter table jarvis.submissions enable row level security;
