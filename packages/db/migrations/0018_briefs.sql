-- V2 Phase 5: the daily brief, kept as the lines it was rendered from (each with the source rows it came from).
-- The command center shows today's focus note from here (no second AI call); the briefs job uses it so the model
-- is called at most once a day. The notification (dedupe key brief:<day>) remains the delivery record.

create table jarvis.briefs (
  id           bigint generated always as identity primary key,
  kind         text not null default 'daily' check (kind in ('daily')),  -- Phase 7 widens to weekly / monthly
  day          date not null,                                            -- IST day the brief is for
  lines        jsonb not null,                                           -- BriefLine[]: {kind, html, refs: FactRef[]}
  text         text not null,                                            -- the notification text exactly as queued
  note         text,                                                     -- focus note as shown (plain text, after substitution)
  note_source  text not null check (note_source in ('ai', 'fallback')),
  note_detail  text,                                                     -- fallback reason: no_model | error:<msg> | invalid:<rule>
  note_refs    jsonb not null default '[]',                              -- FactRef[] the note mentions
  created_at   timestamptz not null default now(),
  unique (kind, day)
);

alter table jarvis.briefs enable row level security;

update jarvis.jobs set description = 'Daily brief 08:00–12:00 IST: facts, focus note, inbox + push' where name = 'briefs';
