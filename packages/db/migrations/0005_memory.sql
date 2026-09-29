-- Long-term memory: durable facts and preferences the student has told JARVIS.
-- Small and explicit (the student can list and delete every entry).

create table jarvis.memories (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('preference', 'fact', 'goal', 'person', 'project')),
  content      text not null check (length(content) between 3 and 500),
  source       text not null default 'chat',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create unique index memories_unique_active on jarvis.memories (lower(content)) where active;

alter table jarvis.memories enable row level security;
