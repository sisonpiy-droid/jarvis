import { describe, expect, it } from "vitest";
import {
  addDays,
  briefSections,
  dayStartIso,
  freeTime,
  istDay,
  rankFocus,
  refKey,
  slipsFrom,
  upcomingFrom,
  type BriefFacts,
  type CalendarEntry,
  type GoalAttention,
  type HabitWithStatus,
  type Task,
} from "@jarvis/db";
import {
  fallbackFocusNote,
  fallbackTemplate,
  FOCUS_NOTE_SYSTEM,
  focusNote,
  noteFacts,
  substituteNote,
  validateFocusNote,
  type NoteToken,
} from "../src/focus-note";
import { extractMentions } from "../src/grounding";
import type { ModelProvider } from "../src/model";
import { say, scripted } from "./scripted";

// The focus note: the model may only point at facts, never state one — so it can't add a date or number the
// data doesn't hold — and anything invalid falls back to a deterministic note. Pure fixtures, scripted models.

const NOW = new Date("2026-10-01T02:35:00.000Z"); // Thu 1 Oct, 08:05 IST

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
  ...o,
});
const habit = (name: string, status: Partial<HabitWithStatus["status"]> = {}, o: Partial<HabitWithStatus> = {}): HabitWithStatus => ({
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
  status: { dueToday: true, today: null, periodDone: 0, periodTarget: null, streak: 0, week: [], ...status },
  ...o,
});
const goal = (title: string, risk: GoalAttention["risk"]["risk"], reason: string, o: { current?: number; target?: number; unit?: string; neglected?: boolean; quietDays?: number } = {}): GoalAttention => ({
  id: nextId++,
  title,
  description: null,
  domain: "personal",
  area: null,
  parentGoalId: null,
  metric: "count",
  targetValue: o.target ?? 10,
  unit: o.unit ?? null,
  period: "week",
  startDate: "2026-09-01",
  targetDate: null,
  status: "active",
  priority: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  progress: { window: { from: "2026-09-28", to: "2026-10-05" }, current: o.current ?? 4, target: o.target ?? 10, ratio: 0.4, met: false, daysLeft: 4 },
  risk: { risk, elapsed: 0.5, expected: 5, remaining: 6, perDay: 1.5, reason },
  neglect: { neglected: o.neglected ?? false, quietDays: o.quietDays ?? 1, threshold: 7 },
  lastEntry: "2026-09-29",
});
const klass = (sourceId: string, title: string, startAt: string, endAt: string, o: Partial<CalendarEntry> = {}): CalendarEntry => ({
  ref: { t: "lms", kind: "event", id: sourceId },
  title,
  course: title,
  startAt,
  endAt,
  allDay: false,
  personal: false,
  cancelled: false,
  room: null,
  type: "class",
  ...o,
});

/** BriefFacts the way loadBriefFacts builds them, from in-memory rows. */
function world(o: { now?: Date; tasks?: Task[]; habits?: HabitWithStatus[]; goals?: GoalAttention[]; calendar?: CalendarEntry[]; calendarWeek?: CalendarEntry[]; stale?: boolean; sessionExpiresAt?: string | null } = {}) {
  const now = o.now ?? NOW;
  const today = istDay(now);
  const calendar = o.calendar ?? [];
  const goals = o.goals ?? [];
  const habits = o.habits ?? [];
  const free = freeTime(calendar, now);
  const ctx = { now, today, goals: new Map(goals.map((g) => [g.id, { title: g.title, risk: g.risk.risk, neglected: g.neglect.neglected, quietDays: g.neglect.quietDays }])), freeMin: free.freeMin };
  const openTasks = o.tasks ?? [];
  const base = { openTasks, projects: [], lmsDue: [], calendarWeek: o.calendarWeek ?? [] };
  const f: BriefFacts = {
    v: 1,
    day: today,
    at: now.toISOString(),
    label: "Thursday, 1 October",
    stale: o.stale ?? false,
    tasksToday: [],
    ...base,
    focus: rankFocus(openTasks, ctx).slice(0, 40),
    defer: [],
    freeTime: free,
    habits,
    calendar,
    upcoming: upcomingFrom(base, now, dayStartIso(addDays(today, 1)), dayStartIso(addDays(today, 8))),
    goals,
    slipping: slipsFrom(habits, today),
    overdue: openTasks.filter((t) => t.dueAt != null && Date.parse(t.dueAt) < now.getTime()),
    unread: 0,
    doneToday: 0,
    mesa: { status: "active", lastSuccessAt: "2026-10-01T02:30:00.000Z", sessionExpiresAt: o.sessionExpiresAt ?? null },
  };
  return { f, s: briefSections(f), tokens: noteFacts(f, briefSections(f)) };
}

