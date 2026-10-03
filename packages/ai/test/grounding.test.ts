import { describe, expect, it } from "vitest";
import { checkGrounding, evidenceFrom, extractMentions, groundingCorrection, type Mention } from "../src/grounding";

// Which dates and ids a text claims, and whether the data backs them — pure.

const NOW = new Date("2026-10-01T02:35:00.000Z"); // Thu 1 Oct, 08:05 IST

const days = (text: string) => extractMentions(text, NOW).flatMap((m) => (m.kind === "day" ? [m.day] : []));
const brief = (m: Mention) => (m.kind === "day" ? m.day : m.kind === "weekday" ? `dow:${m.dow}` : `#${m.id}`);

describe("extractMentions", () => {
  it.each([
    ["Fri, 2 Oct, 5:30 pm", ["2026-10-02"]],
    ["due on the 2nd October", ["2026-10-02"]],
    ["Oct 2", ["2026-10-02"]],
    ["by 02/10", ["2026-10-02"]],
    ["2026-10-02", ["2026-10-02"]],
    ["Thursday", ["dow:4"]],
    ["next Fri", ["2026-10-02"]],
    ["this Saturday", ["2026-10-03"]],
    ["next Thursday", ["2026-10-08"]],
    ["last Monday", ["2026-09-28"]],
    ["in 3 days", ["2026-10-04"]],
    ["in two days", ["2026-10-03"]],
    ["#12", ["#12"]],
    ["task 12 and goal 3", ["#12", "#3"]],
    ["project #4, habit 5, memory 7, id 9", ["#4", "#5", "#7", "#9"]],
    ["today, tomorrow and yesterday", ["2026-10-01", "2026-10-02", "2026-09-30"]],
    ["Thursday, 1 October 2026", ["2026-10-01"]],
    ["5 Jan", ["2027-01-05"]], // nearest occurrence: next January, not last
    ["30 Jun", ["2026-06-30"]],
    ["02/10/2025", ["2025-10-02"]],
  ])("%s", (text, want) => {
    expect(extractMentions(text, NOW).map(brief)).toEqual(want);
  });

  it("reads the labels the brief and focus code write", () => {
    expect(days("overdue since Tue 29 Sep")).toEqual(["2026-09-29"]);
    expect(days("due today 5:00 pm")).toEqual(["2026-10-01"]);
    expect(days("tomorrow 11:59 pm")).toEqual(["2026-10-02"]);
    expect(days("Sat 3 Oct, 2:00 pm")).toEqual(["2026-10-03"]);
    expect(days("not due until Mon 5 Oct · P3")).toEqual(["2026-10-05"]);
  });

  it("converts ISO timestamps with a zone to the IST day", () => {
    expect(days("at 2026-10-01T20:00:00Z")).toEqual(["2026-10-02"]);
    expect(days("2026-10-01T20:00:00+05:30")).toEqual(["2026-10-01"]);
    expect(days("2026-10-01 20:00:00+00")).toEqual(["2026-10-02"]); // Postgres text form
    expect(days("2026-10-01T20:00:00")).toEqual(["2026-10-01"]); // no zone: the written date, whatever the machine's zone
  });

  it("doesn't read counts after task/goal/habit as ids, or a stray number as a year", () => {
    for (const text of ["goal 3 times a week", "the habit 5 days in a row", "habit 3 of 4 this week", "task 2/5 done", "goal 4x a week", "habit 5-day streak"]) {
      expect(extractMentions(text, NOW), text).toEqual([]);
    }
    expect(extractMentions("task 12. Then goal 3, and habit 4", NOW).map(brief)).toEqual(["#12", "#3", "#4"]);
    expect(days("Oct 2, 1000 words")).toEqual(["2026-10-02"]);
  });

  it("finds nothing in ordinary words, counts and fractions", () => {
    for (const text of ["I sat down with the deck", "you may want to start early", "out in the sun", "3 tasks left", "3/4 done", "Your #1 priority is the deck", "at 5:30 pm", "Mondays are for the gym", "Oct 2026 plans"]) {
      expect(extractMentions(text, NOW), text).toEqual([]);
    }
  });

  it("doesn't read one date out of two adjacent ones", () => {
    expect(days("Sat 3 Oct 8 of 12 this month")).toEqual(["2026-10-03"]);
  });
});

describe("evidenceFrom", () => {
  it("converts ISO timestamps to IST days, reads formatted strings and day values, and collects ids", () => {
    const ev = evidenceFrom(
      [
        { tasks: [{ id: 7, due_at: "2026-10-01T20:00:00.000Z", project_id: 3, when: "Sat 3 Oct, 2:00 pm" }] },
        { goalId: 11, day: "2026-10-09", note: "see task 40", ids: [41, 42], source_id: "77" },
        [{ at: "2026-10-12 04:00:00+00" }, { at: "2026-10-13T20:00:00+00" }, { local: "2026-10-15T20:00:00" }],
      ],
      ["what about #5?"],
      NOW,
    );
    expect([...ev.days].sort()).toEqual(["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-09", "2026-10-12", "2026-10-14", "2026-10-15"]);
    expect([...ev.ids].sort((a, b) => a - b)).toEqual([3, 5, 7, 11, 40, 41, 42, 77]);
  });

  it("always includes yesterday, today and tomorrow", () => {
    expect([...evidenceFrom([], [], NOW).days]).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});

describe("checkGrounding", () => {
  const ev = evidenceFrom([{ id: 12, due_at: "2026-10-03T08:30:00.000Z" }], [], NOW);

  it("passes days, weekdays and ids the evidence backs", () => {
    expect(checkGrounding("Task 12 is due Sat 3 Oct — that's Saturday. Tomorrow is clear.", ev, NOW)).toEqual({ ok: true, violations: [] });
    expect(checkGrounding("Nothing to do today.", ev, NOW).ok).toBe(true);
    expect(checkGrounding("It took 3 hours at 5:30 pm and 4 tasks.", ev, NOW).ok).toBe(true); // times and counts aren't checked
  });

  it("passes a weekday only when an evidence day in the window falls on it", () => {
    expect(checkGrounding("See you Friday.", ev, NOW).ok).toBe(true); // tomorrow is a Friday
    expect(checkGrounding("See you Sunday.", ev, NOW)).toEqual({ ok: false, violations: ["Sunday"] });
    const far = evidenceFrom([{ at: "2026-11-01T06:00:00.000Z" }], [], NOW); // a Sunday, but a month out
    expect(checkGrounding("On Sunday.", far, NOW).ok).toBe(false);
    const near = evidenceFrom([{ at: "2026-10-04T06:00:00.000Z" }], [], NOW);
    expect(checkGrounding("On Sunday.", near, NOW).ok).toBe(true);
  });

  it("lists every unbacked day and id once", () => {
    const r = checkGrounding("Task 44 is due 9 Oct, and #44 again on 2026-10-09; goal 12 is fine.", ev, NOW);
    expect(r).toEqual({ ok: false, violations: ["#44", "10-09"] });
    expect(groundingCorrection(r.violations)).toBe(
      "Your draft mentions #44, 10-09, which are not in any tool result or this conversation. Use only dates and IDs from tool results — call a tool if you need one — or say you don't know.",
    );
  });
});
