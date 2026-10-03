import "server-only";
import postgres from "postgres";

// One small pool per server instance. Server-only: the DB URL never reaches the browser.
const g = globalThis as unknown as { __jarvisSql?: postgres.Sql };

export function db(): postgres.Sql {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not configured");
  // TLS always, except a database on this machine (local previews against a throwaway, single-session Postgres).
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  g.__jarvisSql ??= postgres(url, { ssl: local ? false : "require", prepare: false, max: local ? 1 : 3, idle_timeout: 20, connect_timeout: 15 });
  return g.__jarvisSql;
}
