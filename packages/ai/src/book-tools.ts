import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { Tool } from "./agent";
import { findPublicDomainBook } from "./book-source";
import type { ModelProvider } from "./model";
import { deliverPiece } from "./reading";

// Chat tools for the daily book reading: start a book (by title when it is public domain, or from a PDF the owner
// shared), send the next piece now, postpone, pause or drop. The reading itself goes out as notifications.

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const show = (b: db.Book) => ({ id: b.id, title: b.title, author: b.author, status: b.status, next_piece: Math.min(b.nextPiece, b.totalPieces), of: b.totalPieces, next_due: b.nextDay });

export function bookTools(sql: Sql, model: ModelProvider | null, now: () => Date = () => new Date(), fetchImpl: typeof fetch = fetch): Tool[] {
  /** The book meant: the id given, or the only active one. */
  async function pick(id: unknown): Promise<{ book: db.Book } | { fail: Record<string, unknown> }> {
    const book = id != null ? await db.getBook(sql, Number(id)) : await db.onlyActiveBook(sql);
    if (book) return { book };
    const books = await db.listBooks(sql);
    return { fail: { ok: false, reason: id != null ? "no book with that id" : books.some((b) => b.status === "active") ? "several books are active — ask which one" : "no book is being read", books: books.map(show) } };
  }

  return [
    {
      name: "start_book",
      effect: "write-local",
      description:
        "Start reading a book with the owner, one piece (about a page) a day for ~45 days: day one is the beginning, each next day the next piece plus a summary of the days before. Pass file_id when they shared a PDF (a 'Shared file' line); otherwise pass the title — only public-domain books can be fetched by title. Copyrighted books must come as the owner's PDF: say so, don't invent text.",
      parameters: obj({ title: { type: "string" }, author: { type: "string" }, file_id: { type: "string", description: "From a 'Shared file' line, for a PDF/Word/text book" } }),
      async run(a) {
        let text: string;
        let title = str(a.title);
        let author = str(a.author) || null;
        let source: "pdf" | "public_domain" = "pdf";
        const fileId = str(a.file_id);
        if (fileId) {
          const [f] = await sql`select original_filename, text_status, text_content from jarvis.files where sha256 = ${fileId}`;
          if (!f) return { started: false, reason: "no such file" };
          if (f.text_status !== "done" || !f.text_content) return { started: false, reason: "that file has no readable text (a scanned PDF?). Send a PDF with selectable text." };
          text = String(f.text_content);
          title ||= String(f.original_filename ?? "Book").replace(/\.[a-z0-9]+$/i, "");
        } else {
          if (!title) return { started: false, reason: "which book? Give a title, or share the PDF." };
          source = "public_domain";
          const found = await findPublicDomainBook(title, fetchImpl);
          if (!found) {
            return { started: false, reason: "I can only fetch public-domain books by title, and that one isn't (it's probably still under copyright). Send me the PDF and I'll read it with you." };
          }
          text = found.text;
          title = found.title;
          author ||= found.author;
        }
        try {
          const book = await db.createBook(sql, { title, author, source, fileSha: fileId || null, text }, now());
          return { started: true, book: show(book), note: "The first piece (the beginning) arrives this morning from 7 am, or right away with next_reading. About 45 days in all. Tell the owner which book and edition you found so they can say if it's the wrong one." };
        } catch (err) {
          return { started: false, reason: err instanceof Error ? err.message : "couldn't split that text" };
        }
      },
    },
    {
      name: "list_books",
      effect: "read",
      description: "The books being read (and finished or paused ones), with progress and when the next piece is due.",
      parameters: obj({}),
      async run() {
        return { books: (await db.listBooks(sql)).map(show) };
      },
    },
    {
      name: "next_reading",
      effect: "write-local",
      description: "Send the next piece of the book now, instead of waiting for tomorrow morning. It arrives as a message within about a minute. Omit book_id when only one book is active.",
      parameters: obj({ book_id: { type: "integer" } }),
      async run(a) {
        const p = await pick(a.book_id);
        if ("fail" in p) return p.fail;
        const d = await deliverPiece(sql, model, p.book.id, now());
        return d ? { sent: true, title: d.title, piece: d.n, of: d.total, finished: d.finished, note: "It arrives as a message within about a minute; tomorrow's piece follows as usual." } : { sent: false, reason: "that book has no piece left to send, or isn't active" };
      },
    },
    {
      name: "postpone_reading",
      effect: "write-local",
      description: "Push the next piece back by some days (default 1) — nothing is skipped; the same piece arrives later. Omit book_id when only one book is active.",
      parameters: obj({ days: { type: "integer", description: "default 1, max 30" }, book_id: { type: "integer" } }),
      async run(a) {
        const p = await pick(a.book_id);
        if ("fail" in p) return p.fail;
        const b = await db.postponeBook(sql, p.book.id, a.days != null ? Number(a.days) : 1);
        return b ? { postponed: true, book: show(b) } : { postponed: false, reason: "that book isn't active" };
      },
    },
    {
      name: "manage_book",
      effect: "write-local",
      description: "Pause, resume or drop (delete) a book. Only on the owner's request.",
      parameters: obj({ book_id: { type: "integer" }, action: { type: "string", enum: ["pause", "resume", "drop"] } }, ["book_id", "action"]),
      async run(a) {
        const id = Number(a.book_id);
        if (a.action === "drop") return { dropped: await db.deleteBook(sql, id) };
        return { ok: await db.setBookStatus(sql, id, a.action === "pause" ? "paused" : "active"), action: a.action };
      },
    },
  ];
}
