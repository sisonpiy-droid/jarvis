import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { closeEmailDraft, listEmailDrafts, mailtoLink } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import { sql } from "@/lib/passkey";
import { Empty, Section } from "../ui";

// Emails JARVIS drafted. Drafts only — JARVIS cannot send mail. "Open in mail" hands the draft to your own mail
// app; you send it there, then mark it sent here (or discard it).

async function close(form: FormData) {
  "use server";
  if (!(await isSignedIn())) redirect("/login");
  const id = Number(form.get("id"));
  if (Number.isInteger(id)) await closeEmailDraft(sql(), id, form.get("status") === "sent" ? "sent" : "discarded");
  revalidatePath("/emails");
}

export default async function EmailsPage() {
  const drafts = await listEmailDrafts(sql());
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Email drafts</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">JARVIS only drafts — it never sends email. Ask it in chat to change a draft, or open it in your mail app and send it yourself.</p>
      {drafts.length === 0 && (
        <Section title="Waiting for you">
          <Empty>No drafts. Tell JARVIS in chat: “draft a reply to …”.</Empty>
        </Section>
      )}
      {drafts.map((d) => (
        <Section key={d.id} title={`#${d.id} · ${fmtDateTime(d.createdAt)}`}>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-[var(--color-muted)]">To</dt>
              <dd>{d.to ?? <span className="text-[var(--color-muted)]">(no address yet)</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-[var(--color-muted)]">Subject</dt>
              <dd className="font-medium">{d.subject}</dd>
            </div>
          </dl>
          <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-[var(--color-line)] p-3 font-sans text-sm">{d.body}</pre>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a href={mailtoLink(d)} className="inline-flex min-h-11 items-center rounded-xl bg-[var(--color-accent)] px-4 text-sm font-medium text-white no-underline">
              Open in mail
            </a>
            <form action={close}>
              <input type="hidden" name="id" value={d.id} />
              <input type="hidden" name="status" value="sent" />
              <button className="min-h-11 rounded-xl border border-[var(--color-line)] px-4 text-sm">I sent it</button>
            </form>
            <form action={close}>
              <input type="hidden" name="id" value={d.id} />
              <input type="hidden" name="status" value="discarded" />
              <button className="min-h-11 rounded-xl px-4 text-sm text-[var(--color-muted)]">Discard</button>
            </form>
          </div>
        </Section>
      ))}
    </main>
  );
}
