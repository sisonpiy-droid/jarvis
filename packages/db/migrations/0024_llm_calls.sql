-- Every call that reaches an LLM: what it was for, how many tokens, when. The /costs command, the /costs page and
-- chat's get_costs read it; nothing else does. Spend is estimated from the tokens (llm-usage.ts), never stored.
create table jarvis.llm_calls (
  id            bigint generated always as identity primary key,
  task          text not null,                      -- chat | brief_note | prep_points | recap | week_plan | learning | voice | image_read | draft_assignment | deliverable | …
  model         text not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,             -- includes thinking tokens (billed as output)
  at            timestamptz not null default now()
);
create index llm_calls_at on jarvis.llm_calls (at desc);
alter table jarvis.llm_calls enable row level security;
