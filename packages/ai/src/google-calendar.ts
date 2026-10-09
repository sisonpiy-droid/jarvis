// Adding events to the owner's own Google Calendar, on their say-so ("block 3–5 tomorrow for DDDM", "add a revision
// session Friday 6 pm"). Plain fetch against Google's REST API (runs on Deno and Node). One scope — calendar.events —
// and one action — create an event. JARVIS never edits or deletes events, never invites anyone, never reads mail.
// Credentials are env secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN, the last written by
// `npm run google:auth` (the owner's one-time consent in their browser).

export interface GoogleCalendar {
  createEvent(e: { id: string; title: string; startIso: string; endIso: string; notes?: string }): Promise<{ id: string; link: string | null; duplicate: boolean }>;
}

/** The client, or null until the owner has connected Google (all three secrets present). */
export function googleCalendarFromEnv(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): GoogleCalendar | null {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = env;
  if (!id || !secret || !refresh) return null;
  return {
    async createEvent(e) {
      // A short-lived access token each time: events are rare, so nothing to cache.
      const tok = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
      });
      const t = (await tok.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!tok.ok || !t.access_token) throw new Error(`Google sign-in failed (${t.error ?? tok.status}) — run \`npm run google:auth\` again`);
      const res = await fetchImpl("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: e.id, // our own id: asking twice for the same slot is a 409, not a second event
          summary: e.title,
          ...(e.notes ? { description: e.notes } : {}),
          start: { dateTime: e.startIso, timeZone: "Asia/Kolkata" },
          end: { dateTime: e.endIso, timeZone: "Asia/Kolkata" },
          reminders: { useDefault: true },
        }),
      });
      if (res.status === 409) return { id: e.id, link: null, duplicate: true };
      const j = (await res.json().catch(() => ({}))) as { id?: string; htmlLink?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(`Google Calendar said no (${res.status}): ${(j.error?.message ?? "no detail").slice(0, 160)}`);
      return { id: j.id ?? e.id, link: j.htmlLink ?? null, duplicate: false };
    },
  };
}

/** A Google event id (lowercase letters a–v and digits) derived from what was asked, so repeats collapse. */
export async function eventId(title: string, startIso: string, endIso: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${title.toLowerCase().trim()}|${startIso}|${endIso}`)));
  let out = "jv";
  for (const b of d.subarray(0, 16)) out += (b % 32).toString(32);
  return out;
}
