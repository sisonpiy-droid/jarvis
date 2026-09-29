import { describe, expect, it } from "vitest";
import type { ItemKind, StoredItem } from "@jarvis/db";
import { Assignment, Event as EventSchema } from "../../mesa/src/schemas";
import { normalizeAssignment, normalizeEvent } from "../../mesa/src/normalize";
import type { MesaAssignment, MesaEvent, MesaSnapshot } from "@jarvis/mesa";
import { planMessages } from "@jarvis/notify";
import { assignment as rawAssignment, event as rawEvent } from "../../mesa/test/fixtures/api";
import { diffItems } from "../src/diff";
import { deliveryTime, istHour, relative, reminderBucket } from "../src/time";
import { planChangeSet } from "../src/run";

// Synthetic data only (see mesa/test/fixtures). NOW is Mon 28 Sep 2026, 11:30 IST.
const NOW = new Date("2026-09-28T06:00:00.000Z");
const H = 3_600_000;
const inHours = (h: number) => new Date(NOW.getTime() + h * H).toISOString();

const asg = (o: Record<string, unknown> = {}): MesaAssignment => normalizeAssignment(Assignment.parse(rawAssignment(o)), new Map());
const evt = (o: Record<string, unknown> = {}): MesaEvent => normalizeEvent(EventSchema.parse(rawEvent(o)));
const stored = (item: { sourceId: string; contentHash: string }, extra: Partial<StoredItem> = {}): StoredItem => ({
  sourceId: item.sourceId,
  contentHash: item.contentHash,
  data: item as unknown as Record<string, unknown>,
  removedAt: null,
  sortAt: null,
  ...extra,
});
const mapOf = (...xs: StoredItem[]) => new Map(xs.map((x) => [x.sourceId, x]));

function snapshot(parts: Partial<MesaSnapshot> & { complete: MesaSnapshot["meta"]["complete"] }): MesaSnapshot {
  return {
    meta: {
      source: "mesa",
      kind: "light",
      extractedAt: NOW.toISOString(),
      apiBase: "",
      requestCount: 0,
      durationMs: 0,
      counts: {},
      complete: parts.complete,
      eventsWindow: { from: inHours(-24 * 14), to: inHours(24 * 60) },
      warnings: [],
      unavailable: [],
    },
    student: null,
    courses: [],
    materials: [],
    recordings: [],
    assignments: [],
    events: [],
    announcements: [],
    ...parts,
  };
}
const plan = (snap: MesaSnapshot, existing: Partial<Record<ItemKind, Map<string, StoredItem>>>, baselined: ItemKind[] = ["assignment", "event", "announcement", "course", "material", "recording"]) =>
  planChangeSet(snap, new Map(Object.entries(existing) as Array<[ItemKind, Map<string, StoredItem>]>), baselined, NOW, () => "Business Frameworks");
const keys = (r: ReturnType<typeof plan>) => r.changeSet.notifications.map((n) => n.dedupeKey);

describe("diffItems", () => {
  const a = asg();
  it("classifies created / changed / unchanged", () => {
    const b = asg({ id: "asg-2" });
    const moved = asg({ dueAt: inHours(100) });
    expect(diffItems(new Map(), [a], { enabled: true }).created).toHaveLength(1);
    expect(diffItems(mapOf(stored(a)), [a], { enabled: true }).unchanged).toHaveLength(1);
    const d = diffItems(mapOf(stored(a)), [moved, b], { enabled: true });
    expect(d.changed.map((c) => c.after.sourceId)).toEqual(["asg-1"]);
    expect(d.created.map((c) => c.sourceId)).toEqual(["asg-2"]);
  });
  it("only removes on a complete read, and only within scope", () => {
    const gone = stored(asg({ id: "gone" }), { sortAt: inHours(10) });
    expect(diffItems(mapOf(gone), [], { enabled: false }).removed).toHaveLength(0);
    expect(diffItems(mapOf(gone), [], { enabled: true }).removed).toHaveLength(1);
    expect(diffItems(mapOf(gone), [], { enabled: true, inScope: () => false }).removed).toHaveLength(0);
  });
  it("treats a removed item seen again as reappeared, not new", () => {
    expect(diffItems(mapOf(stored(a, { removedAt: NOW.toISOString() })), [a], { enabled: true }).reappeared).toHaveLength(1);
  });
  it("ignores duplicates inside one response (idempotent)", () => {
    expect(diffItems(new Map(), [a, a], { enabled: true }).created).toHaveLength(1);
  });
});

