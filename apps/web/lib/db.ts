import "server-only";
import postgres from "postgres";

// One small pool per server instance. Server-only: the DB URL never reaches the browser.
const g = globalThis as unknown as { __jarvisSql?: postgres.Sql };

export function db(): postgres.Sql {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not configured");
  g.__jarvisSql ??= postgres(url, { ssl: "require", prepare: false, max: 3, idle_timeout: 20, connect_timeout: 15 });
  return g.__jarvisSql;
}
