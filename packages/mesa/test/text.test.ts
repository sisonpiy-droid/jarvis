import { describe, expect, it } from "vitest";
import { extractLinks, formatIst, htmlToText, instructorFromCourseTitle, isSignedUrl, parseDeadline, stableUrl } from "../src/text";

describe("htmlToText", () => {
  it("keeps paragraph and list structure and decodes entities", () => {
    expect(htmlToText("<p><strong>Title</strong> &amp; more</p><ul><li>One</li><li>Two&nbsp;x</li></ul>")).toBe(
      "Title & more\n\n• One\n• Two x",
    );
  });
  it("returns null for empty input", () => {
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText("<p></p>")).toBeNull();
  });
  it("drops script/style content", () => {
    expect(htmlToText("<p>a</p><script>alert(1)</script><style>p{}</style>")).toBe("a");
  });
});

describe("extractLinks", () => {
  it("finds http(s) hrefs once each", () => {
    const html = '<a href="https://a.com/x">1</a> <a href="mailto:x@y.z">m</a> <a href="https://a.com/x">again</a>';
    expect(extractLinks(html)).toEqual(["https://a.com/x"]);
  });
});

describe("stableUrl", () => {
  const signed = "https://storage.googleapis.com/b/f.pdf?GoogleAccessId=svc&Expires=123&Signature=abc";
  it("strips GCS signing params", () => {
    expect(stableUrl(signed)).toBe("https://storage.googleapis.com/b/f.pdf");
    expect(isSignedUrl(signed)).toBe(true);
  });
  it("is identical across re-signed URLs", () => {
    expect(stableUrl(signed)).toBe(stableUrl(signed.replace("Expires=123&Signature=abc", "Expires=999&Signature=zzz")));
  });
  it("leaves ordinary query strings alone", () => {
    expect(stableUrl("https://docs.google.com/x?usp=sharing")).toBe("https://docs.google.com/x?usp=sharing");
    expect(isSignedUrl("https://docs.google.com/x?usp=sharing")).toBe(false);
  });
});

describe("deadlines", () => {
  it("parses ISO timestamps and rejects junk", () => {
    expect(parseDeadline("2026-08-25T18:29:00.000Z")?.toISOString()).toBe("2026-08-25T18:29:00.000Z");
    expect(parseDeadline("not a date")).toBeNull();
    expect(parseDeadline(null)).toBeNull();
    expect(parseDeadline("")).toBeNull();
  });
  it("renders UTC deadlines in IST (18:29Z is 11:59 pm IST)", () => {
    const s = formatIst("2026-08-25T18:29:00.000Z");
    expect(s).toMatch(/25 Aug 2026/);
    expect(s).toMatch(/11:59\s?pm/i);
  });
  it("handles the IST date rollover (20:00Z is next day in IST)", () => {
    expect(formatIst("2026-09-30T20:00:00.000Z")).toMatch(/1 Oct 2026/);
  });
});

describe("instructorFromCourseTitle", () => {
  it("extracts the 'with Prof. X' suffix", () => {
    expect(instructorFromCourseTitle("Data Driven Decision Making with Prof. Vinay Sharma")).toBe("Prof. Vinay Sharma");
  });
  it("returns null when absent", () => {
    expect(instructorFromCourseTitle("Study Block")).toBeNull();
    expect(instructorFromCourseTitle(null)).toBeNull();
  });
});
