// Supabase Edge Function: Telegram webhook for JARVIS chat.
// Bundled by `npm run edge:build` into index.js.

import { GeminiProvider, handleUpdate, type TelegramUpdate } from "@jarvis/ai";
import { connect } from "@jarvis/db";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing secret ${k}`);
  return v;
};

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function processUpdate(update: TelegramUpdate) {
  const sql = connect(env("SUPABASE_DB_URL"));
  try {
    const gemini = Deno.env.get("GEMINI_API_KEY");
    const syncUrl = `${env("SUPABASE_URL")}/functions/v1/mesa-sync?manual`;
    await handleUpdate(
      {
        sql,
        token: env("TELEGRAM_BOT_TOKEN"),
        ownerChatId: env("TELEGRAM_CHAT_ID"),
        model: gemini ? new GeminiProvider(gemini, Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash") : null,
        triggerSync: async () => {
          await fetch(syncUrl, { method: "POST", headers: { Authorization: `Bearer ${env("CRON_SECRET")}` } });
        },
      },
      update,
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "telegram update failed", error: err instanceof Error ? err.message : String(err) }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Deno.serve(async (req) => {
  // Telegram echoes the secret we registered with setWebhook in this header.
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", env("TELEGRAM_WEBHOOK_SECRET"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const update = (await req.json().catch(() => null)) as TelegramUpdate | null;
  if (!update || typeof update.update_id !== "number") return new Response("ok");
  // Answer Telegram at once (it retries slow webhooks); do the work in the background.
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(processUpdate(update));
  else await processUpdate(update);
  return new Response("ok");
});
