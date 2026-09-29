import PptxGenJS from "pptxgenjs";

// Slide decks from a structured spec. Charts are native PowerPoint charts
// (editable in PowerPoint/Google Slides), fed from JARVIS-computed numbers.

export interface SlideChart {
  type: "bar" | "column" | "line" | "pie";
  title?: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}
export interface SlideSpec {
  title: string;
  subtitle?: string;
  bullets?: string[];
  chart?: SlideChart | null;
  table?: { headers: string[]; rows: Array<Array<string | number>> } | null;
  notes?: string;
  kind?: "title" | "content" | "section";
}
export interface DeckSpec {
  title: string;
  subtitle?: string;
  slides: SlideSpec[];
}

const INK = "1F2A37";
const ACCENT = "2F5BD3";
const MUTED = "6B7280";
const PALETTE = ["2F5BD3", "1F8A53", "E07A2E", "8B5CF6", "C2413A", "0EA5A4", "B7791F"];

const fmtNum = (v: string | number) => (typeof v === "number" ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-IN") : String(Math.round(v * 100) / 100)) : v);

export async function buildDeck(spec: DeckSpec): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 in
  pptx.title = spec.title;
  pptx.defineSlideMaster({
    title: "JARVIS",
    background: { color: "FFFFFF" },
    objects: [{ rect: { x: 0, y: 7.2, w: 13.33, h: 0.3, fill: { color: "F3F4F6" } } }],
    slideNumber: { x: 12.6, y: 7.22, w: 0.6, h: 0.25, fontSize: 9, color: MUTED },
  });

  const titleSlide = pptx.addSlide({ masterName: "JARVIS" });
  titleSlide.addShape("rect", { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: ACCENT } });
  titleSlide.addText(spec.title, { x: 0.9, y: 2.3, w: 11.5, h: 1.4, fontSize: 38, bold: true, color: INK, fontFace: "Calibri" });
  if (spec.subtitle) titleSlide.addText(spec.subtitle, { x: 0.9, y: 3.8, w: 11.5, h: 0.8, fontSize: 18, color: MUTED, fontFace: "Calibri" });

  for (const s of spec.slides) {
    const slide = pptx.addSlide({ masterName: "JARVIS" });
    if (s.kind === "section") {
      slide.addShape("rect", { x: 0, y: 0, w: 13.33, h: 7.2, fill: { color: ACCENT } });
      slide.addText(s.title, { x: 0.9, y: 2.8, w: 11.5, h: 1.2, fontSize: 34, bold: true, color: "FFFFFF" });
      if (s.subtitle) slide.addText(s.subtitle, { x: 0.9, y: 4, w: 11.5, h: 0.7, fontSize: 16, color: "E5E7EB" });
      if (s.notes) slide.addNotes(s.notes);
      continue;
    }
    slide.addText(s.title, { x: 0.6, y: 0.35, w: 12.1, h: 0.8, fontSize: 26, bold: true, color: INK, fontFace: "Calibri" });
    slide.addShape("line", { x: 0.6, y: 1.15, w: 1.2, h: 0, line: { color: ACCENT, width: 2.5 } });
    const hasVisual = !!(s.chart || s.table);
    const bullets = (s.bullets ?? []).filter(Boolean);
    if (bullets.length) {
      slide.addText(
        bullets.map((b) => ({ text: b, options: { bullet: { indent: 18 }, paraSpaceAfter: 8 } })),
        { x: 0.6, y: 1.45, w: hasVisual ? 5.3 : 12.1, h: 5.5, fontSize: hasVisual ? 15 : 18, color: INK, valign: "top", fontFace: "Calibri" },
      );
    }
    const vx = bullets.length ? 6.2 : 0.6;
    const vw = bullets.length ? 6.5 : 12.1;
    if (s.chart && s.chart.categories.length) {
      const c = s.chart;
      const type = c.type === "pie" ? pptx.ChartType.pie : c.type === "line" ? pptx.ChartType.line : pptx.ChartType.bar;
      slide.addChart(
        type,
        c.series.map((sr) => ({ name: sr.name, labels: c.categories, values: sr.values.map((v) => (Number.isFinite(v) ? v : 0)) })),
        {
          x: vx,
          y: 1.45,
          w: vw,
          h: 5.5,
          barDir: c.type === "bar" ? "bar" : "col",
          chartColors: PALETTE,
          showTitle: !!c.title,
          title: c.title ?? "",
          titleFontSize: 13,
          showLegend: c.series.length > 1 || c.type === "pie",
          legendPos: "b",
          catAxisLabelFontSize: 11,
          valAxisLabelFontSize: 10,
          valAxisLabelFormatCode: "#,##0",
          dataLabelFormatCode: "#,##0",
          showValue: c.series.length === 1 && c.categories.length <= 12,
          dataLabelFontSize: 9,
          ...(c.type === "pie" ? { showPercent: true, showValue: false } : {}),
        },
      );
    } else if (s.table) {
      const rows = [
        s.table.headers.map((h) => ({ text: String(h), options: { bold: true, fill: { color: "EEF2FF" }, color: INK } })),
        ...s.table.rows.slice(0, 14).map((r) => r.map((v) => ({ text: String(fmtNum(v)), options: { color: INK } }))),
      ];
      slide.addTable(rows, { x: vx, y: 1.45, w: vw, fontSize: 11, border: { type: "solid", color: "D1D5DB", pt: 0.75 }, autoPage: false });
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  const out = (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
  return out;
}
