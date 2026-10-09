import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { findPassages, searchTerms, sectionsOf } from "../src/material-search";
import { jarvisTools } from "../src/tools";
import { systemPrompt } from "../src/jarvis";

// "If the answer is in my course material, find it and say exactly where; if it isn't, say so and stop."

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.files, jarvis.item_files, jarvis.lms_items restart identity cascade`;
});

const PDF = "[page 1]\nIntro to unit economics.\n\n[page 2]\nCAC payback = CAC divided by monthly gross margin per customer.\n\n[page 3]\nLTV is the margin over a customer's lifetime.";
const DECK = "--- Slide 1 ---\nWelcome\n\n--- Slide 2 ---\nThe cohort retention curve flattens after month 3.\n\n--- Slide 3 ---\nContribution margin per order";
const DOC = "Pricing\nWe price at a premium because willingness to pay is high in tier-1 cities.\n\nDistribution\nRetail partners take a 20% margin.";

describe("finding passages", () => {
  it("turns a question into search terms", () => {
    expect(searchTerms("What is the CAC payback formula?")).toEqual(["cac", "payback", "formula"]);
    expect(searchTerms("what did he say")).toEqual([]);
  });

  it("locates by page, slide and the heading above (Word)", () => {
    expect(sectionsOf(PDF).map((s) => s.location)).toEqual(["page 1", "page 2", "page 3"]);
    expect(sectionsOf(DECK).map((s) => s.location)).toEqual(["slide 1", "slide 2", "slide 3"]);
    expect(sectionsOf(DOC).map((s) => s.location)).toEqual(['under "Pricing"', 'under "Distribution"']);
    const files = [
      { fileId: "a", name: "Unit Economics.pdf", course: "Finance", text: PDF },
      { fileId: "b", name: "Session 7 Deck.pptx", course: null, text: DECK },
      { fileId: "c", name: "Case.docx", course: null, text: DOC },
    ];
    expect(findPassages(files, ["payback", "cac"]).map((p) => [p.file, p.location])).toEqual([["Unit Economics.pdf", "page 2"]]);
    expect(findPassages(files, ["retention"]).map((p) => [p.file, p.location])).toEqual([["Session 7 Deck.pptx", "slide 2"]]);
    expect(findPassages(files, ["premium"]).map((p) => [p.file, p.location])).toEqual([["Case.docx", 'under "Pricing"']]);
    expect(findPassages(files, ["blockchain"])).toEqual([]);
  });
});

describe("find_in_materials", () => {
  const add = (sha: string, name: string, text: string) =>
    t.sql`insert into jarvis.files (sha256, storage_path, size_bytes, original_filename, text_status, text_content) values (${sha}, ${`p/${sha}`}, 10, ${name}, 'done', ${text})`;
  const run = (q: string) => jarvisTools(t.sql).find((x) => x.name === "find_in_materials")!.run({ query: q }) as Promise<Record<string, unknown>>;

  it("returns the passage with its file and page, with the course when known", async () => {
    await add("a".repeat(64), "Unit Economics.pdf", PDF);
    await t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, course_id, title) values ('course', 'c1', 'h', '{}', 'c1', 'Finance with Prof. N'), ('material', 'm1', 'h', '{}', 'c1', 'Unit Economics')`;
    await t.sql`insert into jarvis.item_files (kind, item_id, attachment_id, sha256, status) values ('material', 'm1', 'm1', ${"a".repeat(64)}, 'done')`;
    const r = await run("how is CAC payback calculated?");
    expect(r).toMatchObject({ found: true, passages: [{ file: "Unit Economics.pdf", location: "page 2", course: "Finance with Prof. N" }] });
    expect(JSON.stringify(r)).toContain("monthly gross margin");
  });

  it("says it isn't there when nothing matches — and tells the model to stop", async () => {
    await add("b".repeat(64), "Deck.pptx", DECK);
    const r = await run("explain blockchain consensus");
    expect(r).toMatchObject({ found: false });
    expect(String(r.note)).toMatch(/isn't there and stop/);
  });

  it("the prompt makes it the first stop for course questions, with citations and no guessing", () => {
    const p = systemPrompt(new Date());
    expect(p).toContain("find_in_materials first");
    expect(p).toContain("That isn't in your course material");
  });
});
