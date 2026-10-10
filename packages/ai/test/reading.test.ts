import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { splitForTelegram, TelegramChannel } from "@jarvis/notify";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { findPublicDomainBook, stripGutenberg } from "../src/book-source";
import { bookTools } from "../src/book-tools";
import { commandReply } from "../src/bot";
import { deliverPiece, runReading } from "../src/reading";
import { say, scripted } from "./scripted";

// "Give me the name of a book (or a PDF): day one the introduction and first page; from day two the next piece and a
// summary of all the days before; ask for the next one early or postpone; a 100-page book takes about 40–50 days."

const MON_6AM = new Date("2026-10-12T00:30:00.000Z"); // 06:00 IST — before reading time
const day = (n: number, hh = "02:00") => new Date(`2026-10-${String(12 + n).padStart(2, "0")}T${hh}:00.000Z`); // 07:30 IST on day n (0 = Mon 12 Oct)

const para = (i: number) => `${Array.from({ length: 50 }, (_, k) => `w${i}x${k}`).join(" ")}.`;
/** A 100-page book: 400 words a page, "[page N]" markers like extracted PDF text. */
const BOOK = Array.from({ length: 100 }, (_, p) => `[page ${p + 1}]\n${Array.from({ length: 8 }, (_, q) => para(p * 8 + q)).join("\n\n")}`).join("\n\n");
const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.books, jarvis.notifications, jarvis.files, jarvis.chat_messages restart identity cascade`;
});

const SUMMARY = (s: string) => say(JSON.stringify({ summary: s }));
const sent = async () => await t.sql`select dedupe_key, text from jarvis.notifications where dedupe_key like 'reading:%' order by id`;

describe("splitting", () => {
  it("a 100-page book becomes about 45 pieces of about a page, none lost", () => {
    const pieces = db.splitIntoPieces(BOOK);
    expect(pieces.length).toBeGreaterThanOrEqual(40);
    expect(pieces.length).toBeLessThanOrEqual(50);
    for (const p of pieces) expect(wc(p.body)).toBeGreaterThanOrEqual(300);
    for (const p of pieces) expect(wc(p.body)).toBeLessThanOrEqual(1000);
    expect(pieces.reduce((n, p) => n + wc(p.body), 0)).toBe(40_000);
    expect(pieces[0]!.label).toMatch(/^pp\. 1–\d+$/);
    expect(pieces.at(-1)!.label).toMatch(/100$/);
  });

  it("cuts a wall of text at sentence ends, and refuses a text too short to spread over days", () => {
    const wall = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} has exactly ten plain words in it right here.`).join(" ");
    const pieces = db.splitIntoPieces(wall);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((p) => p.body.endsWith("."))).toBe(true);
    expect(() => db.splitIntoPieces("Too short.")).toThrow(/too short/);
  });
});

