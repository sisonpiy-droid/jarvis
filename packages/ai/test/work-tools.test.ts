import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { runAgent } from "../src/agent";
import { saveMemory } from "../src/memory";
import { jarvisTools } from "../src/tools";
import { workTools } from "../src/work-tools";
import { call as toolCall, calls, say, scripted, text } from "./scripted";

// Task and project tools against the real migrations (in-process Postgres); the model is scripted.

const NOW = new Date("2026-10-01T03:30:00.000Z");
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.tasks, jarvis.projects, jarvis.project_items restart identity cascade`;
});

const tools = () => Object.fromEntries(workTools(t.sql, () => NOW).map((x) => [x.name, x]));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON
const call = (name: string, args: Record<string, unknown>) => tools()[name]!.run(args) as Promise<Record<string, any>>;

describe("work tools", () => {
  it("are all local writes or reads, and part of JARVIS's tool set", () => {
    const names = jarvisTools(t.sql).map((x) => x.name);
    for (const x of workTools(t.sql)) {
      expect(names).toContain(x.name);
      expect(["read", "write-local"]).toContain(x.effect);
    }
  });

  it("creates a project and task by title, completes it, and echoes what was stored", async () => {
    const p = await call("create_project", { title: "Spinny case competition", kind: "case_comp", deadline: "2026-10-20" });
    expect(p.created).toMatchObject({ title: "Spinny case competition", kind: "case_comp", status: "active" });
    const c = await call("create_task", { title: "Draft the market sizing slide", project: "spinny", due: "2026-10-05", priority: 1 });
    expect(c.created).toMatchObject({ title: "Draft the market sizing slide", project: "Spinny case competition", due: "Mon, 5 Oct", priority: 1 });
    const today = await call("list_tasks", { view: "upcoming" });
    expect(today.tasks.map((x: { title: string }) => x.title)).toEqual(["Draft the market sizing slide"]);
    const u = await call("update_task", { id: c.created.id, status: "done" });
    expect(u.updated.status).toBe("done");
    await call("add_project_item", { project: p.created.id, kind: "decision", body: "Focus on tier-2 cities" });
    const full = await call("get_project", { project: "spinny" });
    expect(full).toMatchObject({ open_tasks: [], recently_done: [{ title: "Draft the market sizing slide" }], items: [{ kind: "decision", body: "Focus on tier-2 cities" }] });
  });

  it("asks which project when the title is ambiguous, and rejects invalid input as a tool error", async () => {
    await call("create_project", { title: "Case A" });
    await call("create_project", { title: "Case B" });
    await expect(call("create_task", { title: "x", project: "case" })).rejects.toThrow(/several projects match/);
    await expect(call("create_task", { title: "x", due: "someday" })).rejects.toThrow(/ISO/);
  });

  it("round-trips effort_min (1–600; 0 clears it on update)", async () => {
    const c = await call("create_task", { title: "Write the deck", effort_min: 90 });
    expect(c.created.effort_min).toBe(90);
    expect((await call("update_task", { id: c.created.id, effort_min: 45 })).updated.effort_min).toBe(45);
    expect((await call("list_tasks", { view: "open" })).tasks[0].effort_min).toBe(45);
    expect((await call("update_task", { id: c.created.id, effort_min: 0 })).updated.effort_min).toBeUndefined();
    const [row] = await t.sql`select effort_min from jarvis.tasks where id = ${c.created.id}`;
    expect(row!.effort_min).toBeNull();
    await expect(call("create_task", { title: "x", effort_min: 601 })).rejects.toThrow(/1 to 600/);
    await expect(call("create_task", { title: "x", effort_min: 0 })).rejects.toThrow(/1 to 600/);
    await expect(call("update_task", { id: c.created.id, effort_min: 2.5 })).rejects.toThrow(/whole number/);
  });

  it("get_project returns what the owner asked JARVIS to remember about it, and marks it used", async () => {
    await t.sql`truncate jarvis.memories restart identity`;
    const p = await call("create_project", { title: "Spinny case competition" });
    const saved = await saveMemory(t.sql, { kind: "fact", content: "Spinny wants a tier-2 city focus", scope: "project", subjectId: String(p.created.id), subjectLabel: "Spinny case competition" });
    await saveMemory(t.sql, { kind: "fact", content: "A global note" });
    const full = await call("get_project", { project: p.created.id });
    expect(full.memories).toEqual([{ id: saved.id, content: "Spinny wants a tier-2 city focus" }]);
    const [m] = await t.sql`select last_used_at from jarvis.memories where id = ${saved.id!}`;
    expect(m!.last_used_at).not.toBeNull();
  });

  it("create_reminder queues an inbox + push reminder through the normal notification queue", async () => {
    await t.sql`truncate jarvis.notifications restart identity cascade`;
    const reminder = jarvisTools(t.sql, () => NOW).find((x) => x.name === "create_reminder")!;
    const r = (await reminder.run({ text: "Call <Riya> & Asha", at: "2026-10-01T21:00:00+05:30" })) as Record<string, unknown>;
    expect(r).toMatchObject({ scheduled_for_iso: "2026-10-01T15:30:00.000Z" });
    const [n] = await t.sql`select dedupe_key, priority, text, scheduled_for, status, category, url from jarvis.notifications`;
    expect(n).toMatchObject({ priority: "high", text: "⏰ <b>Reminder</b>\nCall &lt;Riya&gt; &amp; Asha", status: "queued", category: "reminder", url: "/inbox" });
    expect(String(n!.dedupe_key)).toMatch(/^user\.reminder:[0-9a-f-]{36}$/);
    expect(new Date(n!.scheduled_for as string).toISOString()).toBe("2026-10-01T15:30:00.000Z");
  });

  it("runs end to end through the agent loop", async () => {
    const { model } = scripted(
      calls(toolCall("create_task", { title: "Call mom", domain: "personal", due: "2026-10-02" })),
      say("Added: Call mom, by Fri 2 Oct."),
    );
    const res = await runAgent({ model, system: "", history: [], user: [text("remind me to call mom tomorrow")], tools: workTools(t.sql, () => NOW) });
    expect(res.toolCalls).toEqual([{ name: "create_task", ok: true }]);
    const [row] = await t.sql`select title, domain, source from jarvis.tasks`;
    expect(row).toEqual({ title: "Call mom", domain: "personal", source: "chat" });
  });
});
