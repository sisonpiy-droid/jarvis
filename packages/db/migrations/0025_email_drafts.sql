-- Emails JARVIS drafted for the owner. They are only ever drafts: JARVIS has no way to send mail. The owner reads
-- the draft (chat, /emails), edits it, opens it in their own mail app, and marks it sent or discarded.
create table jarvis.email_drafts (
  id         bigint generated always as identity primary key,
  to_addr    text,                                   -- may be unknown when drafted ("email the prof about …")
  subject    text not null,
  body       text not null,
  status     text not null default 'draft' check (status in ('draft', 'sent', 'discarded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index email_drafts_open on jarvis.email_drafts (id desc) where status = 'draft';
alter table jarvis.email_drafts enable row level security;
