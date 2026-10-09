import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import type { BriefFacts, FactRef } from "@jarvis/db";
import { checkGrounding, evidenceFrom, extractMentions, fallbackFocusNote } from "@jarvis/ai";
import { renderNotification, toPlainText } from "@jarvis/notify";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { say, scripted } from "../../ai/test/scripted";
import { BRIEF_MAX_CHARS, BRIEF_TITLE, dailyBrief, renderBrief } from "../src/brief";
import { BRIEF_NOW as NOW, seedBriefWorld, truncateBriefWorld } from "./brief-world";

// The morning brief against the real migrations (PGlite): rendering, limits, and that every line traces back
// to a row. No model is called except the scripted ones.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await truncateBriefWorld(t.sql);
});

const facts = async (o: { stale?: boolean } = {}) => {
  const f = await db.loadBriefFacts(t.sql, NOW, o);
  return { f, s: db.briefSections(f) };
};
const render = async () => {
  const { f, s } = await facts();
  return { f, s, ...renderBrief(f, s, fallbackFocusNote(f, s)) };
};
const balanced = (html: string) => ["b", "i"].every((tag) => html.split(`<${tag}>`).length === html.split(`</${tag}>`).length);

describe("renderBrief", () => {
  it("renders the day in spec order", async () => {
    await seedBriefWorld(t.sql);
    const { text } = await render();
    expect(text).toBe(
      [
        "☀️ <b>Good morning — your day is ready</b>",
        "Thursday, 1 October · 1 class from 10:00 am (1 cancelled) · 12 h 25 min free · All day: Dussehra",
        "<b>TODAY'S PRIORITIES</b>",
        "1. Finish Spinny presentation — today 6:00 pm",
        "2. Send recruiter follow-up — overdue since Wed 30 Sep",
        "3. Submit Framework Case — tomorrow 11:59 pm",
        "+2 more",
        "",
        "<b>PERSONAL</b>",
        "- Read 30 minutes",
        "- Workout (2 of 4 this week)",
        "- Call home — today",
        "",
        "<b>UPCOMING</b>",
        "- Interview — Sat 3 Oct, 2:00 pm",
        "- Brand audit reflection — Sat 3 Oct, 11:59 pm",
        "- Pick a name — Sun 4 Oct",
        "- Prepare for Marketing mid-term — Mon 5 Oct, 9:30 am",
        "- Side project — Tue 6 Oct",
        "",
        "<b>GOALS</b>",
        "Reading: 4/10 this week",
        "Workout: 2/4 this week",
        "Journal: 0/4 this month",
        "",
        "<b>RISKS</b>",
        "- Overdue: Send recruiter follow-up (overdue since Wed 30 Sep)",
        "- Finish Spinny presentation due today 6:00 pm, not started",
        "- Call home due today, not started",
        "- Submit Framework Case due tomorrow 11:59 pm, not started",
        "- Reading: 4 of 10 with 4 days left",
        "+3 more",
        "",
        "🧭 <i>Start with “Finish Spinny presentation” — due today 6:00 pm. Keep an eye on “Send recruiter follow-up”: it is overdue. You have about 12 h 25 min free between classes.</i>",
      ].join("\n"),
    );
  });

  it("puts the sections in spec order and the note last", async () => {
    await seedBriefWorld(t.sql);
    const { lines } = await render();
    const order = lines.filter((l) => l.kind !== "item" && l.kind !== "more" && l.kind !== "blank").map((l) => (l.kind === "heading" ? toPlainText(l.html) : l.kind));
    expect(order).toEqual(["title", "meta", "TODAY'S PRIORITIES", "PERSONAL", "UPCOMING", "GOALS", "RISKS", "note"]);
    expect(lines.at(-1)!.kind).toBe("note");
  });

  it("leaves out empty sections but always shows the priorities", async () => {
    const { f, s } = await facts();
    const { text, lines } = renderBrief(f, s, { text: "", refs: [] });
    expect(text).toBe(["☀️ <b>Good morning — your day is ready</b>", "Thursday, 1 October · No classes · 13 h 55 min free", "<b>TODAY'S PRIORITIES</b>", "Nothing pressing at work today."].join("\n"));
    expect(lines.map((l) => l.kind)).toEqual(["title", "meta", "heading", "item"]);
  });

  it("caps each section with a '+N more' line that carries the hidden rows", async () => {
    const w = await seedBriefWorld(t.sql);
    const { lines } = await render();
    const more = lines.filter((l) => l.kind === "more");
    expect(more.map((l) => l.html)).toEqual(["+2 more", "+3 more"]);
    expect(more[0]!.refs.length).toBe(2); // the professional tasks after the top 3
    expect(more[1]!.refs.map(db.refKey)).toEqual(["integration:mesa", `habit:${w.read.id}`, `goal:${w.journal.id}`]);
  });

  it("escapes <, > and & in titles", async () => {
    await db.createTask(t.sql, { title: "Fix <b> & <i> tags", priority: 1, due: "2026-10-01T18:00:00+05:30" });
    const { text } = await render();
    expect(text).toContain("1. Fix &lt;b&gt; &amp; &lt;i&gt; tags — today 6:00 pm");
    expect(balanced(text)).toBe(true);
  });

  it("pushes as 'Good morning' with the meta line and the 3 priorities in the body", async () => {
    await seedBriefWorld(t.sql);
    const { text, s } = await render();
    const push = renderNotification(text);
    expect(push.title).toBe(BRIEF_TITLE);
    expect(push.title).toBe("☀️ Good morning — your day is ready");
    expect(push.body.startsWith("Thursday, 1 October · 1 class from 10:00 am")).toBe(true);
    expect(push.body).toContain("TODAY'S PRIORITIES\n1. Finish Spinny presentation");
    for (const i of s.priorities) expect(push.body).toContain(i.task.title);
  });

  it("stays within 3,500 characters with balanced tags on a huge day, giving up whole lines", async () => {
    const long = (n: number) => `Task ${n} <&> ${"x".repeat(290)}`;
    for (let n = 0; n < 60; n++) {
      await db.createTask(t.sql, { title: long(n), domain: n % 2 ? "personal" : "professional", priority: (n % 4) + 1, due: `2026-10-0${(n % 7) + 1}T12:00:00+05:30` });
    }
    for (let n = 0; n < 8; n++) await db.createHabit(t.sql, { name: `Habit ${n} ${"y".repeat(290)}`, startDate: "2026-09-20" }, NOW);
    for (let n = 0; n < 7; n++) await db.createGoal(t.sql, { title: `Goal ${n} ${"z".repeat(290)}`, targetValue: 5, period: "week", startDate: "2026-09-01" }, NOW);
    const { f, s } = await facts();
    const { text, lines } = renderBrief(f, s, { text: "Ship it & move on. ".repeat(40), refs: [{ t: "integration", id: "mesa" }] });
    expect(text.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(balanced(text)).toBe(true);
    for (const l of lines) expect(balanced(l.html)).toBe(true);
    expect(lines.some((l) => l.kind === "note")).toBe(true);
    // Titles are cut to 80 characters (escaped afterwards).
    expect(toPlainText(lines.find((l) => l.kind === "item")!.html)).toMatch(/^1\. Task \d+ <&> x+… — /);
    // Over the limit at the default caps, so sections gave up lines; the hidden ones are still referenced.
    const shownItems = lines.filter((l) => l.kind === "item").length;
    expect(shownItems).toBeLessThan(3 + 6 + 6 + 5 + 5);
    expect(s.upcoming.length).toBeGreaterThan(6);
    const refs = new Set(lines.flatMap((l) => l.refs.map(db.refKey)));
    for (const d of s.upcoming) expect(refs.has(db.refKey(d.ref))).toBe(true);
  });

  it("states no date the facts don't hold", async () => {
    await seedBriefWorld(t.sql);
    const { f, text } = await render();
    const plain = toPlainText(text);
    expect(extractMentions(plain, NOW).filter((m) => m.kind === "day").length).toBeGreaterThan(3);
    expect(checkGrounding(plain, evidenceFrom([f], [], NOW), NOW)).toEqual({ ok: true, violations: [] });
  });
});

// ── traceability ──────────────────────────────────────────────────────────────

async function resolves(r: FactRef): Promise<boolean> {
  const rows =
    r.t === "lms" ? await t.sql`select 1 from jarvis.lms_items where kind = ${r.kind} and source_id = ${r.id}` :
    r.t === "integration" ? await t.sql`select 1 from jarvis.integrations where provider = ${r.id}` :
    await t.sql`select 1 from ${t.sql(`jarvis.${r.t}s`)} where id = ${r.id}`;
  return rows.length === 1;
}

describe("dailyBrief", () => {
  it("Monday morning adds 'Before Friday' — overdue, then Monday to Friday by day; other days don't", async () => {
    await seedBriefWorld(t.sql);
    expect((await dailyBrief(t.sql, NOW, { model: null, stale: false })).weekAhead).toBeNull(); // a Thursday
    const MON = new Date("2026-10-05T03:30:00.000Z"); // Mon 5 Oct, 09:00 IST
    const { weekAhead } = await dailyBrief(t.sql, MON, { model: null, stale: false });
    expect(weekAhead).toMatchObject({ dedupeKey: "week.ahead:2026-10-05", url: "/plan" });
    expect(weekAhead!.text).toMatch(/Before Friday<\/b> · Mon.*5 Oct – Fri.*9 Oct/);
    expect(weekAhead!.text).toContain("Prepare for Marketing mid-term");
    expect(weekAhead!.text).toContain("Side project");
    expect(db.notificationMeta(weekAhead!.dedupeKey)).toEqual({ category: "brief", url: "/plan" });
  });

  it("traces every line to a row and stores exactly what it queues", async () => {
    await seedBriefWorld(t.sql);
    const { draft, stats } = await dailyBrief(t.sql, NOW, { model: null, stale: false });
    expect(draft).toMatchObject({ dedupeKey: "brief:2026-10-01", priority: "normal", scheduledFor: NOW.toISOString(), url: "/" });
    expect(stats).toEqual({ focusNote: "fallback", detail: "no_model", lines: expect.any(Number) });

    const stored = (await db.getBrief(t.sql, "2026-10-01"))!;
    expect(stored.text).toBe(draft.text);
    expect(stored.lines.map((l) => l.html).join("\n")).toBe(draft.text);
    expect(stored.lines).toHaveLength(stats.lines);
    expect(stored).toMatchObject({ day: "2026-10-01", noteSource: "fallback", noteDetail: "no_model" });
    expect(stored.note).toContain("Finish Spinny presentation");

    for (const l of stored.lines) {
      if (!["meta", "item", "more", "note"].includes(l.kind)) continue;
      expect(l.refs.length, `${l.kind}: ${l.html}`).toBeGreaterThanOrEqual(1);
      for (const r of l.refs) expect(await resolves(r), db.refKey(r)).toBe(true);
    }
    expect(stored.noteRefs).toEqual(stored.lines.find((l) => l.kind === "note")!.refs);
  });

  it("marks stale LMS data in the meta line's refs and the risks", async () => {
    await seedBriefWorld(t.sql, { lastSuccessAt: "2026-09-30T20:00:00Z" });
    await dailyBrief(t.sql, NOW, { model: null, stale: true });
    const stored = (await db.getBrief(t.sql, "2026-10-01"))!;
    expect(stored.lines.find((l) => l.kind === "meta")!.refs).toContainEqual({ t: "integration", id: "mesa" });
    // Severity 1, but shown as the first risk so the capped section's "+N more" can't hide it.
    const risks = stored.lines.slice(stored.lines.findIndex((l) => l.html === "<b>RISKS</b>") + 1);
    expect(risks[0]).toMatchObject({ kind: "item", refs: [{ t: "integration", id: "mesa" }] });
    expect(risks[0]!.html).toMatch(/^- LMS data last updated \d+ h ago — deadlines may be out of date$/);
    expect(risks.filter((l) => l.kind === "item")).toHaveLength(5);
    expect(stored.text.match(/LMS data last updated/g)).toHaveLength(1);
  });

  it("calls the model once a day: a rebuild reuses the stored note", async () => {
    await seedBriefWorld(t.sql);
    const first = scripted(say(JSON.stringify({ note: "Start with {P1}, then {P2}. You have about {FREE}." })));
    const a = await dailyBrief(t.sql, NOW, { model: first.model, stale: false });
    expect(a.stats).toMatchObject({ focusNote: "ai", detail: null });
    expect(a.draft.text).toContain("🧭 <i>Start with “Finish Spinny presentation”, then “Send recruiter follow-up”. You have about 12 h 25 min free between classes.</i>");

    const again = scripted();
    const b = await dailyBrief(t.sql, new Date(NOW.getTime() + 15 * 60_000), { model: again.model, stale: false });
    expect(again.requests).toHaveLength(0);
    expect(b.stats).toMatchObject({ focusNote: "ai", detail: null });
    expect(b.draft.text).toContain("🧭 <i>Start with “Finish Spinny presentation”");
    // The stored text follows the rebuild (it is what gets queued); the note is the first one.
    const stored = (await db.getBrief(t.sql, "2026-10-01"))!;
    expect(stored.text).toBe(b.draft.text);
    expect(stored.noteSource).toBe("ai");
  });
});

// Keeps the fixture honest: the facts the snapshot above was written against.
describe("brief world", () => {
  it("matches the db fixture's numbers", async () => {
    await seedBriefWorld(t.sql);
    const { f }: { f: BriefFacts } = await facts();
    expect(f.freeTime.freeMin).toBe(745);
    expect(f.label).toBe("Thursday, 1 October");
  });
});
