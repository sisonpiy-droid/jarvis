-- Study notes written once per class session from that session's material (decks, readings, workbooks), and the
-- revision packs built from them. source_key names the files the notes were written from: when a session gets a new
-- file, the notes are written again. Packs are plain Word files assembled from these rows — no AI at pack time.
create table jarvis.session_notes (
  course_id  text not null,
  session    int not null,
  course     text not null,
  source_key text not null,             -- sorted sha256s of the files used
  notes      jsonb not null,            -- {concepts: [], formulas: [], terms: [{term, meaning}], questions: []}
  model      text,
  created_at timestamptz not null default now(),
  primary key (course_id, session)
);
alter table jarvis.session_notes enable row level security;
