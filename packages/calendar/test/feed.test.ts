import { describe, expect, it } from "vitest";
import { buildClassFeed, foldLine, icsText } from "../src/feed";
import { eventsBetween } from "../src/ics";

const now = new Date("2026-09-29T10:00:00Z");

describe("buildClassFeed", () => {
  const feed = buildClassFeed(
    [
      { sourceId: "e1", title: "Session 12", courseName: "Corporate Finance", instructor: "Prof. R", startAt: "2026-09-30T04:30:00.000Z", endAt: "2026-09-30T06:00:00.000Z", room: "Room 2, Block A", meetingLink: null, status: "scheduled" },
      { sourceId: "e2", title: "Marketing; guest talk", startAt: "2026-10-01T09:00:00.000Z", endAt: null, status: "cancelled", meetingLink: "https://meet.example/abc" },
    ],
    { now },
  );

  it("round-trips through our own reader with the right times, text and status", () => {
    const got = eventsBetween(feed, Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-11-01T00:00:00Z"));
    expect(got).toHaveLength(2);
    const [a, b] = got;
    expect(a!.title).toBe("Session 12");
    expect(new Date(a!.startMs).toISOString()).toBe("2026-09-30T04:30:00.000Z");
    expect(new Date(a!.endMs).toISOString()).toBe("2026-09-30T06:00:00.000Z");
    expect(a!.location).toBe("Room 2, Block A");
    // No end time → one hour; cancelled classes stay visible but marked.
    expect(b!.endMs - b!.startMs).toBe(3_600_000);
    expect(b!.title).toBe("[Cancelled] Marketing; guest talk");
    expect(b!.status).toBe("cancelled");
  });

  it("uses stable UIDs and CRLF line endings", () => {
    expect(feed).toContain("UID:mesa-event-e1@jarvis\r\n");
    expect(feed.split("\r\n").every((l) => !l.includes("\n"))).toBe(true);
    expect(feed.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  });
});

describe("ics text helpers", () => {
  it("escapes special characters", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
  it("folds long lines at 75 octets without splitting characters", () => {
    const line = "DESCRIPTION:" + "₹".repeat(60);
    const folded = foldLine(line).split("\r\n");
    expect(folded.length).toBeGreaterThan(1);
    expect(folded.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.map((l, i) => (i ? l.slice(1) : l)).join("")).toBe(line);
  });
});
