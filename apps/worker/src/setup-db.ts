import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { loadEnv, repoRoot } from "@jarvis/shared";

// Prompts for the database password with hidden input, URL-encodes it (so
// characters like @ # / just work), proves the connection, then writes
// SUPABASE_DB_URL to .env. The password is typed by you and never printed.

loadEnv();

const HOST = process.env.SUPABASE_DB_HOST ?? "aws-0-ap-south-1.pooler.supabase.com";
const ref = process.env.SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref) {
  console.error("SUPABASE_URL is missing from .env (expected https://<ref>.supabase.co).");
  process.exit(2);
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (buf += d));
      stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const password = await askHidden(`Database password for project ${ref} (input hidden): `);
if (!password) {
  console.error("No password entered.");
  process.exit(2);
}

const url = `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${HOST}:5432/postgres`;
const sql = postgres(url, { ssl: "require", connect_timeout: 15, max: 1 });
try {
  await sql`select 1`;
} catch (err) {
  const code = (err as { code?: string }).code;
  console.error(
    code === "28P01"
      ? `Password rejected (received ${password.length} characters). If that length looks wrong, the paste didn't take — try right-click to paste. Otherwise reset it in Supabase: Database → Settings → Reset database password.`
      : `Could not connect (${code ?? "unknown error"}).`,
  );
  process.exit(1);
} finally {
  await sql.end({ timeout: 1 });
}

const envFile = join(repoRoot(), ".env");
const lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("SUPABASE_DB_URL=")) : [];
lines.push(`SUPABASE_DB_URL=${url}`);
writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
console.log("Connected ✓  Saved SUPABASE_DB_URL to .env.");
