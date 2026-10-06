import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import { createLogger } from "@jarvis/shared";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { b64urlEncode, DEFAULT_SETTINGS, generateVapidKeys, runNotificationService, SETTINGS_KEY, type Channel, type NotifyChannels } from "../src/index";

// The notification service against the real migrations (PGlite). Push services, Resend and Telegram are faked.

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
const log = createLogger("test");
const DAY = new Date(Date.now()); // routing "now"; quiet-hours tests pass their own

let t: TestDb;
let vapid: NotifyChannels["vapid"];
beforeAll(async () => {
  t = await createTestDb();
  vapid = { ...(await generateVapidKeys()), subject: "mailto:owner@example.com" };
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.notifications, jarvis.notification_deliveries, jarvis.push_subscriptions, jarvis.settings restart identity cascade`;
  pushStatus = 201;
  pushes.length = 0;
  emails.length = 0;
  telegrams.length = 0;
});

let pushStatus = 201;
const pushes: Array<{ endpoint: string }> = [];
const emails: Array<{ subject: string; text: string }> = [];
const telegrams: string[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  if (url.startsWith("https://push.test/")) {
    pushes.push({ endpoint: url });
    return new Response(null, { status: pushStatus });
  }
  if (url === "https://api.resend.com/emails") {
    emails.push(JSON.parse(String(init.body)));
    return Response.json({ id: `em_${emails.length}` });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;
const telegram: Channel = { send: async (text) => (telegrams.push(text), String(telegrams.length)) };

const addDevice = async (name = "phone") => {
  const k = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { publicKey: CryptoKey };
  const p256dh = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)));
  return db.savePushSubscription(t.sql, { endpoint: `https://push.test/${name}`, p256dh, auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))), deviceLabel: name });
};
const queue = (key: string, priority: db.Priority = "high", text = `<b>${key}</b>\nbody`) =>
  db.enqueueNotifications(t.sql, [{ dedupeKey: key, priority, text, scheduledFor: new Date(Date.now() - 1000).toISOString() }]);
const channels = (o: Partial<NotifyChannels> = {}): NotifyChannels => ({ baseUrl: "https://jarvis.test", vapid, email: { apiKey: "re_x", to: "me@x.com" }, telegram, ...o });
const run = (o: Partial<NotifyChannels> = {}, now = DAY) => runNotificationService(t.sql, channels(o), { now, log, fetch: fakeFetch });
const deliveries = () => t.sql`select n.dedupe_key, d.channel, d.status, d.reason from jarvis.notification_deliveries d join jarvis.notifications n on n.id = d.notification_id order by d.id`;
const noon = new Date("2026-10-01T06:30:00Z"); // 12:00 IST — daytime, not quiet

describe("routing", () => {
  it("before any push device exists, keeps Telegram as the channel (nothing lost) and fills the inbox", async () => {
    await queue("class.cancelled:e1:x", "high");
    await queue("material.added:m1", "low");
    const s = await run({}, noon);
    expect(s.routed).toBe(2);
    expect(telegrams).toHaveLength(2);
    expect(pushes).toHaveLength(0);
    expect(await db.unreadCount(t.sql)).toBe(2);
    const items = await db.inbox(t.sql);
    expect(items.map((i) => [i.category, i.url])).toEqual([["material", "/"], ["class", "/classes"]]);
  });

  it("Telegram sends attached files after the message; a file that fails doesn't undo the delivery", async () => {
    await db.enqueueNotifications(t.sql, [{ dedupeKey: "class.recap:e1:x", priority: "normal", text: "recap", scheduledFor: new Date(Date.now() - 1000).toISOString(), files: ["ok", "bad", "gone"] }]);
    const sent: string[] = [];
    const tg: Channel = { ...telegram, sendFile: async (_b, name) => void sent.push(name) };
    const file = async (sha: string) => {
      if (sha === "bad") throw new Error("storage down");
      return sha === "ok" ? { bytes: new Uint8Array([1]), name: "Session 11 Deck.pdf", mime: "application/pdf" } : null;
    };
    await run({ telegram: tg, file }, noon);
    expect(telegrams).toEqual(["recap"]);
    expect(sent).toEqual(["Session 11 Deck.pdf"]);
    expect((await deliveries()).map((d) => `${d.channel}:${d.status}`)).toEqual(["telegram:sent"]);
  });

  it("with a push device: high → push only; Telegram stays quiet; inbox still gets it", async () => {
    await addDevice();
    await queue("assignment.created:a1", "high");
    const s = await run({}, noon);
    expect(s.push.sent).toBe(1);
    expect(pushes).toEqual([{ endpoint: "https://push.test/phone" }]);
    expect(telegrams).toHaveLength(0);
    expect((await deliveries()).map((d) => `${d.channel}:${d.status}`)).toEqual(["push:sent"]);
    expect((await db.inbox(t.sql))[0]!.url).toBe("/assignments/a1");
  });

  it("works with no Telegram configured at all", async () => {
    await addDevice();
    await queue("class.created:e2", "normal");
    const s = await run({ telegram: null }, noon);
    expect(s.push.sent).toBe(1);
  });

  it("defers non-critical items during quiet hours; critical goes out", async () => {
    await addDevice();
    await queue("class.rescheduled:e3:x", "high");
    await queue("mesa.session_expired:2026-10-01", "urgent");
    const s = await run({}, new Date("2026-09-30T20:30:00Z")); // 02:00 IST
    expect(s.deferred).toBe(1);
    expect(s.routed).toBe(1);
    expect(pushes).toHaveLength(1);
    const [left] = await t.sql`select status from jarvis.notifications where dedupe_key = 'class.rescheduled:e3:x'`;
    expect(left!.status).toBe("queued");
  });

  it("sends a single digest push for a burst", async () => {
    await addDevice();
    for (const k of ["a", "b", "c", "d", "e"]) await queue(`assignment.created:${k}`, "high");
    const s = await run({}, noon);
    expect(s.push.sent).toBe(5);
    expect(pushes).toHaveLength(1);
  });

  it("caps pushes per hour (critical exempt); capped items stay in the inbox", async () => {
    await addDevice();
    await db.putSetting(t.sql, SETTINGS_KEY, { ...DEFAULT_SETTINGS, pushPerHour: 1 });
    await queue("assignment.created:x1", "high");
    await run({}, noon);
    await queue("assignment.created:x2", "high");
    await queue("mesa.sync_failing:d", "urgent");
    const s = await run({}, noon);
    expect(s.push.skipped).toBe(1);
    expect(s.push.sent).toBe(1);
    expect((await deliveries()).map((d) => `${d.dedupe_key}:${d.status}:${d.reason}`)).toContain("assignment.created:x2:skipped:rate_limited");
    expect(await db.unreadCount(t.sql)).toBe(3);
  });

  const brief = () => queue("brief:2026-10-01", "normal", "☀️ <b>Good morning — your day is ready</b>\nThursday, 1 October · No classes\n<b>TODAY'S PRIORITIES</b>\n1. Deck");

  it("pushes the morning brief on its own, outside the digest", async () => {
    await addDevice();
    await brief();
    for (const k of ["a", "b", "c", "d"]) await queue(`assignment.created:${k}`, "high");
    const s = await run({}, noon);
    expect(s.push.sent).toBe(5);
    expect(pushes).toHaveLength(2); // the brief, then one digest of the other 4
    expect((await deliveries()).every((d) => d.status === "sent")).toBe(true);
  });

  it("sends the brief even when the hourly push budget is used up", async () => {
    await addDevice();
    await db.putSetting(t.sql, SETTINGS_KEY, { ...DEFAULT_SETTINGS, pushPerHour: 1 });
    await queue("assignment.created:x1", "high");
    await run({}, noon);
    await brief();
    await queue("assignment.created:x2", "high");
    const s = await run({}, noon);
    expect(s.push).toMatchObject({ sent: 1, skipped: 1 });
    const rows = (await deliveries()).map((d) => `${d.dedupe_key}:${d.status}:${d.reason}`);
    expect(rows).toContain("brief:2026-10-01:sent:route");
    expect(rows).toContain("assignment.created:x2:skipped:rate_limited");
  });
});

describe("delivery failures", () => {
  it("retries a failing push, then falls back to Telegram for high items", async () => {
    await addDevice();
    pushStatus = 500;
    await queue("class.cancelled:e9:x", "high");
    for (let i = 0; i < 3; i++) await run({}, noon);
    const d = await deliveries();
    expect(d.map((x) => `${x.channel}:${x.status}`)).toEqual(["push:failed", "telegram:sent"]);
    expect(d[1]!.reason).toBe("fallback:push_failed");
    expect(telegrams).toHaveLength(1);
  });

  it("disables a subscription the push service says is gone", async () => {
    await addDevice();
    pushStatus = 410;
    await queue("class.cancelled:e10:x", "high");
    await run({}, noon);
    expect(await db.activePushSubscriptions(t.sql)).toEqual([]);
  });

  it("skips Telegram entirely when it's switched off", async () => {
    await db.putSetting(t.sql, SETTINGS_KEY, { ...DEFAULT_SETTINGS, telegram: "off" });
    await queue("class.cancelled:e11:x", "high");
    await run({}, noon);
    expect(telegrams).toHaveLength(0);
    expect(await db.unreadCount(t.sql)).toBe(1);
  });
});

describe("escalation and email", () => {
  it("emails an unread critical item after the escalation delay, once", async () => {
    await addDevice();
    await queue("mesa.session_expired:d1", "urgent");
    await run({}, noon);
    expect(emails).toHaveLength(0);
    const later = new Date(Date.now() + 31 * 60_000);
    await run({}, later);
    await run({}, later);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain("https://jarvis.test/status");
  });

  it("does not escalate what was already read", async () => {
    await addDevice();
    await queue("mesa.session_expired:d2", "urgent");
    await run({}, noon);
    await db.markRead(t.sql, "all");
    await run({}, new Date(Date.now() + 31 * 60_000));
    expect(emails).toHaveLength(0);
  });

  it("digests a burst of emails", async () => {
    const s = { ...structuredClone(DEFAULT_SETTINGS), telegram: "off" as const };
    s.routes.normal.email = "immediate";
    await db.putSetting(t.sql, SETTINGS_KEY, s);
    for (const k of ["1", "2", "3", "4"]) await queue(`announcement.created:${k}`, "normal");
    const st = await run({}, noon);
    expect(st.email.sent).toBe(4);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe("JARVIS · 4 updates");
  });
});

describe("inbox", () => {
  it("marks read, dismisses, and counts unread", async () => {
    await queue("class.created:i1", "normal");
    await queue("class.created:i2", "normal");
    await run({ telegram: null }, noon);
    const [a, b] = await db.inbox(t.sql);
    await db.markRead(t.sql, [a!.id]);
    expect(await db.unreadCount(t.sql)).toBe(1);
    await db.dismiss(t.sql, [b!.id]);
    expect((await db.inbox(t.sql)).map((i) => i.id)).toEqual([a!.id]);
    expect(await db.unreadCount(t.sql)).toBe(0);
  });
});

