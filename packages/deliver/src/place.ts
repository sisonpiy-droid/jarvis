import type { PivotResult } from "./pivot";
import { numToCol, quoteSheet, splitRef, type Workbook } from "./xlsx";

export interface PlacedTable {
  sheet: string;
  /** Range of the group labels (first label column), for chart categories. */
  categories: string;
  /** One range per value column, with its header. */
  series: Array<{ name: string; values: string }>;
  /** Where the next block can safely start. */
  nextRow: number;
  lastCol: number;
}

/** Writes a pivot result at `anchor`: optional title, bold header, live formulas, bold totals row. */
export function placePivot(wb: Workbook, sheet: string, anchor: string, res: PivotResult, title?: string): PlacedTable {
  const { col: c0, row: r0 } = splitRef(anchor);
  let r = r0;
  if (title) {
    wb.setCell(sheet, `${numToCol(c0)}${r}`, { value: title, bold: true });
    r += 1;
  }
  res.header.forEach((h, j) => wb.setCell(sheet, `${numToCol(c0 + j)}${r}`, { value: h, bold: true }));
  r += 1;
  const firstBody = r;
  res.body.forEach((row, i) => {
    row.forEach((v, j) => {
      const f = res.formulas[i]?.[j] ?? null;
      const cell = `${numToCol(c0 + j)}${r}`;
      if (f) wb.setCell(sheet, cell, { formula: f, value: typeof v === "number" ? round(v) : v });
      else wb.setCell(sheet, cell, { value: typeof v === "number" ? round(v) : v });
    });
    r += 1;
  });
  const lastBody = r - 1;
  if (res.totals) {
    res.totals.forEach((v, j) => {
      const cell = `${numToCol(c0 + j)}${r}`;
      if (j >= res.groupCols && typeof v === "number" && res.body.length) {
        const colL = numToCol(c0 + j);
        wb.setCell(sheet, cell, { formula: `SUM(${colL}${firstBody}:${colL}${lastBody})`, value: round(v), bold: true });
      } else wb.setCell(sheet, cell, { value: v, bold: true });
    });
    r += 1;
  }
  const q = quoteSheet(sheet);
  const labelCol = numToCol(c0 + Math.max(0, res.groupCols - 1));
  return {
    sheet,
    categories: `${q}!$${labelCol}$${firstBody}:$${labelCol}$${Math.max(firstBody, lastBody)}`,
    series: res.header.slice(res.groupCols).map((name, j) => {
      const col = numToCol(c0 + res.groupCols + j);
      return { name: String(name), values: `${q}!$${col}$${firstBody}:$${col}$${Math.max(firstBody, lastBody)}` };
    }),
    nextRow: r + 1,
    lastCol: c0 + res.header.length - 1,
  };
}

const round = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 100) / 100);
