import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@jarvis/db";
import { loadEnv, repoRoot } from "@jarvis/shared";

// One command to put JARVIS in Supabase's cloud:
//   1. bundle the Edge Function        3. deploy it
//   2. upload its secrets              4. schedule it every 5 min with pg_cron
//   5. call it once and show the result
//   6. deploy the Telegram bot and point Telegram's webhook at it
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
const EVERY = process.env.MESA_SYNC_CRON ?? "*/5 * * * *";
const CLI = ["-y", "supabase@2.118.0"];
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args: string[]) => execFileSync(npx, [...CLI, ...args], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

console.log("1/5 bundling Edge Function…");
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "-s", "edge:build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

console.log("2/5 uploading secrets…");
const secretsDir = join(root, ".secrets");
mkdirSync(secretsDir, { recursive: true });
const secretsFile = join(secretsDir, "edge.env");
try {
  const keys = ["MESA_SESSION_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "CRON_SECRET", "TELEGRAM_WEBHOOK_SECRET", "JARVIS_WEB_URL"];
  const optional = ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_DRAFT_MODEL", "AUTO_DRAFT", "GCAL_ICS_URL"].filter((k) => process.env[k]);
  writeFileSync(secretsFile, [...keys.map((k) => `${k}=${need(k)}`), ...optional.map((k) => `${k}=${process.env[k]}`)].join("\n") + "\n", { mode: 0o600 });
  if (!optional.includes("GEMINI_API_KEY")) console.log("   (no GEMINI_API_KEY yet — chat will answer quick commands only)");
  run(["secrets", "set", "--project-ref", ref, "--env-file", secretsFile]);
} finally {
  rmSync(secretsFile, { force: true });
}

console.log("3/5 deploying mesa-sync…");
run(["functions", "deploy", "mesa-sync", "--project-ref", ref, "--use-api", "--no-verify-jwt"]);

console.log(`4/5 scheduling (${EVERY})…`);
const sql = connect(need("SUPABASE_DB_URL"));
try {
  await sql`create extension if not exists pg_cron`;
  await sql`create extension if not exists pg_net`;
  const [existing] = await sql`select id from vault.secrets where name = 'jarvis_cron_secret'`;
  if (existing) await sql`select vault.update_secret(${existing.id}, ${need("CRON_SECRET")})`;
  else await sql`select vault.create_secret(${need("CRON_SECRET")}, 'jarvis_cron_secret')`;
  const fnUrl = `https://${ref}.supabase.co/functions/v1/mesa-sync`;
  const command = `select net.http_post(
      url := '${fnUrl}',
      headers := jsonb_build_object('Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000)`;
  await sql`select cron.unschedule(jobname) from cron.job where jobname = 'jarvis-mesa-sync'`;
  await sql`select cron.schedule('jarvis-mesa-sync', ${EVERY}, ${command})`;
} finally {
  await sql.end();
}

console.log("5/5 test call from the cloud…");
const res = await fetch(`https://${ref}.supabase.co/functions/v1/mesa-sync?wait&manual`, {
  method: "POST",
  headers: { Authorization: `Bearer ${need("CRON_SECRET")}` },
});
console.log(`HTTP ${res.status}`, await res.text());
console.log("6/6 deploying telegram-bot and registering the webhook…");
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
  ["draft", "Draft an assignment (Word doc)"],
  ["memory", "What JARVIS remembers about you"],
  ["help", "What JARVIS can do"],
].map(([command, description]) => ({ command, description }));
await fetch(`https://api.telegram.org/bot${need("TELEGRAM_BOT_TOKEN")}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ commands }),
});

console.log(`\nDone. JARVIS now checks MESA on schedule "${EVERY}" and answers you on Telegram — your laptop can be off.`);
