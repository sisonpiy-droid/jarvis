import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractOfficeText } from "../../files/src/office-text";
import { markdownToDocx, markdownToDocxXml } from "../src/docx";
import { DRAFT_SYSTEM, rankMaterials, stripLatex, summarize } from "../src/draft";

const MD = `# Case — Draft
## 1. What's being asked
- Apply **Porter's 5 Forces** to *Zostel*
1. Recommend a market
## 3. Draft
Body with \`code\` & <angle> brackets.
| Requirement | Where | Status |
|---|---|---|
| Q1 | §3 | ✅ |`;

describe("markdownToDocx", () => {
  it("produces a valid Word package whose text round-trips", () => {
    const files = unzipSync(markdownToDocx(MD));
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml"]);
    const text = extractOfficeText(markdownToDocx(MD), "docx");
    expect(text).toContain("Case — Draft");
    expect(text).toContain("Apply Porter's 5 Forces to Zostel");
    expect(text).toContain("Body with code & <angle> brackets.");
    expect(text).toContain("Requirement");
    expect(strFromU8(files["word/document.xml"]!)).toContain('<w:pStyle w:val="Heading2"/>');
  });
  it("renders bold/italic runs, escapes XML and builds tables", () => {
    const xml = markdownToDocxXml(MD);
    expect(xml).toContain("<w:b/></w:rPr><w:t xml:space=\"preserve\">Porter&apos;s 5 Forces".replace("&apos;", "'"));
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain("&lt;angle&gt;");
    expect(xml).toContain("<w:tbl>");
    expect(xml).not.toContain("|---|");
  });
});

describe("rankMaterials", () => {
  it("prefers materials whose titles overlap the assignment, then recency", () => {
    const mats = [
      { title: "Session 2 slides", topic: "Resources", sortAt: "2026-09-20" },
      { title: "Unit economics of quick commerce", topic: "Resources", sortAt: "2026-09-01" },
      { title: "Session 5 slides", topic: "Resources", sortAt: "2026-09-27" },
    ];
    expect(rankMaterials("Blinkit unit economics deep dive", mats)[0]!.title).toBe("Unit economics of quick commerce");
    expect(rankMaterials("unrelated words", mats)[0]!.title).toBe("Session 5 slides");
  });
});

describe("summarize", () => {
  it("returns sections 1–2 for the Telegram preview", () => {
    const s = summarize("# T\n## 1. What's being asked\n- a\n## 2. Approach & frameworks\n- b\n## 3. Draft\nlong body");
    expect(s).toContain("What's being asked");
    expect(s).toContain("Approach");
    expect(s).not.toContain("long body");
  });
});

describe("DRAFT_SYSTEM", () => {
  it("encodes the MESA priorities and the no-fabrication rule", () => {
    for (const k of ["First principles", "Problem identification", "Course frameworks", "Novelty", "Evidence", "NEVER invent", "authoritative", "Checklist against the brief"]) {
      expect(DRAFT_SYSTEM).toContain(k);
    }
  });
});

describe("stripLatex", () => {
  it("turns inline and display math into plain text", () => {
    expect(stripLatex(String.raw`Use $\text{EBIAT} = \text{EBIT} \times (1 - t)$ here`)).toBe("Use EBIAT = EBIT × (1 - t) here");
    expect(stripLatex(String.raw`$$\text{ROE} = \frac{\text{NI}}{\text{Equity}}$$`)).toBe("ROE = (NI) / (Equity)");
  });
  it("leaves ordinary currency alone", () => {
    expect(stripLatex("Revenue of Rs 500 Cr, costs $10 and $20")).toBe("Revenue of Rs 500 Cr, costs $10 and $20");
  });
});
