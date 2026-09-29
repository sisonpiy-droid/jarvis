// Telegram delivery for drafts: a message and a document (multipart upload).

export function telegramSender(token: string, chatId: string, fetchImpl: typeof fetch = fetch) {
  const api = `https://api.telegram.org/bot${token}`;
  const check = async (res: Response, what: string) => {
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!j.ok) throw new Error(`Telegram ${what} failed: ${j.description ?? res.status}`);
  };
  return {
    async sendMessage(html: string) {
      const res = await fetchImpl(`${api}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: html.slice(0, 4096), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      });
      await check(res, "sendMessage");
    },
    async sendFile(bytes: Uint8Array, filename: string, mime: string, caption: string) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption.slice(0, 1024));
      form.append("document", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), filename);
      await check(await fetchImpl(`${api}/sendDocument`, { method: "POST", body: form }), "sendDocument");
    },
    async sendDocument(bytes: Uint8Array, filename: string, caption: string) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption.slice(0, 1024));
      form.append("document", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), filename);
      await check(await fetchImpl(`${api}/sendDocument`, { method: "POST", body: form }), "sendDocument");
    },
  };
}
