import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import type { Tool } from "../src/agent";
import { chatTranscript, fromStoredRows, loadHistory, resetConversation, sanitizeHistory, saveTurns, type StoredRow } from "../src/history";
import { chat } from "../src/jarvis";
import type { Message, Part } from "../src/model";
import { call, calls, say, scripted, text } from "./scripted";

// Chat history as neutral Messages. New rows are stored neutral (migration 0019); older Gemini-shaped rows are
// converted on read. These pin that both read back exactly, thought signatures included.

const row = (id: number, role: StoredRow["role"], parts: unknown, format: StoredRow["format"] = "gemini"): StoredRow => ({ id, role, parts, format, meta: null, created_at: "2026-10-01T03:30:00.000Z" });
const sig = (s: string) => ({ meta: { gemini: { thoughtSignature: s } } });
const user = (t: string): Message => ({ role: "user", parts: [text(t)] });

describe("fromStoredRows", () => {
  it("converts legacy Gemini rows, pairing id-less responses with their calls by name and order", () => {
    const out = fromStoredRows([
      row(1, "user", [{ text: "what's due and what's on?" }]),
      row(2, "model", [{ functionCall: { name: "get_due", args: { days: 3 } }, thoughtSignature: "sig-1" }, { functionCall: { name: "get_due", args: { days: 7 } } }, { functionCall: { name: "get_events" } }]),
      row(3, "tool", [
        { functionResponse: { name: "get_events", response: { result: [] } } },
        { functionResponse: { name: "get_due", response: { result: ["a"] } } },
        { functionResponse: { name: "get_due", response: { error: "boom" } } },
      ]),
      row(4, "model", [{ text: "Two things." }, { text: "", thoughtSignature: "sig-2" }]),
    ]);
    expect(out.map((x) => x.rowId)).toEqual([1, 2, 3, 4]);
    expect(out.map((x) => x.msg.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(out[1]!.msg.parts).toEqual([
      { type: "tool_call", id: "gx-2-0", name: "get_due", args: { days: 3 }, ...sig("sig-1") },
      { type: "tool_call", id: "gx-2-1", name: "get_due", args: { days: 7 } },
      { type: "tool_call", id: "gx-2-2", name: "get_events", args: {} },
    ]);
    expect(out[2]!.msg.parts).toEqual([
      { type: "tool_result", id: "gx-2-2", name: "get_events", result: [] },
      { type: "tool_result", id: "gx-2-0", name: "get_due", result: ["a"] },
      { type: "tool_result", id: "gx-2-1", name: "get_due", error: "boom" },
    ]);
    expect(out[3]!.msg.parts).toEqual([text("Two things."), { type: "text", text: "", ...sig("sig-2") }]);
  });

  it("keeps real ids, gives an unmatched response an id that matches nothing, and skips markers", () => {
    const out = fromStoredRows([
      row(1, "user", [{ text: "x" }]),
      row(2, "model", [{ functionCall: { name: "a", id: "fc-1" } }]),
      row(3, "tool", [{ functionResponse: { name: "a", response: { result: 1 }, id: "fc-1" } }, { functionResponse: { name: "zzz", response: { result: 2 } } }]),
      row(4, "marker", []),
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]!.msg.parts.map((p) => (p as { id: string }).id)).toEqual(["fc-1", "gx-3-o1"]);
  });

  it("reads neutral rows as they are, dropping unknown part types", () => {
    const out = fromStoredRows([
      row(1, "user", [{ type: "text", text: "hi" }, { type: "hologram" }], "neutral"),
      row(2, "model", [{ type: "text", text: "Hello.", meta: { gemini: { thoughtSignature: "s" } } }], "neutral"),
      row(3, "user", [{ text: "legacy row marked neutral by mistake" }], "neutral"),
    ]);
    expect(out.map((x) => x.msg)).toEqual([user("hi"), { role: "assistant", parts: [{ type: "text", text: "Hello.", ...sig("s") }] }, user("legacy row marked neutral by mistake")]);
  });
});

describe("sanitizeHistory", () => {
  const call = (id: string, name = "t"): Part => ({ type: "tool_call", id, name, args: {} });
  const result = (id: string, r: unknown = 1, name = "t"): Part => ({ type: "tool_result", id, name, result: r });
  const asst = (...parts: Part[]): Message => ({ role: "assistant", parts });
  const tool = (...parts: Part[]): Message => ({ role: "tool", parts });

  it("starts at the first user message with text", () => {
    expect(sanitizeHistory([tool(result("a")), say("x"), user("hi"), say("Hello.")])).toEqual([user("hi"), say("Hello.")]);
    expect(sanitizeHistory([say("x")])).toEqual([]);
  });

  it("drops a call without a matching result, a result without its call, and a partly answered turn", () => {
    const h = [
      user("one"), asst(call("a")), // dangling: no tool message follows
      user("two"), asst(call("b"), call("c")), tool(result("b")), // only one of two answered
      user("three"), tool(result("zz")), // orphaned result
      asst(call("d")), tool(result("d")), say("Done."),
    ];
    expect(sanitizeHistory(h)).toEqual([user("one"), user("two"), user("three"), asst(call("d")), tool(result("d")), say("Done.")]);
  });

  it("cuts large tool results before the newest exchange and leaves the newest intact", () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ i, title: "x".repeat(20) }));
    const out = sanitizeHistory([user("old"), asst(call("a")), tool(result("a", big)), say("ok"), user("new"), asst(call("b")), tool(result("b", big)), say("ok")]);
    const old = out[2]!.parts[0] as { result: { truncated: boolean; partial: string } };
    expect(old.result.truncated).toBe(true);
    expect(old.result.partial).toHaveLength(4_000);
    expect((out[6]!.parts[0] as { result: unknown }).result).toEqual(big);
  });
});

