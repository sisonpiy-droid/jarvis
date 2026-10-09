import { strFromU8, unzipSync } from "fflate";

// Cleaning a pile of rows (CSV / Excel): deterministic rules fix what is safe to fix (spacing, case, date and number
// formats) and FLAG everything it isn't sure about instead of guessing — an ambiguous date, an invalid email, a
// possible duplicate, a missing value. Every flag says which cell and why. No AI: the same file always gives the
// same result, and nothing is silently dropped except blank rows and exact duplicates (both counted).
// Assumes Indian conventions: day-first dates, 10-digit mobile numbers.

export const MAX_ROWS = 5000;

/** Byte-order mark: Excel needs it to open a UTF-8 CSV (₹, accents) correctly. Built from char codes, not typed. */
const BOM = String.fromCharCode(0xfeff);
/** No-break space, zero-width space and stray BOMs inside cells. */
const INVISIBLE = new RegExp(`[${String.fromCharCode(0xa0, 0x200b, 0xfeff)}]`, "g");

export interface CleanedRow {
  /** Row number in the original file (the header is row 1). */
  row: number;
  cells: string[];
  flags: string[];
}

export interface CleanResult {
  header: string[];
  rows: CleanedRow[];
  rowsIn: number;
  blankRemoved: number;
  duplicatesRemoved: Array<{ row: number; sameAs: number }>;
  cellsChanged: number;
}

// ── reading ──────────────────────────────────────────────────────────────────

/** RFC 4180-style CSV with quotes; the delimiter (comma, semicolon, tab or pipe) is guessed from the first line. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t", "|"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const xmlDecode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const colIndex = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The first worksheet of an .xlsx as rows of text (empty cells kept in place). */
export function readXlsx(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes, { filter: (f) => /^xl\/(worksheets\/sheet\d+|sharedStrings)\.xml$/.test(f.name) });
  const xml = (n: string) => (files[n] ? strFromU8(files[n]!) : "");
  const shared = [...xml("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...(m[1] ?? "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => xmlDecode(t[1] ?? "")).join(""));
  const sheet = Object.keys(files).filter((n) => n.startsWith("xl/worksheets/")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheet) throw new Error("no worksheet found in this Excel file");
  const rows: string[][] = [];
  for (const r of xml(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const out: string[] = [];
    let next = 0;
    for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? "";
      const at = /r="([A-Z]+)\d+"/.exec(attrs);
      const idx = at ? colIndex(at[1]!) : next;
      const body = c[2] ?? "";
      const v = body.match(/<v>([^<]*)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "";
      while (out.length < idx) out.push("");
      out[idx] = /t="s"/.test(attrs) ? (shared[Number(v)] ?? "") : xmlDecode(v);
      next = idx + 1;
    }
    rows.push(out);
  }
  return rows;
}

/** Rows from a CSV/TSV/TXT or .xlsx file; null for any other kind of file. */
export function readTable(bytes: Uint8Array, fileName: string): string[][] | null {
  if (/\.xlsx$/i.test(fileName)) return readXlsx(bytes);
  if (/\.(csv|tsv|txt)$/i.test(fileName)) return parseCsv(new TextDecoder().decode(bytes));
  return null;
}

export function toCsv(header: string[], rows: string[][]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [header, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
}

// ── cleaning ─────────────────────────────────────────────────────────────────

const EMPTY = /^(n\/?a|na|null|none|nil|nan|-+|—|–|\?+)$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]{2,}$/;
const EMAIL_TYPO = /@(gmial|gmai|gmal|gamil|gnail|gmail\.con|gmail\.co|yahooo|yaho|hotmial|outlok|outloook)\./i;
const pad = (n: number) => String(n).padStart(2, "0");
const mon = (i: number) => MONTHS[i - 1]!.replace(/^./, (c) => c.toUpperCase());
const validDay = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

type Kind = "email" | "phone" | "date" | "amount" | "name" | "text";

