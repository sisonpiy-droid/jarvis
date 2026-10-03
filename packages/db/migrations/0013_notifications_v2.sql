-- Provider-independent notifications. The queue (jarvis.notifications) and its dedupe keys are unchanged:
-- producers still insert one row per fact. The notification service now *routes* each due row
-- (status queued → sent = "visible in the in-app inbox") and records one delivery per external channel.

alter table jarvis.notifications
  add column category     text,        -- deadline | assignment | class | announcement | material | calendar | brief | draft | reminder | system
  add column url          text,        -- deep link inside the dashboard, e.g. /assignments/<id>
  add column read_at      timestamptz, -- opened in the inbox or tapped on a push
  add column dismissed_at timestamptz, -- hidden from the inbox
  add column escalated_at timestamptz; -- an unread critical item was re-sent by email

create index notifications_inbox on jarvis.notifications (id desc) where status = 'sent' and dismissed_at is null;
create index notifications_unread on jarvis.notifications (id) where status = 'sent' and read_at is null and dismissed_at is null;

-- One row per notification per external channel (the in-app inbox needs none).
create table jarvis.notification_deliveries (
  id              bigint generated always as identity primary key,
  notification_id bigint not null references jarvis.notifications (id) on delete cascade,
  channel         text not null check (channel in ('push', 'email', 'telegram')),
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  reason          text,                -- why it exists or was skipped: route | escalation | fallback | rate_limited | no_device …
  attempts        int  not null default 0,
  provider_id     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (notification_id, channel)
);
create index notification_deliveries_pending on jarvis.notification_deliveries (channel, id) where status = 'pending';
create index notification_deliveries_sent on jarvis.notification_deliveries (channel, sent_at) where status = 'sent';

-- Browser / installed-PWA push endpoints (Android Chrome → FCM, iPhone home-screen app → Apple Web Push).
create table jarvis.push_subscriptions (
  id                   bigint generated always as identity primary key,
  endpoint             text not null unique,
  p256dh               text not null,   -- base64url, the browser's ECDH public key
  auth                 text not null,   -- base64url, the browser's auth secret
  device_label         text,
  user_agent           text,
  created_at           timestamptz not null default now(),
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  consecutive_failures int not null default 0,
  disabled_at          timestamptz      -- set when the push service says the endpoint is gone (404/410)
);

alter table jarvis.notification_deliveries enable row level security;
alter table jarvis.push_subscriptions      enable row level security;
