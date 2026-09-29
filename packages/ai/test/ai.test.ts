import { describe, expect, it, vi } from "vitest";
import type { Sql } from "@jarvis/db";
import { runAgent, type Tool } from "../src/agent";
import { handleUpdate, type BotDeps } from "../src/bot";
import type { Content, GenerateRequest, ModelProvider } from "../src/gemini";
import { GeminiProvider } from "../src/gemini";
import { markdownToTelegramHtml, splitForTelegram } from "../src/telegram-format";
import { istRange, jarvisTools } from "../src/tools";

/** A scripted model: returns the queued replies in order and records every request. */
function scripted(...replies: Content[]) {
  const requests: GenerateRequest[] = [];
  const model: ModelProvider = {
    async generate(req) {
      requests.push(structuredClone(req));
      const r = replies.shift();
      if (!r) throw new Error("no more scripted replies");
      return r;
    },
  };
  return { model, requests };
}

const tool = (name: string, run: Tool["run"]): Tool => ({ name, description: name, parameters: { type: "object", properties: {} }, effect: "read", run });

describe("runAgent", () => {
  it("runs tools the model asks for, feeds results back, and returns the final text", async () => {
    const { model, requests } = scripted(
      { role: "model", parts: [{ functionCall: { name: "get_due", args: { days: 3 } }, thoughtSignature: "sig-1" }] },
      { role: "model", parts: [{ text: "You have 1 thing due." }] },
    );
    const run = vi.fn(async () => [{ title: "Case" }]);
    const res = await runAgent({ model, system: "sys", history: [], user: [{ text: "what's due?" }], tools: [tool("get_due", run)] });
    expect(run).toHaveBeenCalledWith({ days: 3 });
    expect(res.text).toBe("You have 1 thing due.");
    // The second request carries the model's call verbatim (thought signature intact) and the tool result.
    const second = requests[1]!.contents;
    expect(second[1]!.parts[0]!.thoughtSignature).toBe("sig-1");
    expect(second[2]!.parts[0]!.functionResponse).toEqual({ name: "get_due", response: { result: [{ title: "Case" }] } });
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["get_due"]);
  });

  it("reports tool errors to the model instead of crashing", async () => {
    const { model, requests } = scripted(
      { role: "model", parts: [{ functionCall: { name: "boom" } }, { functionCall: { name: "nope" } }] },
      { role: "model", parts: [{ text: "Sorry, that failed." }] },
    );
    const res = await runAgent({ model, system: "", history: [], user: [{ text: "x" }], tools: [tool("boom", async () => { throw new Error("db down"); })] });
    const responses = requests[1]!.contents[2]!.parts.map((p) => p.functionResponse!.response);
    expect(responses).toEqual([{ error: "db down" }, { error: "unknown tool nope" }]);
    expect(res.toolCalls).toEqual([{ name: "boom", ok: false }, { name: "nope", ok: false }]);
  });

  it("stops after the step limit", async () => {
    const loop = { role: "model" as const, parts: [{ functionCall: { name: "t" } }] };
    const { model } = scripted(loop, loop, loop);
    const res = await runAgent({ model, system: "", history: [], user: [{ text: "x" }], tools: [tool("t", async () => 1)], maxSteps: 3 });
    expect(res.text).toMatch(/more steps/);
  });

  it("ignores thought parts in the final text", async () => {
    const { model } = scripted({ role: "model", parts: [{ text: "thinking…", thought: true }, { text: "Answer." }] });
    expect((await runAgent({ model, system: "", history: [], user: [{ text: "x" }], tools: [] })).text).toBe("Answer.");
  });
});

describe("GeminiProvider", () => {
  it("sends the key in a header, never the URL, and returns parts", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] });
    }) as unknown as typeof fetch;
    const out = await new GeminiProvider("KEY123", "gemini-x", f).generate({ system: "s", contents: [], tools: [] });
    expect(out.parts).toEqual([{ text: "hi" }]);
    expect(seen!.url).not.toContain("KEY123");
    expect(new Headers(seen!.init.headers).get("x-goog-api-key")).toBe("KEY123");
  });
  it("surfaces API errors without echoing the key", async () => {
    const f = (async () => Response.json({ error: { message: "quota exceeded" } }, { status: 429 })) as unknown as typeof fetch;
    await expect(new GeminiProvider("KEY123", "m", f).generate({ system: "", contents: [], tools: [] })).rejects.toThrow(/429: quota exceeded/);
  });
});

