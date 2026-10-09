import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { costSummary, estimateUsd, logLlmCall } from "@jarvis/db";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { costsReply } from "../src/bot";
import { GeminiProvider, meterTo } from "../src/gemini";
import { chat } from "../src/jarvis";
import { jarvisTools } from "../src/tools";

// The cost log: every LLM call is recorded (task, tokens, time); /costs and the web page summarise it.

const NOW = new Date("2026-10-06T08:00:00.000Z"); // Tue 6 Oct, 13:30 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.llm_calls, jarvis.chat_messages, jarvis.notifications restart identity cascade`;
});

const reply = (usage: Record<string, number> | null) =>
  (async () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }], ...(usage ? { usageMetadata: usage } : {}) })) as unknown as typeof fetch;
const row = (task: string, i: number, o: number, at: string) => t.sql`insert into jarvis.llm_calls (task, model, input_tokens, output_tokens, at) values (${task}, 'm', ${i}, ${o}, ${at})`;

describe("cost log", () => {
  it("logs each successful call with its task; thinking tokens count as output; a failing meter or HTTP error logs nothing wrong", async () => {
    const seen: unknown[] = [];
    const p = new GeminiProvider("K", "gem-x", reply({ promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 }), 5000, (u) => void seen.push(u));
    await p.generate({ system: "", messages: [], tools: [], task: "brief_note" });
    expect(seen).toEqual([{ task: "brief_note", model: "gem-x", inputTokens: 1000, outputTokens: 500 }]);
    // No task → "other"; a meter that throws never fails the call.
    const boom = new GeminiProvider("K", "m", reply({ promptTokenCount: 1 }), 5000, () => Promise.reject(new Error("db down")));
    expect((await boom.generate({ system: "", messages: [], tools: [] })).parts[0]).toMatchObject({ text: "hi" });
    // A failed call (HTTP 400) is not logged.
    const bad = new GeminiProvider("K", "m", (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch, 5000, (u) => void seen.push(u));
    await expect(bad.generate({ system: "", messages: [], tools: [] })).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("a chat turn lands in the log as 'chat', with the tokens Gemini reported", async () => {
    const model = new GeminiProvider("K", "gem-x", reply({ promptTokenCount: 4000, candidatesTokenCount: 100 }), 5000, meterTo(t.sql));
    await chat({ sql: t.sql, model, channel: "web", tools: [], now: () => NOW, situation: false }, "hello");
    expect(await t.sql`select task, model, input_tokens, output_tokens from jarvis.llm_calls`).toMatchObject([{ task: "chat", model: "gem-x", input_tokens: 4000, output_tokens: 100 }]);
  });

  it("summarises today (IST), the week and the most expensive task", async () => {
    await row("chat", 100_000, 10_000, "2026-10-06T05:00:00Z"); // today 10:30 IST
    await row("chat", 50_000, 5_000, "2026-10-05T20:00:00Z"); // 01:30 IST today
    await row("brief_note", 20_000, 1_000, "2026-10-06T03:00:00Z"); // today
    await row("deliverable", 400_000, 60_000, "2026-10-03T08:00:00Z"); // this week, not today
    await row("learning", 5_000, 500, "2026-09-20T08:00:00Z"); // older than a week
    const s = await costSummary(t.sql, NOW);
    expect(s.today.calls).toBe(3);
    expect(s.today.byTask.map((x) => x.task)).toEqual(["chat", "brief_note"]);
    expect(s.today.usd).toBeCloseTo(estimateUsd(170_000, 16_000), 6);
    expect(s.week.calls).toBe(4);
    expect(s.all.calls).toBe(5);
    expect(s.topTask?.task).toBe("deliverable");

    const text = await costsReply(t.sql, NOW);
    expect(text).toContain("<b>Today</b>: $0.09");
    expect(text).toContain("• chat — $0.08 · 2 calls · 165k tokens");
    expect(text).toContain("Most expensive task: <b>deliverable</b>");
  });

  it("is empty-safe, and chat can answer 'what did I spend?' from get_costs", async () => {
    expect(await costsReply(t.sql, NOW)).toContain("No AI calls logged yet");
    await logLlmCall(t.sql, { task: "chat", model: "m", inputTokens: 1000, outputTokens: 100 });
    const r = (await jarvisTools(t.sql, () => new Date()).find((x) => x.name === "get_costs")!.run({})) as { all_time: { calls: number }; most_expensive_task: { task: string } };
    expect([r.all_time.calls, r.most_expensive_task.task]).toEqual([1, "chat"]);
  });
});
