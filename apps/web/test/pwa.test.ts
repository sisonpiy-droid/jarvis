import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import manifest from "../app/manifest";
import { urlBase64ToUint8Array } from "../lib/pwa-client";

describe("web app manifest", () => {
  it("is installable: standalone, root scope, 192/512 icons and a maskable icon", () => {
    const m = manifest();
    expect(m).toMatchObject({ name: "JARVIS", start_url: "/", scope: "/", display: "standalone" });
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});

describe("pwa client helpers", () => {
  it("decodes the VAPID key into the bytes PushManager expects", () => {
    expect([...urlBase64ToUint8Array("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
});

// Runs public/sw.js in a minimal fake ServiceWorkerGlobalScope.
function loadServiceWorker(opts: { windows?: Array<{ url: string; focus: () => Promise<void>; navigate: (u: string) => Promise<void> }> } = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const fetchMock = vi.fn(async () => new Response("{}"));
  const self = {
    location: { origin: "https://jarvis.app" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    skipWaiting: vi.fn(),
    registration: { showNotification },
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => opts.windows ?? []), openWindow },
    navigator: {},
  };
  // A tiny CacheStorage: one store per name, keyed by request path.
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      const m = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, m);
      return {
        keys: async () => [...m.keys()],
        delete: async (k: string) => m.delete(k),
        put: async (k: string, r: Response) => void m.set(k, r),
        match: async (k: string) => m.get(k)?.clone(),
      };
    },
    delete: async (name: string) => stores.delete(name),
  };
  const src = readFileSync(join(import.meta.dirname, "..", "public", "sw.js"), "utf8");
  new Function("self", "fetch", "Response", "caches", src)(self, fetchMock, Response, caches);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p), respondWith: (p: Promise<unknown>) => (done = p) });
    return done;
  };
  return { fire, showNotification, openWindow, fetchMock, stores };
}

describe("service worker", () => {
  it("shows a push with its title, body, tag and deep link", async () => {
    const sw = loadServiceWorker();
    await sw.fire("push", { data: { json: () => ({ title: "📌 New assignment", body: "Due Fri", url: "https://jarvis.app/assignments/a1", tag: "jarvis-7", ids: [7] }) } });
    expect(sw.showNotification).toHaveBeenCalledWith("📌 New assignment", expect.objectContaining({ body: "Due Fri", tag: "jarvis-7", data: { url: "https://jarvis.app/assignments/a1", ids: [7] } }));
  });

  it("falls back to text when a push isn't JSON", async () => {
    const sw = loadServiceWorker();
    await sw.fire("push", { data: { json: () => JSON.parse("nope"), text: () => "plain" } });
    expect(sw.showNotification).toHaveBeenCalledWith("JARVIS", expect.objectContaining({ body: "plain" }));
  });

  it("on tap: marks it read, then focuses an open window and navigates it", async () => {
    const win = { url: "https://jarvis.app/", focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
    const sw = loadServiceWorker({ windows: [win] });
    const close = vi.fn();
    await sw.fire("notificationclick", { notification: { close, data: { url: "https://jarvis.app/drafts/5", ids: [5] } } });
    expect(close).toHaveBeenCalled();
    expect(sw.fetchMock).toHaveBeenCalledWith("/api/notifications", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "read", ids: [5] }) }));
    expect(win.focus).toHaveBeenCalled();
    expect(win.navigate).toHaveBeenCalledWith("https://jarvis.app/drafts/5");
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("on tap with no window open: opens one", async () => {
    const sw = loadServiceWorker();
    await sw.fire("notificationclick", { notification: { close: () => {}, data: { url: "/inbox", ids: [] } } });
    expect(sw.openWindow).toHaveBeenCalledWith("https://jarvis.app/inbox");
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it("Done on a habit check-in logs it in the background and opens nothing", async () => {
    const sw = loadServiceWorker();
    await sw.fire("notificationclick", { action: "habit-done", notification: { close: () => {}, data: { url: "https://jarvis.app/q/habit/7?d=2026-10-01", ids: [3] } } });
    expect(sw.fetchMock).toHaveBeenCalledWith("/api/habits/log", expect.objectContaining({ body: JSON.stringify({ id: 7, day: "2026-10-01", status: "done", source: "push_action" }) }));
    expect(sw.fetchMock).toHaveBeenCalledWith("/api/notifications", expect.objectContaining({ body: JSON.stringify({ action: "read", ids: [3] }) }));
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("if the background log fails (signed out), Skip opens the check-in page instead", async () => {
    const sw = loadServiceWorker();
    sw.fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await sw.fire("notificationclick", { action: "habit-skip", notification: { close: () => {}, data: { url: "https://jarvis.app/q/habit/7?d=2026-10-01", ids: [] } } });
    expect(sw.fetchMock).toHaveBeenCalledWith("/api/habits/log", expect.objectContaining({ body: JSON.stringify({ id: 7, day: "2026-10-01", status: "skipped", source: "push_action" }) }));
    expect(sw.openWindow).toHaveBeenCalledWith("https://jarvis.app/q/habit/7?d=2026-10-01");
  });

  it("parks a share-sheet post (text, link, files) and opens /share", async () => {
    const sw = loadServiceWorker();
    const form = new FormData();
    form.set("title", "Groww results");
    form.set("text", "Read before class");
    form.set("url", "https://example.com/groww");
    form.append("files", new File(["%PDF-1.4"], "groww.pdf", { type: "application/pdf" }));
    form.append("files", new File([], "empty.txt"));
    const request = { method: "POST", mode: "navigate", url: "https://jarvis.app/share-target", formData: async () => form };
    const res = (await sw.fire("fetch", { request })) as Response;
    expect([res.status, res.headers.get("location")]).toEqual([303, "https://jarvis.app/share"]);
    const store = sw.stores.get("jarvis-share-v1")!;
    const meta = await store.get("/__share/meta")!.clone().json();
    expect(meta).toMatchObject({ title: "Groww results", text: "Read before class", url: "https://example.com/groww", files: [{ name: "groww.pdf", type: "application/pdf", size: 8 }] });
    expect(await store.get("/__share/file/0")!.clone().text()).toBe("%PDF-1.4");
    expect(store.has("/__share/file/1")).toBe(false); // empty files are dropped
  });

  it("leaves other POSTs to the network", async () => {
    const sw = loadServiceWorker();
    const done = await sw.fire("fetch", { request: { method: "POST", mode: "cors", url: "https://jarvis.app/api/chat" } });
    expect(done).toBeUndefined(); // respondWith was never called
  });

  it("serves an offline page when a navigation fails", async () => {
    const sw = loadServiceWorker();
    sw.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const res = (await sw.fire("fetch", { request: { mode: "navigate" } })) as Response;
    expect(await res.text()).toContain("You're offline");
  });
});
