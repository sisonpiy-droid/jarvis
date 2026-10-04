import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { draftWeekPlan } from "@jarvis/ai";
import { approveWeekPlan, fmtIstShort, fmtIstTime, getWeekPlan, istDay, loadSituation, saveWeekPlan } from "@jarvis/db";
import { aiModel } from "@/lib/ai";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";
import { Empty, Section } from "../ui";

// The week plan: JARVIS's draft (Sunday 19:00, or "plan my week" in chat), approved here. Untick a block to drop it.

async function approve(f: FormData) {
  "use server";
  if (!(await isSignedIn())) redirect("/login");
  await approveWeekPlan(sql(), f.getAll("keep").map(Number), new Date());
  revalidatePath("/plan");
}

async function redraft() {
  "use server";
  if (!(await isSignedIn())) redirect("/login");
  const model = aiModel(60_000);
  if (!model) redirect("/plan?error=no-ai");
  const now = new Date();
  await saveWeekPlan(sql(), await draftWeekPlan(model, await loadSituation(sql(), now), now));
  revalidatePath("/plan");
}

const end = (start: string, min: number) => new Date(Date.parse(start) + min * 60_000).toISOString();

export default async function PlanPage() {
  const plan = await getWeekPlan(sql());
  const days = new Map<string, Array<{ i: number; b: NonNullable<typeof plan>["blocks"][number] }>>();
  plan?.blocks.forEach((b, i) => days.set(istDay(b.start), [...(days.get(istDay(b.start)) ?? []), { i, b }]));
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Week plan</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {plan ? (plan.approvedAt ? "Approved — JARVIS plans around it in chat and the evening check-in." : "Draft — untick what you don't want, then approve.") : "No plan yet."}
      </p>
      {plan?.note && <p className="mt-2 text-sm">🧭 {plan.note}</p>}
      <form action={approve}>
        {plan && plan.blocks.length ? (
          [...days].map(([day, items]) => (
            <Section key={day} title={fmtIstShort(items[0]!.b.start)}>
              <ul className="space-y-2 text-sm">
                {items.map(({ i, b }) => (
                  <li key={i}>
                    <label className="flex items-start gap-3">
                      <input type="checkbox" name="keep" value={i} defaultChecked className="mt-1 h-5 w-5" />
                      <span>
                        <b className="font-medium">
                          {fmtIstTime(b.start)}–{fmtIstTime(end(b.start, b.minutes))}
                        </b>{" "}
                        {b.title}
                        {b.why && <span className="block text-xs text-[var(--color-muted)]">{b.why}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Section>
          ))
        ) : (
          <Section title="Blocks">
            <Empty>{plan ? "Nothing to plan — no open work fits the coming week." : "Make a plan to see it here."}</Empty>
          </Section>
        )}
        {plan && plan.blocks.length > 0 && (
          <button className="mt-4 min-h-11 rounded-xl bg-[var(--color-accent)] px-4 text-sm font-medium text-white">{plan.approvedAt ? "Save changes" : "Approve plan"}</button>
        )}
      </form>
      <form action={redraft} className="mt-3">
        <button className="min-h-11 rounded-xl border border-[var(--color-line)] px-4 text-sm hover:bg-[var(--color-line)]">{plan ? "Make a new plan" : "Make a plan"}</button>
      </form>
    </main>
  );
}
