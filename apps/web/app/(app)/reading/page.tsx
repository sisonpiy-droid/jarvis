import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bookPiece, deleteBook, listBooks, postponeBook, setBookStatus } from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import { deliverPiece } from "@jarvis/ai";
import { isSignedIn } from "@/lib/auth";
import { aiModel } from "@/lib/ai";
import { sql } from "@/lib/passkey";
import { Badge, Empty, Section } from "../ui";

export const dynamic = "force-dynamic";

// The daily book: a piece (about a page) each morning with a summary of the days before. Start a book by telling
// JARVIS in chat (a title, or a shared PDF). From here: send the next piece now, postpone it, pause or drop.

async function act(form: FormData) {
  "use server";
  if (!(await isSignedIn())) redirect("/login");
  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) return;
  const db = sql() as unknown as Sql;
  switch (form.get("do")) {
    case "next":
      await deliverPiece(db, aiModel(), id, new Date());
      break;
    case "postpone":
      await postponeBook(db, id, 1);
      break;
    case "pause":
      await setBookStatus(db, id, "paused");
      break;
    case "resume":
      await setBookStatus(db, id, "active");
      break;
    case "drop":
      await deleteBook(db, id);
      break;
  }
  revalidatePath("/reading");
}

const btn = "min-h-11 rounded-xl border border-[var(--color-line)] px-4 text-sm";

export default async function ReadingPage() {
  const books = await listBooks(sql() as unknown as Sql);
  const withLast = await Promise.all(books.map(async (b) => ({ b, last: b.nextPiece > 1 ? await bookPiece(sql() as unknown as Sql, b.id, Math.min(b.nextPiece - 1, b.totalPieces)) : null })));
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Daily reading</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">One piece of a book each morning (about 45 days for a 100-page book), with a summary of the days before. To start one, tell JARVIS in chat: “read Pride and Prejudice with me”, or share a PDF and say “read this with me”.</p>
      {withLast.length === 0 && (
        <Section title="No book yet">
          <Empty>Nothing is being read. Public-domain books can be started by title; any other book needs its PDF.</Empty>
        </Section>
      )}
      {withLast.map(({ b, last }) => {
        const done = Math.min(b.nextPiece - 1, b.totalPieces);
        return (
          <Section key={b.id} title={b.title}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={b.status === "active" ? "good" : b.status === "done" ? "muted" : "warn"}>{b.status === "done" ? "Finished" : b.status === "paused" ? "Paused" : "Reading"}</Badge>
              {b.author && <span className="text-[var(--color-muted)]">{b.author}</span>}
              <span className="text-[var(--color-muted)]">
                · {done} of {b.totalPieces} pieces{b.status === "active" ? ` · next ${b.nextDay}` : ""}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-line)]">
              <div className="h-full bg-[var(--color-accent)]" style={{ width: `${Math.round((done / b.totalPieces) * 100)}%` }} />
            </div>
            {b.summary && done > 1 && (
              <>
                <h3 className="mt-4 text-sm font-semibold">The story so far</h3>
                <p className="mt-1 text-sm">{b.summary}</p>
              </>
            )}
            {last && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer py-1 text-[var(--color-muted)]">Last piece sent (day {last.n}{last.label ? ` · ${last.label}` : ""})</summary>
                <div className="mt-2 space-y-2">
                  {last.body.split("\n\n").map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </details>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {b.status === "active" && (
                <>
                  <form action={act}>
                    <input type="hidden" name="id" value={b.id} />
                    <button name="do" value="next" className="min-h-11 rounded-xl bg-[var(--color-accent)] px-4 text-sm font-medium text-white">
                      Next piece now
                    </button>
                  </form>
                  <form action={act}>
                    <input type="hidden" name="id" value={b.id} />
                    <button name="do" value="postpone" className={btn}>
                      Postpone a day
                    </button>
                  </form>
                </>
              )}
              {b.status !== "done" && (
                <form action={act}>
                  <input type="hidden" name="id" value={b.id} />
                  <button name="do" value={b.status === "paused" ? "resume" : "pause"} className={btn}>
                    {b.status === "paused" ? "Resume" : "Pause"}
                  </button>
                </form>
              )}
              <form action={act}>
                <input type="hidden" name="id" value={b.id} />
                <button name="do" value="drop" className="min-h-11 rounded-xl px-4 text-sm text-[var(--color-muted)]">
                  Remove
                </button>
              </form>
            </div>
          </Section>
        );
      })}
    </main>
  );
}
