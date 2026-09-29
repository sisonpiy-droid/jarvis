import { strToU8, zipSync } from "fflate";

// Markdown → a clean, minimal .docx (Word / Google Docs compatible). Handles
// headings, paragraphs, bullet and numbered lists, **bold**, *italic*, `code`,
// and pipe tables. Pure JS (fflate), so it runs in Supabase Edge.

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function runs(text: string): string {
  const out: string[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(run(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith("**")) out.push(run(t.slice(2, -2), "<w:b/>"));
    else if (t.startsWith("`")) out.push(run(t.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'));
    else out.push(run(t.slice(1, -1), "<w:i/>"));
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(run(text.slice(last)));
  return out.join("");
}

const run = (t: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${x(t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"))}</w:t></w:r>`;
const para = (inner: string, style?: string, extra = "") => `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : ""}${inner}</w:p>`;

function table(rows: string[][]): string {
  const cell = (t: string, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(header ? run(t, "<w:b/>") : runs(t))}</w:tc>`;
  const border = ["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:color="999999"/>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>${rows
    .map((r, i) => `<w:tr>${r.map((c) => cell(c, i === 0)).join("")}</w:tr>`)
    .join("")}</w:tbl>${para("")}`;
}

export function markdownToDocxXml(md: string): string {
  const body: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) continue;
    if (/^\|.*\|$/.test(t)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i]!.trim())) {
        const cells = lines[i]!.trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      body.push(table(rows));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      body.push(para(run(h[2]!.replace(/\*\*/g, "")), `Heading${h[1]!.length}`));
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) continue;
    const bullet = /^[-*•]\s+(.*)$/.exec(t);
    if (bullet) {
      const depth = Math.min(2, Math.floor((line.length - line.trimStart().length) / 2));
      body.push(para(runs(`•\u00a0${bullet[1]}`), undefined, `<w:ind w:left="${360 + depth * 360}" w:hanging="220"/>`));
      continue;
    }
    const num = /^(\d+)[.)]\s+(.*)$/.exec(t);
    if (num) {
      body.push(para(runs(`${num[1]}.\u00a0${num[2]}`), undefined, `<w:ind w:left="360" w:hanging="300"/>`));
      continue;
    }
    body.push(para(runs(t.replace(/^>\s?/, ""))));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${[1, 2, 3, 4]
  .map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[36, 28, 24, 22][n - 1]}"/><w:color w:val="1F3864"/></w:rPr></w:style>`)
  .join("")}
</w:styles>`;

export function markdownToDocx(md: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(markdownToDocxXml(md)),
    "word/styles.xml": strToU8(STYLES),
  });
}
