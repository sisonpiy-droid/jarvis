-- V2 Phase 6: scoped memory and provider-neutral chat history.

-- 1. What a memory is about. Dated facts never belong here (tasks / goals / projects); saveMemory enforces it.
--    global  = always relevant (preferences, personal context)
--    mesa    = MESA / LMS context; subject null, 'course:<id>' or 'assignment:<id>'
--    project = one project; subject = project id
--    person  = one person; subject = normalised name until the people table exists (Phase 10)
alter table jarvis.memories
  add column scope         text not null default 'global',
  add column subject_id    text,
  add column subject_label text,          -- display name at save time (project title, person's name)
  add column reviewed_at   timestamptz,   -- legacy 'goal'/'project' notes: when the owner answered the one-time review
  add column converted_to  text;          -- 'goal:<id>' | 'project:<id>' | 'kept' | 'forgotten'

alter table jarvis.memories
  add constraint memories_scope check (scope in ('global', 'mesa', 'project', 'person')),
  add constraint memories_scope_subject check (
        (scope = 'global'  and subject_id is null)
     or (scope = 'mesa'    and (subject_id is null or subject_id ~ '^(course|assignment):.+$'))
     or (scope = 'project' and subject_id is not null and subject_id ~ '^[0-9]+$')
     or (scope = 'person'  and subject_id is not null and length(subject_id) between 1 and 80)),
  add constraint memories_converted_to check (converted_to is null or converted_to ~ '^(goal:[0-9]+|project:[0-9]+|kept|forgotten)$');

-- memories_unique_active (lower(content)) where active is deliberately UNCHANGED: deployed save_memory uses it
-- as its ON CONFLICT target.
create index memories_by_subject on jarvis.memories (scope, subject_id) where active;
create index memories_legacy_pending on jarvis.memories (id) where active and kind in ('goal', 'project') and reviewed_at is null;

-- 2. Chat history. Rows written from Phase 6 on are provider-neutral; older rows keep Gemini's shape and are
--    converted when read (never rewritten). The default keeps a not-yet-redeployed writer correct.
--    'marker' rows record "New conversation": the model's context starts after the latest one.
alter table jarvis.chat_messages
  add column format text not null default 'gemini',
  add column meta   jsonb;   -- e.g. {"guard":{"repaired":true,"unverified":["10-09","#44"]}} on a final answer
alter table jarvis.chat_messages add constraint chat_messages_format check (format in ('gemini', 'neutral'));
alter table jarvis.chat_messages drop constraint chat_messages_role_check;
alter table jarvis.chat_messages add constraint chat_messages_role_check check (role in ('user', 'model', 'tool', 'marker'));
