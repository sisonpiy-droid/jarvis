-- JARVIS chat: conversation history (for context) and processed Telegram
-- updates (Telegram retries webhooks; this makes handling exactly-once).

create table jarvis.chat_messages (
  id         bigint generated always as identity primary key,
  channel    text not null default 'telegram',
  role       text not null check (role in ('user', 'model', 'tool')),
  -- Provider-native parts, stored verbatim (Gemini requires its thought
  -- signatures to be echoed back unchanged on later turns).
  parts      jsonb not null,
  created_at timestamptz not null default now()
);
create index chat_messages_recent on jarvis.chat_messages (channel, id desc);

create table jarvis.telegram_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);

alter table jarvis.chat_messages    enable row level security;
alter table jarvis.telegram_updates enable row level security;
