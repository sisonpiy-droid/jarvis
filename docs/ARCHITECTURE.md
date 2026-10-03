# JARVIS — Architecture

JARVIS is a personal AI chief of staff. It watches the systems your academic
and working life runs on, turns them into one structured, current picture,
tells you what matters, and acts on your instructions. Anything that can't
be undone needs your explicit approval.

**Start with §0. It describes what is actually built** (checked against the code in October 2026, during V2 Phase 0).
§1–§11 are the original V1 design document and are kept for history. Where they disagree with §0, §0 is right.

## 0. As built (October 2026)

```
MESA REST API (read-only MesaClient; cookie → 15-min JWT)   Google Calendar (private iCal URL, read)
          │                                                            │
pg_cron ── one entry per job ──► Edge Function `jarvis-tick?job=<name>` (Supabase, Deno)
   mesa (5 min)      extract → diff → rules → one atomic write; deadline reminders; MESA → tasks/projects; file downloads
   calendar (5 min)  iCal diff → moved/cancelled alerts and 30-min heads-ups
   notify (1 min)    route to the inbox; push / email / Telegram per preferences, quiet hours, caps, escalation
   briefs (15 min)   daily brief 08:00–12:00 IST: facts, focus note (≤1 AI call), stored in `briefs`, inbox + push
   drafts (10 min)   assignment backlog → Vercel /api/jobs/deliver
   habits (5 min)    habit check-in reminders (push with Done / Skip buttons)
   engine (5 min)    goal risk / neglect, slipping habits, task due reminders — each alert once per period;
                     one-time nudge to review old goal/project memories
   health (15 min)   stale/failing jobs; prunes job history after 30 days
          │  each job: own lease lock (jarvis.locks), heartbeat (jarvis.jobs), history (jarvis.job_runs)
          ▼
Supabase Postgres, schema `jarvis` — RLS on, no policies, server-side access only. Migrations 0001–0019
  (0018 and 0019 are Phases 5–6, built but not yet applied live).
          │
Vercel Next.js dashboard (apps/web, installable PWA): command center (/), tasks, projects, goals and habits, inbox, assignments,
  drafts, classes, chat (web transcript), settings (notifications, devices, passkeys, memory), status (job health),
  private ICS feed of MESA classes (/cal), deliverables job (/api/jobs/deliver, docx/xlsx/pptx via Gemini)
Edge `telegram-bot`: owner-only chat (Gemini, tool-calling) and commands — legacy, removed in V2 Phase 11
Edge `mesa-sync`: all jobs in one call (Telegram /sync, manual runs); `npm run sync:mesa` does the same locally
```

**Packages** (all TypeScript, exported as source):

| Package | What it holds |
|---|---|
| `shared` | secret-box (AES-256-GCM), hashing, redacting logger, env loading |
| `mesa` | auth, client, extract, normalize; `login.ts` (Playwright, Node only) |
| `db` | postgres.js client, repository, job health, notifications, passkeys, tasks/projects (`work.ts`), goals/habits (`goals.ts`, pure maths in `progress.ts`), risk/neglect (`risk.ts`, `attention.ts`), focus score and free time (`focus.ts`), the one facts loader (`brief-facts.ts`: `loadBriefFacts`, `briefSections`, stored briefs), migrations; `test/harness.ts` (PGlite) |
| `sync` | diff, rules, time, brief renderer (`brief.ts`), calendar, `run.ts` (`mesaSync`), `jobs.ts` (job runner, schedules), `work.ts` (MESA → tasks/projects), `engine.ts` |
| `notify` | notification service: policy, rendering, Web Push (RFC 8291/8292), email (Resend), Telegram (legacy) |
| `files` | Storage, Office text extraction |
| `calendar` | iCal reader, ICS feed writer |
| `ai` | provider-neutral model types (`model.ts`) and the Gemini adapter, agent loop, chat history (`history.ts`), tools (LMS, tasks, projects, goals, habits, planning), scoped memory, grounding checker and chat guard, focus note, Markdown → chat HTML, Telegram bot (legacy) |
| `assist` | v1 docx drafts (legacy) |
| `deliver` | v2 deliverables |

**Not built yet** (planned in V2), even where §1–§11 mention them:
- pg-boss, Drizzle, Supabase Auth, OpenAI;
- `user_id` columns (JARVIS stays single-owner by decision);
- `pending_actions` / approvals;
- pgvector or pg_trgm memory search (memory search is ILIKE word matching);
- a people table (person memories are keyed by normalised name until Phase 10);
- Gmail and Google OAuth;
- weekly and monthly reviews and approvals (Phases 7–8).

