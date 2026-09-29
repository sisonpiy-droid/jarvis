import { MESA_TIMEZONE } from "./config";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** LMS rich text (TipTap-style HTML) → readable plain text. Not a sanitizer; output is never rendered as HTML. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote)>/gi, "\n\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/** Every http(s) href in a chunk of HTML, deduplicated, in order of appearance. */
export function extractLinks(html: string | null | undefined): string[] {
  if (!html) return [];
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeEntities(m[1] ?? "");
    if (/^https?:\/\//i.test(href)) out.add(href);
  }
  return [...out];
}

const SIGNING_PARAMS = /^(GoogleAccessId|Expires|Signature|X-Goog-.*)$/i;

/**
 * Storage links are signed and re-signed on every API response, so the raw URL
 * changes even when the file does not. This strips the signature for identity
 * and change detection; the signed URL is fetched fresh at download time.
 */
export function stableUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (SIGNING_PARAMS.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

export function isSignedUrl(url: string | null | undefined): boolean {
  return !!url && /[?&](Signature|X-Goog-Signature)=/i.test(url);
}

/** Parses an LMS timestamp. Returns null for missing or malformed values rather than an Invalid Date. */
export function parseDeadline(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: MESA_TIMEZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "Tue, 25 Aug 2026, 11:59 pm" in IST, or null. Assembled from parts: ICU punctuation varies by version. */
export function formatIst(value: string | null | undefined): string | null {
  const d = parseDeadline(value);
  if (!d) return null;
  const p = Object.fromEntries(IST.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase()}`;
}

/** "Data Driven Decision Making with Prof. Vinay Sharma" → "Prof. Vinay Sharma". */
export function instructorFromCourseTitle(title: string | null | undefined): string | null {
  const m = title?.match(/\bwith\s+((?:Prof\.?|Dr\.?|Mr\.?|Ms\.?)?\s*[^,|()]+)$/i);
  return m?.[1]?.trim() ?? null;
}
