-- V2 Phase 2: one task and project model for personal and professional work. MESA assignments and exams
-- become projects with tasks automatically (packages/sync/src/work.ts); everything else is added by hand or chat.
-- LMS fields stay in lms_items: a project only adds planning state on top.

create table jarvis.projects (
  id          bigint generated always as identity primary key,
  title       text not null check (length(title) between 1 and 300),
  objective   text,
  domain      text not null default 'professional' check (domain in ('personal', 'professional')),
  area        text,                                   -- free label: mesa, career, fitness, startup …
  kind        text not null default 'other'
              check (kind in ('mesa_assignment', 'exam', 'case_comp', 'startup', 'job_search', 'product', 'research', 'personal', 'other')),
  status      text not null default 'active' check (status in ('active', 'on_hold', 'done', 'cancelled')),
  priority    int  not null default 2 check (priority between 1 and 4),   -- 1 = highest
  deadline    timestamptz,
  source      text not null default 'manual' check (source in ('manual', 'chat', 'mesa')),
  source_ref  text,                                   -- e.g. assignment:<id>, exam:<event id>
  source_data jsonb,                                  -- last LMS values applied (changes are applied once)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  completed_at timestamptz
);
create unique index projects_source on jarvis.projects (source, source_ref) where source_ref is not null;
create index projects_open on jarvis.projects (deadline nulls last) where status in ('active', 'on_hold');

-- Decisions, open questions, blockers, notes, documents and people for a project (one table, not five).
create table jarvis.project_items (
  id          bigint generated always as identity primary key,
  project_id  bigint not null references jarvis.projects (id) on delete cascade,
  kind        text not null check (kind in ('decision', 'question', 'blocker', 'note', 'document', 'person')),
  body        text not null check (length(body) between 1 and 4000),
  ref         text,                                   -- URL, /drafts/<id>, file sha …
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index project_items_project on jarvis.project_items (project_id, created_at);

create table jarvis.tasks (
  id               bigint generated always as identity primary key,
  title            text not null check (length(title) between 1 and 300),
  notes            text,
  domain           text not null default 'professional' check (domain in ('personal', 'professional')),
  area             text,
  project_id       bigint references jarvis.projects (id) on delete set null,
  priority         int  not null default 2 check (priority between 1 and 4),
  status           text not null default 'todo' check (status in ('todo', 'doing', 'waiting', 'done', 'cancelled')),
  due_at           timestamptz,
  due_is_date_only boolean not null default false,    -- "Friday" (end of day IST) vs an exact time
  effort_min       int check (effort_min between 1 and 10000),
  is_next_action   boolean not null default false,
  source           text not null default 'manual' check (source in ('manual', 'chat', 'mesa')),
  source_ref       text,                              -- e.g. mesa:submit:<assignment id>
  source_data      jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create unique index tasks_source on jarvis.tasks (source, source_ref) where source_ref is not null;
create index tasks_open on jarvis.tasks (due_at nulls last) where status in ('todo', 'doing', 'waiting');
create index tasks_project on jarvis.tasks (project_id, status);

alter table jarvis.projects      enable row level security;
alter table jarvis.project_items enable row level security;
alter table jarvis.tasks         enable row level security;
