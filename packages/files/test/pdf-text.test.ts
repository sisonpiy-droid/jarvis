import { describe, expect, it } from "vitest";
import { cleanPdfText, extractPdfText, isPdf } from "../src/pdf-text";

/** A minimal one-page PDF, built with correct xref offsets; `text` null = a page with no text layer. */
function tinyPdf(text: string | null): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("PDF text", () => {
  it("extracts the text layer of a PDF", async () => {
    const text = await extractPdfText(tinyPdf("Session 8 pre-read: Groww unit economics and cohort retention"));
    expect(text).toContain("Groww unit economics and cohort retention");
  });

  it("drops control characters such as NUL, which Postgres can't store", () => {
    expect(cleanPdfText("HBS\u0000 Case\u0007 —  FoF\t\tnotes\n\n\n\nend")).toBe("HBS Case — FoF notes\n\nend");
  });

  it("returns null for a PDF with no text layer (scanned)", async () => {
    expect(await extractPdfText(tinyPdf(null))).toBeNull();
  });

  it("recognises PDFs by mime type or file name", () => {
    expect(isPdf("PreRead_Session 8_Groww.pdf", null)).toBe(true);
    expect(isPdf(null, "application/pdf")).toBe(true);
    expect(isPdf("deck.pptx", "application/vnd.openxmlformats")).toBe(false);
  });
});
