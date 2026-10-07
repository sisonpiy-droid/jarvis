import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import { estimateSession, sessionNumber } from "@jarvis/db";
import { createLogger } from "@jarvis/shared";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { say, scripted } from "../../ai/test/scripted";
import { prepAlert, RECAP_WAIT_MS, runClassPrep } from "../src/class-prep";
import { runEvening } from "../src/evening";

// Pre-class prep against the real migrations (in-process Postgres): which session a class is, which pre-read
// belongs to it, the key points (scripted model), the 30-minute push and the evening list — each sent once.

vi.spyOn(console, "log").mockImplementation(() => {});
const log = createLogger("test");
const NOW = new Date("2026-10-03T02:30:00.000Z"); // Sat 3 Oct, 08:00 IST
const SHA = "a".repeat(64);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());

const item = (kind: string, id: string, title: string, data: Record<string, unknown>, sortAt: string | null, courseId: string | null) =>
  t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, course_id, title, sort_at)
        values (${kind}, ${id}, ${`h-${id}`}, ${t.sql.json({ sourceId: id, title, ...data } as never)}, ${courseId}, ${title}, ${sortAt})`;
const session = (id: string, title: string, startAt: string, courseId: string, extra: Record<string, unknown> = {}) =>
  item("event", id, title, { eventType: "session", status: "scheduled", startAt, room: "LT-2", ...extra }, startAt, courseId);

beforeEach(async () => {
  await t.sql`truncate jarvis.lms_items, jarvis.item_files, jarvis.files, jarvis.prep_notes, jarvis.notifications restart identity cascade`;
  await item("course", "c1", "Data Driven Decision Making with Prof. Vinay Sharma", { shortName: "DDDM", instructor: "Prof. Vinay Sharma" }, null, "c1");
  await item("course", "c2", "Power of Communication with Chirantan", { shortName: "PoC" }, null, "c2");
  await item("recording", "r8", "Session 8", { recordedOn: "2026-09-25" }, "2026-09-25T00:00:00Z", "c1");
  await item("recording", "r9", "Session 9", { recordedOn: "2026-09-26" }, "2026-09-26T00:00:00Z", "c1");
  await session("e0", "Data Driven Decision Making with Vinay Sharma", "2026-09-26T08:30:00Z", "c1"); // the Session 9 day
  await session("e1", "Data Driven Decision Making with Vinay Sharma", "2026-09-30T06:00:00Z", "c1"); // → 10
  await session("ex", "Data Driven Decision Making with Vinay Sharma", "2026-10-02T06:00:00Z", "c1", { status: "cancelled" });
  await session("e2", "Data Driven Decision Making with Vinay Sharma", "2026-10-03T03:00:00Z", "c1"); // → 11, in 30 min
  await session("e3", "Power of Communication with Chirantan", "2026-10-04T06:00:00Z", "c2");
  await item("material", "m11", "PreRead_Session 11_Groww", { kind: "file", topicTitle: "Pre-Reads", downloadable: true }, "2026-09-30T08:00:00Z", "c1");
  await item("material", "m11w", "Session 11 Workbook", { kind: "file", topicTitle: "Resources", downloadable: true }, "2026-10-01T08:00:00Z", "c1");
  await item("material", "m10", "Session 10 Deck", { kind: "file", topicTitle: "Resources", downloadable: true }, "2026-10-01T09:00:00Z", "c1");
  await item("material", "m12", "Session 12 Pre-Read", { kind: "link", topicTitle: "Pre-Reads", url: "https://docs.google.com/document/d/x" }, "2026-10-02T09:00:00Z", "c1");
  await item("material", "p1", "Opening paragraphs exercise", { kind: "file", topicTitle: "Resources", downloadable: true }, "2026-10-01T09:00:00Z", "c2");
  await item("assignment", "a1", "Session 11 Groww Workbook", { submissionStatus: "not_submitted" }, "2026-10-03T18:29:00Z", "c1");
  await item("assignment", "a2", "Session 9 Workbook", { submissionStatus: "submitted" }, "2026-10-03T18:29:00Z", "c1");
  await t.sql`insert into jarvis.files (sha256, storage_path, size_bytes, original_filename, text_status, text_content)
              values (${SHA}, 'mesa/aa/x.pdf', 100, 'PreRead_Session 11_Groww.pdf', 'done', 'Groww reached 10 million users. Retention by cohort is the key question.')`;
  await t.sql`insert into jarvis.item_files (kind, item_id, attachment_id, sha256, status) values ('material', 'm11', 'm11', ${SHA}, 'done')`;
});

const POINTS = say(JSON.stringify({ points: ["Groww reached 10 million users.", "Its market share is 99% in tier-2 cities.", "Think about cohort retention."] }));

describe("session numbers", () => {
  it("reads them from titles", () => {
    expect(sessionNumber("PreRead_Session 8_Groww")).toBe(8);
    expect(sessionNumber("Pre-Read 1_Session 10 - HBR Article")).toBe(10);
    expect(sessionNumber("C4_Intro to Business Frameworks - Session 5")).toBe(5);
    expect(sessionNumber("Self-assessment 2")).toBeNull();
    expect(sessionNumber("Pre-Read FOF1")).toBeNull();
  });

  it("counts classes after the latest recording, and refuses when the timetable doesn't reach back", () => {
    const recs = [{ title: "Session 9", day: "2026-09-26" }];
    const starts = ["2026-09-26T08:30:00Z", "2026-09-30T06:00:00Z", "2026-10-03T03:00:00Z"];
    expect(estimateSession({ title: "DDDM", startAt: "2026-10-03T03:00:00Z" }, recs, starts)).toBe(11);
    expect(estimateSession({ title: "DDDM", startAt: "2026-10-03T03:00:00Z" }, recs, starts.slice(2))).toBeNull(); // gap
    expect(estimateSession({ title: "DDDM", startAt: "2026-10-03T03:00:00Z" }, [], starts)).toBeNull();
    expect(estimateSession({ title: "DDDM Session 4", startAt: "2026-10-03T03:00:00Z" }, recs, starts)).toBe(4);
  });
});

describe("classPrep", () => {
  it("links the session's pre-read and materials, and what's due", async () => {
    const p = (await db.classPrep(t.sql, "e2", NOW))!;
    expect(p.session).toBe(11);
    expect(p.match).toBe("session");
    expect(p.items.map((i) => [i.title, i.preRead, i.hasText])).toEqual([
      ["PreRead_Session 11_Groww", true, true],
      ["Session 11 Workbook", false, false],
    ]);
    expect(p.items[0]!.noteKey).toBe(`file:${SHA}`);
    expect(p.due.map((d) => d.id)).toEqual(["a1"]);
    expect((await db.classPrep(t.sql, "e1", NOW))!.session).toBe(10);
  });

  it("without a session number shows the course's newest materials as such", async () => {
    const p = (await db.classPrep(t.sql, "e3", NOW))!;
    expect([p.session, p.match, p.items.map((i) => i.title)]).toEqual([null, "recent", ["Opening paragraphs exercise"]]);
  });
});

describe("prep job", () => {
  it("writes key points once, pushes 30 minutes before, and never twice", async () => {
    const { model, requests } = scripted(POINTS);
    const s = await runClassPrep(t.sql, NOW, model, log);
    expect([s.summarized, s.alerts]).toEqual([1, 1]);
    expect(requests[0]!.messages[0]!.parts[0]).toMatchObject({ type: "text" });
    // The invented 99% is dropped: the document never says it.
    const [note] = await t.sql`select points from jarvis.prep_notes where key = ${`file:${SHA}`}`;
    expect(note!.points).toEqual(["Groww reached 10 million users.", "Think about cohort retention."]);
    const [n] = await t.sql`select dedupe_key, priority, text from jarvis.notifications`;
    expect(n!.dedupe_key).toBe("class.prep:e2:2026-10-03T03:00:00.000Z");
    expect(n!.priority).toBe("high");
    expect(n!.text).toContain("DDDM · Session 11");
    expect(n!.text).toContain("Pre-read: PreRead_Session 11_Groww");
    expect(n!.text).toContain("• Groww reached 10 million users.");
    expect(n!.text).toContain("Due");
    const [f] = await t.sql`select files from jarvis.notifications`;
    expect(f!.files).toEqual([SHA]); // the pre-read itself goes along
    expect(db.notificationMeta(String(n!.dedupe_key)).url).toBe("/classes/e2");

    // Again five minutes later: no AI call (the scripted model has no replies left) and no second push.
    const again = await runClassPrep(t.sql, new Date(NOW.getTime() + 5 * 60_000), model, log);
    expect([again.summarized, again.summaryErrors, again.queued]).toEqual([0, 0, 0]);
  });

  it("leaves tomorrow's pre-reads to the evening check-in, sent once", async () => {
    const evening = new Date("2026-10-03T15:05:00.000Z"); // 20:35 IST
    // Only this morning's recap (no AI key: without points); no pre-class push in the evening.
    expect(await runClassPrep(t.sql, evening, null, log)).toMatchObject({ alerts: 0, recaps: 1 });
    const s = await runEvening(t.sql, evening, null, log);
    expect(s.checkin).toBe(true);
    const [n] = await t.sql`select dedupe_key, text from jarvis.notifications where dedupe_key like 'checkin:%'`;
    expect(n!.dedupe_key).toBe("checkin:2026-10-03");
    expect(n!.text).toContain("Tomorrow (Sun 4 Oct): 1 class from 11:30 am");
    expect(n!.text).toContain("📖 Pre-reads: PoC — none on the LMS");
    expect(db.notificationMeta(String(n!.dedupe_key))).toEqual({ category: "brief", url: "/checkin" });
    expect((await runEvening(t.sql, new Date(evening.getTime() + 15 * 60_000), null, log)).checkin).toBe(false);
  });

  it("after class: waits for the recording, then sends revision points, the material and the recording — once", async () => {
    const after = new Date("2026-10-03T06:00:00.000Z"); // 11:30 IST, class (8:30–10:00) ended 1.5 h ago
    expect((await runClassPrep(t.sql, after, null, log)).recaps).toBe(0); // no recording yet, not waited long enough
    await item("recording", "r11", "Session 11", { recordedOn: "2026-10-03", videoUrl: "https://youtube.com/live/abc" }, "2026-10-03T05:30:00Z", "c1");
    const { model, requests } = scripted(say(JSON.stringify({ points: ["Groww reached 10 million users.", "Retention by cohort is the key question.", "Churn fell 40%."] })));
    const s = await runClassPrep(t.sql, after, model, log);
    expect([s.recaps, s.summarized]).toEqual([1, 1]);
    expect(requests[0]!.system).toContain("revision notes");
    const [n] = await t.sql`select dedupe_key, priority, text, files from jarvis.notifications where dedupe_key like 'class.recap:%'`;
    expect(n!.dedupe_key).toBe("class.recap:e2:2026-10-03T03:00:00.000Z");
    expect(n!.text).toBe(
      [
        "📝 <b>DDDM · Session 11 — recap</b>",
        "• Groww reached 10 million users.",
        "• Retention by cohort is the key question.", // the invented 40% is dropped
        "📎 PreRead_Session 11_Groww",
        "📎 Session 11 Workbook",
        '🎥 <a href="https://youtube.com/live/abc">Recording: Session 11</a>',
      ].join("\n"),
    );
    expect(n!.files).toEqual([SHA]);
    expect(db.notificationMeta(String(n!.dedupe_key)).url).toBe("/classes/e2");
    // Never twice, and no second AI call.
    expect((await runClassPrep(t.sql, new Date(after.getTime() + RECAP_WAIT_MS), model, log)).recaps).toBe(0);
  });

  it("formats a class with nothing linked", () => {
    const p: db.ClassPrep = {
      event: { id: "e9", title: "AOS", course: "The Art of Selling", courseId: "c9", short: "AOS", startAt: "2026-10-03T06:00:00Z", endAt: null, room: null, meetingLink: null, status: "scheduled" },
      session: 12,
      match: "none",
      items: [],
      due: [],
      recording: null,
    };
    expect(prepAlert(p, NOW).text).toBe("📖 <b>AOS · Session 12</b> at 11:30 am\nNo pre-read found on the LMS for this class.");
  });
});
