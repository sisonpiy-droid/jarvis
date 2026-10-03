-- Passkey sign-in for the single owner (replaces the Telegram login link as the primary method).

create table jarvis.passkeys (
  credential_id text primary key,          -- base64url, as the browser reports it
  public_key    bytea not null,            -- COSE public key
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_name   text not null default 'Passkey',
  backed_up     boolean not null default false,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- One-time recovery codes, stored as SHA-256 hashes only.
create table jarvis.recovery_codes (
  code_hash  text primary key,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

alter table jarvis.passkeys       enable row level security;
alter table jarvis.recovery_codes enable row level security;
