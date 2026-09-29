import { MESA_REFRESH_URL, MESA_WEB_ORIGIN } from "./config";
import { applySetCookies, cookieHeaderFor } from "./cookies";
import type { SessionState, SessionStore } from "./session-store";

// Browser-free token refresh (runs in Node and in Supabase Edge / Deno).
// Interactive sign-in, which does need a browser, lives in ./login.

export class MesaAuthError extends Error {
  constructor(
    message: string,
    readonly code: "NO_SESSION" | "SESSION_EXPIRED" | "REFRESH_FAILED" | "LOGIN_TIMEOUT",
  ) {
    super(message);
    this.name = "MesaAuthError";
  }
}

export interface AccessToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Reads `exp` from a JWT without verifying it (we only need to know when to refresh). */
export function jwtExpiryMs(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface RefreshResult {
  accessToken: AccessToken;
  /** Updated cookie state (the refresh endpoint may rotate the session cookie). */
  state: SessionState;
}

/**
 * Exchanges the stored session cookie for a short-lived API access token via
 * the web app's own /api/auth/refresh route — the same call the LMS page makes.
 */
export async function refreshAccessToken(state: SessionState, fetchImpl: typeof fetch = fetch): Promise<RefreshResult> {
  const cookie = cookieHeaderFor(MESA_REFRESH_URL, state.cookies);
  if (!cookie) throw new MesaAuthError("Saved MESA session has expired — run `npm run mesa:login`", "SESSION_EXPIRED");
  const res = await fetchImpl(MESA_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookie,
      Origin: MESA_WEB_ORIGIN,
      Referer: `${MESA_WEB_ORIGIN}/student/lms`,
    },
    redirect: "manual",
  });
  if (res.status === 401 || res.status === 403) {
    throw new MesaAuthError("MESA session has expired — run `npm run mesa:login`", "SESSION_EXPIRED");
  }
  if (!res.ok) throw new MesaAuthError(`Token refresh failed with HTTP ${res.status}`, "REFRESH_FAILED");
  const body = (await res.json()) as { data?: { accessToken?: unknown } };
  const token = body.data?.accessToken;
  if (typeof token !== "string") throw new MesaAuthError("Refresh response had no access token", "REFRESH_FAILED");
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return {
    accessToken: { token, expiresAt: jwtExpiryMs(token) ?? Date.now() + 5 * 60_000 },
    state: setCookies.length
      ? { cookies: applySetCookies(state.cookies, setCookies, MESA_REFRESH_URL), origins: [], savedAt: new Date().toISOString() }
      : state,
  };
}

export type Refresher = (state: SessionState) => Promise<RefreshResult>;

/** Hands out a valid access token, refreshing (and persisting rotated cookies) as needed. */
export class TokenProvider {
  private current: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly refresher: Refresher = (s) => refreshAccessToken(s),
    private readonly skewMs = 60_000,
  ) {}

  async get(): Promise<string> {
    if (this.current && this.current.expiresAt - this.skewMs > Date.now()) return this.current.token;
    return (await this.refresh()).token;
  }

  /** Forces a refresh (after a 401). Concurrent callers share one refresh. */
  refresh(): Promise<AccessToken> {
    this.inflight ??= (async () => {
      const state = await this.store.load();
      if (!state) throw new MesaAuthError("No saved MESA session — run `npm run mesa:login`", "NO_SESSION");
      const result = await this.refresher(state);
      if (result.state !== state) await this.store.save(result.state);
      this.current = result.accessToken;
      return result.accessToken;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}
