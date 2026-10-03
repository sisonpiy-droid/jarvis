// Supabase Edge Function: the all-in-one sync (calendar → MESA → brief → send → drafting), each step recorded
// as its own job. Kept for the Telegram /sync command and manual runs; the schedule now calls `jarvis-tick`
// per job instead. Bundled by `npm run edge:build` into index.js, which is what gets deployed.

import { createLogger } from "@jarvis/shared";
import { runMesaSync } from "@jarvis/sync";
import { authorized, syncDeps } from "../_shared/sync-deps";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): void };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

async function sync(trigger: "schedule" | "manual", force?: "full" | "light") {
  const log = createLogger("edge:mesa-sync");
  const deps = syncDeps(log);
  try {
    return await runMesaSync(deps, { trigger, ...(force ? { force } : {}) });
  } catch (err) {
    log.error("sync crashed", { error: err });
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await deps.sql.end({ timeout: 5 });
  }
}

Deno.serve(async (req) => {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });

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