describe("the daily reading", () => {
  it("day one: the beginning only, from 7 am, once a day; day two: the next piece with a summary of the days before", async () => {
    const book = await db.createBook(t.sql, { title: "Pride and Prejudice", author: "Jane Austen", source: "public_domain", text: BOOK }, day(0));
    expect(await runReading(t.sql, null, MON_6AM)).toEqual([]); // before 7:00 IST
    const { model } = scripted(SUMMARY("Mr Bennet's family hears that a rich bachelor is moving nearby."));

    const d1 = await runReading(t.sql, model, day(0));
    expect(d1).toEqual([{ bookId: book.id, title: "Pride and Prejudice", n: 1, total: book.totalPieces, finished: false }]);
    expect((await runReading(t.sql, model, day(0, "04:00"))).length).toBe(0); // same morning again: nothing
    const [n1] = await sent();
    expect(n1!.dedupe_key).toBe(`reading:${book.id}:1`);
    expect(String(n1!.text)).toContain(`<b>Pride and Prejudice</b> · day 1 of ${book.totalPieces} · pp. 1–`);
    expect(String(n1!.text)).toContain("Today's reading — the beginning");
    expect(String(n1!.text)).not.toContain("The story so far");
    expect(String(n1!.text)).toContain("w0x0 w0x1");

    const d2 = await runReading(t.sql, model, day(1));
    expect(d2[0]!.n).toBe(2);
    const text2 = String((await sent())[1]!.text);
    expect(text2).toContain("day 2 of");
    expect(text2).toContain("<b>The story so far</b>\nMr Bennet's family hears that a rich bachelor is moving nearby.");
    expect(text2).toContain("Today's reading</b>\n"); // not "the beginning"
    expect(text2).not.toContain(String((await db.bookPiece(t.sql, book.id, 1))!.body.slice(0, 40))); // the new piece, not a repeat
    expect(await db.getBook(t.sql, book.id)).toMatchObject({ nextPiece: 3, summaryUpto: 1, nextDay: "2026-10-14" });
  });

  it("the summary is rolled forward from the one before and the piece it covers", async () => {
    const book = await db.createBook(t.sql, { title: "B", source: "pdf", text: BOOK }, day(0));
    const { model, requests } = scripted(SUMMARY("S1: the opening of the story, in a few words."), SUMMARY("S2: the opening, then the journey begins in earnest."));
    await runReading(t.sql, model, day(0));
    await runReading(t.sql, model, day(1));
    await runReading(t.sql, model, day(2));
    const second = JSON.stringify(requests[1]!.messages);
    expect(second).toContain("S1: the opening of the story"); // what it already knew
    expect(second).toContain((await db.bookPiece(t.sql, book.id, 2))!.body.slice(0, 20)); // plus yesterday's piece
    expect(String((await sent())[2]!.text)).toContain("S2: the opening, then the journey begins in earnest.");
  });

  it("'next' sends the next piece now; tomorrow's follows as usual", async () => {
    const book = await db.createBook(t.sql, { title: "B", source: "pdf", text: BOOK }, day(0));
    const { model } = scripted(SUMMARY("one"), SUMMARY("two"));
    await runReading(t.sql, model, day(0)); // piece 1, morning
    const next = bookTools(t.sql, model, () => day(0, "05:00")).find((x) => x.name === "next_reading")!;
    expect(await next.run({})).toMatchObject({ sent: true, title: "B", piece: 2 });
    expect((await sent()).map((n) => n.dedupe_key)).toEqual([`reading:${book.id}:1`, `reading:${book.id}:2`]);
    expect((await runReading(t.sql, model, day(0, "06:00"))).length).toBe(0); // no third piece today
    expect((await runReading(t.sql, model, day(1)))[0]!.n).toBe(3); // tomorrow continues
  });

  it("'postpone' moves the same piece to a later day — nothing is skipped", async () => {
    const book = await db.createBook(t.sql, { title: "B", source: "pdf", text: BOOK }, day(0));
    await runReading(t.sql, null, day(0)); // piece 1
    const post = bookTools(t.sql, null, () => day(0)).find((x) => x.name === "postpone_reading")!;
    expect(await post.run({ days: 1 })).toMatchObject({ postponed: true, book: { next_piece: 2, next_due: "2026-10-14" } });
    expect(await runReading(t.sql, null, day(1))).toEqual([]); // postponed: nothing tomorrow
    expect((await runReading(t.sql, null, day(2)))[0]!.n).toBe(2); // the very next piece, a day late
    expect((await db.getBook(t.sql, book.id))!.nextDay).toBe("2026-10-15");
  });

  it("without a model the reading still arrives (just no fresh summary), and the last piece finishes the book", async () => {
    const book = await db.createBook(t.sql, { title: "B", source: "pdf", text: BOOK }, day(0));
    await t.sql`update jarvis.books set next_piece = ${book.totalPieces}, summary = 'Earlier.', summary_upto = ${book.totalPieces - 1} where id = ${book.id}`;
    const d = await deliverPiece(t.sql, null, book.id, day(5));
    expect(d).toMatchObject({ n: book.totalPieces, finished: true });
    expect(String((await sent())[0]!.text)).toContain("you've finished the book");
    expect(await db.getBook(t.sql, book.id)).toMatchObject({ status: "done" });
    expect(await deliverPiece(t.sql, null, book.id, day(6))).toBeNull();
  });

  it("paused books are left alone", async () => {
    const book = await db.createBook(t.sql, { title: "B", source: "pdf", text: BOOK }, day(0));
    await db.setBookStatus(t.sql, book.id, "paused");
    expect(await runReading(t.sql, null, day(0))).toEqual([]);
  });
});

