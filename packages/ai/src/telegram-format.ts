// Model output is Markdown-ish; Telegram's HTML mode is strict. Escape
// everything, then re-introduce only the handful of tags Telegram accepts.

export function markdownToTelegramHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const code: string[] = [];
  let s = md.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c: string) => `\u0000${code.push(`<pre>${esc(c.trimEnd())}</pre>`) - 1}\u0000`);
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${code.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/^\s*[-*]\s+/gm, "• ");
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "");
}

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
