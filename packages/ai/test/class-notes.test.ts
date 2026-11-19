import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { extractOfficeText } from "@jarvis/files";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { classNotesTool, revisionNotesTool } from "../src/study-tools";
import { jarvisTools } from "../src/tools";
import { say, scripted } from "./scripted";

// "Here's the transcript of Finance session 8": notes of what was said, saved with that session and merged into the pack.

const NOW = new Date("2026-11-03T05:00:00.000Z");
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());

const SHA_T = "t".padEnd(64, "0");
const SHA_S = "s".padEnd(64, "0");
const TRANSCRIPT = `So today we are talking about contribution margin. Remember, contribution margin is price minus variable cost, and the key thing, and I will say this again, is that the exam will ask you to compute it per unit. Take Rapido as the example: a ride at 120 rupees with 90 rupees of driver payout. ${"Then we discuss unit economics in more detail and why cohorts matter for retention. ".repeat(10)}`;
const LECTURE = {
  emphasis: ["The professor stressed that the exam will ask for contribution margin per unit.", "Rapido is the worked example: a ride at 120 rupees with 90 rupees of driver payout.", "Retention will rise by 45% — a figure never mentioned."],
  concepts: ["Contribution margin is price minus variable cost."],
  formulas: ["Contribution margin = price − variable cost."],
  terms: [{ term: "Contribution margin", meaning: "Price less the variable cost of one unit." }],
  questions: ["Compute the contribution margin of a 120 rupee ride with 90 rupees of payout."],
};

