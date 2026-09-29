import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/**
 * Connects to Postgres. prepare:false keeps it compatible with Supabase's
 * poolers; max:1 is plenty for a single short-lived sync.
 */
export function connect(url: string): Sql {
  return postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15, idle_timeout: 5, onnotice: () => {} });
}
