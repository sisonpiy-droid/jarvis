import { MESA_API_BASE } from "./config";
import { MesaAuthError } from "./auth";

// Read-only by construction: the client only exposes GET. Nothing in V1 can
// submit, edit or delete anything on the LMS.

export class MesaApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly code?: string,
  ) {
    super(`MESA API ${status} on GET ${path}${code ? ` (${code})` : ""}`);
    this.name = "MesaApiError";
  }
}

export interface TokenSource {
  get(): Promise<string>;
  refresh(): Promise<unknown>;
}

export interface MesaClientOptions {
  tokens: TokenSource;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxConcurrency?: number;
  minGapMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MesaClient {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxConcurrency: number;
  private readonly minGapMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private queue: Array<() => void> = [];
  private lastStart = 0;
  requestCount = 0;

  constructor(private readonly opts: MesaClientOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? MESA_API_BASE;
    this.maxConcurrency = opts.maxConcurrency ?? 3;
    this.minGapMs = opts.minGapMs ?? 150;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async get<T = unknown>(path: string): Promise<T> {
    await this.acquire();
    try {
      return await this.getWithRetry<T>(path);
    } finally {
      this.release();
    }
  }

  private async getWithRetry<T>(path: string): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.tokens.get();
      this.requestCount++;
      let res: Response;
      try {
        res = await this.fetch(this.baseUrl + path, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.opts.tokens.refresh();
        continue;
      }
      if (res.status === 401) throw new MesaAuthError("MESA rejected a freshly refreshed token", "SESSION_EXPIRED");
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt));
        continue;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        throw new MesaApiError(res.status, path, body?.error?.code);
      }
      return (await res.json()) as T;
    }
  }

  private backoff(attempt: number): number {
    return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.maxConcurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    const wait = this.lastStart + this.minGapMs - Date.now();
    this.lastStart = Math.max(Date.now(), this.lastStart + this.minGapMs);
    if (wait > 0) await this.sleep(wait);
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
