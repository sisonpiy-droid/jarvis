-- Files attached to a notification (jarvis.files sha256s): class material before a class, the deck after it.
-- Telegram sends them as documents right after the message; the inbox and push link to the class page instead.
alter table jarvis.notifications add column files text[];
