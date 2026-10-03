import { connect } from "@jarvis/db";
import { extractPdfText, SupabaseStorage } from "@jarvis/files";
import { loadEnv } from "@jarvis/shared";

// One-off backfill: extract text from PDFs that were stored before JARVIS could read PDFs, so chat can answer
// from pre-reads, slides and readings. New downloads are extracted automatically by the mesa job.
//
//   npm run files:extract-pdfs -- --dry-run   # extract and report, write nothing
//   npm run files:extract-pdfs                # write text_content for every PDF that has a text layer

loadEnv();
const dryRun = process.argv.includes("--dry-run");
const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`${k} must be set in .env.`);
    process.exit(2);
  }
  return v;
};
const sql = connect(need("SUPABASE_DB_URL"));
const storage = new SupabaseStorage(need("SUPABASE_URL"), need("SUPABASE_SECRET_KEY"));

const rows = await sql`
  select sha256, storage_path, original_filename from jarvis.files
   where text_status = 'original' and (mime_type ilike '%pdf%' or original_filename ilike '%.pdf')
   order by size_bytes`;
console.log(`${rows.length} stored PDFs without text${dryRun ? " (dry run — nothing will be written)" : ""}`);

const tally = { extracted: 0, scanned: 0, failed: 0, chars: 0 };
for (const r of rows) {
  const name = String(r.original_filename ?? r.sha256);
  try {
    const text = await extractPdfText(await storage.download(String(r.storage_path)));
    if (!text) {
      tally.scanned++;
      console.log(`  - ${name}: no text layer (scanned) — left as original`);
      continue;
    }
    tally.extracted++;
    tally.chars += text.length;
    console.log(`  ✓ ${name}: ${text.length.toLocaleString()} characters`);
    if (!dryRun) await sql`update jarvis.files set text_status = 'done', text_content = ${text} where sha256 = ${r.sha256} and text_status = 'original'`;
  } catch (err) {
    tally.failed++;
    console.log(`  ✗ ${name}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
  }
}
console.log(`\nDone: ${tally.extracted} with text (${tally.chars.toLocaleString()} characters), ${tally.scanned} scanned, ${tally.failed} failed.${dryRun ? " Dry run: nothing written." : ""}`);
await sql.end();
