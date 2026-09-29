import type { Content, FunctionDeclaration, ModelProvider, Part } from "./gemini";

// The tool-calling loop. Tools are the only way the model touches data, and
// each declares what it may do: "read" (free), "write-local" (free, logged —
// e.g. a reminder to yourself). Anything external/irreversible must never be a
// tool here; it would go through an approval flow instead.

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: "read" | "write-local";
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentResult {
  text: string;
  /** New turns to append to history (model/tool turns + the user turn). */
  turns: Content[];
  toolCalls: Array<{ name: string; ok: boolean }>;
}

const MAX_TOOL_RESULT_CHARS = 30_000;

export async function runAgent(opts: {
  model: ModelProvider;
  system: string;
  history: Content[];
  user: Part[];
  tools: Tool[];
  maxSteps?: number;
}): Promise<AgentResult> {
  const decls: FunctionDeclaration[] = opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const turns: Content[] = [{ role: "user", parts: opts.user }];
  const toolCalls: AgentResult["toolCalls"] = [];

  for (let step = 0; step < (opts.maxSteps ?? 6); step++) {
    const reply = await opts.model.generate({ system: opts.system, contents: [...opts.history, ...turns], tools: decls });
    turns.push(reply);
    const calls = reply.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const text = reply.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      return { text: text || "I couldn't come up with an answer to that.", turns, toolCalls };
    }
    const responses: Part[] = [];
    for (const c of calls) {
      const call = c.functionCall!;
      const tool = byName.get(call.name);
      let response: Record<string, unknown>;
      try {
        if (!tool) throw new Error(`unknown tool ${call.name}`);
        const result = await tool.run(call.args ?? {});
        let json = JSON.stringify(result ?? null);
        if (json.length > MAX_TOOL_RESULT_CHARS) json = JSON.stringify({ truncated: true, partial: json.slice(0, MAX_TOOL_RESULT_CHARS) });
        response = { result: JSON.parse(json) };
        toolCalls.push({ name: call.name, ok: true });
      } catch (err) {
        response = { error: err instanceof Error ? err.message : String(err) };
        toolCalls.push({ name: call.name, ok: false });
      }
      responses.push({ functionResponse: { name: call.name, response, ...(call.id ? { id: call.id } : {}) } });
    }
    turns.push({ role: "user", parts: responses });
  }
  return { text: "That needed more steps than I allow in one reply — try asking more specifically.", turns, toolCalls };
}