### Phases 5–6 as built (tested, not yet deployed)

**One facts loader.** `db.loadBriefFacts(sql, now)` reads everything the day needs in one batch: open
tasks (and today's done count), projects with their next action, MESA assignments due, the calendar (MESA classes plus
the personal iCal feed), goals and habits with their risk, slipping habits, the MESA integration's health and the
unread count. It also ranks the focus list (`focus.ts`: integer points for priority, IST due bucket, goal link, neglect and effort against today's free
time, each part with a human reason). `briefSections(facts)` cuts it into priorities, upcoming, personal, goals and
risks. The brief, the command center and the chat tools `get_focus` / `get_attention` all read this one loader,
so they cannot disagree.

**Daily brief.**
```
briefs job (every 15 min) ── before 08:00 IST: idle · brief:<day> already queued: idle
   │                         MESA data older than 30 min: wait until 10:00, then send with a stale-data risk line
   │                         after 12:00: idle (missedWindow) — a late morning brief is skipped, not sent
   ▼
loadBriefFacts → briefSections → focus note → renderBrief (≤3,500 chars, sections trimmed line by line)
   │   focus note: reuse briefs.note if today's row exists, else ONE model call (JSON, no tools, 20 s)
   ▼
jarvis.briefs (kind 'daily', day, lines[] each with the source rows it came from, text, note + note_source/detail/refs)
   + notification `brief:<day>` (category 'brief'): inbox, and a push "Your day is ready" outside the hourly cap and digest
```
The model never writes a fact in the note. It writes a template that may only use placeholders (`{P1}`, `{P1.due}`,
`{FREE}`, `{R1}` …) built from the facts; `validateFocusNote` rejects digits, date words, number words, markup, names
and status claims, and the code substitutes the real values. Any failure (no key, `BRIEF_AI=off`, timeout, invalid
reply) falls back to a fixed template over the same placeholders, recorded in `note_detail`
(`no_model` | `no_facts` | `error:<msg>` | `invalid:<rule>`). The note is plain text and escaped when rendered.

**Command center (`/`).** A server component over `loadBriefFacts` plus small view helpers in
`apps/web/lib/command.ts`. Mobile-first order: header (day mode, last LMS check), glance chips (overdue, due today,
free time, habits, at risk, classes), the focus card, the old-notes review banner, priorities with Done / ⋯ (Move to
tomorrow, edit with effort), also-today tasks, next 7 days, calendar and a day strip, habits, goals needing attention,
projects, risks, and LMS changes (streamed in a `<Suspense>` fold). The focus card shows today's stored note
(`getBrief`); before the brief exists it shows `fallbackFocusNote(facts)`, so the page never calls Gemini.

**Provider-neutral model types (`ai/model.ts`).** Messages are `user | assistant | tool` with typed parts (`text`,
`thinking`, `tool_call`, `tool_result`, `file`); provider-only data (Gemini thought signatures) rides in `meta` on the
part it came on. `GeminiProvider` is the only place that knows Gemini's wire shape. Chat history is stored in this
neutral shape (`chat_messages.format = 'neutral'`); older Gemini-shaped rows are converted on read, never rewritten.
`sanitizeHistory` drops half-finished tool exchanges and trims old tool results before they reach the model.
The model's context is the last 24 rows after the channel's latest `marker` row (New conversation). Saves take a
per-channel advisory lock inside one transaction.

**Scoped memory (`ai/memory.ts`).** Each memory has a scope: `global` (preferences, personal context), `mesa`
(optionally one course or assignment), `project` (one project id) or `person` (a normalised name until Phase 10).
For each chat message, `detectMemoryFocus` looks at it and the last two user messages for project titles, course
names and people, and `loadMemories` fills a 6,000-character block in the order preferences, matching projects,
matching people, MESA (only when the message is about MESA), personal context, old notes, ending with a
"(+N more — use search_memory)" footer when anything was left out. `search_memory` is ILIKE word matching. Goals, projects and
anything dated belong in the database, not memory: the save guard refuses them. Old `goal` / `project` notes from V1
wait on `/settings/memory`, where the owner turns each into a real goal or project (prefilled form, owner sets the
target), keeps it as a note, or forgets it; nothing is converted automatically.

