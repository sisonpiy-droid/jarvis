import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import type { Sql } from "../src/client";
import { migrate } from "../src/migrate";

// An in-process Postgres (PGlite) behind a local socket, so tests exercise the real
// migrations and the real postgres.js queries — no network, no Supabase project.

/** The few Supabase-provided objects our migrations reference. */
const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false);
`;

export interface TestDb {
  sql: Sql;
  /** Opens a second, independent connection (to test locking/concurrency). */
  connect(): Sql;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUBS);
  const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 8 });
  await server.start();
  const [host, port] = server.getServerConn().split(":");
  const opened: Sql[] = [];
  const connect = () => {
    const s = postgres({ host, port: Number(port), user: "postgres", database: "postgres", max: 1, prepare: false, onnotice: () => {} });
    opened.push(s);
    return s;
  };
  const sql = connect();
  await migrate(sql, () => {});
  return {
    sql,
    connect,
    async close() {
      await Promise.all(opened.map((s) => s.end({ timeout: 1 })));
      await server.stop();
      await db.close();
    },
  };
}
