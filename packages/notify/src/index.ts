// Notification channels. V1: Telegram. A channel only has to deliver text;
// deciding *what* to say (and deduping it) happens upstream in the sync engine.

export interface Channel {
  /** Sends one message; returns the provider's message id. */
  send(text: string): Promise<string>;
}

const TELEGRAM_LIMIT = 4096;

/** Escapes text for Telegram's HTML parse mode. */
export function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class TelegramChannel implements Channel {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<string> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    // Never echo the URL: it contains the bot token.
    if (!res.ok || !body.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.description ?? ""}`.trim());
    return String(body.result?.message_id ?? "");
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
  if (items.length <= individualMax) return items.map((i) => ({ ids: [i.id], text: i.text.slice(0, TELEGRAM_LIMIT) }));
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
