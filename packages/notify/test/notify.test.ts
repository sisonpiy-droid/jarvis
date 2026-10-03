import { describe, expect, it } from "vitest";
import { notificationMeta } from "@jarvis/db";
import { pushMessage } from "../src/service";
import {
  DEFAULT_SETTINGS,
  b64urlDecode,
  b64urlEncode,
  emailHtml,
  encryptPayload,
  generateVapidKeys,
  inQuietHours,
  inWindow,
  parseSettings,
  pushBudget,
  renderNotification,
  route,
  sendEmail,
  sendPush,
  telegramFallbackOnPushFailure,
  toPlainText,
  toSafeHtml,
  vapidAuthorization,
  type NotificationSettings,
} from "../src/index";

const ist = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00+05:30`);

describe("render", () => {
  const msg = `📌 <b>New assignment: Case &amp; Co</b>\nDue <i>Fri 3 Oct</i> · <a href="https://students.mesaschool.co.in/x">open</a>\n<code>npm run mesa:login</code>`;

  it("splits a Telegram-HTML message into a plain title and body", () => {
    const r = renderNotification(msg);
    expect(r.title).toBe("📌 New assignment: Case & Co");
    expect(r.body).toBe("Due Fri 3 Oct · open\nnpm run mesa:login");
  });

  it("keeps only safe tags and links in HTML", () => {
    const html = toSafeHtml(`<b>ok</b><script>alert(1)</script><a href="javascript:alert(1)">x</a><a href="/assignments/1">y</a><img src=x onerror=1>`);
    expect(html).toBe(`<b>ok</b>alert(1)x<a href="/assignments/1">y</a>`);
    expect(toSafeHtml(`<a href="https://e.com/?a=1&amp;b=2">l</a>`)).toBe(`<a href="https://e.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">l</a>`);
  });

  it("escapes text and closes unbalanced tags", () => {
    expect(toSafeHtml(`a < b & <b>c`)).toBe("a &lt; b &amp; <b>c</b>");
    expect(toSafeHtml("line1\nline2")).toBe("line1<br>line2");
    expect(toPlainText("x &lt;y&gt;<br>z")).toBe("x <y>\nz");
  });

  it("bounds push title and body length", () => {
    const r = renderNotification(`${"T".repeat(300)}\n${"b".repeat(900)}`);
    expect(r.title.length).toBeLessThanOrEqual(120);
    expect(r.body.length).toBeLessThanOrEqual(400);
  });

  it("wraps email content and escapes the footer", () => {
    expect(emailHtml(`a<b`, "<b>x</b>", "https://j.app/inbox")).toContain(`a&lt;b`);
  });
});

describe("notification meta (deep links)", () => {
  it("derives category and url from the dedupe key", () => {
    expect(notificationMeta("assignment.created:abc")).toEqual({ category: "assignment", url: "/assignments/abc" });
    expect(notificationMeta("assignment.deadline_changed:abc:2026-10-01")).toEqual({ category: "deadline", url: "/assignments/abc" });
    expect(notificationMeta("reminder:abc:24h:2026-10-01T00:00:00Z")).toEqual({ category: "deadline", url: "/assignments/abc" });
    expect(notificationMeta("class.cancelled:e1:x").category).toBe("class");
    expect(notificationMeta("gcal.soon:x:y").category).toBe("calendar");
    expect(notificationMeta("draft.done:42")).toEqual({ category: "draft", url: "/drafts/42" });
    expect(notificationMeta("mesa.session_expired:2026-10-01")).toEqual({ category: "system", url: "/status" });
    expect(notificationMeta("memory.review:v1")).toEqual({ category: "system", url: "/settings/memory" });
    expect(notificationMeta("brief:2026-10-01").category).toBe("brief");
    expect(notificationMeta("user.reminder:uuid").category).toBe("reminder");
    expect(notificationMeta("habit.reminder:7:2026-10-01")).toEqual({ category: "habit", url: "/q/habit/7?d=2026-10-01" });
  });

  it("gives habit check-ins Done / Skip buttons, and nothing else gets buttons", () => {
    const abs = (p: string) => `https://jarvis.test${p}`;
    const n = { id: 3, dedupeKey: "habit.reminder:7:2026-10-01", priority: "normal" as const, text: "🔁 <b>Work out</b>\n2 of 4 this week", category: "habit", url: "/q/habit/7?d=2026-10-01", createdAt: "" };
    const m = pushMessage(n, abs);
    expect(m).toMatchObject({ title: "🔁 Work out", url: "https://jarvis.test/q/habit/7?d=2026-10-01", actions: [{ action: "habit-done" }, { action: "habit-skip" }] });
    expect(pushMessage({ ...n, dedupeKey: "habit.slipping:7:2026-09-30", url: "/goals" }, abs).actions).toBeUndefined();
    expect(pushMessage({ ...n, dedupeKey: "class.cancelled:e1:x", category: "class", url: "/classes" }, abs).actions).toBeUndefined();
  });
});

