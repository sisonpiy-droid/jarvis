"use server";

import { revalidatePath } from "next/cache";
import * as w from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

// "Add as task" from the share page: the shared text, link and file links go into the task's notes.
export async function addSharedTask(input: { title: string; notes: string }): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  if (!(await isSignedIn())) return { ok: false, error: "Not signed in" };
  try {
    const t = await w.createTask(sql(), { title: input.title, notes: input.notes || null, domain: "personal" });
    revalidatePath("/tasks");
    revalidatePath("/");
    return { ok: true, id: t.id };
  } catch (err) {
    if (err instanceof w.WorkInputError) return { ok: false, error: err.message };
    throw err;
  }
}
