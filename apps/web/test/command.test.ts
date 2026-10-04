import { describe, expect, it } from "vitest";
import { briefSections, parseDue, WorkInputError, type BriefFacts, type BriefSections, type CalendarEntry, type HabitWithStatus, type RiskItem, type Task } from "@jarvis/db";
import { calendarRows, canDefer, chooseNote, dayMode, dayStrip, deferredDue, doneTodayLine, glanceChips, greeting, homeProjects, mesaHeader, otherTasks, parseEffort } from "../lib/command";

// The command center's pure helpers: IST day modes, the glance chips, and the Move-to-tomorrow date logic.

const NOW = new Date("2026-10-01T02:35:00.000Z"); // Thu 1 Oct, 08:05 IST
const ist = (hhmm: string, day = "2026-10-01") => new Date(`${day}T${hhmm}:00+05:30`);

let nextId = 1;
const task = (title: string, o: Partial<Task> = {}): Task => ({
  id: nextId++,
  title,
  notes: null,
  domain: "professional",
  area: null,
  projectId: null,
  projectTitle: null,
  goalId: null,
  priority: 3,
  status: "todo",
  dueAt: null,
  dueIsDateOnly: false,
  effortMin: null,
  isNextAction: false,
  source: "manual",
  sourceRef: null,
  createdAt: "2026-09-29T04:00:00.000Z",
  updatedAt: "2026-09-29T04:00:00.000Z",
  completedAt: null,
  postponedCount: 0,
  ...o,
});
const habit = (name: string, today: HabitWithStatus["status"]["today"]): HabitWithStatus => ({
  id: nextId++,
  goalId: null,
  goalTitle: null,
  name,
  description: null,
  schedule: { freq: "daily" },
  reminderTime: null,
  startDate: "2026-09-01",
  endDate: null,
  active: true,
  status: { dueToday: true, today, periodDone: 0, periodTarget: null, streak: 0, week: [] },
});
const event = (id: string, title: string, startAt: string, o: Partial<CalendarEntry> = {}): CalendarEntry => ({
  ref: { t: "lms", kind: "event", id },
  title,
  course: title,
  startAt,
  endAt: null,
  allDay: false,
  personal: false,
  cancelled: false,
  room: null,
  type: "class",
  ...o,
});

function facts(o: Partial<BriefFacts> = {}): BriefFacts {
  return {
    v: 1,
    day: "2026-10-01",
    at: NOW.toISOString(),
    label: "Thursday, 1 October",
    stale: false,
    tasksToday: [],
    openTasks: [],
    focus: [],
    defer: [],
    freeTime: { freeMin: 0, largestMin: 0, gaps: [] },
    habits: [],
    calendar: [],
    calendarWeek: [],
    lmsDue: [],
    upcoming: [],
    goals: [],
    slipping: [],
    overdue: [],
    projects: [],
    unread: 0,
    doneToday: 0,
    mesa: { status: "active", lastSuccessAt: NOW.toISOString(), sessionExpiresAt: null },
    ...o,
  };
}
const risk = (kind: RiskItem["kind"]): RiskItem => ({ kind, severity: 2, text: kind, refs: [], href: "/" });
const sections = (risks: RiskItem[] = []): BriefSections => ({ priorities: [], personal: { habits: [], tasks: [] }, upcoming: [], goals: [], risks });

describe("dayMode and greeting (IST)", () => {
  it("switches at 12:00 and 18:00 IST, not UTC", () => {
    expect(dayMode(ist("00:00"))).toBe("morning");
    expect(dayMode(ist("11:59"))).toBe("morning");
    expect(dayMode(ist("12:00"))).toBe("day");
    expect(dayMode(ist("17:59"))).toBe("day");
    expect(dayMode(ist("18:00"))).toBe("evening");
    expect(dayMode(ist("23:59"))).toBe("evening");
    // 06:00 UTC is 11:30 IST — still morning.
    expect(dayMode(new Date("2026-10-01T06:00:00Z"))).toBe("morning");
    expect(dayMode(new Date("2026-10-01T06:30:00Z"))).toBe("day");
  });

  it("greets by time of day", () => {
    expect(greeting(NOW)).toBe("Good morning");
    expect(greeting(ist("14:00"))).toBe("Good afternoon");
    expect(greeting(ist("18:30"))).toBe("Good evening");
  });
});