**Chat (web and Telegram share `chat()`).**
```
message ─► loadHistory(channel) + scoped memories ─► channel-neutral system prompt ─► runAgent (tools)
        ─► grounding guard: every day, weekday and #id in the answer must appear in the evidence
             (tool results of this turn and the history, the owner's messages, loaded memory ids)
             fail → one correction turn (≤3 steps) → still unbacked → footer "Not found in your data: …"
        ─► saveTurns(channel, turns, meta.guard if it fired) ─► {text, sources (tool names), guard}
```
The rejected draft and the correction prompt are never stored. Planning questions route to `get_focus`, `get_week`,
`get_attention`, `get_accomplished` and `get_commitments`, which read the same facts as the brief. The web chat shows
only the `web` channel: a paged transcript (`?before=<id>`, older pages read-only), a "New conversation" divider
(`POST /api/chat {action:'reset'}` writes a marker row), and a caption per answer, `Checked: <sources> · <time>`,
plus a note when the guard fired. Replies are Markdown rendered by `markdownToChatHtml`, which escapes everything first.

The dashboard signs in with a passkey (recovery codes, `npm run web:login-link` and the legacy Telegram link as fallbacks).
The V2 plan and its phase status are in [ROADMAP.md](ROADMAP.md).

---

*Original V1 design follows.*

**V1 = MESA LMS → JARVIS → Telegram notifications.**

## 1. Current project structure

JARVIS lives in its own repository. The neighbouring `presence-project`
repo is an unrelated Vite/React chat app with a serverless LLM proxy. The
one idea carried over from it is a model-provider interface that lets you
swap providers.

```
jarvis/
├── apps/
│   └── worker/                 background process + CLI entry points      [exists]
│       └── src/mesa-login.ts   interactive sign-in → encrypted session
│       └── src/mesa-extract.ts read-only LMS snapshot → JSON
│   └── web/                    Next.js dashboard + chat                    [Phase 6]
├── packages/
│   ├── shared/                 crypto (AES-GCM), canonical hashing,       [exists]
│   │                           redacting logger, env loading
│   ├── mesa/                   MESA integration: auth, read-only client,  [exists]
│   │                           zod schemas, normalizers, extractor
│   ├── database/               Drizzle schema + migrations (Supabase PG)  [Phase 3]
│   ├── sync/                   diff engine + domain events                [Phase 4]
│   ├── notifications/          channel interface, Telegram, dedupe        [Phase 5]
│   ├── ai/                     provider-agnostic LLM layer + tools        [Phase 7]
│   ├── agents/                 orchestrator + specialised agents          [Phase 7+]
│   └── integrations/{gmail,calendar}                                      [Phase 8]
└── docs/  ARCHITECTURE · MESA_INTEGRATION · ROADMAP · SECURITY
```

Why these differ from the suggested layout:

- `packages/mesa` sits at the top level rather than under
  `integrations/mesa`. It's the first and biggest integration, and a deep
  folder tree adds nothing yet. Gmail and Calendar can join it as siblings.
- Packages are added **only when a phase needs them**. Every package in the
  tree above is either real or scheduled.

Tooling: npm workspaces, TypeScript (strict, `noUncheckedIndexedAccess`),
tsx to run, Vitest, ESLint (typescript-eslint), zod. Packages export their
TypeScript source directly, so there's no build step inside the monorepo.

## 2. Recommended architecture

