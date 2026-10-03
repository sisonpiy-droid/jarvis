// Legacy Telegram front door (until Phase 11). Telegram's HTML mode accepts exactly the subset the shared
// chat converter emits, so it is re-exported under its old name.

export { markdownToChatHtml as markdownToTelegramHtml } from "./markdown";

/** Splits a message on paragraph/line boundaries to respect Telegram's 4096-char limit. */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n/)) {
    if ((cur ? cur.length + 1 : 0) + para.length > limit) {
      if (cur) out.push(cur);
      cur = para.length > limit ? para.slice(0, limit) : para;
    } else cur = cur ? `${cur}\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}
