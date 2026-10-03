"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveOldMemory } from "@jarvis/ai";
import * as g from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

// Form actions for goals, habits and check-ins. Validation lives in @jarvis/db; a rejected input comes back
// to the page as ?error=… so forms work without client JavaScript.

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const n = (f: FormData, k: string) => {
  const v = Number(s(f, k));
  return Number.isInteger(v) && v > 0 ? v : null;
};
const num = (f: FormData, k: string) => (s(f, k) === "" ? null : Number(s(f, k)));
const backTo = (f: FormData, fallback: string) => {
  const b = s(f, "back");
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
};

function refresh() {
  revalidatePath("/goals", "layout");
  revalidatePath("/");
}

async function guarded(f: FormData, fallback: string, fn: () => Promise<string | void>): Promise<never> {
  if (!(await isSignedIn())) redirect("/login");
  const back = backTo(f, fallback);
  let to: string;
  try {
    to = (await fn()) ?? back;
  } catch (err) {
    if (err instanceof g.WorkInputError) {
      const u = new URL(back, "http://x");
      u.searchParams.set("error", err.message);
      redirect(`${u.pathname}${u.search}`);
    }
    throw err;
  }
  refresh();
  redirect(to);
}

/** Schedule from the habit form: kind = daily | days | weekly | monthly. */
function scheduleFrom(f: FormData): unknown {
  switch (s(f, "freq")) {
    case "days":
      return { freq: "weekly", days: f.getAll("days").map(Number) };
    case "weekly":
      return { freq: "weekly", times: Number(s(f, "times")) };
    case "monthly":
      return { freq: "monthly", times: Number(s(f, "times")) };
    default:
      return { freq: "daily" };
  }
}

export async function addGoal(f: FormData) {
  await guarded(f, "/goals", async () => {
    const domain = s(f, "domain");
    const goal = await g.createGoal(sql(), {
      title: s(f, "title"),
      description: s(f, "description") || null,
      metric: (s(f, "metric") || "count") as g.Metric,
      targetValue: num(f, "target"),
      unit: s(f, "unit") || null,
      period: (s(f, "period") || "week") as g.Period,
      targetDate: s(f, "target_date") || null,
      area: s(f, "area") || null,
      ...(domain === "personal" || domain === "professional" ? { domain } : {}),
    });
    // Made from an old goal note on /settings/memory: that note is now converted (a no-op if already reviewed).
    // Recorded as soon as the goal exists, so a rejected habit below can't leave the note open for a duplicate.
    const fromMemory = n(f, "from_memory");
    if (fromMemory) {
      await resolveOldMemory(sql(), fromMemory, `goal:${goal.id}`);
      revalidatePath("/settings/memory");
    }
    // Optional habit that feeds it, created in the same step ("work out 4× a week" → habit "Work out").
    if (s(f, "habit_name")) {
      await g.createHabit(sql(), { name: s(f, "habit_name"), goalId: goal.id, schedule: scheduleFrom(f), reminderTime: s(f, "reminder") || null });
    }
    return `/goals/${goal.id}`;
  });
}

export async function editGoal(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "id");
    if (!id) return;
    const patch: g.GoalPatch = {};
    if (f.has("title")) patch.title = s(f, "title");
    if (f.has("description")) patch.description = s(f, "description") || null;
    if (f.has("target")) patch.targetValue = num(f, "target");
    if (f.has("unit")) patch.unit = s(f, "unit") || null;
    if (f.has("period")) patch.period = s(f, "period") as g.Period;
    if (f.has("target_date")) patch.targetDate = s(f, "target_date") || null;
    if (f.has("status")) patch.status = s(f, "status") as g.GoalStatus;
    if (f.has("priority")) patch.priority = n(f, "priority") ?? 2;
    await g.updateGoal(sql(), id, patch);
  });
}

export async function removeGoal(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "id");
    if (id) await g.deleteGoal(sql(), id);
    return "/goals";
  });
}

export async function logGoalEntry(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "goal_id");
    if (!id) return;
    await g.logGoal(sql(), id, {
      ...(num(f, "value") != null ? { value: num(f, "value")! } : {}),
      durationMin: num(f, "duration"),
      ...(s(f, "day") ? { day: s(f, "day") } : {}),
      note: s(f, "note") || null,
    });
  });
}

export async function removeActivity(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "id");
    if (id) await g.deleteActivity(sql(), id);
  });
}

export async function addHabit(f: FormData) {
  await guarded(f, "/goals", async () => {
    await g.createHabit(sql(), {
      name: s(f, "name"),
      goalId: n(f, "goal_id"),
      schedule: scheduleFrom(f),
      reminderTime: s(f, "reminder") || null,
    });
  });
}

export async function editHabit(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "id");
    if (!id) return;
    const patch: g.HabitPatch = {};
    if (f.has("name")) patch.name = s(f, "name");
    if (f.has("freq")) patch.schedule = scheduleFrom(f);
    if (f.has("reminder")) patch.reminderTime = s(f, "reminder") || null;
    if (f.has("goal_id")) patch.goalId = n(f, "goal_id");
    if (f.has("active")) patch.active = s(f, "active") === "1";
    await g.updateHabit(sql(), id, patch);
  });
}

export async function removeHabit(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "id");
    if (id) await g.deleteHabit(sql(), id);
  });
}

/** Done / Skip / Undo for a habit on a day (default today). */
export async function checkHabit(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "id");
    if (!id) return;
    const status = s(f, "status");
    const day = s(f, "day") || g.istDay(new Date());
    if (status === "undo") await g.unlogHabit(sql(), id, day);
    else await g.logHabit(sql(), id, { status: status === "skipped" ? "skipped" : "done", day, source: "ui" });
  });
}

/** An answer to a neglect / risk prompt: continue, pause, change_target (with target) or archive. Recorded. */
export async function decide(f: FormData) {
  await guarded(f, "/goals", async () => {
    const id = n(f, "id");
    if (!id) return;
    const choice = s(f, "choice") as g.GoalChoice;
    await g.decideGoal(sql(), id, choice, { reason: s(f, "reason") === "risk" ? "risk" : "neglect", ...(choice === "change_target" ? { target: num(f, "target") ?? undefined } : {}) });
  });
}