```
                ┌──────────────┐   cron/interval   ┌─────────────────────────────┐
                │  Scheduler   │ ─────────────────►│ Job queue (pg-boss on PG)   │
                └──────────────┘                   └──────────────┬──────────────┘
                                                                  │
          ┌──────────────────────────────┬────────────────────────┼─────────────────────┐
          ▼                              ▼                        ▼                     ▼
   ┌─────────────┐               ┌──────────────┐         ┌──────────────┐      ┌──────────────┐
   │ MESA sync   │               │ Gmail sync   │         │ Calendar sync│      │ Reminder scan│
   │ (read-only) │               │  (Phase 8)   │         │  (Phase 8)   │      │ (deadlines)  │
   └──────┬──────┘               └──────┬───────┘         └──────┬───────┘      └──────┬───────┘
          │ snapshot                    │                        │                     │
          ▼                             ▼                        ▼                     │
   ┌────────────────────────────────────────────────────────────────────┐              │
   │ Diff engine: upsert by (source, source_id), compare content_hash,  │              │
   │ field-level diff → domain events (outbox table, same transaction)  │              │
   └───────────────────────────────┬────────────────────────────────────┘              │
                                   ▼                                                   ▼
                        ┌──────────────────────┐   decide / batch / dedupe   ┌──────────────────┐
                        │ Notification agent   │ ───────────────────────────►│ Channels:        │
                        │ (rules first, LLM    │                             │ Telegram (V1),   │
                        │  later for ranking)  │                             │ email/push later │
                        └──────────────────────┘                             └──────────────────┘

   ┌──────────────────────┐        ┌───────────────────────────┐
   │ Web dashboard (Next) │ ─────► │ Postgres (Supabase)       │ ◄── all of the above
   │ + JARVIS chat        │        │ + Storage (files)         │
   └──────────┬───────────┘        └───────────────────────────┘
              ▼
   ┌───────────────────────────┐
   │ Orchestrator (tool calls) │ → get_upcoming_assignments(), search_materials(), …
   └───────────────────────────┘
```

Principles:

1. **The worker is the product. The dashboard is only a window onto it.**
   Monitoring never depends on a browser tab being open.
2. **Every integration outputs normalized snapshots.** Sync is a pure step,
   `snapshot + DB state → changes`. That makes it idempotent and testable
   without the network.
3. **Postgres is the source of truth and also the queue** (pg-boss plus an
   outbox table), so there's no Redis to run.
4. **The LLM never sees credentials, and never gets raw database dumps.** It
   reaches data through narrow tool functions.
5. **Read-only by default.** Anything that acts on your behalf (sending,
   submitting, deleting) goes through an approval gate.

## 3. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language for the worker, web and agents. Your requested stack. |
| LMS access | **Private REST API via your session**, Playwright for sign-in only | The API is structured and stable-ID'd. Scraping is fragile. See MESA_INTEGRATION.md. |
| Browser | `playwright-core` + installed **Edge** (`channel: msedge`) | No 150 MB browser download. Configurable via `MESA_BROWSER_CHANNEL`. |
| Validation | zod (loose objects) | Catches schema drift for each record. |
| DB | **Supabase Postgres** + Drizzle ORM | Relational data, row-level security, pgvector for memory, Storage for files, one vendor. Drizzle keeps SQL visible and migrations in the repo. |
| Jobs | **Dedicated Node worker + pg-boss** (Postgres-backed) | Vercel Cron is too coarse on Hobby and serverless can't run long jobs. n8n would add a second system of record and untestable logic. pg-boss gives retries, schedules and singleton jobs on the DB we already run. |
| Worker hosting | Your laptop first (Task Scheduler or `npm run worker`), then **Railway or Fly.io** (one small always-on container) | 24/7 without your machine. Needs no browser, because sign-in happens locally and only the encrypted session is uploaded. |
| Web | Next.js (App Router) + Tailwind on Vercel | Your requested stack. Server components read from Supabase with the service role on the server only. |
| Auth (web) | Supabase Auth, restricted to your email | Single user. Magic link or Google. |
| AI | Provider interface; **OpenAI** default | Swappable. Tool-calling is the only capability the core relies on. |
| Notifications | Telegram Bot API | Free, instant, and supports buttons for approvals. |
| Files | Supabase Storage (private bucket) + sha256 | Downloaded briefs and materials, deduplicated by hash. |

## 4. Required integrations

| Integration | Mechanism | Credentials | Phase |
|---|---|---|---|
| MESA LMS | Your session cookie → `/api/auth/refresh` → Bearer JWT → REST GETs | Encrypted cookie; you sign in interactively | **1–4 (in progress)** |
| Telegram | Bot API (`sendMessage`, inline keyboards, webhook or long-poll) | `TELEGRAM_BOT_TOKEN`, your `chat_id` | 5 |
| Supabase | Postgres + Storage + Auth | `SUPABASE_URL`, service-role key (worker/server only) | 3 |
| OpenAI | Chat Completions / Responses with tools | `OPENAI_API_KEY` | 7 |
| Gmail | Google OAuth 2.0 (`gmail.readonly` first, `gmail.compose` later) + history-ID polling or Pub/Sub push | OAuth refresh token, encrypted | 8 |
| Google Calendar | OAuth 2.0 (`calendar.readonly`, then `calendar.events`) + sync tokens | Same Google grant | 8 |
| Doc parsing | pdf-parse / mammoth (docx) / SheetJS (xlsx) / pptx XML | none | 9 |

