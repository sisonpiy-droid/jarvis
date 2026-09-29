import { GeminiProvider } from "@jarvis/ai";
import { draftAssignment, telegramSender } from "@jarvis/assist";
import { connect } from "@jarvis/db";
import { SupabaseStorage } from "@jarvis/files";
import { createLogger, loadEnv } from "@jarvis/shared";
import { nextToDraft } from "@jarvis/sync";

// Drafts every open, unsubmitted assignment that has no draft yet — one after another.
//   npm run draft:all
loadEnv();
const need = (k: string) => process.env[k] || (console.error(`${k} is not set`), process.exit(2));
const sql = connect(need("SUPABASE_DB_URL"));
try {
  const ids = await nextToDraft(sql, new Date(), 25);
  console.log(`${ids.length} assignment(s) to draft`);
  const model = process.env.GEMINI_DRAFT_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  const tg = telegramSender(need("TELEGRAM_BOT_TOKEN"), need("TELEGRAM_CHAT_ID"));
  const deps = {
    sql,
    storage: new SupabaseStorage(need("SUPABASE_URL"), need("SUPABASE_SECRET_KEY")),
    model: new GeminiProvider(need("GEMINI_API_KEY"), model, fetch, 180_000),
    modelName: model,
    sendMessage: tg.sendMessage,
    sendDocument: tg.sendDocument,
    log: createLogger("draft-all"),
  };
  for (const [i, id] of ids.entries()) {
    const [row] = await sql`select title from jarvis.lms_items where kind = 'assignment' and source_id = ${id}`;
    const t0 = Date.now();
    const r = await draftAssignment(deps, id, "auto");
    console.log(`${i + 1}/${ids.length} ${r.status}${r.reason ? ` (${r.reason})` : ""} · ${Math.round((Date.now() - t0) / 1000)}s · ${row?.title}`);
  }
} finally {
  await sql.end();
}
