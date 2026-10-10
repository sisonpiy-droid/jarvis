import type { Sql } from "./client";
import { addDays, istDay, type Day } from "./progress";

// Books read a piece a day (migration 0026). Pure splitting + the small amount of SQL the reading job, chat tools,
// Telegram commands and the /reading page share. Sending and summarising live in @jarvis/ai (reading.ts).

/** A book should take about this many days, however long it is (a 100-page book ≈ 40–50 days). */
export const BOOK_DAYS = 45;
const MIN_PIECE_WORDS = 300;
const MAX_PIECE_WORDS = 1000;
const MIN_BOOK_WORDS = 150;

export interface Piece {
  label: string | null;
  body: string;
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** One paragraph's worth of text cut at sentence ends into chunks of at most `max` words. */
function chunkSentences(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?”"])\s+/)) {
    if (cur && words(cur) + words(s) > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Splits a book's text into pieces of about a page: paragraph by paragraph, aiming at total ÷ BOOK_DAYS words
 * (clamped to 300–1000), never cutting mid-paragraph unless one paragraph is huge. "[page N]" markers (PDF text)
 * give each piece a page range.
 */
export function splitIntoPieces(raw: string, days = BOOK_DAYS): Piece[] {
  const paras: Array<{ text: string; page: number | null }> = [];
  let page: number | null = null;
  let block: string[] = [];
  const flush = () => {
    const t = block.join(" ").replace(/(\w)- (?=[a-z])/g, "$1").replace(/\s+/g, " ").trim();
    if (t) paras.push({ text: t, page });
    block = [];
  };
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const m = /^\[page (\d+)\]$/.exec(line.trim());
    if (m) {
      flush();
      page = Number(m[1]);
    } else if (!line.trim()) flush();
    else block.push(line.trim());
  }
  flush();
  const total = paras.reduce((n, p) => n + words(p.text), 0);
  if (total < MIN_BOOK_WORDS) throw new Error("that text is too short to read over several days");
  const target = Math.min(MAX_PIECE_WORDS, Math.max(MIN_PIECE_WORDS, Math.round(total / days)));
  const pieces: Array<{ parts: string[]; w: number; from: number | null; to: number | null }> = [];
  let cur: (typeof pieces)[number] | null = null;
  for (const p of paras) {
    for (const chunk of words(p.text) > target * 1.5 ? chunkSentences(p.text, target) : [p.text]) {
      if (!cur || cur.w >= target) {
        cur = { parts: [], w: 0, from: p.page, to: p.page };
        pieces.push(cur);
      }
      cur.parts.push(chunk);
      cur.w += words(chunk);
      cur.to = p.page ?? cur.to;
    }
  }
  // A short tail joins the piece before it rather than getting a day of its own.
  const last = pieces[pieces.length - 1];
  const prev = pieces[pieces.length - 2];
  if (last && prev && last.w < target * 0.4) {
    prev.parts.push(...last.parts);
    prev.w += last.w;
    prev.to = last.to ?? prev.to;
    pieces.pop();
  }
  return pieces.map((p) => ({ label: p.from == null ? null : p.from === p.to || p.to == null ? `p. ${p.from}` : `pp. ${p.from}–${p.to}`, body: p.parts.join("\n\n") }));
}

export interface Book {
  id: number;
  title: string;
  author: string | null;
  source: "pdf" | "public_domain";
  status: "active" | "paused" | "done";
  totalPieces: number;
  nextPiece: number;
  nextDay: Day;
  summary: string;
  summaryUpto: number;
}

const toBook = (r: Record<string, unknown>): Book => ({
  id: Number(r.id),
  title: String(r.title),
  author: (r.author as string | null) ?? null,
  source: r.source as Book["source"],
  status: r.status as Book["status"],
  totalPieces: Number(r.total_pieces),
  nextPiece: Number(r.next_piece),
  nextDay: String(r.next_day instanceof Date ? r.next_day.toISOString().slice(0, 10) : r.next_day).slice(0, 10),
  summary: String(r.summary ?? ""),
  summaryUpto: Number(r.summary_upto),
});

/** Splits the text and stores the book; the first piece is due today. */
export async function createBook(sql: Sql, b: { title: string; author?: string | null; source: Book["source"]; fileSha?: string | null; text: string }, now: Date): Promise<Book> {
  const pieces = splitIntoPieces(b.text);
  return sql.begin(async (tx) => {
    const [r] = await tx`
      insert into jarvis.books (title, author, source, file_sha, total_pieces, next_day)
      values (${b.title.slice(0, 200)}, ${b.author?.slice(0, 200) ?? null}, ${b.source}, ${b.fileSha ?? null}, ${pieces.length}, ${istDay(now)}) returning *`;
    for (const [i, p] of pieces.entries()) await tx`insert into jarvis.book_pieces (book_id, n, label, body) values (${r!.id}, ${i + 1}, ${p.label}, ${p.body})`;
    return toBook(r!);
  });
}

export async function getBook(sql: Sql, id: number): Promise<Book | null> {
  const [r] = await sql`select * from jarvis.books where id = ${id}`;
  return r ? toBook(r) : null;
}

export async function listBooks(sql: Sql, status?: Book["status"]): Promise<Book[]> {
  return (await (status ? sql`select * from jarvis.books where status = ${status} order by id` : sql`select * from jarvis.books order by id`)).map(toBook);
}

/** The one active book, when there is exactly one (so "next" needs no name). */
export async function onlyActiveBook(sql: Sql): Promise<Book | null> {
  const active = await listBooks(sql, "active");
  return active.length === 1 ? active[0]! : null;
}

export async function bookPiece(sql: Sql, bookId: number, n: number): Promise<{ n: number; label: string | null; body: string } | null> {
  const [r] = await sql`select n, label, body from jarvis.book_pieces where book_id = ${bookId} and n = ${n}`;
  return r ? { n: Number(r.n), label: (r.label as string | null) ?? null, body: String(r.body) } : null;
}

/** Active books whose next piece is due today or earlier. */
export async function booksDue(sql: Sql, now: Date): Promise<Book[]> {
  return (await sql`select * from jarvis.books where status = 'active' and next_day <= ${istDay(now)} order by id`).map(toBook);
}

/** Piece n went out today: the next one is due tomorrow, or the book is finished. */
export async function markPieceSent(sql: Sql, book: Book, n: number, now: Date): Promise<void> {
  const done = n >= book.totalPieces;
  await sql`update jarvis.books set next_piece = ${n + 1}, next_day = ${addDays(istDay(now), 1)}, status = ${done ? "done" : "active"} where id = ${book.id}`;
}

/** Pushes the next piece back by `days` (it is due on a later day; nothing is skipped). */
export async function postponeBook(sql: Sql, bookId: number, days: number): Promise<Book | null> {
  const book = await getBook(sql, bookId);
  if (!book || book.status !== "active") return null;
  const [r] = await sql`update jarvis.books set next_day = ${addDays(book.nextDay, Math.max(1, Math.min(30, Math.round(days))))} where id = ${bookId} returning *`;
  return toBook(r!);
}

export async function setBookStatus(sql: Sql, bookId: number, status: "active" | "paused"): Promise<boolean> {
  return (await sql`update jarvis.books set status = ${status} where id = ${bookId} and status <> 'done' returning id`).length === 1;
}

export async function deleteBook(sql: Sql, bookId: number): Promise<boolean> {
  return (await sql`delete from jarvis.books where id = ${bookId} returning id`).length === 1;
}

export async function saveBookSummary(sql: Sql, bookId: number, summary: string, upto: number): Promise<void> {
  await sql`update jarvis.books set summary = ${summary}, summary_upto = ${upto} where id = ${bookId}`;
}