const full = () =>
  world({
    tasks: [
      task("Finish Spinny presentation", { priority: 1, dueAt: "2026-10-01T12:30:00.000Z" }),
      task("Send recruiter follow-up", { priority: 2, dueAt: "2026-09-30T04:30:00.000Z" }),
      task("Call home", { domain: "personal", priority: 2, dueAt: "2026-10-01T18:29:00.000Z", dueIsDateOnly: true }),
      task("Pick a name", { dueAt: "2026-10-04T18:29:00.000Z", dueIsDateOnly: true }),
    ],
    calendar: [klass("C1", "Strategy", "2026-10-01T04:30:00.000Z", "2026-10-01T06:00:00.000Z")],
    calendarWeek: [klass("G1", "Interview", "2026-10-03T08:30:00.000Z", "2026-10-03T09:30:00.000Z", { ref: { t: "lms", kind: "gcal_event", id: "G1" }, personal: true, course: null, type: "personal" })],
    goals: [goal("Reading", "at_risk", "4 of 10 with 4 days left", { unit: "chapters" })],
    habits: [habit("Workout", { periodDone: 2, periodTarget: 4 }, { schedule: { freq: "weekly", times: 4 } })],
  });

const note = (text: string) => JSON.stringify({ note: text });

describe("noteFacts", () => {
  it("numbers the facts and keeps the rows behind each", () => {
    const { tokens } = full();
    expect(Object.keys(tokens)).toEqual(["P1", "P2", "P3", "Q1", "H1", "U1", "G1", "R1", "R2", "R3", "R4", "FREE", "FIRST"]);
    expect(tokens.P1).toMatchObject({ value: "Finish Spinny presentation", fields: { due: "today 6:00 pm", why: "due today 6:00 pm, P1" }, refs: [{ t: "task" }] });
    expect(tokens.P2!.fields.due).toBe("overdue since Wed 30 Sep");
    expect(tokens.H1!.fields).toEqual({ detail: "2 of 4 this week", status: "due today" });
    expect(tokens.P3!.fields.due).toBe("Sun 4 Oct");
    expect(tokens.U1).toMatchObject({ value: "Interview", fields: { when: "Sat 3 Oct, 2:00 pm" }, refs: [{ t: "lms", kind: "gcal_event", id: "G1" }] });
    expect(tokens.G1!.fields).toEqual({ progress: "4 of 10 chapters this week", risk: "at risk", reason: "4 of 10 with 4 days left" });
    expect(tokens.R1).toMatchObject({ value: "Send recruiter follow-up", fields: { text: "Overdue: Send recruiter follow-up (overdue since Wed 30 Sep)" } });
    expect(tokens.FREE).toEqual({ value: "12 h 25 min free between classes", fields: {}, refs: [{ t: "lms", kind: "event", id: "C1" }], plain: true });
    expect(tokens.FIRST).toMatchObject({ value: "10:00 am Strategy", plain: true });
  });

  it("says MESA (unquoted) for a sign-in risk", () => {
    const { tokens } = world({ sessionExpiresAt: "2026-10-03T04:30:00.000Z" });
    expect(tokens.R1).toMatchObject({ value: "MESA", plain: true, refs: [{ t: "integration", id: "mesa" }] });
  });
});

