import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractOfficeText, officeKind } from "../src/office-text";
import { SupabaseStorage } from "../src/storage";

// Synthetic Office files built in-memory — no real documents in the repo.
const docx = (paras: string[]) =>
  zipSync({
    "word/document.xml": strToU8(`<w:document><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`),
    "word/_rels/document.xml.rels": strToU8("<Relationships/>"),
  });

describe("officeKind", () => {
  it("detects by extension or MIME type", () => {
    expect(officeKind("Brief.DOCX", null)).toBe("docx");
    expect(officeKind(null, "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("pptx");
    expect(officeKind("data.xlsx", "application/octet-stream")).toBe("xlsx");
    expect(officeKind("case.pdf", "application/pdf")).toBeNull();
  });
});

describe("extractOfficeText", () => {
  it("reads Word paragraphs and decodes entities", () => {
    expect(extractOfficeText(docx(["Question 1", "Apply Porter&apos;s 5 Forces &amp; SWOT"]), "docx")).toBe("Question 1\nApply Porter's 5 Forces & SWOT");
  });

  it("reads slides in numeric order", () => {
    const slide = (t: string) => strToU8(`<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`);
    const pptx = zipSync({ "ppt/slides/slide10.xml": slide("Ten"), "ppt/slides/slide2.xml": slide("Two"), "ppt/slides/slide1.xml": slide("One") });
    expect(extractOfficeText(pptx, "pptx")).toBe("--- Slide 1 ---\nOne\n\n--- Slide 2 ---\nTwo\n\n--- Slide 3 ---\nTen");
  });

  it("reads spreadsheet cells, resolving shared strings", () => {
    const xlsx = zipSync({
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Revenue</t></si><si><t>Cost</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>120</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>80</v></c></row></sheetData></worksheet>`),
    });
    expect(extractOfficeText(xlsx, "xlsx")).toBe("--- Sheet 1 ---\nRevenue\t120\nCost\t80");
  });

  it("truncates very long documents", () => {
    expect(extractOfficeText(docx(["x".repeat(500)]), "docx", 100)).toMatch(/…\[truncated\]$/);
  });
});

describe("SupabaseStorage", () => {
  const capture = () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, f };
  };
  it("sends new-style secret keys only as apikey", async () => {
    const { calls, f } = capture();
    await new SupabaseStorage("https://x.supabase.co/", "sb_secret_abc", "b", f).upload("p/f.pdf", new Uint8Array([1]), "application/pdf");
    expect(calls[0]!.url).toBe("https://x.supabase.co/storage/v1/object/b/p/f.pdf");
    expect(calls[0]!.headers.get("apikey")).toBe("sb_secret_abc");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });
  it("also sends legacy JWT keys as a bearer token", async () => {
    const { calls, f } = capture();
    await new SupabaseStorage("https://x.supabase.co", "eyJhbGc.x.y", "b", f).upload("f", new Uint8Array([1]), "");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer eyJhbGc.x.y");
  });
});
