# Adding events to your Google Calendar

JARVIS can put an event on your Google Calendar the moment you ask — "block 3–5 pm tomorrow for DDDM", "add a
revision session Friday 6 pm". It checks your classes and events first and asks before double-booking.

It can only **add** events (the `calendar.events` permission). It never edits or deletes events, never invites
anyone, and never reads your mail. Nothing is added unless you ask.

## One-time setup (about 5 minutes, on your laptop)

1. Go to <https://console.cloud.google.com> → create a project (any name) → **APIs & Services → Library** → enable **Google Calendar API**.
2. **OAuth consent screen**: choose **External**, fill the app name and your email, add your own Google account under **Test users**, save.
3. **Credentials → Create credentials → OAuth client ID** → application type **Desktop app**. Copy the client ID and secret.
4. Put them in `.env` (open it in Notepad — don't paste them into chat):

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

5. Run `npm run google:auth`. Your browser opens; sign in and approve. The token is saved to `.env` — never printed.
6. `npm run deploy:cloud` (the Telegram bot) and add the three `GOOGLE_*` values to the Vercel project's environment (the web app), then redeploy.

While the app is in Google's **Testing** mode the token expires after 7 days. To avoid re-running step 5 weekly, on the
OAuth consent screen press **Publish app** (it stays private to you; Google just shows an "unverified app" notice once).

Until this is done, asking JARVIS to block time gets a clear "not connected yet" reply and nothing is added.
