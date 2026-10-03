// Notification text is written once, in the small HTML subset Telegram understands (<b> <i> <u> <s> <a>
// <code> <pre> and &lt; &gt; &amp; &quot;). These helpers turn it into what each channel needs: a push title and
// body (plain text), an email (safe HTML + plain text) and the in-app inbox (safe HTML).

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text: tags removed, entities decoded, whitespace tidied. Links keep their label only. */
export function toPlainText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SIMPLE = new Set(["b", "strong", "i", "em", "u", "s", "code", "pre"]);

/** Only allow links we can vouch for: http(s) and dashboard-relative paths. */
export function safeHref(href: string): string | null {
  const h = decodeEntities(href.trim());
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  return null;
}

/**
 * Safe HTML for the inbox and email: every tag outside the allow-list is dropped (its text kept and escaped),
 * attributes other than a validated href are discarded, and line breaks become <br>.
 */
export function toSafeHtml(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  // A tag name must follow "<" directly, and a tag never contains another "<" — so "a < b" stays text.
  const re = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*)?>|([^<]+)|(<)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [, closing, rawName, attrs, text, stray] = m;
    if (text !== undefined) {
      out.push(escapeHtml(decodeEntities(text)).replace(/\n/g, "<br>"));
      continue;
    }
    if (stray !== undefined) {
      out.push("&lt;");
      continue;
    }
    const name = rawName!.toLowerCase();
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (name === "br") {
      out.push("<br>");
    } else if (SIMPLE.has(name)) {
      out.push(`<${name}>`);
      open.push(name);
    } else if (name === "a") {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs ?? "");
      const safe = href ? safeHref(href[1] ?? href[2] ?? "") : null;
      if (safe) {
        const external = /^https?:/i.test(safe);
        out.push(`<a href="${escapeHtml(safe)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>`);
        open.push("a");
      }
    }
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("");
}

export interface Rendered {
  /** First line, plain text. */
  title: string;
  /** Everything after the first line, plain text. */
  body: string;
  /** Full message, safe HTML. */
  html: string;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** Splits a notification into title + body; push services cap payloads, so both are bounded. */
export function renderNotification(text: string, limits = { title: 120, body: 400 }): Rendered {
  const plain = toPlainText(text);
  const [first = "", ...rest] = plain.split("\n");
  return { title: clip(first.trim() || "JARVIS", limits.title), body: clip(rest.join("\n").trim(), limits.body), html: toSafeHtml(text) };
}
