// Small, escape-first Markdown → HTML renderer for drafts (headings, lists,
// tables, blockquotes, bold/italic/code, https links). Everything is HTML-
// escaped before any tag is introduced, so model output can't inject markup.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) {
      flushPara();
      closeList();
      continue;
    }
    if (/^\|.*\|$/.test(t)) {
      flushPara();
      closeList();
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i]!.trim())) {
        const cells = lines[i]!.trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      const [head, ...body] = rows;
      out.push(
        `<div class="md-table"><table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flushPara();
      closeList();
      const level = Math.min(4, h[1]!.length + 1);
      out.push(`<h${level}>${inline(h[2]!.replace(/\*\*/g, ""))}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      out.push("<hr>");
      continue;
    }
    const b = /^[-*•]\s+(.*)$/.exec(t);
    const n = /^\d+[.)]\s+(.*)$/.exec(t);
    if (b || n) {
      flushPara();
      const kind = b ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((b ?? n)![1]!)}</li>`);
      continue;
    }
    if (t.startsWith(">")) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(t.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    closeList();
    para.push(t);
  }
  flushPara();
  closeList();
  return out.join("\n");
}
