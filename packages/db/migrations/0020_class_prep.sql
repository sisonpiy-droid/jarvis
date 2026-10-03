-- Pre-class prep: a push ~30 minutes before each MESA session (the session's pre-read and its key points) and an
-- evening list of tomorrow's pre-reads. Which pre-read belongs to which class is computed (packages/db/src/class-prep.ts);
-- only the AI's key points are stored, once per distinct content, so a pre-read is summarised at most once.

create table jarvis.prep_notes (
  key        text primary key,          -- 'file:<sha256>' or 'text:<material source_id>:<content hash>'
  title      text,
  points     jsonb not null check (jsonb_typeof(points) = 'array'),  -- 1–3 short strings
  model      text,
  created_at timestamptz not null default now()
);

insert into jarvis.jobs (name, description, cadence_minutes) values ('prep', 'Pre-class prep: pre-read key points, 30-minute push, evening list', 5)
on conflict (name) do nothing;

alter table jarvis.prep_notes enable row level security;