describe("settings", () => {
  it("falls back to defaults for missing or invalid parts", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = parseSettings({ pushPerHour: 999, telegram: "off", quietHours: { start: "23:00" }, routes: { low: { push: "always", email: "never" } } });
    expect(s.pushPerHour).toBe(DEFAULT_SETTINGS.pushPerHour); // invalid → default
    expect(s.telegram).toBe("off");
    expect(s.quietHours).toEqual({ enabled: true, start: "23:00", end: "07:00" });
    expect(s.routes.low.push).toBe("always");
    expect(s.routes.urgent).toEqual(DEFAULT_SETTINGS.routes.urgent);
  });
});

describe("policy", () => {
  const all = { push: true, email: true, telegram: true };
  const S = (o: Partial<NotificationSettings> = {}) => ({ ...structuredClone(DEFAULT_SETTINGS), ...o });

  it("handles time windows in IST, including ones that wrap midnight", () => {
    expect(inWindow(ist("01:30"), "01:00", "07:00")).toBe(true);
    expect(inWindow(ist("07:00"), "01:00", "07:00")).toBe(false);
    expect(inWindow(ist("23:30"), "22:00", "06:00")).toBe(true);
    expect(inWindow(ist("05:59"), "22:00", "06:00")).toBe(true);
    expect(inWindow(ist("12:00"), "22:00", "06:00")).toBe(false);
    expect(inQuietHours(ist("03:00"), S({ quietHours: { enabled: false, start: "01:00", end: "07:00" } }))).toBe(false);
  });

  it("defers everything except critical during quiet hours", () => {
    expect(route({ priority: "high", category: "class" }, S(), ist("02:00"), all).defer).toBe(true);
    const crit = route({ priority: "urgent", category: "system" }, S(), ist("02:00"), all);
    expect(crit.defer).toBe(false);
    expect(crit.deliveries.map((d) => d.channel)).toEqual(["push"]);
    expect(crit.escalate).toBe(true);
  });

  it("routes by level: high → push, normal → push only in daytime, low → inbox only", () => {
    expect(route({ priority: "high", category: "class" }, S(), ist("22:30"), all).deliveries.map((d) => d.channel)).toEqual(["push"]);
    expect(route({ priority: "normal", category: "brief" }, S(), ist("10:00"), all).deliveries.map((d) => d.channel)).toEqual(["push"]);
    expect(route({ priority: "normal", category: "brief" }, S(), ist("22:30"), all).deliveries).toEqual([]);
    expect(route({ priority: "low", category: "material" }, S(), ist("10:00"), all).deliveries).toEqual([]);
  });

  it("respects muted categories and immediate email", () => {
    const s = S({ mutedCategories: ["announcement"] });
    s.routes.normal.email = "immediate";
    expect(route({ priority: "normal", category: "announcement" }, s, ist("10:00"), all).deliveries.map((d) => d.channel)).toEqual(["email"]);
  });

  it("emails critical items straight away when there is no push device", () => {
    const d = route({ priority: "urgent", category: "system" }, S(), ist("10:00"), { push: false, email: true, telegram: false });
    expect(d.deliveries.map((x) => x.channel)).toEqual(["email"]);
    expect(d.escalate).toBe(false);
  });

  it("keeps Telegram as the fallback until a push device exists; mirror sends everything; off never", () => {
    const noDevice = { push: false, email: false, telegram: true };
    expect(route({ priority: "low", category: "material" }, S(), ist("10:00"), noDevice).deliveries).toEqual([{ channel: "telegram", reason: "fallback:no_device" }]);
    expect(route({ priority: "high", category: "class" }, S(), ist("10:00"), all).deliveries.map((d) => d.channel)).toEqual(["push"]);
    expect(route({ priority: "low", category: "material" }, S({ telegram: "mirror" }), ist("10:00"), all).deliveries.map((d) => d.channel)).toEqual(["telegram"]);
    expect(route({ priority: "high", category: "class" }, S({ telegram: "off" }), ist("10:00"), noDevice).deliveries).toEqual([]);
    expect(telegramFallbackOnPushFailure("high", S(), true)).toBe(true);
    expect(telegramFallbackOnPushFailure("normal", S(), true)).toBe(false);
    expect(telegramFallbackOnPushFailure("urgent", S({ telegram: "off" }), true)).toBe(false);
  });

  it("caps pushes per hour", () => {
    expect(pushBudget(0, S())).toBe(6);
    expect(pushBudget(9, S())).toBe(0);
  });
});