beforeEach(async () => {
  await t.sql`truncate jarvis.lms_items, jarvis.files, jarvis.session_notes restart identity cascade`;
  await t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title) values ('course', 'c1', 'h', '{}', 'Fundamentals of Finance with Prof. Narahari'), ('course', 'c2', 'h', '{}', 'Data Driven Decision Making with Prof. Vinay Sharma'), ('course', 'c3', 'h', '{}', 'Business Frameworks with Pranjal')`;
  await t.sql`insert into jarvis.files (sha256, storage_path, size_bytes, original_filename, text_status, text_content) values (${SHA_T}, 'p/t', 1, 'finance-8.txt', 'done', ${TRANSCRIPT}), (${SHA_S}, 'p/s', 1, 'scan.pdf', 'original', null)`;
});

const run = (model: ReturnType<typeof scripted>["model"] | null, a: Record<string, unknown>) => classNotesTool(t.sql, model).run(a) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("save_class_notes", () => {
  it("writes notes of what was said from a shared transcript file; an invented number is dropped; saved with the session", async () => {
    const { model, requests } = scripted(say(JSON.stringify(LECTURE)));
    const r = await run(model, { course: "finance", session: 8, file_id: SHA_T });
    expect(r).toMatchObject({ saved: true, course: "Fundamentals of Finance", session: 8, ideas: 1, formulas: 1, terms: 1, questions: 1 });
    expect(r.emphasis).toHaveLength(2); // "45%" is not in the transcript
    expect(r.emphasis[0]).toContain("exam will ask");
    expect(JSON.stringify(requests[0]!.messages)).toContain("Session: 8");
    const [row] = await db.courseNotes(t.sql, "c1");
    expect(row).toMatchObject({ session: 8, course: "Fundamentals of Finance with Prof. Narahari" });
    expect(row!.lecture!.emphasis).toHaveLength(2);
    expect(db.hasNoteContent(row!)).toBe(true); // a session with only class notes still counts
  });

  it("accepts pasted text too, and says what is missing or wrong instead of guessing", async () => {
    const { model } = scripted(say(JSON.stringify(LECTURE)));
    expect(await run(model, { course: "finance", session: 3, text: TRANSCRIPT })).toMatchObject({ saved: true });
    expect(await run(model, { course: "finance", session: 3, text: "too short" })).toMatchObject({ saved: false, reason: expect.stringContaining("too short") });
    expect(await run(model, { course: "quantum", session: 3, text: TRANSCRIPT })).toMatchObject({ saved: false, reason: expect.stringContaining("no course matches") });
    expect(await run(model, { course: "prof", session: 3, text: TRANSCRIPT })).toMatchObject({ saved: false, candidates: expect.arrayContaining(["Data Driven Decision Making", "Fundamentals of Finance"]) });
    expect(await run(model, { course: "business", session: 3, file_id: SHA_S })).toMatchObject({ saved: false, reason: expect.stringContaining("no readable text") });
    await expect(run(model, { course: "finance", session: 0, text: TRANSCRIPT })).rejects.toThrow(/session number/);
    expect(await run(null, { course: "finance", session: 3, text: TRANSCRIPT })).toMatchObject({ saved: false });
  });

  it("an unusable reply saves nothing", async () => {
    const { model } = scripted(say("not json"));
    expect(await run(model, { course: "finance", session: 8, text: TRANSCRIPT })).toMatchObject({ saved: false, reason: expect.stringContaining("usable notes") });
    expect(await db.courseNotes(t.sql, "c1")).toEqual([]);
  });

  it("slide notes written later (or rewritten) do not erase what was said in class", async () => {
    const { model } = scripted(say(JSON.stringify(LECTURE)));
    await run(model, { course: "finance", session: 8, text: TRANSCRIPT });
    const src = { courseId: "c1", course: "Fundamentals of Finance with Prof. Narahari", session: 8, files: [], sourceKey: "k1" };
    await db.saveSessionNotes(t.sql, src, { concepts: ["Slide idea about margins (Deck 8.pptx, slide 2)."], formulas: [], terms: [], questions: [] }, "m");
    await db.saveSessionNotes(t.sql, { ...src, sourceKey: "k2" }, { concepts: ["Rewritten slide idea about margins (Deck 8.pptx, slide 2)."], formulas: [], terms: [], questions: [] }, "m");
    const [row] = await db.courseNotes(t.sql, "c1");
    expect(row!.notes.concepts[0]).toContain("Rewritten");
    expect(row!.lecture!.concepts).toEqual(["Contribution margin is price minus variable cost."]);
  });
});

describe("the pack and /notes include what was said", () => {
  it("an 'In class' section with the emphasis, merged formulas and questions, in session order", async () => {
    const { model } = scripted(say(JSON.stringify(LECTURE)));
    await run(model, { course: "finance", session: 8, text: TRANSCRIPT });
    await db.saveSessionNotes(t.sql, { courseId: "c1", course: "Fundamentals of Finance with Prof. Narahari", session: 5, files: [], sourceKey: "k" }, { concepts: ["Earlier idea about working capital (Deck 5.pptx, slide 1)."], formulas: [], terms: [], questions: [] }, "m");
    let docx = "";
    const tool = revisionNotesTool(t.sql, () => NOW, async (bytes) => ((docx = extractOfficeText(bytes, "docx")), "sent"));
    expect(await tool.run({ course: "finance" })).toMatchObject({ sent: true, sessions: 2 });
    expect(docx).toContain("In class (what was said)");
    expect(docx).toContain("The professor stressed that the exam will ask for contribution margin per unit.");
    expect(docx).toContain("Rapido is the worked example");
    expect(docx).toContain("Formulas used in class");
    expect(docx).toContain("Contribution margin = price − variable cost. (session 8)");
    expect(docx).toContain("Compute the contribution margin of a 120 rupee ride");
    expect(docx.indexOf("Session 5")).toBeLessThan(docx.indexOf("Session 8"));
  });

  it("chat offers both notes tools only where they can work, and the prompt names the new one", async () => {
    const { systemPrompt } = await import("../src/jarvis");
    expect(systemPrompt(NOW)).toContain("save_class_notes");
    expect(jarvisTools(t.sql, () => NOW, { sendFile: async () => "" }).some((x) => x.name === "get_revision_notes")).toBe(true);
  });
});
