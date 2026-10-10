// Getting a book's text from its title. Only public-domain books can be fetched (Project Gutenberg's own catalog
// search, then its plain-text file); anything under copyright has to come in as the owner's own PDF.
// Nothing is guessed or generated.

export interface FoundBook {
  title: string;
  author: string | null;
  text: string;
}

const STOP = new Set(["the", "a", "an", "of", "and", "by", "book", "novel"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
const xml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(?:39|x27);|&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** "Austen, Jane" → "Jane Austen". */
const person = (n: string) => (n.includes(",") ? n.split(",").map((s) => s.trim()).reverse().join(" ") : n);

/** Project Gutenberg's licence header and footer are not the book. */
export function stripGutenberg(text: string): string {
  const t = text.replace(/\r/g, "");
  const start = /\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i.exec(t);
  const end = /\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.exec(t);
  return t.slice(start ? start.index + start[0].length : 0, end && end.index > (start?.index ?? 0) ? end.index : undefined).trim();
}

/** Catalog entries (id, title, author) from an OPDS search page; subject/author listings have no book id and are skipped. */
export function parseCatalog(feed: string): Array<{ id: number; title: string; author: string | null }> {
  const out: Array<{ id: number; title: string; author: string | null }> = [];
  for (const m of feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /\/ebooks\/(\d+)\.opds/.exec(m[1] ?? "")?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(m[1] ?? "")?.[1];
    if (!id || !title) continue;
    const author = /<content type="text">([^<]*)<\/content>/.exec(m[1] ?? "")?.[1];
    out.push({ id: Number(id), title: xml(title), author: author ? person(xml(author)) : null });
  }
  return out;
}

/** The public-domain book whose title has every significant word asked for (the closest title wins), with its full text; null if there is none. */
export async function findPublicDomainBook(query: string, fetchImpl: typeof fetch = fetch): Promise<FoundBook | null> {
  const want = words(query);
  if (!want.length) return null;
  const res = await fetchImpl(`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`book search failed (HTTP ${res.status})`);
  const hit = parseCatalog(await res.text())
    .filter((b) => {
      const have = new Set(words(b.title));
      return want.every((w) => have.has(w));
    })
    .sort((a, b) => words(a.title).length - words(b.title).length)[0]; // "Pride and Prejudice" before "The Complete Works of Jane Austen"
  if (!hit) return null;
  const body = await fetchImpl(`https://www.gutenberg.org/cache/epub/${hit.id}/pg${hit.id}.txt`, { signal: AbortSignal.timeout(30_000) });
  if (!body.ok) throw new Error(`couldn't download the book (HTTP ${body.status})`);
  return { title: hit.title, author: hit.author, text: stripGutenberg(await body.text()) };
}