describe("starting a book", () => {
  /** Gutenberg's catalog search (an OPDS feed) and its plain-text files. */
  const gutendex = (results: Array<{ id: number; title: string; author?: string }>) =>
    (async (url: string) => {
      if (String(url).includes("search.opds")) {
        const entries = results.map((r) => `<entry><id>https://www.gutenberg.org/ebooks/${r.id}.opds</id><title>${r.title}</title><content type="text">${r.author ?? ""}</content></entry>`);
        return new Response(`<feed><entry><id>https://www.gutenberg.org/ebooks/subjects/search.opds/?query=x</id><title>Subjects</title></entry>${entries.join("")}</feed>`);
      }
      return new Response(`Licence blah\n*** START OF THE PROJECT GUTENBERG EBOOK PRIDE ***\n${BOOK}\n*** END OF THE PROJECT GUTENBERG EBOOK PRIDE ***\nMore licence`);
    }) as unknown as typeof fetch;
  const entry = { id: 1342, title: "Pride and Prejudice", author: "Austen, Jane" };
  const collection = { id: 31100, title: "The Complete Works of Jane Austen, Pride and Prejudice included", author: "Jane Austen" };
  const start = (a: Record<string, unknown>, f: typeof fetch) => bookTools(t.sql, null, () => day(0), f).find((x) => x.name === "start_book")!.run(a) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("finds a public-domain book by title, strips the Gutenberg licence, and starts it", async () => {
    expect(stripGutenberg("x\n*** START OF THE PROJECT GUTENBERG EBOOK A ***\nBODY\n*** END OF THE PROJECT GUTENBERG EBOOK A ***\ny")).toBe("BODY");
    const found = await findPublicDomainBook("pride and prejudice", gutendex([collection, entry])); // the closest title wins
    expect(found).toMatchObject({ title: "Pride and Prejudice", author: "Jane Austen" });
    expect(found!.text.startsWith("[page 1]")).toBe(true);
    const r = await start({ title: "Pride and Prejudice" }, gutendex([entry]));
    expect(r).toMatchObject({ started: true, book: { title: "Pride and Prejudice", author: "Jane Austen" } });
    expect(r.book.of).toBeGreaterThanOrEqual(40);
    expect(await db.listBooks(t.sql)).toHaveLength(1);
  });

  it("won't invent a book it can't fetch: a copyrighted title asks for the PDF", async () => {
    const r = await start({ title: "Atomic Habits" }, gutendex([{ id: 9, title: "Atomic Theory of Matter" }]));
    expect(r).toMatchObject({ started: false });
    expect(String(r.reason)).toContain("Send me the PDF");
    expect(await db.listBooks(t.sql)).toHaveLength(0);
  });

  it("starts from a shared PDF's text, and says so when the PDF has no text", async () => {
    await t.sql`insert into jarvis.files (sha256, storage_path, size_bytes, original_filename, text_status, text_content) values ('a', 'p/a', 1, 'Zero to One.pdf', 'done', ${BOOK}), ('b', 'p/b', 1, 'Scan.pdf', 'original', null)`;
    expect(await start({ file_id: "a" }, gutendex([]))).toMatchObject({ started: true, book: { title: "Zero to One" } });
    expect(await start({ file_id: "b" }, gutendex([]))).toMatchObject({ started: false });
    expect((await db.listBooks(t.sql))[0]).toMatchObject({ source: "pdf" });
  });
});

describe("Telegram", () => {
  it("splits long messages at paragraph breaks and sends them in order", async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"word ".repeat(100)}`.trim()).join("\n\n"); // ~6,500 chars
    const parts = splitForTelegram(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    expect(parts.join("\n\n")).toBe(text);
    expect(splitForTelegram("short")).toEqual(["short"]);
    const posted: string[] = [];
    const f = (async (_u: string, init: RequestInit) => (posted.push(JSON.parse(String(init.body)).text), Response.json({ ok: true, result: { message_id: posted.length } }))) as unknown as typeof fetch;
    expect(await new TelegramChannel("T", "1", f).send(text)).toBe(String(parts.length));
    expect(posted).toEqual(parts);
  });

  it("/read sends the next piece, /postpone moves it", async () => {
    const book = await db.createBook(t.sql, { title: "B", source: "pdf", text: BOOK }, day(0));
    const { model } = scripted(SUMMARY("one"));
    const deps = { sql: t.sql, token: "T", ownerChatId: "1", model, now: () => day(0) };
    expect(await commandReply(deps, "/read")).toContain("Piece 1 of");
    expect(await commandReply(deps, "/postpone", "2")).toContain(`piece 2 of ${book.totalPieces} moved to 2026-10-15`);
    await db.deleteBook(t.sql, book.id);
    expect(await commandReply(deps, "/read")).toContain("No book is being read");
  });
});
