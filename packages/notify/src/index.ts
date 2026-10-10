// Notification channels and the provider-independent notification service (service.ts). Telegram is the
// legacy channel, kept for rollback until Phase 11. A channel only has to deliver text;
// deciding *what* to say (and deduping it) happens upstream in the sync engine.

export interface Channel {
  /** Sends one message; returns the provider's message id. */
  send(text: string): Promise<string>;
  /** Sends one file (a class deck, a pre-read) after the message. */
  sendFile?(bytes: Uint8Array, filename: string, mime: string): Promise<void>;
}

const TELEGRAM_LIMIT = 4096;

/** Escapes text for Telegram's HTML parse mode. */
export function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Splits a message into parts under Telegram's limit at blank lines (then single lines, then anywhere). Short texts are returned as is. */
export function splitForTelegram(text: string, limit = TELEGRAM_LIMIT - 96): string[] {
  if (text.length <= TELEGRAM_LIMIT) return [text];
  const parts: string[] = [];
  let cur = "";
  const push = (piece: string, sep: string) => {
    if (cur && cur.length + sep.length + piece.length > limit) {
      parts.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}${sep}${piece}` : piece;
  };
  for (const para of text.split("\n\n")) {
    if (para.length <= limit) push(para, "\n\n");
    else
      for (const line of para.split("\n")) {
        if (line.length <= limit) push(line, "\n");
        else for (let i = 0; i < line.length; i += limit) push(line.slice(i, i + limit), "\n");
      }
  }
  if (cur) parts.push(cur);
  return parts;
}

export class TelegramChannel implements Channel {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Long texts (a day's book reading) go out as several messages, split at paragraph breaks; returns the last id. */
  async send(text: string): Promise<string> {
    let id = "";
    for (const chunk of splitForTelegram(text)) {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: chunk, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id?: number } };
      // Never echo the URL: it contains the bot token.
      if (!res.ok || !body.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.description ?? ""}`.trim());
      id = String(body.result?.message_id ?? "");
    }
    return id;
  }

  async sendFile(bytes: Uint8Array, filename: string, mime: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append("document", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), filename);
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !body.ok) throw new Error(`Telegram sendDocument failed: HTTP ${res.status} ${body.description ?? ""}`.trim());
  }
}

export interface Outgoing {
  id: number;
  text: string;
}

/**
 * Groups queued notifications into messages: up to `individualMax` go out one
 * by one; more than that become a digest, split to respect Telegram's size limit.
 */
export function planMessages(items: Outgoing[], individualMax = 3, limit = TELEGRAM_LIMIT - 96): Array<{ ids: number[]; text: string }> {
  if (items.length <= individualMax) return items.map((i) => ({ ids: [i.id], text: i.text }));
  const sep = "\n\n━━━━━━━━━━\n\n";
  const chunks: Array<{ ids: number[]; parts: string[]; len: number }> = [];
  for (const it of items) {
    const text = it.text.slice(0, limit);
    const cur = chunks[chunks.length - 1];
    if (cur && cur.len + sep.length + text.length <= limit) {
      cur.ids.push(it.id);
      cur.parts.push(text);
      cur.len += sep.length + text.length;
    } else chunks.push({ ids: [it.id], parts: [text], len: text.length });
  }
  return chunks.map((c, i) => ({
    ids: c.ids,
    text: `🗂 <b>${items.length} MESA updates</b>${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""}\n\n${c.parts.join(sep)}`,
  }));
}

export * from "./render";
export * from "./settings";
export * from "./policy";
export * from "./webpush";
export * from "./email";
export * from "./service";
