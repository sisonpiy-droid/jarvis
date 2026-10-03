import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@jarvis/db";
import { JOB_NAMES, JOB_SCHEDULES } from "@jarvis/sync";
import { loadEnv, repoRoot } from "@jarvis/shared";

// One command to put JARVIS in Supabase's cloud:
//   1. bundle the Edge Functions       3. deploy jarvis-tick and mesa-sync
//   2. upload their secrets            4. schedule one pg_cron entry per job (jarvis-job-<name> → jarvis-tick?job=<name>)
//   5. run the health job once and show the result
//   6. deploy the Telegram bot and point Telegram's webhook at it
// Run `npm run db:migrate` first: the jobs and the bot need every migration up to 0020 (class prep job and notes).
// Needs SUPABASE_ACCESS_TOKEN in .env (supabase.com/dashboard/account/tokens).

loadEnv();
const root = repoRoot();
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`${k} is not set in .env`);
    process.exit(2);
  }
  return v;
};

const ref = need("SUPABASE_URL").match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref) throw new Error("SUPABASE_URL must look like https://<ref>.supabase.co");
need("SUPABASE_ACCESS_TOKEN");
const SCHEDULES = { ...JOB_SCHEDULES, ...(process.env.MESA_SYNC_CRON ? { mesa: process.env.MESA_SYNC_CRON } : {}) };
const CLI = ["-y", "supabase@2.118.0"];
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args: string[]) => execFileSync(npx, [...CLI, ...args], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

{
  const check = connect(need("SUPABASE_DB_URL"));
  try {
    const [m] = await check`select 1 from jarvis._migrations where name = '0020_class_prep.sql'`;
    if (!m) {
      console.error("Migration 0020_class_prep.sql isn't applied yet — run `npm run db:migrate` first.");
      process.exit(2);
    }
  } finally {
    await check.end();
  }
}

console.log("1/5 bundling Edge Functions…");
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "-s", "edge:build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

console.log("2/5 uploading secrets…");
const secretsDir = join(root, ".secrets");
mkdirSync(secretsDir, { recursive: true });
const secretsFile = join(secretsDir, "edge.env");
try {
  const keys = ["MESA_SESSION_KEY", "CRON_SECRET", "JARVIS_WEB_URL"];
  const optional = [
    "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_DRAFT_MODEL", "AUTO_DRAFT", "BRIEF_AI", "GCAL_ICS_URL",
    // Notifications: push (VAPID, `npm run setup:push`) and email (Resend). The in-app inbox needs neither.
    "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "RESEND_API_KEY", "NOTIFY_EMAIL_TO", "NOTIFY_EMAIL_FROM",
    // Legacy Telegram channel and bot (rollback until Phase 11).
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET",
  ].filter((k) => process.env[k]);
  if (!optional.includes("VAPID_PRIVATE_KEY")) console.log("   (no VAPID keys — push is off until you run `npm run setup:push`)");
  if (!optional.includes("RESEND_API_KEY")) console.log("   (no RESEND_API_KEY — email notifications are off)");
  writeFileSync(secretsFile, [...keys.map((k) => `${k}=${need(k)}`), ...optional.map((k) => `${k}=${process.env[k]}`)].join("\n") + "\n", { mode: 0o600 });
  if (!optional.includes("GEMINI_API_KEY")) console.log("   (no GEMINI_API_KEY yet — chat will answer quick commands only)");
  run(["secrets", "set", "--project-ref", ref, "--env-file", secretsFile]);
} finally {
  rmSync(secretsFile, { force: true });
}

console.log("3/5 deploying jarvis-tick and mesa-sync…");
run(["functions", "deploy", "jarvis-tick", "--project-ref", ref, "--use-api", "--no-verify-jwt"]);
run(["functions", "deploy", "mesa-sync", "--project-ref", ref, "--use-api", "--no-verify-jwt"]);

console.log("4/5 scheduling one cron entry per job…");
const sql = connect(need("SUPABASE_DB_URL"));
try {
  await sql`create extension if not exists pg_cron`;
  await sql`create extension if not exists pg_net`;
  const [existing] = await sql`select id from vault.secrets where name = 'jarvis_cron_secret'`;
  if (existing) await sql`select vault.update_secret(${existing.id}, ${need("CRON_SECRET")})`;
  else await sql`select vault.create_secret(${need("CRON_SECRET")}, 'jarvis_cron_secret')`;
  const command = (job: string) => `select net.http_post(
      url := 'https://${ref}.supabase.co/functions/v1/jarvis-tick?job=${job}',
      headers := jsonb_build_object('Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000)`;
  // The single all-in-one entry is replaced by one entry per job.
  await sql`select cron.unschedule(jobname) from cron.job where jobname = 'jarvis-mesa-sync'`;
  for (const job of JOB_NAMES) {
    const name = `jarvis-job-${job}`;
    await sql`select cron.unschedule(jobname) from cron.job where jobname = ${name}`;
    await sql`select cron.schedule(${name}, ${SCHEDULES[job]}, ${command(job)})`;
    console.log(`   ${name.padEnd(20)} ${SCHEDULES[job]}`);
  }
} finally {
  await sql.end();
}

console.log("5/5 test call from the cloud (health job)…");
const res = await fetch(`https://${ref}.supabase.co/functions/v1/jarvis-tick?job=health&wait&manual`, {
  method: "POST",
  headers: { Authorization: `Bearer ${need("CRON_SECRET")}` },
});
console.log(`HTTP ${res.status}`, await res.text());
const telegram = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_WEBHOOK_SECRET);
if (!telegram) {
  console.log("6/6 Telegram not configured — skipping the legacy bot.");
  console.log(`
Done. JARVIS runs ${JOB_NAMES.length} scheduled jobs in the cloud (see the Status page) — your laptop can be off.`);
  process.exit(0);
}
console.log("6/6 deploying the legacy telegram-bot and registering the webhook…");
run(["functions", "deploy", "telegram-bot", "--project-ref", ref, "--use-api", "--no-verify-jwt"]);
run(["functions", "deploy", "assignment-draft", "--project-ref", ref, "--use-api", "--no-verify-jwt"]);
const hook = await fetch(`https://api.telegram.org/bot${need("TELEGRAM_BOT_TOKEN")}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `https://${ref}.supabase.co/functions/v1/telegram-bot`,
    secret_token: need("TELEGRAM_WEBHOOK_SECRET"),
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
}).then((r) => r.json() as Promise<{ ok: boolean; description?: string }>);
console.log(`Telegram webhook: ${hook.ok ? "set" : `FAILED ${hook.description}`}`);
const commands = [
  ["due", "What's due in the next 7 days"],
  ["today", "Today's classes"],
  ["tomorrow", "Tomorrow's classes"],
  ["status", "Sync health and sign-in expiry"],
  ["sync", "Check the LMS right now"],
  ["draft", "Do an assignment (doc + workbook/slides)"],
  ["revise", "Edit an assignment: /revise name | change"],
  ["memory", "What JARVIS remembers about you"],
  ["help", "What JARVIS can do"],
].map(([command, description]) => ({ command, description }));
await fetch(`https://api.telegram.org/bot${need("TELEGRAM_BOT_TOKEN")}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ commands }),
});

console.log(`\nDone. JARVIS runs ${JOB_NAMES.length} scheduled jobs in the cloud (see the Status page) — your laptop can be off.`);
