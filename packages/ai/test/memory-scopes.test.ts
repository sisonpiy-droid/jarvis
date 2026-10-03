import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { createTestDb, type TestDb } from "../../db/test/harness";
import {
  countMemories,
  detectMemoryFocus,
  listLegacyMemories,
  loadMemories,
  matchMemoryFocus,
  memoriesFor,
  memoryBlock,
  memoryTools,
  resolveOldMemory,
  saveMemory,
  searchMemories,
} from "../src/memory";

// Scoped memory against the real migrations (0019): what is saved, what a conversation loads, and the one-time
// review of old goal/project notes.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.memories, jarvis.goals, jarvis.projects, jarvis.tasks, jarvis.lms_items restart identity cascade`;
});

const NOW = new Date("2026-10-01T02:35:00.000Z");
const tool = (name: string) => memoryTools(t.sql, () => NOW).find((x) => x.name === name)!;
/** A raw row, as older code (or the owner long ago) stored it. */
const insert = (content: string, o: { kind?: string; scope?: string; subject?: string | null; label?: string | null; created?: string; lastUsed?: string | null } = {}) =>
  t.sql`insert into jarvis.memories (kind, content, scope, subject_id, subject_label, created_at, last_used_at)
        values (${o.kind ?? "fact"}, ${content}, ${o.scope ?? "global"}, ${o.subject ?? null}, ${o.label ?? null}, ${o.created ?? "2026-09-01T00:00:00Z"}, ${o.lastUsed ?? null})
        returning id`.then((r) => Number(r[0]!.id));
const lastUsed = async (id: number) => (await t.sql`select last_used_at from jarvis.memories where id = ${id}`)[0]!.last_used_at as Date | null;

describe("0019 constraints", () => {
  it("rejects a global memory with a subject", async () => {
    await expect(insert("Likes tea", { subject: "x" })).rejects.toThrow(/memories_scope_subject/);
  });
  it("needs a numeric subject for a project", async () => {
    await expect(insert("Riya owns the numbers", { scope: "project", subject: "spinny" })).rejects.toThrow(/memories_scope_subject/);
    await expect(insert("Riya owns the numbers", { scope: "project" })).rejects.toThrow(/memories_scope_subject/);
    expect(await insert("Riya owns the numbers", { scope: "project", subject: "4" })).toBeGreaterThan(0);
  });
  it("gives MESA subjects a format", async () => {
    await expect(insert("Section B", { scope: "mesa", subject: "marketing" })).rejects.toThrow(/memories_scope_subject/);
    expect(await insert("Section B", { scope: "mesa" })).toBeGreaterThan(0);
    expect(await insert("Prof wants APA", { scope: "mesa", subject: "course:c1" })).toBeGreaterThan(0);
    expect(await insert("Group of four", { scope: "mesa", subject: "assignment:a1" })).toBeGreaterThan(0);
  });
  it("checks the scope and converted_to values", async () => {
    await expect(insert("x y z", { scope: "team" })).rejects.toThrow(/memories_scope/);
    await expect(t.sql`insert into jarvis.memories (kind, content, converted_to) values ('goal', 'Old one', 'goal:abc')`).rejects.toThrow(/memories_converted_to/);
  });
});

