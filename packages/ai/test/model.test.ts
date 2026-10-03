import { describe, expect, it } from "vitest";
import { runAgent, type Tool } from "../src/agent";
import { GeminiProvider, fromGeminiContent, toGeminiContents, type GeminiContent } from "../src/gemini";
import { isNeutralParts, isSyntheticCallId, textOf, toolCallsOf, userText, type Message } from "../src/model";

// The neutral model types and the Gemini mapping. Gemini 3 rejects a multi-step tool exchange whose thought
// signatures were dropped or moved, so these pin the signature to the exact part it arrived on.

/** A fake Gemini endpoint: answers with the queued candidate parts and records each request body. */
function fakeGemini(...replies: Array<Array<Record<string, unknown>>>) {
  const bodies: Array<{ contents: GeminiContent[]; [k: string]: unknown }> = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const parts = replies.shift();
    if (!parts) return Response.json({ error: { message: "no more replies" } }, { status: 500 });
    return Response.json({ candidates: [{ content: { role: "model", parts } }] });
  }) as unknown as typeof fetch;
  return { provider: new GeminiProvider("KEY", "gemini-test", f), bodies };
}

describe("neutral helpers", () => {
  it("textOf joins text parts only, never thinking", () => {
    const m: Message = { role: "assistant", parts: [{ type: "thinking", text: "plan…" }, { type: "text", text: " Hello " }, { type: "tool_call", id: "a", name: "t", args: {} }, { type: "text", text: "there. " }] };
    expect(textOf(m)).toBe("Hello there.");
    expect(textOf(m.parts)).toBe("Hello there.");
    expect(toolCallsOf(m).map((c) => c.name)).toEqual(["t"]);
  });
  it("tells neutral parts from Gemini parts", () => {
    expect(isNeutralParts(userText("hi").parts)).toBe(true);
    expect(isNeutralParts([{ text: "hi" }])).toBe(false);
    expect(isNeutralParts([{ functionCall: { name: "x" } }, { type: "text", text: "" }])).toBe(false);
    expect(isSyntheticCallId("gx-12-0")).toBe(true);
    expect(isSyntheticCallId("call_abc")).toBe(false);
  });
});

describe("Gemini mapping", () => {
  const reply: GeminiContent = {
    role: "model",
    parts: [
      { text: "weighing it", thought: true, thoughtSignature: "sig-0" },
      { text: "Let me check." },
      { functionCall: { name: "get_due", args: { days: 3 }, id: "fc-1" }, thoughtSignature: "sig-1" },
      { thoughtSignature: "sig-2" },
    ],
  };

  it("round-trips text, a call with an id, a thought and a signature-only part, signatures on the same parts", () => {
    const m = fromGeminiContent(reply, 7);
    expect(m).toEqual({
      role: "assistant",
      parts: [
        { type: "thinking", text: "weighing it", meta: { gemini: { thoughtSignature: "sig-0" } } },
        { type: "text", text: "Let me check." },
        { type: "tool_call", id: "fc-1", name: "get_due", args: { days: 3 }, meta: { gemini: { thoughtSignature: "sig-1" } } },
        { type: "text", text: "", meta: { gemini: { thoughtSignature: "sig-2" } } },
      ],
    });
    const [back] = toGeminiContents([m]);
    expect(back).toEqual({
      role: "model",
      parts: [
        { text: "weighing it", thought: true, thoughtSignature: "sig-0" },
        { text: "Let me check." },
        { functionCall: { name: "get_due", args: { days: 3 }, id: "fc-1" }, thoughtSignature: "sig-1" },
        { text: "", thoughtSignature: "sig-2" },
      ],
    });
    // Same signature, same index, and no part gained or lost one.
    expect(back!.parts.map((p) => p.thoughtSignature ?? null)).toEqual(reply.parts.map((p) => p.thoughtSignature ?? null));
  });

  it("gives an id-less call a synthetic gx- id and leaves it out on the way back", () => {
    const m = fromGeminiContent({ role: "model", parts: [{ functionCall: { name: "a" } }, { functionCall: { name: "b", args: { x: 1 } } }] }, 42);
    expect(toolCallsOf(m).map((c) => c.id)).toEqual(["gx-42-0", "gx-42-1"]);
    expect(toolCallsOf(m)[0]!.args).toEqual({});
    expect(toGeminiContents([m])[0]!.parts).toEqual([{ functionCall: { name: "a", args: {} } }, { functionCall: { name: "b", args: { x: 1 } } }]);
  });

  it("sends a tool message as a user functionResponse: {result} on success, {error} on failure", () => {
    const tool: Message = {
      role: "tool",
      parts: [
        { type: "tool_result", id: "gx-42-0", name: "a", result: [{ title: "Case" }] },
        { type: "tool_result", id: "fc-9", name: "b", error: "db down" },
        { type: "tool_result", id: "gx-42-2", name: "c" },
      ],
    };
    expect(toGeminiContents([tool])).toEqual([
      {
        role: "user",
        parts: [
          { functionResponse: { name: "a", response: { result: [{ title: "Case" }] } } },
          { functionResponse: { name: "b", response: { error: "db down" }, id: "fc-9" } },
          { functionResponse: { name: "c", response: { result: null } } },
        ],
      },
    ]);
    // And back: an all-functionResponse user content is a tool message; ids are left for the caller to pair.
    expect(fromGeminiContent(toGeminiContents([tool])[0]!, 1)).toEqual({
      role: "tool",
      parts: [
        { type: "tool_result", id: "", name: "a", result: [{ title: "Case" }] },
        { type: "tool_result", id: "fc-9", name: "b", error: "db down" },
        { type: "tool_result", id: "", name: "c", result: null },
      ],
    });
  });

  it("sends a file part as inlineData and maps it back", () => {
    const m: Message = { role: "user", parts: [{ type: "text", text: "brief:" }, { type: "file", mimeType: "application/pdf", data: "JVBERi0=" }] };
    const [c] = toGeminiContents([m]);
    expect(c).toEqual({ role: "user", parts: [{ text: "brief:" }, { inlineData: { mimeType: "application/pdf", data: "JVBERi0=" } }] });
    expect(fromGeminiContent(c!, 1)).toEqual(m);
  });

  it("drops parts it doesn't model, keeping only their signature", () => {
    const m = fromGeminiContent({ role: "model", parts: [{ executableCode: { code: "1+1" } }, { executableCode: { code: "2" }, thoughtSignature: "s" }, { text: "ok" }] }, 1);
    expect(m.parts).toEqual([{ type: "text", text: "", meta: { gemini: { thoughtSignature: "s" } } }, { type: "text", text: "ok" }]);
  });
});

