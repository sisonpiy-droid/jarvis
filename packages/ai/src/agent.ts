import { textOf, toolCallsOf, type GenerateRequest, type Message, type ModelProvider, type Part, type ToolDecl } from "./model";

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
  /** New turns to append to history (the user turn, then assistant/tool turns). */
  turns: Message[];
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** What each tool call returned (as the model saw it), in call order. */
  toolResults: Array<{ name: string; ok: boolean; result?: unknown; error?: string }>;
}

const MAX_TOOL_RESULT_CHARS = 30_000;

export async function runAgent(opts: {
  model: ModelProvider;
  system: string;
  history: Message[];
  user: Part[];
  tools: Tool[];
  maxSteps?: number;
  thinking?: GenerateRequest["thinking"];
  toolChoice?: "auto" | "none";
}): Promise<AgentResult> {
  const decls: ToolDecl[] = opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const turns: Message[] = [{ role: "user", parts: opts.user }];
  const toolCalls: AgentResult["toolCalls"] = [];
  const toolResults: AgentResult["toolResults"] = [];

  for (let step = 0; step < (opts.maxSteps ?? 6); step++) {
    const reply = await opts.model.generate({
      system: opts.system,
      messages: [...opts.history, ...turns],
      tools: decls,
      ...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
    });
    turns.push(reply);
    const calls = toolCallsOf(reply);
    if (!calls.length) {
      return { text: textOf(reply) || "I couldn't come up with an answer to that.", turns, toolCalls, toolResults };
    }
    const results: Part[] = [];
    const exec = (call: (typeof calls)[number]) => {
      const tool = byName.get(call.name);
      return tool ? tool.run(call.args).then((v) => ({ v }), (e: unknown) => ({ e })) : Promise.resolve({ e: new Error(`unknown tool ${call.name}`) as unknown });
    };
    // Lookups in one step run in parallel; any write keeps the model's order.
    const outs: Array<{ v?: unknown; e?: unknown }> = calls.every((c) => byName.get(c.name)?.effect === "read") ? await Promise.all(calls.map(exec)) : [];
    if (!outs.length) for (const c of calls) outs.push(await exec(c));
    for (const [i, call] of calls.entries()) {
      try {
        if ("e" in outs[i]!) throw outs[i]!.e;
        const out = outs[i]!.v;
        let json = JSON.stringify(out ?? null);
        if (json.length > MAX_TOOL_RESULT_CHARS) json = JSON.stringify({ truncated: true, partial: json.slice(0, MAX_TOOL_RESULT_CHARS) });
        const result: unknown = JSON.parse(json);
        results.push({ type: "tool_result", id: call.id, name: call.name, result });
        toolCalls.push({ name: call.name, ok: true });
        toolResults.push({ name: call.name, ok: true, result });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ type: "tool_result", id: call.id, name: call.name, error });
        toolCalls.push({ name: call.name, ok: false });
        toolResults.push({ name: call.name, ok: false, error });
      }
    }
    turns.push({ role: "tool", parts: results });
  }
  // Out of steps: answer from what was gathered instead of giving up.
  const last = await opts.model.generate({ system: opts.system, messages: [...opts.history, ...turns], tools: decls, toolChoice: "none", ...(opts.thinking ? { thinking: opts.thinking } : {}) }).catch(() => null);
  const text = last && !toolCallsOf(last).length ? textOf(last) : "";
  if (last && text) {
    turns.push(last);
    return { text, turns, toolCalls, toolResults };
  }
  return { text: "That needed more steps than I allow in one reply — try asking more specifically.", turns, toolCalls, toolResults };
}