describe("validateFocusNote", () => {
  const { tokens } = full();
  const reject = (raw: string) => {
    const v = validateFocusNote(raw, tokens);
    return v.ok ? "ok" : v.rule;
  };

  it.each([
    ["non-JSON", "Start with {P1}, then {P2}.", "json"],
    ["JSON without a note", JSON.stringify({ text: "Start with {P1}, then {P2}." }), "json"],
    ["under 20 characters", note("Do {P1}."), "length"],
    ["over 320 characters", note(`Start with {P1}${", and keep going".repeat(20)}.`), "length"],
    ["4 sentences", note("Start with {P1}. Then {P2}. Then {Q1}. Then rest."), "sentences"],
    ["an unknown key", note("Start with {X9}, then {P2}."), "placeholders"],
    ["an unknown field", note("Start with {P1}, it is {P1.colour}."), "placeholders"],
    ["no placeholder", note("Start with the hardest task first."), "placeholders"],
    ["a digit", note("Start with {P1} before 5 pm."), "digits"],
    ["a weekday", note("Start with {P1}, it is due Friday."), "date_word"],
    ["a month", note("Start with {P1}, it is due in Oct."), "date_word"],
    ["tomorrow", note("Start with {P1}, then {P2} tomorrow."), "date_word"],
    ["next week", note("Start with {P1}; {U1} can wait until next week."), "date_word"],
    ["a number word", note("Start with {P1} and spend three hours on it."), "number_word"],
    ["markdown", note("**Start** with {P1}, then {P2}."), "markup"],
    ["a URL", note("Start with {P1}, see https://mesa.example for {P2}."), "markup"],
    ["an emoji", note("Start with {P1}, then {P2} 🚀."), "markup"],
    ["a stray brace", note("Start with {P1}, then } the rest."), "markup"],
    ["a name mid-sentence", note("Ask Prof Menon about {P1} before class."), "name"],
    ["a status claim", note("You have already submitted {U1}, so start {P1}."), "status_claim"],
  ])("rejects %s", (_, raw, rule) => {
    expect(reject(raw)).toBe(rule);
  });

  it.each([
    "Start with {P1} — it is due {P1.due}. Then clear {P2} before {FIRST}.",
    "Keep an eye on {R1}: {R1.text}. You have {FREE}, so give some of it to {G1}.",
    "Make room for {H1} ({H1.detail}) and {Q1}.",
    "Use {FREE} for {U1}, which is due {U1.when}.",
    "Today, focus on {P1} first, then {P2}. I would leave {U1} for later; MESA work comes first.",
    "```json\n{\"note\": \"Start with {P1} now, then {P2}.\"}\n```",
  ])("accepts %s", (text) => {
    const v = validateFocusNote(text.startsWith("```") ? text : note(text), tokens);
    expect(v).toMatchObject({ ok: true });
  });
});

describe("substituteNote", () => {
  it("quotes titles, fills fields and records the refs of every token used", () => {
    const { tokens } = full();
    const r = substituteNote("Start with {P1} — due {P1.due}. You have about {FREE}.", tokens);
    expect(r.text).toBe("Start with “Finish Spinny presentation” — due today 6:00 pm. You have about 12 h 25 min free between classes.");
    expect(r.refs.map(refKey)).toEqual([refKey(tokens.P1!.refs[0]!), "lms:event:C1"]);
  });

  it("cuts long titles to 60 characters", () => {
    const tokens: Record<string, NoteToken> = { P1: { value: "x".repeat(100), fields: {}, refs: [{ t: "task", id: 1 }] } };
    const text = substituteNote("{P1}", tokens).text;
    expect(text).toBe(`“${"x".repeat(59)}…”`);
  });
});