describe("time rules", () => {
  it("computes IST hours", () => {
    expect(istHour(NOW)).toBe(11);
    expect(istHour(new Date("2026-09-28T20:00:00.000Z"))).toBe(1);
  });
  it("holds non-urgent messages during quiet hours until 07:00 IST", () => {
    const night = new Date("2026-09-28T21:00:00.000Z"); // 02:30 IST on the 29th
    expect(deliveryTime("normal", night).toISOString()).toBe("2026-09-29T01:30:00.000Z"); // 07:00 IST
    expect(deliveryTime("urgent", night)).toBe(night);
    expect(deliveryTime("normal", NOW)).toBe(NOW);
  });
  it("picks the tightest reminder bucket", () => {
    expect(reminderBucket(inHours(2), NOW)?.name).toBe("T-3h");
    expect(reminderBucket(inHours(20), NOW)?.name).toBe("T-24h");
    expect(reminderBucket(inHours(60), NOW)?.name).toBe("T-72h");
    expect(reminderBucket(inHours(100), NOW)).toBeNull();
    expect(reminderBucket(inHours(-1), NOW)).toBeNull();
    expect(reminderBucket(null, NOW)).toBeNull();
  });
  it("formats relative times", () => {
    expect(relative(inHours(5), NOW)).toBe("in 5 h");
    expect(relative(inHours(24 * 3), NOW)).toBe("in 3 days");
    expect(relative(inHours(-2), NOW)).toBe("overdue by 2 h");
  });
});

describe("planChangeSet — assignments", () => {
  const complete = { assignments: true };

  it("baseline: records silently, sends one summary, still reminds about work due soon", () => {
    const soon = asg({ id: "soon", dueAt: inHours(20) });
    const later = asg({ id: "later", dueAt: inHours(24 * 30) });
    const r = plan(snapshot({ complete, assignments: [soon, later] }), {}, []);
    expect(r.newlyBaselined).toEqual(["assignment"]);
    expect(r.changeSet.upserts).toHaveLength(2);
    expect(r.changeSet.events).toHaveLength(0);
    expect(keys(r).sort()).toEqual(["mesa.baseline.summary", `reminder:soon:T-24h:${soon.dueAt}`]);
    expect(r.changeSet.notifications.find((n) => n.dedupeKey === "mesa.baseline.summary")!.text).toContain("Framework Application Case");
  });

  it("does not baseline from an incomplete read", () => {
    expect(plan(snapshot({ complete: { assignments: false }, assignments: [asg()] }), {}, []).newlyBaselined).toEqual([]);
  });

  it("announces a new assignment once and suppresses its now-redundant reminder", () => {
    const a = asg({ dueAt: inHours(20) });
    const r = plan(snapshot({ complete, assignments: [a] }), { assignment: new Map() });
    expect(keys(r)).toEqual(["assignment.created:asg-1", `reminder:asg-1:T-24h:${a.dueAt}`]);
    const [created, reminder] = r.changeSet.notifications;
    expect(created!.priority).toBe("high");
    expect(created!.text).toContain("New MESA assignment");
    expect(created!.text).toContain("students.mesaschool.co.in/student/lms/assignments/asg-1");
    expect(reminder!.suppressed).toBe(true);
  });

  it("is idempotent: an unchanged re-read produces no events and no new notifications", () => {
    const a = asg({ dueAt: inHours(24 * 30) });
    const r = plan(snapshot({ complete, assignments: [a] }), { assignment: mapOf(stored(a)) });
    expect(r.changeSet.upserts).toHaveLength(0);
    expect(r.changeSet.events).toHaveLength(0);
    expect(r.changeSet.notifications).toHaveLength(0);
    expect(r.changeSet.touched.find((t) => t.kind === "assignment")!.sourceIds).toEqual(["asg-1"]);
  });

  it("flags a deadline moved earlier as urgent, later as high, keyed by the new time", () => {
    const orig = asg({ dueAt: inHours(24 * 10) });
    const earlier = asg({ dueAt: inHours(24 * 5) });
    const later = asg({ dueAt: inHours(24 * 12) });
    const e = plan(snapshot({ complete, assignments: [earlier] }), { assignment: mapOf(stored(orig)) });
    expect(e.changeSet.notifications[0]).toMatchObject({ dedupeKey: `assignment.deadline_changed:asg-1:${earlier.dueAt}`, priority: "urgent" });
    expect(e.changeSet.notifications[0]!.text).toContain("EARLIER");
    const l = plan(snapshot({ complete, assignments: [later] }), { assignment: mapOf(stored(orig)) });
    expect(l.changeSet.notifications[0]).toMatchObject({ priority: "high" });
    expect(e.changeSet.versions).toHaveLength(1);
  });

  it("reports newly attached files", () => {
    const base = rawAssignment({ dueAt: inHours(24 * 30) });
    const before = asg({ dueAt: base.dueAt });
    const after = asg({ dueAt: base.dueAt, materials: [...base.materials, { ...base.materials[0]!, id: "rubric", title: "Rubric" }] });
    const r = plan(snapshot({ complete, assignments: [after] }), { assignment: mapOf(stored(before)) });
    expect(keys(r)).toEqual(["assignment.material_added:asg-1:rubric"]);
    expect(r.changeSet.notifications[0]!.text).toContain("Rubric");
  });

  it("names what changed when the brief is edited", () => {
    const before = asg({ dueAt: inHours(24 * 30) });
    const after = asg({ dueAt: before.dueAt, description: "<p>Revised brief</p>" });
    const r = plan(snapshot({ complete, assignments: [after] }), { assignment: mapOf(stored(before)) });
    expect(r.changeSet.notifications[0]!.text).toContain("Assignment updated</b>: brief");
  });

  it("records submission changes without notifying, and stops reminding once submitted", () => {
    const before = asg({ dueAt: inHours(20) });
    const after = asg({ dueAt: before.dueAt, mySubmissionStatus: "submitted" });
    const r = plan(snapshot({ complete, assignments: [after] }), { assignment: mapOf(stored(before)) });
    expect(r.changeSet.events.map((e) => e.type)).toEqual(["assignment.submission_changed"]);
    expect(r.changeSet.notifications).toHaveLength(0);
  });

  it("marks an assignment removed only on a complete read", () => {
    const gone = stored(asg({ id: "gone" }));
    expect(plan(snapshot({ complete, assignments: [] }), { assignment: mapOf(gone) }).changeSet.removed[0]!.sourceIds).toEqual(["gone"]);
    expect(plan(snapshot({ complete: { assignments: false }, assignments: [] }), { assignment: mapOf(gone) }).changeSet.removed[0]!.sourceIds).toEqual([]);
  });
});

