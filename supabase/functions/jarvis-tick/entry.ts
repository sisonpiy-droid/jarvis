// Supabase Edge Function: runs ONE scheduled job per call — `?job=mesa|calendar|notify|briefs|drafts|health`.
// pg_cron calls it once per job on that job's own schedule (see JOB_SCHEDULES and `npm run deploy:cloud`).
// Bundled by `npm run edge:build` into index.js, which is what gets deployed.

import { createLogger } from "@jarvis/shared";
import { isJobName, runScheduledJob } from "@jarvis/sync";
import { authorized, syncDeps } from "../_shared/sync-deps";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): void };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

async function tick(job: Parameters<typeof runScheduledJob>[0], trigger: "schedule" | "manual", force?: "full" | "light") {
  const log = createLogger(`edge:tick:${job}`);
  const deps = syncDeps(log);
  try {
    return await runScheduledJob(job, deps, { trigger, ...(force ? { force } : {}) });
  } catch (err) {
    // Only infrastructure errors land here (e.g. the database is unreachable); job failures are recorded by runJob.
    log.error("tick crashed", { error: err });
    return { job, status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await deps.sql.end({ timeout: 5 });
  }
}

Deno.serve(async (req) => {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const job = url.searchParams.get("job") ?? "";
  if (!isJobName(job)) return Response.json({ error: "unknown job" }, { status: 400 });
  const force = url.searchParams.get("force");
  const run = tick(job, url.searchParams.has("manual") ? "manual" : "schedule", force === "full" || force === "light" ? force : undefined);

  // ?wait returns the result (for testing); otherwise answer immediately and keep working in the background.
  if (url.searchParams.has("wait") || typeof EdgeRuntime === "undefined") return Response.json(await run);
  EdgeRuntime.waitUntil(run);
  return Response.json({ accepted: true, job }, { status: 202 });
});
