import * as db from "@jarvis/db";
import type { Sql } from "@jarvis/db";
import type { Tool } from "./agent";

// Email drafting for chat. JARVIS drafts, shows, and waits: there is deliberately no tool that sends mail, replies
// or forwards — the owner sends from their own mail app (the /emails page has an "Open in mail" link).

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const show = (d: db.EmailDraft) => ({ id: d.id, to: d.to, subject: d.subject, body: d.body });
const NOTE = "This is a DRAFT — JARVIS cannot send email and has not sent it. Show the owner the whole draft (To, Subject, body) and ask if they want changes; they send it themselves from their own mail app (the /emails page has an 'Open in mail' link).";

export function emailTools(sql: Sql): Tool[] {
  return [
    {
      name: "draft_email",
      effect: "write-local",
      description:
        "Draft an email the owner needs to send (a reply, a request to a professor, a follow-up). Write it ready to send in the owner's voice: a clear subject, a short greeting, the point, a polite close. `to` only when they gave an address. Saved as a draft for the owner to read; never sent.",
      parameters: obj(
        { to: { type: "string", description: "Recipient email address, if known" }, subject: { type: "string" }, body: { type: "string", description: "The full email text, plain text with line breaks" } },
        ["subject", "body"],
      ),
      async run(a) {
        const d = await db.createEmailDraft(sql, { to: str(a.to) || null, subject: str(a.subject), body: str(a.body) });
        return { draft: show(d), status: "draft", note: NOTE };
      },
    },
    {
      name: "revise_email_draft",
      effect: "write-local",
      description: "Change an open email draft by id (recipient, subject and/or body) when the owner asks for edits. Pass the complete new body, not a diff.",
      parameters: obj({ id: { type: "integer" }, to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, ["id"]),
      async run(a) {
        const d = await db.updateEmailDraft(sql, Number(a.id), { ...(a.to !== undefined ? { to: str(a.to) || null } : {}), ...(a.subject !== undefined ? { subject: str(a.subject) } : {}), ...(a.body !== undefined ? { body: str(a.body) } : {}) });
        return d ? { draft: show(d), status: "draft", note: NOTE } : { updated: false, reason: "no open draft with that id" };
      },
    },
    {
      name: "list_email_drafts",
      effect: "read",
      description: "The owner's open email drafts, newest first.",
      parameters: obj({}),
      async run() {
        return { drafts: (await db.listEmailDrafts(sql)).map(show), note: "Drafts only — none of these has been sent." };
      },
    },
    {
      name: "close_email_draft",
      effect: "write-local",
      description: "Mark a draft 'sent' (the owner says they sent it themselves) or 'discarded' (they don't want it). This only updates the list; it sends nothing.",
      parameters: obj({ id: { type: "integer" }, status: { type: "string", enum: ["sent", "discarded"] } }, ["id", "status"]),
      async run(a) {
        const status = a.status === "sent" ? "sent" : "discarded";
        return { closed: await db.closeEmailDraft(sql, Number(a.id), status), status };
      },
    },
  ];
}
