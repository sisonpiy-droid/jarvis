import { createHash, randomBytes } from "node:crypto";
import { connect } from "@jarvis/db";
import { loadEnv } from "@jarvis/shared";

// Emergency sign-in that needs no Telegram, passkey or recovery code: proves you're the owner by having
// .env (database access) on this laptop. Prints a one-time link, valid 10 minutes.
//   npm run web:login-link

loadEnv();
const url = process.env.SUPABASE_DB_URL;
const base = (process.env.WEB_BASE_URL || process.env.JARVIS_WEB_URL || "").replace(/\/+$/, "");
if (!url || !base) {
  console.error("SUPABASE_DB_URL and JARVIS_WEB_URL (or WEB_BASE_URL) must be set in .env.");
  process.exit(2);
}
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = b64url(randomBytes(32));
const sql = connect(url);
try {
  await sql`insert into jarvis.login_tokens (token_hash, expires_at) values (${b64url(createHash("sha256").update(token).digest())}, now() + interval '10 minutes')`;
} finally {
  await sql.end();
}
console.log(`Open this within 10 minutes (works once) — don't share it:\n${base}/auth?t=${encodeURIComponent(token)}`);