const HEADER_KIND: Array<[RegExp, Kind]> = [
  [/e-?mail/i, "email"],
  [/phone|mobile|whats?app|contact\s*(no|num)/i, "phone"],
  [/date|dob|birth|\bon\b|deadline|joined|since/i, "date"],
  [/amount|price|cost|fee|salary|total|revenue|sales|qty|quantity|marks|score|balance|\bage\b/i, "amount"],
  [/name|city|company|organi[sz]ation|college|designation|department/i, "name"],
];

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-'.(])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

/** The column's kind: from its header, or from what at least 60% of its filled cells look like. */
function kindOf(header: string, values: string[]): Kind {
  for (const [re, k] of HEADER_KIND) if (re.test(header)) return k;
  const filled = values.filter(Boolean);
  if (filled.length < 3) return "text";
  const share = (f: (v: string) => boolean) => filled.filter(f).length / filled.length;
  if (share((v) => v.includes("@")) >= 0.6) return "email";
  if (share((v) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(v)) >= 0.6) return "date";
  if (share((v) => /^[-+(₹$]?\s*[\d,]+(\.\d+)?\)?$/.test(v)) >= 0.8) return "amount";
  return "text";
}

interface DateParts {
  y: number;
  m: number;
  d: number;
  note?: string;
}

/** Slash/dash/dot numeric dates for a column: which of day-first / month-first it uses, from its unambiguous values. */
function dateOrder(values: string[]): "dmy" | "mdy" | "unknown" {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}$/.exec(v);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    else if (Number(m[2]) > 12) mdy++;
  }
  return dmy && !mdy ? "dmy" : mdy && !dmy ? "mdy" : "unknown";
}

function parseDate(v: string, order: "dmy" | "mdy" | "unknown"): DateParts | null {
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (m) return validDay(+m[1]!, +m[2]!, +m[3]!) ? { y: +m[1]!, m: +m[2]!, d: +m[3]! } : null;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(v);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    let y = +m[3]!;
    let note: string | undefined;
    if (m[3]!.length === 2) {
      y += y < 70 ? 2000 : 1900;
      note = `two-digit year read as ${y}`;
    }
    const dayFirst = order === "mdy" ? false : true;
    const [d, mo] = dayFirst ? [a, b] : [b, a];
    if (!validDay(y, mo, d)) return null;
    if (order === "unknown" && a <= 12 && b <= 12 && a !== b) note = `is ambiguous (${a} ${mon(b)} or ${b} ${mon(a)}) — read as day first`;
    return { y, m: mo, d, ...(note ? { note } : {}) };
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})[\s,.-]+(\d{4})$/i.exec(v);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    return mo && validDay(+m[3]!, mo, +m[1]!) ? { y: +m[3]!, m: mo, d: +m[1]! } : null;
  }
  m = /^([a-z]{3,9})[\s.-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4})$/i.exec(v);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    return mo && validDay(+m[3]!, mo, +m[2]!) ? { y: +m[3]!, m: mo, d: +m[2]! } : null;
  }
  return null;
}

