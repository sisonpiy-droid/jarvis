// Supabase Edge Function: one MESA sync per invocation. pg_cron calls it every
// 5 minutes. Source of truth is packages/*; this file is bundled by
// `npm run edge:build` into index.js, which is what gets deployed.

import { connect } from "@jarvis/db";
import { SupabaseStorage } from "@jarvis/files";
import { TelegramChannel } from "@jarvis/notify";
import { createLogger } from "@jarvis/shared";
import { runMesaSync } from "@jarvis/sync";

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

/** Length-independent comparison so the secret can't be probed by timing. */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function sync(trigger: "schedule" | "manual", force?: "full" | "light") {
  const log = createLogger("edge:mesa-sync");
  // SUPABASE_DB_URL is provided to every Edge Function by the platform.
  const sql = connect(env("SUPABASE_DB_URL"));
  try {
    return await runMesaSync(
      {
        sql,
        sessionKey: env("MESA_SESSION_KEY"),
        channel: new TelegramChannel(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID")),
        // Both provided to Edge Functions by the platform.
        storage: new SupabaseStorage(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")),
        log,
        // Auto-draft new assignments unless AUTO_DRAFT=off (and only when an AI key is configured).
        ...(Deno.env.get("GEMINI_API_KEY") && Deno.env.get("AUTO_DRAFT") !== "off"
          ? {
              onNewAssignments: async (ids: string[]) => {
                for (const assignmentId of ids) {
                  await fetch(`${env("SUPABASE_URL")}/functions/v1/assignment-draft`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${env("CRON_SECRET")}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ assignmentId, trigger: "auto" }),
                  });
                }
              },
            }
          : {}),
      },
      { trigger, ...(force ? { force } : {}) },
    );
  } catch (err) {
    log.error("sync crashed", { error: err });
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env("CRON_SECRET")}`)) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const force = url.searchParams.get("force");
  const run = sync(url.searchParams.has("manual") ? "manual" : "schedule", force === "full" || force === "light" ? force : undefined);

  // ?wait returns the result (for testing); otherwise answer immediately and keep working in the background.
  if (url.searchParams.has("wait") || typeof EdgeRuntime === "undefined") {
    return Response.json(await run);
  }
  EdgeRuntime.waitUntil(run);
  return Response.json({ accepted: true }, { status: 202 });
});
