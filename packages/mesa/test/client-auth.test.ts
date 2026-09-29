import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateKey } from "@jarvis/shared";
import { MesaAuthError, TokenProvider, jwtExpiryMs, refreshAccessToken, type Refresher } from "../src/auth";
import { MesaApiError, MesaClient } from "../src/client";
import { MemorySessionStore, filterMesaCookies, sessionExpiry, type SessionState, type StoredCookie } from "../src/session-store";
import { fileSessionStore } from "../src/file-session";
import { fakeFetch, type FakeCall } from "./helpers";

const cookie = (name: string, domain: string, expires = -1): StoredCookie => ({
  name,
  value: "v",
  domain,
  path: "/",
  expires,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
});
const state = (cookies = [cookie("refresh", "students.mesaschool.co.in", 1_900_000_000)]): SessionState => ({ cookies, origins: [], savedAt: "x" });
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const noSleep = async () => {};

describe("MesaClient", () => {
  it("refreshes once on 401 and retries", async () => {
    let n = 0;
    const tokens = { get: vi.fn(async () => (n ? "fresh" : "stale")), refresh: vi.fn(async () => void n++) };
    const calls: FakeCall[] = [];
    const fetch = fakeFetch({ "/x": (c: FakeCall) => (c.auth === "Bearer fresh" ? Response.json({ ok: 1 }) : new Response(null, { status: 401 })) }, calls);
    const client = new MesaClient({ tokens, fetch, minGapMs: 0, sleep: noSleep });
    await expect(client.get("/x")).resolves.toEqual({ ok: 1 });
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.auth)).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("gives up with an auth error if a fresh token is also rejected", async () => {
    const tokens = { get: async () => "t", refresh: async () => undefined };
    const client = new MesaClient({ tokens, fetch: fakeFetch({ "/x": () => new Response(null, { status: 401 }) }), minGapMs: 0, sleep: noSleep });
    await expect(client.get("/x")).rejects.toBeInstanceOf(MesaAuthError);
  });

  it("backs off and retries on 429 / 5xx", async () => {
    let n = 0;
    const sleep = vi.fn(noSleep);
    const fetch = fakeFetch({ "/x": () => (++n < 3 ? new Response(null, { status: n === 1 ? 429 : 503, headers: { "retry-after": "2" } }) : Response.json({ ok: 1 })) });
    const client = new MesaClient({ tokens: { get: async () => "t", refresh: async () => 0 }, fetch, minGapMs: 0, sleep });
    await expect(client.get("/x")).resolves.toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("surfaces other errors with the API's error code", async () => {
    const client = new MesaClient({ tokens: { get: async () => "t", refresh: async () => 0 }, fetch: fakeFetch({}), minGapMs: 0, sleep: noSleep });
    await expect(client.get("/missing")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" } satisfies Partial<MesaApiError>);
  });

  it("never runs more than maxConcurrency requests at once", async () => {
    let active = 0;
    let peak = 0;
    const fetch = (async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return Response.json({});
    }) as unknown as typeof globalThis.fetch;
    const client = new MesaClient({ tokens: { get: async () => "t", refresh: async () => 0 }, fetch, maxConcurrency: 2, minGapMs: 0 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => client.get(`/p${i}`)));
    expect(peak).toBe(2);
  });

  it("exposes no mutating methods", () => {
    const proto = Object.getOwnPropertyNames(MesaClient.prototype);
    for (const verb of ["post", "put", "patch", "delete", "submit"]) expect(proto).not.toContain(verb);
  });
});

describe("TokenProvider", () => {
  it("fails clearly when no session has been saved", async () => {
    await expect(new TokenProvider(new MemorySessionStore()).get()).rejects.toMatchObject({ code: "NO_SESSION" });
  });

  it("caches the token until it nears expiry, and persists rotated cookies", async () => {
    const store = new MemorySessionStore(state());
    const rotated = state([cookie("refresh2", "students.mesaschool.co.in")]);
    let exp = Date.now() + 15 * 60_000;
    const refresher: Refresher = vi.fn(async () => ({ accessToken: { token: `tok-${exp}`, expiresAt: exp }, state: rotated }));
    const tp = new TokenProvider(store, refresher, 60_000);
    const first = await tp.get();
    expect(await tp.get()).toBe(first);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(await store.load()).toBe(rotated);
    exp = Date.now() + 30_000; // next token; force expiry of the current one:
    await tp.refresh();
    await tp.get(); // current expires within skew → refresh again
    expect(refresher).toHaveBeenCalledTimes(3);
  });

  it("shares one refresh between concurrent callers", async () => {
    const refresher: Refresher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { accessToken: { token: "t", expiresAt: Date.now() + 900_000 }, state: state() };
    });
    const tp = new TokenProvider(new MemorySessionStore(state()), refresher);
    await Promise.all([tp.get(), tp.get(), tp.get()]);
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("reads JWT expiry without verifying", () => {
    expect(jwtExpiryMs(jwt(1790598873))).toBe(1790598873000);
    expect(jwtExpiryMs("garbage")).toBeNull();
  });
});

describe("session store", () => {
  it("keeps only MESA cookies", () => {
    const kept = filterMesaCookies([cookie("a", "students.mesaschool.co.in"), cookie("b", ".mesaschool.co.in"), cookie("c", ".google.com")]);
    expect(kept.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("reports the earliest persistent cookie expiry", () => {
    expect(sessionExpiry(state([cookie("a", "x", 2_000_000_000), cookie("b", "x", 1_900_000_000), cookie("s", "x", -1)]))).toBe(
      new Date(1_900_000_000_000).toISOString(),
    );
    expect(sessionExpiry(state([cookie("s", "x", -1)]))).toBeNull();
  });

  it("round-trips through an encrypted file and rejects the wrong key", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "jarvis-")), "s.enc");
    const key = generateKey();
    await fileSessionStore(key, path).save(state());
    expect(await fileSessionStore(key, path).load()).toEqual(state());
    await expect(fileSessionStore(generateKey(), path).load()).rejects.toThrow();
  });
});

describe("refreshAccessToken (browser-free)", () => {
  const exp = Math.floor(Date.now() / 1000) + 900;
  const refreshFetch = (status: number, setCookie?: string, seen?: RequestInit[]) =>
    (async (_url: string, init: RequestInit) => {
      seen?.push(init);
      const headers = new Headers({ "content-type": "application/json" });
      if (setCookie) headers.append("set-cookie", setCookie);
      return new Response(status === 200 ? JSON.stringify({ data: { accessToken: jwt(exp), user: {} } }) : "{}", { status, headers });
    }) as unknown as typeof fetch;

  it("sends only the MESA cookie with browser-like origin headers", async () => {
    const seen: RequestInit[] = [];
    const s = state([cookie("refresh", "students.mesaschool.co.in", exp + 86400), cookie("other", ".google.com", exp + 86400)]);
    const r = await refreshAccessToken(s, refreshFetch(200, undefined, seen));
    const h = new Headers(seen[0]!.headers);
    expect(seen[0]!.method).toBe("POST");
    expect(h.get("cookie")).toBe("refresh=v");
    expect(h.get("origin")).toBe("https://students.mesaschool.co.in");
    expect(r.accessToken.expiresAt).toBe(exp * 1000);
    expect(r.state).toBe(s); // no Set-Cookie → unchanged, so nothing is re-saved
  });

  it("folds a rotated cookie back into the session", async () => {
    const s = state([cookie("refresh", "students.mesaschool.co.in", exp + 86400)]);
    const r = await refreshAccessToken(s, refreshFetch(200, "refresh=NEW; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax"));
    expect(r.state.cookies).toHaveLength(1);
    expect(r.state.cookies[0]).toMatchObject({ name: "refresh", value: "NEW", httpOnly: true, secure: true });
  });

  it("maps 401 to SESSION_EXPIRED and never calls out with an expired cookie", async () => {
    const live = state([cookie("refresh", "students.mesaschool.co.in", exp + 86400)]);
    await expect(refreshAccessToken(live, refreshFetch(401))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const dead = state([cookie("refresh", "students.mesaschool.co.in", 1000)]);
    const f = vi.fn(refreshFetch(200));
    await expect(refreshAccessToken(dead, f)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(f).not.toHaveBeenCalled();
  });
});
