import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@jarvis/ai";
import { chatCaption, contextDividerIndex, dayLabel, groupByDay, sourceLabels, TOOL_LABEL, timeLabel, toChatView } from "../lib/chat";

// The chat page's view model: stored transcript items → safe HTML bubbles with IST day/time labels and
// plain "Checked: …" sources.

const NOW = new Date("2026-10-01T02:35:00.000Z"); // Thu 1 Oct, 08:05 IST

const item = (o: Partial<TranscriptItem> & Pick<TranscriptItem, "id" | "role">): TranscriptItem => ({ text: "", at: NOW.toISOString(), tools: [], guarded: false, ...o });

describe("toChatView", () => {
  it("escapes the owner's text and renders JARVIS's Markdown", () => {
    const [u, j] = toChatView(
      [item({ id: 1, role: "user", text: `<script>alert("x")</script> & **not bold**` }), item({ id: 2, role: "jarvis", text: "**Spinny deck** first\n- then <b>this</b>" })],
      NOW,
    );
    expect(u!.html).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; **not bold**");
    expect(j!.html).toContain("<b>Spinny deck</b> first");
    expect(j!.html).toContain("• then &lt;b&gt;this&lt;/b&gt;");
    expect(j!.html).not.toContain("<script");
  });

  it("maps tool names to plain labels, de-duplicated, writes left out", () => {
    const [j] = toChatView([item({ id: 2, role: "jarvis", text: "ok", tools: ["get_focus", "get_week", "list_tasks", "create_task", "get_attention", "search_memory"] })], NOW);
    expect(j!.sources).toEqual(["focus list", "your week", "tasks", "risks", "memory"]);
    expect(sourceLabels(["get_accomplished", "get_commitments", "get_assignment", "list_goals", "get_goal"])).toEqual(["done items", "commitments", "assignment", "goals"]);
    expect(sourceLabels(["get_brand_new_thing", "save_memory", "resolve_old_memory"])).toEqual(["brand new thing"]);
    expect(TOOL_LABEL.get_focus).toBe("focus list");
  });

  it("labels days in IST: Today, Yesterday, then a short date (with the year when it differs)", () => {
    const views = toChatView(
      [
        item({ id: 1, role: "user", text: "a", at: "2026-09-28T04:00:00.000Z" }),
        item({ id: 2, role: "user", text: "b", at: "2026-09-30T18:00:00.000Z" }), // 23:30 IST on the 30th
        item({ id: 3, role: "user", text: "c", at: "2026-09-30T18:30:00.000Z" }), // 00:00 IST on the 1st
      ],
      NOW,
    );
    expect(views.map((v) => v.dayLabel)).toEqual(["Mon 28 Sep", "Yesterday", "Today"]);
    expect(views[0]!.timeLabel).toBe("9:30 am");
    expect(timeLabel("2026-09-30T18:00:00.000Z")).toBe("11:30 pm");
    expect(timeLabel("2026-09-30T18:30:00.000Z")).toBe("12:00 am");
    expect(dayLabel("2025-12-31T04:00:00.000Z", NOW)).toBe("Wed 31 Dec 2025");
  });

  it("turns a marker into an empty divider item, and keeps sources and guarded for JARVIS only", () => {
    const views = toChatView([item({ id: 5, role: "marker", tools: ["get_focus"], guarded: true }), item({ id: 6, role: "jarvis", text: "x", guarded: true })], NOW);
    expect(views[0]).toMatchObject({ role: "marker", html: "", sources: [], guarded: false });
    expect(views[1]!.guarded).toBe(true);
  });
});

describe("chat page helpers", () => {
  it("writes the caption under a JARVIS bubble", () => {
    expect(chatCaption({ sources: ["focus list", "your week"], timeLabel: "9:02 am", guarded: false })).toBe("Checked: focus list · your week · 9:02 am");
    expect(chatCaption({ sources: [], timeLabel: "9:02 am", guarded: true })).toBe("9:02 am · some details couldn't be verified");
  });

  it("draws the context divider only after earlier messages, and not right after a New conversation divider", () => {
    const items = [
      { id: 1, role: "user" as const },
      { id: 2, role: "jarvis" as const },
      { id: 3, role: "user" as const },
      { id: 4, role: "jarvis" as const },
    ];
    expect(contextDividerIndex(items, 3)).toBe(2);
    expect(contextDividerIndex(items, 1)).toBe(-1); // everything shown is in context
    expect(contextDividerIndex(items, null)).toBe(-1);
    expect(contextDividerIndex(items, 99)).toBe(-1); // not on this page
    expect(contextDividerIndex([{ id: 1, role: "user" }, { id: 2, role: "marker" }, { id: 3, role: "user" }], 3)).toBe(-1);
    expect(contextDividerIndex([{ id: 1, role: "marker" }, { id: 2, role: "user" }], 2)).toBe(-1);
  });

  it("groups consecutive items under their day separator", () => {
    const g = groupByDay([
      { id: 1, dayLabel: "Yesterday" },
      { id: 2, dayLabel: "Yesterday" },
      { id: 3, dayLabel: "Today" },
    ]);
    expect(g.map((x) => [x.day, x.items.map((i) => i.id)])).toEqual([
      ["Yesterday", [1, 2]],
      ["Today", [3]],
    ]);
  });
});
