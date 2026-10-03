import { describe, expect, it } from "vitest";
import { istParts, sourceLink } from "../lib/work-format";

describe("task display helpers", () => {
  it("splits a timestamp into IST date and time for form inputs", () => {
    expect(istParts("2026-10-02T18:29:00.000Z")).toEqual({ date: "2026-10-02", time: "23:59" });
    expect(istParts("2026-10-01T18:45:00.000Z")).toEqual({ date: "2026-10-02", time: "00:15" }); // after midnight IST
    expect(istParts(null)).toEqual({ date: "", time: "" });
  });

  it("links MESA tasks back to their assignment or exam", () => {
    expect(sourceLink({ source: "mesa", sourceRef: "mesa:submit:abc" })).toEqual({ href: "/assignments/abc", label: "Assignment" });
    expect(sourceLink({ source: "mesa", sourceRef: "mesa:review:abc" })?.href).toBe("/assignments/abc");
    expect(sourceLink({ source: "mesa", sourceRef: "mesa:prep:e1" })?.label).toBe("Exam");
    expect(sourceLink({ source: "manual", sourceRef: null })).toBeNull();
  });
});
