import { GeminiProvider, type UsageMeter } from "./gemini";
import type { GenerateRequest, Message, ModelProvider } from "./model";
import { OpenRouterProvider } from "./openrouter";

// Never-stop model access: Gemini first, OpenRouter behind it. A call goes to the first provider that answers; one
// that is down (key rejected, quota hit, server error, timeout) is skipped for a few minutes, so a dead provider
// costs one slow call, not one per message. If every provider fails the last error is thrown, as before.

/** Errors that mean "this provider is unavailable right now" (as opposed to a bad request). */
const OUTAGE = /HTTP (?:401|402|403|429|5\d\d)|TimeoutError|AbortError|fetch failed|network|ECONN|ENOTFOUND/i;

/** Which providers are down, shared by every chain in this process (a web request builds a new chain each time). */
const SHARED_DOWN = new Map<string, number>();

export class FallbackProvider implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly chain: ModelProvider[],
    private readonly cooldownMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly down: Map<string, number> = SHARED_DOWN,
  ) {
    this.name = chain.map((p) => p.name).join("→");
  }

  async generate(req: GenerateRequest): Promise<Message> {
    const t = this.now();
    // Healthy providers first, in order; any in cooldown are still tried last rather than giving up.
    const order = [...this.chain.filter((p) => (this.down.get(p.name) ?? 0) <= t), ...this.chain.filter((p) => (this.down.get(p.name) ?? 0) > t)];
    let last: unknown;
    for (const p of order) {
      try {
        const reply = await p.generate(req);
        this.down.delete(p.name);
        return reply;
      } catch (err) {
        last = err;
        if (OUTAGE.test(err instanceof Error ? `${err.name} ${err.message}` : String(err))) this.down.set(p.name, this.now() + this.cooldownMs);
      }
    }
    throw last;
  }
}

export interface ModelEnvOptions {
  timeoutMs?: number;
  meter?: UsageMeter | null;
  fetch?: typeof fetch;
  /** Overrides GEMINI_MODEL (e.g. the draft model for deliverables). */
  geminiModel?: string;
}

/**
 * The model for this environment: Gemini (GEMINI_API_KEY) with OpenRouter (OPENROUTER_API_KEY) as the backup;
 * whichever key is missing is simply left out. Null when neither is set. `get` reads one setting (process.env or Deno.env).
 */
export function modelFromEnv(get: (name: string) => string | undefined, o: ModelEnvOptions = {}): ModelProvider | null {
  const f = o.fetch ?? fetch;
  const timeout = o.timeoutMs ?? 60_000;
  const gemini = get("GEMINI_API_KEY");
  const router = get("OPENROUTER_API_KEY");
  const chain: ModelProvider[] = [];
  if (gemini) chain.push(new GeminiProvider(gemini, o.geminiModel ?? (get("GEMINI_MODEL") || "gemini-3.6-flash"), f, timeout, o.meter ?? null));
  if (router) chain.push(new OpenRouterProvider(router, get("OPENROUTER_MODEL") || "google/gemini-2.5-flash", f, timeout, o.meter ?? null));
  return chain.length === 0 ? null : chain.length === 1 ? chain[0]! : new FallbackProvider(chain);
}