describe("glanceChips", () => {
  it("shows nothing when every count is zero", () => {
    expect(glanceChips(facts(), sections())).toEqual([]);
  });

  it("maps each count to its label, link and tone, in a fixed order", () => {
    const overdue = task("Late", { dueAt: "2026-09-30T04:30:00.000Z" });
    const later = task("Later today", { dueAt: ist("18:00").toISOString() });
    const tomorrow = task("Tomorrow", { dueAt: ist("10:00", "2026-10-02").toISOString() });
    const f = facts({
      openTasks: [overdue, later, tomorrow, task("Waiting", { status: "waiting", dueAt: ist("19:00").toISOString() })],
      overdue: [overdue],
      habits: [habit("Workout", "done"), habit("Read", null)],
      calendar: [
        event("C1", "Strategy", ist("10:00").toISOString()),
        event("C2", "Finance", ist("14:00").toISOString(), { cancelled: true }),
        event("A1", "Dussehra", ist("00:00").toISOString(), { allDay: true }),
        event("G1", "Gym", ist("19:00").toISOString(), { personal: true }),
      ],
      unread: 4,
      freeTime: { freeMin: 210, largestMin: 120, gaps: [] },
    });
    expect(glanceChips(f, sections([risk("overdue"), risk("goal")]))).toEqual([
      { label: "1 overdue", href: "/tasks?view=today", tone: "bad" },
      { label: "1 due today", href: "/tasks?view=today", tone: "muted" },
      { label: "1/2 habits", href: "#habits", tone: "muted" },
      { label: "2 at risk", href: "#risks", tone: "warn" },
      { label: "1 class", href: "#calendar", tone: "muted" },
      { label: "4 unread", href: "/inbox", tone: "muted" },
      { label: "3 h 30 min free", href: "#calendar", tone: "muted" },
    ]);
  });

  it("marks the habits chip good once all are done, and hides zero counts individually", () => {
    const chips = glanceChips(facts({ habits: [habit("Workout", "done")], unread: 2 }), sections());
    expect(chips).toEqual([
      { label: "1/1 habits", href: "#habits", tone: "good" },
      { label: "2 unread", href: "/inbox", tone: "muted" },
    ]);
  });

  it("agrees with briefSections on the risk count", () => {
    const overdue = task("Late", { dueAt: "2026-09-30T04:30:00.000Z" });
    const f = facts({ openTasks: [overdue], overdue: [overdue] });
    const s = briefSections(f);
    expect(glanceChips(f, s).find((c) => c.href === "#risks")?.label).toBe(`${s.risks.length} at risk`);
  });
});

