-- Assignment drafts produced by JARVIS. One row per attempt; the assignment's
-- content hash lets auto-drafting skip assignments it has already drafted.

create table jarvis.drafts (
  id              bigint generated always as identity primary key,
  assignment_id   text not null,
  assignment_hash text not null,
  trigger         text not null check (trigger in ('auto', 'request')),
  status          text not null default 'running' check (status in ('running', 'done', 'failed')),
  model           text,
  sources         jsonb,          -- which originals/materials were read
  storage_path    text,           -- the .docx in the mesa-files bucket
  summary         text,
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index drafts_assignment on jarvis.drafts (assignment_id, created_at desc);

alter table jarvis.drafts enable row level security;
