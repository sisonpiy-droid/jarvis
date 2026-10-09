import { describe, expect, it, vi } from "vitest";
import type { Sql } from "@jarvis/db";
import { runAgent, type Tool } from "../src/agent";
import { handleUpdate, type BotDeps } from "../src/bot";
import { GeminiProvider } from "../src/gemini";
import { markdownToChatHtml } from "../src/markdown";
import { markdownToTelegramHtml, splitForTelegram } from "../src/telegram-format";
import { istRange, jarvisTools } from "../src/tools";
import { call, calls, say, scripted, text } from "./scripted";

const tool = (name: string, run: Tool["run"]): Tool => ({ name, description: name, parameters: { type: "object", properties: {} }, effect: "read", run });

describe("runAgent", () => {
  it("runs tools the model asks for, feeds results back under the call's id, and returns the final text", async () => {
    const { model, requests } = scripted(calls(call("get_due", { days: 3 }, "c-1")), say("You have 1 thing due."));
    const run = vi.fn(async () => [{ title: "Case" }]);
    const res = await runAgent({ model, system: "sys", history: [], user: [text("what's due?")], tools: [tool("get_due", run)] });
    expect(run).toHaveBeenCalledWith({ days: 3 });
    expect(res.text).toBe("You have 1 thing due.");
    const second = requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(second[2]!.parts).toEqual([{ type: "tool_result", id: "c-1", name: "get_due", result: [{ title: "Case" }] }]);
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["get_due"]);
    expect(res.toolResults).toEqual([{ name: "get_due", ok: true, result: [{ title: "Case" }] }]);
    expect(res.turns.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("reports tool errors to the model instead of crashing", async () => {
    const { model, requests } = scripted(calls(call("boom", {}, "c-1"), call("nope", {}, "c-2")), say("Sorry, that failed."));
    const res = await runAgent({ model, system: "", history: [], user: [text("x")], tools: [tool("boom", async () => { throw new Error("db down"); })] });
    expect(requests[1]!.messages[2]!.parts).toEqual([
      { type: "tool_result", id: "c-1", name: "boom", error: "db down" },
      { type: "tool_result", id: "c-2", name: "nope", error: "unknown tool nope" },
    ]);
    expect(res.toolCalls).toEqual([{ name: "boom", ok: false }, { name: "nope", ok: false }]);
    expect(res.toolResults).toEqual([{ name: "boom", ok: false, error: "db down" }, { name: "nope", ok: false, error: "unknown tool nope" }]);
  });

  it("caps huge tool results and says so", async () => {
    const { model, requests } = scripted(calls(call("big")), say("ok"));
    await runAgent({ model, system: "", history: [], user: [text("x")], tools: [tool("big", async () => "x".repeat(40_000))] });
    const r = requests[1]!.messages[2]!.parts[0] as { result: { truncated: boolean; partial: string } };
    expect(r.result.truncated).toBe(true);
    expect(r.result.partial).toHaveLength(30_000);
  });

  it("stops after the step limit", async () => {
    const loop = calls(call("t"));
    const { model } = scripted(loop, loop, loop);
    const res = await runAgent({ model, system: "", history: [], user: [text("x")], tools: [tool("t", async () => 1)], maxSteps: 3 });
    expect(res.text).toMatch(/more steps/);
    expect(res.turns[res.turns.length - 1]!.role).toBe("tool");
  });

  it("ignores thinking parts in the final text", async () => {
    const { model } = scripted({ role: "assistant", parts: [{ type: "thinking", text: "thinking…" }, text("Answer.")] });
    expect((await runAgent({ model, system: "", history: [], user: [text("x")], tools: [] })).text).toBe("Answer.");
  });

  it("passes history first and toolChoice through", async () => {
    const { model, requests } = scripted(say("Hi again."));
    const history = [{ role: "user" as const, parts: [text("hi")] }, say("Hello.")];
    await runAgent({ model, system: "", history, user: [text("again")], tools: [], toolChoice: "none" });
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[0]!.toolChoice).toBe("none");
  });
});

describe("GeminiProvider", () => {
  it("sends the key in a header, never the URL, and returns a neutral assistant message", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] });
    }) as unknown as typeof fetch;
    const out = await new GeminiProvider("KEY123", "gemini-x", f).generate({ system: "s", messages: [], tools: [] });
    expect(out).toEqual({ role: "assistant", parts: [{ type: "text", text: "hi" }] });
    expect(seen!.url).not.toContain("KEY123");
    expect(new Headers(seen!.init.headers).get("x-goog-api-key")).toBe("KEY123");
  });
  it("surfaces API errors without echoing the key", async () => {
    const f = (async () => Response.json({ error: { message: "quota exceeded" } }, { status: 429 })) as unknown as typeof fetch;
    await expect(new GeminiProvider("KEY123", "m", f).generate({ system: "", messages: [], tools: [] })).rejects.toThrow(/429: quota exceeded/);
  });
});

describe("chat formatting", () => {
  it("is one converter for every surface (Telegram re-exports the chat one)", () => {
    expect(markdownToTelegramHtml).toBe(markdownToChatHtml);
    expect(markdownToChatHtml("<script>x</script> **ok**")).toBe("&lt;script&gt;x&lt;/script&gt; <b>ok</b>");
  });
  it("escapes HTML and converts common Markdown", () => {
    expect(markdownToTelegramHtml("**Due** <soon> & *today*\n- one\n- [LMS](https://x.y/a?b=1)")).toBe(
      '<b>Due</b> &lt;soon&gt; &amp; <i>today</i>\n• one\n• <a href="https://x.y/a?b=1">LMS</a>',
    );
  });
  it("doesn't double-bold headings and turns rules into a divider", () => {
    expect(markdownToTelegramHtml("## **Plan**\n---\nok")).toBe("<b>Plan</b>\n━━━━━━━━━━\nok");
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
  it("is declared write-local (never an external action; the calendar tool is the one named exception)", () => {
    expect(reminder.effect).toBe("write-local");
    // The one exception is adding an event to the owner's own calendar, only when they ask (calendar.test.ts).
    expect(jarvisTools(sql).filter((t) => t.effect !== "read" && t.effect !== "write-local").map((t) => t.name)).toEqual(["add_calendar_event"]);
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

describe("/revise", () => {
  const sql = vi.fn(async () => []) as unknown as Sql;
  it("explains the format when the instruction is missing", async () => {
    const { commandReply } = await import("../src/bot");
    const out = await commandReply({ sql, token: "", ownerChatId: "", model: null, requestRevision: async () => {} }, "/revise", "marketing");
    expect(out).toContain("/revise marketing | our startup is Snitch");
  });
  it("offers revise_assignment to the chat model only when revising is wired", () => {
    expect(jarvisTools(sql).some((t) => t.name === "revise_assignment")).toBe(false);
    const tool = jarvisTools(sql, () => new Date(), { requestRevision: async () => {} }).find((t) => t.name === "revise_assignment");
    expect(tool?.effect).toBe("write-local");
  });
});
