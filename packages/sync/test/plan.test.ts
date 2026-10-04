import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "@jarvis/db";
import { createLogger } from "@jarvis/shared";
import { planningTools } from "../../ai/src/planning-tools";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { say, scripted } from "../../ai/test/scripted";
import { runEvening } from "../src/evening";

// Week plan (AI draft, checked against real free gaps, approved) and commitments (a person on a task).

vi.spyOn(console, "log").mockImplementation(() => {});
const log = createLogger("test");
const SUN_7PM = new Date("2026-10-04T13:35:00.000Z"); // Sun 4 Oct, 19:05 IST
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.tasks, jarvis.projects, jarvis.lms_items, jarvis.notifications, jarvis.settings restart identity cascade`;
});

const input = (): db.PlanInput => ({
  candidates: [{ id: 1, title: "Finance memo", dueAt: "2026-10-06T18:29:00.000Z", effortMin: null, priority: 1, project: null }],
  days: [{ day: "2026-10-05", gaps: [{ from: "2026-10-05T04:30:00.000Z", to: "2026-10-05T08:30:00.000Z", min: 240 }] }],
});

describe("validatePlan", () => {
  it("keeps blocks inside real gaps, before the due, in the future and apart — drops the rest", () => {
    const blocks = db.validatePlan(
      {
        blocks: [
          { task_id: 1, day: "2026-10-05", start: "10:00", minutes: 90, why: "before Tuesday" }, // 04:30Z–06:00Z ✓
          { task_id: 1, day: "2026-10-05", start: "10:30", minutes: 30 }, // overlaps
          { task_id: 1, day: "2026-10-05", start: "13:00", minutes: 120 }, // ends 09:30Z, past the gap
          { task_id: 9, day: "2026-10-05", start: "12:00", minutes: 30 }, // unknown task
          { task_id: 1, day: "2026-10-09", start: "12:00", minutes: 30 }, // day not offered
          { task_id: 1, day: "2026-10-05", start: "12:00", minutes: 5 }, // too short
        ],
      },
      input(),
      SUN_7PM,
    );
    expect(blocks).toEqual([{ taskId: 1, title: "Finance memo", start: "2026-10-05T04:30:00.000Z", minutes: 90, why: "before Tuesday" }]);
    expect(db.validatePlan("junk", input(), SUN_7PM)).toEqual([]);
  });
});

describe("the Sunday plan", () => {
  it("drafts at 19:00 on Sunday once, notifies, and once approved shows up in chat's briefing", async () => {
    const task = await db.createTask(t.sql, { title: "Finance memo", due: "2026-10-06T23:59:00+05:30", priority: 1 });
    const { model } = scripted(say(JSON.stringify({ note: "Front-load Monday.", blocks: [{ task_id: task.id, day: "2026-10-05", start: "10:00", minutes: 90, why: "a day of buffer" }, { task_id: task.id, day: "2026-10-05", start: "15:00", minutes: 60, why: "finish it" }] })));
    const s = await runEvening(t.sql, SUN_7PM, model, log);
    expect(s.planned).toBe(2);
    const [n] = await t.sql`select dedupe_key, text from jarvis.notifications where dedupe_key like 'plan:%'`;
    expect(n!.dedupe_key).toBe("plan:2026-10-04");
    expect(n!.text).toContain("Your plan for the week: 2 work blocks");
    expect(n!.text).toContain("Mon 5 Oct 10:00 am–11:30 am — Finance memo");
    expect(db.notificationMeta("plan:2026-10-04")).toEqual({ category: "brief", url: "/plan" });
    // A second run that evening makes no new plan (the scripted model has no replies left).
    expect((await runEvening(t.sql, new Date(SUN_7PM.getTime() + 15 * 60_000), model, log)).planned).toBeNull();

    // A draft isn't in the briefing; approving keeps only the ticked block.
    expect((await db.loadSituation(t.sql, SUN_7PM)).text).not.toContain("Approved week plan");
    await db.approveWeekPlan(t.sql, [1], SUN_7PM);
    const text = (await db.loadSituation(t.sql, SUN_7PM)).text;
    expect(text).toContain(`Approved week plan, blocks still ahead: Mon 5 Oct 3:00 pm–4:00 pm — Finance memo [task #${task.id}]`);
    expect(text).not.toContain("10:00 am–11:30 am");
  });
});

describe("commitments", () => {
  it("records who, lists both directions, and flags overdue ones in the check-in", async () => {
    const owe = await db.createTask(t.sql, { title: "Send the deck", person: "Rahul", due: "2026-10-05" });
    await db.createTask(t.sql, { title: "Market data for the case", person: "Aditi", status: "waiting", due: "2026-10-03" });
    expect(owe.person).toBe("Rahul");
    const r = (await planningTools(t.sql, () => SUN_7PM).find((x) => x.name === "get_commitments")!.run({})) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.you_owe.map((x: { title: string; to: string }) => [x.title, x.to])).toEqual([["Send the deck", "Rahul"]]);
    expect(r.waiting_on_others.map((x: { title: string; from: string; overdue: boolean }) => [x.title, x.from, x.overdue])).toEqual([["Market data for the case", "Aditi", true]]);
    const c = await db.loadCheckin(t.sql, new Date("2026-10-04T15:05:00.000Z"));
    expect(db.checkinText(c)).toContain("📨 Aditi still owes you: Market data for the case (due Sat 3 Oct) — nudge them?");
    expect((await db.updateTask(t.sql, owe.id, { person: "" }))!.person).toBeNull();
  });
});
