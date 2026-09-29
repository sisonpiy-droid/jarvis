import { numToCol, quoteSheet, type Workbook } from "./xlsx";

// Exact aggregation over a sheet's data table. The AI only chooses WHAT to
// compute (rows, columns, measures, filters); the numbers come from here, and
// every result cell is also written as a live COUNTIFS/SUMIFS formula over the
// data tab so the workbook stays verifiable and recalculates in Excel/Sheets.

export type Agg = "sum" | "count" | "average" | "min" | "max" | "countDistinct";

export interface Measure {
  field: string;
  agg: Agg;
  label?: string;
}
export interface Filter {
  field: string;
  op: "eq" | "neq" | "in";
  value: string | number | Array<string | number>;
}
export interface PivotSpec {
  rows: string[]; // group-by fields (0–2)
  column?: string | null; // optional pivot-column field (single measure only)
  measures: Measure[];
  filters?: Filter[];
  sortBy?: { measure: number; dir: "asc" | "desc" } | null;
  top?: number | null;
  totals?: boolean;
}

export interface Dataset {
  sheet: string;
  headers: string[];
  /** 1-based column number of each header in the sheet. */
  colOf: Map<string, number>;
  firstRow: number; // first data row (after header)
  lastRow: number;
  rows: Array<Array<string | number | boolean | null>>;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Finds the data table: the sheet with the most rows whose first row looks like a header. */
export function findDataset(wb: Workbook, preferred?: string): Dataset | null {
  const candidates = wb.sheets
    .filter((s) => (preferred ? s.name.toLowerCase() === preferred.toLowerCase() : true))
    .map((s) => {
      // Header = first row with ≥3 text cells.
      for (let r = 1; r <= Math.min(10, s.maxRow); r++) {
        const cells = Array.from({ length: s.maxCol }, (_, i) => s.cells.get(`${numToCol(i + 1)}${r}`));
        const texts = cells.filter((c) => typeof c?.value === "string" && c.value.trim());
        if (texts.length >= 3) {
          let last = r;
          for (let rr = r + 1; rr <= s.maxRow; rr++) if (s.cells.get(`A${rr}`)?.value != null || s.cells.get(`B${rr}`)?.value != null) last = rr;
          return { s, headerRow: r, dataRows: last - r, cols: cells.length };
        }
      }
      return null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.dataRows >= 5)
    .sort((a, b) => b.dataRows - a.dataRows);
  const best = candidates[0];
  if (!best) return null;
  const { s, headerRow } = best;
  const headers: string[] = [];
  const colOf = new Map<string, number>();
  for (let c = 1; c <= s.maxCol; c++) {
    const v = s.cells.get(`${numToCol(c)}${headerRow}`)?.value;
    if (typeof v === "string" && v.trim()) {
      headers.push(v.trim());
      colOf.set(norm(v), c);
    }
  }
  const lastRow = headerRow + best.dataRows;
  const rows: Dataset["rows"] = [];
  for (let r = headerRow + 1; r <= lastRow; r++) {
    rows.push(headers.map((h) => s.cells.get(`${numToCol(colOf.get(norm(h))!)}${r}`)?.value ?? null));
  }
  return { sheet: s.name, headers, colOf, firstRow: headerRow + 1, lastRow, rows };
}

/** Short profile of each column for the AI: type, distinct values (if few), range. */
export function profile(ds: Dataset): string {
  return ds.headers
    .map((h, i) => {
      const vals = ds.rows.map((r) => r[i]).filter((v) => v !== null && v !== "");
      const nums = vals.filter((v): v is number => typeof v === "number");
      const distinct = [...new Set(vals.map(String))];
      const col = numToCol(ds.colOf.get(norm(h))!);
      if (nums.length === vals.length && nums.length) {
        return `- ${col} "${h}": number, ${distinct.length} distinct, min ${Math.min(...nums)}, max ${Math.max(...nums)}`;
      }
      return `- ${col} "${h}": text, ${distinct.length} distinct${distinct.length <= 15 ? `: ${distinct.slice(0, 15).map((d) => JSON.stringify(d)).join(", ")}` : `, e.g. ${distinct.slice(0, 4).map((d) => JSON.stringify(d)).join(", ")}`}`;
    })
    .join("\n");
}

function idx(ds: Dataset, field: string): number {
  const i = ds.headers.findIndex((h) => norm(h) === norm(field));
  if (i < 0) throw new Error(`Unknown column "${field}". Columns: ${ds.headers.join(", ")}`);
  return i;
}

const matches = (v: unknown, f: Filter) => {
  const eq = (a: unknown, b: unknown) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  if (f.op === "in") return (Array.isArray(f.value) ? f.value : [f.value]).some((x) => eq(v, x));
  return f.op === "eq" ? eq(v, f.value) : !eq(v, f.value);
};

function aggregate(values: unknown[], agg: Agg): number {
  const nums = values.filter((v): v is number => typeof v === "number");
  switch (agg) {
    case "count":
      return values.filter((v) => v !== null && v !== "").length;
    case "countDistinct":
      return new Set(values.filter((v) => v !== null && v !== "").map(String)).size;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "average":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case "min":
      return nums.length ? Math.min(...nums) : 0;
    case "max":
      return nums.length ? Math.max(...nums) : 0;
  }
}

export interface PivotResult {
  header: string[];
  /** Each row: group labels then measure values. */
  body: Array<Array<string | number>>;
  totals: Array<string | number> | null;
  /** Formula for each body/totals value cell (null where no simple formula exists, e.g. countDistinct). */
  formulas: Array<Array<string | null>>;
  totalFormulas: Array<string | null> | null;
  groupCols: number;
}

/** Computes a pivot and the equivalent live formulas (COUNTIFS/SUMIFS/AVERAGEIFS/MINIFS/MAXIFS). */
export function computePivot(ds: Dataset, spec: PivotSpec): PivotResult {
  const rowIdx = spec.rows.map((f) => idx(ds, f));
  const colIdx = spec.column ? idx(ds, spec.column) : null;
  const measures = spec.measures.map((m) => ({ ...m, i: idx(ds, m.field) }));
  if (colIdx !== null && measures.length !== 1) throw new Error("A pivot column needs exactly one measure");
  const filters = (spec.filters ?? []).map((f) => ({ ...f, i: idx(ds, f.field) }));
  const data = ds.rows.filter((r) => filters.every((f) => matches(r[f.i], f)));

  const key = (r: (typeof data)[number]) => rowIdx.map((i) => String(r[i] ?? "(blank)"));
  const groups = new Map<string, { labels: string[]; rows: typeof data }>();
  for (const r of data) {
    const labels = key(r);
    const k = labels.join("\u0001");
    const g = groups.get(k) ?? { labels, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }
  if (!rowIdx.length) groups.set("", { labels: [], rows: data });
  const colValues = colIdx !== null ? [...new Set(data.map((r) => String(r[colIdx] ?? "(blank)")))].sort() : [];

  const dsRange = (i: number) => `${quoteSheet(ds.sheet)}!$${numToCol(ds.colOf.get(norm(ds.headers[i]!))!)}$${ds.firstRow}:$${numToCol(ds.colOf.get(norm(ds.headers[i]!))!)}$${ds.lastRow}`;
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const criteria = (labels: string[], extra: Array<[number, string]> = []) => {
    const parts: string[] = [];
    rowIdx.forEach((ri, n) => parts.push(dsRange(ri), q(labels[n]!)));
    for (const [ci, v] of extra) parts.push(dsRange(ci), q(v));
    for (const f of filters) {
      if (f.op === "eq") parts.push(dsRange(f.i), typeof f.value === "number" ? String(f.value) : q(String(f.value)));
      else if (f.op === "neq") parts.push(dsRange(f.i), q(`<>${f.value}`));
      else return null; // "in" has no single-criterion equivalent
    }
    return parts;
  };
  const formula = (m: (typeof measures)[number], labels: string[], extra: Array<[number, string]> = []): string | null => {
    const c = criteria(labels, extra);
    if (!c) return null;
    const crit = c.join(",");
    const noCrit = c.length === 0;
    switch (m.agg) {
      case "count":
        return noCrit ? `COUNTA(${dsRange(m.i)})` : `COUNTIFS(${crit})`;
      case "sum":
        return noCrit ? `SUM(${dsRange(m.i)})` : `SUMIFS(${dsRange(m.i)},${crit})`;
      case "average":
        return noCrit ? `AVERAGE(${dsRange(m.i)})` : `IFERROR(AVERAGEIFS(${dsRange(m.i)},${crit}),0)`;
      case "min":
        return noCrit ? `MIN(${dsRange(m.i)})` : `MINIFS(${dsRange(m.i)},${crit})`;
      case "max":
        return noCrit ? `MAX(${dsRange(m.i)})` : `MAXIFS(${dsRange(m.i)},${crit})`;
      default:
        return null;
    }
  };

  let body: PivotResult["body"] = [];
  let formulas: PivotResult["formulas"] = [];
  const header = [...spec.rows, ...(colIdx !== null ? colValues : measures.map((m) => m.label ?? `${m.agg === "count" ? "Count" : m.agg[0]!.toUpperCase() + m.agg.slice(1)} of ${m.field}`))];
  for (const g of groups.values()) {
    if (colIdx !== null) {
      const m = measures[0]!;
      body.push([...g.labels, ...colValues.map((cv) => aggregate(g.rows.filter((r) => String(r[colIdx] ?? "(blank)") === cv).map((r) => r[m.i]), m.agg))]);
      formulas.push([...g.labels.map(() => null), ...colValues.map((cv) => formula(m, g.labels, [[colIdx, cv]]))]);
    } else {
      body.push([...g.labels, ...measures.map((m) => aggregate(g.rows.map((r) => r[m.i]), m.agg))]);
      formulas.push([...g.labels.map(() => null), ...measures.map((m) => formula(m, g.labels))]);
    }
  }
  // Sort (default: by first measure, descending) and optional top-N.
  const sm = spec.sortBy ?? (rowIdx.length ? { measure: 0, dir: "desc" as const } : null);
  if (sm) {
    const col = rowIdx.length + sm.measure;
    const order = body.map((_, i) => i).sort((a, b) => ((Number(body[a]![col]) - Number(body[b]![col])) * (sm.dir === "asc" ? 1 : -1)));
    body = order.map((i) => body[i]!);
    formulas = order.map((i) => formulas[i]!);
  }
  if (spec.top && spec.top > 0) {
    body = body.slice(0, spec.top);
    formulas = formulas.slice(0, spec.top);
  }
  let totals: PivotResult["totals"] = null;
  let totalFormulas: PivotResult["totalFormulas"] = null;
  if (spec.totals !== false && rowIdx.length) {
    const nLabels = rowIdx.length;
    const valueCount = header.length - nLabels;
    const canSum = measures.every((m) => m.agg === "sum" || m.agg === "count");
    totals = ["Grand Total", ...Array.from({ length: nLabels - 1 }, () => ""), ...Array.from({ length: valueCount }, (_, j) => (canSum ? body.reduce((a, r) => a + Number(r[nLabels + j] ?? 0), 0) : ""))];
    totalFormulas = totals.map(() => null);
  }
  return { header, body, totals, formulas, totalFormulas, groupCols: rowIdx.length };
}