describe("saving", () => {
  it("keeps the ON CONFLICT dedupe after 0019, across scopes", async () => {
    expect(await saveMemory(t.sql, { kind: "preference", content: "Prefers short answers" })).toEqual({ saved: true, id: 1 });
    expect(await saveMemory(t.sql, { kind: "fact", content: "prefers SHORT answers", scope: "person", subjectId: "Riya" })).toEqual({ saved: false, reason: "already remembered" });
    expect((await countMemories(t.sql)).active).toBe(1);
  });
  it("refuses dated state with the create_task hint, and allows weekday routines", async () => {
    const r = await saveMemory(t.sql, { kind: "fact", content: "Spinny deck is due Friday" });
    expect(r).toEqual({ saved: false, reason: "that's dated — store it as a task or goal (create_task / create_goal), not a memory" });
    expect(await saveMemory(t.sql, { kind: "fact", content: "Goes to the gym on Mondays" })).toMatchObject({ saved: true });
  });
  it("refuses goal and project kinds and secrets", async () => {
    expect(await saveMemory(t.sql, { kind: "goal", content: "Read 12 books" })).toMatchObject({ saved: false, reason: expect.stringContaining("create_goal") });
    expect(await saveMemory(t.sql, { kind: "project", content: "Launch the app" })).toMatchObject({ saved: false, reason: expect.stringContaining("create_project") });
    expect(await saveMemory(t.sql, { kind: "fact", content: "My MESA password is hunter2" })).toMatchObject({ saved: false });
    expect((await countMemories(t.sql)).active).toBe(0);
  });
  it("save_memory resolves the project and normalises a person", async () => {
    const p = await db.createProject(t.sql, { title: "Spinny pitch" });
    expect(await tool("save_memory").run({ content: "Riya owns the financials", kind: "fact", project: "spinny" })).toMatchObject({ saved: true, scope: "project", about: "Spinny pitch" });
    expect(await tool("save_memory").run({ content: "Likes concise decks", kind: "preference", person: "  Asha   Rao " })).toMatchObject({ saved: true, scope: "person", about: "Asha Rao" });
    expect(await tool("save_memory").run({ content: "Note about nothing", kind: "fact", project: "nope" })).toMatchObject({ saved: false, reason: expect.stringContaining("no project matches") });
    const rows = await t.sql`select scope, subject_id, subject_label from jarvis.memories order by id`;
    expect(rows.map((r) => [r.scope, r.subject_id, r.subject_label])).toEqual([
      ["project", String(p.id), "Spinny pitch"],
      ["person", "asha rao", "Asha Rao"],
    ]);
  });
  it("save_memory resolves a MESA course or assignment", async () => {
    await t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title) values ('course', 'c1', 'h', '{}', 'Marketing Management')`;
    await t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title, course_id)
                values ('assignment', 'a1', 'h', ${t.sql.json({ sourceId: "a1", title: "Zostel case write-up" } as never)}, 'Zostel case write-up', 'c1')`;
    expect(await tool("save_memory").run({ content: "Prof wants APA style", kind: "fact", mesa_course_or_assignment: "marketing" })).toMatchObject({ saved: true, scope: "mesa", about: "Marketing Management" });
    expect(await tool("save_memory").run({ content: "Group of four people", kind: "fact", mesa_course_or_assignment: "zostel" })).toMatchObject({ saved: true, scope: "mesa", about: "Zostel case write-up" });
    expect((await t.sql`select subject_id from jarvis.memories order by id`).map((r) => r.subject_id)).toEqual(["course:c1", "assignment:a1"]);
  });
});

