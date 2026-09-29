import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { computePivot, findDataset, profile } from "../src/pivot";
import { placePivot } from "../src/place";
import { buildDeck } from "../src/pptx";
import { Workbook, blankWorkbook, colToNum, numToCol } from "../src/xlsx";

// Synthetic orders table (no real data).
function sampleWorkbook() {
  const wb = blankWorkbook("Data");
  const rows: Array<[string, string, string, number, number, string]> = [
    ["O1", "Online", "Pune", 1, 1000, "New"],
    ["O2", "Offline", "Pune", 2, 3000, "Returning"],
    ["O3", "Online", "Delhi", 1, 1500, "Returning"],
    ["O4", "Offline", "Delhi", 3, 4500, "New"],
    ["O5", "Offline", "Pune", 1, 2000, "Returning"],
    ["O6", "Online", "Mumbai", 2, 2500, "New"],
  ];
  ["Order ID", "Channel", "City", "Units", "Order Value (₹)", "Customer Type"].forEach((h, i) => wb.setCell("Data", `${numToCol(i + 1)}1`, { value: h }));
  rows.forEach((r, i) => r.forEach((v, j) => wb.setCell("Data", `${numToCol(j + 1)}${i + 2}`, { value: v })));
  wb.addSheet("Q1");
  wb.setCell("Q1", "A1", { value: "Find city-wise orders, units and revenue" });
  return new Workbook(wb.toBytes()); // round-trip through bytes like a real template
}

describe("xlsx basics", () => {
  it("converts column letters", () => {
    expect(colToNum("A")).toBe(1);
    expect(colToNum("Z")).toBe(26);
    expect(colToNum("AA")).toBe(27);
    expect(numToCol(28)).toBe("AB");
  });
  it("round-trips values, strings and formulas and sets recalc-on-open", () => {
    const wb = sampleWorkbook();
    wb.setCell("Q1", "B3", { formula: "SUM(Data!E2:E7)", value: 14500 });
    wb.setCell("Q1", "A3", { value: "Total revenue", bold: true });
    const again = new Workbook(wb.toBytes());
    expect(again.sheet("Q1").cells.get("A3")?.value).toBe("Total revenue");
    expect(again.sheet("Q1").cells.get("B3")).toMatchObject({ value: 14500, formula: "SUM(Data!E2:E7)" });
    expect(strFromU8(unzipSync(wb.toBytes())["xl/workbook.xml"]!)).toContain('fullCalcOnLoad="1"');
  });
  it("inserts cells in column order inside existing rows", () => {
    const wb = sampleWorkbook();
    wb.setCell("Q1", "C1", { value: "c" });
    wb.setCell("Q1", "B1", { value: "b" });
    const xml = strFromU8(unzipSync(wb.toBytes())[wb.sheet("Q1").path]!);
    expect(xml.indexOf('r="A1"')).toBeLessThan(xml.indexOf('r="B1"'));
    expect(xml.indexOf('r="B1"')).toBeLessThan(xml.indexOf('r="C1"'));
  });
});

