import { describe, expect, it } from "vitest";
import { Announcement, Assignment } from "../src/schemas";
import { normalizeAnnouncement, normalizeAssignment, normalizeSubmissionStatus } from "../src/normalize";
import { COURSE_BF, announcement, assignment } from "./fixtures/api";

const instructors = new Map([[COURSE_BF, "Prof. Example Person"]]);
const norm = (overrides: Record<string, unknown> = {}) => normalizeAssignment(Assignment.parse(assignment(overrides)), instructors);

describe("normalizeAssignment", () => {
  it("extracts every V1 field", () => {
    const a = norm();
    expect(a).toMatchObject({
      source: "mesa",
      sourceId: "asg-1",
      sourceUrl: "https://students.mesaschool.co.in/student/lms/assignments/asg-1",
      courseId: COURSE_BF,
      instructor: "Prof. Example Person",
      title: "Framework Application Case",
      descriptionText: "Framework Application — apply two frameworks.\n\n• Part A\n• Part B & C",
      instructionsText: "Make a copy of this sheet.",
      dueAt: "2026-09-30T18:29:00.000Z",
      submissionType: "file",
      maxMarks: 10,
      submissionStatus: "not_submitted",
      lmsStatus: "published",
    });
    expect(a.dueAtIst).toMatch(/30 Sept? 2026.*11:59\s?pm/i);
  });

  it("orders materials by position and strips signatures", () => {
    const a = norm();
    expect(a.materials.map((m) => m.sourceId)).toEqual(["mat-link", "mat-pdf"]);
    expect(a.materials[1]).toMatchObject({ url: "https://storage.googleapis.com/example-bucket/briefs/brief.pdf", signed: true, sizeBytes: 123456 });
  });

  it("collects links from instructions and link materials without duplicates", () => {
    expect(norm().links).toEqual(["https://docs.google.com/spreadsheets/d/EXAMPLE"]);
  });

  it("falls back to the instructor named in the course title", () => {
    expect(normalizeAssignment(Assignment.parse(assignment()), new Map()).instructor).toBe("Prof. Example Person");
  });

  it("tolerates missing course, description and materials", () => {
    const a = norm({ courseId: null, courseTitle: null, description: null, instructions: null, materials: [] });
    expect(a).toMatchObject({ courseId: null, instructor: null, descriptionText: null, links: [], materials: [] });
  });
});

describe("assignment content hash (change detection)", () => {
  it("is stable across identical fetches", () => {
    expect(norm().contentHash).toBe(norm().contentHash);
  });

  it("ignores key order", () => {
    const raw = assignment();
    const reversed = Object.fromEntries(Object.entries(raw).reverse());
    expect(normalizeAssignment(Assignment.parse(reversed), instructors).contentHash).toBe(norm().contentHash);
  });

  it("ignores re-signed storage URLs", () => {
    const base = assignment();
    const resigned = assignment({
      materials: base.materials.map((m) => ({ ...m, url: m.url.replace("Signature=AAAA", "Signature=ZZZZ").replace("Expires=1790000000", "Expires=1799999999") })),
    });
    expect(normalizeAssignment(Assignment.parse(resigned), instructors).contentHash).toBe(norm().contentHash);
  });

  it("changes when the deadline moves", () => {
    expect(norm({ dueAt: "2026-10-02T18:29:00.000Z" }).contentHash).not.toBe(norm().contentHash);
  });

  it("changes when a material is added", () => {
    const base = assignment();
    const more = assignment({ materials: [...base.materials, { ...base.materials[1], id: "mat-new", title: "Rubric" }] });
    expect(normalizeAssignment(Assignment.parse(more), instructors).contentHash).not.toBe(norm().contentHash);
  });

  it("changes when the description is edited", () => {
    expect(norm({ description: "<p>Revised brief</p>" }).contentHash).not.toBe(norm().contentHash);
  });

  it("does not change on HTML-only formatting differences", () => {
    expect(norm({ description: "<p><b>Framework Application</b> — apply <i>two</i> frameworks.</p><ul><li>Part A</li><li>Part B &amp; C</li></ul>" }).contentHash).toBe(
      norm().contentHash,
    );
  });
});

describe("normalizeSubmissionStatus", () => {
  it("maps known LMS values", () => {
    expect(normalizeSubmissionStatus("submitted")).toBe("submitted");
    expect(normalizeSubmissionStatus("late")).toBe("submitted_late");
    expect(normalizeSubmissionStatus(null)).toBe("not_submitted");
    expect(normalizeSubmissionStatus(undefined)).toBe("not_submitted");
  });
  it("preserves unknown values instead of guessing", () => {
    expect(normalizeSubmissionStatus("graded")).toBe("other:graded");
  });
});

describe("normalizeAnnouncement", () => {
  const n = (o: Record<string, unknown> = {}) => normalizeAnnouncement(Announcement.parse(announcement(o)));
  it("converts body and attachments", () => {
    expect(n()).toMatchObject({ title: "Groups for next week", bodyText: "Hello everyone!\n\nGroups are attached.", pinned: false });
    expect(n().attachments[0]).toMatchObject({ fileName: "groups.xlsx", signed: true, url: "https://storage.googleapis.com/example-bucket/ann/groups.xlsx" });
  });
  it("ignores engagement churn and pinning in the hash", () => {
    expect(n({ likesCount: 99, viewsCount: 1000, isPinned: true }).contentHash).toBe(n().contentHash);
  });
});
