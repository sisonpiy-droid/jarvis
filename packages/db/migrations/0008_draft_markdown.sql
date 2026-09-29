-- Keep the draft text itself so the dashboard can show it without opening Word.
alter table jarvis.drafts add column markdown text;
