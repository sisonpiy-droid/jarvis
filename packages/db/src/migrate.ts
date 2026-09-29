import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client";

// Node-only. Applies packages/db/migrations/*.sql in filename order, each in
// its own transaction, recording what ran in jarvis._migrations.

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(sql: Sql, log: (m: string) => void = console.log): Promise<string[]> {
  await sql`create schema if not exists jarvis`;
  await sql`create table if not exists jarvis._migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select name from jarvis._migrations`).map((r) => r.name as string));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into jarvis._migrations (name) values (${file})`;
    });
    log(`applied ${file}`);
    applied.push(file);
  }
  if (!applied.length) log("database is up to date");
  return applied;
}
