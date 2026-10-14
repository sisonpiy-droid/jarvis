-- Grades and attendance from MESA's Nexus (read-only MCP, token in NEXUS_TOKEN). The `nexus` job copies them here;
-- chat answers from these tables and the job raises the alerts (new marks, attendance dropping under your threshold).
create table jarvis.grades (
  assignment_id text primary key,
  assignment    text not null,
  course        text not null,
  marks         numeric,
  max_marks     numeric,                -- null when Nexus doesn't publish one
  feedback      text,
  released_at   timestamptz,
  first_seen_at timestamptz not null default now(),
  notified_at   timestamptz             -- null until the "new marks" alert went out (set at once for the first sync)
);
create table jarvis.attendance (
  course      text primary key,
  term        text,
  attended    int not null,
  total       int not null,
  percentage  numeric not null,
  updated_at  timestamptz not null default now()
);
insert into jarvis.jobs (name, description, cadence_minutes) values ('nexus', 'Grades and attendance from MESA Nexus: new-marks and low-attendance alerts', 30)
on conflict (name) do nothing;
alter table jarvis.grades enable row level security;
alter table jarvis.attendance enable row level security;
