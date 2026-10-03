import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { finishJob, jobHealth, pruneJobRuns, recordJobSkipped } from "../src/jobs";
import { createTestDb, type TestDb } from "./harness";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());

describe("migrations", () => {
  it("apply in order and record every file", async () => {
    const files = readdirSync(join(import.meta.dirname, "..", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    const rows = await t.sql`select name from jarvis._migrations order by name`;
    expect(rows.map((r) => r.name)).toEqual(files);
  });

  it("are idempotent on re-run", async () => {
    expect(await migrate(t.sql, () => {})).toEqual([]);
  });

  it("leave RLS enabled on every jarvis table", async () => {
    const rows = await t.sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'jarvis' and c.relkind = 'r' and c.relname <> '_migrations' and not c.relrowsecurity`;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("seed the scheduled jobs", async () => {
    const health = await jobHealth(t.sql);
    expect(health.map((j) => j.name).sort()).toEqual(["briefs", "calendar", "drafts", "engine", "habits", "health", "mesa", "notify", "prep"]);
    expect(health.every((j) => j.health === "never_run")).toBe(true);
  });
});

describe("job health", () => {
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);

  it("records work in history, but idle runs only on the heartbeat", async () => {
    await finishJob(t.sql, "drafts", { status: "idle", trigger: "schedule", startedAt: at(1), durationMs: 5 });
    await finishJob(t.sql, "drafts", { status: "success", trigger: "manual", startedAt: at(0), durationMs: 50, stats: { requested: 1 } });
    const runs = await t.sql`select status, trigger, stats from jarvis.job_runs where job = 'drafts'`;
    expect(runs).toEqual([{ status: "success", trigger: "manual", stats: { requested: 1 } }]);
    const drafts = (await jobHealth(t.sql)).find((j) => j.name === "drafts")!;
    expect(drafts.health).toBe("ok");
    expect(drafts.lastStatus).toBe("success");
  });

  it("counts consecutive failures and resets them on success", async () => {
    await finishJob(t.sql, "calendar", { status: "success", trigger: "schedule", startedAt: at(2), durationMs: 10 });
    await finishJob(t.sql, "calendar", { status: "failed", trigger: "schedule", startedAt: at(1), durationMs: 10, error: "boom" });
    await finishJob(t.sql, "calendar", { status: "failed", trigger: "schedule", startedAt: at(0), durationMs: 10, error: "boom again" });
    let cal = (await jobHealth(t.sql)).find((j) => j.name === "calendar")!;
    expect(cal).toMatchObject({ health: "failing", consecutiveFailures: 2, lastError: "boom again" });
    await finishJob(t.sql, "calendar", { status: "partial", trigger: "schedule", startedAt: at(0), durationMs: 10 });
    cal = (await jobHealth(t.sql)).find((j) => j.name === "calendar")!;
    expect(cal).toMatchObject({ health: "ok", consecutiveFailures: 0 });
  });

  it("marks a job stale after 3 missed cadences", async () => {
    await finishJob(t.sql, "mesa", { status: "success", trigger: "schedule", startedAt: at(16), durationMs: 10 });
    expect((await jobHealth(t.sql)).find((j) => j.name === "mesa")!.health).toBe("stale"); // cadence 5 min
    await finishJob(t.sql, "mesa", { status: "failed", trigger: "schedule", startedAt: at(0), durationMs: 10, error: "x" });
    expect((await jobHealth(t.sql)).find((j) => j.name === "mesa")!.health).toBe("stale");
  });

  it("records skips without touching the heartbeat, and prunes old history", async () => {
    const before = (await jobHealth(t.sql)).find((j) => j.name === "briefs")!;
    await recordJobSkipped(t.sql, "briefs", "schedule", at(0));
    expect((await jobHealth(t.sql)).find((j) => j.name === "briefs")).toEqual(before);
    await t.sql`update jarvis.job_runs set started_at = now() - interval '40 days' where job = 'briefs'`;
    expect(await pruneJobRuns(t.sql, 30)).toBe(1);
  });
});
