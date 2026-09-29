-- Every file a draft produced: the Word doc, a filled workbook, a slide deck.
create table jarvis.draft_files (
  id           bigint generated always as identity primary key,
  draft_id     bigint not null references jarvis.drafts (id) on delete cascade,
  kind         text not null check (kind in ('docx', 'xlsx', 'pptx')),
  filename     text not null,
  storage_path text not null,
  size_bytes   bigint not null,
  created_at   timestamptz not null default now()
);
create index draft_files_draft on jarvis.draft_files (draft_id);
alter table jarvis.draft_files enable row level security;
