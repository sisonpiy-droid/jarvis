import { blockLine, fmtIstShort, fmtIstTime, loadSituation, planInput, saveWeekPlan, validatePlan, type Situation, type Sql, type WeekPlan } from "@jarvis/db";
import type { Tool } from "./agent";
import { textOf, userText, type ModelProvider } from "./model";

// The model drafts a week plan from the live situation; validatePlan keeps only blocks that fit real free gaps
// before each task's due. One JSON call. Saved as a draft for the owner to approve on /plan.

const SYSTEM = `You plan a business-school student's week like a chief of staff. You get their live situation, the tasks to plan (with ids) and the exact free gaps per day.
Return JSON {"blocks": [{"task_id": number, "day": "YYYY-MM-DD", "start": "HH:MM", "minutes": number, "why": string}], "note": string}.
Rules: only the listed task ids; every block fully inside a listed gap; each task's blocks finish before its due time, with a buffer (aim to finish the day before when possible); 30–180 minutes per block; at most about 4 hours of blocks a day; earlier rather than later where the owner usually cuts it close; leave breathing room on crunch days by moving work earlier. "why" is one short reason. "note" is one sentence on the week's shape. Times are IST, 24-hour.`;

export async function draftWeekPlan(model: ModelProvider, s: Situation, now: Date): Promise<WeekPlan> {
  const input = planInput(s);
  const tasks = input.candidates.map((c) => `#${c.id} ${c.title}${c.project ? ` (${c.project})` : ""} — due ${c.dueAt ? `${fmtIstShort(c.dueAt)} ${fmtIstTime(c.dueAt)}` : "no date"}, P${c.priority}${c.effortMin ? `, ~${c.effortMin} min` : ""}`);
  const gaps = input.days.map((d) => `${d.day}: ${d.gaps.map((g) => `${fmtIstTime(g.from)}–${fmtIstTime(g.to)}`).join(", ") || "no free gap"}`);
  const plan: WeekPlan = { from: input.days[0]!.day, createdAt: now.toISOString(), note: null, blocks: [], approvedAt: null };
  if (!input.candidates.length) return { ...plan, note: "Nothing open to plan this week." };
  const reply = await model.generate({
    system: SYSTEM,
    messages: [userText(`${s.text}\n\nTASKS TO PLAN:\n${tasks.join("\n")}\n\nFREE GAPS (IST):\n${gaps.join("\n")}`)],
    tools: [],
    json: true,
    temperature: 0.2,
    task: "week_plan",
  });
  let raw: unknown;
  try {
    raw = JSON.parse(textOf(reply).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    raw = {};
  }
  const note = typeof (raw as { note?: unknown }).note === "string" ? (raw as { note: string }).note.slice(0, 300) : null;
  return { ...plan, note, blocks: validatePlan(raw, input, now) };
}

/** Chat: "plan my week" / "re-plan". Saves a fresh draft (replacing the current plan) for approval on /plan. */
export function weekPlanTool(sql: Sql, model: ModelProvider, now: () => Date): Tool {
  return {
    name: "make_week_plan",
    effect: "write-local",
    description: "Draft a plan for the next 7 days: work blocks for open tasks placed in real free gaps before each deadline. Replaces the current plan with a draft the owner approves on /plan.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      const plan = await draftWeekPlan(model, await loadSituation(sql, now()), now());
      await saveWeekPlan(sql, plan);
      return { status: "draft — approve or change on /plan", note: plan.note, blocks: plan.blocks.map((b) => blockLine(b)) };
    },
  };
}
