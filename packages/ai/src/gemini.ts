import { logLlmCall, type Sql } from "@jarvis/db";
import { SYNTHETIC_ID_PREFIX, isSyntheticCallId, type GenerateRequest, type Message, type ModelProvider, type Part, type ProviderMeta } from "./model";

// Gemini over REST (generateContent) with function calling. The key goes in a
// header, never the URL. The rest of JARVIS speaks the neutral types in ./model;
// this file maps them to Gemini's wire format and back. Thought signatures stay
// on exactly the part that carried them (signature-only parts are kept too),
// because Gemini 3 rejects a multi-step tool exchange that drops one.

/** Receives one record per successful call (see @jarvis/db llm-usage). A failure inside it never fails the call. */
export type UsageMeter = (u: { task: string; model: string; inputTokens: number; outputTokens: number }) => void | Promise<void>;

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
  thought?: boolean;
  [k: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const sigOut = (meta: ProviderMeta | undefined) => (meta?.gemini?.thoughtSignature ? { thoughtSignature: meta.gemini.thoughtSignature } : {});
const sigIn = (p: GeminiPart): { meta?: ProviderMeta } => (typeof p.thoughtSignature === "string" ? { meta: { gemini: { thoughtSignature: p.thoughtSignature } } } : {});

function toGeminiPart(p: Part): GeminiPart {
  switch (p.type) {
    case "text":
      return { text: p.text, ...sigOut(p.meta) };
    case "thinking":
      return { text: p.text, thought: true, ...sigOut(p.meta) };
    case "tool_call":
      return { functionCall: { name: p.name, args: p.args, ...(isSyntheticCallId(p.id) ? {} : { id: p.id }) }, ...sigOut(p.meta) };
    case "tool_result":
      return {
        functionResponse: {
          name: p.name,
          response: p.error !== undefined ? { error: p.error } : { result: p.result ?? null },
          ...(p.id && !isSyntheticCallId(p.id) ? { id: p.id } : {}),
        },
      };
    case "file":
      return { inlineData: { mimeType: p.mimeType, data: p.data } };
  }
}

/** Neutral → Gemini. assistant → "model"; user and tool → "user" (tool results travel as functionResponse parts). */
export function toGeminiContents(messages: Message[]): GeminiContent[] {
  return messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: m.parts.map(toGeminiPart) }));
}

/**
 * Gemini → neutral, part for part and in order. A functionCall without an id gets `gx-<seed>-<i>`; a
 * functionResponse keeps its id or gets "" (the caller pairs it with its call). Parts we don't model are
 * dropped, but a signature never is: a part carrying only a signature becomes an empty text part.
 */
export function fromGeminiContent(c: GeminiContent, seed: string | number): Message {
  const parts: Part[] = [];
  c.parts.forEach((p, i) => {
    if (p.functionCall) {
      const fc = p.functionCall;
      parts.push({ type: "tool_call", id: fc.id || `${SYNTHETIC_ID_PREFIX}${seed}-${i}`, name: fc.name, args: fc.args ?? {}, ...sigIn(p) });
    } else if (p.functionResponse) {
      const fr = p.functionResponse;
      const r = fr.response ?? {};
      parts.push({ type: "tool_result", id: fr.id ?? "", name: fr.name, ...("error" in r ? { error: String(r.error) } : { result: "result" in r ? r.result : r }) });
    } else if (p.inlineData) {
      parts.push({ type: "file", mimeType: p.inlineData.mimeType, data: p.inlineData.data });
    } else if (typeof p.text === "string" || p.thought || typeof p.thoughtSignature === "string") {
      parts.push({ type: p.thought ? "thinking" : "text", text: typeof p.text === "string" ? p.text : "", ...sigIn(p) });
    }
  });
  const role = c.role === "model" ? "assistant" : c.parts.length && c.parts.every((p) => p.functionResponse) ? "tool" : "user";
  return { role, parts };
}

export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  private replies = 0;

  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-3.6-flash",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
    private readonly meter: UsageMeter | null = null,
  ) {}

  /** Seed for the ids of id-less calls in a live reply: a per-instance counter plus 6 random base36 characters. */
  private liveSeed(): string {
    return `${++this.replies}${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
  }

  /** One retry after a timeout, a network error, 429 or 5xx — a single slow reply shouldn't lose an answer or a job. */
  async generate(req: GenerateRequest): Promise<Message> {
    try {
      return await this.once(req);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (!/TimeoutError|AbortError|fetch failed|network|Gemini HTTP (429|5\d\d)/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      return this.once(req);
    }
  }

  private async once(req: GenerateRequest): Promise<Message> {
    const decls: GeminiFunctionDeclaration[] = req.tools;
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
      ...(req.toolChoice === "none" ? { toolConfig: { functionCallingConfig: { mode: "NONE" } } } : {}),
      generationConfig: {
        temperature: req.temperature ?? 0.4,
        ...(req.json ? { responseMimeType: "application/json" } : {}),
        ...(req.thinking ? { thinkingConfig: { thinkingLevel: req.thinking } } : {}),
      },
    };
    const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(data.error?.message ?? "no detail").slice(0, 200)}`);
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    if (!parts.length) throw new Error(`Gemini returned nothing (finishReason: ${cand?.finishReason ?? "unknown"})`);
    const u = data.usageMetadata;
    // Thinking tokens are billed as output.
    if (this.meter && u) await Promise.resolve(this.meter({ task: req.task ?? "other", model: this.model, inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) })).catch(() => {});
    return fromGeminiContent({ role: "model", parts }, this.liveSeed());
  }
}

/** A meter that writes to the cost log. */
export const meterTo =
  (sql: Sql): UsageMeter =>
  (u) =>
    logLlmCall(sql, u);
