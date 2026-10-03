# Security

Checked against the code in October 2026 (V2 Phase 0; the LLM boundary again for Phases 5–6). JARVIS has a single owner by design.

## Credentials

| Secret | Where it lives | Who can read it |
|---|---|---|
| MESA password and OTP | **Nowhere.** You type them into the real MESA page in a Playwright-launched Edge window. | You |
| MESA session cookie | `jarvis.integrations.secret_sealed` (AES-256-GCM); a local copy in `.secrets/mesa-session.enc` | Edge Functions and worker |
| `MESA_SESSION_KEY` | `.env` (gitignored); Supabase Edge secrets | Edge Functions and worker |
| MESA access token (JWT, 15 min) | Process memory only | Edge Functions and worker |
| `SUPABASE_SECRET_KEY` (Storage) | `.env`; Vercel env | Worker, dashboard server |
| `SUPABASE_DB_URL` (contains the DB password) | `.env`; Vercel env. Edge Functions get the platform's own copy. | Worker, dashboard server, Edge Functions |
| `SUPABASE_ACCESS_TOKEN` (CLI) | `.env` only | Deploy script on your laptop |
| `CRON_SECRET` | `.env`; Supabase Edge secrets; Vault (`jarvis_cron_secret`, read by pg_cron); Vercel env | Scheduler, Edge Functions, dashboard job route |
| `WEB_SESSION_SECRET` | `.env`; Vercel env. It also derives the calendar-feed token. | Dashboard server |
| `GEMINI_API_KEY` | `.env`; Supabase Edge secrets; Vercel env. Sent only in the `x-goog-api-key` header. | Servers |
| Telegram bot token and webhook secret | `.env`; Supabase Edge secrets (legacy and optional, removed in Phase 11) | Edge Functions |
| `VAPID_PRIVATE_KEY` (push signing) | `.env`; Supabase Edge secrets. Never rotate casually: every subscribed device is bound to the key pair. | notify job |
| `VAPID_PUBLIC_KEY` | `.env`; Supabase Edge secrets; Vercel env (it is public by design, given to browsers) | notify job, dashboard |
| `RESEND_API_KEY` | `.env`; Supabase Edge secrets | notify job |
| Passkeys | `jarvis.passkeys`: public keys only; private keys never leave your devices | Dashboard server |
| Recovery codes | `jarvis.recovery_codes`: SHA-256 hashes only; shown to you once | Dashboard server |
| Push subscriptions | `jarvis.push_subscriptions` (endpoint + browser keys; treat as secret) | notify job |
| `GCAL_ICS_URL` (private calendar address) | `.env`; Supabase Edge secrets | Calendar job |

None of these reach the browser bundle or the LLM.

## Rules the code enforces

- **Read-only MESA client.** `MesaClient` has only `get`, and a test fails if a mutating method appears.
- **Cookie scoping.** Only `*.mesaschool.co.in` cookies are saved (`filterMesaCookies`).
- **Tamper-evident storage.** GCM authentication makes a modified or wrong-key session fail to decrypt.
- **Database access is server-side only.**
  - The `jarvis` schema is revoked from `anon` and `authenticated`.
  - RLS is on for every table with no policies; a test checks this.
  - Only the server roles (Edge Functions, worker, dashboard server) connect.
- **Sign-in (Phase 1).**
  - Passkeys (WebAuthn): phishing-resistant and bound to the dashboard origin. The challenge is HMAC-sealed in a strict 5-minute cookie and usable once.
  - Recovery codes: one-time, hashed, rate-slowed.
  - `npm run web:login-link` (laptop with `.env`) and the legacy Telegram link remain as fallbacks.
- **Owner-only entry points.**
  - The dashboard needs a signed, httpOnly session cookie, checked on every page and API route.
  - The Telegram bot ignores every chat except `TELEGRAM_CHAT_ID` and checks the webhook secret header.
  - Scheduled and job endpoints need `Bearer CRON_SECRET`, compared in constant time.
- **Redacting logger.** It scrubs JWTs, `Bearer` values, secret-named keys and signed-URL parameters.
- **LLM boundary.**
  - Tools return database data only.
  - LMS, file and calendar text is marked as untrusted data in prompts.
  - Tools are classified `read` or `write-local`. Nothing external or irreversible is exposed to the model.
  - **Focus note (Phases 5–6, not yet deployed).** The brief's model call has no tools and gets only labelled facts.
    It must answer with a template of placeholders (`{P1}`, `{P1.due}`, `{FREE}` …). `validateFocusNote` rejects
    any reply with digits, date or number words, markup or emoji, unknown placeholders, names or status claims, so a
    date, count or instruction smuggled in through a task or LMS title cannot reach the brief. The code substitutes
    the real values; anything invalid, slow or failing falls back to a fixed template, and the reason is stored in
    `briefs.note_detail`. The note is plain text, escaped when rendered.
  - **Chat grounding guard.** Every date, weekday and `#id` in a chat answer must appear in that conversation's tool
    results, the owner's own messages or the loaded memory ids. Otherwise the model gets one correction turn, and
    whatever is still unbacked is shown in a "Not found in your data: …" footer rather than passed off as fact.
    The rejected draft is never stored. Clock times, counts and durations are not checked.
  - **Memory save guard.** `save_memory` refuses anything that looks like a credential or secret, anything dated or
    progress-like, and goals or projects (they belong in their own tables), and caps a memory at 500 characters.
    Old goal/project notes are converted only by the owner on `/settings/memory`, or by `resolve_old_memory`, which
    the prompt allows only after an explicit yes in chat and which refuses a goal or project that does not exist.
  - **Chat rendering.** Replies are Markdown converted by `markdownToChatHtml`, which escapes all text first and only
    links `http(s)` URLs. The browser bundle never imports the database or AI packages.
- **Gitignored:** `.env*` (except `.env.example`), `.secrets/`, `data/`.
- **Tests stay offline.**
  - Synthetic fixtures and an injected fake `fetch`; never the real LMS.
  - Database tests run on an in-process PGlite, never the Supabase project.

## Planned (V2)

- **Approval system** (Phase 8). External actions (send email, edit your calendar events) are only *proposed*, then executed once after you approve them in a fresh session, and every step is audited.
- **Google OAuth refresh tokens** will be sealed with the same secret-box (Phase 9).

## Rotating or revoking

| What | How | Then update |
|---|---|---|
| Supabase secret key | Dashboard → Project Settings → API Keys → create a new secret key, then delete the old one | `.env` `SUPABASE_SECRET_KEY`; Vercel `SUPABASE_SECRET_KEY`; redeploy the dashboard |
| Database password | Dashboard → Project Settings → Database → Reset database password | `npm run setup:db` (rewrites `SUPABASE_DB_URL` in `.env`); Vercel `SUPABASE_DB_URL`; redeploy the dashboard. Edge Functions pick up the platform value automatically. |
| `CRON_SECRET` | Generate a new random value in `.env` | `npm run deploy:cloud` (Edge secrets and Vault); Vercel `CRON_SECRET`; redeploy |
| `WEB_SESSION_SECRET` | New random value (32+ chars) | Vercel; redeploy. This signs you out and changes the calendar-feed URL, so re-subscribe in Google Calendar. |
| MESA session | Sign out of MESA, delete `.secrets/mesa-session.enc` | `npm run mesa:login` |
| `MESA_SESSION_KEY` | Delete it and the `.enc` file | `npm run mesa:login` (generates a new key); `npm run deploy:cloud` |
