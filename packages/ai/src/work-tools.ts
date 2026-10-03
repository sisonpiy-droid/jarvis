import * as db from "@jarvis/db";
import type { Sql, Task, Project } from "@jarvis/db";
import type { Tool } from "./agent";
import { memoriesFor } from "./memory";

// Tasks and projects for the chat. Writes are local (your own lists) and validated by @jarvis/db; every
// reply echoes exactly what was stored so the model can confirm it back to you.

const IST = "Asia/Kolkata";
const fmt = (iso: string | null, dateOnly = false) =>
  !iso
    ? null
    : new Intl.DateTimeFormat("en-IN", dateOnly ? { timeZone: IST, weekday: "short", day: "numeric", month: "short" } : { timeZone: IST, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const task = (x: Task, now: Date) => ({
  id: x.id,
  title: x.title,
  status: x.status,
  due: fmt(x.dueAt, x.dueIsDateOnly),
  overdue: !!x.dueAt && Date.parse(x.dueAt) < now.getTime() && (x.status === "todo" || x.status === "doing"),
  priority: x.priority,
  effort_min: x.effortMin ?? undefined,
  project: x.projectTitle,
  project_id: x.projectId,
  next_action: x.isNextAction || undefined,
  from_mesa: x.source === "mesa" || undefined,
  notes: x.notes ?? undefined,
});

const project = (p: Project) => ({
  id: p.id,
  title: p.title,
  kind: p.kind,
  status: p.status,
  domain: p.domain,
  area: p.area,
  deadline: fmt(p.deadline),
  open_tasks: p.openTasks,
  done_tasks: p.doneTasks,
  from_mesa: p.source === "mesa" || undefined,
});

const DUE_HELP = "YYYY-MM-DD for 'by the end of that day' (IST), or a full ISO time with +05:30 for an exact time. Empty string clears it.";
const EFFORT_MAX = 600;

/** effort_min from the model: a whole number of minutes, 1–600; 0 (update only) clears it. */
function effortOf(v: unknown, allowClear: boolean): number | null {
  const n = Number(v);
  if (allowClear && n === 0) return null;
  if (!Number.isInteger(n) || n < 1 || n > EFFORT_MAX) throw new db.WorkInputError(`effort_min must be a whole number of minutes from 1 to ${EFFORT_MAX}`);
  return n;
}

/** Finds a project by id or title words; errors name the candidates so the model can ask. */
export async function resolveProject(sql: Sql, v: unknown): Promise<number | null> {
  if (v === undefined || v === null || v === "") return null;
  const id = int(v);
  if (id) return id;
  const found = await db.listProjects(sql, { status: "all", search: String(v) });
  const open = found.filter((p) => p.status === "active" || p.status === "on_hold");
  const pick = open.length ? open : found;
  if (pick.length === 1) return pick[0]!.id;
  if (!pick.length) throw new db.WorkInputError(`no project matches "${String(v)}"`);
  throw new db.WorkInputError(`several projects match: ${pick.slice(0, 6).map((p) => `${p.id} "${p.title}"`).join(", ")} — ask which one`);
}

export function workTools(sql: Sql, now: () => Date = () => new Date()): Tool[] {
  return [
    {
      name: "list_tasks",
      effect: "read",
      description:
        "The user's tasks (personal and professional, including MESA submissions and exam prep). view: today (overdue + due today + in progress), upcoming, waiting (waiting on someone), done (recently completed), open (all not done).",
      parameters: obj({
        view: { type: "string", enum: ["today", "upcoming", "waiting", "done", "open"] },
        project: { type: "string", description: "Optional project id or title words" },
        domain: { type: "string", enum: ["personal", "professional"] },
        search: { type: "string", description: "Optional words in the title or notes" },
      }),
      async run(a) {
        const projectId = await resolveProject(sql, a.project);
        const view = (["today", "upcoming", "waiting", "done", "open"] as const).find((v) => v === a.view) ?? "open";
        const rows = await db.listTasks(sql, { view, ...(projectId ? { projectId } : {}), ...(a.domain === "personal" || a.domain === "professional" ? { domain: a.domain } : {}), ...(str(a.search) ? { search: str(a.search) } : {}), limit: 60 }, now());
        return { view, count: rows.length, tasks: rows.map((x) => task(x, now())) };
      },
    },
    {
      name: "create_task",
      effect: "write-local",
      description:
        "Add a task to the user's list. Title must be a concrete action (verb + object, e.g. 'Email Prof. Menon about the viva slot'). Confirm back exactly what was stored (title, due, project).",
      parameters: obj(
        {
          title: { type: "string" },
          due: { type: "string", description: DUE_HELP },
          project: { type: "string", description: "Optional project id or title words" },
          domain: { type: "string", enum: ["personal", "professional"], description: "Default professional; personal for life admin, health, family, hobbies" },
          priority: { type: "integer", description: "1 (highest) to 4; default 2" },
          status: { type: "string", enum: ["todo", "doing", "waiting"], description: "waiting = waiting on someone else" },
          notes: { type: "string" },
          next_action: { type: "boolean", description: "Mark as the project's next action" },
          effort_min: { type: "integer", description: "Optional estimate in minutes (1–600), only when the owner gives one" },
        },
        ["title"],
      ),
      async run(a) {
        const projectId = await resolveProject(sql, a.project);
        const created = await db.createTask(sql, {
          title: str(a.title),
          due: str(a.due) || null,
          ...(a.effort_min != null && a.effort_min !== "" ? { effortMin: effortOf(a.effort_min, false) } : {}),
          projectId,
          ...(a.domain === "personal" || a.domain === "professional" ? { domain: a.domain } : {}),
          ...(a.priority != null ? { priority: Number(a.priority) } : {}),
          ...(typeof a.status === "string" && a.status ? { status: a.status as db.TaskStatus } : {}),
          notes: str(a.notes) || null,
          isNextAction: a.next_action === true,
          source: "chat",
        });
        return { created: task(created, now()) };
      },
    },
    {
      name: "update_task",
      effect: "write-local",
      description:
        "Change a task: complete it (status done), start it (doing), park it (waiting), cancel it, reschedule (due), rename, re-prioritise or move it to a project. Find the id with list_tasks first.",
      parameters: obj(
        {
          id: { type: "integer" },
          status: { type: "string", enum: ["todo", "doing", "waiting", "done", "cancelled"] },
          due: { type: "string", description: DUE_HELP },
          title: { type: "string" },
          priority: { type: "integer" },
          project: { type: "string", description: "Project id or title words; empty string removes it from its project" },
          goal: { type: "integer", description: "Goal id it counts toward (see list_goals); 0 unlinks" },
          notes: { type: "string" },
          next_action: { type: "boolean" },
          effort_min: { type: "integer", description: "Estimate in minutes (1–600); 0 clears it" },
        },
        ["id"],
      ),
      async run(a) {
        const id = int(a.id);
        if (!id) throw new db.WorkInputError("id is required");
        const patch: db.TaskPatch = {};
        if (typeof a.status === "string") patch.status = a.status as db.TaskStatus;
        if (typeof a.due === "string") patch.due = str(a.due) || null;
        if (typeof a.title === "string") patch.title = a.title;
        if (a.priority != null) patch.priority = Number(a.priority);
        if (typeof a.notes === "string") patch.notes = a.notes;
        if (typeof a.next_action === "boolean") patch.isNextAction = a.next_action;
        if (a.effort_min != null && a.effort_min !== "") patch.effortMin = effortOf(a.effort_min, true);
        if (typeof a.project === "string") patch.projectId = str(a.project) ? await resolveProject(sql, a.project) : null;
        if (a.goal !== undefined) patch.goalId = int(a.goal);
        const updated = await db.updateTask(sql, id, patch);
        if (!updated) return { updated: false, reason: `task ${id} not found` };
        return { updated: task(updated, now()) };
      },
    },
    {
      name: "list_projects",
      effect: "read",
      description: "The user's projects (MESA assignments and exams are created automatically; others are the user's own), with deadlines and open/done task counts.",
      parameters: obj({
        status: { type: "string", enum: ["open", "closed", "all"], description: "Default open" },
        domain: { type: "string", enum: ["personal", "professional"] },
        search: { type: "string" },
      }),
      async run(a) {
        const status = (["open", "closed", "all"] as const).find((v) => v === a.status) ?? "open";
        const rows = await db.listProjects(sql, { status, ...(a.domain === "personal" || a.domain === "professional" ? { domain: a.domain } : {}), ...(str(a.search) ? { search: str(a.search) } : {}) });
        return { count: rows.length, projects: rows.slice(0, 60).map(project) };
      },
    },
    {
      name: "get_project",
      effect: "read",
      description:
        "One project in full: objective, deadline, next action, open and recently done tasks, its decisions, questions, blockers, notes and documents, and what the owner asked you to remember about it.",
      parameters: obj({ project: { type: "string", description: "Project id or title words" } }, ["project"]),
      async run(a) {
        const id = await resolveProject(sql, a.project);
        const p = id ? await db.getProject(sql, id) : null;
        if (!p) return { found: false };
        const [open, done, items, next, memories] = await Promise.all([
          db.listTasks(sql, { projectId: p.id, view: "open" }, now()),
          db.listTasks(sql, { projectId: p.id, view: "done", limit: 10 }, now()),
          db.projectItems(sql, p.id),
          db.nextAction(sql, p.id),
          memoriesFor(sql, "project", String(p.id)),
        ]);
        return {
          ...project(p),
          objective: p.objective,
          next_action: next ? task(next, now()) : null,
          open_tasks: open.map((x) => task(x, now())),
          recently_done: done.map((x) => ({ id: x.id, title: x.title })),
          items: items.map((i) => ({ id: i.id, kind: i.kind, body: i.body, ref: i.ref, resolved: !!i.resolvedAt })),
          memories: memories.map((m) => ({ id: m.id, content: m.content })),
        };
      },
    },
    {
      name: "create_project",
      effect: "write-local",
      description:
        "Create a project for multi-step work (a case competition, a job search, a side project). Not for MESA assignments or exams — those exist automatically. Add its first tasks with create_task.",
      parameters: obj(
        {
          title: { type: "string" },
          objective: { type: "string", description: "What done looks like, in one or two sentences" },
          kind: { type: "string", enum: ["case_comp", "startup", "job_search", "product", "research", "personal", "other"] },
          domain: { type: "string", enum: ["personal", "professional"] },
          area: { type: "string", description: "Short label, e.g. career, fitness, startup, muse" },
          deadline: { type: "string", description: DUE_HELP },
          priority: { type: "integer", description: "1 (highest) to 4" },
        },
        ["title"],
      ),
      async run(a) {
        const p = await db.createProject(sql, {
          title: str(a.title),
          objective: str(a.objective) || null,
          ...(typeof a.kind === "string" && a.kind ? { kind: a.kind as db.ProjectKind } : {}),
          ...(a.domain === "personal" || a.domain === "professional" ? { domain: a.domain } : {}),
          area: str(a.area) || null,
          deadline: str(a.deadline) || null,
          ...(a.priority != null ? { priority: Number(a.priority) } : {}),
          source: "chat",
        });
        return { created: project(p) };
      },
    },
    {
      name: "update_project",
      effect: "write-local",
      description: "Change a project's status (active, on_hold, done, cancelled), deadline, title, objective or priority.",
      parameters: obj(
        {
          project: { type: "string", description: "Project id or title words" },
          status: { type: "string", enum: ["active", "on_hold", "done", "cancelled"] },
          deadline: { type: "string", description: DUE_HELP },
          title: { type: "string" },
          objective: { type: "string" },
          priority: { type: "integer" },
        },
        ["project"],
      ),
      async run(a) {
        const id = await resolveProject(sql, a.project);
        if (!id) throw new db.WorkInputError("project is required");
        const patch: db.ProjectPatch = {};
        if (typeof a.status === "string") patch.status = a.status as db.ProjectStatus;
        if (typeof a.deadline === "string") patch.deadline = str(a.deadline) || null;
        if (typeof a.title === "string") patch.title = a.title;
        if (typeof a.objective === "string") patch.objective = a.objective;
        if (a.priority != null) patch.priority = Number(a.priority);
        const p = await db.updateProject(sql, id, patch);
        return p ? { updated: project(p) } : { updated: false, reason: `project ${id} not found` };
      },
    },
    {
      name: "add_project_item",
      effect: "write-local",
      description: "Record something on a project: a decision made, an open question, a blocker, a note, a document link, or a person involved.",
      parameters: obj(
        {
          project: { type: "string", description: "Project id or title words" },
          kind: { type: "string", enum: ["decision", "question", "blocker", "note", "document", "person"] },
          body: { type: "string" },
          ref: { type: "string", description: "Optional URL or link for a document" },
        },
        ["project", "kind", "body"],
      ),
      async run(a) {
        const id = await resolveProject(sql, a.project);
        if (!id) throw new db.WorkInputError("project is required");
        const item = await db.addProjectItem(sql, id, { kind: a.kind as db.ProjectItemKind, body: str(a.body), ref: str(a.ref) || null });
        return { added: { id: item.id, kind: item.kind, body: item.body, project_id: id } };
      },
    },
  ];
}
