/* global self */
/* JARVIS service worker: shows pushes, opens the right page on tap (marking it read), and gives a small
   offline page instead of the browser's error. Kept dependency-free and tiny on purpose. */

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JARVIS · offline</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#111214;color:#ececec;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;text-align:center}button{margin-top:16px;padding:10px 16px;border-radius:10px;border:0;background:#7aa0ff;color:#111;font-weight:600}</style></head>
<body><div><h1 style="font-size:20px">You're offline</h1><p style="color:#9a9ea6">JARVIS needs a connection. Your notifications are kept in the inbox.</p><button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d;
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: "JARVIS", body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: d.body || "",
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    icon: "/pwa-icon/192",
    badge: "/pwa-icon/96",
    timestamp: Date.now(),
    data: { url: d.url || "/inbox", ids: Array.isArray(d.ids) ? d.ids : [] },
    actions: Array.isArray(d.actions) ? d.actions.slice(0, 2) : [],
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(d.title || "JARVIS", options),
      // App-icon badge where supported (installed apps on iPhone and Android).
      self.navigator && "setAppBadge" in self.navigator ? self.navigator.setAppBadge().catch(() => {}) : null,
    ]),
  );
});

// Marks notifications read (stops email escalation). Same-origin, so the session cookie is sent.
const markRead = (ids) =>
  fetch("/api/notifications", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "read", ids }),
  }).catch(() => {});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || "/inbox", self.location.origin);
  event.waitUntil(
    (async () => {
      // Done / Skip buttons on a habit check-in: log it in the background, no window needed.
      if (event.action === "habit-done" || event.action === "habit-skip") {
        const m = /^\/q\/habit\/(\d+)$/.exec(target.pathname);
        const day = target.searchParams.get("d");
        if (m && day) {
          const res = await fetch("/api/habits/log", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: Number(m[1]), day, status: event.action === "habit-done" ? "done" : "skipped", source: "push_action" }),
          }).catch(() => null);
          if (res && res.ok) {
            if (data.ids && data.ids.length) await markRead(data.ids);
            return;
          }
          // Signed out or offline: fall through and open the check-in page instead.
        }
      }
      if (data.ids && data.ids.length) {
        await markRead(data.ids);
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          await w.focus();
          if ("navigate" in w && target.origin === self.location.origin) await w.navigate(target.href).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