describe("fallbackFocusNote", () => {
  it("starts with the top priority, then the top risk, then free time", () => {
    const { f, s } = full();
    const r = fallbackFocusNote(f, s);
    expect(r.text).toBe(
      "Start with “Finish Spinny presentation” — due today 6:00 pm. Keep an eye on “Send recruiter follow-up”: it is overdue. You have about 12 h 25 min free between classes.",
    );
    expect(r.refs.map((x) => x.t)).toEqual(["task", "task", "lms"]);
  });

  it("names the next priority when the top risk is about the top priority", () => {
    const { f, s } = world({
      tasks: [task("Send recruiter follow-up", { priority: 1, dueAt: "2026-09-30T04:30:00.000Z" }), task("Draft the memo", { priority: 2, dueAt: "2026-10-02T12:30:00.000Z" })],
      calendar: [klass("C1", "Offsite", "2026-10-01T02:00:00.000Z", "2026-10-01T17:00:00.000Z")],
    });
    expect(fallbackFocusNote(f, s).text).toBe("Start with “Send recruiter follow-up” — it's overdue. Then “Draft the memo”.");
  });

  it("is a fixed sentence on an empty, fully booked day", () => {
    const { f, s } = world({ now: new Date("2026-10-01T17:00:00.000Z") }); // 22:30 IST
    expect(fallbackFocusNote(f, s)).toEqual({ text: "Nothing urgent today — a good day to get ahead on your upcoming work.", refs: [] });
  });

  // Eight shapes of day; the template always passes every rule except possibly the date/number ones (it may
  // carry computed numbers — here they all sit in placeholders, so it passes outright).
  const LONG = `Prof Menon's <b>#1</b> deck & 5 Oct review ${"very long title ".repeat(20)}`;
  const variants: Record<string, () => ReturnType<typeof world>> = {
    "an empty day": () => world(),
    "only personal tasks": () => world({ tasks: [task("Call home", { domain: "personal", priority: 1, dueAt: "2026-10-01T12:30:00.000Z" }), task("Groceries", { domain: "personal", priority: 2 })] }),
    "long, odd titles": () => world({ tasks: [task(LONG, { priority: 1, dueAt: "2026-10-02T12:30:00.000Z" }), task(LONG, { priority: 2, dueAt: "2026-09-29T12:30:00.000Z" })] }),
    "risks only": () => world({ goals: [goal("Reading", "off_track", "6 still to do but only 2 days left")], sessionExpiresAt: "2026-10-02T04:30:00.000Z", stale: true }),
    "a full day": full,
    "habits only": () => world({ habits: [habit("Read 30 minutes", { streak: 4 })] }),
    "a packed evening": () => world({ now: new Date("2026-10-01T16:00:00.000Z"), tasks: [task("Prep slides", { priority: 1, dueAt: "2026-10-02T04:30:00.000Z" })] }),
    "stale data and an undated priority": () => world({ tasks: [task("Plan the offsite", { priority: 1 })], stale: true }),
  };

  it.each(Object.keys(variants))("passes the validator's shape rules: %s", (name) => {
    const { f, s, tokens } = variants[name]!();
    const template = fallbackTemplate(f, s, tokens);
    const v = validateFocusNote(note(template), tokens);
    if (!v.ok) expect(["digits", "date_word", "number_word"]).toContain(v.rule);
    expect(v.ok).toBe(true);
    const r = fallbackFocusNote(f, s);
    expect(r.text.length).toBeGreaterThan(20);
    expect(r.text).not.toMatch(/[{}]/);
    expect(fallbackFocusNote(f, s)).toEqual(r); // deterministic
  });
});

