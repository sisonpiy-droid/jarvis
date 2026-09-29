import { GeminiProvider } from "@jarvis/ai";
import { draftAssignment, telegramSender } from "@jarvis/assist";
import { connect } from "@jarvis/db";
import { SupabaseStorage } from "@jarvis/files";
import { resolveAssignment } from "@jarvis/ai";
import { createLogger, loadEnv } from "@jarvis/shared";

// Draft one assignment from the laptop (same code the cloud runs):
//   npm run draft -- "Finance end term"
loadEnv();
const need = (k: string) => process.env[k] || (console.error(`${k} is not set`), process.exit(2));
const query = process.argv.slice(2).join(" ").trim();
if (!query) { console.error('Usage: npm run draft -- "<assignment title words>"'); process.exit(2); }
const sql = connect(need("SUPABASE_DB_URL"));
try {
  const r = await resolveAssignment(sql, query);
  if (!("one" in r)) { console.log("none" in r ? "No match." : r.candidates); process.exit(1); }
  const model = process.env.GEMINI_DRAFT_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  const tg = telegramSender(need("TELEGRAM_BOT_TOKEN"), need("TELEGRAM_CHAT_ID"));
  const t0 = Date.now();
  const out = await draftAssignment(
    { sql, storage: new SupabaseStorage(need("SUPABASE_URL"), need("SUPABASE_SECRET_KEY")), model: new GeminiProvider(need("GEMINI_API_KEY"), model, fetch, 180_000), modelName: model, sendMessage: tg.sendMessage, sendDocument: tg.sendDocument, log: createLogger("draft") },
    String(r.one.sourceId),
    "request",
  );
  console.log(out, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
} finally {
  await sql.end();
}