describe("loadHistory / saveTurns (PGlite)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => t?.close());
  beforeEach(async () => {
    await t.sql`truncate jarvis.chat_messages, jarvis.memories restart identity cascade`;
  });

  const turn: Message[] = [
    user("what's due?"),
    { role: "assistant", parts: [{ type: "thinking", text: "" }, { type: "tool_call", id: "gx-9abc-0", name: "get_due", args: { days: 3 }, ...sig("sig-1") }] },
    { role: "tool", parts: [{ type: "tool_result", id: "gx-9abc-0", name: "get_due", result: [{ title: "Case" }] }] },
    { role: "assistant", parts: [text("You have 1 thing due."), { type: "text", text: "", ...sig("sig-2") }] },
  ];

  /** A row as the code before migration 0019 wrote it: Gemini parts, no format (the column default 'gemini'). */
  const legacy = (role: string, parts: unknown[], channel = "web") =>
    t.sql`insert into jarvis.chat_messages (channel, role, parts) values (${channel}, ${role}, ${t.sql.json(parts as never)}) returning id`.then(([r]) => Number(r!.id));

  it("stores neutral rows (signatures and ids kept, empty thinking dropped), with meta on the final answer", async () => {
    const ids = await saveTurns(t.sql, "web", turn, { guard: { repaired: true, unverified: ["10-09"] } });
    expect(ids).toEqual([1, 2, 3, 4]);
    const rows = await t.sql`select channel, role, parts, format, meta from jarvis.chat_messages order by id`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { channel: "web", role: "user", parts: [text("what's due?")], format: "neutral", meta: null },
      { channel: "web", role: "model", parts: [turn[1]!.parts[1]], format: "neutral", meta: null },
      { channel: "web", role: "tool", parts: turn[2]!.parts, format: "neutral", meta: null },
      { channel: "web", role: "model", parts: turn[3]!.parts, format: "neutral", meta: { guard: { repaired: true, unverified: ["10-09"] } } },
    ]);
  });

  it("reads back what it wrote, per channel, exactly (ids, signatures)", async () => {
    await saveTurns(t.sql, "web", turn);
    await saveTurns(t.sql, "telegram", [user("other channel"), say("ok")]);
    expect(await loadHistory(t.sql, "web")).toEqual([turn[0], { role: "assistant", parts: [turn[1]!.parts[1]] }, turn[2], turn[3]]);
    expect(await loadHistory(t.sql, "telegram")).toEqual([user("other channel"), say("ok")]);
  });

  it("loads legacy Gemini rows and neutral rows together as alternating Messages, dropping a dangling call", async () => {
    await legacy("user", [{ text: "what's due and what's on?" }]);
    const callRow = await legacy("model", [{ functionCall: { name: "get_due", args: { days: 3 } }, thoughtSignature: "sig-1" }, { functionCall: { name: "get_events", args: {} } }]);
    await legacy("tool", [{ functionResponse: { name: "get_events", response: { result: [] } } }, { functionResponse: { name: "get_due", response: { result: ["a"] } } }]);
    await legacy("model", [{ text: "Two things." }, { text: "", thoughtSignature: "sig-2" }]);
    await legacy("user", [{ text: "and grades?" }]);
    await legacy("model", [{ functionCall: { name: "get_grades", args: {} } }]); // the response was never stored
    await saveTurns(t.sql, "web", [user("thanks"), say("Any time.")]);
    expect((await t.sql`select format from jarvis.chat_messages order by id`).map((r) => r.format)).toEqual([...Array(6).fill("gemini"), "neutral", "neutral"]);

    const h = await loadHistory(t.sql, "web");
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "user", "assistant"]);
    expect(h[1]!.parts).toEqual([
      { type: "tool_call", id: `gx-${callRow}-0`, name: "get_due", args: { days: 3 }, ...sig("sig-1") },
      { type: "tool_call", id: `gx-${callRow}-1`, name: "get_events", args: {} },
    ]);
    expect(h[2]!.parts).toEqual([
      { type: "tool_result", id: `gx-${callRow}-1`, name: "get_events", result: [] },
      { type: "tool_result", id: `gx-${callRow}-0`, name: "get_due", result: ["a"] },
    ]);
    expect(h[3]!.parts).toEqual([text("Two things."), { type: "text", text: "", ...sig("sig-2") }]);
    expect(h.slice(4)).toEqual([user("and grades?"), user("thanks"), say("Any time.")]);
  });

  it("starts the context after the latest marker; a second reset in a row adds nothing", async () => {
    await saveTurns(t.sql, "web", [user("old"), say("old answer")]);
    await resetConversation(t.sql, "web");
    expect(await loadHistory(t.sql, "web")).toEqual([]);
    await resetConversation(t.sql, "web");
    await saveTurns(t.sql, "web", [user("new"), say("new answer")]);
    await resetConversation(t.sql, "telegram"); // another channel's marker changes nothing here
    expect(await loadHistory(t.sql, "web")).toEqual([user("new"), say("new answer")]);
    const rows = await t.sql`select role, parts, format from jarvis.chat_messages where channel = 'web' order by id`;
    expect(rows.map((r) => r.role)).toEqual(["user", "model", "marker", "user", "model"]);
    expect({ ...rows[2] }).toEqual({ role: "marker", parts: [], format: "neutral" });
  });

  it("saves a turn atomically: a failing row leaves none of the turn behind", async () => {
    await saveTurns(t.sql, "web", [user("kept"), say("ok")]);
    const bad: Message = { role: "tool", parts: [{ type: "tool_result", id: "gx-a", name: "t", result: "nul \u0000 byte" }] }; // jsonb rejects \u0000
    await expect(saveTurns(t.sql, "web", [user("lost"), calls(call("t", {}, "gx-a")), bad])).rejects.toThrow();
    expect((await t.sql`select parts from jarvis.chat_messages order by id`).map((r) => r.parts)).toEqual([[text("kept")], [text("ok")]]);
    expect(await saveTurns(t.sql, "web", [{ role: "assistant", parts: [{ type: "thinking", text: "" }] }])).toEqual([]);
  });

  it("never interleaves two saves on separate connections", async () => {
    const [a, b] = [t.connect(), t.connect()];
    const exchange = (tag: string): Message[] => [user(`${tag} q`), calls(call("t", {}, `gx-${tag}`)), { role: "tool", parts: [{ type: "tool_result", id: `gx-${tag}`, name: "t", result: tag }] }, say(`${tag} a`)];
    const saved = await Promise.all(Array.from({ length: 6 }, (_, i) => saveTurns(i % 2 ? a : b, "web", exchange(`x${i}`))));
    for (const ids of saved) expect(ids).toEqual(Array.from({ length: 4 }, (_, k) => ids[0]! + k));
    const h = await loadHistory(t.sql, "web");
    expect(h).toHaveLength(24);
    expect(h.filter((m) => m.role === "user")).toHaveLength(6);
  });

  // PGlite serialises the connections above itself, so that test can't prove the lock. This one checks that every
  // insert (a turn's rows and a reset's marker) runs while the transaction holds the channel's advisory lock.
  it("writes only while holding the channel's advisory lock", async () => {
    const held: Array<{ channel: string; n: number }> = [];
    const spy = {
      begin: (cb: (tx: unknown) => Promise<unknown>) =>
        t.sql.begin((tx) =>
          cb(new Proxy(tx, {
            apply: async (target, self, args: [TemplateStringsArray, ...unknown[]]) => {
              if (args[0].join("").includes("insert into")) {
                const channel = String(args[1]);
                const [r] = await target`
                  select count(*)::int as n from pg_locks
                   where locktype = 'advisory' and granted and objsubid = 1
                     and ((classid::bigint << 32) | objid::bigint) = hashtext(${`chat:${channel}`})::bigint`;
                held.push({ channel, n: Number(r!.n) });
              }
              return Reflect.apply(target, self, args);
            },
          })),
        ),
    } as unknown as typeof t.sql;
    await saveTurns(spy, "web", [user("q"), say("a")]);
    await resetConversation(spy, "telegram");
    expect(held).toEqual([{ channel: "web", n: 1 }, { channel: "web", n: 1 }, { channel: "telegram", n: 1 }]);
    expect(await t.sql`select 1 from pg_locks where locktype = 'advisory'`).toHaveLength(0); // released at commit
  });

  describe("chatTranscript", () => {
    it("shows questions and final answers only, with the tools used and the guard flag", async () => {
      await saveTurns(t.sql, "web", [
        user("what's due?"),
        { role: "assistant", parts: [{ type: "thinking", text: "let me look", ...sig("s0") }, call("get_due", {}, "gx-1")] },
        { role: "tool", parts: [{ type: "tool_result", id: "gx-1", name: "get_due", result: [] }] },
        { role: "assistant", parts: [text("Checking the week too."), call("get_week", {}, "gx-2"), call("get_due", {}, "gx-3")] },
        { role: "tool", parts: [{ type: "tool_result", id: "gx-2", name: "get_week", result: [] }, { type: "tool_result", id: "gx-3", name: "get_due", result: [] }] },
        { role: "assistant", parts: [{ type: "thinking", text: "done" }, text("Nothing is due.")] },
      ], { guard: { repaired: false, unverified: ["#44"] } });
      await resetConversation(t.sql, "web");
      const [hiId] = await saveTurns(t.sql, "web", [user("hi"), say("Hello.")]);

      const { items, nextBefore, contextStartId } = await chatTranscript(t.sql, "web");
      expect(items.map(({ id, role, text, tools, guarded }) => ({ id, role, text, tools, guarded }))).toEqual([
        { id: 1, role: "user", text: "what's due?", tools: [], guarded: false },
        { id: 6, role: "jarvis", text: "Nothing is due.", tools: ["get_due", "get_week"], guarded: true },
        { id: 7, role: "marker", text: "", tools: [], guarded: false },
        { id: 8, role: "user", text: "hi", tools: [], guarded: false },
        { id: 9, role: "jarvis", text: "Hello.", tools: [], guarded: false },
      ]);
      expect(items[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(nextBefore).toBeNull();
      expect(contextStartId).toBe(hiId);
    });

    it("shows legacy Gemini rows too, and has no context start right after a reset", async () => {
      await legacy("user", [{ text: "old question" }]);
      await legacy("model", [{ functionCall: { name: "list_tasks", args: {} } }]);
      await legacy("tool", [{ functionResponse: { name: "list_tasks", response: { result: [] } } }]);
      await legacy("model", [{ text: "Old answer." }]);
      expect((await chatTranscript(t.sql, "web")).contextStartId).toBe(1);
      await resetConversation(t.sql, "web");
      const r = await chatTranscript(t.sql, "web");
      expect(r.items.map((i) => [i.role, i.text, i.tools])).toEqual([["user", "old question", []], ["jarvis", "Old answer.", ["list_tasks"]], ["marker", "", []]]);
      expect(r.contextStartId).toBeNull();
    });

    it("pages backwards at user boundaries, never splitting an exchange", async () => {
      for (let i = 0; i < 5; i++) {
        await saveTurns(t.sql, "web", [user(`q${i}`), calls(call("t", {}, `gx-${i}`)), { role: "tool", parts: [{ type: "tool_result", id: `gx-${i}`, name: "t", result: i }] }, say(`a${i}`)]);
      }
      const pages: string[][] = [];
      let before: number | undefined;
      for (let n = 0; n < 10; n++) {
        const p = await chatTranscript(t.sql, "web", { limit: 2, ...(before !== undefined ? { before } : {}) });
        pages.push(p.items.map((i) => i.text));
        expect(p.items[0]?.role).toBe("user");
        if (p.nextBefore === null) break;
        expect(p.nextBefore).toBe(p.items[0]!.id);
        before = p.nextBefore;
      }
      expect(pages).toEqual([["q4", "a4"], ["q3", "a3"], ["q2", "a2"], ["q1", "a1"], ["q0", "a0"]]);
    });

    it("cuts a page that has too many items at the first user message within the limit", async () => {
      for (let i = 0; i < 6; i++) await saveTurns(t.sql, "web", [user(`q${i}`), say(`a${i}`)]);
      const p = await chatTranscript(t.sql, "web", { limit: 3 });
      expect(p.items.map((i) => i.text)).toEqual(["q5", "a5"]);
      expect(p.nextBefore).toBe(p.items[0]!.id);
      const all = await chatTranscript(t.sql, "web", { limit: 12 });
      expect(all.items).toHaveLength(12);
      expect(all.nextBefore).toBeNull();
    });
  });

  it("reads only the last 24 rows, starting at a real user message", async () => {
    for (let i = 0; i < 15; i++) await saveTurns(t.sql, "web", [user(`q${i}`), say(`a${i}`)]);
    const h = await loadHistory(t.sql, "web");
    expect(h).toHaveLength(24);
    expect(h[0]).toEqual(user("q3"));
  });

  it("carries a thought signature through chat(), storage and the next turn", async () => {
    const { model, requests } = scripted(
      { role: "assistant", parts: [{ type: "tool_call", id: "gx-live-0", name: "get_due", args: { days: 3 }, ...sig("sig-1") }] },
      say("You have 1 thing due."),
      say("Still just the one."),
    );
    const getDue: Tool = { name: "get_due", description: "d", parameters: { type: "object" }, effect: "read", run: async () => [{ title: "Case" }] };
    const deps = { sql: t.sql, model, channel: "web" as const, tools: [getDue], now: () => new Date("2026-10-01T03:30:00.000Z") };
    expect((await chat(deps, "what's due?")).text).toBe("You have 1 thing due.");
    expect((await chat(deps, "anything else?")).text).toBe("Still just the one.");
    const third = requests[2]!.messages;
    expect(third.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    const [c] = third[1]!.parts as Array<Extract<Part, { type: "tool_call" }>>;
    expect(c).toMatchObject({ type: "tool_call", name: "get_due", ...sig("sig-1") });
    expect(third[2]!.parts[0]).toMatchObject({ type: "tool_result", id: c!.id, result: [{ title: "Case" }] });
  });

  it("records a fallback answer when the step limit cuts the turn short", async () => {
    const loop: Message = { role: "assistant", parts: [{ type: "tool_call", id: "gx-l-0", name: "t", args: {} }] };
    const { model } = scripted(loop, loop, loop, loop, loop, loop);
    const t1: Tool = { name: "t", description: "d", parameters: { type: "object" }, effect: "read", run: async () => 1 };
    const res = await chat({ sql: t.sql, model, channel: "web", tools: [t1] }, "loop");
    expect(res.text).toMatch(/more steps/);
    const rows = await t.sql`select role from jarvis.chat_messages order by id`;
    expect(rows.map((r) => r.role)).toEqual(["user", ...Array.from({ length: 6 }, () => ["model", "tool"]).flat(), "model"]);
  });
});
