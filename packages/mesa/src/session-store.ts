import { open, seal } from "@jarvis/shared";

// The saved MESA session (cookies only), sealed with MESA_SESSION_KEY. This is
// the only long-lived credential JARVIS holds for MESA; the password is never
// seen or stored. Where the sealed blob lives (a file locally, a DB row in the
// cloud) is pluggable.

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface SessionState {
  cookies: StoredCookie[];
  origins: never[];
  savedAt: string;
}

export interface SessionStore {
  load(): Promise<SessionState | null>;
  save(state: SessionState): Promise<void>;
}

/** Where a sealed (encrypted) blob is kept. */
export interface SealedBlobStore {
  read(): Promise<string | null>;
  write(sealed: string, meta: { expiresAt: string | null }): Promise<void>;
}

const MESA_DOMAIN = /(^|\.)mesaschool\.co\.in$/;

/** Keep only MESA cookies; drops any third-party state the browser picked up. */
export function filterMesaCookies(cookies: StoredCookie[]): StoredCookie[] {
  return cookies.filter((c) => MESA_DOMAIN.test(c.domain.replace(/^\./, "")));
}

/** Earliest-expiring persistent cookie, as an ISO string, or null for session-only cookies. */
export function sessionExpiry(state: SessionState): string | null {
  const persistent = state.cookies.map((c) => c.expires).filter((e) => e > 0);
  return persistent.length ? new Date(Math.min(...persistent) * 1000).toISOString() : null;
}

export class SealedSessionStore implements SessionStore {
  constructor(
    private readonly key: string,
    private readonly blobs: SealedBlobStore,
  ) {}

  async load(): Promise<SessionState | null> {
    const sealed = await this.blobs.read();
    return sealed ? (JSON.parse(await open(sealed, this.key)) as SessionState) : null;
  }

  async save(state: SessionState): Promise<void> {
    await this.blobs.write(await seal(JSON.stringify(state), this.key), { expiresAt: sessionExpiry(state) });
  }
}

export class MemorySessionStore implements SessionStore {
  constructor(private state: SessionState | null = null) {}
  async load() {
    return this.state;
  }
  async save(state: SessionState) {
    this.state = state;
  }
}
