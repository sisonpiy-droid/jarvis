import { connect, getIntegration } from "@jarvis/db";
import { fileSessionStore } from "@jarvis/mesa/file-session";
import { TelegramChannel } from "@jarvis/notify";
import { createLogger, intEnv, loadEnv } from "@jarvis/shared";
import { dbSessionStore, runMesaSync } from "@jarvis/sync";

// The same sync the cloud runs every 5 minutes, run once from your laptop.
//   npm run sync:mesa               light or full, whichever is due
//   npm run sync:mesa -- --full     force a full scan
//   npm run sync:mesa -- --no-send  store changes, send nothing (queued for next run)

loadEnv();
const log = createLogger("sync:mesa");
const need = (k: string) => process.env[k] || (console.error(`${k} is not set in .env`), process.exit(2));

const sql = connect(need("SUPABASE_DB_URL"));
const key = need("MESA_SESSION_KEY");
try {
  // First run after upgrading: move the locally saved session into the database.
  if (!(await getIntegration(sql, "mesa"))?.secretSealed) {
    const local = await fileSessionStore(key).load();
    if (local) {
      await dbSessionStore(sql, key).save(local);
      log.info("copied local MESA session into Supabase");
    }
  }
  const args = process.argv.slice(2);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const summary = await runMesaSync(
    {
      sql,
      sessionKey: key,
      channel: token && chat ? new TelegramChannel(token, chat) : null,
      log,
      maxConcurrency: intEnv("MESA_MAX_CONCURRENCY", 3),
      minGapMs: intEnv("MESA_MIN_GAP_MS", 150),
    },
    { trigger: "manual", ...(args.includes("--full") ? { force: "full" as const } : {}), send: !args.includes("--no-send") },
  );
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.status === "failed" ? 1 : 0;
} finally {
  await sql.end();
}
