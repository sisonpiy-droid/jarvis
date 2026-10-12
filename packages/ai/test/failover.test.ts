import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { chat } from "../src/jarvis";
import { meterTo } from "../src/gemini";
import { FallbackProvider, modelFromEnv } from "../src/model-chain";
import type { GenerateRequest, Message, ModelProvider } from "../src/model";
import { OpenRouterProvider, toOpenAiMessages } from "../src/openrouter";
import { call, say } from "./scripted";

// "Make sure the website never stops": Gemini first, OpenRouter behind it.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.chat_messages, jarvis.llm_calls restart identity cascade`;
});

const REQ: GenerateRequest = { system: "s", messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [] };
const provider = (name: string, impl: () => Promise<Message>) => {
  const p = { name, calls: 0, async generate() { p.calls++; return impl(); } };
  return p as ModelProvider & { calls: number };
};

describe("FallbackProvider", () => {
  it("uses the first provider while it works, and skips a dead one for a few minutes instead of waiting on it every time", async () => {
    let clock = 1_000;
    const gemini = provider("gemini", async () => { throw new Error("Gemini HTTP 401: API key not valid"); });
    const router = provider("openrouter", async () => say("from the backup"));
    const chain = new FallbackProvider([gemini, router], 5 * 60_000, () => clock, new Map());
    expect((await chain.generate(REQ)).parts[0]).toMatchObject({ text: "from the backup" });
    expect([gemini.calls, router.calls]).toEqual([1, 1]);
    await chain.generate(REQ);
    expect([gemini.calls, router.calls]).toEqual([1, 2]); // Gemini skipped: it is in its cooldown
    clock += 6 * 60_000;
    await chain.generate(REQ);
    expect([gemini.calls, router.calls]).toEqual([2, 3]); // tried again after the cooldown
  });

  it("a healthy first provider never touches the backup; a bad request falls through without a cooldown", async () => {
    const ok = provider("gemini", async () => say("primary"));
    const backup = provider("openrouter", async () => say("backup"));
    expect((await new FallbackProvider([ok, backup], 1000, Date.now, new Map()).generate(REQ)).parts[0]).toMatchObject({ text: "primary" });
    expect(backup.calls).toBe(0);

    const picky = provider("gemini", async () => { throw new Error("Gemini HTTP 400: invalid argument"); });
    const chain = new FallbackProvider([picky, backup], 60_000, Date.now, new Map());
    await chain.generate(REQ);
    await chain.generate(REQ);
    expect(picky.calls).toBe(2); // a 400 is the request's fault, not an outage: no cooldown
  });

  it("when everything fails it throws the last error, and still tries providers in cooldown before giving up", async () => {
    const a = provider("gemini", async () => { throw new Error("Gemini HTTP 429: quota"); });
    const b = provider("openrouter", async () => { throw new Error("OpenRouter HTTP 503: busy"); });
    const chain = new FallbackProvider([a, b], 60_000, Date.now, new Map());
    await expect(chain.generate(REQ)).rejects.toThrow(/OpenRouter HTTP 503/);
    await expect(chain.generate(REQ)).rejects.toThrow(/OpenRouter HTTP 503/);
    expect([a.calls, b.calls]).toEqual([2, 2]);
  });

  it("modelFromEnv builds whatever the keys allow", () => {
    const env = (o: Record<string, string>) => (k: string) => o[k];
    expect(modelFromEnv(env({}))).toBeNull();
    expect(modelFromEnv(env({ GEMINI_API_KEY: "g" }))!.name).toBe("gemini");
    expect(modelFromEnv(env({ OPENROUTER_API_KEY: "o" }))!.name).toBe("openrouter");
    expect(modelFromEnv(env({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o" }))!.name).toBe("gemini→openrouter");
  });
});

describe("OpenRouter adapter", () => {
  it("maps tool calls and results both ways, pairing results that lost their ids", () => {
    const msgs = toOpenAiMessages("SYS", [
      { role: "user", parts: [{ type: "text", text: "what's due?" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "hmm" }, { type: "tool_call", id: "gx-1", name: "get_week", args: { days: 5 } }, { type: "tool_call", id: "gx-2", name: "get_status", args: {} }] },
      { role: "tool", parts: [{ type: "tool_result", id: "gx-1", name: "get_week", result: { n: 2 } }, { type: "tool_result", id: "", name: "get_status", error: "boom" }] },
      { role: "assistant", parts: [{ type: "text", text: "Two things." }] },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "assistant"]);
    expect(msgs[2]!.tool_calls!.map((c) => [c.id, c.function.name, c.function.arguments])).toEqual([["gx-1", "get_week", '{"days":5}'], ["gx-2", "get_status", "{}"]]);
    expect(msgs[3]).toMatchObject({ tool_call_id: "gx-1", content: '{"result":{"n":2}}' });
    expect(msgs[4]).toMatchObject({ tool_call_id: "gx-2", content: '{"error":"boom"}' }); // paired by order
    expect(msgs[5]).toMatchObject({ content: "Two things." });
  });

  it("reads tool calls out of the reply, meters tokens as openrouter:<model>, and refuses audio and PDFs", async () => {
    const seen: unknown[] = [];
    let body: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    const f = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "get_week", arguments: '{"days":3}' } }] } }], usage: { prompt_tokens: 120, completion_tokens: 30 } });
    }) as unknown as typeof fetch;
    const p = new OpenRouterProvider("K", "google/gemini-2.5-flash", f, 5000, (u) => void seen.push(u));
    const r = await p.generate({ ...REQ, tools: [{ name: "get_week", description: "d", parameters: { type: "object", properties: {} } }], json: false, task: "chat" });
    expect(r.parts).toEqual([{ type: "tool_call", id: "call_9", name: "get_week", args: { days: 3 } }]);
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "get_week" } });
    expect(seen).toEqual([{ task: "chat", model: "openrouter:google/gemini-2.5-flash", inputTokens: 120, outputTokens: 30 }]);
    await expect(p.generate({ ...REQ, messages: [{ role: "user", parts: [{ type: "file", mimeType: "audio/wav", data: "AAAA" }] }] })).rejects.toThrow(/can't read audio/);
    const bad = new OpenRouterProvider("K", "m", (async () => new Response('{"error":{"message":"No auth"}}', { status: 401 })) as unknown as typeof fetch);
    await expect(bad.generate(REQ)).rejects.toThrow(/OpenRouter HTTP 401: No auth/);
  });
});

