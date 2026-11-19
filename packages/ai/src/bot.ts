import type { Sql } from "@jarvis/db";
import type { ModelProvider } from "./model";
import { chat } from "./jarvis";
import { markdownToTelegramHtml, splitForTelegram } from "./telegram-format";
import { forgetMemory, listMemories, memoryScopeLabel } from "./memory";
import { jarvisTools, resolveAssignment } from "./tools";
import type { GoogleCalendar } from "./google-calendar";
import { costSummary, fmtTokens, fmtUsd, listBooks, onlyActiveBook, postponeBook, type CostWindow } from "@jarvis/db";
import { deliverPiece } from "./reading";

// Telegram front door. Only the owner's chat is served; every other sender is
// ignored. Slash commands answer straight from the database (no AI needed);
// anything else goes to the JARVIS agent.

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    /** Text sent with a file. */
    caption?: string;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
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
  /** Saves an instruction for an assignment and redoes it. */
  requestRevision?: (assignmentId: string, instruction: string) => Promise<void>;
  /** Stores a file the owner sent so chat can read it (set by the Edge function, which has storage). */
  ingestDocument?: (bytes: Uint8Array, name: string, mime: string | null) => Promise<{ fileId: string; name: string; textStatus: string }>;
  /** Reads a stored file back, for clean_data. */
  readFile?: (fileId: string) => Promise<{ bytes: Uint8Array; name: string } | null>;
  /** The owner's Google Calendar, once connected. */
  calendar?: GoogleCalendar | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const HELP = [
  "🤖 <b>JARVIS</b> — your MESA chief of staff",
  "",
  "<b>Quick commands</b>",
  "/due — what's due in the next 7 days",
  "/today — today's classes",
  "/tomorrow — tomorrow's classes",
  "/status — sync health and sign-in expiry",
  "/costs — what the AI calls cost: today, this week, by task",
  "/read — the next piece of your book now · /postpone — move it a day",
  "/notes &lt;course&gt; — your revision notes for a course, as a Word file",
  "/sync — check the LMS right now",
  "/draft &lt;assignment&gt; — do the assignment (doc + workbook/slides)",
  "/revise &lt;assignment&gt; | &lt;what to change&gt; — edit it",
  "/memory — what I remember about you · /forget &lt;#&gt;",
  "",
  "<b>Or just ask</b>, e.g.",
  "• What's due this week?",
  "• Explain the Lenskart workbook assignment",
  "• Find the slides on unit economics",
  "• Remind me at 9 pm to finish the case",
  "• Draft the Finance end-term assignment",
  "• For marketing, our startup is Snitch — redo it",
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

/** A file the owner sent the bot (Telegram allows bots 20 MB). The token stays out of every error message. */
export const TELEGRAM_DOWNLOAD_MAX = 20 * 2 ** 20;
async function downloadFile(deps: BotDeps, fileId: string): Promise<Uint8Array> {
  const f = deps.fetch ?? fetch;
  const info = await f(`https://api.telegram.org/bot${deps.token}/getFile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: fileId }) });
  const j = (await info.json().catch(() => ({}))) as { ok?: boolean; result?: { file_path?: string }; description?: string };
  if (!j.ok || !j.result?.file_path) throw new Error(`Telegram getFile failed: ${j.description ?? info.status}`);
  const res = await f(`https://api.telegram.org/file/bot${deps.token}/${j.result.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
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

const costLine = (t: { task: string; usd: number; calls: number; inputTokens: number; outputTokens: number }) => `• ${esc(t.task)} — ${fmtUsd(t.usd)} · ${t.calls} call${t.calls === 1 ? "" : "s"} · ${fmtTokens(t.inputTokens + t.outputTokens)} tokens`;
const costWindow = (label: string, w: CostWindow) => [`<b>${label}</b>: ${fmtUsd(w.usd)} · ${fmtTokens(w.tokens)} tokens · ${w.calls} calls`, ...w.byTask.slice(0, 6).map(costLine)];

/** /costs: spend today and this week by task, and the most expensive task. Estimated at paid prices (the free tier costs nothing). */
export async function costsReply(sql: Sql, now: Date): Promise<string> {
  const s = await costSummary(sql, now);
  if (!s.all.calls) return "💸 No AI calls logged yet.";
  const top = s.topTask!;
  return [
    "💸 <b>AI costs</b> <i>(estimated at paid Gemini Flash prices — you're on the free tier)</i>",
    ...costWindow("Today", s.today),
    "",
    ...costWindow("Last 7 days", s.week),
    "",
    `🏆 Most expensive task: <b>${esc(top.task)}</b> — ${fmtUsd(top.usd)} of ${fmtUsd(s.all.usd)} so far (${Math.round((top.usd / (s.all.usd || 1)) * 100)}%)`,
  ].join("\n");
}

export async function commandReply(deps: BotDeps, cmd: string, arg = ""): Promise<string | null> {
  const tools = new Map(jarvisTools(deps.sql, deps.now).map((t) => [t.name, t]));
  switch (cmd) {
    case "/memory": {
      const mems = await listMemories(deps.sql);
      if (!mems.length) return "🧠 I don't remember anything about you yet. Tell me things like “I prefer short answers” or “my BYOB group is …”.";
      return ["🧠 <b>What I remember</b>", ...mems.map((m) => `#${m.id} · <i>${esc(memoryScopeLabel(m) || m.kind)}</i> — ${esc(m.content)}`), "", "Remove one with <code>/forget 12</code>."].join("\n");
    }
    case "/forget": {
      const id = Number(arg.replace(/^#/, ""));
      if (!Number.isInteger(id) || id <= 0) return "Which one? e.g. <code>/forget 12</code> (see /memory).";
      return (await forgetMemory(deps.sql, id)) ? `🗑️ Forgotten #${id}.` : `No active memory #${id}.`;
    }
    case "/revise": {
      if (!deps.requestRevision) return "Revising isn't configured yet.";
      const [q, ...rest] = arg.split("|");
      const instruction = rest.join("|").trim();
      if (!q?.trim() || !instruction) return "Use: <code>/revise marketing | our startup is Snitch</code>";
      const r = await resolveAssignment(deps.sql, q.trim(), deps.now?.() ?? new Date());
      if ("none" in r) return `No assignment matches “${esc(q.trim())}”. Try /due to see names.`;
      if ("candidates" in r) return ["Several match — be more specific:", ...r.candidates.map((c) => `• ${esc(c.title)} — ${esc(c.due)}`)].join("\n");
      await deps.requestRevision(String(r.one.sourceId), instruction);
      return `✏️ Got it — for <b>${esc(r.one.title)}</b>: “${esc(instruction)}”.\nI'll remember this and send the revised files here in 1–3 minutes.`;
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
    case "/read":
    case "/postpone": {
      const active = await listBooks(deps.sql, "active");
      if (!active.length) return "📖 No book is being read. Tell me a book title (public domain) or send the PDF.";
      const book = await onlyActiveBook(deps.sql);
      if (!book) return `📖 You're reading ${active.length} books — tell me which one in chat (e.g. “next piece of ${esc(active[0]!.title)}”).`;
      if (cmd === "/postpone") {
        const days = Math.max(1, Math.min(30, Math.round(Number(arg) || 1)));
        const b = (await postponeBook(deps.sql, book.id, days))!;
        return `⏭️ <b>${esc(b.title)}</b>: piece ${b.nextPiece} of ${b.totalPieces} moved to ${esc(b.nextDay)}.`;
      }
      const d = await deliverPiece(deps.sql, deps.model, book.id, deps.now?.() ?? new Date());
      return d ? `📖 Piece ${d.n} of ${d.total} of <b>${esc(d.title)}</b> is on its way (a minute or so).` : "That book has nothing left to send.";
    }
    case "/costs":
      return costsReply(deps.sql, deps.now?.() ?? new Date());
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
  if (!msg || (!msg.text && !msg.document) || String(msg.chat.id) !== deps.ownerChatId) return; // not the owner: ignore silently
  const fresh = await deps.sql`insert into jarvis.telegram_updates (update_id) values (${update.update_id}) on conflict do nothing returning update_id`;
  if (!fresh.length) return; // Telegram retry of something already handled

  let text = (msg.text ?? msg.caption ?? "").trim();
  let cmd = !msg.document && text.startsWith("/") ? text.split(/[\s@]/)[0]!.toLowerCase() : null;
  // /notes <course> is a request for a file, so it goes through chat like asking in words ("notes for Finance").
  if (cmd === "/notes") {
    const course = text.slice(text.split(/\s/)[0]!.length).trim();
    text = course ? `Send me my revision notes for ${course} as a document.` : "Which courses do you have revision notes for? List them, then ask which one I want.";
    cmd = null;
  }
  try {
    if (cmd) {
      const out = await commandReply(deps, cmd, text.slice(text.split(/\s/)[0]!.length).trim());
      await reply(deps, out ?? `Unknown command. ${HELP}`);
      return;
    }
    if (msg.document) {
      const d = msg.document;
      const name = d.file_name ?? "file";
      if (!deps.ingestDocument) {
        await reply(deps, "📎 I can't take files here yet.");
        return;
      }
      if ((d.file_size ?? 0) > TELEGRAM_DOWNLOAD_MAX) {
        await reply(deps, `📎 ${esc(name)} is over 20 MB — Telegram won't let me download it. Send a smaller file.`);
        return;
      }
      await telegram(deps, "sendChatAction", { chat_id: deps.ownerChatId, action: "typing" }).catch(() => {});
      const f = await deps.ingestDocument(await downloadFile(deps, d.file_id), name, d.mime_type ?? null);
      // The same line the web app's share sheet writes, so chat treats it as a shared file.
      text = `📎 Shared file: ${f.name} (file_id: ${f.fileId})${f.textStatus === "done" ? "" : " — no readable text"}
${text || "(no instruction — ask what to do with it)"}`;
    }
    if (!deps.model) {
      await reply(deps, "💬 Chat isn't switched on yet (no AI key). Quick commands work: /due /today /status /sync");
      return;
    }
    await telegram(deps, "sendChatAction", { chat_id: deps.ownerChatId, action: "typing" }).catch(() => {});
    const res = await chat(
      { sql: deps.sql, model: deps.model, channel: "telegram", ...(deps.now ? { now: deps.now } : {}), tools: jarvisTools(deps.sql, deps.now, {
          ...(deps.requestDraft ? { requestDraft: deps.requestDraft } : {}),
          ...(deps.requestRevision ? { requestRevision: deps.requestRevision } : {}),
          ...(deps.readFile ? { readFile: deps.readFile } : {}),
          ...(deps.calendar ? { calendar: deps.calendar } : {}),
          sendFile: async (bytes, filename, caption, mime = DOCX) => {
            const form = new FormData();
            form.append("chat_id", deps.ownerChatId);
            form.append("caption", caption.slice(0, 1024));
            form.append("document", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), filename);
            const res = await (deps.fetch ?? fetch)(`https://api.telegram.org/bot${deps.token}/sendDocument`, { method: "POST", body: form });
            const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
            if (!json.ok) throw new Error(`Telegram sendDocument failed: ${json.description ?? res.status}`);
            return "Sent in this chat as a file.";
          },
        }),
      },
      text,
    );
    await reply(deps, markdownToTelegramHtml(res.text));
  } catch (err) {
    await reply(deps, `⚠️ Something went wrong: ${esc(err instanceof Error ? err.message : String(err)).slice(0, 300)}`).catch(() => {});
  }
}
