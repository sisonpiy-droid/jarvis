# Roadmap

## V2 — personal operating system (approved October 2026)

The full plan covers architecture, data model, phases and risks. Decisions:
- single owner, with no `user_id`;
- Target folded into Goal;
- MESA stays on its REST API, with Playwright only for sign-in;
- Gemini free tier behind a provider-neutral layer;
- passkey login;
- push to Android and iPhone;
- Gmail for personal and MESA accounts;
- Telegram kept for rollback until Phase 11, then removed only with explicit approval.

| # | Phase | Status |
|---|---|---|
| 0 | Foundations: job health (`jobs`, `job_runs`, `settings`), one pg_cron entry per job via `jarvis-tick`, PGlite database tests, docs in line with the code, Google OAuth feasibility | ✅ live 2026-10-01 |
| 1 | Leave Telegram: notification service (routing, quiet hours, caps, escalation, digests), in-app inbox, installable PWA, web push (Android + iPhone), email (Resend), passkeys + recovery codes; Telegram optional (fallback/mirror/off) | ✅ live 2026-10-01 (closed by owner; Android/iPhone push still to be confirmed on device — Telegram covers alerts until then) |
| 2 | Tasks and projects: `projects`, `project_items`, `tasks` (0015); MESA assignments → project + “Submit” task (+ “Review the JARVIS draft”), exams → project + “Prepare for” task, closed/cancelled from LMS changes; /tasks, /projects, Today; chat tools | ✅ live 2026-10-01 |
| 3 | Goals, habits, activity: `goals` (target folded in), `habits` (daily / weekdays / N× per week or month), `activities` log (0016); progress, streaks and misses derived in IST (`progress.ts`); /goals, goal detail, Today habits, one-tap /q/habit check-in; `habits` job sends reminders with Done / Skip push buttons; completed linked tasks count toward goals; chat tools | ✅ live 2026-10-01 |
| 4 | Progress, risk and neglect engine: pace-based risk (on track / at risk / off track, first partial period prorated, habit-only capacity), neglect thresholds by period, slipping habits (`risk.ts`, `attention.ts`); `engine` job (5 min) sends each alert once per period plus task due reminders (exact time 1 h before, date-only 09:00, exam prep 48 h); Needs-attention card with Keep going / Pause / Change target / Archive, answers recorded (`goal_decisions`, 0017); chat `get_attention`, `respond_to_goal` | ✅ live 2026-10-01 |
| 5 | Command center and daily brief v2: one facts loader (`loadBriefFacts`) shared by the brief, `/` and chat; focus score (`focus.ts`); brief stored with per-line source rows (`briefs`, 0018); AI focus note written as placeholders only, validated, with a fixed-template fallback; brief window 08:00–12:00 IST, push exempt from cap and digest; `/` rebuilt mobile-first (glance chips, focus card, calendar, day strip, effort field, Move to tomorrow, active tab) | ✅ live 2026-10-03 |
| 6 | AI chief of staff and scoped memory: provider-neutral model types; chat history stored neutral with `marker` rows for New conversation (0019); scoped memory (global / MESA / project / person) with a save guard, `search_memory`, legacy goal/project notes reviewed on `/settings/memory`; planning tools (`get_focus`, `get_week`, `get_accomplished`, `get_commitments`, extended `get_attention`); channel-neutral prompt; grounding guard on every chat answer; web chat transcript with paging, sources caption and starter chips | ✅ live 2026-10-03 |
| 6+ | Extras: **pre-class prep** — `prep` job (5 min): session number worked out from recordings + timetable (`class-prep.ts`), that session's pre-read and materials, AI key points stored once per document (`prep_notes`, 0020; numbers not in the document are dropped), push ~30 min before each MESA session (tomorrow's pre-reads now come in the evening check-in), `/classes/[id]`, chat `get_class_prep`. **Share to JARVIS** — PWA share target (Android) → service worker → `/share` (ask JARVIS or add as task); 📎 in chat (all phones); files uploaded straight to Storage (signed URL, ≤ 25 MB), stored by sha256, text extracted (PDF, Office, text; images read by the model) for `read_file_text`. **Voice** — 🎤 in chat: recorded, re-encoded to 16 kHz WAV in the browser, transcribed (silence never sent to the model) into the box for review; 🔊 read-aloud on replies | built 2026-10-03 |
| CoS | Chief of staff v1 (0021). **A — knows the situation:** every chat turn loads a live briefing (`situation.ts`: today's time left and priorities, overdue, habits, the next 7 days day by day with classes / other blocks / deadlines / free time, crunch days, risks, what can wait, work patterns); prompt stance "make the call, with times and a reason"; the briefing counts as grounding evidence. **B — learns the owner:** nightly (22:30) lasting facts from the day's own chat messages through the memory save guard (`reflect.ts`, source `learned`, badge + forget on `/settings/memory`); work patterns without AI (`patterns.ts`: real submission times read once per assignment from `/assignments/{id}/submissions` → median lead, last-minute count, late rate, tightest course; when work gets finished; own on-time rate; tasks postponed ≥2 — `tasks.postponed_count`). **C — runs the day quietly:** brief adds CAN WAIT; 20:30 evening check-in (`checkin.ts`: done, still open with one-tap move to tomorrow — push button or `/checkin`, MESA work due tonight, tomorrow with pre-reads, tomorrow's top 3, one pattern nudge); alerts that learn (`alert-learning.ts`: a normal/low kind with ≥6 pushes and none opened in 14 days stops pushing, never deadlines/classes/briefs/reminders/system, retried after 30 days, "Turn back on" in Settings; `notifications.opened_at` from push taps). `evening` job (15 min). | built 2026-10-04 |
| 7 | Weekly and monthly reviews (migration 0022; reuses `briefs.kind`) | — |
| 8 | Approval and action system | — |
| 9 | Google OAuth and two-way calendar | — |
| 10 | Gmail | — |
| 11 | Hardening and Telegram removal | — |

### Phases 5–6: changes from the plan

- **No `packages/briefing`.** The facts loader and focus maths live in `packages/db` (`brief-facts.ts`, `focus.ts`);
  the focus note and the grounding checker in `packages/ai` (`focus-note.ts`, `grounding.ts`); the brief renderer
  stays in `packages/sync/src/brief.ts`. One loader serves the brief, `/` and the chat tools, with no package cycle.
- **Migrations 0018 and 0019.** `0018_briefs.sql` adds the briefs table (with `kind`, daily only for now);
  `0019_memory_scopes.sql` adds memory scopes and chat `format` / `meta` / the `marker` role. Phase 7 starts at
  **0022** (0020 went to class prep, 0021 to chief of staff) and widens `briefs.kind` to weekly and monthly instead of adding a table.
  0019 was tightened before it was ever applied: a project-scoped memory must have a non-null subject.
- **`get_at_risk` is `get_attention`,** extended (deadlines at risk, slipping habits, overdue count, system health with
  `lms_stale` after 3 h). There is no alias: every extra tool declaration costs tokens on every request.
- **No pg_trgm.** `search_memory` is ILIKE word matching. It is weaker on typos. Upgrade path: confirm the extension's
  schema on the live database, add PGlite's `contrib/pg_trgm` to the test harness, then add a GIN index and
  `word_similarity` ordering behind the same `searchMemories` signature.
- **The chat guard checks days, weekdays and ids only.** Clock times, counts and durations are not checked. Evidence is
  this turn's and the history's tool results (failed calls' error text included), every owner message in the loaded
  history, and the ids of the loaded memories.
- **`get_week`** adds an `events` list (personal calendar) per day; deadline items carry `project` (tasks) or `course`
  (assignments).

### Phases 5–6: deploy runbook and manual checks

Not deployed yet. In order, after Phases 0–4 are live:
1. `npm run db:migrate` (applies 0018 and 0019). `deploy-cloud.ts` refuses to deploy without `0019_memory_scopes.sql`.
2. `npm run deploy:cloud` — `jarvis-tick` (briefs, engine nudge), `mesa-sync`, `assignment-draft`, and `telegram-bot`
   **in the same release**: `chat()` now requires a channel and writes neutral history rows.
3. Redeploy the web app (Vercel). Optional Edge secret: `BRIEF_AI=off` for the template note only.

Rolling back to code from before Phase 6: old code cannot read neutral or `marker` chat rows. Stop using chat, or delete
`jarvis.chat_messages` rows where `format = 'neutral'` (and the markers) before the old bundles run. Inserting a marker
row per channel is not enough on its own, because old code does not filter markers.

Manual done-when checks (need the live app, a phone and real Gemini):
- One tool-using chat with several steps succeeds (thought signatures survive the neutral types).
- The 08:00 brief arrives as "Your day is ready", with the same focus note at the top of `/`. Check
  `jarvis.briefs.note_source` / `note_detail` (also in the briefs job run's stats): `invalid:<rule>` days mean the
  note fell back to the template; tune the allowed words, not the date rules.
- `/` at 375 px: no sideways page scroll (only the chip row scrolls); ⋯ → Move to tomorrow works and is absent on MESA
  tasks; Effort saves in quick add and the edit form; the active tab is highlighted.
- `/settings/memory`: Make it a goal opens a prefilled goal form and the note leaves the review list; Keep as note
  moves it into About you; the home banner disappears once every old note is answered; the engine queues
  `memory.review:v1` once.
- `/chat` at 375 px: opens at the newest message; the composer does not zoom and grows to 5 lines; ⋯ → New conversation
  adds a divider that survives a reload; Show earlier messages / Back to the latest messages page correctly; the card
  height leaves the composer above the tab bar (adjust the offset in `chat-box.tsx` if not).
- Ask the 10 planning questions in web chat: each `Checked: …` caption lists the expected sources and no
  "Not found in your data" footer appears.

## V1 (history)

Principle: build a working vertical slice first, then widen it. Every phase
ends with `npm run verify` (typecheck + lint + tests), a live check where
possible, and doc updates.

| # | Phase | Status | Exit criteria |
|---|---|---|---|
| 0 | Inspect repo and environment | ✅ 2026-09-28 | Stack decided; new `jarvis` repo |
| 1 | Investigate MESA LMS | ✅ 2026-09-28 | Auth flow, API catalogue, file access documented ([MESA_INTEGRATION.md](MESA_INTEGRATION.md)) |
| 2 | LMS extraction layer (PoC) | ✅ 2026-09-28 | `mesa:login` + `mesa:extract` work live; 0 warnings; hashes stable across runs; 57 tests |
| 3 | Database | ✅ 2026-09-29 | Built: private `jarvis` schema, plain-SQL migrations (`npm run db:migrate`), RLS on, repository in `packages/db`. Changed from plan: no Drizzle; generic `lms_items` table; repo verified live, not against a test Postgres |
| 4 | Sync engine | ✅ 2026-09-29 (files ✅ later) | `npm run sync:mesa`: snapshot → diff → items + versions + events + notifications in one transaction; per-kind baseline; light/full; removal only on complete reads. File download to Storage not yet built |
| 5 | Telegram notifications | ✅ 2026-09-29 | Bot, dedupe keys, quiet hours, batching, deadline reminders (T-72h/24h/3h), "session expiring" alert |
| 6 | Dashboard | ✅ 2026-09-29 (Vercel, Telegram magic-link login) | Next.js: Today / Assignments / Classes / Sync-runs debug page, behind a Telegram magic-link login (not Supabase Auth) |
| 7 | JARVIS chat + tools | ✅ 2026-09-29 (Telegram, Gemini free tier) | Provider-agnostic LLM layer; read tools over the DB; `create_task` / `create_reminder`; chat answers "what's due this week?" from real data |
| 8 | Gmail + Calendar | 🟡 Calendar ✅ (personal Google Calendar via private iCal feed). Gmail ⏸ deferred by choice (most communication is on the LMS) | OAuth, read-only sync, classification, draft replies (approval-gated send) |
| 9 | Assignment intelligence | ✅ v2 2026-09-29: finished deliverables — filled Excel templates (exact pivots as live formulas + native charts), slide decks with native charts, Word doc; runs on Vercel (/api/jobs/deliver) | Brief parsing (PDF/DOCX/PPTX/XLSX), requirement extraction, material retrieval, draft deliverables, checks against the original |
| 10 | 24/7 orchestration | 🟡 monitoring live on Supabase (pg_cron → Edge Function, every 5 min, ₹0) | Daily brief, health page |

## Current state (2026-09-29)

Live in Supabase: `mesa-sync` (cron, 5 min; files; 8 am brief), `telegram-bot` (owner-only chat + commands), `assignment-draft` (reads the original brief/attachments + ranked class material, drafts with Gemini, delivers a .docx; never submits). Also live: long-term memory (/memory), web dashboard (https://jarvis-dashboard-ashy-seven.vercel.app), personal Google Calendar. Gmail deferred by choice.

Monitoring runs in the cloud: pg_cron calls the `mesa-sync` Edge Function every 5 minutes (light check, ~3 GETs); a full scan runs when the last one is >6 h old. Next up: file downloads to Storage (Phase 4 remainder), then the dashboard (Phase 6) and chat (Phase 7, Gemini free tier).

Files are downloaded into Supabase Storage with sha256 dedupe (built after this note was first written).

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
