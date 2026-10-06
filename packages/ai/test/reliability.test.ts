import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { extractOfficeText } from "@jarvis/files";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { runAgent, type Tool } from "../src/agent";
import { GeminiProvider } from "../src/gemini";
import { chat } from "../src/jarvis";
import { jarvisTools } from "../src/tools";
import { call, calls, say, scripted, text } from "./scripted";

// Chat knows the alerts it sent, can hand over a Word file, and doesn't dead-end on the step limit or one slow reply.

const NOW = new Date("2026-10-06T04:45:00.000Z"); // Tue 6 Oct, 10:15 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.notifications, jarvis.chat_messages restart identity cascade`;
});

describe("reliability", () => {
  it("puts the last day's sent alerts in the prompt, newest first", async () => {
    await t.sql`insert into jarvis.notifications (dedupe_key, priority, text, status, sent_at) values
      ('old', 'normal', 'Two days ago', 'sent', ${new Date(NOW.getTime() - 2 * 86_400_000)}),
      ('d1', 'high', '✍️ <b>Draft ready</b>: Quiz 2 Entrepreneurship 101', 'sent', ${new Date(NOW.getTime() - 5 * 60_000)}),
      ('q', 'normal', 'Not sent yet', 'queued', null)`;
    const { model, requests } = scripted(say("OK — I'll leave the Quiz 2 draft alone."));
    await chat({ sql: t.sql, model, channel: "telegram", tools: [], now: () => NOW }, "Leave it");
    const sys = requests[0]!.system;
    expect(sys).toContain("ALERTS YOU SENT THE OWNER");
    expect(sys).toContain("10:10 am: ✍️ Draft ready: Quiz 2 Entrepreneurship 101");
    expect(sys).not.toContain("Two days ago");
    expect(sys).not.toContain("Not sent yet");
  });

  it("make_document hands over a real Word file", async () => {
    const sent: Array<{ name: string; text: string }> = [];
    const tools = jarvisTools(t.sql, () => NOW, { sendFile: async (bytes, name) => (sent.push({ name, text: extractOfficeText(bytes, "docx") }), "sent") });
    const out = await tools.find((x) => x.name === "make_document")!.run({ title: "DDDM: formulas", markdown: "- `=SUMIFS(range, crit)` adds with conditions" });
    expect(out).toEqual({ sent: true, file: "DDDM formulas.docx", note: "sent" });
    expect(sent[0]!.text).toContain("SUMIFS");
    expect(jarvisTools(t.sql).some((x) => x.name === "make_document")).toBe(false); // only where a surface can deliver
  });

  it("answers from what it gathered when it runs out of steps", async () => {
    const tool: Tool = { name: "t", description: "", parameters: {}, effect: "read", run: async () => 1 };
    const { model, requests } = scripted(calls(call("t")), calls(call("t")), say("Here's what I found: 1."));
    const res = await runAgent({ model, system: "", history: [], user: [text("x")], tools: [tool], maxSteps: 2 });
    expect(res.text).toBe("Here's what I found: 1.");
    expect(requests[2]!.toolChoice).toBe("none");
  });

  it("retries Gemini once after a 503, not after a 400", async () => {
    let n = 0;
    const ok = { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] };
    const f = (async () => (++n === 1 ? new Response("{}", { status: 503 }) : Response.json(ok))) as unknown as typeof fetch;
    expect((await new GeminiProvider("K", "m", f).generate({ system: "", messages: [], tools: [] })).parts[0]).toMatchObject({ text: "hi" });
    expect(n).toBe(2);
    n = 0;
    const bad = (async () => (++n, new Response("{}", { status: 400 }))) as unknown as typeof fetch;
    await expect(new GeminiProvider("K", "m", bad).generate({ system: "", messages: [], tools: [] })).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});