describe("loading", () => {
  async function world() {
    const spinny = await db.createProject(t.sql, { title: "Spinny presentation" });
    await insert("Prefers bullet points", { kind: "preference" });
    await insert("Lives in Gurgaon");
    await insert("Section B", { scope: "mesa" });
    await insert("Riya owns the financials", { scope: "project", subject: String(spinny.id), label: "Spinny presentation" });
    await insert("Met at the alumni dinner", { scope: "person", subject: "asha", label: "Asha" });
    await insert("Read 12 books this year", { kind: "goal" });
    return spinny;
  }
  const contents = (r: { memories: Array<{ content: string }> }) => r.memories.map((m) => m.content);

  it("always loads preferences, context and old notes; scoped notes only when the conversation touches them", async () => {
    await world();
    const plain = await loadMemories(t.sql, await detectMemoryFocus(t.sql, ["how was your day"]));
    expect(contents(plain)).toEqual(["Prefers bullet points", "Lives in Gurgaon", "Read 12 books this year"]);
    expect(plain.omitted).toBe(3);

    const mesa = await loadMemories(t.sql, await detectMemoryFocus(t.sql, ["what's in my MESA assignment"]));
    expect(contents(mesa)).toContain("Section B");
    expect(contents(mesa)).not.toContain("Riya owns the financials");

    const project = await loadMemories(t.sql, await detectMemoryFocus(t.sql, ["how is the Spinny deck going"]));
    expect(contents(project)).toContain("Riya owns the financials");
    expect(contents(project)).not.toContain("Section B");

    const person = await loadMemories(t.sql, await detectMemoryFocus(t.sql, ["Asha said hi"]));
    expect(contents(person)).toContain("Met at the alumni dinner");
    const notPerson = await loadMemories(t.sql, await detectMemoryFocus(t.sql, ["Ashanti said hi"]));
    expect(contents(notPerson)).not.toContain("Met at the alumni dinner");
  });

  it("fills in the order preferences, project, person, mesa, context, old notes", async () => {
    const spinny = await world();
    const r = await loadMemories(t.sql, { mesa: true, projectIds: [spinny.id], people: ["Asha"] });
    expect(contents(r)).toEqual(["Prefers bullet points", "Riya owns the financials", "Met at the alumni dinner", "Section B", "Lives in Gurgaon", "Read 12 books this year"]);
    expect(r.omitted).toBe(0);
  });

  it("caps personal context at 30, most recently used first", async () => {
    for (let i = 1; i <= 35; i++) await insert(`Context fact number ${i}`, { created: new Date(Date.UTC(2026, 8, i % 28 || 1, i)).toISOString() });
    const used = await insert("An old but recently used fact", { created: "2025-01-01T00:00:00Z", lastUsed: "2026-09-30T00:00:00Z" });
    const r = await loadMemories(t.sql, {}, { budgetChars: 100_000 });
    expect(r.memories).toHaveLength(30);
    expect(r.memories[0]!.id).toBe(used);
    expect(r.omitted).toBe(6);
    const recency = r.memories.map((m) => Date.parse(m.lastUsedAt ?? m.createdAt));
    expect(recency).toEqual([...recency].sort((a, b) => b - a));
  });

  it("stays within the 6,000-character budget and points at search_memory", async () => {
    for (let i = 0; i < 200; i++) {
      const kind = i % 3 === 0 ? "preference" : "fact";
      await insert(`${i} ${"lorem ipsum dolor sit amet ".repeat(20)}`.slice(0, 400), { kind });
    }
    const loaded = await loadMemories(t.sql, { mesa: true });
    const block = memoryBlock(loaded);
    expect(block.length).toBeLessThanOrEqual(6000);
    expect(Math.ceil(block.length / 4)).toBeLessThan(2000);
    expect(block).toMatch(/\(\+\d+ more — use search_memory\)$/);
    expect(loaded.omitted).toBe(200 - loaded.memories.length);
  });

  it("marks scoped loads, search hits and get_project notes as used, never the always-loaded rows", async () => {
    const spinny = await world();
    await loadMemories(t.sql, { mesa: true, projectIds: [spinny.id], people: ["asha"] });
    const rows = await t.sql`select content, last_used_at from jarvis.memories order by id`;
    expect(Object.fromEntries(rows.map((r) => [r.content, r.last_used_at != null]))).toEqual({
      "Prefers bullet points": false,
      "Lives in Gurgaon": false,
      "Section B": true,
      "Riya owns the financials": true,
      "Met at the alumni dinner": true,
      "Read 12 books this year": false,
    });

    await t.sql`update jarvis.memories set last_used_at = null`;
    const [hit] = await searchMemories(t.sql, "gurgaon");
    expect(hit!.content).toBe("Lives in Gurgaon");
    expect(await lastUsed(hit!.id)).not.toBeNull();

    const notes = await memoriesFor(t.sql, "project", String(spinny.id));
    expect(notes.map((m) => m.content)).toEqual(["Riya owns the financials"]);
    expect(await lastUsed(notes[0]!.id)).not.toBeNull();
    expect(await lastUsed(1)).toBeNull();
  });

  it("loads course and assignment notes for a matching course", async () => {
    await t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title) values ('course', 'c1', 'h', '{}', 'Marketing Management'), ('course', 'c2', 'h', '{}', 'Corporate Finance')`;
    await t.sql`insert into jarvis.lms_items (kind, source_id, content_hash, data, title, course_id) values ('assignment', 'a1', 'h', '{}', 'Zostel case', 'c1')`;
    await insert("General MESA note", { scope: "mesa" });
    await insert("Marketing prof wants APA", { scope: "mesa", subject: "course:c1", created: "2026-09-20T00:00:00Z" });
    await insert("Zostel group of four", { scope: "mesa", subject: "assignment:a1", created: "2026-09-10T00:00:00Z" });
    await insert("Finance needs Excel models", { scope: "mesa", subject: "course:c2" });
    const focus = await detectMemoryFocus(t.sql, ["what does the marketing prof expect?"]);
    expect(focus).toMatchObject({ mesa: true, courseIds: ["c1"] });
    expect(contents(await loadMemories(t.sql, focus))).toEqual(["General MESA note", "Marketing prof wants APA", "Zostel group of four"]);
  });
});

describe("search and review", () => {
  it("ranks by how many words match", async () => {
    await insert("Riya likes tea");
    await insert("Riya leads the Spinny deck and likes tea");
    await insert("Spinny is a used-car startup");
    const found = await searchMemories(t.sql, "riya spinny tea");
    expect(found.map((m) => m.content)).toEqual(["Riya leads the Spinny deck and likes tea", "Riya likes tea", "Spinny is a used-car startup"]);
    expect(await searchMemories(t.sql, "%")).toEqual([]);
    expect((await searchMemories(t.sql, "riya", { scope: "person" })).length).toBe(0);
    const out = (await tool("search_memory").run({ query: "riya" })) as { results: Array<{ id: number; saved: string }>; note: string };
    expect(out.results.map((r) => r.saved)).toEqual(["2026-09-01", "2026-09-01"]);
    expect(out.note).toBe("Memories are context, not deadlines or progress.");
  });

  it("resolveOldMemory keeps, forgets or converts an old note exactly once", async () => {
    const goal = await db.createGoal(t.sql, { title: "Read 12 books", metric: "count", targetValue: 12, period: "year" });
    const read = await insert("Read 12 books this year", { kind: "goal" });
    const launch = await insert("Launch the side project", { kind: "project" });
    const tea = await insert("Drink less coffee", { kind: "goal" });
    const plain = await insert("Lives in Gurgaon");
    expect((await listLegacyMemories(t.sql)).map((m) => m.id)).toEqual([read, launch, tea]);
    expect(await countMemories(t.sql)).toEqual({ active: 4, legacy: 3 });

    expect(await resolveOldMemory(t.sql, read, "goal:999")).toBe(false); // the goal must exist
    expect(await resolveOldMemory(t.sql, read, `goal:${goal.id}`)).toBe(true);
    expect(await resolveOldMemory(t.sql, read, "kept")).toBe(false); // already answered
    expect(await resolveOldMemory(t.sql, launch, "kept")).toBe(true);
    expect(await resolveOldMemory(t.sql, tea, "forgotten")).toBe(true);
    expect(await resolveOldMemory(t.sql, plain, "forgotten")).toBe(false); // not an old note

    const rows = await t.sql`select id, kind, active, converted_to, reviewed_at is not null as reviewed from jarvis.memories order by id`;
    expect(rows.map((r) => [Number(r.id), r.kind, r.active, r.converted_to, r.reviewed])).toEqual([
      [read, "goal", false, `goal:${goal.id}`, true],
      [launch, "fact", true, "kept", true],
      [tea, "goal", false, "forgotten", true],
      [plain, "fact", true, null, false],
    ]);
    expect(await listLegacyMemories(t.sql)).toEqual([]);
  });

  it("resolve_old_memory refuses a non-legacy row or a goal that doesn't exist", async () => {
    const plain = await insert("Lives in Gurgaon");
    const old = await insert("Read 12 books this year", { kind: "goal" });
    await expect(tool("resolve_old_memory").run({ id: plain, outcome: "forget" })).rejects.toThrow(/not an old goal\/project note/);
    await expect(tool("resolve_old_memory").run({ id: old, outcome: "made_goal", goal_id: 42 })).rejects.toThrow(/goal #42 doesn't exist/);
    await expect(tool("resolve_old_memory").run({ id: old, outcome: "made_goal" })).rejects.toThrow(/goal_id is required/);
    const g = await db.createGoal(t.sql, { title: "Read 12 books", metric: "count", targetValue: 12, period: "year" });
    expect(await tool("resolve_old_memory").run({ id: old, outcome: "made_goal", goal_id: g.id })).toEqual({ resolved: true, id: old, outcome: `goal:${g.id}` });
  });
});

describe("matchMemoryFocus (pure)", () => {
  const subjects = {
    projects: [
      { id: 4, title: "Spinny presentation" },
      { id: 5, title: "Final report" },
      { id: 6, title: "Prepare the review" },
    ],
    courses: [{ id: "c1", title: "Marketing Management" }],
    people: ["asha", "riya sharma"],
  };
  it("matches a project by a distinctive title word", () => {
    expect(matchMemoryFocus(["how is the Spinny deck going"], subjects).projectIds).toEqual([4]);
  });
  it("sets mesa on MESA words and on a course title word", () => {
    expect(matchMemoryFocus(["my MESA assignment"], subjects)).toMatchObject({ mesa: true, courseIds: [] });
    expect(matchMemoryFocus(["the marketing reading"], subjects)).toMatchObject({ mesa: true, courseIds: ["c1"] });
    expect(matchMemoryFocus(["what should I eat"], subjects).mesa).toBe(false);
  });
  it("matches a person by whole word only, by full name or first name", () => {
    expect(matchMemoryFocus(["Asha said"], subjects).people).toEqual(["asha"]);
    expect(matchMemoryFocus(["Ashanti said"], subjects).people).toEqual([]);
    expect(matchMemoryFocus(["ping Riya about it"], subjects).people).toEqual(["riya sharma"]);
  });
  it("ignores stop-list words", () => {
    expect(matchMemoryFocus(["I need to prepare a presentation and review it"], subjects).projectIds).toEqual([]);
    expect(matchMemoryFocus(["the final numbers in the report"], subjects).projectIds).toEqual([]);
  });
  it("puts the current message's subjects first", () => {
    expect(matchMemoryFocus(["the final report", "how is Spinny"], subjects).projectIds).toEqual([5, 4]);
  });
});
