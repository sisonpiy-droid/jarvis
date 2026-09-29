-- Downloaded LMS files. Content-addressed: one row per distinct file (sha256),
-- linked to every item that attaches it. Bytes live in a private Storage bucket.

insert into storage.buckets (id, name, public)
values ('mesa-files', 'mesa-files', false)
on conflict (id) do nothing;

create table jarvis.files (
  sha256            text primary key,
  storage_path      text not null,
  mime_type         text,
  size_bytes        bigint not null,
  original_filename text,
  -- 'done' = text extracted; 'original' = keep as-is (PDF/image: the model reads the file itself);
  -- 'unsupported' / 'failed' otherwise.
  text_status       text not null check (text_status in ('done', 'original', 'unsupported', 'failed')),
  text_content      text,
  created_at        timestamptz not null default now()
);

-- Which item attachment points at which file, plus fetch bookkeeping.
create table jarvis.item_files (
  kind          text not null,             -- assignment | material | announcement | event
  item_id       text not null,
  attachment_id text not null,
  title         text,
  sha256        text references jarvis.files (sha256),
  status        text not null default 'pending' check (status in ('pending', 'done', 'failed', 'skipped')),
  attempts      int not null default 0,
  last_error    text,
  fetched_at    timestamptz,
  primary key (kind, item_id, attachment_id)
);
create index item_files_todo on jarvis.item_files (status) where status in ('pending', 'failed');

alter table jarvis.files      enable row level security;
alter table jarvis.item_files enable row level security;
