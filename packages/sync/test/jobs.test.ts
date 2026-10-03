import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import type { Channel } from "@jarvis/notify";
import { createLogger } from "@jarvis/shared";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { say, scripted } from "../../ai/test/scripted";
import type { ModelProvider } from "@jarvis/ai";
import { runJob, runMesaSync, runScheduledJob } from "../src/jobs";
import type { SyncDeps } from "../src/run";
import { seedBriefWorld } from "./brief-world";

// Jobs against the real migrations (in-process Postgres). Nothing here reaches MESA, Google or Telegram.

const NOW = new Date("2026-10-01T03:30:00.000Z"); // 09:00 IST
const log = createLogger("test");
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.job_runs, jarvis.notifications, jarvis.notification_deliveries, jarvis.locks, jarvis.integrations, jarvis.lms_items, jarvis.drafts, jarvis.activities, jarvis.habits, jarvis.goals,
                jarvis.briefs, jarvis.tasks, jarvis.projects cascade`;
  await t.sql`update jarvis.jobs set enabled = true, last_started_at = null, last_finished_at = null, last_success_at = null,
                last_failure_at = null, last_status = null, consecutive_failures = 0, last_error = null, last_duration_ms = null`;
});

const sentTexts: string[] = [];
const channel = (fail = false): Channel => ({
  async send(text) {
    if (fail) throw new Error("channel down");
    sentTexts.push(text);
    return String(sentTexts.length);
  },
});
const deps = (o: Partial<SyncDeps> = {}): SyncDeps => ({ sql: t.sql, sessionKey: "k".repeat(43), channel: channel(), log, now: () => NOW, ...o });
const job = async (name: string) => (await db.jobHealth(t.sql)).find((j) => j.name === name)!;
const runs = (name: string) => t.sql`select status, trigger, stats, error from jarvis.job_runs where job = ${name} order by id`;
const queue = (key: string, at = NOW) =>
  db.enqueueNotifications(t.sql, [{ dedupeKey: key, priority: "high", text: `msg ${key}`, scheduledFor: at.toISOString() }]);

describe("runJob", () => {
  it("records success, failure and idle runs on the heartbeat", async () => {
    await runJob(t.sql, log, "health", "manual", async () => ({ status: "success", stats: { n: 1 } }));
    await runJob(t.sql, log, "health", "schedule", async () => {
      throw new Error("db hiccup");
    });
    expect(await job("health")).toMatchObject({ lastStatus: "failed", consecutiveFailures: 1, lastError: "db hiccup", health: "failing" });
    await runJob(t.sql, log, "health", "schedule", async () => ({ status: "idle" }));
    expect(await job("health")).toMatchObject({ lastStatus: "idle", consecutiveFailures: 0, health: "ok" });
    expect((await runs("health")).map((r) => r.status)).toEqual(["success", "failed"]); // idle isn't kept in history
  });

  it("skips (and records it) while another run holds the lease", async () => {
    let release!: () => void;
    const slow = runJob(t.sql, log, "drafts", "schedule", () => new Promise((r) => (release = () => r({ status: "success" }))));
    await vi.waitFor(async () => expect((await job("drafts")).lastStartedAt).not.toBeNull(), { timeout: 10_000, interval: 25 });
    const second = await runJob(t.connect(), log, "drafts", "schedule", async () => ({ status: "success" }));
    expect(second.status).toBe("skipped");
    release();
    expect((await slow).status).toBe("success");
    expect((await runs("drafts")).map((r) => r.status).sort()).toEqual(["skipped", "success"]);
  });

  it("does nothing for a disabled job", async () => {
    await t.sql`update jarvis.jobs set enabled = false where name = 'briefs'`;
    const fn = vi.fn();
    expect((await runJob(t.sql, log, "briefs", "schedule", fn)).status).toBe("disabled");
    expect(fn).not.toHaveBeenCalled();
    expect((await job("briefs")).health).toBe("disabled");
  });
});

describe("notify job", () => {
  it("sends what's due once, leaves future items queued", async () => {
    sentTexts.length = 0;
    await queue("a");
    await queue("later", new Date(Date.now() + 3_600_000));
    const r = await runScheduledJob("notify", deps(), { trigger: "schedule" });
    expect(r).toMatchObject({ status: "success", stats: { sent: 1, failed: 0 } });
    expect(sentTexts).toEqual(["msg a"]);
    expect((await runScheduledJob("notify", deps(), { trigger: "schedule" })).status).toBe("idle");
    const [later] = await t.sql`select status from jarvis.notifications where dedupe_key = 'later'`;
    expect(later!.status).toBe("queued");
  });

  it("never double-sends when a second dispatcher starts mid-send", async () => {
    // (PGlite is one session, so the second dispatcher runs while the first is waiting on its channel.)
    sentTexts.length = 0;
    for (const k of ["r1", "r2", "r3"]) await queue(k);
    let unblock!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const inSend = new Promise<void>((r) => (entered = r));
    const slow: Channel = { send: async (text) => (entered(), await gate, sentTexts.push(text), "x") };
    const first = runScheduledJob("notify", deps({ channel: slow }), { trigger: "schedule" });
    await inSend; // the first dispatcher holds the lease and is mid-send, with no query in flight
    const second = await runScheduledJob("notify", deps({ sql: t.connect() }), { trigger: "manual" });
    unblock();
    expect(second.status).toBe("skipped");
    expect((await first).status).toBe("success");
    expect(sentTexts.filter((s) => s.includes("r1"))).toHaveLength(1);
  });

  it("reports a failing channel; the item still reaches the inbox and the delivery is retried", async () => {
    await queue("f");
    const r = await runScheduledJob("notify", deps({ channel: channel(true) }), { trigger: "schedule" });
    expect(r.status).toBe("partial");
    const [n] = await t.sql`select status from jarvis.notifications where dedupe_key = 'f'`;
    expect(n!.status).toBe("sent"); // routed: visible in the inbox
    const [d] = await t.sql`select channel, status, attempts from jarvis.notification_deliveries`;
    expect(d).toMatchObject({ channel: "telegram", status: "pending", attempts: 1 });
  });

  it("is idle when sending is off, and needs no Telegram to fill the inbox", async () => {
    await queue("held");
    expect((await runScheduledJob("notify", deps(), { trigger: "manual", send: false })).status).toBe("idle");
    const r = await runScheduledJob("notify", deps({ channel: null }), { trigger: "schedule" });
    expect(r).toMatchObject({ status: "success", stats: { routed: 1, sent: 0 } });
    expect(await db.unreadCount(t.sql)).toBe(1);
  });
});

describe("briefs job", () => {
  it("waits for fresh MESA data, then queues the brief exactly once a day", async () => {
    expect(await runScheduledJob("briefs", deps(), { trigger: "schedule" })).toMatchObject({ status: "idle", stats: { waitingForFreshLmsData: true } });
    await t.sql`insert into jarvis.integrations (provider, status, last_success_at) values ('mesa', 'active', ${new Date(NOW.getTime() - 5 * 60_000).toISOString()})`;
    expect(await runScheduledJob("briefs", deps(), { trigger: "schedule" })).toMatchObject({ status: "success", stats: { queued: 1 } });
    expect((await runScheduledJob("briefs", deps(), { trigger: "schedule" })).status).toBe("idle");
    const rows = await t.sql`select dedupe_key from jarvis.notifications`;
    expect(rows.map((r) => r.dedupe_key)).toEqual(["brief:2026-10-01"]);
  });

  const at = (ist: string) => new Date(`2026-10-01T${ist}:00+05:30`);
  const briefs = (o: Partial<SyncDeps> = {}) => runScheduledJob("briefs", deps(o), { trigger: "schedule" });
  const freshWorld = () => seedBriefWorld(t.sql, { lastSuccessAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() });
  const queuedBrief = async () => (await t.sql`select text from jarvis.notifications where dedupe_key = 'brief:2026-10-01'`)[0]?.text as string | undefined;
  const note = (n: string) => say(JSON.stringify({ note: n }));

  it("writes the focus note with the model and puts it last", async () => {
    await freshWorld();
    const r = await briefs({ model: scripted(note("Start with {P1}, then {P2}. You have about {FREE}.")).model });
    expect(r).toMatchObject({ status: "success", stats: { queued: 1, focusNote: "ai", detail: null, lmsStale: false } });
    expect((await queuedBrief())!.split("\n").at(-1)).toMatch(/^🧭 <i>Start with “Finish Spinny presentation”, then “Send recruiter follow-up”\. You have about .+ free between classes\.<\/i>$/);
  });

  it("falls back when the model's note states a date, and still queues the brief", async () => {
    await freshWorld();
    const r = await briefs({ model: scripted(note("Start with {P1} by 5 Oct, then {P2}.")).model });
    expect(r).toMatchObject({ status: "success", stats: { queued: 1, focusNote: "fallback", detail: "invalid:digits" } });
    expect(await queuedBrief()).toContain("🧭 <i>Start with “Finish Spinny presentation”");
  });

  it("queues the brief when the model throws", async () => {
    await freshWorld();
    const throwing: ModelProvider = { name: "boom", generate: async () => Promise.reject(new Error("HTTP 429 quota exceeded")) };
    expect(await briefs({ model: throwing })).toMatchObject({ status: "success", stats: { queued: 1, focusNote: "fallback", detail: "error:HTTP 429 quota exceeded" } });
    expect(await queuedBrief()).toContain("🧭");
  });

  it("calls the model once however often it runs", async () => {
    await freshWorld();
    const m = scripted(note("Start with {P1}, then {P2}."), note("Start with {P2}."));
    const results = [];
    for (const minutes of [0, 15, 30]) results.push(await briefs({ model: m.model, now: () => new Date(NOW.getTime() + minutes * 60_000) }));
    expect(results.map((r) => r.status)).toEqual(["success", "idle", "idle"]);
    expect(m.requests).toHaveLength(1);
  });

  it("after 10:00 sends without fresh MESA data, with a stale-data risk", async () => {
    await t.sql`insert into jarvis.integrations (provider, status, last_success_at) values ('mesa', 'active', ${at("07:30").toISOString()})`;
    expect(await briefs({ now: () => at("09:45") })).toMatchObject({ status: "idle", stats: { waitingForFreshLmsData: true } });
    const r = await briefs({ now: () => at("10:30") });
    expect(r).toMatchObject({ status: "success", stats: { queued: 1, lmsStale: true, focusNote: "fallback", detail: "no_model" } });
    expect(await queuedBrief()).toContain("- LMS data last updated 3 h ago — deadlines may be out of date");
    expect((await db.getBrief(t.sql, "2026-10-01"))!.lines.find((l) => l.kind === "meta")!.refs).toEqual([{ t: "integration", id: "mesa" }]);
  });

  it("is idle before 08:00, and after noon when the morning's brief never went out", async () => {
    await freshWorld();
    const early = await briefs({ now: () => at("07:59") });
    expect(early.status).toBe("idle");
    expect(early.stats).toBeUndefined();
    expect(await briefs({ now: () => at("12:30") })).toMatchObject({ status: "idle", stats: { missedWindow: true } });
    expect(await queuedBrief()).toBeUndefined();
    expect(await db.getBrief(t.sql, "2026-10-01")).toBeNull();
  });
});

describe("drafts job", () => {
  it("asks for one draft for the earliest open assignment", async () => {
    const assignment = (id: string, due: string) => ({
      kind: "assignment" as const, sourceId: id, contentHash: `h-${id}`, data: { submissionStatus: "not_submitted" }, courseId: null, title: id, sortAt: due,
    });
    await db.applyChanges(t.sql, {
      upserts: [assignment("late", "2026-10-09T00:00:00.000Z"), assignment("soon", "2026-10-03T00:00:00.000Z")],
      versions: [], touched: [], removed: [], events: [], notifications: [],
    });
    const asked: string[][] = [];
    const r = await runScheduledJob("drafts", deps({ onNewAssignments: async (ids) => void asked.push(ids) }), { trigger: "schedule" });
    expect(r.status).toBe("success");
    expect(asked).toEqual([["soon"]]);
    expect((await runScheduledJob("drafts", deps(), { trigger: "schedule" })).status).toBe("idle"); // not configured
  });
});

describe("habits job", () => {
  it("sends one check-in per due habit per day, with progress, and stops once logged", async () => {
    // NOW is 09:00 IST
    const goal = await db.createGoal(t.sql, { title: "Fitness", targetValue: 4, period: "week" }, NOW);
    const gym = await db.createHabit(t.sql, { name: "Work out", goalId: goal.id, schedule: { freq: "weekly", times: 4 }, reminderTime: "08:45", startDate: "2026-09-01" });
    await db.createHabit(t.sql, { name: "Evening walk", reminderTime: "19:00", startDate: "2026-09-01" });
    expect(await runScheduledJob("habits", deps(), { trigger: "schedule" })).toMatchObject({ status: "success", stats: { queued: 1, habits: [gym.id] } });
    expect((await runScheduledJob("habits", deps(), { trigger: "schedule" })).status).toBe("idle"); // deduped for today
    const [n] = await t.sql`select dedupe_key, text, priority from jarvis.notifications`;
    expect(n).toMatchObject({ dedupe_key: `habit.reminder:${gym.id}:2026-10-01`, priority: "normal" });
    expect(n!.text).toBe("🔁 <b>Work out</b>\n0 of 4 this week · Fitness");
    await db.logHabit(t.sql, gym.id, {}, NOW);
    await t.sql`truncate jarvis.notifications cascade`;
    expect((await runScheduledJob("habits", deps(), { trigger: "schedule" })).status).toBe("idle");
  });
});

describe("calendar and health jobs", () => {
  it("calendar is idle without a feed URL", async () => {
    expect(await runScheduledJob("calendar", deps(), { trigger: "schedule" })).toMatchObject({ status: "idle", stats: { configured: false } });
  });

  it("health lists stale or failing jobs and prunes old history", async () => {
    await db.finishJob(t.sql, "mesa", { status: "success", trigger: "schedule", startedAt: new Date(Date.now() - 60 * 60_000), durationMs: 1 });
    await t.sql`insert into jarvis.job_runs (job, trigger, status, started_at) values ('mesa', 'schedule', 'success', now() - interval '45 days')`;
    const r = await runScheduledJob("health", deps(), { trigger: "schedule" });
    expect(r).toMatchObject({ status: "success", stats: { unhealthy: ["mesa:stale"], pruned: 1 } });
  });
});

describe("runMesaSync (all-in-one)", () => {
  it("records each step as its own job and still delivers when MESA fails", async () => {
    sentTexts.length = 0;
    await queue("pending");
    const s = await runMesaSync(deps(), { trigger: "manual" });
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/No MESA session/);
    expect(s.sent).toBe(1);
    expect(s.jobs.map((j) => `${j.job}:${j.status}`)).toEqual(["mesa:failed", "briefs:idle", "notify:success", "drafts:idle"]);
    expect(await job("mesa")).toMatchObject({ consecutiveFailures: 1, health: "stale" });
  });
});