describe("deferredDue (Move to tomorrow)", () => {
  it("moves an undated or date-only task to tomorrow (IST), date-only", () => {
    expect(deferredDue({ source: "manual", dueAt: null, dueIsDateOnly: false }, NOW)).toBe("2026-10-02");
    expect(deferredDue({ source: "chat", dueAt: "2026-09-29T18:29:00.000Z", dueIsDateOnly: true }, NOW)).toBe("2026-10-02");
    expect(parseDue("2026-10-02")).toEqual({ dueAt: "2026-10-02T18:29:00.000Z", dateOnly: true });
  });

  it("keeps an exact time, moved to tomorrow", () => {
    const due = deferredDue({ source: "manual", dueAt: ist("17:30").toISOString(), dueIsDateOnly: false }, NOW);
    expect(due).toBe("2026-10-02T17:30:00+05:30");
    expect(parseDue(due)).toEqual({ dueAt: "2026-10-02T12:00:00.000Z", dateOnly: false });
    // An overdue task from days ago lands on tomorrow too, at its own time.
    expect(deferredDue({ source: "manual", dueAt: ist("09:15", "2026-09-27").toISOString(), dueIsDateOnly: false }, NOW)).toBe("2026-10-02T09:15:00+05:30");
  });

  it("uses the IST day, not the UTC one", () => {
    // 00:30 IST on Fri 2 Oct is still Thu 1 Oct in UTC; tomorrow is Sat 3 Oct.
    expect(deferredDue({ source: "manual", dueAt: null, dueIsDateOnly: false }, ist("00:30", "2026-10-02"))).toBe("2026-10-03");
  });

  it("refuses a task already due after today (it would pull the deadline earlier)", () => {
    const later = { source: "manual" as const, dueAt: ist("09:00", "2026-10-05").toISOString(), dueIsDateOnly: false };
    expect(canDefer(later, NOW)).toBe(false);
    expect(() => deferredDue(later, NOW)).toThrow(WorkInputError);
    // Date-only tomorrow (23:59 IST) is already tomorrow; 23:59 IST today can still move.
    expect(canDefer({ source: "manual", dueAt: "2026-10-02T18:29:00.000Z" }, NOW)).toBe(false);
    expect(canDefer({ source: "manual", dueAt: "2026-10-01T18:29:00.000Z" }, NOW)).toBe(true);
    expect(canDefer({ source: "manual", dueAt: null }, NOW)).toBe(true);
    expect(canDefer({ source: "mesa", dueAt: null }, NOW)).toBe(false);
  });

  it("refuses MESA tasks", () => {
    expect(() => deferredDue({ source: "mesa", dueAt: ist("23:59").toISOString(), dueIsDateOnly: false }, NOW)).toThrow(WorkInputError);
    expect(() => deferredDue({ source: "mesa", dueAt: null, dueIsDateOnly: false }, NOW)).toThrow("MESA deadlines can't be moved");
  });
});

describe("parseEffort", () => {
  it("accepts 1–600 whole minutes; empty means none", () => {
    expect(parseEffort("")).toBeNull();
    expect(parseEffort(null)).toBeNull();
    expect(parseEffort(" 45 ")).toBe(45);
    expect(parseEffort("600")).toBe(600);
    for (const bad of ["0", "601", "1.5", "abc", "-5"]) expect(() => parseEffort(bad)).toThrow(WorkInputError);
  });
});

