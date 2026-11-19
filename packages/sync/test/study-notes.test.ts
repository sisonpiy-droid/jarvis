import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import { extractOfficeText } from "@jarvis/files";
import { createLogger } from "@jarvis/shared";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { say, scripted } from "../../ai/test/scripted";
import { runStudyNotes } from "../src/study-notes";

// Study notes written once per session from its material, and a revision pack sent before each exam.

vi.spyOn(console, "log").mockImplementation(() => {});
const log = createLogger("test");
const NOW = new Date("2026-10-13T05:00:00.000Z"); // Tue 13 Oct, 10:30 IST
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const DECK7 = "--- Slide 1 ---\nUnit economics\n--- Slide 2 ---\nContribution margin = price - variable cost. Payback is 18 months.\n--- Slide 3 ---\nCAC divided by gross margin per month gives payback.";
const READ7 = "[page 1]\nGroww case: users grew to 10 million. Retention by cohort is the key question.";
const DECK8 = "--- Slide 1 ---\nPricing\n--- Slide 2 ---\nPrice elasticity measures demand response. A 5% price rise cut volume 12%.";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());

const item = (kind: string, id: string, title: string, data: Record<string, unknown>, sortAt: string | null, courseId: string | null) =>
  t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, course_id, title, sort_at)
        values (${kind}, ${id}, ${`h-${id}`}, ${t.sql.json({ sourceId: id, title, ...data } as never)}, ${courseId}, ${title}, ${sortAt})`;
const file = async (sha: string, name: string, text: string, materialId: string) => {
  await t.sql`insert into jarvis.files (sha256, storage_path, size_bytes, original_filename, text_status, text_content) values (${sha}, ${`p/${sha}`}, ${text.length}, ${name}, 'done', ${text})`;
  await t.sql`insert into jarvis.item_files (kind, item_id, attachment_id, sha256, status) values ('material', ${materialId}, ${materialId}, ${sha}, 'done')`;
};

beforeEach(async () => {
  await t.sql`truncate jarvis.lms_items, jarvis.item_files, jarvis.files, jarvis.session_notes, jarvis.notifications restart identity cascade`;
  await item("course", "c1", "Data Driven Decision Making with Prof. Vinay Sharma", {}, null, "c1");
  await item("course", "c2", "Business Frameworks with Pranjal", {}, null, "c2");
  await item("material", "m7", "Session 7 Deck", { kind: "file", topicTitle: "Resources" }, hours(-200), "c1");
  await item("material", "m7p", "PreRead_Session 7_Groww", { kind: "file", topicTitle: "Pre-Reads" }, hours(-210), "c1");
  await item("material", "m8", "Session 8 Deck", { kind: "file", topicTitle: "Resources" }, hours(-100), "c1");
  await item("material", "bf3", "Session 3 Deck", { kind: "file", topicTitle: "Resources" }, hours(-300), "c2");
  await file("d7".padEnd(64, "0"), "Session 7 Deck.pptx", DECK7, "m7");
  await file("r7".padEnd(64, "0"), "PreRead_Session 7_Groww.pdf", READ7, "m7p");
  await file("d8".padEnd(64, "0"), "Session 8 Deck.pptx", DECK8, "m8");
  await file("b3".padEnd(64, "0"), "BF Session 3 Deck.pptx", "--- Slide 1 ---\nPorter's five forces: rivalry, entrants, substitutes, buyers, suppliers.", "bf3");
  await item("assignment", "ex1", "End-Term Assessment", { submissionStatus: "not_submitted" }, hours(48), "c1");
  await item("assignment", "ex2", "Quiz 2", { submissionStatus: "submitted" }, hours(30), "c1");
  await item("assignment", "ex3", "Case Workbook", { submissionStatus: "not_submitted" }, hours(40), "c1");
  await item("assignment", "ex4", "Mid-Term Assessment", { submissionStatus: "not_submitted" }, hours(200), "c1");
});

const NOTES7 = { concepts: ["Contribution margin is price less variable cost (Session 7 Deck.pptx, slide 2).", "Payback of 40 months is the benchmark."], formulas: ["Payback = CAC / gross margin per month (Session 7 Deck.pptx, slide 3)."], terms: [{ term: "Contribution margin", meaning: "Price minus variable cost, per unit (slide 2)." }], questions: ["How is payback worked out?", "Why does retention by cohort matter?"] };
const NOTES8 = { concepts: ["Price elasticity measures how demand responds to a price change (Session 8 Deck.pptx, slide 2)."], formulas: [], terms: [], questions: ["What happened to volume after the 5% price rise?"] };

function fakeStorage() {
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  return { uploads, upload: async (path: string, bytes: Uint8Array) => void uploads.push({ path, bytes }) };
}

describe("session sources", () => {
  it("groups files by session, deck before pre-read, with a key that changes when the files do", async () => {
    const all = await db.sessionSources(t.sql);
    expect(all.map((s) => [s.courseId, s.session, s.files.map((f) => f.name)])).toEqual(
      expect.arrayContaining([["c1", 7, ["Session 7 Deck.pptx", "PreRead_Session 7_Groww.pdf"]], ["c1", 8, ["Session 8 Deck.pptx"]], ["c2", 3, ["BF Session 3 Deck.pptx"]]]),
    );
    const k = all.find((s) => s.session === 8)!.sourceKey;
    await item("material", "m8w", "Session 8 Workbook", { kind: "file" }, null, "c1");
    await file("w8".padEnd(64, "0"), "Session 8 Workbook.xlsx", "--- Sheet 1 ---\nprice\tvolume", "m8w");
    expect((await db.sessionSources(t.sql)).find((s) => s.session === 8)!.sourceKey).not.toBe(k);
  });
});

describe("study notes", () => {
  it("one session per run, the exam's course and the newest session first; invented numbers are dropped; never twice", async () => {
    const { model, requests } = scripted(say(JSON.stringify(NOTES8)), say(JSON.stringify(NOTES7)), say(JSON.stringify({ concepts: ["Porter's five forces: rivalry, entrants, substitutes, buyers, suppliers."], formulas: [], terms: [], questions: [] })));
    expect(await runStudyNotes(t.sql, NOW, model, null, log)).toMatchObject({ written: 1 });
    expect(requests[0]!.messages[0]!.parts[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(requests[0]!.messages)).toContain("Session: 8"); // c1 has an exam within 72 h: first, newest session
    await runStudyNotes(t.sql, NOW, model, null, log);
    await runStudyNotes(t.sql, NOW, model, null, log); // c2's session last
    const c1 = await db.courseNotes(t.sql, "c1");
    expect(c1.map((n) => n.session)).toEqual([7, 8]);
    expect(c1[0]!.notes.concepts).toEqual(["Contribution margin is price less variable cost (Session 7 Deck.pptx, slide 2)."]); // "40 months" is not in the deck
    expect(c1[0]!.notes.formulas).toHaveLength(1);
    expect(c1[0]!.notes.terms[0]!.term).toBe("Contribution margin");
    // Everything is written: no more AI calls (the scripted model has no replies left).
    expect(await runStudyNotes(t.sql, NOW, model, null, log)).toMatchObject({ written: 0, errors: 0 });
  });

  it("a failed AI call is counted and retried next run; an unusable deck is saved empty, not retried", async () => {
    const boom = { name: "x", generate: async () => { throw new Error("Gemini HTTP 503"); } };
    expect(await runStudyNotes(t.sql, NOW, boom, null, log)).toMatchObject({ written: 0, errors: 1 });
    expect(await db.pendingSessionNotes(t.sql, [], 10)).toHaveLength(3);
    const { model } = scripted(say("not json at all"), say("{}"), say("{}"));
    for (let i = 0; i < 3; i++) await runStudyNotes(t.sql, NOW, model, null, log);
    expect(await db.pendingSessionNotes(t.sql, [], 10)).toHaveLength(0);
  });
});

describe("revision pack", () => {
  const writeAll = async () => {
    const s = await db.sessionSources(t.sql);
    for (const x of s) await db.saveSessionNotes(t.sql, x, x.session === 7 ? NOTES7 : x.session === 8 ? NOTES8 : { concepts: [], formulas: [], terms: [], questions: [] }, "m");
  };

  it("sends the course's notes as one Word file before the end-term — once, with the file attached", async () => {
    await writeAll();
    const storage = fakeStorage();
    expect(await runStudyNotes(t.sql, NOW, null, storage, log)).toMatchObject({ packs: 1 });
    const [n] = await t.sql`select dedupe_key, priority, text, url, files from jarvis.notifications`;
    expect(n!.dedupe_key).toBe("revision.pack:ex1");
    expect(n!.priority).toBe("high");
    expect(String(n!.text)).toContain("<b>Revision pack: Data Driven Decision Making</b>");
    expect(String(n!.text)).toContain("End-Term Assessment is due");
    expect(String(n!.text)).toContain("2 sessions of notes");
    expect(n!.files).toHaveLength(1);
    expect(n!.url).toBe(`/files/${(n!.files as string[])[0]}`);
    const [f] = await t.sql`select original_filename, storage_path from jarvis.files where sha256 = ${(n!.files as string[])[0]!}`;
    expect(f!.original_filename).toBe("Data Driven Decision Making - revision pack.docx");

    const text = extractOfficeText(storage.uploads[0]!.bytes, "docx");
    expect(text).toContain("Data Driven Decision Making — revision pack");
    expect(text).toContain("Session 7");
    expect(text).toContain("Payback = CAC / gross margin per month (Session 7 Deck.pptx, slide 3).");
    expect(text).toContain("All formulas in one place");
    expect(text).toContain("Test yourself");
    expect(text).toContain("What happened to volume after the 5% price rise?");
    expect(text.indexOf("Session 7")).toBeLessThan(text.indexOf("Session 8"));

    // Once per exam; and not for the submitted quiz, the workbook, or the mid-term that is days away.
    expect(await runStudyNotes(t.sql, NOW, null, storage, log)).toMatchObject({ packs: 0 });
    expect((await t.sql`select dedupe_key from jarvis.notifications`).map((r) => r.dedupe_key)).toEqual(["revision.pack:ex1"]);
  });

  it("waits while the course's notes are still being written — unless the exam is under a day away", async () => {
    const [s7] = (await db.sessionSources(t.sql)).filter((s) => s.courseId === "c1" && s.session === 7);
    await db.saveSessionNotes(t.sql, s7!, NOTES7, "m"); // session 8 still pending
    const storage = fakeStorage();
    expect(await runStudyNotes(t.sql, NOW, null, storage, log)).toMatchObject({ packs: 0 }); // 48 h away: wait
    const close = new Date(NOW.getTime() + 30 * 3_600_000); // now the exam is 18 h away
    expect(await runStudyNotes(t.sql, close, null, storage, log)).toMatchObject({ packs: 1 });
    expect(extractOfficeText(storage.uploads[0]!.bytes, "docx")).toContain("1 session covered");
  });

  it("no notes, no storage → no pack (and nothing broken)", async () => {
    expect(await runStudyNotes(t.sql, NOW, null, fakeStorage(), log)).toMatchObject({ packs: 0 });
    await writeAll();
    expect(await runStudyNotes(t.sql, NOW, null, null, log)).toMatchObject({ packs: 0 });
    expect((await t.sql`select count(*)::int n from jarvis.notifications`)[0]!.n).toBe(0);
  });

  it("the notification routes and attaches like the other class messages", () => {
    expect(db.notificationMeta("revision.pack:ex1")).toEqual({ category: "class", url: "/classes" });
  });
});
