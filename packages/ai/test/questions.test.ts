import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import type { Tool } from "../src/agent";
import { extractMentions } from "../src/grounding";
import { chatTranscript } from "../src/history";
import { chat, systemPrompt } from "../src/jarvis";
import type { GenerateRequest, ModelProvider } from "../src/model";
import { call, calls, say, scripted } from "./scripted";
import { seedPlanningWorld, truncatePlanningWorld } from "./planning-world";

// The Phase 6 done-when: each of the ten chief-of-staff questions is routed by the prompt to a tool, the tool
// returns the fixture's rows, and an answer quoting those ids and dates passes the grounding guard and is stored.
// Plus the guard itself: one repair, then the "Not found in your data" footer.

const NOW = new Date("2026-10-01T03:30:00.000Z"); // Thu 1 Oct, 09:00 IST
let t: TestDb;
let w: Awaited<ReturnType<typeof seedPlanningWorld>>;
beforeAll(async () => {
  t = await createTestDb();
  await truncatePlanningWorld(t.sql);
  w = await seedPlanningWorld(t.sql);
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.chat_messages restart identity`;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON
type Results = Record<string, any>;

/** A model that calls the planned tools, then answers from what they returned (as a real model would quote them). */
function routed(plan: Array<[string, Record<string, unknown>?]>, answer: (r: Results) => string) {
  const requests: GenerateRequest[] = [];
  const model: ModelProvider = {
    name: "routed",
    async generate(req) {
      requests.push(structuredClone(req));
      if (requests.length === 1) return calls(...plan.map(([name, args], i) => call(name, args ?? {}, `c-${i}`)));
      const results: Results = {};
      for (const p of req.messages[req.messages.length - 1]!.parts) {
        if (p.type !== "tool_result") continue;
        if (p.error !== undefined) throw new Error(`${p.name} failed: ${p.error}`);
        results[p.name] = p.result;
      }
      return say(answer(results));
    },
  };
  return { model, requests };
}

const idTag = (id: unknown) => (typeof id === "number" ? ` (#${id})` : "");

interface Question {
  q: string;
  /** The phrase the prompt quotes on this question's routing line. */
  route: string;
  plan: Array<[string, Record<string, unknown>?]>;
  /** The routed tools return the fixture's rows. */
  check: (r: Results) => void;
  answer: (r: Results) => string;
}

const QUESTIONS: Question[] = [
  {
    q: "What should I focus on today?",
    route: "What should I focus on today?",
    plan: [["get_focus"]],
    check: (r) => expect(r.get_focus.professional.slice(0, 2).map((x: { id: number }) => x.id)).toEqual([w.spinny.id, w.recruiter.id]),
    answer: (r) => {
      const [a, b] = r.get_focus.professional;
      return `Start with **${a.title}** (task #${a.id}, due ${a.due}) — ${a.reasons.join(", ")}. Then ${b.title} (#${b.id}, ${b.due}).`;
    },
  },
  {
    q: "What am I falling behind on?",
    route: "What am I falling behind on?",
    plan: [["get_attention"]],
    check: (r) => {
      expect(r.get_attention.overdue_list.map((x: { id: number }) => x.id)).toEqual([w.recruiter.id]);
      expect(r.get_attention.goals.length).toBeGreaterThan(0);
    },
    answer: (r) => {
      const a = r.get_attention;
      return [
        ...a.overdue_list.map((o: Results) => `- Overdue: ${o.title} (#${o.id}, ${o.due})`),
        ...a.deadlines_at_risk.map((d: Results) => `- ${d.title}${idTag(d.id)} due ${d.due}, ${d.why}`),
        ...a.habits_slipping.map((h: Results) => `- ${h.name}: missed ${h.missed_in_a_row} in a row since ${h.since}`),
      ].join("\n");
    },
  },
  {
    q: "Which goals are at risk?",
    route: "Which goals are at risk?",
    plan: [["get_attention"]],
    check: (r) => expect(r.get_attention.goals.map((g: { id: number }) => g.id)).toContain(w.reading.id),
    answer: (r) => r.get_attention.goals.map((g: Results) => `- **${g.title}** (goal #${g.id}, ${g.progress.period}): ${g.why}`).join("\n"),
  },
  {
    q: "What is due this week?",
    route: "What is due this week?",
    plan: [["get_week"]],
    check: (r) => {
      const all = r.get_week.days.flatMap((d: Results) => d.deadlines);
      expect(all.map((x: { id: unknown }) => x.id)).toEqual(expect.arrayContaining([w.submitId, "A2", w.spinny.id]));
    },
    answer: (r) =>
      `${r.get_week.week.label}:\n` +
      r.get_week.days
        .flatMap((d: Results) => d.deadlines)
        .map((x: Results) => `- ${x.title}${idTag(x.id)} — ${x.due}`)
        .join("\n"),
  },
  {
    q: "What did I accomplish?",
    route: "What did I accomplish?",
    plan: [["get_accomplished"]],
    check: (r) => expect(r.get_accomplished.tasks_done.items.map((x: { id: number }) => x.id)).toEqual([w.submitted, w.doneThisWeek]),
    answer: (r) => {
      const a = r.get_accomplished;
      return `${a.tasks_done.count} tasks done (${a.range.label}):\n${a.tasks_done.items.map((x: Results) => `- ${x.title} (#${x.id}, ${x.completed})`).join("\n")}`;
    },
  },
  {
    q: "What did I promise people?",
    route: "What did I promise people?",
    plan: [["get_commitments"]],
    check: (r) => {
      expect(r.get_commitments.you_owe.map((x: { id: number }) => x.id)).toEqual([w.recruiter.id, w.callHome.id]);
      expect(r.get_commitments.waiting_on_others.map((x: { id: number }) => x.id)).toEqual([w.waiting.id]);
    },
    answer: (r) => {
      const c = r.get_commitments;
      return [
        `_${c.caveat}_`,
        ...c.you_owe.map((x: Results) => `- You owe: ${x.title} (#${x.id}, ${x.due})`),
        ...c.waiting_on_others.map((x: Results) => `- Waiting on: ${x.title} (#${x.id}, due ${x.due})`),
        ...c.people_notes.map((n: Results) => `- ${n.person}: ${n.content} (#${n.memory_id})`),
      ].join("\n");
    },
  },
  {
    q: "What should I defer?",
    route: "What should I defer?",
    plan: [["get_focus"]],
    check: (r) => expect(r.get_focus.defer_candidates.map((x: { id: number }) => x.id)).toEqual([w.tidy.id]),
    answer: (r) => r.get_focus.defer_candidates.map((d: Results) => `- ${d.title} (#${d.id}) could wait: ${d.reason}. Nothing changed.`).join("\n"),
  },
  {
    q: "What are my priorities?",
    route: "What are my priorities?",
    plan: [["get_focus"], ["list_goals"]],
    check: (r) => {
      expect(r.get_focus.professional[0].id).toBe(w.spinny.id);
      expect(r.list_goals.goals.map((g: { id: number }) => g.id)).toEqual(expect.arrayContaining([w.reading.id, w.journal.id]));
    },
    answer: (r) =>
      [
        ...r.get_focus.professional.slice(0, 3).map((x: Results) => `${x.rank}. ${x.title} (#${x.id}, ${x.due})`),
        `Goals: ${r.list_goals.goals.map((g: Results) => `${g.title} (goal #${g.id}, ${g.progress.current}/${g.progress.target} for ${g.progress.period})`).join("; ")}`,
      ].join("\n"),
  },
  {
    q: "Review my week.",
    route: "Review my week",
    plan: [["get_week"], ["get_accomplished", { period: "this_week" }], ["get_attention"]],
    check: (r) => {
      expect(r.get_week.week.from).toBe("2026-09-28");
      expect(r.get_accomplished.range.from).toBe("2026-09-28");
      expect(r.get_attention.overdue_tasks).toBe(1);
    },
    answer: (r) =>
      [
        `**${r.get_week.week.label}** — ${r.get_week.totals.deadlines} deadlines, ${r.get_week.totals.classes} classes.`,
        `Done: ${r.get_accomplished.tasks_done.items.map((x: Results) => `${x.title} (#${x.id}, ${x.completed})`).join(", ")}.`,
        `Behind: ${r.get_attention.overdue_list.map((x: Results) => `${x.title} (#${x.id}, ${x.due})`).join(", ")}.`,
      ].join("\n"),
  },
  {
    q: "Review my month.",
    route: "Review my month",
    plan: [["get_accomplished", { period: "this_month" }], ["get_attention"], ["list_goals"]],
    check: (r) => {
      expect(r.get_accomplished.range).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
      expect(r.list_goals.goals.length).toBe(3);
    },
    answer: (r) =>
      [
        `${r.get_accomplished.range.label}: ${r.get_accomplished.tasks_done.count} tasks done so far.`,
        ...r.list_goals.goals.map((g: Results) => `- ${g.title} (goal #${g.id}): ${g.progress.current} of ${g.progress.target}, ${g.progress.days_left} days left in the period`),
        ...r.get_attention.goals.map((g: Results) => `- Watch ${g.title} (#${g.id}): ${g.why}`),
      ].join("\n"),
  },
];

describe("the ten chief-of-staff questions", () => {
  const prompt = systemPrompt(NOW);

  it("covers every question", () => {
    expect(QUESTIONS).toHaveLength(10);
  });

  for (const Q of QUESTIONS) {
    it(`"${Q.q}" → ${Q.plan.map(([n]) => n).join(" + ")}`, async () => {
      // The prompt routes it: one line quotes the question and names every tool.
      const line = prompt.split("\n").find((l) => l.includes(`"${Q.route}`));
      expect(line, `routing line for "${Q.q}"`).toBeDefined();
      for (const [name] of Q.plan) expect(line).toContain(name);

      let seen: Results = {};
      const { model, requests } = routed(Q.plan, (r) => {
        seen = r;
        return Q.answer(r);
      });
      const res = await chat({ sql: t.sql, model, channel: "web", now: () => NOW }, Q.q);

      Q.check(seen);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.tools.map((x) => x.name)).toEqual(expect.arrayContaining(Q.plan.map(([n]) => n)));
      // The answer really does state ids and days (so the guard had something to check), and they all pass.
      const mentions = extractMentions(res.text, NOW);
      expect(mentions.some((m) => m.kind === "id")).toBe(true);
      if (!Q.q.includes("defer")) expect(mentions.some((m) => m.kind === "day")).toBe(true);
      expect(res.guard).toEqual({ ok: true, repaired: false, unverified: [] });
      expect(res.text).not.toMatch(/Not found in your data/);
      expect(res.sources).toEqual([...new Set(Q.plan.map(([n]) => n))]);
      if (Q.q.includes("promise")) expect(res.text).toContain("no people tracker yet");

      const { items } = await chatTranscript(t.sql, "web");
      expect(items.map((i) => [i.role, i.text])).toEqual([
        ["user", Q.q],
        ["jarvis", res.text],
      ]);
      expect(items[1]).toMatchObject({ tools: [...new Set(Q.plan.map(([n]) => n))], guarded: false });
    });
  }
});

describe("the grounding guard", () => {
  const focus: Tool = {
    name: "get_focus",
    description: "d",
    parameters: { type: "object" },
    effect: "read",
    run: async () => ({ today: "2026-10-01", professional: [{ rank: 1, id: 12, title: "Spinny deck", due: "today 6:00 pm", due_iso: "2026-10-01T12:30:00.000Z" }] }),
  };
  const deps = (model: ModelProvider) => ({ sql: t.sql, model, channel: "web" as const, now: () => NOW, tools: [focus] });
  const rows = async () => (await t.sql`select role, parts, meta from jarvis.chat_messages order by id`).map((r) => ({ role: String(r.role), text: JSON.stringify(r.parts), meta: r.meta }));

  it("sends one correction for an unbacked date and stores only the repaired answer", async () => {
    const { model, requests } = scripted(
      calls(call("get_focus", {}, "c-1")),
      say("Finish the Spinny deck (task #12) by 5 Oct."),
      say("Finish the Spinny deck (task #12) today by 6:00 pm."),
    );
    const res = await chat(deps(model), "what should I focus on today?");
    expect(res.text).toBe("Finish the Spinny deck (task #12) today by 6:00 pm.");
    expect(res.guard).toEqual({ ok: true, repaired: true, unverified: [] });
    expect(res.sources).toEqual(["get_focus"]);

    // The correction continues the same exchange without the rejected draft.
    const fix = requests[2]!.messages;
    expect(fix.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(JSON.stringify(fix[3]!.parts)).toContain("10-05");
    expect(JSON.stringify(fix)).not.toContain("by 5 Oct");

    const stored = await rows();
    expect(stored.map((r) => r.role)).toEqual(["user", "model", "tool", "model"]);
    expect(stored.some((r) => r.text.includes("5 Oct") || r.text.includes("Your draft mentions"))).toBe(false);
    expect(stored[3]!.meta).toEqual({ guard: { repaired: true, unverified: [] } });
    expect((await chatTranscript(t.sql, "web")).items[1]).toMatchObject({ role: "jarvis", text: res.text, guarded: true, tools: ["get_focus"] });
  });

  it("adds the footer when the second answer is still wrong", async () => {
    const { model } = scripted(calls(call("get_focus", {}, "c-1")), say("Due 5 Oct."), say("Still due 5 Oct."));
    const res = await chat(deps(model), "when is the deck due?");
    expect(res.text).toBe("Still due 5 Oct.\n\n_Not found in your data: 10-05._");
    expect(res.guard).toEqual({ ok: false, repaired: false, unverified: ["10-05"] });
    const stored = await rows();
    expect(stored.map((r) => r.role)).toEqual(["user", "model", "tool", "model"]);
    expect(stored[3]!.meta).toEqual({ guard: { repaired: false, unverified: ["10-05"] } });
    expect((await chatTranscript(t.sql, "web")).items[1]!.text).toBe(res.text);
  });

  it("checks ids too, and keeps the first draft (with the footer) when the correction call fails", async () => {
    const { model } = scripted(calls(call("get_focus", {}, "c-1")), say("Start with task #44."));
    const res = await chat(deps(model), "what first?");
    expect(res.text).toBe("Start with task #44.\n\n_Not found in your data: #44._");
    expect(res.guard).toEqual({ ok: false, repaired: false, unverified: ["#44"] });
    expect((await rows()).map((r) => r.role)).toEqual(["user", "model", "tool", "model"]);
  });

  it("passes a reply with no tools that mentions only today, and stores no guard meta", async () => {
    const { model, requests } = scripted(say("Nothing else is due today."));
    const res = await chat(deps(model), "anything else today?");
    expect(res.guard).toEqual({ ok: true, repaired: false, unverified: [] });
    expect(res.sources).toEqual([]);
    expect(requests).toHaveLength(1);
    expect((await rows()).map((r) => r.meta)).toEqual([null, null]);
  });

  it("accepts dates the owner wrote and ids of loaded memories", async () => {
    await t.sql`insert into jarvis.memories (kind, content) values ('preference', 'Prefers short answers')`;
    const [m] = await t.sql`select id from jarvis.memories where content = 'Prefers short answers'`;
    const { model } = scripted(say(`Noted for 9 Oct — and I keep answers short (#${m!.id}).`));
    const res = await chat(deps(model), "my interview moved to 9 Oct");
    expect(res.guard.ok).toBe(true);
    await t.sql`delete from jarvis.memories where id = ${m!.id}`;
  });
});

describe("memory in the chat prompt", () => {
  it("stays under ~2k tokens with 200 long memories", async () => {
    const lorem = "lorem ipsum dolor sit amet ".repeat(20);
    for (let i = 0; i < 200; i++) {
      await t.sql`insert into jarvis.memories (kind, content) values (${i % 3 ? "fact" : "preference"}, ${`${i} ${lorem}`.slice(0, 400)})`;
    }
    try {
      const { model, requests } = scripted(say("Hello."));
      await chat({ sql: t.sql, model, channel: "web", now: () => NOW, tools: [] }, "my MESA assignment and the Side project");
      const added = requests[0]!.system.length - systemPrompt(NOW).length;
      expect(added).toBeGreaterThan(1000);
      expect(added).toBeLessThanOrEqual(8000);
      expect(Math.ceil(added / 4)).toBeLessThan(2000);
      expect(requests[0]!.system).toMatch(/\(\+\d+ more — use search_memory\)$/);
    } finally {
      await t.sql`delete from jarvis.memories where content like '%lorem ipsum%'`;
    }
  });
});
