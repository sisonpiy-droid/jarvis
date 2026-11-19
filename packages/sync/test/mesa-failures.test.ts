import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import { MesaAuthError } from "@jarvis/mesa";
import { createLogger } from "@jarvis/shared";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { handleFailure, type SyncDeps } from "../src/run";

// "Your sign-in has expired" must mean the sign-in really is gone — not that MESA hiccuped once (it sent that alarm
// at 1:00 am on 19 Oct after a single HTTP 502 on the token refresh; the next run, five minutes later, was fine).

vi.spyOn(console, "log").mockImplementation(() => {});
const NOW = new Date("2026-10-19T19:30:00.000Z");
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.notifications, jarvis.sync_runs, jarvis.integrations restart identity cascade`;
  await t.sql`insert into jarvis.integrations (provider, status) values ('mesa', 'active')`;
});

const fail = async (err: unknown) => {
  const runId = await db.startRun(t.sql, "mesa", "light", "schedule");
  return handleFailure({ sql: t.sql, log: createLogger("test") } as unknown as SyncDeps, runId, "light", err, NOW);
};
const alerts = async () => (await t.sql`select dedupe_key from jarvis.notifications order by id`).map((r) => String(r.dedupe_key));
const status = async () => (await db.getIntegration(t.sql, "mesa"))!.status;

describe("handleFailure", () => {
  it("a refresh that failed with a server error is not an expired sign-in: no alarm, still active, retried next run", async () => {
    await fail(new MesaAuthError("Token refresh failed with HTTP 502", "REFRESH_FAILED"));
    expect(await alerts()).toEqual([]);
    expect(await status()).toBe("active");
    expect((await db.getIntegration(t.sql, "mesa"))!.consecutiveFailures).toBe(1);
  });

  it("three failures in a row do raise the 'sync failing' alert — a real problem is still reported", async () => {
    for (let i = 0; i < 3; i++) await fail(new MesaAuthError("Token refresh failed with HTTP 502", "REFRESH_FAILED"));
    expect(await alerts()).toEqual(["mesa.sync_failing:2026-10-19"]);
    expect(await status()).toBe("active");
  });

  it("a session that is really gone still asks for a login, urgently", async () => {
    await fail(new MesaAuthError("MESA session has expired — run `npm run mesa:login`", "SESSION_EXPIRED"));
    expect(await alerts()).toEqual(["mesa.session_expired:2026-10-19"]);
    expect(await status()).toBe("needs_login");
    const [n] = await t.sql`select priority from jarvis.notifications`;
    expect(n!.priority).toBe("urgent");
  });

  it("no saved session at all also needs a login", async () => {
    await fail(new MesaAuthError("No saved MESA session — run `npm run mesa:login`", "NO_SESSION"));
    expect(await alerts()).toEqual(["mesa.session_expired:2026-10-19"]);
  });
});