describe("GeminiProvider request", () => {
  it("maps toolChoice 'none' to toolConfig mode NONE, json to a JSON mime type, and tools to declarations", async () => {
    const { provider, bodies } = fakeGemini([{ text: "{}" }], [{ text: "ok" }]);
    const decl = { name: "t", description: "d", parameters: { type: "object" } };
    await provider.generate({ system: "sys", messages: [userText("hi")], tools: [decl], toolChoice: "none", json: true });
    await provider.generate({ system: "sys", messages: [userText("hi")], tools: [] });
    expect(bodies[0]).toMatchObject({
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ functionDeclarations: [decl] }],
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
      generationConfig: { responseMimeType: "application/json" },
    });
    expect(bodies[1]).not.toHaveProperty("toolConfig");
    expect(bodies[1]).not.toHaveProperty("tools");
  });

  it("gives id-less calls in different replies different ids", async () => {
    const { provider } = fakeGemini([{ functionCall: { name: "t" } }], [{ functionCall: { name: "t" } }]);
    const a = await provider.generate({ system: "", messages: [userText("x")], tools: [] });
    const b = await provider.generate({ system: "", messages: [userText("x")], tools: [] });
    const [ia, ib] = [toolCallsOf(a)[0]!.id, toolCallsOf(b)[0]!.id];
    expect(isSyntheticCallId(ia) && isSyntheticCallId(ib)).toBe(true);
    expect(ia).not.toBe(ib);
  });
});

describe("GeminiProvider + runAgent end to end", () => {
  it("echoes the call with its thought signature and the matching response on the next request", async () => {
    const { provider, bodies } = fakeGemini(
      [{ functionCall: { name: "get_due", args: { days: 3 } }, thoughtSignature: "sig-1" }],
      [{ text: "You have 1 thing due." }, { text: "", thoughtSignature: "sig-final" }],
    );
    const tool: Tool = { name: "get_due", description: "d", parameters: { type: "object" }, effect: "read", run: async () => [{ title: "Case" }] };
    const res = await runAgent({ model: provider, system: "sys", history: [], user: [{ type: "text", text: "what's due?" }], tools: [tool] });
    expect(res.text).toBe("You have 1 thing due.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.contents).toEqual([
      { role: "user", parts: [{ text: "what's due?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_due", args: { days: 3 } }, thoughtSignature: "sig-1" }] },
      { role: "user", parts: [{ functionResponse: { name: "get_due", response: { result: [{ title: "Case" }] } } }] },
    ]);
    // The final turn keeps its trailing signature-only part, so it survives into stored history.
    expect(res.turns[res.turns.length - 1]!.parts[1]).toEqual({ type: "text", text: "", meta: { gemini: { thoughtSignature: "sig-final" } } });
  });

  it("keeps a real call id on both the call and its response", async () => {
    const { provider, bodies } = fakeGemini([{ functionCall: { name: "get_due", args: {}, id: "fc-7" }, thoughtSignature: "sig-1" }], [{ text: "Done." }]);
    const tool: Tool = { name: "get_due", description: "d", parameters: { type: "object" }, effect: "read", run: async () => 1 };
    await runAgent({ model: provider, system: "", history: [], user: [{ type: "text", text: "x" }], tools: [tool] });
    expect(bodies[1]!.contents[1]!.parts[0]).toEqual({ functionCall: { name: "get_due", args: {}, id: "fc-7" }, thoughtSignature: "sig-1" });
    expect(bodies[1]!.contents[2]!.parts[0]).toEqual({ functionResponse: { name: "get_due", response: { result: 1 }, id: "fc-7" } });
  });
});
