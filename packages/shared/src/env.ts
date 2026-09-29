import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Walk up from cwd to the repo root (the directory holding the workspace
// package.json with a .git sibling) so scripts work from any workspace.
export function repoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Load <repo>/.env into process.env if it exists. Real env vars win. */
export function loadEnv(): void {
  const file = join(repoRoot(), ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