describe("a chat turn with Gemini's key rejected", () => {
  it("still answers — through OpenRouter, tool call included — and the cost log says which model did it", async () => {
    const replies: unknown[] = [
      { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_status", arguments: "{}" } }] } }], usage: { prompt_tokens: 500, completion_tokens: 20 } },
      { choices: [{ message: { content: "JARVIS is healthy." } }], usage: { prompt_tokens: 700, completion_tokens: 10 } },
    ];
    const f = (async (url: string) => (String(url).includes("generativelanguage") ? new Response('{"error":{"message":"API key not valid"}}', { status: 400 }) : Response.json(replies.shift()))) as unknown as typeof fetch;
    // 400 from Gemini is not an "outage", but the chain still moves on; use a real outage code too:
    const f401 = (async (url: string, init?: RequestInit) => (String(url).includes("generativelanguage") ? new Response('{"error":{"message":"bad key"}}', { status: 401 }) : f(url, init as never))) as unknown as typeof fetch;
    const model = modelFromEnv((k) => ({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o" })[k], { fetch: f401, meter: meterTo(t.sql) })!;
    const res = await chat({ sql: t.sql, model, channel: "web", situation: false }, "how is JARVIS doing?");
    expect(res.text).toBe("JARVIS is healthy.");
    expect(res.toolCalls.map((c) => c.name)).toEqual(["get_status"]);
    const log = await t.sql`select task, model from jarvis.llm_calls order by id`;
    expect(log.map((r) => r.model)).toEqual(["openrouter:google/gemini-2.5-flash", "openrouter:google/gemini-2.5-flash"]);
    void call; // (scripted helpers unused here)
  });
});