## 5. Security model (summary; details in SECURITY.md)

- **You sign in, JARVIS never does.** The LMS password is never typed,
  stored, logged or sent to a model. An OTP step, if one appears, is yours
  to complete.
- **Secrets at rest:**
  - The MESA session is sealed with AES-256-GCM. The key is in
    `MESA_SESSION_KEY`, which lives in `.env` locally and in the host's
    secret store in production.
  - Later, Google refresh tokens are sealed the same way in
    `integrations.secret_sealed`.
- **Secrets in memory:** access tokens only, refreshed every 15 minutes.
- **Logging:** the logger redacts JWTs, Bearer headers, cookies, secret-named
  keys and GCS URL signatures. Snapshots strip URL signatures.
- **Read-only client.** The MESA client has no mutating method, and a test
  enforces this.
- **Frontend:** session cookies and service-role keys never reach the
  browser. The dashboard reads through server components or route handlers.
- **Prompt injection:** LMS text, emails and documents are **data**. The
  orchestrator never takes instructions from tool results, and every
  side-effectful tool needs approval from your own chat or a Telegram button.
- **Approval gate.** Sending email, submitting assignments, deleting
  anything, or messaging third parties creates a `pending_action` row. It
  only runs after you approve that specific action.

## 6. Database design

Postgres (Supabase). `source` + `source_id` identify every external record,
and `content_hash` is the fingerprint used for change detection.

```
users               id, email, display_name, timezone ('Asia/Kolkata'), created_at
integrations        id, user_id, provider ('mesa'|'gmail'|'gcal'|'telegram'), status
                    ('active'|'needs_login'|'error'), secret_sealed (bytea), session_expires_at,
                    last_success_at, last_error, meta jsonb
terms               id, user_id, source, source_id, name, sequence
courses             id, user_id, term_id, source, source_id, title, short_name, instructor,
                    course_type, class_type, source_url, content_hash, first_seen_at,
                    last_seen_at, removed_at            UNIQUE(user_id, source, source_id)
course_topics       id, course_id, source_id, title, type, sequence
assignments         id, user_id, course_id?, source, source_id, title, description_text,
                    description_html, instructions_text, instructions_html, source_url,
                    due_at, cutoff_at, available_from, allow_late, submission_type, is_group,
                    max_marks, lms_status, submission_status, progress ('not_started'|
                    'in_progress'|'drafted'|'done' — JARVIS-side), content_hash,
                    lms_created_at, first_seen_at, last_seen_at, removed_at, updated_at
                    UNIQUE(user_id, source, source_id)
files               id, user_id, sha256 UNIQUE, storage_path, mime_type, size_bytes,
                    original_filename, extracted_text, text_status ('pending'|'done'|
                    'failed'|'unsupported'), created_at
attachments         id, owner_type ('assignment'|'material'|'announcement'|'event'),
                    owner_id, source_id, title, kind, stable_url, file_id? → files,
                    position, content_hash, first_seen_at, removed_at
class_materials     id, course_id, topic_id, source_id, title, kind, category, file_id?,
                    stable_url, text_content, downloadable, lms_updated_at, content_hash, …
recordings          id, course_id, topic_id, source_id, title, provider, video_url, recorded_on
classes (events)    id, user_id, course_id?, source, source_id, title, event_type, status,
                    start_at, end_at, room, meeting_link, instructor, attendance_required,
                    content_hash, first_seen_at, last_seen_at, cancelled_at
announcements       id, user_id, course_id?, source_id, title, body_text, author, pinned,
                    lms_created_at, content_hash
entity_versions     id, entity_type, entity_id, content_hash, snapshot jsonb, seen_at
                    — full history; powers "what changed?" diffs
deadlines           VIEW over assignments(due_at, cutoff_at) ∪ tasks(due_at)
tasks               id, user_id, title, notes, due_at, status, source ('user'|'jarvis'),
                    related_type, related_id, created_at, completed_at
domain_events       id, user_id, type ('assignment.created'…), entity_type, entity_id,
                    payload jsonb, dedupe_key UNIQUE, created_at, processed_at   ← outbox
notifications       id, user_id, event_id?, channel, priority, title, body, dedupe_key
                    UNIQUE, status ('queued'|'sent'|'suppressed'|'failed'), scheduled_for,
                    sent_at, provider_message_id
reminders           id, user_id, target_type, target_id, remind_at, rule ('T-24h'…),
                    fired_at                    UNIQUE(target_type, target_id, rule)
pending_actions     id, user_id, kind ('send_email'|…), payload jsonb, status
                    ('awaiting'|'approved'|'rejected'|'executed'|'expired'), requested_by,
                    decided_at, executed_at, result
conversations       id, user_id, channel ('web'|'telegram'), title, created_at
messages            id, conversation_id, role, content, tool_calls jsonb, created_at
memories            id, user_id, kind ('preference'|'fact'|'project'), content, embedding
                    vector(1536), source_ref, created_at, last_used_at
projects            id, user_id, name, description, status
sync_runs           id, user_id, provider, trigger ('schedule'|'manual'), started_at,
                    finished_at, status ('success'|'partial'|'failed'), request_count,
                    counts jsonb (discovered/new/changed/removed per entity), warnings jsonb,
                    error
activity_log        id, user_id, actor ('jarvis'|'user'|agent name), action, target, detail
                    jsonb, created_at
```

