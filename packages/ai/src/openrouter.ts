import type { UsageMeter } from "./gemini";
import { SYNTHETIC_ID_PREFIX, type GenerateRequest, type Message, type ModelProvider, type Part } from "./model";

// OpenRouter (OpenAI-style chat API) as a second model provider: the backup JARVIS fails over to when Gemini is
// down, rate-limited or its key is rejected (see model-chain.ts). Text, tool calls and images; JSON mode. Audio and
// documents (voice notes, PDF deliverables) stay Gemini-only: asking for them here throws, and the chain reports it.
// The key goes in a header, never the URL.

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type OAIContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: OAIContent | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

/** Neutral → OpenAI-style messages. A tool result with no id is paired, in order, with the assistant's open calls. */
export function toOpenAiMessages(system: string, messages: Message[]): OAIMessage[] {
  const out: OAIMessage[] = [{ role: "system", content: system }];
  let open: string[] = [];
  let seq = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      const calls = m.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call").map((p) => ({ id: p.id || `call_${++seq}`, type: "function" as const, function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) } }));
      open = calls.map((c) => c.id);
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === "tool") {
      for (const p of m.parts) {
        if (p.type !== "tool_result") continue;
        const at = p.id ? open.indexOf(p.id) : -1;
        if (at >= 0) open.splice(at, 1); // this call is answered
        const id = at >= 0 ? p.id : (open.shift() ?? p.id ?? `call_${++seq}`);
        out.push({ role: "tool", tool_call_id: id, content: JSON.stringify(p.error !== undefined ? { error: p.error } : { result: p.result ?? null }) });
      }
    } else {
      const content: Exclude<OAIContent, string> = [];
      for (const p of m.parts) {
        if (p.type === "text") content.push({ type: "text", text: p.text });
        else if (p.type === "file") {
          if (!p.mimeType.startsWith("image/")) throw new Error(`the backup model can't read ${p.mimeType} files`);
          content.push({ type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } });
        }
      }
      out.push({ role: "user", content: content.length === 1 && content[0]!.type === "text" ? content[0]!.text : content });
    }
  }
  return out;
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter";
  private replies = 0;

  constructor(
    private readonly apiKey: string,
    private readonly model = "google/gemini-2.5-flash",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
    private readonly meter: UsageMeter | null = null,
  ) {}

  async generate(req: GenerateRequest): Promise<Message> {
    const body = {
      model: this.model,
      messages: toOpenAiMessages(req.system, req.messages),
      temperature: req.temperature ?? 0.4,
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      ...(req.toolChoice === "none" && req.tools.length ? { tool_choice: "none" } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    };
    const res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string | null; tool_calls?: OAIToolCall[] }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(data.error?.message ?? "no detail").slice(0, 200)}`);
    const msg = data.choices?.[0]?.message;
    const parts: Part[] = [];
    if (msg?.content) parts.push({ type: "text", text: msg.content });
    const seed = `${++this.replies}${Math.random().toString(36).slice(2, 8)}`;
    for (const [i, c] of (msg?.tool_calls ?? []).entries()) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // malformed arguments: the tool reports the missing fields back to the model
      }
      parts.push({ type: "tool_call", id: c.id || `${SYNTHETIC_ID_PREFIX}or-${seed}-${i}`, name: c.function.name, args });
    }
    if (!parts.length) throw new Error(`OpenRouter returned nothing (finish_reason: ${data.choices?.[0]?.finish_reason ?? "unknown"})`);
    const u = data.usage;
    if (this.meter && u) await Promise.resolve(this.meter({ task: req.task ?? "other", model: `openrouter:${this.model}`, inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 })).catch(() => {});
    return { role: "assistant", parts };
  }
}
