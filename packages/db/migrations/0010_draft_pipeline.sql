-- Which pipeline produced a draft: v1 = document only, v2 = document + filled workbook/slides.
alter table jarvis.drafts add column pipeline text not null default 'v1';