Rules:

- **Idempotent upserts.** `INSERT … ON CONFLICT (user_id, source, source_id)
  DO UPDATE`. A rerun of the same snapshot changes nothing, because the hash
  is equal and `last_seen_at` is the only thing written.
- **Soft removal.** An item missing from a *complete* snapshot gets
  `removed_at`. It is never deleted, because the LMS sometimes hides items
  temporarily.
- **Events go in the same transaction as the upsert** (outbox). A crash can't
  lose an event or double-send it.
- **Row-level security** on every table keys off `user_id`. Only the worker
  uses the service role.

## 7. Agent architecture

```
          user (web chat / Telegram)
                     │
              ┌──────▼───────┐        tools are typed functions with zod schemas;
              │ Orchestrator │        each tool declares: read | write-local | external-action
              └──────┬───────┘
     ┌───────────┬───┴──────┬───────────┬───────────┬───────────┐
     ▼           ▼          ▼           ▼           ▼           ▼
   MESA       Assignment  Research    Email      Calendar     Memory
   agent      agent       agent       agent      agent        agent
 (Phase 7)   (Phase 9)   (Phase 9)  (Phase 8)   (Phase 8)    (Phase 7)
                     Notification agent sits on the event bus, not in the chat path
```

- **V1 has no LLM in the monitoring path.** Sync, diffing and notification
  rules are deterministic code. That's cheap, testable and predictable.
- **An agent is a bundle of tools, prompts and context.** It is not a
  separate process. The orchestrator is one tool-calling loop, and a
  "specialised agent" is a scoped tool set plus a system prompt it can hand
  off to. Adding an agent means registering a module.
- **Tool classes:**
  - `read` runs freely: `get_upcoming_assignments`, `get_assignment`,
    `search_materials`, `get_today_schedule`, `get_pending_tasks`,
    `search_memory`.
  - `write-local` runs freely and is logged: `create_task`,
    `create_reminder`, `save_memory`.
  - `external-action` always creates a `pending_action` and asks you:
    `send_email`, `submit_assignment`, `delete_*`.
- **The Assignment agent (Phase 9) always has the original brief.** The full
  extracted text of the brief and its attachments comes from `files`. A
  summary alone is never used when the original exists.
- **Model provider interface:**
  `generate({system, messages, tools}) → {text, toolCalls, usage}`.
  OpenAI is the first implementation. Anthropic and Gemini adapters come
  from the Presence project's pattern.

## 8. Background job architecture

> **As built (2026-09-29), ₹0/month:** Supabase `pg_cron` → `pg_net` POSTs the
> `mesa-sync` Edge Function every 5 min with a shared secret (stored in Vault).
> The function runs the same `runMesaSync` as `npm run sync:mesa`, guarded by a
> lease lock in `jarvis.locks`. No pg-boss, no separate server; the table below
> is the longer-term plan. Data lives in the private `jarvis` schema
> (`lms_items` + `item_versions` + `domain_events` + `notifications` + `sync_runs`),
> a simplification of §6 for single-user V1.


