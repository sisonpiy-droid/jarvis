"use server";

import { revalidatePath } from "next/cache";
import { putSetting, removePushSubscription, NOTIFICATION_CATEGORIES } from "@jarvis/db";
import { LEVELS, SETTINGS_KEY, settingsSchema } from "@jarvis/notify";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export type SaveState = { status: "idle" | "saved" | "error"; message?: string };

export async function saveNotificationSettings(_prev: SaveState, form: FormData): Promise<SaveState> {
  if (!(await isSignedIn())) return { status: "error", message: "Not signed in." };
  const str = (k: string) => String(form.get(k) ?? "");
  const candidate = {
    routes: Object.fromEntries(LEVELS.map((l) => [l, { push: str(`push_${l}`), email: str(`email_${l}`) }])),
    quietHours: { enabled: form.get("quiet_enabled") === "on", start: str("quiet_start"), end: str("quiet_end") },
    daytime: { start: str("day_start"), end: str("day_end") },
    pushPerHour: Number(str("push_per_hour")),
    escalateAfterMinutes: Number(str("escalate_after")),
    mutedCategories: NOTIFICATION_CATEGORIES.filter((c) => form.get(`mute_${c}`) === "on"),
    telegram: str("telegram"),
  };
  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success) return { status: "error", message: `Not saved: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")} invalid.` };
  await putSetting(sql(), SETTINGS_KEY, parsed.data);
  revalidatePath("/settings");
  return { status: "saved" };
}

export async function removeDevice(form: FormData): Promise<void> {
  if (!(await isSignedIn())) return;
  const id = Number(form.get("id"));
  if (Number.isInteger(id)) await removePushSubscription(sql(), { id });
  revalidatePath("/settings");
}
