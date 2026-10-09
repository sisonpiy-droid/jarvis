import type { Sql } from "./client";
import { istDay } from "./progress";

// The LLM cost log: one row per call (task, tokens, time) and the summaries built from it. JARVIS runs on the
// Gemini free tier, so the spend shown is an estimate — what the same tokens would cost at paid list prices.

/** US dollars per million tokens (Gemini Flash list price). Update here if the model or its pricing changes. */
export const PRICE_PER_M = { input: 0.3, output: 2.5 };

export const estimateUsd = (inputTokens: number, outputTokens: number): number => (inputTokens * PRICE_PER_M.input + outputTokens * PRICE_PER_M.output) / 1_000_000;

export interface LlmUsage {
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function logLlmCall(sql: Sql, u: LlmUsage): Promise<void> {
  await sql`insert into jarvis.llm_calls (task, model, input_tokens, output_tokens) values (${u.task.slice(0, 60)}, ${u.model.slice(0, 80)}, ${Math.max(0, Math.round(u.inputTokens))}, ${Math.max(0, Math.round(u.outputTokens))})`;
}

export interface TaskCost {
  task: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface CostWindow {
  calls: number;
  tokens: number;
  usd: number;
  /** Most expensive first. */
  byTask: TaskCost[];
}

export interface CostSummary {
  today: CostWindow;
  week: CostWindow;
  all: CostWindow;
  /** The most expensive task overall (null before the first call). */
  topTask: TaskCost | null;
  since: string | null;
}

async function window(sql: Sql, from: Date | null): Promise<CostWindow> {
  const rows = await sql`
    select task, count(*)::int as calls, coalesce(sum(input_tokens), 0)::bigint as i, coalesce(sum(output_tokens), 0)::bigint as o
      from jarvis.llm_calls where ${from ? sql`at >= ${from.toISOString()}` : sql`true`} group by task`;
  const byTask: TaskCost[] = rows
    .map((r) => ({ task: String(r.task), calls: Number(r.calls), inputTokens: Number(r.i), outputTokens: Number(r.o), usd: estimateUsd(Number(r.i), Number(r.o)) }))
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls);
  return {
    calls: byTask.reduce((n, t) => n + t.calls, 0),
    tokens: byTask.reduce((n, t) => n + t.inputTokens + t.outputTokens, 0),
    usd: byTask.reduce((n, t) => n + t.usd, 0),
    byTask,
  };
}

/** Today (IST), the last 7 days and everything so far, each by task. */
export async function costSummary(sql: Sql, now: Date): Promise<CostSummary> {
  const todayStart = new Date(`${istDay(now.toISOString())}T00:00:00+05:30`);
  const [today, week, all, [first]] = await Promise.all([
    window(sql, todayStart),
    window(sql, new Date(now.getTime() - 7 * 86_400_000)),
    window(sql, null),
    sql`select min(at) as at from jarvis.llm_calls`,
  ]);
  return { today, week, all, topTask: all.byTask[0] ?? null, since: first?.at ? new Date(first.at as string).toISOString() : null };
}

export const fmtUsd = (usd: number): string => (usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`);
export const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