| Job | Schedule | Notes |
|---|---|---|
| `mesa.sync.light` | every 20 min, 07:00–01:00 IST | `/assignments/my`, `/events/my`, `/announcements?page=1`, `/notifications`: about 4 requests |
| `mesa.sync.full` | every 6 h + on demand | Also walks courses, topics and materials (~150–250 requests) |
| `mesa.fetch_file` | on `material_added` / `assignment.created` | signed URL → download → sha256 → Storage → text extraction |
| `reminders.scan` | every 5 min | Unsubmitted assignments at T-72h / T-24h / T-3h. Classes at T-30m (optional). |
| `notifications.dispatch` | on enqueue | Rate-limited and batched (see §9) |
| `integrations.health` | hourly | Session age and failing syncs. Alerts once when you need to sign in again. |

- **Singleton jobs.** pg-boss `singletonKey` stops two MESA syncs running at
  once, which matters because the refresh cookie may rotate.
- **Retries.** Exponential backoff. An auth failure isn't retried: it marks
  the integration `needs_login` and sends a single "please re-login"
  notification.
- **Manual runs:** `npm run mesa:extract` today; `npm run sync:mesa` from
  Phase 4.

## 9. Notification architecture

```
domain_events ─► rules ─► candidate { priority, dedupe_key, title, body, when }
                          │
                          ├─ dedupe: INSERT … ON CONFLICT (dedupe_key) DO NOTHING
                          ├─ quiet hours (01:00–07:00 IST): hold low/normal, allow urgent
                          ├─ batching: >3 normal items in 10 min → one digest
                          └─ channel router → Telegram (V1) | email | push (later)
```

- **Dedupe keys** encode the thing *and the version* being announced, for
  example:
  - `assignment.created:<id>`
  - `assignment.deadline_changed:<id>:<new due_at>`
  - `reminder:<id>:T-24h`
  - `material.added:<id>`

  The same unchanged fact can never be sent twice, even across restarts.
- **First sync is a baseline.** Everything already present is recorded
  silently. You get notified about what changed after that, plus a
  one-time "JARVIS is now watching N assignments" summary. Otherwise the
  first run would send 39 alerts.
- **Priority:**
  - `urgent`: due within 24 h and not submitted, or a deadline moved
    earlier.
  - `high`: new assignment, or a deadline changed.
  - `normal`: new material or announcement.
  - `low`: edits.
- **Channel interface:**
  `send(userId, {title, body, priority, actions?}) → providerMessageId`.
  Telegram inline buttons ("Mark started", "Snooze", "Approve") come back
  through a webhook as user actions.

## 10. Development roadmap

See [ROADMAP.md](ROADMAP.md). Phases 0–2 are done as of 2026-09-28.

## 11. Risks and limitations

| Risk | Impact | Mitigation |
|---|---|---|
| **Undocumented private API** changes without notice | Sync breaks or data goes subtly wrong | zod validation per record, drift warnings in `sync_runs`, alert on a spike in warnings, fixtures updated from real shapes, DOM-scrape fallback possible |
| **Session lifetime unknown** (refresh-cookie TTL, sliding or not) | Frequent manual sign-ins | Measure it (`mesa:login` prints expiry). Health job warns ahead of expiry. Sign-in takes about 30 seconds. |
| **OTP on login** | 24/7 can't be fully automatic across sign-ins | Deliberate: you complete the OTP. It happens only when the session expires, not every sync. |
| **Terms of use / IT policy** on automated access | Account or policy issue | Read-only, your own data, human-like request rates, same calls as the official app. Consider asking MESA tech for their OK or an official feed. |
| **Rate limiting / load** | Blocked requests | ≤3 concurrent, ≥150 ms gap, backoff on 429, light sync by default |
| **Cookie rotation plus two workers** | One worker logs the other out | Singleton job lock. One worker per integration. |
| **Signed URLs expire in about 15 min** | Stale links in the DB | Store stable URLs. Fetch a fresh signed URL at download time. Keep your own copy in Storage. |
| **Sensitive data at rest** (your grades, your email) | Leak if the DB or laptop is compromised | Supabase row-level security, private bucket, sealed secrets, `data/` gitignored, no secrets in logs |
| **LLM prompt injection** via LMS, email or doc content | JARVIS tricked into acting | Tool results are data. Approval gate on external actions. No auto-send in early phases. |
| **Academic integrity** (Phase 9 "solve assignments") | Policy violation | JARVIS drafts, researches and structures. You review, own and submit. Nothing is ever auto-submitted. Check MESA's policy on AI assistance. |
| **Single-user assumptions** | Harder to share later | `user_id` on every row from day one |
