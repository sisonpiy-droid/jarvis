import { describe, expect, it } from "vitest";
import { extractLight, extractSnapshot } from "../src/extract";
import { COURSE_BF, COURSE_ENT, event, fixtureRoutes } from "./fixtures/api";
import { type FakeCall, testClient } from "./helpers";

const NOW = new Date("2026-09-28T06:00:00.000Z");
const routes = () => ({ ...fixtureRoutes(), "/events/my?*": { data: { events: [event(), event({ id: "evt-0", startAt: "2026-09-28T04:30:00.000Z" })] } } });

describe("extractSnapshot", () => {
  it("builds a complete normalized snapshot from the API", async () => {
    const snap = await extractSnapshot(testClient(routes()), { now: NOW });
    expect(snap.student).toMatchObject({ name: "Test Student", program: "PGP Test Cohort", batch: "Batch 2099" });
    expect(snap.student!.terms.map((t) => t.name)).toEqual(["Pre-Term", "Term 1"]);
    expect(snap.meta.counts).toEqual({ courses: 2, materials: 3, recordings: 1, assignments: 3, events: 2, announcements: 1 });
    expect(snap.courses.reduce((n, c) => n + c.topics.length, 0)).toBe(10);
    expect(snap.meta.kind).toBe("full");
  });

  it("deduplicates a course listed under more than one term", async () => {
    const snap = await extractSnapshot(testClient(routes()), { now: NOW });
    expect(snap.courses.map((c) => c.sourceId).sort()).toEqual([COURSE_BF, COURSE_ENT].sort());
  });

  it("is deterministic: two runs over unchanged data give identical records", async () => {
    const a = await extractSnapshot(testClient(routes()), { now: NOW });
    const b = await extractSnapshot(testClient(routes()), { now: NOW });
    const strip = (s: typeof a) => ({ ...s, meta: { ...s.meta, durationMs: 0 } });
    expect(strip(b)).toEqual(strip(a));
  });

  it("records malformed items and missing endpoints as warnings without failing", async () => {
    const snap = await extractSnapshot(testClient(routes()), { now: NOW });
    expect(snap.meta.warnings.some((w) => w.where.startsWith("materials(Business Frameworks/Resources)[2]"))).toBe(true);
    expect(snap.meta.unavailable).toContain("materials(Entrepreneurship/Outlines)");
  });

  it("maps topics to the right content endpoints and skips view-only topics", async () => {
    const calls: FakeCall[] = [];
    await extractSnapshot(testClient(routes(), calls), { now: NOW });
    const paths = calls.map((c) => c.path);
    expect(paths).toContain(`/content/topics/${COURSE_BF}-t-rec/recordings`);
    expect(paths).not.toContain(`/content/topics/${COURSE_BF}-t-rec/materials`);
    expect(paths.some((p) => p.includes("-t-asg") || p.includes("-t-ann"))).toBe(false);
  });

  it("only ever issues authenticated GET requests", async () => {
    const calls: FakeCall[] = [];
    await extractSnapshot(testClient(routes(), calls), { now: NOW });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET" && c.auth === "Bearer test-token")).toBe(true);
  });

  it("sorts assignments by deadline and events by start", async () => {
    const snap = await extractSnapshot(testClient(routes()), { now: NOW });
    expect(snap.assignments.map((a) => a.sourceId)).toEqual(["asg-0", "asg-late", "asg-1"]);
    expect(snap.events.map((e) => e.sourceId)).toEqual(["evt-0", "evt-1"]);
  });

  it("requests the configured calendar window", async () => {
    const calls: FakeCall[] = [];
    await extractSnapshot(testClient(routes(), calls), { now: NOW, eventsPastDays: 1, eventsFutureDays: 2 });
    const ev = calls.find((c) => c.path.startsWith("/events/my"))!;
    const q = new URLSearchParams(ev.path.split("?")[1]);
    expect(q.get("from")).toBe("2026-09-27T06:00:00.000Z");
    expect(q.get("to")).toBe("2026-09-30T06:00:00.000Z");
  });

  it("marks a collection incomplete when one of its items is malformed, but not for per-topic 404s", async () => {
    const snap = await extractSnapshot(testClient(routes()), { now: NOW });
    expect(snap.meta.complete).toMatchObject({ courses: true, materials: false, recordings: true, assignments: true, events: true, announcements: true });
  });

  it("marks a top-level 404 as incomplete so nothing is ever treated as deleted", async () => {
    const r: Record<string, unknown> = routes();
    delete r["/assignments/my"];
    const snap = await extractSnapshot(testClient(r), { now: NOW });
    expect(snap.assignments).toEqual([]);
    expect(snap.meta.complete.assignments).toBe(false);
  });

  it("fails loudly if the student context itself is unreadable", async () => {
    await expect(extractSnapshot(testClient({ ...routes(), "/student/me": { data: {} } }), { now: NOW })).rejects.toThrow();
  });
});

describe("extractLight", () => {
  it("reads only assignments, events and announcements", async () => {
    const calls: FakeCall[] = [];
    const snap = await extractLight(testClient(routes(), calls), { now: NOW, instructorByCourse: new Map([[COURSE_BF, "Prof. From DB"]]) });
    expect(calls.map((c) => c.path.split("?")[0]).sort()).toEqual(["/announcements", "/assignments/my", "/events/my"]);
    expect(snap.meta.kind).toBe("light");
    expect(Object.keys(snap.meta.complete).sort()).toEqual(["announcements", "assignments", "events"]);
    expect(snap.student).toBeNull();
    expect(snap.assignments.find((a) => a.sourceId === "asg-1")?.instructor).toBe("Prof. From DB");
  });
});
