-- Commitments: who a task is for (you owe them, status todo/doing) or from (they owe you, status waiting).
-- ponytail: a name on the task, not a people table — add one when people need more than a name.
alter table jarvis.tasks add column person text check (person is null or length(person) between 1 and 80);
create index tasks_person on jarvis.tasks (lower(person)) where person is not null;