describe("focusNote", () => {
  const VALID = "Start with {P1} — it is due {P1.due}. Then clear {P2} before {FIRST}.";

  it("uses a valid AI note, sent once as JSON facts with no tools", async () => {
    const { f, s, tokens } = full();
    const { model, requests } = scripted(say(note(VALID)));
    const r = await focusNote(model, f, s);
    expect(r).toEqual({
      text: "Start with “Finish Spinny presentation” — it is due today 6:00 pm. Then clear “Send recruiter follow-up” before 10:00 am Strategy.",
      refs: [...tokens.P1!.refs, ...tokens.P2!.refs, ...tokens.FIRST!.refs],
      source: "ai",
      detail: null,
    });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req).toMatchObject({ system: FOCUS_NOTE_SYSTEM, tools: [], toolChoice: "none", json: true, temperature: 0.2 });
    const sent = JSON.parse((req.messages[0]!.parts[0] as { text: string }).text) as { FACTS: Record<string, unknown> };
    expect(sent.FACTS.P1).toEqual({ title: "Finish Spinny presentation", due: "today 6:00 pm", why: "due today 6:00 pm, P1" });
    expect(sent.FACTS.R1).toMatchObject({ about: "Send recruiter follow-up" });
    expect(sent.FACTS.FREE).toBe("12 h 25 min free between classes");
    expect(JSON.stringify(sent)).not.toMatch(/"(refs|id)"/);
  });

  it("falls back on garbage, a date, a throw, a timeout or no model — and never throws", async () => {
    const { f, s } = full();
    const fb = fallbackFocusNote(f, s);
    const throwing: ModelProvider = { name: "boom", generate: async () => Promise.reject(new Error("HTTP 429 quota exceeded")) };
    const hanging: ModelProvider = { name: "slow", generate: () => new Promise(() => {}) };
    expect(await focusNote(scripted(say("Sure! Here's your note")).model, f, s)).toEqual({ ...fb, source: "fallback", detail: "invalid:json" });
    expect(await focusNote(scripted(say(note("Start with {P1} by 5 Oct, then {P2}."))).model, f, s)).toMatchObject({ source: "fallback", detail: "invalid:digits" });
    expect(await focusNote(throwing, f, s)).toEqual({ ...fb, source: "fallback", detail: "error:HTTP 429 quota exceeded" });
    expect(await focusNote(hanging, f, s, { timeoutMs: 20 })).toMatchObject({ source: "fallback", detail: "error:timed out after 20 ms" });
    expect(await focusNote(null, f, s)).toEqual({ ...fb, source: "fallback", detail: "no_model" });
  });

  it("doesn't call the model when there is nothing to refer to", async () => {
    const { f, s } = world({ now: new Date("2026-10-01T17:00:00.000Z") });
    const { model, requests } = scripted();
    expect(await focusNote(model, f, s)).toMatchObject({ source: "fallback", detail: "no_facts" });
    expect(requests).toHaveLength(0);
  });
});

describe("the AI note cannot add dates", () => {
  const { tokens } = full();

  it.each(["due Friday", "on 3 Oct", "in 2 days", "by 5pm", "by the 3rd", "on Monday", "in a fortnight", "the day after", "this weekend", "by the second of October", "in two days", "by the third", "for thirty minutes", "by noon", "by ５ pm", "at half past", "by ½ past"])(
    "rejects a note that says %s",
    (claim) => {
      expect(validateFocusNote(note(`Finish {P1} ${claim}, then {P2}.`), tokens).ok).toBe(false);
    },
  );

  it("rejects a date after a placeholder", () => {
    expect(validateFocusNote(note("{P1} on Monday, then {P2}."), tokens).ok).toBe(false);
  });

  it("every day an accepted note mentions is a day in the facts", () => {
    const corpus = [
      "Start with {P1} — it is due {P1.due}. Then clear {P2} before {FIRST}.",
      "Keep an eye on {R1}: {R1.text}. You have {FREE}, so give some of it to {G1}.",
      "Use {FREE} for {U1}, which is due {U1.when}. {G1.progress} so far on {G1}.",
      "{P2.due} is when {P2} was due; {U1.when} {G1.progress} is next.",
      "Today, focus on {P1} now and {Q1} later.",
    ];
    const factDays = new Set([istDay(NOW)]);
    for (const t of Object.values(tokens)) for (const v of [t.value, ...Object.values(t.fields)]) for (const m of extractMentions(v, NOW)) if (m.kind === "day") factDays.add(m.day);
    const said = new Set<string>();
    for (const template of corpus) {
      const v = validateFocusNote(note(template), tokens);
      expect(v, template).toMatchObject({ ok: true });
      const text = substituteNote(template, tokens).text;
      for (const m of extractMentions(text, NOW)) {
        if (m.kind !== "day") continue;
        said.add(m.day);
        expect(factDays, `${m.day} in "${text}"`).toContain(m.day);
      }
    }
    // The corpus does carry dates (all from the facts): today, the overdue day and the interview.
    expect([...said].sort()).toEqual(["2026-09-30", "2026-10-01", "2026-10-03"]);
  });
});
