# Security

## Credentials

| Secret | Where it lives | Who can read it |
|---|---|---|
| MESA password | **Nowhere.** You type it into the real MESA page in a Playwright-launched Edge window. | You |
| MESA OTP | Nowhere. Same as the password. | You |
| MESA session cookie | `.secrets/mesa-session.enc`, AES-256-GCM (later `integrations.secret_sealed`) | Worker process |
| `MESA_SESSION_KEY` | `.env` (gitignored) locally; host secret store in production | Worker process |
| MESA access token (JWT, 15 min) | Worker memory only | Worker process |
| Telegram / OpenAI / Supabase keys | Env vars | Worker and web server, never the browser |

## Rules the code enforces

- **Read-only MESA client.** `MesaClient` has only a `get` method, and a
  test fails if any mutating method appears.
- **Cookie scoping.** Only `*.mesaschool.co.in` cookies are saved
  (`filterMesaCookies`).
- **Atomic, private writes.** The session file is written to a temp file
  and renamed into place, with mode 0600.
- **Tamper-evident storage.** GCM authentication makes a modified or
  wrong-key session file fail to decrypt instead of producing garbage.
- **Redacting logger.** It scrubs JWTs, `Bearer` values, secret-named keys
  and GCS signed-URL parameters.
- **Snapshots strip URL signatures.** Signed URLs are fetched fresh when
  they're needed.
- **Gitignored:** `.env*` (except `.env.example`), `.secrets/`, and `data/`
  (snapshots hold your personal academic data).
- **Test isolation.** Tests use synthetic fixtures and an injected fake
  `fetch`, and never touch the real LMS.

## Rules for future phases

- The LLM never receives credentials, cookies or tokens. LMS, email and
  document content given to it is **untrusted data**, never instructions.
- Anything external or irreversible (send email, submit assignment, delete,
  message someone) creates a `pending_action`. It runs only after you
  approve that specific action, in chat or with a Telegram button.
- The dashboard uses Supabase Auth, restricted to your email. The
  service-role key stays server-side only.
- Screenshots are never stored during login.

## Rotating or revoking

- **Revoke the MESA session:** sign out of MESA in any browser (if MESA
  invalidates sessions server-side), delete `.secrets/mesa-session.enc`,
  then run `npm run mesa:login` again.
- **Rotate the encryption key:** delete `MESA_SESSION_KEY` from `.env` and
  the `.enc` file, then run `npm run mesa:login`. It generates a new key.
