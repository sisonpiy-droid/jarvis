import { describe, expect, it } from "vitest";
import * as f from "../src/focus";
import type { FocusCtx, GoalCtx } from "../src/focus";
import type { Task } from "../src/work";

// The focus score, free time and what can wait — pure, table-driven.

const NOW = new Date("2026-10-01T02:35:00.000Z"); // Thu 1 Oct, 08:05 IST
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const task = (o: Partial<Task> = {}): Task => ({
  id: 1,
  title: "Task",
  notes: null,
  domain: "professional",
  area: null,
  projectId: null,
  projectTitle: null,
  goalId: null,
  priority: 4,
  status: "todo",
  dueAt: null,
  dueIsDateOnly: false,
  effortMin: null,
  isNextAction: false,
  source: "manual",
  sourceRef: null,
  createdAt: daysAgo(1),
  updatedAt: daysAgo(1),
  completedAt: null,
  ...o,
});
const ctx = (o: Partial<FocusCtx> = {}): FocusCtx => ({ now: NOW, today: "2026-10-01", goals: new Map(), freeMin: null, ...o });
const goal = (title: string, risk: GoalCtx["risk"], neglected = false, quietDays = 0): GoalCtx => ({ title, risk, neglected, quietDays });

describe("focusScore", () => {
  it.each([
    ["overdue", "2026-09-30T10:00:00.000Z", "overdue", 40],
    ["today", "2026-10-01T11:30:00.000Z", "today", 34],
    ["tomorrow", "2026-10-02T06:00:00.000Z", "tomorrow", 26],
    ["in 2 days", "2026-10-03T06:00:00.000Z", "soon", 18],
    ["in 3 days", "2026-10-04T06:00:00.000Z", "soon", 18],
    ["in 4 days", "2026-10-05T06:00:00.000Z", "week", 10],
    ["in 7 days", "2026-10-08T06:00:00.000Z", "week", 10],
    ["in 8 days", "2026-10-09T06:00:00.000Z", "later", 4],
    ["no date", null, "none", 0],
  ] as const)("due %s → %s, %i points", (_, dueAt, bucket, points) => {
    const it = f.focusScore(task({ dueAt }), ctx());
    expect(it.bucket).toBe(bucket);
    expect(it.parts.due).toBe(points);
    expect(it.score).toBe(points);
  });

  it("buckets by the IST day: a date-only task due today turns overdue just after IST midnight", () => {
    const t = task({ dueAt: "2026-10-01T18:29:00.000Z", dueIsDateOnly: true }); // 1 Oct, 23:59 IST
    const at = (iso: string) => f.focusScore(t, ctx({ now: new Date(iso), today: "2026-10-01" }));
    expect(at("2026-10-01T17:30:00.000Z")).toMatchObject({ bucket: "today", reasons: ["due today"] });
    expect(at("2026-10-01T18:31:00.000Z")).toMatchObject({ bucket: "overdue", reasons: ["overdue since Thu 1 Oct"] });
  });

  it("priority points, shown as a reason for P1 and P2 only", () => {
    expect([1, 2, 3, 4].map((priority) => f.focusScore(task({ priority }), ctx()).parts.priority)).toEqual([25, 15, 7, 0]);
    expect([1, 2, 3, 4].map((priority) => f.focusScore(task({ priority }), ctx()).reasons)).toEqual([["P1"], ["P2"], [], []]);
  });

  it("a linked goal adds its risk (highest applies)", () => {
    const goals = new Map([
      [1, goal("Reading", "off_track", true, 15)],
      [2, goal("Workout", "at_risk")],
      [3, goal("Reading", "on_track", true, 15)],
      [4, goal("Calm", "on_track")],
    ]);
    const g = (goalId: number) => f.focusScore(task({ goalId }), ctx({ goals }));
    expect([1, 2, 3, 4, 99].map((id) => g(id).parts.goal)).toEqual([15, 10, 6, 0, 0]);
    expect([1, 2, 3, 4].map((id) => g(id).reasons)).toEqual([["goal “Reading” off track"], ["goal “Workout” at risk"], ["goal “Reading” quiet 15 days"], []]);
  });

  it("effort counts only when effort and free time are both known", () => {
    const e = (o: Partial<Task>, freeMin: number | null) => f.focusScore(task(o), ctx({ freeMin }));
    expect(e({ effortMin: 45 }, 150)).toMatchObject({ parts: { effort: 5 }, reasons: ["fits today's free time (45 of 150 min)"] });
    expect(e({ effortMin: 180, dueAt: "2026-10-03T06:00:00.000Z" }, 90)).toMatchObject({ parts: { effort: -10 }, score: 8 });
    expect(e({ effortMin: 180, dueAt: "2026-10-03T06:00:00.000Z" }, 90).reasons).toEqual(["due Sat 3 Oct, 11:30 am", "needs 180 min, 90 free today"]);
    // Due today and too big: no penalty (the brief lists an effort risk instead).
    expect(e({ effortMin: 180, dueAt: "2026-10-01T11:30:00.000Z" }, 90).parts.effort).toBe(0);
    expect(e({ effortMin: 180, dueAt: "2026-09-30T11:30:00.000Z" }, 90).parts.effort).toBe(0);
    expect(e({ effortMin: null }, 100)).toMatchObject({ parts: { effort: 0 }, reasons: [] });
    expect(e({ effortMin: 30 }, null)).toMatchObject({ parts: { effort: 0 }, reasons: [] });
  });

  it("undated tasks nobody has touched rise slowly", () => {
    const n = (days: number, dueAt: string | null = null) => f.focusScore(task({ updatedAt: daysAgo(days), dueAt }), ctx());
    expect([6, 7, 13, 14, 30].map((d) => n(d).parts.neglect)).toEqual([0, 4, 4, 8, 8]);
    expect(n(16).reasons).toEqual(["untouched 16 days"]);
    expect(n(30, "2026-10-09T06:00:00.000Z").parts.neglect).toBe(0); // dated: the due date drives it
  });

  it("momentum: in progress and next action", () => {
    expect(f.focusScore(task({ status: "doing" }), ctx())).toMatchObject({ parts: { momentum: 6 }, reasons: ["in progress"] });
    expect(f.focusScore(task({ isNextAction: true }), ctx())).toMatchObject({ parts: { momentum: 4 }, reasons: ["next action"] });
    expect(f.focusScore(task({ status: "doing", isNextAction: true }), ctx()).parts.momentum).toBe(10);
  });

  it("the worked examples", () => {
    const submit = f.focusScore(task({ priority: 1, dueAt: "2026-10-02T18:29:00.000Z", isNextAction: true, source: "mesa", sourceRef: "mesa:submit:a1" }), ctx());
    expect(submit).toMatchObject({ score: 55, reasons: ["due tomorrow 11:59 pm", "P1", "next action"] });
    const personal = f.focusScore(task({ domain: "personal", priority: 2, dueAt: "2026-10-01T11:30:00.000Z" }), ctx());
    expect(personal).toMatchObject({ score: 49, reasons: ["due today 5:00 pm", "P2"] });
    const overdue = f.focusScore(task({ priority: 4, dueAt: "2026-09-30T18:29:00.000Z", dueIsDateOnly: true }), ctx());
    expect(overdue).toMatchObject({ score: 40, reasons: ["overdue since Wed 30 Sep"] });
    const stale = f.focusScore(task({ priority: 2, isNextAction: true, updatedAt: daysAgo(20) }), ctx());
    expect(stale).toMatchObject({ score: 27, reasons: ["P2", "untouched 20 days", "next action"] });
  });

  it("lists every reason in a fixed order", () => {
    const goals = new Map([[7, goal("Workout", "at_risk")]]);
    const t = task({ priority: 1, status: "doing", goalId: 7, effortMin: 45, dueAt: "2026-10-03T08:30:00.000Z" });
    expect(f.focusScore(t, ctx({ goals, freeMin: 150 })).reasons).toEqual([
      "due Sat 3 Oct, 2:00 pm",
      "P1",
      "goal “Workout” at risk",
      "fits today's free time (45 of 150 min)",
      "in progress",
    ]);
  });
});

