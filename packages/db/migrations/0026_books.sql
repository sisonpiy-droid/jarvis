-- A book read one piece a day: split once into ~45 pieces (about a page each), delivered each morning with a running
-- summary of everything before it. next_day is when the next piece is due — postponing moves it, "next now" sends early.
create table jarvis.books (
  id             bigint generated always as identity primary key,
  title          text not null,
  author         text,
  source         text not null check (source in ('pdf', 'public_domain')),
  file_sha       text,                               -- the stored PDF, when source = 'pdf'
  status         text not null default 'active' check (status in ('active', 'paused', 'done')),
  total_pieces   int not null check (total_pieces > 0),
  next_piece     int not null default 1,             -- 1-based: the piece to send next
  next_day       date not null,                      -- IST day it is due
  summary        text not null default '',           -- rolling summary of pieces 1..summary_upto
  summary_upto   int not null default 0,
  created_at     timestamptz not null default now()
);
create table jarvis.book_pieces (
  book_id bigint not null references jarvis.books(id) on delete cascade,
  n       int not null,
  label   text,                                      -- "pp. 12–14" when the source has pages
  body    text not null,
  primary key (book_id, n)
);
insert into jarvis.jobs (name, description, cadence_minutes) values ('reading', 'Daily book reading: this morning''s piece with a summary of the days before', 15)
on conflict (name) do nothing;
alter table jarvis.books enable row level security;
alter table jarvis.book_pieces enable row level security;