describe("web push crypto", () => {
  const j = (s: string) => b64urlDecode(s.replace(/\s+/g, ""));
  it("matches the RFC 8291 Appendix A test vector exactly", async () => {
    const body = await encryptPayload(j("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"), j("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), j("BTBZMqHH6r4Tts7J_aSIgg"), {
      salt: j("DGv6ra1nlYgDCS1FRnbzlw"),
      serverKeys: {
        publicRaw: j("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
        privateRaw: j("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      },
    });
    const header = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const ciphertext = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";
    expect(b64urlEncode(body.slice(0, 86))).toBe(header);
    expect(b64urlEncode(body.slice(86))).toBe(ciphertext);
  });

  it("signs a VAPID JWT the push service can verify", async () => {
    const keys = { ...(await generateVapidKeys()), subject: "mailto:owner@example.com" };
    const auth = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, Date.UTC(2026, 9, 1));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2]!)));
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:owner@example.com" });
    const pub = await crypto.subtle.importKey("raw", b64urlDecode(keys.publicKey) as unknown as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(m[3]!) as unknown as ArrayBuffer, new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });

  it("posts an encrypted body with the right headers, and reports gone endpoints", async () => {
    const keys = { ...(await generateVapidKeys()), subject: "mailto:o@e.com" };
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { publicKey: CryptoKey };
    const target = { endpoint: "https://web.push.apple.com/abc", p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
    let seen: RequestInit | null = null;
    const ok = await sendPush(target, { title: "t", body: "b", url: "/inbox", tag: "jarvis-1", urgency: "high" }, keys, (async (_u: string, init: RequestInit) => ((seen = init), new Response(null, { status: 201 }))) as unknown as typeof fetch);
    expect(ok).toEqual({ ok: true, status: 201 });
    const h = new Headers(seen!.headers);
    expect(h.get("content-encoding")).toBe("aes128gcm");
    expect(h.get("urgency")).toBe("high");
    expect(h.get("topic")).toBe("jarvis-1");
    expect(h.get("authorization")).toMatch(/^vapid t=/);
    const gone = await sendPush(target, { title: "t", body: "b", url: "/" }, keys, (async () => new Response("", { status: 410 })) as unknown as typeof fetch);
    expect(gone).toMatchObject({ ok: false, gone: true, status: 410 });
  });
});

describe("email", () => {
  it("sends through Resend without leaking the key in errors", async () => {
    let body: Record<string, unknown> = {};
    const id = await sendEmail({ apiKey: "re_secret", to: "me@x.com" }, { subject: "s", html: "<b>h</b>", text: "h" }, (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer re_secret");
      return Response.json({ id: "em_1" });
    }) as unknown as typeof fetch);
    expect(id).toBe("em_1");
    expect(body).toMatchObject({ to: ["me@x.com"], subject: "s", from: "JARVIS <onboarding@resend.dev>" });
    await expect(sendEmail({ apiKey: "re_secret", to: "me@x.com" }, { subject: "s", html: "", text: "" }, (async () => Response.json({ message: "invalid" }, { status: 422 })) as unknown as typeof fetch)).rejects.toThrow(/^Email failed: HTTP 422 invalid$/);
  });
});
