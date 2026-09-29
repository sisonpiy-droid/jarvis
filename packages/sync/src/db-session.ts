import { getIntegration, saveSession, type Sql } from "@jarvis/db";
import { SealedSessionStore, type SealedBlobStore } from "@jarvis/mesa";

/** Keeps the sealed MESA session in jarvis.integrations so any worker (local or cloud) can use it. */
export class DbBlobStore implements SealedBlobStore {
  constructor(
    private readonly sql: Sql,
    private readonly provider = "mesa",
  ) {}

  async read(): Promise<string | null> {
    return (await getIntegration(this.sql, this.provider))?.secretSealed ?? null;
  }

  async write(sealed: string, meta: { expiresAt: string | null }): Promise<void> {
    await saveSession(this.sql, this.provider, sealed, meta.expiresAt);
  }
}

export const dbSessionStore = (sql: Sql, key: string) => new SealedSessionStore(key, new DbBlobStore(sql));
