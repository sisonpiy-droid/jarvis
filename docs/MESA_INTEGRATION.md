# MESA LMS integration

Status: **discovery complete, read-only extractor built** (2026-09-28).
Everything below was observed on the live LMS with a legitimately signed-in
student session. Nothing was bypassed, and only GET requests (plus the site's
own token-refresh call) were made.

## TL;DR

| Question | Answer |
|---|---|
| Public API? | **No.** There is no documented or public API. |
| What does the site use? | A **private JSON REST API** that the web app itself calls. |
| GraphQL / WebSockets? | Neither. Firebase is loaded only for push notifications (FCM). |
| Server-rendered? | Partly (Next.js App Router, RSC). All LMS data arrives via client-side REST calls. |
| Auth | Email/ID + password → httpOnly session cookie on the web origin → short-lived JWT access token (15 min) sent as `Authorization: Bearer`. |
| MFA? | The login code has `login/verify` and `login/resend` steps (an OTP flow). It did **not** trigger on our sign-in; it may be conditional (new device, risk-based). Design assumes it can appear at any time. |
| CAPTCHA? | None seen on the login page. |
| Files | Hosted on Google Cloud Storage with **time-limited signed URLs**. Some are embedded in responses; course files need a separate `signed-url` call. |
| Browser automation needed? | **Only for sign-in.** After that, every read can go through the same REST calls the page makes. That is more reliable than scraping the DOM. |

## Frontend architecture

- `https://students.mesaschool.co.in` is Next.js (App Router, Turbopack
  build) and calls itself **"Nexus"**.
- Unauthenticated visits to `/student/*` redirect to `/login`.
- The Next.js server exposes a small auth BFF (backend for frontend) at
  `/api/auth/*`:
  - `POST /api/auth/login` takes `{ identifier, password }`-style JSON, and
    either finishes sign-in or asks for verification.
  - `POST /api/auth/login/verify` and `POST /api/auth/login/resend` handle
    the OTP step.
  - `POST /api/auth/refresh` returns `{ data: { accessToken, user } }`. It
    authenticates with the httpOnly cookie, which JavaScript cannot read.
- The data API lives at `https://api-students.mesaschool.co.in/api/v1`.
  - The browser keeps the access token **in memory only** (`tokenStore`).
    On a 401, the client calls `/api/auth/refresh` once and retries.
  - JWT claims seen: `sub`, `account_type`, `program_scope`, `iat`, `exp`.
    `exp − iat` = **900 s**.
- Cross-origin calls to the data API work with the Bearer token alone. No
  cookie is needed on the API domain.

## Endpoints JARVIS uses (all GET)

| Purpose | Endpoint | Notes |
|---|---|---|
| Student context | `/student/me` | `data.context.{student, program, batch, enrollment, terms[]}` |
| Profile | `/auth/me` | Not used. Contains phone and blood group, which JARVIS doesn't need. |
| Courses | `/curriculum/courses?termId=` | Per term; 17 courses in Term 1. Fields: `title, shortName, instructorName, courseType, classType, termId, updatedAt` |
| Course detail | `/curriculum/courses/{id}` | Same fields |
| Topics (course sections) | `/curriculum/topics?courseId=` | `type` ∈ `outline, resources, assignments, recordings, announcements, custom` |
| Course materials | `/content/topics/{topicId}/materials` | `kind` (`file`/`link`/`text`), `fileName, fileType, sizeBytes, allowDownload, url` (null for files), `updatedAt` |
| File download | `/content/materials/{id}/signed-url` | `data.url` → GCS signed URL, **~15 min** lifetime. Verified: returns the PDF. |
| Recordings | `/content/topics/{topicId}/recordings` | YouTube `videoUrl` / `embedUrl`, `recordedOn` |
| **Assignments** | `/assignments/my` | 39 items. Carries `title, description (HTML), instructions (HTML), courseId, courseTitle, dueAt, cutoffDate, allowSubmissionsFrom, allowLate, submissionType, isGroup, maxMarks, maxAttempts, status, mySubmissionStatus, materials[]` |
| Assignment detail | `/assignments/{id}` | Same, plus `accessible, accessReasons`. The list already has everything V1 needs. |
| My submission | `/assignments/{id}/submissions` | `data.submission.{status, submittedAt, files, linkUrl, textAnswer, grade}`. Not used yet. |
| My group | `/assignments/{id}/my-group` | Not used yet |
| Course assignments | `/assignments?courseId=&status=published` | Used by the course page |
| Calendar | `/events/my?from=ISO&to=ISO` | 54 events in 30 days. `title, eventType, status, startAt, endAt, timezone, courseName, instructorName, room, meetingLink, attendanceRequired, attachments[]` |
| Announcements | `/announcements?page=&limit=` · `?courseId=` | Paginated (`total` 201). `title, body (HTML), authorName, courseId, isPinned, createdAt, attachments[]` (signed URLs) |
| LMS notifications | `/notifications?limit=` | `items[].{type, title, body, data.{announcementId, courseId}, isRead}`. A useful change hint for later. |
| Attendance | `/attendance/student/summary`, `/attendance/student/sessions` | Not used yet |

Assignment page link: `https://students.mesaschool.co.in/student/lms/assignments/{id}`.
Course page link: `https://students.mesaschool.co.in/student/lms/courses/{id}`.

### Observed quirks

