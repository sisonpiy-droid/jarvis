// Model output is Markdown-ish; every surface that shows it (the web chat, the legacy Telegram bot) takes a
// small, strict HTML subset. Escape everything, then re-introduce only a handful of tags: b, i, a, code, pre.

export function markdownToChatHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const code: string[] = [];
  let s = md.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c: string) => `\u0000${code.push(`<pre>${esc(c.trimEnd())}</pre>`) - 1}\u0000`);
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${code.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`)
    .replace(/^#{1,6}\s+(.+)$/gm, (_, h: string) => `<b>${h.replace(/\*\*|__/g, "")}</b>`)
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "━━━━━━━━━━")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/^\s*[-*]\s+/gm, "• ");
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? "");
}