describe("sections on the page", () => {
  it("shows the stored note unless a task it names is closed, else the live note", () => {
    const open = task("Open");
    const f = facts({ openTasks: [open] });
    const live = () => ({ text: "live note" });
    const brief = { note: "Start with “Open”.", noteRefs: [{ t: "task" as const, id: open.id }], createdAt: "2026-10-01T02:35:00.000Z" };
    expect(chooseNote(brief, f, live)).toEqual({ text: "Start with “Open”.", caption: "8:05 am brief" });
    expect(chooseNote({ ...brief, noteRefs: [{ t: "task", id: 9999 }] }, f, live)).toEqual({ text: "live note", caption: "live" });
    expect(chooseNote(null, f, live).caption).toBe("live");
    expect(chooseNote({ ...brief, note: null }, f, live).caption).toBe("live");
  });

  it("lists today's other tasks without the ones shown as priorities", () => {
    const a = task("A"), b = task("B"), c = task("C");
    const item = (t: Task) => ({ task: t, score: 50, reasons: [], bucket: "today" as const, parts: { due: 0, priority: 0, goal: 0, effort: 0, neglect: 0, momentum: 0 } });
    expect(otherTasks(facts({ tasksToday: [a, b, c] }), { priorities: [item(a)], personal: { habits: [], tasks: [item(c)] } }).map((t) => t.title)).toEqual(["B"]);
  });

  it("orders own projects by deadline (undated last), then priority; MESA assignment projects are left out", () => {
    const p = (id: number, o: Partial<BriefFacts["projects"][number]>) => ({
      id, title: `P${id}`, objective: null, domain: "professional" as const, area: null, kind: "other" as const, status: "active" as const, priority: 2, deadline: null,
      source: "manual" as const, sourceRef: null, createdAt: NOW.toISOString(), completedAt: null, openTasks: 0, doneTasks: 0, next: null, ...o,
    });
    const f = facts({
      projects: [p(1, {}), p(2, { deadline: "2026-10-05T00:00:00.000Z" }), p(3, { priority: 1 }), p(4, { kind: "mesa_assignment", deadline: "2026-10-02T00:00:00.000Z" }), p(5, { status: "on_hold" }), p(6, { deadline: "2026-10-03T00:00:00.000Z" })],
    });
    expect(homeProjects(f).map((x) => x.id)).toEqual([6, 2, 3, 1]);
  });

  it("draws free gaps of 45+ minutes between today's timed entries", () => {
    const f = facts({
      calendar: [event("A1", "Dussehra", ist("00:00").toISOString(), { allDay: true }), event("C1", "Strategy", ist("10:00").toISOString())],
      freeTime: {
        freeMin: 805,
        largestMin: 660,
        gaps: [
          { from: ist("08:05").toISOString(), to: ist("10:00").toISOString(), min: 115 },
          { from: ist("11:00").toISOString(), to: ist("11:30").toISOString(), min: 30 },
          { from: ist("11:30").toISOString(), to: ist("22:00").toISOString(), min: 630 },
        ],
      },
    });
    expect(calendarRows(f).map((r) => (r.kind === "event" ? r.e.title : r.label))).toEqual(["Free · 1 h 55 min", "Strategy", "Free · 10 h 30 min"]);
  });

  it("builds the 6-day strip with class and deadline counts", () => {
    const f = facts({
      calendarWeek: [event("C1", "Strategy", ist("10:00", "2026-10-02").toISOString()), event("C2", "Finance", ist("10:00", "2026-10-02").toISOString(), { cancelled: true }), event("G1", "Interview", ist("14:00", "2026-10-03").toISOString(), { personal: true })],
      upcoming: [{ ref: { t: "task", id: 1 }, kind: "task", title: "X", at: ist("23:59", "2026-10-03").toISOString(), dateOnly: true, when: "Sat 3 Oct", href: "/", mesa: false, context: null }],
    });
    const strip = dayStrip(f);
    expect(strip.map((d) => d.label)).toEqual(["Fri 2", "Sat 3", "Sun 4", "Mon 5", "Tue 6", "Wed 7"]);
    expect(strip.slice(0, 2)).toEqual([
      { day: "2026-10-02", label: "Fri 2", classes: 1, deadlines: 0 },
      { day: "2026-10-03", label: "Sat 3", classes: 0, deadlines: 1 },
    ]);
  });

  it("warns about the MESA sign-in under 5 days out, and says when it has already expired", () => {
    const at = (iso: string | null) => mesaHeader(facts({ mesa: { status: "active", lastSuccessAt: null, sessionExpiresAt: iso } }));
    expect(at(null)).toEqual({ lastCheck: null, connected: true, expiresSoon: null, expired: false });
    expect(at("2026-10-10T00:00:00.000Z").expiresSoon).toBeNull();
    expect(at("2026-10-03T00:00:00.000Z")).toMatchObject({ expiresSoon: "2026-10-03T00:00:00.000Z", expired: false });
    expect(at("2026-09-30T00:00:00.000Z")).toMatchObject({ expiresSoon: "2026-09-30T00:00:00.000Z", expired: true });
  });

  it("summarises the evening", () => {
    expect(doneTodayLine(facts({ doneToday: 1, habits: [habit("Workout", "done"), habit("Read", null)] }))).toBe("Done today: 1 task · 1/2 habits");
    expect(doneTodayLine(facts({ doneToday: 3 }))).toBe("Done today: 3 tasks");
  });
});
