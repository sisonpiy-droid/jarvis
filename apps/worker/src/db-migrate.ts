import { connect } from "@jarvis/db";
import { migrate } from "@jarvis/db/migrate";
import { loadEnv } from "@jarvis/shared";

loadEnv();
const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is not set — run `npm run setup:db`.");
  process.exit(2);
}
const sql = connect(url);
try {
  await migrate(sql);
} finally {
  await sql.end();
}
