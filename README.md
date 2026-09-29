# JARVIS

Personal AI chief of staff. **Current capability: 24/7 MESA LMS monitoring
with Telegram alerts** (V1: MESA → JARVIS → notifications).

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): target system, database, agents, jobs, notifications, risks
- [docs/MESA_INTEGRATION.md](docs/MESA_INTEGRATION.md): how the LMS works, and how JARVIS talks to it
- [docs/ROADMAP.md](docs/ROADMAP.md): phases and what's next
- [docs/SECURITY.md](docs/SECURITY.md): the credential model

## Commands

```bash
npm install
npm run mesa:login     # Edge opens; you sign in; session saved encrypted (Supabase + local)
npm run setup:db       # asks for the DB password (hidden), writes SUPABASE_DB_URL
npm run db:migrate     # create/upgrade tables in the private "jarvis" schema
npm run sync:mesa      # one sync from this laptop (-- --full, -- --no-send)
npm run deploy:cloud   # bundle + deploy the Edge Function + schedule it every 5 min
npm run mesa:extract   # read-only snapshot → data/snapshots/*.json
npm run verify         # typecheck + lint + tests (no network)
```

## How it runs 24/7 (free)

Supabase pg_cron calls the `mesa-sync` Edge Function every 5 minutes. It refreshes
the MESA session, reads assignments, calendar and announcements (a full scan every
6 h), stores changes, and messages you on Telegram. Your laptop can be off.
Re-run `npm run mesa:login` only if Telegram says the sign-in expired.

Required `.env` values are listed in `.env.example`.
