import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listEmailDrafts, mailtoLink } from "@jarvis/db";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { chat } from "../src/jarvis";
import { memoryTools } from "../src/memory";
import { jarvisTools } from "../src/tools";
import { call, calls, say, scripted } from "./scripted";

// "It drafts any email I need to send, shows it to me, and waits. It never sends anything on its own. Not once."

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.email_drafts, jarvis.chat_messages restart identity cascade`;
});

const NOW = new Date("2026-10-06T08:00:00.000Z");
const draft = { to: "menon@mesa.example", subject: "Viva slot", body: "Dear Prof. Menon,\n\nCould I book a viva slot on Friday?\n\nThanks,\nPiyush" };

describe("email drafts", () => {
  it("drafts, shows the whole draft in the reply, saves it and waits — nothing is sent", async () => {
    const net = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", net);
    try {
      const { model, requests } = scripted(calls(call("draft_email", draft)), say("Here's the draft — To: menon@mesa.example\nSubject: Viva slot\n\nDear Prof. Menon, … Want any changes? I haven't sent it."));
      const res = await chat({ sql: t.sql, model, channel: "telegram", now: () => NOW, situation: false }, "email Prof Menon asking for a viva slot on Friday");
      expect(res.text).toContain("I haven't sent it");
      expect(requests[0]!.system).toContain("you cannot send, reply to or forward email");
      const open = await listEmailDrafts(t.sql);
      expect(open).toMatchObject([{ id: 1, to: "menon@mesa.example", subject: "Viva slot", status: "draft" }]);
      // The tool result tells the model it is only a draft.
      const result = JSON.stringify(requests[1]!.messages.at(-1));
      expect(result).toContain("JARVIS cannot send email");
      expect(net).not.toHaveBeenCalled(); // no network call of any kind
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("revises, then the owner closes it as sent; closed drafts can't be edited", async () => {
    const tools = jarvisTools(t.sql, () => NOW);
    const run = (name: string, a: Record<string, unknown>) => tools.find((x) => x.name === name)!.run(a) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    await run("draft_email", draft);
    const r = await run("revise_email_draft", { id: 1, body: "Dear Prof. Menon,\n\nIs Thursday possible instead?\n\nPiyush", to: "" });
    expect(r.draft).toMatchObject({ id: 1, to: null, subject: "Viva slot" });
    expect(r.draft.body).toContain("Thursday");
    expect((await run("list_email_drafts", {})).drafts).toHaveLength(1);
    expect(await run("close_email_draft", { id: 1, status: "sent" })).toEqual({ closed: true, status: "sent" });
    expect(await run("revise_email_draft", { id: 1, body: "x" })).toMatchObject({ updated: false });
    expect((await run("list_email_drafts", {})).drafts).toHaveLength(0);
    await expect(run("draft_email", { subject: "", body: "" })).rejects.toThrow(/subject and a body/);
  });

  it("opens in the owner's own mail app", () => {
    expect(mailtoLink({ to: "a@b.co", subject: "Hi there", body: "Line 1\nLine 2" })).toBe("mailto:a@b.co?subject=Hi%20there&body=Line%201%0ALine%202");
  });

  it("no tool anywhere can send, reply to, forward or submit", () => {
    const all = [...jarvisTools(t.sql, () => NOW, { requestDraft: async () => {}, requestRevision: async () => {}, sendFile: async () => "ok" }), ...memoryTools(t.sql, () => NOW)];
    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((x) => /send|reply|forward|submit|post_|publish/i.test(x.name)).map((x) => x.name)).toEqual([]);
    // The only effect that leaves JARVIS: adding an event to the owner's own calendar, on request.
    expect(all.filter((x) => x.effect !== "read" && x.effect !== "write-local").map((x) => x.name)).toEqual(["add_calendar_event"]);
  });
});