describe("planChangeSet — classes", () => {
  const complete = { events: true };
  it("announces reschedules within the next 7 days, keyed by the new start", () => {
    const before = evt({ startAt: inHours(24) });
    const after = evt({ startAt: inHours(26) });
    const r = plan(snapshot({ complete, events: [after] }), { event: mapOf(stored(before, { sortAt: before.startAt })) });
    expect(r.changeSet.notifications[0]).toMatchObject({ dedupeKey: `class.rescheduled:evt-1:${after.startAt}`, priority: "high" });
  });
  it("stays quiet about changes to classes far in the future", () => {
    const before = evt({ startAt: inHours(24 * 20) });
    const after = evt({ startAt: inHours(24 * 21) });
    expect(plan(snapshot({ complete, events: [after] }), { event: mapOf(stored(before)) }).changeSet.notifications).toHaveLength(0);
  });
  it("treats a class vanishing from the calendar window as removed", () => {
    const e = evt({ startAt: inHours(30) });
    const r = plan(snapshot({ complete, events: [] }), { event: mapOf(stored(e, { sortAt: e.startAt })) });
    expect(r.changeSet.removed[0]!.sourceIds).toEqual(["evt-1"]);
    expect(keys(r)).toEqual([`class.removed:evt-1:${e.startAt}`]);
  });
  it("never removes classes outside the requested window", () => {
    const old = evt({ startAt: inHours(-24 * 40) });
    expect(plan(snapshot({ complete, events: [] }), { event: mapOf(stored(old, { sortAt: old.startAt })) }).changeSet.removed[0]!.sourceIds).toEqual([]);
  });
});

describe("planMessages (digest batching)", () => {
  it("sends up to 3 individually", () => {
    expect(planMessages([{ id: 1, text: "a" }, { id: 2, text: "b" }])).toEqual([{ ids: [1], text: "a" }, { ids: [2], text: "b" }]);
  });
  it("digests bursts and stays under Telegram's size limit", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: i, text: "x".repeat(300) }));
    const msgs = planMessages(items);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => m.text.length <= 4096)).toBe(true);
    expect(msgs.flatMap((m) => m.ids)).toEqual(items.map((i) => i.id));
    expect(msgs[0]!.text).toContain("40 MESA updates");
  });
});
