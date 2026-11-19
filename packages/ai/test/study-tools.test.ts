import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { extractOfficeText } from "@jarvis/files";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { handleUpdate } from "../src/bot";
import { jarvisTools } from "../src/tools";
import { call, calls, say, scripted } from "./scripted";

// "/notes <course>": the saved study notes as one Word file, on demand — Telegram and chat alike.

const NOW = new Date("2026-10-29T05:00:00.000Z");
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.session_notes, jarvis.chat_messages, jarvis.telegram_updates restart identity cascade`;
  const src = (courseId: string, course: string, session: number) => ({ courseId, course, session, files: [], sourceKey: `k${courseId}${session}` });
  await db.saveSessionNotes(t.sql, src("c1", "Data Driven Decision Making with Prof. Vinay Sharma", 9), { concepts: ["Cohort retention groups customers by signup month (Pre-Read 9.pdf, page 2)."], formulas: ["CAC = spend / new customers (Pre-Read 9.pdf, page 3)."], terms: [], questions: ["How is CAC worked out?"] }, "m");
  await db.saveSessionNotes(t.sql, src("c1", "Data Driven Decision Making with Prof. Vinay Sharma", 7), { concepts: ["Contribution margin is price less variable cost (Deck 7.pptx, slide 2)."], formulas: [], terms: [], questions: [] }, "m");
  await db.saveSessionNotes(t.sql, src("c2", "Fundamentals of Finance with Prof. Narahari", 3), { concepts: ["DuPont splits ROE into margin, turnover and leverage (Deck 3.pptx, slide 4)."], formulas: [], terms: [], questions: [] }, "m");
});

const run = (course: string) => {
  const sent: Array<{ name: string; text: string; mime?: string }> = [];
  const tools = jarvisTools(t.sql, () => NOW, { sendFile: async (bytes, name, _c, mime) => (sent.push({ name, text: extractOfficeText(bytes, "docx"), ...(mime ? { mime } : {}) }), "Sent in this chat as a file.") });
  return { sent, result: tools.find((x) => x.name === "get_revision_notes")!.run({ course }) as Promise<Record<string, any>> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe("get_revision_notes", () => {
  it("sends one course's notes as a Word file, sessions in order, with citations", async () => {
    const { sent, result } = run("data driven");
    expect(await result).toMatchObject({ sent: true, file: "Data Driven Decision Making - revision notes.docx", sessions: 2 });
    expect(sent[0]!.mime).toContain("wordprocessingml");
    expect(sent[0]!.text).toContain("Data Driven Decision Making — revision pack");
    expect(sent[0]!.text).toContain("General revision.");
    expect(sent[0]!.text.indexOf("Session 7")).toBeLessThan(sent[0]!.text.indexOf("Session 9"));
    expect(sent[0]!.text).toContain("CAC = spend / new customers (Pre-Read 9.pdf, page 3).");
    expect(sent[0]!.text).toContain("Test yourself");
  });

  it("says which courses have notes when the name is missing, matches nothing or several", async () => {
    const none = run("quantum physics");
    expect(await none.result).toMatchObject({ sent: false, reason: expect.stringContaining("no notes for that course") });
    expect(none.sent).toHaveLength(0);
    const blank = await run("").result;
    expect(blank.reason).toBe("which course?");
    expect(blank.courses.map((c: { course: string }) => c.course)).toEqual(["Data Driven Decision Making", "Fundamentals of Finance"]);
    expect(await run("of").result).toMatchObject({ sent: false, reason: expect.stringContaining("several") }); // "of" is in both course titles ("Prof." and "Fundamentals of")
  });

  it("is only offered where a file can be delivered", () => {
    expect(jarvisTools(t.sql).some((x) => x.name === "get_revision_notes")).toBe(false);
  });
});

describe("Telegram /notes", () => {
  it("is passed to chat as a request, so the file comes the same way as asking in words", async () => {
    const { model, requests } = scripted(calls(call("get_revision_notes", { course: "data driven" })), say("Sent your Data Driven Decision Making notes."));
    const sentFiles: string[] = [];
    const fetchTg = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("sendDocument")) sentFiles.push(String((init?.body as FormData).get("document") instanceof Blob ? "doc" : "?"));
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as unknown as typeof fetch;
    await handleUpdate({ sql: t.sql, token: "T", ownerChatId: "1", model, now: () => NOW, fetch: fetchTg }, { update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: "/notes data driven" } });
    expect(JSON.stringify(requests[0]!.messages[0])).toContain("Send me my revision notes for data driven as a document.");
    expect(sentFiles).toEqual(["doc"]); // the Word file went out through Telegram's sendDocument
  });
});
