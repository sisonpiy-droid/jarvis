-- One-time dashboard login links, delivered to the owner's Telegram.
-- Only a SHA-256 of each token is stored; tokens expire in 10 minutes and work once.

create table jarvis.login_tokens (
  token_hash text primary key,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

alter table jarvis.login_tokens enable row level security;