describe("pivot engine", () => {
  const wb = sampleWorkbook();
  const ds = findDataset(wb)!;
  it("finds the data table and profiles columns", () => {
    expect(ds.sheet).toBe("Data");
    expect(ds.rows).toHaveLength(6);
    expect(profile(ds)).toContain('"Channel": text, 2 distinct: "Online", "Offline"');
  });
  it("computes exact grouped aggregates with matching live formulas", () => {
    const r = computePivot(ds, { rows: ["City"], measures: [{ field: "Order ID", agg: "count", label: "Orders" }, { field: "Units", agg: "sum" }, { field: "Order Value (₹)", agg: "sum", label: "Revenue" }] });
    expect(r.header).toEqual(["City", "Orders", "Sum of Units", "Revenue"]);
    // Sorted by the first measure (orders), descending.
    expect(r.body).toEqual([
      ["Pune", 3, 4, 6000],
      ["Delhi", 2, 4, 6000],
      ["Mumbai", 1, 2, 2500],
    ]);
    expect(r.totals).toEqual(["Grand Total", 6, 10, 14500]);
    expect(r.formulas[0]![1]).toBe('COUNTIFS(Data!$C$2:$C$7,"Pune")');
    expect(r.formulas[1]![3]).toBe('SUMIFS(Data!$E$2:$E$7,Data!$C$2:$C$7,"Delhi")');
  });
  it("pivots across a column and applies filters", () => {
    const r = computePivot(ds, { rows: ["City"], column: "Channel", measures: [{ field: "Order Value (₹)", agg: "sum" }], filters: [{ field: "Customer Type", op: "eq", value: "Returning" }] });
    expect(r.header).toEqual(["City", "Offline", "Online"]);
    const pune = r.body.find((x) => x[0] === "Pune")!;
    expect(pune).toEqual(["Pune", 5000, 0]);
    expect(r.formulas[r.body.indexOf(pune)]![1]).toBe('SUMIFS(Data!$E$2:$E$7,Data!$C$2:$C$7,"Pune",Data!$B$2:$B$7,"Offline",Data!$F$2:$F$7,"Returning")');
  });
  it("rejects unknown columns with a helpful message", () => {
    expect(() => computePivot(ds, { rows: ["Town"], measures: [{ field: "Units", agg: "sum" }] })).toThrow(/Unknown column "Town"/);
  });
  it("places the table with a totals SUM row and returns chart ranges; adds a native chart", () => {
    const r = computePivot(ds, { rows: ["City"], measures: [{ field: "Order Value (₹)", agg: "sum", label: "Revenue" }] });
    const p = placePivot(wb, "Q1", "A3", r, "Revenue by city");
    expect(wb.sheet("Q1").cells.get("A3")?.value).toBe("Revenue by city");
    expect(wb.sheet("Q1").cells.get("B8")).toMatchObject({ formula: "SUM(B5:B7)", value: 14500 });
    expect(p.categories).toBe("Q1!$A$5:$A$7");
    expect(p.series[0]).toEqual({ name: "Revenue", values: "Q1!$B$5:$B$7" });
    wb.addChart("Q1", "D3", { type: "column", title: "Revenue by city", categories: p.categories, series: p.series });
    const files = unzipSync(wb.toBytes());
    expect(Object.keys(files).some((k) => /^xl\/charts\/chart\d+\.xml$/.test(k))).toBe(true);
    expect(strFromU8(files[wb.sheet("Q1").path]!)).toContain("<drawing r:id=");
    expect(strFromU8(files["[Content_Types].xml"]!)).toContain("drawingml.chart+xml");
  });
});

describe("charts in Google-exported templates", () => {
  it("attaches charts to an existing empty self-closing drawing", async () => {
    const { strToU8, zipSync } = await import("fflate");
    const base = unzipSync(sampleWorkbook().toBytes());
    const q1 = Object.keys(base).find((k) => /sheet\d+\.xml$/.test(k) && strFromU8(base[k]!).includes("Find city-wise"))!;
    const file = q1.split("/").pop()!;
    base[`xl/worksheets/_rels/${file}.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
    base["xl/drawings/drawing1.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`);
    base[q1] = strToU8(strFromU8(base[q1]!).replace("</worksheet>", `<drawing r:id="rId1"/></worksheet>`));
    const wb = new Workbook(zipSync(base));
    wb.addChart("Q1", "D3", { type: "bar", title: "t", categories: "Q1!$A$5:$A$7", series: [{ name: "s", values: "Q1!$B$5:$B$7" }] });
    const out = unzipSync(wb.toBytes());
    const drawing = strFromU8(out["xl/drawings/drawing1.xml"]!);
    expect(drawing).toContain("<xdr:twoCellAnchor>");
    expect(drawing).toContain("</xdr:wsDr>");
    expect(strFromU8(out["xl/drawings/_rels/drawing1.xml.rels"]!)).toContain("../charts/chart1.xml");
  });
});

describe("slides", () => {
  it("builds a deck with a native chart and a table", async () => {
    const bytes = await buildDeck({
      title: "Where should the next stores go?",
      slides: [
        { title: "Offline wins in Pune", bullets: ["Pune offline revenue is 5,000"], chart: { type: "column", categories: ["Pune", "Delhi"], series: [{ name: "Revenue", values: [6000, 6000] }] } },
        { title: "Numbers", table: { headers: ["City", "Revenue"], rows: [["Pune", 6000]] } },
      ],
    });
    const files = unzipSync(bytes);
    expect(Object.keys(files).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))).toHaveLength(3);
    expect(Object.keys(files).some((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k))).toBe(true);
  });
});
