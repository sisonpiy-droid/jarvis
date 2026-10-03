"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { forgetMemory, resolveOldMemory } from "@jarvis/ai";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

// Form actions for /settings/memory. Only the owner's own choices change anything: an old goal/project note is
// kept, forgotten, or (through the prefilled goal / project forms) converted — never automatically. A choice that
// no longer applies comes back to the page as ?error=… so forms work without client JavaScript.

const PAGE = "/settings/memory";

const id = (f: FormData) => {
  const v = Number(String(f.get("id") ?? "").trim());
  return Number.isInteger(v) && v > 0 ? v : null;
};

async function guarded(fn: () => Promise<string | void>): Promise<never> {
  if (!(await isSignedIn())) redirect("/login");
  const error = await fn();
  revalidatePath(PAGE);
  revalidatePath("/settings");
  revalidatePath("/");
  redirect(error ? `${PAGE}?error=${encodeURIComponent(error)}` : PAGE);
}

/** "Keep as note": the old goal/project note becomes ordinary context (kind 'fact'). */
export async function keepOldMemory(f: FormData) {
  await guarded(async () => {
    const m = id(f);
    if (!m || !(await resolveOldMemory(sql(), m, "kept"))) return "that note was already reviewed";
  });
}

/** "Forget": an old note is closed as forgotten; any other memory is simply switched off. */
export async function forgetMemoryAction(f: FormData) {
  await guarded(async () => {
    const m = id(f);
    if (!m) return "no such memory";
    if (await resolveOldMemory(sql(), m, "forgotten")) return;
    if (!(await forgetMemory(sql(), m))) return "that memory was already forgotten";
  });
}
