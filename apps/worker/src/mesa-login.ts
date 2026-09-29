import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@jarvis/db";
import { refreshAccessToken, sessionExpiry, type SessionStore } from "@jarvis/mesa";
import { fileSessionStore } from "@jarvis/mesa/file-session";
import { interactiveLogin } from "@jarvis/mesa/login";
import { dbSessionStore } from "@jarvis/sync";
import { generateKey, loadEnv, repoRoot } from "@jarvis/shared";

// Opens a visible browser; YOU sign in (password + any OTP). JARVIS stores only
// the resulting session cookie, encrypted — in Supabase (so the cloud worker can
// use it) and in .secrets/ as a local fallback. Re-run when the session expires.

loadEnv();

function ensureKey(): string {
  const existing = process.env.MESA_SESSION_KEY;
  if (existing) return existing;
  const key = generateKey();
  const envFile = join(repoRoot(), ".env");
  const prefix = existsSync(envFile) && !readFileSync(envFile, "utf8").endsWith("\n") ? "\n" : "";
  appendFileSync(envFile, `${prefix}MESA_SESSION_KEY=${key}\n`, { mode: 0o600 });
  console.log("Generated MESA_SESSION_KEY and saved it to .env (gitignored).");
  return key;
}

const key = ensureKey();
const state = await interactiveLogin({
  channel: process.env.MESA_BROWSER_CHANNEL ?? "msedge",
  onStatus: (m: string) => console.log(m),
});

// Prove the captured session actually works before declaring success.
const { state: working } = await refreshAccessToken(state);

const stores: Array<[string, SessionStore]> = [["local file", fileSessionStore(key)]];
const sql = process.env.SUPABASE_DB_URL ? connect(process.env.SUPABASE_DB_URL) : null;
if (sql) stores.push(["Supabase", dbSessionStore(sql, key)]);
for (const [name, store] of stores) {
  await store.save(working);
  console.log(`Saved encrypted MESA session → ${name}`);
}
await sql?.end();

console.log(`Session expires: ${sessionExpiry(working) ?? "at browser close (session cookie)"}`);
