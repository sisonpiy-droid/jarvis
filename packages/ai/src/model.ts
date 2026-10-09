// Provider-neutral model types. Everything outside a provider adapter (the agent loop, chat history, drafting,
// delivery) speaks these; each provider maps them to and from its own wire format. Provider-specific data that
// must survive a round trip (Gemini's thought signatures) rides along in `meta`, on exactly the part it came on.

export type Role = "user" | "assistant" | "tool";

export interface ProviderMeta {
  gemini?: { thoughtSignature?: string };
  [provider: string]: Record<string, unknown> | undefined;
}

export type Part =
  | { type: "text"; text: string; meta?: ProviderMeta }
  | { type: "thinking"; text: string; meta?: ProviderMeta }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; meta?: ProviderMeta }
  | { type: "tool_result"; id: string; name: string; result?: unknown; error?: string }
  | { type: "file"; mimeType: string; data: string }; // data is base64

/** user: text | file · assistant: text | thinking | tool_call · tool: tool_result */
export interface Message {
  role: Role;
  parts: Part[];
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateRequest {
  system: string;
  messages: Message[];
  tools: ToolDecl[];
  /** Ask for a JSON reply (no tools allowed in this mode). */
  json?: boolean;
  temperature?: number;
  /** "none" forbids tool calls for this request even when tools are declared. */
  toolChoice?: "auto" | "none";
  /** How much the model reasons before answering; less is faster. Provider default when omitted. */
  thinking?: "minimal" | "low" | "medium" | "high";
  /** What the call is for ("chat", "brief_note", …) — the cost log is grouped by it. */
  task?: string;
}

export interface ModelProvider {
  readonly name: string;
  /** Returns the model's turn (role "assistant"). */
  generate(req: GenerateRequest): Promise<Message>;
}

/** Ids we invent for tool calls the provider sent without one. Never sent back to the provider. */
export const SYNTHETIC_ID_PREFIX = "gx-";
export const isSyntheticCallId = (id: string) => id.startsWith(SYNTHETIC_ID_PREFIX);

/** The visible text of a message: text parts only (never thinking), joined and trimmed. */
export function textOf(m: Pick<Message, "parts"> | Part[]): string {
  const parts = Array.isArray(m) ? m : m.parts;
  return parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

export function toolCallsOf(m: Message): Extract<Part, { type: "tool_call" }>[] {
  return m.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
}

export const userText = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });

/** True when stored parts are already neutral (every part has a string `type`); Gemini parts never do. */
export const isNeutralParts = (parts: unknown[]) => parts.every((p) => typeof (p as { type?: unknown } | null)?.type === "string");
