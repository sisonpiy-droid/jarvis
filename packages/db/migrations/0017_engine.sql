-- V2 Phase 4: progress, risk and neglect engine. Risk and neglect are computed (packages/db/src/risk.ts),
-- never stored; only your answers to a neglect prompt are kept, so they can be honoured and reviewed later.

create table jarvis.goal_decisions (
  id         bigint generated always as identity primary key,
  goal_id    bigint not null references jarvis.goals (id) on delete cascade,
  reason     text not null check (reason in ('neglect', 'risk')),
  choice     text not null check (choice in ('continue', 'pause', 'change_target', 'archive')),
  detail     jsonb,                    -- e.g. {"from": 4, "to": 3} for a changed target
  created_at timestamptz not null default now()
);
create index goal_decisions_goal on jarvis.goal_decisions (goal_id, created_at desc);

-- "Continue" quiets the neglect prompt for one threshold length.
alter table jarvis.goals add column attention_snoozed_until date;

insert into jarvis.jobs (name, description, cadence_minutes) values ('engine', 'Goal risk and neglect alerts, task due reminders', 5)
on conflict (name) do nothing;

alter table jarvis.goal_decisions enable row level security;
