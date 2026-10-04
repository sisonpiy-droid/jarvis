import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTask } from "@jarvis/db";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { chat } from "../src/jarvis";
import { listMemories } from "../src/memory";
import { learnFromMessages, ownerMessagesBetween } from "../src/reflect";
import { saveTurns } from "../src/history";
import { say, scripted } from "./scripted";

// Chief of staff: chat sees the live situation (and may quote it), and the nightly pass learns lasting facts.

const NOW = new Date("2026-10-03T10:30:00.000Z"); // Sat 3 Oct, 16:00 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.tasks, jarvis.memories, jarvis.chat_messages restart identity cascade`;
});

describe("chat with the live situation", () => {
  it("puts the situation and the chief-of-staff stance in the prompt, and counts it as evidence", async () => {
    const task = await createTask(t.sql, { title: "Finish the Spinny deck", due: "2026-10-03T21:00:00+05:30", priority: 1 });
    const { model, requests } = scripted(say(`Do the Spinny deck now — it's due today 9:00 pm [task #${task.id}]. Leave the gym for tomorrow.`));
    const res = await chat({ sql: t.sql, model, channel: "web", tools: [], now: () => NOW }, "what should I do now?");
    expect(requests[0]!.system).toContain("Be a chief of staff, not a search box");
    expect(requests[0]!.system).toContain("LIVE SITUATION");
    expect(requests[0]!.system).toContain(`Finish the Spinny deck [task #${task.id}]`);
    // No tool was called, yet the date and id pass the grounding guard: they're in the situation.
    expect(res.guard).toEqual({ ok: true, repaired: false, unverified: [] });
    expect(res.text).not.toContain("Not found in your data");
  });

  it("can be switched off", async () => {
    const { model, requests } = scripted(say("Hi."));
    await chat({ sql: t.sql, model, channel: "web", tools: [], now: () => NOW, situation: false }, "hi");
    expect(requests[0]!.system).not.toContain("LIVE SITUATION");
  });
});

describe("learning from the day's chats", () => {
  it("keeps lasting facts, refuses dated ones and duplicates, and marks them learned", async () => {
    await saveTurns(t.sql, "web", [{ role: "user", parts: [{ type: "text", text: "I work best late at night, keep answers short. Rahul is on my Spinny team." }] }, say("Noted.")]);
    const msgs = await ownerMessagesBetween(t.sql, "2026-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    expect(msgs).toEqual(["I work best late at night, keep answers short. Rahul is on my Spinny team."]);
    const { model, requests } = scripted(
      say(
        JSON.stringify({
          memories: [
            { content: "Works best late at night", kind: "preference", scope: "global", person: null },
            { content: "Prefers short answers", kind: "preference", scope: "global", person: null },
            { content: "Rahul is on the Spinny case team", kind: "person", scope: "person", person: "Rahul" },
            { content: "Spinny deck is due on Friday", kind: "fact", scope: "global", person: null },
            { content: "Prefers short answers", kind: "preference", scope: "global", person: null },
          ],
        }),
      ),
    );
    const r = await learnFromMessages(t.sql, model, msgs);
    expect(r.saved.map((s) => s.content)).toEqual(["Works best late at night", "Prefers short answers", "Rahul is on the Spinny case team"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["that's dated — store it as a task or goal (create_task / create_goal), not a memory", "already remembered"]);
    expect(requests[0]!.messages[0]!.parts[0]).toMatchObject({ type: "text" });
    const mems = await listMemories(t.sql);
    expect(mems.every((m) => m.learned)).toBe(true);
    expect(mems.find((m) => m.content.startsWith("Rahul"))).toMatchObject({ scope: "person", subjectId: "rahul" });
  });

  it("makes no call without messages, and survives a bad reply", async () => {
    const none = scripted();
    expect((await learnFromMessages(t.sql, none.model, [])).proposed).toBe(0);
    expect((await learnFromMessages(t.sql, scripted(say("not json")).model, ["hello"])).saved).toEqual([]);
  });
});
