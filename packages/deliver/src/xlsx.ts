import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// Read and edit .xlsx files at the XML level (fflate only), so a student's
// template keeps its formatting, validation and anything we don't touch.
// Supports: reading sheets/cells/shared strings/fills, writing values,
// strings and formulas (with cached results), a bold header style, native
// charts (column/bar/line/pie), new sheets, and force-recalc on open.

export type CellValue = string | number | boolean | null;
export interface Cell {
  ref: string;
  value: CellValue;
  formula?: string;
  style: number;
}
export interface SheetInfo {
  name: string;
  path: string; // e.g. xl/worksheets/sheet3.xml
  cells: Map<string, Cell>;
  maxRow: number;
  maxCol: number;
}

const X = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unX = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

export function colToNum(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
export function splitRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.replace(/\$/g, ""));
  if (!m) throw new Error(`Bad cell reference ${ref}`);
  return { col: colToNum(m[1]!), row: Number(m[2]) };
}
export const ref = (col: number, row: number) => `${numToCol(col)}${row}`;
export const quoteSheet = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

export class Workbook {
  files: Record<string, Uint8Array>;
  sheets: SheetInfo[] = [];
  private shared: string[] = [];
  private boldStyle: number | null = null;
  private highlight: Set<number> = new Set();

  constructor(bytes: Uint8Array) {
    this.files = unzipSync(bytes);
    this.load();
  }

  private text(path: string): string {
    const f = this.files[path];
    return f ? strFromU8(f) : "";
  }
  private put(path: string, xml: string) {
    this.files[path] = strToU8(xml);
  }

