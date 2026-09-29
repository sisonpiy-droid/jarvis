import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MesaAuthError, MesaClient, TokenProvider, extractSnapshot } from "@jarvis/mesa";
import { fileSessionStore } from "@jarvis/mesa/file-session";
import { createLogger, intEnv, loadEnv, repoRoot } from "@jarvis/shared";

// Proof of concept: read-only snapshot of the LMS as structured JSON.
// Writes data/snapshots/mesa-<timestamp>.json (gitignored) and prints a summary.
// Flags: --stdout  print the full JSON instead of the summary.

loadEnv();
const log = createLogger("mesa:extract");

const key = process.env.MESA_SESSION_KEY;
if (!key) {
  console.error("MESA_SESSION_KEY is not set. Run `npm run mesa:login` first.");
  process.exit(2);
}

const client = new MesaClient({
  tokens: new TokenProvider(fileSessionStore(key)),
  maxConcurrency: intEnv("MESA_MAX_CONCURRENCY", 3),
  minGapMs: intEnv("MESA_MIN_GAP_MS", 150),
});

try {
  const snapshot = await extractSnapshot(client, { log });
  const dir = join(repoRoot(), "data", "snapshots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `mesa-${snapshot.meta.extractedAt.replace(/[:.]/g, "-")}.json`);
  delete snapshot.transient; // signed URLs are credentials-in-a-URL: never written to disk
  writeFileSync(file, JSON.stringify(snapshot, null, 2));

  if (process.argv.includes("--stdout")) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    const now = Date.now();
    const upcoming = snapshot.assignments.filter((a) => a.dueAt && Date.parse(a.dueAt) > now);
    console.log(`\n${snapshot.student?.name} · ${snapshot.student?.program} · ${snapshot.student?.batch}`);
    console.log(`Counts: ${JSON.stringify(snapshot.meta.counts)}`);
    console.log(`Requests: ${snapshot.meta.requestCount} in ${(snapshot.meta.durationMs / 1000).toFixed(1)}s`);
    console.log(`\nUpcoming assignments (${upcoming.length}):`);
    for (const a of upcoming) {
      console.log(`  • ${a.dueAtIst}  [${a.submissionStatus}]  ${a.courseTitle ?? "(no course)"} — ${a.title}`);
    }
    if (snapshot.meta.warnings.length) {
      console.log(`\nWarnings (${snapshot.meta.warnings.length}):`);
      for (const w of snapshot.meta.warnings.slice(0, 15)) console.log(`  ! ${w.where}: ${w.message}`);
    }
    console.log(`\nFull JSON: ${file}`);
  }
} catch (err) {
  if (err instanceof MesaAuthError) {
    console.error(`${err.message}`);
    process.exit(3);
  }
  log.error("extract failed", { error: err });
  process.exit(1);
}