describe("rankFocus", () => {
  const tasks = [
    task({ id: 1, priority: 2, dueAt: "2026-10-02T06:00:00.000Z" }), // 41
    task({ id: 2, priority: 2, dueAt: "2026-10-02T04:00:00.000Z" }), // 41, earlier
    task({ id: 3, priority: 1, dueAt: "2026-10-03T06:00:00.000Z" }), // 43
    task({ id: 4, priority: 3, dueAt: "2026-10-03T06:00:00.000Z", isNextAction: true, status: "doing" }), // 35
    task({ id: 5, priority: 1, isNextAction: true, status: "doing" }), // 35, undated
    task({ id: 6, priority: 1, isNextAction: true, status: "doing" }), // 35, undated, higher id
    task({ id: 7, priority: 4, dueAt: "2026-10-03T06:00:00.000Z", status: "doing", effortMin: 10 }), // 18 + 6 (+5 when it fits)
    task({ id: 8, status: "waiting", priority: 1, dueAt: "2026-09-30T06:00:00.000Z" }),
    task({ id: 9, status: "done", priority: 1 }),
    task({ id: 10, status: "cancelled", priority: 1 }),
  ];

  it("orders by score, then due, priority and id — the same for any input order", () => {
    const c = ctx({ freeMin: 60 });
    const ids = f.rankFocus(tasks, c).map((i) => i.task.id);
    expect(ids).toEqual([3, 2, 1, 4, 5, 6, 7]);
    for (let n = 0; n < 20; n++) {
      const shuffled = [...tasks].sort(() => Math.random() - 0.5);
      expect(f.rankFocus(shuffled, c).map((i) => i.task.id)).toEqual(ids);
    }
  });

  it("leaves out waiting, done and cancelled tasks", () => {
    const ids = f.rankFocus(tasks, ctx()).map((i) => i.task.id);
    expect(ids).not.toContain(8);
    expect(ids).not.toContain(9);
    expect(ids).not.toContain(10);
  });
});