  private load() {
    this.shared = [...this.text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      unX([...m[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
    );
    // Cell styles whose fill is a real colour (not none/gray125/white): the "fill this in" cells.
    const styles = this.text("xl/styles.xml");
    const fills = [...(styles.match(/<fills[^>]*>([\s\S]*?)<\/fills>/)?.[1] ?? "").matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map((m) => m[1]!);
    const coloured = fills.map((f) => /patternType="solid"/.test(f) && !/rgb="FF(FFFFFF|000000)"/i.test(f));
    const xfs = [...(styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "").matchAll(/<xf\b([^>]*)/g)].map((m) => Number(m[1]!.match(/fillId="(\d+)"/)?.[1] ?? 0));
    xfs.forEach((fid, i) => coloured[fid] && this.highlight.add(i));

    const wb = this.text("xl/workbook.xml");
    const rels = this.text("xl/_rels/workbook.xml.rels");
    for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const attrs = m[1]!;
      const name = unX(attrs.match(/name="([^"]*)"/)?.[1] ?? "");
      const rid = attrs.match(/r:id="([^"]+)"/)?.[1];
      const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((r) => r[1]!).find((r) => r.includes(`Id="${rid}"`));
      const target = rel?.match(/Target="([^"]+)"/)?.[1];
      if (!target) continue;
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      this.sheets.push(this.parseSheet(name, path));
    }
  }

  private parseSheet(name: string, path: string): SheetInfo {
    const xml = this.text(path);
    const cells = new Map<string, Cell>();
    let maxRow = 0;
    let maxCol = 0;
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const r = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!r) continue;
      const body = c[2] ?? "";
      const t = attrs.match(/\bt="([^"]+)"/)?.[1];
      const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
      const f = body.match(/<f[^>]*>([^<]*)<\/f>/)?.[1];
      let value: CellValue = null;
      if (t === "s" && v !== undefined) value = this.shared[Number(v)] ?? "";
      else if (t === "inlineStr") value = unX([...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(""));
      else if (t === "str") value = v !== undefined ? unX(v) : "";
      else if (t === "b") value = v === "1";
      else if (v !== undefined) value = Number(v);
      const { col, row } = splitRef(r);
      maxRow = Math.max(maxRow, row);
      maxCol = Math.max(maxCol, col);
      cells.set(r, { ref: r, value, ...(f ? { formula: unX(f) } : {}), style: Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0) });
    }
    return { name, path, cells, maxRow, maxCol };
  }

  sheet(name: string): SheetInfo {
    const s = this.sheets.find((x) => x.name === name) ?? this.sheets.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) throw new Error(`No sheet named "${name}"`);
    return s;
  }

  isHighlighted(cell: Cell): boolean {
    return this.highlight.has(cell.style);
  }

  /** Human/AI-readable outline: every non-empty cell (capped) plus highlighted empty cells. */
  describe(maxCellsPerSheet = 80): string {
    return this.sheets
      .map((s) => {
        const cells = [...s.cells.values()];
        const filled = cells.filter((c) => c.value !== null && c.value !== "");
        const blanksToFill = cells.filter((c) => (c.value === null || c.value === "") && this.isHighlighted(c)).map((c) => c.ref);
        const big = filled.length > maxCellsPerSheet;
        const shown = filled.slice(0, big ? 30 : maxCellsPerSheet).map((c) => `${c.ref}=${c.formula ? `=${c.formula}` : JSON.stringify(c.value)}`);
        return [
          `### Sheet "${s.name}" (${s.maxRow} rows × ${s.maxCol} cols, ${filled.length} filled cells)`,
          shown.join(" | ") + (big ? ` | …(${filled.length - 30} more — looks like a data table)` : ""),
          blanksToFill.length ? `Highlighted EMPTY cells (answer cells): ${blanksToFill.slice(0, 60).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
  }

  // ── writing ────────────────────────────────────────────────────────────────

  private ensureBold(): number {
    if (this.boldStyle !== null) return this.boldStyle;
    let styles = this.text("xl/styles.xml");
    const fontCount = Number(styles.match(/<fonts[^>]*count="(\d+)"/)?.[1] ?? (styles.match(/<font>/g) ?? []).length);
    styles = styles.replace(/<\/fonts>/, `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`).replace(/<fonts([^>]*)count="\d+"/, `<fonts$1count="${fontCount + 1}"`);
    const xfCount = Number(styles.match(/<cellXfs[^>]*count="(\d+)"/)?.[1] ?? 0);
    styles = styles
      .replace(/<\/cellXfs>/, `<xf numFmtId="0" fontId="${fontCount}" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`)
      .replace(/<cellXfs([^>]*)count="\d+"/, `<cellXfs$1count="${xfCount + 1}"`);
    this.put("xl/styles.xml", styles);
    this.boldStyle = xfCount;
    return xfCount;
  }

  /** Writes one cell (value, or formula with optional cached result), keeping the cell's existing style. */
  setCell(sheetName: string, cellRef: string, input: { value?: CellValue; formula?: string; bold?: boolean }) {
    const s = this.sheet(sheetName);
    const { row } = splitRef(cellRef);
    let xml = this.text(s.path);
    const existing = s.cells.get(cellRef);
    const style = input.bold ? this.ensureBold() : (existing?.style ?? 0);
    const sAttr = style ? ` s="${style}"` : "";
    const v = input.value;
    let cellXml: string;
    if (input.formula) {
      const f = `<f>${X(input.formula.replace(/^=/, ""))}</f>`;
      if (typeof v === "number" && Number.isFinite(v)) cellXml = `<c r="${cellRef}"${sAttr}>${f}<v>${v}</v></c>`;
      else if (typeof v === "string") cellXml = `<c r="${cellRef}"${sAttr} t="str">${f}<v>${X(v)}</v></c>`;
      else cellXml = `<c r="${cellRef}"${sAttr}>${f}</c>`;
    } else if (typeof v === "number" && Number.isFinite(v)) cellXml = `<c r="${cellRef}"${sAttr}><v>${v}</v></c>`;
    else if (typeof v === "boolean") cellXml = `<c r="${cellRef}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
    else if (v === null || v === undefined || v === "") cellXml = `<c r="${cellRef}"${sAttr}/>`;
    else cellXml = `<c r="${cellRef}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${X(String(v))}</t></is></c>`;

    const cellRe = new RegExp(`<c r="${cellRef}"(?:[^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
    if (cellRe.test(xml)) xml = xml.replace(cellRe, cellXml);
    else {
      const rowRe = new RegExp(`<row r="${row}"([^>]*?)(/>|>([\\s\\S]*?)</row>)`);
      const rm = rowRe.exec(xml);
      if (rm) {
        const inner = rm[3] ?? "";
        const cells = [...inner.matchAll(/<c r="([A-Z]+)\d+"[\s\S]*?(?:\/>|<\/c>)/g)];
        const col = splitRef(cellRef).col;
        const after = cells.find((c) => colToNum(c[1]!) > col);
        const newInner = after ? inner.slice(0, after.index) + cellXml + inner.slice(after.index) : inner + cellXml;
        xml = xml.replace(rm[0], `<row r="${row}"${rm[1]}>${newInner}</row>`);
      } else {
        const rows = [...xml.matchAll(/<row r="(\d+)"/g)];
        const next = rows.find((r) => Number(r[1]) > row);
        const rowXml = `<row r="${row}">${cellXml}</row>`;
        if (next) xml = xml.slice(0, next.index) + rowXml + xml.slice(next.index);
        else if (/<sheetData\s*\/>/.test(xml)) xml = xml.replace(/<sheetData\s*\/>/, `<sheetData>${rowXml}</sheetData>`);
        else xml = xml.replace("</sheetData>", `${rowXml}</sheetData>`);
      }
    }
    this.put(s.path, xml);
    s.cells.set(cellRef, { ref: cellRef, value: v ?? null, ...(input.formula ? { formula: input.formula } : {}), style });
    const { col } = splitRef(cellRef);
    s.maxRow = Math.max(s.maxRow, row);
    s.maxCol = Math.max(s.maxCol, col);
  }

  /** Adds an empty sheet at the end (used for new answer tabs or from-scratch workbooks). */
  addSheet(name: string): SheetInfo {
    const existing = this.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const n = Math.max(0, ...Object.keys(this.files).map((k) => Number(k.match(/^xl\/worksheets\/sheet(\d+)\.xml$/)?.[1] ?? 0))) + 1;
    const path = `xl/worksheets/sheet${n}.xml`;
    this.put(path, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData/></worksheet>`);
    let rels = this.text("xl/_rels/workbook.xml.rels");
    const rid = `rIdJ${n}`;
    rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`);
    this.put("xl/_rels/workbook.xml.rels", rels);
    let wb = this.text("xl/workbook.xml");
    const sheetId = Math.max(0, ...[...wb.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
    wb = wb.replace("</sheets>", `<sheet name="${X(name.slice(0, 31))}" sheetId="${sheetId}" r:id="${rid}"/></sheets>`);
    this.put("xl/workbook.xml", wb);
    this.addContentType(`/xl/worksheets/sheet${n}.xml`, "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml");
    const info: SheetInfo = { name: name.slice(0, 31), path, cells: new Map(), maxRow: 0, maxCol: 0 };
    this.sheets.push(info);
    return info;
  }

  private addContentType(part: string, type: string) {
    let ct = this.text("[Content_Types].xml");
    if (!ct.includes(`PartName="${part}"`)) ct = ct.replace("</Types>", `<Override PartName="${part}" ContentType="${type}"/></Types>`);
    this.put("[Content_Types].xml", ct);
  }

  private chartCount = 0;
  /** Adds a native Excel chart anchored at `anchor`, reading its data from sheet ranges. */
  addChart(sheetName: string, anchor: string, chart: { type: "column" | "bar" | "line" | "pie"; title: string; categories: string; series: Array<{ name: string; values: string }> }) {
    const s = this.sheet(sheetName);
    const base = Math.max(0, ...Object.keys(this.files).map((k) => Number(k.match(/^xl\/charts\/chart(\d+)\.xml$/)?.[1] ?? 0)));
    const cn = base + 1;
    this.chartCount++;
    const chartPath = `xl/charts/chart${cn}.xml`;
    const ser = chart.series
      .map(
        (sr, i) =>
          `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${X(sr.name)}</c:v></c:tx><c:cat><c:strRef><c:f>${X(chart.categories)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${X(sr.values)}</c:f></c:numRef></c:val></c:ser>`,
      )
      .join("");
    const axes = `<c:axId val="${cn}1"/><c:axId val="${cn}2"/>`;
    const body =
      chart.type === "pie"
        ? `<c:pieChart><c:varyColors val="1"/>${ser}</c:pieChart>`
        : chart.type === "line"
          ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/>${axes}</c:lineChart>`
          : `<c:barChart><c:barDir val="${chart.type === "bar" ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}${axes}</c:barChart>`;
    const axisXml =
      chart.type === "pie"
        ? ""
        : `<c:catAx><c:axId val="${cn}1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type === "bar" ? "l" : "b"}"/><c:crossAx val="${cn}2"/></c:catAx><c:valAx><c:axId val="${cn}2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${chart.type === "bar" ? "b" : "l"}"/><c:majorGridlines/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:crossAx val="${cn}1"/></c:valAx>`;
    this.put(
      chartPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${X(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${body}${axisXml}</c:plotArea><c:legend><c:legendPos val="${chart.type === "pie" ? "r" : "b"}"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`,
    );
    this.addContentType(`/${chartPath}`, "application/vnd.openxmlformats-officedocument.drawingml.chart+xml");

    // One drawing part per sheet; charts are appended to it.
    const sheetFile = s.path.split("/").pop()!;
    const sheetRelsPath = `xl/worksheets/_rels/${sheetFile}.rels`;
    let sheetRels = this.text(sheetRelsPath) || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    let drawingTarget = sheetRels.match(/Type="[^"]*\/drawing"[^>]*Target="([^"]+)"/)?.[1] ?? sheetRels.match(/Target="([^"]+)"[^>]*Type="[^"]*\/drawing"/)?.[1];
    let sheetXml = this.text(s.path);
    if (!drawingTarget) {
      const dn = Math.max(0, ...Object.keys(this.files).map((k) => Number(k.match(/^xl\/drawings\/drawing(\d+)\.xml$/)?.[1] ?? 0))) + 1;
      drawingTarget = `../drawings/drawing${dn}.xml`;
      this.put(`xl/drawings/drawing${dn}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>`);
      this.addContentType(`/xl/drawings/drawing${dn}.xml`, "application/vnd.openxmlformats-officedocument.drawing+xml");
      sheetRels = sheetRels.replace("</Relationships>", `<Relationship Id="rIdJdraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${drawingTarget}"/></Relationships>`);
      this.put(sheetRelsPath, sheetRels);
      if (!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace("<worksheet ", `<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `);
      // <drawing> must precede legacyDrawing/tableParts/extLst.
      const before = sheetXml.search(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
      const tag = `<drawing r:id="rIdJdraw"/>`;
      sheetXml = before >= 0 ? sheetXml.slice(0, before) + tag + sheetXml.slice(before) : sheetXml.replace("</worksheet>", `${tag}</worksheet>`);
      this.put(s.path, sheetXml);
    }
    const drawingPath = `xl/drawings/${drawingTarget.split("/").pop()}`;
    const drawingRelsPath = `xl/drawings/_rels/${drawingTarget.split("/").pop()}.rels`;
    let drels = this.text(drawingRelsPath) || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const crid = `rIdJc${cn}`;
    drels = drels.replace("</Relationships>", `<Relationship Id="${crid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${cn}.xml"/></Relationships>`);
    this.put(drawingRelsPath, drels);
    const { col, row } = splitRef(anchor);
    const frame = `<xdr:twoCellAnchor><xdr:from><xdr:col>${col - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 7}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 17}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${1000 + cn}" name="Chart ${cn}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${crid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
    // Google's exports use an empty self-closing <xdr:wsDr …/>; Excel's use an open/close pair.
    let dx = this.text(drawingPath);
    if (/<xdr:wsDr\b[^>]*\/>/.test(dx)) dx = dx.replace(/<xdr:wsDr\b([^>]*?)\s*\/>/, `<xdr:wsDr$1>${frame}</xdr:wsDr>`);
    else dx = dx.replace("</xdr:wsDr>", `${frame}</xdr:wsDr>`);
    if (!dx.includes(`r:id="${crid}"`)) throw new Error("could not attach chart to the sheet drawing");
    if (!/xmlns:r=/.test(dx.match(/<xdr:wsDr\b[^>]*>/)?.[0] ?? "")) dx = dx.replace(/<xdr:wsDr\b/, `<xdr:wsDr xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`);
    this.put(drawingPath, dx);
  }

  /** Bytes of the edited workbook; formulas recalculate when opened (Excel/Sheets). */
  toBytes(): Uint8Array {
    let wb = this.text("xl/workbook.xml");
    if (/<calcPr\b/.test(wb)) wb = wb.replace(/<calcPr\b([^>]*?)\/?>/, (m, a: string) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"/>`);
    else wb = wb.replace("</workbook>", `<calcPr fullCalcOnLoad="1"/></workbook>`);
    this.put("xl/workbook.xml", wb);
    // Stale calc chains confuse Excel after edits; it rebuilds one automatically.
    delete this.files["xl/calcChain.xml"];
    const ct = this.text("[Content_Types].xml").replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, "");
    this.put("[Content_Types].xml", ct);
    const rels = this.text("xl/_rels/workbook.xml.rels").replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, "");
    this.put("xl/_rels/workbook.xml.rels", rels);
    return zipSync(this.files, { level: 6 });
  }
}

/** A minimal empty workbook (one sheet) to build from scratch. */
export function blankWorkbook(firstSheet = "Sheet1"): Workbook {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${X(firstSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData/></worksheet>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    ),
  };
  return new Workbook(zipSync(files));
}
