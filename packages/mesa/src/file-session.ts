import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot } from "@jarvis/shared";
import { SealedSessionStore, type SealedBlobStore } from "./session-store";

// Node-only local fallback: the sealed session in .secrets/ (gitignored).

export function defaultSessionPath(): string {
  return join(repoRoot(), ".secrets", "mesa-session.enc");
}

export class FileBlobStore implements SealedBlobStore {
  constructor(private readonly path = defaultSessionPath()) {}

  async read(): Promise<string | null> {
    return existsSync(this.path) ? readFileSync(this.path, "utf8") : null;
  }

  async write(sealed: string): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, sealed, { mode: 0o600 });
    renameSync(tmp, this.path); // atomic replace: a crash never leaves a half-written session
  }
}

export const fileSessionStore = (key: string, path?: string) => new SealedSessionStore(key, new FileBlobStore(path));
