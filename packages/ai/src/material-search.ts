// Finding an answer in the owner's course material, and exactly where: the file and the page / slide / sheet.
// Pure — the tool (tools.ts) fetches candidate files, this ranks their sections. Stored text carries markers:
// "[page N]" (PDF), "--- Slide N ---" (PowerPoint), "--- Sheet N ---" (Excel); Word has none, so its location is
// the nearest heading above the passage.

export interface MaterialFile {
  fileId: string;
  name: string;
  course: string | null;
  text: string;
}

export interface Passage {
  file: string;
  fileId: string;
  course: string | null;
  location: string;
  text: string;
}

const STOP = new Set(
  "the and for are was were what which who whom whose when where how why does did can could would should about from with into that this these those have has had your you our his her their they them then than there here tell show give find any all not but its it's per out off over under also too very just like some more most one two said say says taught teach teaches mean means define defined".split(" "),
);
const MARKER = /(\[page \d+\]|--- (?:Slide|Sheet) \d+ ---)/;
const SECTION_MAX = 1500;
const SNIPPET = 600;

/** Distinct lowercase words worth searching for (at most 6), in the order asked. */
export function searchTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9&%.\-/]*[a-z0-9]|[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)))].slice(0, 6);
}

const labelOf = (marker: string) => marker.replace(/^\[|\]$/g, "").replace(/^--- | ---$/g, "").toLowerCase();

const isHeading = (line: string) => line.length >= 3 && line.length <= 80 && !/[.;:,]$/.test(line);

/** A file's text as sections with a location each. */
export function sectionsOf(text: string): Array<{ location: string; body: string }> {
  const parts = text.split(MARKER);
  const out: Array<{ location: string; body: string }> = [];
  if (parts.length > 1) {
    if (parts[0]!.trim()) out.push({ location: "start of file", body: parts[0]! });
    for (let i = 1; i < parts.length; i += 2) out.push({ location: labelOf(parts[i]!), body: parts[i + 1] ?? "" });
    return out.filter((s) => s.body.trim());
  }
  // No markers (Word, pasted text): paragraph groups, located by the nearest heading above them.
  let heading: string | null = null;
  let buf = "";
  let part = 0;
  const flush = () => {
    if (buf.trim()) out.push({ location: heading ? `under "${heading}"` : `part ${++part}`, body: buf });
    buf = "";
  };
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    if (isHeading(line) && line.split(/\s+/).length <= 10) {
      flush();
      heading = line;
    }
    if (buf.length + line.length > SECTION_MAX) flush();
    buf += `${line}\n`;
  }
  flush();
  return out;
}

/** Passages (best first) that mention the terms: every term for up to two terms, otherwise at least two. */
export function findPassages(files: MaterialFile[], terms: string[], limit = 6): Passage[] {
  if (!terms.length) return [];
  const need = terms.length >= 3 ? 2 : terms.length;
  const scored: Array<{ score: number; p: Passage }> = [];
  for (const f of files) {
    for (const s of sectionsOf(f.text)) {
      const low = s.body.toLowerCase();
      const hits = terms.filter((t) => low.includes(t));
      if (hits.length < need) continue;
      const total = hits.reduce((n, t) => n + low.split(t).length - 1, 0);
      const at = Math.max(0, low.indexOf(hits[0]!) - 150);
      scored.push({ score: hits.length * 10 + Math.min(total, 9), p: { file: f.name, fileId: f.fileId, course: f.course, location: s.location, text: s.body.trim().slice(at, at + SNIPPET).replace(/\s+/g, " ") } });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.p);
}
