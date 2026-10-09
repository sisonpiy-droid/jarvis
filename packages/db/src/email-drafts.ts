import type { Sql } from "./client";

// Email drafts (migration 0025). Drafts only: nothing here — or anywhere in JARVIS — sends mail.

export type EmailStatus = "draft" | "sent" | "discarded";

export interface EmailDraft {
  id: number;
  to: string | null;
  subject: string;
  body: string;
  status: EmailStatus;
  createdAt: string;
  updatedAt: string;
}

const toDraft = (r: Record<string, unknown>): EmailDraft => ({
  id: Number(r.id),
  to: (r.to_addr as string | null) ?? null,
  subject: String(r.subject),
  body: String(r.body),
  status: r.status as EmailStatus,
  createdAt: new Date(r.created_at as string).toISOString(),
  updatedAt: new Date(r.updated_at as string).toISOString(),
});

const clean = (s: string | null | undefined, max: number) => (s ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const addr = (s: string | null | undefined) => clean(s, 200) || null;

export async function createEmailDraft(sql: Sql, d: { to?: string | null; subject: string; body: string }): Promise<EmailDraft> {
  const subject = clean(d.subject, 200);
  const body = clean(d.body, 10_000);
  if (!subject || !body) throw new Error("an email needs a subject and a body");
  const [r] = await sql`insert into jarvis.email_drafts (to_addr, subject, body) values (${addr(d.to)}, ${subject}, ${body}) returning *`;
  return toDraft(r!);
}

/** Edits an open draft (null for a missing one, or one already sent / discarded). */
export async function updateEmailDraft(sql: Sql, id: number, p: { to?: string | null; subject?: string; body?: string }): Promise<EmailDraft | null> {
  const [cur] = await sql`select * from jarvis.email_drafts where id = ${id} and status = 'draft'`;
  if (!cur) return null;
  const subject = p.subject != null ? clean(p.subject, 200) : String(cur.subject);
  const body = p.body != null ? clean(p.body, 10_000) : String(cur.body);
  if (!subject || !body) throw new Error("an email needs a subject and a body");
  const to = p.to !== undefined ? addr(p.to) : ((cur.to_addr as string | null) ?? null);
  const [r] = await sql`update jarvis.email_drafts set to_addr = ${to}, subject = ${subject}, body = ${body}, updated_at = now() where id = ${id} returning *`;
  return toDraft(r!);
}

/** The owner's own bookkeeping: they sent it from their mail app, or don't want it. */
export async function closeEmailDraft(sql: Sql, id: number, status: "sent" | "discarded"): Promise<boolean> {
  const rows = await sql`update jarvis.email_drafts set status = ${status}, updated_at = now() where id = ${id} and status = 'draft' returning id`;
  return rows.length === 1;
}

export async function listEmailDrafts(sql: Sql, status: EmailStatus = "draft", limit = 30): Promise<EmailDraft[]> {
  return (await sql`select * from jarvis.email_drafts where status = ${status} order by id desc limit ${limit}`).map(toDraft);
}

/** A link that opens the draft in the owner's own mail app, ready to read and send themselves. */
export function mailtoLink(d: Pick<EmailDraft, "to" | "subject" | "body">): string {
  return `mailto:${encodeURIComponent(d.to ?? "").replace(/%40/g, "@")}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
}
