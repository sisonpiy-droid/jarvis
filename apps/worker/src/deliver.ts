import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GeminiProvider, meterTo, resolveAssignment } from "@jarvis/ai";
import { connect } from "@jarvis/db";
import { deliverAssignment } from "@jarvis/deliver";
import { SupabaseStorage } from "@jarvis/files";
import { createLogger, loadEnv, repoRoot } from "@jarvis/shared";

// Produce the finished deliverables (doc + filled workbook + slides) for one assignment.
//   npm run deliver -- "Lenskart workbook"            → Drafts page + a notification (inbox / push / email)
//   npm run deliver -- "Lenskart workbook" --local    → also saves the files to data/deliverables/, no notification
loadEnv();
const need = (k: string) => process.env[k] || (console.error(`${k} is not set`), process.exit(2));
const args = process.argv.slice(2);
const local = args.includes("--local");
const query = args.filter((a) => !a.startsWith("--")).join(" ");
const sql = connect(need("SUPABASE_DB_URL"));
try {
  const r = await resolveAssignment(sql, query);
  if (!("one" in r)) {
    console.log("none" in r ? "No match." : r.candidates);
    process.exit(1);
  }
  const model = process.env.GEMINI_DRAFT_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  const outDir = join(repoRoot(), "data", "deliverables");
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const res = await deliverAssignment(
    {
      sql,
      storage: new SupabaseStorage(need("SUPABASE_URL"), need("SUPABASE_SECRET_KEY")),
      model: new GeminiProvider(need("GEMINI_API_KEY"), model, fetch, 240_000, meterTo(sql)),
      modelName: model,
      ...(local
        ? {
            notify: async (n) => console.log(n.text.replace(/<[^>]+>/g, "")),
            sendFile: async (bytes: Uint8Array, name: string) => {
              writeFileSync(join(outDir, name), bytes);
              console.log(`saved ${name} (${bytes.length} bytes)`);
            },
          }
        : {}),
      log: createLogger("deliver"),
    },
    String(r.one.sourceId),
    "request",
  );
  console.log(res, `${Math.round((Date.now() - t0) / 1000)}s`);
} finally {
  await sql.end();
}