describe("freeTime", () => {
  const ev = (start: string, end: string | null, o: Partial<f.BusyEvent> = {}): f.BusyEvent => ({ startAt: start, endAt: end, allDay: false, cancelled: false, ...o });

  it("merges overlaps, ignores cancelled and all-day events, and counts a missing end as 60 minutes", () => {
    const r = f.freeTime(
      [
        ev("2026-10-01T04:30:00.000Z", "2026-10-01T06:00:00.000Z"), // 10:00–11:30 IST
        ev("2026-10-01T05:30:00.000Z", "2026-10-01T06:30:00.000Z"), // 11:00–12:00, overlaps
        ev("2026-10-01T08:30:00.000Z", "2026-10-01T09:30:00.000Z", { cancelled: true }),
        ev("2026-09-30T18:30:00.000Z", "2026-10-01T18:30:00.000Z", { allDay: true }),
        ev("2026-10-01T10:30:00.000Z", null), // 16:00, no end → until 17:00
      ],
      NOW,
    );
    expect(r.gaps).toEqual([
      { from: "2026-10-01T02:35:00.000Z", to: "2026-10-01T04:30:00.000Z", min: 115 },
      { from: "2026-10-01T06:30:00.000Z", to: "2026-10-01T10:30:00.000Z", min: 240 },
      { from: "2026-10-01T11:30:00.000Z", to: "2026-10-01T16:30:00.000Z", min: 300 },
    ]);
    expect(r).toMatchObject({ freeMin: 655, largestMin: 300 });
  });

  it("clips to now and to 08:00–22:00 IST", () => {
    const early = new Date("2026-10-01T00:30:00.000Z"); // 06:00 IST
    expect(f.freeTime([], early)).toMatchObject({ freeMin: 840, largestMin: 840 });
    expect(f.freeTime([ev("2026-10-01T01:30:00.000Z", "2026-10-01T03:30:00.000Z")], early).freeMin).toBe(780); // 07:00–09:00 IST
    expect(f.freeTime([], NOW).freeMin).toBe(835);
    expect(f.freeTime([], new Date("2026-10-01T16:40:00.000Z"))).toEqual({ freeMin: 0, largestMin: 0, gaps: [] }); // 22:10 IST
  });

  it("drops gaps under 15 minutes", () => {
    const r = f.freeTime([ev("2026-10-01T02:45:00.000Z", "2026-10-01T16:20:00.000Z")], NOW); // 08:15–21:50 IST
    expect(r).toEqual({ freeMin: 0, largestMin: 0, gaps: [] });
  });
});

