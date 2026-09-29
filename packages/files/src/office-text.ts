import { strFromU8, unzipSync } from "fflate";

// Plain-text extraction for Office Open XML (docx / pptx / xlsx): they're zip
// files of XML. Pure JS so it runs in Supabase Edge. PDFs are deliberately not
// handled here — the assignment agent reads the original PDF itself, which is
// more faithful than any text dump.

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const byNumber = (a: string, b: string) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);

function paragraphs(xml: string, textTag: string, paraTag: string): string {
  return xml
    .split(new RegExp(`</${paraTag}>`))
    .map((p) => [...p.matchAll(new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>`, "g"))].map((m) => decode(m[1] ?? "")).join(""))
    .filter((t) => t.trim())
    .join("\n");
}

export type OfficeKind = "docx" | "pptx" | "xlsx";

export function officeKind(fileName: string | null | undefined, mime: string | null | undefined): OfficeKind | null {
  const s = `${fileName ?? ""} ${mime ?? ""}`.toLowerCase();
  if (/\.docx\b|wordprocessingml|\bdocx\b/.test(s)) return "docx";
  if (/\.pptx\b|presentationml|\bpptx\b/.test(s)) return "pptx";
  if (/\.xlsx\b|spreadsheetml|\bxlsx\b/.test(s)) return "xlsx";
  return null;
}

export function extractOfficeText(bytes: Uint8Array, kind: OfficeKind, maxChars = 200_000): string {
  const files = unzipSync(bytes, { filter: (f) => f.name.endsWith(".xml") && !f.name.includes("/_rels/") });
  const xml = (name: string) => (files[name] ? strFromU8(files[name]) : "");
  let out: string;
  if (kind === "docx") {
    out = paragraphs(xml("word/document.xml"), "w:t", "w:p");
  } else if (kind === "pptx") {
    const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
    out = slides.map((n, i) => `--- Slide ${i + 1} ---\n${paragraphs(xml(n), "a:t", "a:p")}`).join("\n\n");
  } else {
    const shared = [...xml("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      [...(m[1] ?? "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decode(t[1] ?? "")).join(""),
    );
    const sheets = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber);
    out = sheets
      .map((n, i) => {
        const rows = [...xml(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
          [...(r[1] ?? "").matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map((c) => {
              const attrs = c[1] ?? "";
              const body = c[2] ?? "";
              const v = body.match(/<v>([^<]*)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "";
              return /t="s"/.test(attrs) ? shared[Number(v)] ?? "" : decode(v);
            })
            .join("\t"),
        );
        return `--- Sheet ${i + 1} ---\n${rows.filter((r) => r.trim()).join("\n")}`;
      })
      .join("\n\n");
  }
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…[truncated]` : out;
}
