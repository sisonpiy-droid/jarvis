/* global self, caches */
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

// Marks notifications opened (and read, which stops email escalation): the signal JARVIS learns from about
// which alerts matter. Same-origin, so the session cookie is sent.
const markRead = (ids) =>
  fetch("/api/notifications", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "open", ids }),
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
      // "Move the rest to tomorrow" on the evening check-in: done in the background.
      if (event.action === "checkin-move") {
        const res = await fetch("/api/checkin", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "move" }),
        }).catch(() => null);
        if (res && res.ok) {
          if (data.ids && data.ids.length) await markRead(data.ids);
          const j = await res.json().catch(() => ({}));
          await self.registration.showNotification("Moved to tomorrow", { body: `${j.moved || 0} task(s) now due tomorrow.`, tag: "jarvis-checkin-moved", icon: "/pwa-icon/192", data: { url: "/tasks", ids: [] } });
          return;
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

// Share sheet → JARVIS (Android). The shared title/text/link and files are parked in a cache and the app opens
// /share, which reads them from there and asks what to do. Nothing is uploaded until the owner chooses.
const SHARE_CACHE = "jarvis-share-v1";

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    const files = form.getAll("files").filter((f) => f && typeof f === "object" && "size" in f && f.size > 0).slice(0, 5);
    const meta = {
      title: String(form.get("title") || ""),
      text: String(form.get("text") || ""),
      url: String(form.get("url") || ""),
      files: files.map((f, i) => ({ name: f.name || `shared-${i + 1}`, type: f.type || "", size: f.size })),
      at: Date.now(),
    };
    await Promise.all(files.map((f, i) => cache.put(`/__share/file/${i}`, new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream" } }))));
    await cache.put("/__share/meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    return Response.redirect(new URL("/share", self.location.origin).href, 303);
  } catch {
    return Response.redirect(new URL("/share?failed=1", self.location.origin).href, 303);
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method === "POST") {
    const url = new URL(event.request.url);
    if (url.origin === self.location.origin && url.pathname === "/share-target") event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
