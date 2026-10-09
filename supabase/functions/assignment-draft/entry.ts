// Supabase Edge Function: drafts one assignment and sends it to Telegram.
// Called (fire-and-forget) by mesa-sync for new assignments and by the bot
// for /draft. Bundled by `npm run edge:build` into index.js.

import { GeminiProvider, meterTo } from "@jarvis/ai";
import { draftAssignment, telegramSender } from "@jarvis/assist";
import { connect } from "@jarvis/db";
import { SupabaseStorage } from "@jarvis/files";
import { createLogger } from "@jarvis/shared";

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

async function run(assignmentId: string, trigger: "auto" | "request") {
  const log = createLogger("edge:assignment-draft");
  const sql = connect(env("SUPABASE_DB_URL"));
  const modelName = Deno.env.get("GEMINI_DRAFT_MODEL") ?? Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";
  try {
    const tg = telegramSender(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID"));
    return await draftAssignment(
      {
        sql,
        storage: new SupabaseStorage(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")),
        model: new GeminiProvider(env("GEMINI_API_KEY"), modelName, fetch, 140_000, meterTo(sql)),
        modelName,
        sendMessage: tg.sendMessage,
        sendDocument: tg.sendDocument,
        log,
      },
      assignmentId,
      trigger,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Deno.serve(async (req) => {
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${env("CRON_SECRET")}`)) return new Response("unauthorized", { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { assignmentId?: string; trigger?: string };
  if (!body.assignmentId) return new Response("assignmentId required", { status: 400 });
  const job = run(body.assignmentId, body.trigger === "auto" ? "auto" : "request");
  if (new URL(req.url).searchParams.has("wait") || typeof EdgeRuntime === "undefined") return Response.json(await job);
  EdgeRuntime.waitUntil(job);
  return Response.json({ accepted: true }, { status: 202 });
});
