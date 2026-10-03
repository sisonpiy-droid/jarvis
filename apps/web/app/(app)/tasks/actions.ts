"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveOldMemory } from "@jarvis/ai";
import * as w from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { deferredDue, parseEffort } from "@/lib/command";
import { sql } from "@/lib/passkey";

// Form actions for tasks and projects. Validation lives in @jarvis/db; a rejected input comes back to the
// page as ?error=… so forms work without client JavaScript.

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const n = (f: FormData, k: string) => {
  const v = Number(s(f, k));
  return Number.isInteger(v) && v > 0 ? v : null;
};

/** Only same-site paths are allowed as the place to return to. */
const backTo = (f: FormData, fallback: string) => {
  const b = s(f, "back");
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
};

/** Date + optional time inputs → the due value @jarvis/db understands (IST). */
function dueFrom(f: FormData, prefix = "due"): string | null {
  const date = s(f, `${prefix}_date`);
  const time = s(f, `${prefix}_time`);
  if (!date) return null;
  return time ? `${date}T${time}:00+05:30` : date;
}

function refresh() {
  revalidatePath("/tasks");
  revalidatePath("/projects", "layout");
  revalidatePath("/");
}

async function guarded(f: FormData, fallback: string, fn: () => Promise<string | void>): Promise<never> {
  if (!(await isSignedIn())) redirect("/login");
  const back = backTo(f, fallback);
  let to: string;
  try {
    to = (await fn()) ?? back;
  } catch (err) {
    if (err instanceof w.WorkInputError) {
      const u = new URL(back, "http://x");
      u.searchParams.set("error", err.message);
      redirect(`${u.pathname}${u.search}`);
    }
    throw err;
  }
  refresh();
  redirect(to);
}

export async function addTask(f: FormData) {
  await guarded(f, "/tasks", async () => {
    const domain = s(f, "domain");
    const effort = parseEffort(f.get("effort_min"));
    await w.createTask(sql(), {
      title: s(f, "title"),
      due: dueFrom(f),
      projectId: n(f, "project_id"),
      ...(effort != null ? { effortMin: effort } : {}),
      ...(n(f, "priority") ? { priority: n(f, "priority")! } : {}),
      ...(domain === "personal" || domain === "professional" ? { domain } : {}),
      ...(s(f, "status") === "waiting" ? { status: "waiting" as const } : {}),
    });
  });
}

export async function setTaskStatus(f: FormData) {
  await guarded(f, "/tasks", async () => {
    const id = n(f, "id");
    if (id) await w.updateTask(sql(), id, { status: s(f, "status") as w.TaskStatus });
  });
}

export async function editTask(f: FormData) {
  await guarded(f, "/tasks", async () => {
    const id = n(f, "id");
    if (!id) return;
    await w.updateTask(sql(), id, {
      title: s(f, "title"),
      notes: s(f, "notes") || null,
      priority: n(f, "priority") ?? 2,
      status: s(f, "status") as w.TaskStatus,
      due: dueFrom(f),
      projectId: n(f, "project_id"),
      isNextAction: f.get("next_action") === "on",
      // Forms without the field (older cached pages) leave the effort as it is; an emptied field clears it.
      ...(f.has("effort_min") ? { effortMin: parseEffort(f.get("effort_min")) } : {}),
    });
  });
}

/** "Move to tomorrow" from Today's ⋯ menu. MESA deadlines are refused (they follow the LMS). */
export async function deferTask(f: FormData) {
  await guarded(f, "/", async () => {
    const id = n(f, "id");
    const t = id ? await w.getTask(sql(), id) : null;
    if (t) await w.updateTask(sql(), t.id, { due: deferredDue(t, new Date()) });
  });
}

export async function removeTask(f: FormData) {
  await guarded(f, "/tasks", async () => {
    const id = n(f, "id");
    if (id) await w.deleteTask(sql(), id);
  });
}

export async function addProject(f: FormData) {
  await guarded(f, "/projects", async () => {
    const domain = s(f, "domain");
    const p = await w.createProject(sql(), {
      title: s(f, "title"),
      objective: s(f, "objective") || null,
      kind: (s(f, "kind") || "other") as w.ProjectKind,
      area: s(f, "area") || null,
      deadline: dueFrom(f, "deadline"),
      ...(domain === "personal" || domain === "professional" ? { domain } : {}),
    });
    // Made from an old project note on /settings/memory: that note is now converted (a no-op if already reviewed).
    const fromMemory = n(f, "from_memory");
    if (fromMemory) {
      await resolveOldMemory(sql(), fromMemory, `project:${p.id}`);
      revalidatePath("/settings/memory");
    }
    return `/projects/${p.id}`;
  });
}

export async function editProject(f: FormData) {
  await guarded(f, "/projects", async () => {
    const id = n(f, "id");
    if (!id) return;
    const patch: w.ProjectPatch = { status: s(f, "status") as w.ProjectStatus, priority: n(f, "priority") ?? 2 };
    // MESA keeps the title and deadline of its own projects in step with the LMS.
    if (f.has("title")) {
      patch.title = s(f, "title");
      patch.deadline = dueFrom(f, "deadline");
    }
    if (f.has("objective")) patch.objective = s(f, "objective") || null;
    if (f.has("area")) patch.area = s(f, "area") || null;
    await w.updateProject(sql(), id, patch);
  });
}

export async function addItem(f: FormData) {
  await guarded(f, "/projects", async () => {
    const id = n(f, "project_id");
    if (id) await w.addProjectItem(sql(), id, { kind: s(f, "kind") as w.ProjectItemKind, body: s(f, "body"), ref: s(f, "ref") || null });
  });
}

export async function toggleItem(f: FormData) {
  await guarded(f, "/projects", async () => {
    const id = n(f, "id");
    if (id) await w.setProjectItemResolved(sql(), id, s(f, "resolved") === "1");
  });
}

export async function removeItem(f: FormData) {
  await guarded(f, "/projects", async () => {
    const id = n(f, "id");
    if (id) await w.deleteProjectItem(sql(), id);
  });
}
