import { extractText, getDocumentProxy } from "unpdf";

// Text out of a PDF (pre-reads, slides, readings) with unpdf — pdf.js built for serverless and edge runtimes, so
// it runs in the Edge jobs and in Node alike. Scanned PDFs (images only) have no text layer: they return null and
// stay stored as originals.

/** Above this, the rest is cut: chat tools read at most 30k characters at a time anyway. */
const MAX_CHARS = 400_000;
/** Less real text than this (after whitespace) means a scanned/image-only PDF. */
const MIN_CHARS = 40;

export async function extractPdfText(bytes: Uint8Array): Promise<string | null> {
  // pdf.js may take ownership of the buffer, so give it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => p.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
  const joined = pages.map((p, i) => (pages.length > 1 ? `[page ${i + 1}]\n${p}` : p)).join("\n\n");
  if (joined.replace(/\[page \d+\]|\s/g, "").length < MIN_CHARS) return null;
  return joined.length > MAX_CHARS ? `${joined.slice(0, MAX_CHARS)}\n…(cut)` : joined;
}

export const isPdf = (fileName: string | null | undefined, mime: string | null | undefined) => /pdf/i.test(mime ?? "") || /\.pdf$/i.test(fileName ?? "");