- `mySubmissionStatus` values seen: `submitted`, `late`, and `null` (not
  submitted). JARVIS maps `late` to `submitted_late`, which is an assumption.
  Unknown values are kept as `other:<value>` rather than guessed.
- About 7 of 39 assignments have no `courseId` (for example "Pre-work
  submission" and startup-leader tasks).
- Deadlines are UTC ISO strings. `18:29Z` means **11:59 pm IST**.
- Assignment material `kind`s seen: `link`, `pdf`. For `pdf`, the signed URL
  is embedded in the response.
- Signed URLs change on every response. Change detection **must** strip
  `GoogleAccessId / Expires / Signature`, which `stableUrl()` does.
  Otherwise every sync would look like a change.
- `/courses`, `/courses/my` and `/assignments/{id}/materials` return 404 for
  students. The student views go through `/curriculum/*`, `/content/*` and
  `/assignments/my`.

## Integration design

```
 (once, or when the session expires)          (every sync, unattended)
 ┌───────────────────────────┐              ┌─────────────────────────────────────┐
 │ npm run mesa:login        │              │ worker                              │
 │ Playwright opens Edge     │              │  load encrypted session             │
 │ YOU type password + OTP   │              │  POST /api/auth/refresh ─► JWT 15m  │
 │ capture MESA cookies only │── encrypt ──►│  GET /api/v1/... (read-only)        │
 └───────────────────────────┘  AES-GCM     │  validate (zod) → normalize → hash  │
                                            │  persist rotated cookies            │
                                            └─────────────────────────────────────┘
```

1. **Sign-in is always interactive.** JARVIS never sees, stores or types
   the password, so an OTP step costs nothing extra: you complete it in
   the window.
2. **Session storage.** Only cookies scoped to `*.mesaschool.co.in` are
   kept. They are sealed with AES-256-GCM (`MESA_SESSION_KEY`) in
   `.secrets/mesa-session.enc`, and later in the database. If the refresh
   response rotates the cookie, the new cookie is saved straight away.
3. **Access tokens** live in memory only. They are refreshed 60 s before
   `exp`, or on a 401. Concurrent callers share one refresh.
4. **Reads** go through `MesaClient`. It only has a `get` method, so it
   cannot submit anything by construction. It runs at most 3 requests at
   once with a ≥150 ms gap between starts, and uses exponential backoff
   on 429/5xx, honouring `Retry-After`.
5. **Schema-drift detection.** Each record is validated on its own against
   a zod schema that allows extra fields. A changed field we rely on
   becomes a `warning` in the snapshot, and that one record is skipped
   rather than failing the whole sync. A broken `/student/me` or auth
   still fails loudly.
6. **Why not DOM scraping?** The API returns structured, typed data with
   stable IDs and timestamps, which is exactly what idempotent sync and
   change detection need. Scraping would turn the same data into HTML and
   back again, and break on every redesign. DOM scraping stays as a
   fallback if the API ever becomes unusable.

## Proof of concept

```bash
npm run mesa:login     # visible Edge window; you sign in; session saved encrypted
npm run mesa:extract   # read-only snapshot → data/snapshots/mesa-<ts>.json
```

The snapshot contains `student, courses[topics], materials, recordings,
assignments, events, announcements`, plus
`meta.{counts, requestCount, durationMs, warnings, unavailable}`. A full
extract is about 120–250 GETs, because materials are fetched per topic.
Syncs that run often should only re-fetch cheap, high-signal endpoints (see
ROADMAP Phase 4).

## Verified live (2026-09-28)

- `mesa:login` captured **1 cookie** on the MESA origin. The refresh call
  worked **from Node, with no browser**.
- **Session cookie lifetime: 30 days** (expires 2026-10-28). Whether it
  slides with use is still unknown (see below).
- A full extract made **101 GETs in 17.6 s**, with **0 schema warnings** and
  no unavailable endpoints. It returned 18 courses, 110 topics, 222
  materials (92 downloadable files: pdf/xlsx/docx/pptx/png), 78 recordings,
  39 assignments, 113 events (−14 to +60 days) and 50 announcements.
- **Idempotency.** Two back-to-back extracts gave **identical content hashes
  for all 520 records**: 0 changed, 0 added, 0 removed.
- **No secrets in the output.** The snapshot has no `Signature=` values
  and no JWTs.
- Coverage: 32/39 assignments have a course and instructor, 31/39 a
  description, 37/39 a due date.

## Open questions (need live observation over days)

- ~~Is the session sliding?~~ **Yes** (observed 2026-09-29): the refresh call
  rotates the cookie and pushes its expiry ~30 days forward. While the sync runs
  every few minutes, re-login should rarely be needed; JARVIS warns 3 days ahead.
- **Refresh rotation.** Handled either way, but it matters for running two
  workers at once (don't).
- **When OTP triggers** (new device? every login? time-based?).
- **Rate limits.** None hit so far. No `RateLimit-*` headers were inspected.
- **Submission timeline.** Does `mySubmissionStatus` go through states
  like `graded`?
- **Assignment detail vs list.** Does the list ever leave out fields the
  detail endpoint has, for example for restricted assignments with
  `accessible: false`?

## Terms of use

This integration reads **only your own data, with your own session, at
roughly human request rates**. It uses the same calls the official web app
makes. It is still an undocumented private API: MESA can change it without
notice, and automated access may be governed by school IT policy. If in
doubt, ask the tech team whether a personal read-only integration is OK.
They may even offer an official export or webhook.
