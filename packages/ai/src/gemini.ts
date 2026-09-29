// Gemini over REST (generateContent) with function calling. The key goes in a
// header, never the URL. Parts from the model are kept verbatim so any thought
// signatures survive into the next turn, as Gemini 3 requires.

export interface Part {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
  thought?: boolean;
  [k: string]: unknown;
}

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateRequest {
  system: string;
  contents: Content[];
  tools: FunctionDeclaration[];
  /** Ask for a JSON reply (no tools allowed in this mode). */
  json?: boolean;
  temperature?: number;
}

export interface ModelProvider {
  generate(req: GenerateRequest): Promise<Content>;
}

export class GeminiProvider implements ModelProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = "gemini-3.6-flash",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  async generate(req: GenerateRequest): Promise<Content> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.contents,
      ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools }] } : {}),
      generationConfig: { temperature: req.temperature ?? 0.4, ...(req.json ? { responseMimeType: "application/json" } : {}) },
    };
    const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      candidates?: Array<{ content?: Content; finishReason?: string }>;
    };
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(data.error?.message ?? "no detail").slice(0, 200)}`);
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    if (!parts.length) throw new Error(`Gemini returned nothing (finishReason: ${cand?.finishReason ?? "unknown"})`);
    return { role: "model", parts };
  }
}
