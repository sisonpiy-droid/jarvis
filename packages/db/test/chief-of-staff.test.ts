import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTask,
  decideAlertLearning,
  getLearnedRouting,
  getTask,
  keepAlertCategory,
  learnAlertHabits,
  loadSituation,
  moveOpenToTomorrow,
  patternLines,
  partOfDay,
  updateTask,
  workPatterns,
  type WorkPatterns,
} from "../src/index";
import { createTestDb, type TestDb } from "./harness";

// The chief of staff's memory of how the owner works, its picture of the week, and alerts that learn.

const NOW = new Date("2026-10-03T10:30:00.000Z"); // Sat 3 Oct, 16:00 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.tasks, jarvis.projects, jarvis.lms_items, jarvis.submissions, jarvis.notifications, jarvis.settings restart identity cascade`;
});

const item = (kind: string, id: string, title: string, data: Record<string, unknown>, sortAt: string | null) =>
  t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, course_id, title, sort_at)
        values (${kind}, ${id}, ${id}, ${t.sql.json({ sourceId: id, title, ...data } as never)}, null, ${title}, ${sortAt})`;

describe("postponed tasks", () => {
  it("counts the owner moving a due date later — not earlier, not MESA's own changes", async () => {
    const a = await createTask(t.sql, { title: "Write the cover letter", due: "2026-10-03" });
    await updateTask(t.sql, a.id, { due: "2026-10-04" });
    await updateTask(t.sql, a.id, { due: "2026-10-06" });
    await updateTask(t.sql, a.id, { due: "2026-10-05" }); // earlier: not a postponement
    expect((await getTask(t.sql, a.id))!.postponedCount).toBe(2);
    const m = await createTask(t.sql, { title: "Submit DDDM workbook", due: "2026-10-03", source: "mesa" });
    await updateTask(t.sql, m.id, { due: "2026-10-08" });
    expect((await getTask(t.sql, m.id))!.postponedCount).toBe(0);
  });

  it("moves today's unfinished own tasks to tomorrow, keeping the time", async () => {
    const timed = await createTask(t.sql, { title: "Call the bank", due: "2026-10-03T18:00:00+05:30" });
    const dated = await createTask(t.sql, { title: "Read chapter 4", due: "2026-10-03" });
    const mesa = await createTask(t.sql, { title: "Submit DDDM workbook", due: "2026-10-03", source: "mesa" });
    const later = await createTask(t.sql, { title: "Gym", due: "2026-10-05" });
    expect(await moveOpenToTomorrow(t.sql, NOW)).toBe(2);
    expect((await getTask(t.sql, timed.id))!.dueAt).toBe("2026-10-04T12:30:00.000Z");
    expect((await getTask(t.sql, dated.id))!.dueAt).toBe("2026-10-04T18:29:00.000Z");
    expect((await getTask(t.sql, mesa.id))!.dueAt).toBe("2026-10-03T18:29:00.000Z");
    expect((await getTask(t.sql, later.id))!.dueAt).toBe("2026-10-05T18:29:00.000Z");
    expect((await getTask(t.sql, timed.id))!.postponedCount).toBe(1);
  });
});

describe("work patterns", () => {
  it("says nothing without enough history", async () => {
    const p = await workPatterns(t.sql, NOW);
    expect(p.lines).toEqual([]);
  });

  it("learns lead time, late rate, the tightest course and when work gets finished", async () => {
    // 4 DDDM assignments submitted 1 h before, 4 Finance ones 2 days before; one Finance one late.
    const due = (d: number) => new Date(Date.UTC(2026, 8, d, 18, 29)).toISOString();
    for (let i = 0; i < 4; i++) {
      await item("assignment", `d${i}`, `DDDM ${i}`, { courseTitle: "Data Driven Decision Making with Prof. Vinay", submissionStatus: "submitted" }, due(10 + i));
      await t.sql`insert into jarvis.submissions (assignment_id, status, submitted_at) values (${`d${i}`}, 'submitted', ${new Date(Date.parse(due(10 + i)) - 3_600_000).toISOString()})`;
      await item("assignment", `f${i}`, `FOF ${i}`, { courseTitle: "Fundamentals of Finance", submissionStatus: i === 0 ? "submitted_late" : "submitted" }, due(20 + i));
      await t.sql`insert into jarvis.submissions (assignment_id, status, submitted_at) values (${`f${i}`}, 'submitted', ${new Date(Date.parse(due(20 + i)) - 48 * 3_600_000).toISOString()})`;
    }
    const p = await workPatterns(t.sql, NOW);
    expect(p.submissions.known).toBe(8);
    expect(p.submissions.lastMinute).toBe(4);
    expect(p.submissions.tightest?.course).toBe("Data Driven Decision Making");
    expect(p.lines).toContain("Late submissions: 1 of 8 (Fundamentals of Finance).");
    expect(p.lines.some((l) => l.startsWith("Submits MESA work a median"))).toBe(true);
    expect(p.lines).toContain("Cuts it closest in Data Driven Decision Making: a median 1 h before the deadline.");
    // 23:29 IST submissions → "at night"
    expect(p.peak?.label).toBe("at night (9 pm–2 am)");
  });

  it("names parts of the day in IST and lists repeatedly postponed tasks", () => {
    expect([partOfDay(7), partOfDay(13), partOfDay(18), partOfDay(23), partOfDay(1), partOfDay(4)]).toEqual([
      "in the morning (6 am–12 pm)",
      "in the afternoon (12–5 pm)",
      "in the evening (5–9 pm)",
      "at night (9 pm–2 am)",
      "at night (9 pm–2 am)",
      "in the small hours (2–6 am)",
    ]);
    const p: WorkPatterns = {
      submissions: { known: 0, medianLeadHours: null, lastMinute: 0, submitted: 0, late: 0, lateCourses: [], tightest: null },
      peak: null,
      ownTasks: { withDue: 0, onTime: 0 },
      postponed: [{ id: 7, title: "Update CV", times: 3 }],
      lines: [],
    };
    expect(patternLines(p)).toEqual(['Keeps postponing "Update CV" (moved 3 times) [task #7].']);
  });
});

describe("situation", () => {
  it("lays out today, priorities, the week day by day and crunch days", async () => {
    await createTask(t.sql, { title: "Finish the Spinny deck", due: "2026-10-03T21:00:00+05:30", priority: 1, effortMin: 120 });
    await item("assignment", "a1", "DDDM workbook", { courseTitle: "Data Driven Decision Making", submissionStatus: "not_submitted", dueAt: "2026-10-05T18:29:00Z" }, "2026-10-05T18:29:00Z");
    await item("assignment", "a2", "FOF case memo", { courseTitle: "Fundamentals of Finance", submissionStatus: "not_submitted", dueAt: "2026-10-05T12:00:00Z" }, "2026-10-05T12:00:00Z");
    await item("event", "e1", "Entrepreneurship 101 with Abhishek", { eventType: "session", status: "scheduled", startAt: "2026-10-05T04:00:00Z", endAt: "2026-10-05T05:30:00Z", courseName: "Entrepreneurship 101 with Abhishek" }, "2026-10-05T04:00:00Z");
    const s = await loadSituation(t.sql, NOW);
    expect(s.text).toContain("LIVE SITUATION");
    expect(s.text).toMatch(/1\. Finish the Spinny deck \[task #\d+\] — due today 9:00 pm/);
    expect(s.text).toContain("- Mon 5 Oct: 1 class (9:30 am Entrepreneurship 101)");
    expect(s.text).toContain("Crunch days: Mon 5 Oct");
    expect(s.text).toContain("How the owner works: not enough history yet to say.");
    expect(s.week).toHaveLength(7);
  });
});

describe("alerts that learn", () => {
  const stats = (category: string, pushed: number, opened: number) => ({ category, pushed, opened });

  it("quietens a kind never opened, never protected ones, and retries after a month", () => {
    const empty = { quiet: {}, keep: [] };
    const a = decideAlertLearning([stats("habit", 8, 0), stats("goal", 8, 1), stats("deadline", 9, 0), stats("task", 3, 0)], empty, NOW);
    expect(a.changes).toEqual([{ category: "habit", action: "quiet", ignored: 8 }]);
    expect(Object.keys(a.next.quiet)).toEqual(["habit"]);
    expect(decideAlertLearning([stats("habit", 8, 0)], { quiet: {}, keep: ["habit"] }, NOW).changes).toEqual([]);
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    const b = decideAlertLearning([], a.next, later);
    expect(b.changes).toEqual([{ category: "habit", action: "retry", ignored: 8 }]);
    expect(b.next.quiet).toEqual({});
  });

  it("measures opened pushes from deliveries, tells the owner, and can be turned back on", async () => {
    for (let i = 0; i < 7; i++) {
      const [n] = await t.sql`
        insert into jarvis.notifications (dedupe_key, priority, text, scheduled_for, status, category, sent_at)
        values (${`goal.risk:${i}`}, 'normal', 'x', now(), 'sent', 'goal', now()) returning id`;
      await t.sql`insert into jarvis.notification_deliveries (notification_id, channel, status, sent_at) values (${n!.id}, 'push', 'sent', ${NOW.toISOString()})`;
    }
    const changes = await learnAlertHabits(t.sql, NOW);
    expect(changes.map((c) => c.category)).toEqual(["goal"]);
    const [note] = await t.sql`select dedupe_key, priority, text from jarvis.notifications where dedupe_key like 'learned.%'`;
    expect(note!.dedupe_key).toBe("learned.quiet:goal:2026-10-03");
    expect(note!.priority).toBe("low");
    expect(note!.text).toContain("Goal nudges now go to your inbox only");
    expect(Object.keys((await getLearnedRouting(t.sql)).quiet)).toEqual(["goal"]);
    await keepAlertCategory(t.sql, "goal");
    expect(await getLearnedRouting(t.sql)).toEqual({ quiet: {}, keep: ["goal"] });
    expect(await learnAlertHabits(t.sql, NOW)).toEqual([]);
  });
});
