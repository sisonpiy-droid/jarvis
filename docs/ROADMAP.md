# Roadmap

Principle: build a working vertical slice first, then widen it. Every phase
ends with `npm run verify` (typecheck + lint + tests), a live check where
possible, and doc updates.

| # | Phase | Status | Exit criteria |
|---|---|---|---|
| 0 | Inspect repo and environment | ✅ 2026-09-28 | Stack decided; new `jarvis` repo |
| 1 | Investigate MESA LMS | ✅ 2026-09-28 | Auth flow, API catalogue, file access documented ([MESA_INTEGRATION.md](MESA_INTEGRATION.md)) |
| 2 | LMS extraction layer (PoC) | ✅ 2026-09-28 | `mesa:login` + `mesa:extract` work live; 0 warnings; hashes stable across runs; 57 tests |
| 3 | Database | ✅ 2026-09-29 | Built: private `jarvis` schema, plain-SQL migrations (`npm run db:migrate`), RLS on, repository in `packages/db`. Changed from plan: no Drizzle; generic `lms_items` table; repo verified live, not against a test Postgres |
| 4 | Sync engine | ✅ 2026-09-29 (files: pending) | `npm run sync:mesa`: snapshot → diff → items + versions + events + notifications in one transaction; per-kind baseline; light/full; removal only on complete reads. File download to Storage not yet built |
| 5 | Telegram notifications | ✅ 2026-09-29 | Bot, dedupe keys, quiet hours, batching, deadline reminders (T-72h/24h/3h), "session expiring" alert |
| 6 | Dashboard | ✅ 2026-09-29 (Vercel, Telegram magic-link login) | Next.js: Today / Assignments / Classes / Sync-runs debug page, behind Supabase Auth |
| 7 | JARVIS chat + tools | ✅ 2026-09-29 (Telegram, Gemini free tier) | Provider-agnostic LLM layer; read tools over the DB; `create_task` / `create_reminder`; chat answers "what's due this week?" from real data |
| 8 | Gmail + Calendar | 🟡 Calendar ✅ (personal Google Calendar via private iCal feed). Gmail ⏳ needs a Google OAuth app | OAuth, read-only sync, classification, draft replies (approval-gated send) |
| 9 | Assignment intelligence | ✅ 2026-09-29 (drafts → .docx on Telegram; auto for new work, /draft on request) | Brief parsing (PDF/DOCX/PPTX/XLSX), requirement extraction, material retrieval, draft deliverables, checks against the original |
| 10 | 24/7 orchestration | 🟡 monitoring live on Supabase (pg_cron → Edge Function, every 5 min, ₹0) | Daily brief, health page |

## Current state (2026-09-29)

Live in Supabase: `mesa-sync` (cron, 5 min; files; 8 am brief), `telegram-bot` (owner-only chat + commands), `assignment-draft` (reads the original brief/attachments + ranked class material, drafts with Gemini, delivers a .docx; never submits). Also live: long-term memory (/memory), web dashboard (https://jarvis-dashboard-ashy-seven.vercel.app), personal Google Calendar. Remaining: Gmail (OAuth).

Monitoring runs in the cloud: pg_cron calls the `mesa-sync` Edge Function every 5 minutes (light check, ~3 GETs); a full scan runs when the last one is >6 h old. Next up: file downloads to Storage (Phase 4 remainder), then the dashboard (Phase 6) and chat (Phase 7, Gemini free tier).

Deferred from Phase 4: downloading files into Supabase Storage with sha256 dedupe (metadata and stable URLs are stored today).

## Phase 3 — Database (original plan)

1. Create a Supabase project. Put `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
2. `packages/database`: a Drizzle schema for `users, integrations, terms,
   courses, course_topics, assignments, attachments, files,
   class_materials, recordings, classes, announcements, entity_versions,
   domain_events, notifications, reminders, sync_runs, activity_log`.
   Chat, memory and task tables come in Phase 7.
3. Idempotent upsert helpers keyed on `(user_id, source, source_id)`.
4. Tests against a throwaway Postgres (Docker or `pglite`), never the real
   project.
5. Move the sealed MESA session into `integrations.secret_sealed`, with the
   file store as a dev fallback.

## Phase 4 — Sync engine

- Diff = `normalize(snapshot)` vs rows. It emits `assignment.created`,
  `assignment.updated` (with a field-level diff), `assignment.deadline_changed`,
  `assignment.material_added`, `assignment.submission_changed`,
  `class.created`, `class.updated`, `class.cancelled`, `material.added`,
  `announcement.created`.
- **Baseline**: the first run for an integration emits no user-facing events.
- **Removal**: only when the snapshot for that collection was *complete*
  (that endpoint had no errors).
- **Light sync** every 20 min: assignments, events, announcements p1, LMS
  notifications. **Full sync** every 6 h.
- **Files**: new downloadable material or brief → `signed-url` → stream →
  sha256 → Storage → `files.text_status = 'pending'`.

## What V1 deliberately excludes

Assignment solving, email sending, calendar writes, multi-user support,
mobile push. The interfaces for them exist; the implementations wait until
LMS monitoring has been reliable for a couple of weeks.