describe("telegram formatting", () => {
  it("escapes HTML and converts common Markdown", () => {
    expect(markdownToTelegramHtml("**Due** <soon> & *today*\n- one\n- [LMS](https://x.y/a?b=1)")).toBe(
      '<b>Due</b> &lt;soon&gt; &amp; <i>today</i>\n• one\n• <a href="https://x.y/a?b=1">LMS</a>',
    );
  });
  it("keeps code verbatim and escaped", () => {
    expect(markdownToTelegramHtml("run `npm run mesa:login` **now**")).toBe("run <code>npm run mesa:login</code> <b>now</b>");
  });
  it("splits long messages on line boundaries", () => {
    const parts = splitForTelegram(Array.from({ length: 100 }, () => "x".repeat(99)).join("\n"), 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n").length).toBe(100 * 99 + 99);
  });
});

describe("istRange", () => {
  const now = new Date("2026-09-29T20:00:00.000Z"); // 01:30 IST on 30 Sep
  it("resolves today/tomorrow in IST", () => {
    expect(istRange("today", 1, now)).toEqual({ from: "2026-09-29T18:30:00.000Z", to: "2026-09-30T18:30:00.000Z" });
    expect(istRange("tomorrow", 1, now).from).toBe("2026-09-30T18:30:00.000Z");
    expect(istRange("2026-10-05", 2, now)).toEqual({ from: "2026-10-04T18:30:00.000Z", to: "2026-10-06T18:30:00.000Z" });
  });
});

describe("create_reminder guards", () => {
  const sql = vi.fn(async () => []) as unknown as Sql;
  const reminder = jarvisTools(sql, () => new Date("2026-09-29T10:00:00.000Z")).find((t) => t.name === "create_reminder")!;
  it("rejects past, unparseable and far-future times", async () => {
    await expect(reminder.run({ text: "x", at: "2026-09-29T09:00:00Z" })).rejects.toThrow(/past/);
    await expect(reminder.run({ text: "x", at: "tonight" })).rejects.toThrow(/ISO/);
    await expect(reminder.run({ text: "x", at: "2028-01-01T00:00:00Z" })).rejects.toThrow(/year/);
  });
  it("is declared write-local (never an external action)", () => {
    expect(reminder.effect).toBe("write-local");
    expect(jarvisTools(sql).every((t) => t.effect === "read" || t.effect === "write-local")).toBe(true);
  });
});

describe("handleUpdate", () => {
  const deps = (seenIds = new Set<number>()) => {
    const sent: Array<Record<string, unknown>> = [];
    const f = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/sendMessage")) sent.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    // Fake tagged-template SQL: only the telegram_updates insert is exercised here.
    const sql = (async (_s: TemplateStringsArray, id: number) => (seenIds.has(id) ? [] : (seenIds.add(id), [{ update_id: id }]))) as unknown as Sql;
    const d: BotDeps = { sql, token: "T", ownerChatId: "42", model: null, fetch: f };
    return { d, sent };
  };
  it("ignores anyone who isn't the owner", async () => {
    const { d, sent } = deps();
    await handleUpdate(d, { update_id: 1, message: { message_id: 1, chat: { id: 999 }, text: "/help" } });
    expect(sent).toHaveLength(0);
  });
  it("answers the owner, and handles each update exactly once", async () => {
    const { d, sent } = deps();
    const u = { update_id: 7, message: { message_id: 1, chat: { id: 42 }, text: "/help" } };
    await handleUpdate(d, u);
    await handleUpdate(d, u); // Telegram retry
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat_id).toBe("42");
    expect(String(sent[0]!.text)).toContain("JARVIS");
  });
  it("explains when chat has no AI key yet", async () => {
    const { d, sent } = deps();
    await handleUpdate(d, { update_id: 8, message: { message_id: 1, chat: { id: 42 }, text: "what's due?" } });
    expect(String(sent[0]!.text)).toContain("isn't switched on yet");
  });
});
