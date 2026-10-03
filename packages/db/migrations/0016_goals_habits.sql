-- V2 Phase 3: goals, habits and the activity log. A goal carries its own measurable target (no separate
-- Target table). Progress, streaks and "missed" are never stored: they are derived from activities, so they
-- can't drift (packages/db/src/progress.ts).

create table jarvis.goals (
  id             bigint generated always as identity primary key,
  title          text not null check (length(title) between 1 and 300),
  description    text,
  domain         text not null default 'personal' check (domain in ('personal', 'professional')),
  area           text,                                       -- fitness, reading, career, mesa …
  parent_goal_id bigint references jarvis.goals (id) on delete set null,
  metric         text not null default 'count' check (metric in ('count', 'duration_min', 'boolean', 'value')),
  target_value   numeric check (target_value is null or target_value > 0),
  unit           text,                                       -- workouts, pages, minutes, kg …
  period         text not null default 'week' check (period in ('day', 'week', 'month', 'quarter', 'year', 'total')),
  start_date     date not null default ((now() at time zone 'Asia/Kolkata')::date),
  target_date    date,
  status         text not null default 'active' check (status in ('active', 'completed', 'paused', 'abandoned')),
  priority       int  not null default 2 check (priority between 1 and 4),
  source         text not null default 'manual' check (source in ('manual', 'chat', 'rule')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index goals_open on jarvis.goals (status, priority);

create table jarvis.habits (
  id            bigint generated always as identity primary key,
  goal_id       bigint references jarvis.goals (id) on delete set null,
  name          text not null check (length(name) between 1 and 200),
  description   text,
  -- {"freq":"daily"} | {"freq":"weekly","days":[1,3,5]} (ISO weekdays, Mon=1) | {"freq":"weekly","times":4} | {"freq":"monthly","times":2}
  schedule      jsonb not null default '{"freq":"daily"}',
  reminder_time time,                                        -- IST; null = no reminder
  start_date    date not null default ((now() at time zone 'Asia/Kolkata')::date),
  end_date      date,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index habits_active on jarvis.habits (active, goal_id);

-- Append-only log of what actually happened. One row per habit per IST day (dedupe_key habit:<id>:<date>),
-- one per completed linked task (task_done:<id>); free logs get a random key.
create table jarvis.activities (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  day          date not null,                                -- IST calendar day of occurred_at (periods are IST)
  kind         text not null check (kind in ('habit', 'task_done', 'log', 'auto')),
  status       text not null default 'done' check (status in ('done', 'skipped')),
  goal_id      bigint references jarvis.goals (id) on delete cascade,
  habit_id     bigint references jarvis.habits (id) on delete cascade,
  task_id      bigint references jarvis.tasks (id) on delete set null,
  project_id   bigint references jarvis.projects (id) on delete set null,
  value        numeric not null default 1,
  duration_min int check (duration_min is null or duration_min between 0 and 1440),
  note         text,
  source       text not null default 'ui' check (source in ('push_action', 'ui', 'chat', 'rule', 'calendar')),
  dedupe_key   text not null unique,
  created_at   timestamptz not null default now()
);
create index activities_goal on jarvis.activities (goal_id, day);
create index activities_habit on jarvis.activities (habit_id, day);

-- Link work to goals ("applications" goal ← each application task).
alter table jarvis.tasks    add column goal_id bigint references jarvis.goals (id) on delete set null;
alter table jarvis.projects add column goal_id bigint references jarvis.goals (id) on delete set null;

-- Habit reminders (one pg_cron entry, like the other jobs).
insert into jarvis.jobs (name, description, cadence_minutes) values ('habits', 'Habit reminders (Done / Skip on the push)', 5)
on conflict (name) do nothing;

alter table jarvis.goals      enable row level security;
alter table jarvis.habits     enable row level security;
alter table jarvis.activities enable row level security;
