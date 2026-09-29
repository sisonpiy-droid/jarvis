import type { Sql } from "@jarvis/db";
import type { ModelProvider } from "./gemini";
import { chat } from "./jarvis";
import { markdownToTelegramHtml, splitForTelegram } from "./telegram-format";
import { forgetMemory, listMemories } from "./memory";
import { jarvisTools, resolveAssignment } from "./tools";

// Telegram front door. Only the owner's chat is served; every other sender is
// ignored. Slash commands answer straight from the database (no AI needed);
// anything else goes to the JARVIS agent.

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number | string }; text?: string };
}

export interface BotDeps {
  sql: Sql;
  token: string;
  ownerChatId: string;
  model: ModelProvider | null;
  /** Kicks off an immediate LMS sync (fire-and-forget). */
  triggerSync?: () => Promise<void>;
  /** Starts drafting an assignment (fire-and-forget; the draft arrives on Telegram). */
  requestDraft?: (assignmentId: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const HELP = [
  "🤖 <b>JARVIS</b> — your MESA chief of staff",
  "",
  "<b>Quick commands</b>",
  "/due — what's due in the next 7 days",
  "/today — today's classes",
  "/tomorrow — tomorrow's classes",
  "/status — sync health and sign-in expiry",
  "/sync — check the LMS right now",
  "/draft &lt;assignment&gt; — write a first draft (Word doc)",
  "/memory — what I remember about you · /forget &lt;#&gt;",
  "",
  "<b>Or just ask</b>, e.g.",
  "• What's due this week?",
  "• Explain the Lenskart workbook assignment",
  "• Find the slides on unit economics",
  "• Remind me at 9 pm to finish the case",
  "• Draft the Finance end-term assignment",
].join("\n");

async function telegram(deps: BotDeps, method: string, body: Record<string, unknown>) {
  const res = await (deps.fetch ?? fetch)(`https://api.telegram.org/bot${deps.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
}

export async function reply(deps: BotDeps, html: string) {
  for (const chunk of splitForTelegram(html)) {
    try {
      await telegram(deps, "sendMessage", { chat_id: deps.ownerChatId, text: chunk, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch {
      // Malformed HTML from the model: fall back to plain text rather than dropping the reply.
      await telegram(deps, "sendMessage", { chat_id: deps.ownerChatId, text: chunk.replace(/<[^>]+>/g, "") });
    }
  }
}

export async function commandReply(deps: BotDeps, cmd: string, arg = ""): Promise<string | null> {
  const tools = new Map(jarvisTools(deps.sql, deps.now).map((t) => [t.name, t]));
  switch (cmd) {
    case "/memory": {
      const mems = await listMemories(deps.sql);
      if (!mems.length) return "🧠 I don't remember anything about you yet. Tell me things like “I prefer short answers” or “my BYOB group is …”.";
      return ["🧠 <b>What I remember</b>", ...mems.map((m) => `#${m.id} · <i>${m.kind}</i> — ${esc(m.content)}`), "", "Remove one with <code>/forget 12</code>."].join("\n");
    }
    case "/forget": {
      const id = Number(arg.replace(/^#/, ""));
      if (!Number.isInteger(id) || id <= 0) return "Which one? e.g. <code>/forget 12</code> (see /memory).";
      return (await forgetMemory(deps.sql, id)) ? `🗑️ Forgotten #${id}.` : `No active memory #${id}.`;
    }
    case "/draft": {
      if (!deps.requestDraft) return "Drafting isn't configured yet.";
      if (!arg) return "Which one? e.g. <code>/draft Finance end term</code>";
      const r = await resolveAssignment(deps.sql, arg, deps.now?.() ?? new Date());
      if ("none" in r) return `No assignment matches “${esc(arg)}”. Try /due to see names.`;
      if ("candidates" in r) return ["Several match — be more specific:", ...r.candidates.map((c) => `• ${esc(c.title)} — ${esc(c.due)} (${esc(c.status)})`)].join("\n");
      await deps.requestDraft(String(r.one.sourceId));
      return `✍️ Drafting <b>${esc(r.one.title)}</b> — reading the brief, attachments and class slides. The Word doc arrives here in 1–3 minutes.`;
    }
    case "/start":
    case "/help":
      return HELP;
    case "/due": {
      const rows = (await tools.get("get_upcoming_assignments")!.run({ days: 7 })) as Array<Record<string, unknown>>;
      if (!rows.length) return "📌 Nothing unsubmitted is due in the next 7 days. ✅";
      return [
        `📌 <b>Not submitted — next 7 days (${rows.length})</b>`,
        ...rows.map((r) => `• ${r.overdue ? "⚠️ <b>OVERDUE</b> " : ""}${esc(r.due)} — <a href="${esc(r.url)}">${esc(r.title)}</a>${r.course ? ` <i>(${esc(String(r.course).replace(/\s+with\s+.*$/i, ""))})</i>` : ""}`),
      ].join("\n");
    }
    case "/today":
    case "/tomorrow": {
      const rows = (await tools.get("get_schedule")!.run({ date: cmd.slice(1) })) as Array<Record<string, unknown>>;
      if (!rows.length) return `🏫 No classes ${cmd.slice(1)}.`;
      return [
        `🏫 <b>${cmd === "/today" ? "Today" : "Tomorrow"} (${rows.length})</b>`,
        ...rows.map((r) => `• ${esc(String(r.when).replace(/^.*?,\s*\d+\s+\w+\s+\d{4},\s*/, ""))} — ${esc(r.course ?? r.title)}${r.course && r.title !== r.course ? `: ${esc(r.title)}` : ""}${r.room ? ` <i>(${esc(r.room)})</i>` : ""}${r.status === "cancelled" ? " ❌ cancelled" : ""}`),
      ].join("\n");
    }
    case "/status": {
      const s = (await tools.get("get_status")!.run({})) as Record<string, Record<string, unknown> | number | undefined>;
      const run = s.last_sync as Record<string, unknown> | undefined;
      const mesa = s.mesa as Record<string, unknown> | undefined;
      const files = (s.files ?? {}) as Record<string, number>;
      return [
        "🩺 <b>JARVIS status</b>",
        `Last check: ${esc(run?.at)} — ${esc(run?.status)}${run?.error ? ` (${esc(run.error)})` : ""}`,
        `Last full scan: ${esc(mesa?.last_full_scan)}`,
        `MESA sign-in: ${esc(mesa?.status)}, expires ${esc(mesa?.sign_in_expires)}`,
        `Files: ${files.done ?? 0} downloaded, ${files.pending ?? 0} pending${files.failed ? `, ${files.failed} failed` : ""}`,
        `Notifications queued: ${esc(s.queued_notifications)}`,
      ].join("\n");
    }
    case "/sync":
      if (!deps.triggerSync) return "Sync trigger isn't configured.";
      await deps.triggerSync();
      return "🔄 Checking the LMS now — you'll get a message if anything changed.";
    default:
      return null;
  }
}

/** Handles one Telegram update. Exactly-once: the update id is recorded before any work. */
export async function handleUpdate(deps: BotDeps, update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text || String(msg.chat.id) !== deps.ownerChatId) return; // not the owner: ignore silently
  const fresh = await deps.sql`insert into jarvis.telegram_updates (update_id) values (${update.update_id}) on conflict do nothing returning update_id`;
  if (!fresh.length) return; // Telegram retry of something already handled

  const text = msg.text.trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0]!.toLowerCase() : null;
  try {
    if (cmd) {
      const out = await commandReply(deps, cmd, text.slice(text.split(/\s/)[0]!.length).trim());
      await reply(deps, out ?? `Unknown command. ${HELP}`);
      return;
    }
    if (!deps.model) {
      await reply(deps, "💬 Chat isn't switched on yet (no AI key). Quick commands work: /due /today /status /sync");
      return;
    }
    await telegram(deps, "sendChatAction", { chat_id: deps.ownerChatId, action: "typing" }).catch(() => {});
    const res = await chat(
      { sql: deps.sql, model: deps.model, ...(deps.now ? { now: deps.now } : {}), tools: jarvisTools(deps.sql, deps.now, deps.requestDraft ? { requestDraft: deps.requestDraft } : {}) },
      text,
    );
    await reply(deps, markdownToTelegramHtml(res.text));
  } catch (err) {
    await reply(deps, `⚠️ Something went wrong: ${esc(err instanceof Error ? err.message : String(err)).slice(0, 300)}`).catch(() => {});
  }
}
