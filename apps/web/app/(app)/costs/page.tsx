import type { Sql } from "@jarvis/db";
import { costSummary, fmtTokens, fmtUsd, type CostWindow } from "@jarvis/db";
import { db } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { Empty, Section } from "../ui";

export const dynamic = "force-dynamic";

function ByTask({ w }: { w: CostWindow }) {
  if (!w.calls) return <Empty>No AI calls in this period.</Empty>;
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[420px] text-sm">
        <thead className="text-left text-[var(--color-muted)]">
          <tr>
            <th className="py-1.5 pl-4 font-medium sm:pl-0">Task</th>
            <th className="text-right font-medium">Calls</th>
            <th className="text-right font-medium">Tokens</th>
            <th className="pr-4 text-right font-medium sm:pr-0">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {w.byTask.map((t) => (
            <tr key={t.task} className="border-t border-[var(--color-line)]">
              <td className="py-1.5 pl-4 sm:pl-0">{t.task}</td>
              <td className="text-right tabular-nums">{t.calls}</td>
              <td className="text-right tabular-nums">{fmtTokens(t.inputTokens + t.outputTokens)}</td>
              <td className="pr-4 text-right tabular-nums sm:pr-0">{fmtUsd(t.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CostsPage() {
  const s = await costSummary(db() as unknown as Sql, new Date());
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">AI costs</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">Every call JARVIS makes to the AI is logged (task, tokens, time). Costs are estimated at paid Gemini Flash prices; you&apos;re on the free tier, so you pay nothing.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Spent today</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtUsd(s.today.usd)}</div>
          <div className="text-xs text-[var(--color-muted)]">{s.today.calls} calls · {fmtTokens(s.today.tokens)} tokens</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Last 7 days</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtUsd(s.week.usd)}</div>
          <div className="text-xs text-[var(--color-muted)]">{s.week.calls} calls · {fmtTokens(s.week.tokens)} tokens</div>
        </div>
        <div className="card col-span-2 p-4 sm:col-span-1">
          <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Most expensive task</div>
          <div className="mt-1 text-2xl font-semibold">{s.topTask ? s.topTask.task : "—"}</div>
          <div className="text-xs text-[var(--color-muted)]">{s.topTask ? `${fmtUsd(s.topTask.usd)} of ${fmtUsd(s.all.usd)} since ${s.since ? fmtDateTime(s.since) : "the start"}` : "No calls logged yet"}</div>
        </div>
      </div>
      <Section title="Today, by task">
        <ByTask w={s.today} />
      </Section>
      <Section title="Last 7 days, by task">
        <ByTask w={s.week} />
      </Section>
      <Section title="All time, by task">
        <ByTask w={s.all} />
      </Section>
    </main>
  );
}