describe("deferCandidates", () => {
  it("never picks P1, started work, MESA submissions or exam prep due soon; lowest score first, at most 5", () => {
    const tasks = [
      task({ id: 1, priority: 1 }),
      task({ id: 2, priority: 3, status: "doing" }),
      task({ id: 3, priority: 3, sourceRef: "mesa:submit:a1", dueAt: "2026-10-06T06:00:00.000Z" }),
      task({ id: 4, priority: 3, sourceRef: "mesa:prep:e1", dueAt: "2026-10-03T01:00:00.000Z" }), // 2 IST days, under 48 h
      task({ id: 5, priority: 3, dueAt: "2026-10-02T06:00:00.000Z" }), // tomorrow
      task({ id: 6, priority: 2 }), // P2, no effort: not a candidate
      task({ id: 7, priority: 3 }),
      task({ id: 8, priority: 4, dueAt: "2026-10-03T06:00:00.000Z" }),
      task({ id: 9, priority: 2, effortMin: 180, dueAt: "2026-10-05T06:00:00.000Z" }),
      task({ id: 10, priority: 4 }),
      task({ id: 11, priority: 4 }),
      task({ id: 12, priority: 4 }),
    ];
    const c = ctx({ freeMin: 90 });
    const out = f.deferCandidates(f.rankFocus(tasks, c), c);
    expect(out.map((i) => [i.task.id, i.score, i.deferReason])).toEqual([
      [10, 0, "no due date · P4"],
      [11, 0, "no due date · P4"],
      [12, 0, "no due date · P4"],
      [7, 7, "no due date · P3"],
      [9, 15, "not due until Mon 5 Oct · won't fit today (180 of 90 min free)"],
    ]);
    expect(f.deferCandidates(f.rankFocus(tasks, c), c, 10).map((i) => i.task.id)).toEqual([10, 11, 12, 7, 9, 8]);
  });
});

describe("labels", () => {
  it.each([
    ["2026-10-01T11:30:00.000Z", false, "today 5:00 pm"],
    ["2026-10-01T18:29:00.000Z", true, "today"],
    ["2026-10-02T03:30:00.000Z", false, "tomorrow 9:00 am"],
    ["2026-10-01T18:30:00.000Z", false, "tomorrow 12:00 am"],
    ["2026-10-02T18:29:00.000Z", true, "tomorrow"],
    ["2026-10-03T18:29:00.000Z", true, "Sat 3 Oct"],
    ["2026-10-03T08:30:00.000Z", false, "Sat 3 Oct, 2:00 pm"],
    ["2026-09-29T10:00:00.000Z", false, "overdue since Tue 29 Sep"],
  ] as const)("whenLabel(%s, %s) = %s", (iso, dateOnly, label) => {
    expect(f.whenLabel(iso, dateOnly, NOW)).toBe(label);
  });

  it("formats minutes and IST times", () => {
    expect([0, 45, 60, 120, 150, 745].map(f.fmtMinutes)).toEqual(["0 min", "45 min", "1 h", "2 h", "2 h 30 min", "12 h 25 min"]);
    expect(f.fmtIstTime("2026-10-01T06:30:00.000Z")).toBe("12:00 pm");
    expect(f.fmtIstTime("2026-09-30T18:35:00.000Z")).toBe("12:05 am");
    expect(f.fmtIstShort("2026-09-30T18:35:00.000Z")).toBe("Thu 1 Oct");
  });
});
