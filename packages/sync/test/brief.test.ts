import { describe, expect, it } from "vitest";
import { istDay, renderBrief, type BriefData } from "../src/brief";

const NOW = new Date("2026-09-29T02:40:00.000Z"); // 08:10 IST, Tue 29 Sep

const data = (o: Partial<BriefData> = {}): BriefData => ({
  classes: [
    { title: "Session 7", course: "Business Frameworks", startAt: "2026-09-29T04:00:00.000Z", room: "LT-1", status: "scheduled" },
    { title: "Guest talk", course: null, startAt: "2026-09-29T09:00:00.000Z", room: null, status: "cancelled" },
  ],
  due: [{ title: "Framework Case", course: "Business Frameworks with Prof. Example", dueAt: "2026-09-29T12:30:00.000Z", dueIst: "Tue, 29 Sept 2026, 6:00 pm" }],
  newSince: { announcements: 2, materials: 1, recordings: 0, assignments: 0 },
  sessionExpiresAt: null,
  ...o,
});

describe("istDay", () => {
  it("uses the IST calendar day, not UTC", () => {
    const late = istDay(new Date("2026-09-29T20:00:00.000Z")); // 01:30 IST on the 30th
    expect(late.key).toBe("2026-09-30");
    expect(late.start).toBe("2026-09-29T18:30:00.000Z");
    expect(istDay(NOW).key).toBe("2026-09-29");
  });
});

describe("renderBrief", () => {
  it("lists today's classes, cancellations, pending deadlines and what's new", () => {
    const t = renderBrief(data(), NOW);
    expect(t).toContain("Good morning — Tuesday, 29 September");
    expect(t).toContain("Today's schedule (1)");
    expect(t).toMatch(/9:30\s?am — Business Frameworks: Session 7 <i>\(LT-1\)<\/i>/i);
    expect(t).toContain("❌ Cancelled: Guest talk");
    expect(t).toContain("(in 10 h) — Framework Case <i>(Business Frameworks)</i>");
    expect(t).toContain("Since yesterday: 2 announcements, 1 material");
  });
  it("says so when the day is clear", () => {
    const t = renderBrief(data({ classes: [], due: [], newSince: { announcements: 0, materials: 0, recordings: 0, assignments: 0 } }), NOW);
    expect(t).toContain("Nothing scheduled today.");
    expect(t).toContain("Nothing unsubmitted is due in the next 3 days");
    expect(t).not.toContain("Since yesterday");
  });
  it("lists all-day personal entries at the top", () => {
    expect(renderBrief(data({ allDay: ["Mom's birthday"] }), NOW)).toContain("📌 Today: Mom's birthday");
  });
  it("warns when the MESA sign-in is close to expiring", () => {
    expect(renderBrief(data({ sessionExpiresAt: "2026-10-01T00:00:00.000Z" }), NOW)).toContain("npm run mesa:login");
  });
  it("escapes LMS text for Telegram HTML", () => {
    expect(renderBrief(data({ due: [{ title: "A<b>&", course: null, dueAt: "2026-09-30T00:00:00.000Z", dueIst: "x" }] }), NOW)).toContain("A&lt;b&gt;&amp;");
  });
});
