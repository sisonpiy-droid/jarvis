-- The student's standing instructions per assignment ("our startup is X",
-- "make it shorter"). Every draft of that assignment follows them.
create table jarvis.assignment_notes (
  id            bigint generated always as identity primary key,
  assignment_id text not null,
  note          text not null check (length(note) between 2 and 4000),
  source        text not null default 'chat',
  created_at    timestamptz not null default now()
);
create index assignment_notes_by_assignment on jarvis.assignment_notes (assignment_id, id);
alter table jarvis.assignment_notes enable row level security;

-- A draft can pause to ask the student for information only they have.
alter table jarvis.drafts drop constraint drafts_status_check;
alter table jarvis.drafts add constraint drafts_status_check check (status in ('running', 'done', 'failed', 'needs_input'));
alter table jarvis.drafts add column questions jsonb;
