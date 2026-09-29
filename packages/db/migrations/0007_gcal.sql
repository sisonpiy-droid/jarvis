-- Google Calendar occurrences live alongside LMS items (kind 'gcal_event').
alter table jarvis.lms_items drop constraint lms_items_kind_check;
alter table jarvis.lms_items add constraint lms_items_kind_check
  check (kind in ('course', 'material', 'recording', 'assignment', 'event', 'announcement', 'gcal_event'));

insert into jarvis.integrations (provider, status) values ('gcal', 'active') on conflict (provider) do nothing;