/** Cleans a table whose first non-blank row is the header. */
export function cleanTable(input: string[][]): CleanResult {
  const norm = (s: string | undefined) => {
    const t = (s ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
    return EMPTY.test(t) ? "" : t;
  };
  const numbered = input.map((cells, i) => ({ row: i + 1, cells }));
  const firstData = numbered.findIndex((r) => r.cells.some((c) => norm(c)));
  if (firstData < 0) return { header: [], rows: [], rowsIn: 0, blankRemoved: 0, duplicatesRemoved: [], cellsChanged: 0 };
  const width = Math.max(...numbered.map((r) => r.cells.length));
  const seen = new Set<string>();
  const header = Array.from({ length: width }, (_, i) => {
    let h = (input[firstData]![i] ?? "").replace(/\s+/g, " ").trim() || `column ${i + 1}`;
    while (seen.has(h.toLowerCase())) h += "_";
    seen.add(h.toLowerCase());
    return h;
  });
  const body = numbered.slice(firstData + 1);
  const rows: CleanedRow[] = [];
  let blankRemoved = 0;
  for (const r of body) {
    if (!r.cells.some((c) => norm(c))) {
      blankRemoved++;
      continue;
    }
    rows.push({ row: r.row, cells: Array.from({ length: width }, (_, i) => norm(r.cells[i])), flags: [] });
  }

  for (let c = 0; c < width; c++) {
    const col = rows.map((r) => r.cells[c]!);
    const kind = kindOf(header[c]!, col);
    const h = header[c]!;
    const filled = col.filter(Boolean).length;
    const mostlyFilled = rows.length >= 5 && filled / rows.length >= 0.8;
    const order = kind === "date" ? dateOrder(col) : "unknown";
    for (const row of rows) {
      const raw = row.cells[c]!;
      const flag = (why: string) => row.flags.push(`${h}: ${why}`);
      if (!raw) {
        if (mostlyFilled) flag("missing");
        continue;
      }
      let v = raw;
      switch (kind) {
        case "email":
          v = raw.toLowerCase().replace(/^mailto:/, "");
          if (!EMAIL.test(v)) flag(`"${raw}" is not a valid email`);
          else if (EMAIL_TYPO.test(v)) flag(`"${v}" — domain looks misspelled`);
          break;
        case "phone": {
          let d = raw.replace(/\D/g, "");
          if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
          else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
          v = d;
          if (d.length !== 10) flag(`"${raw}" has ${d.length} digits (expected 10)`);
          break;
        }
        case "date": {
          let s = raw;
          // An Excel date serial (days since 1899-12-30) in a date column.
          if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 70000) s = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86_400_000).toISOString().slice(0, 10);
          const p = parseDate(s, order);
          if (!p) flag(`"${raw}" is not a date I can read`);
          else {
            v = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
            if (p.note) flag(`"${raw}" ${p.note}`);
          }
          break;
        }
        case "amount": {
          const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw.replace(/^[₹$\s]*/, ""));
          const digits = raw.replace(/rs\.?|inr|[₹$,\s()+-]/gi, "");
          if (/^\d+(\.\d+)?$/.test(digits)) v = `${neg ? "-" : ""}${digits.replace(/^0+(?=\d)/, "")}`;
          else flag(`"${raw}" is not a plain number`);
          break;
        }
        case "name":
          if ((raw === raw.toLowerCase() || raw === raw.toUpperCase()) && /[a-z]/i.test(raw) && raw.length > 3) v = titleCase(raw);
          break;
        default:
          break;
      }
      row.cells[c] = v;
    }
  }

  // Duplicates: identical rows are removed (counted); rows sharing an email but differing elsewhere are flagged.
  const emailCol = header.findIndex((h, i) => kindOf(h, rows.map((r) => r.cells[i]!)) === "email");
  const keyOf = (r: CleanedRow) => (emailCol >= 0 && r.cells[emailCol] ? `e:${r.cells[emailCol]}` : "");
  const exact = new Map<string, number>();
  const byKey = new Map<string, CleanedRow>();
  const kept: CleanedRow[] = [];
  const duplicatesRemoved: CleanResult["duplicatesRemoved"] = [];
  for (const r of rows) {
    const sig = r.cells.join("\u0001").toLowerCase();
    const dup = exact.get(sig);
    if (dup != null) {
      duplicatesRemoved.push({ row: r.row, sameAs: dup });
      continue;
    }
    exact.set(sig, r.row);
    const key = keyOf(r);
    const other = key ? byKey.get(key) : undefined;
    if (other) {
      r.flags.push(`possible duplicate of row ${other.row} (same ${header[emailCol]}, other values differ)`);
      other.flags.push(`possible duplicate of row ${r.row} (same ${header[emailCol]}, other values differ)`);
    } else if (key) byKey.set(key, r);
    kept.push(r);
  }
  // Cells that differ from the file as given (spacing, case, formats).
  const cellsChanged = kept.reduce((n, r) => n + r.cells.filter((cell, i) => cell !== (input[r.row - 1]?.[i] ?? "")).length, 0);
  return { header, rows: kept, rowsIn: body.length, blankRemoved, duplicatesRemoved, cellsChanged };
}

/** The cleaned file: the original row number, the cleaned columns, then why a row needs a look. */
export function cleanedCsv(res: CleanResult): string {
  return `${BOM}${toCsv(["row", ...res.header, "needs review"], res.rows.map((r) => [String(r.row), ...r.cells, r.flags.join("; ")]))}`;
}
