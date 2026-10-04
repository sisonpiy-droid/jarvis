import type { Sql } from "./client";
import { istDay } from "./progress";

// Tasks and projects (migration 0015). Plain storage and validation; the MESA rules that create work
// automatically live in @jarvis/sync (work.ts). Callers: the dashboard, chat tools and the sync.

export const TASK_STATUSES = ["todo", "doing", "waiting", "done", "cancelled"] as const;
export const OPEN_TASK_STATUSES = ["todo", "doing", "waiting"] as const;
export const PROJECT_STATUSES = ["active", "on_hold", "done", "cancelled"] as const;
export const PROJECT_KINDS = ["mesa_assignment", "exam", "case_comp", "startup", "job_search", "product", "research", "personal", "other"] as const;
export const PROJECT_ITEM_KINDS = ["decision", "question", "blocker", "note", "document", "person"] as const;
export const DOMAINS = ["personal", "professional"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export type ProjectItemKind = (typeof PROJECT_ITEM_KINDS)[number];
export type Domain = (typeof DOMAINS)[number];
export type WorkSource = "manual" | "chat" | "mesa";

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  domain: Domain;
  area: string | null;
  projectId: number | null;
  projectTitle: string | null;
  goalId: number | null;
  priority: number;
  status: TaskStatus;
  dueAt: string | null;
  dueIsDateOnly: boolean;
  effortMin: number | null;
  isNextAction: boolean;
  source: WorkSource;
  sourceRef: string | null;
  createdAt: string;
  /** Last edit (any field); the focus score uses it to spot undated tasks nobody has touched. */
  updatedAt: string;
  completedAt: string | null;
  /** Times the owner moved the due date later (MESA deadline changes don't count). */
  postponedCount: number;
  /** Commitment: the person this is owed to (todo/doing) or awaited from (waiting). */
  person: string | null;
}

export interface Project {
  id: number;
  title: string;
  objective: string | null;
  domain: Domain;
  area: string | null;
  kind: ProjectKind;
  status: ProjectStatus;
  priority: number;
  deadline: string | null;
  source: WorkSource;
  sourceRef: string | null;
  createdAt: string;
  completedAt: string | null;
  openTasks: number;
  doneTasks: number;
}

export interface ProjectItem {
  id: number;
  projectId: number;
  kind: ProjectItemKind;
  body: string;
  ref: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

type R = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

const toTask = (r: R): Task => ({
  id: Number(r.id),
  title: String(r.title),
  notes: (r.notes as string | null) ?? null,
  domain: r.domain as Domain,
  area: (r.area as string | null) ?? null,
  projectId: r.project_id == null ? null : Number(r.project_id),
  projectTitle: (r.project_title as string | null) ?? null,
  goalId: r.goal_id == null ? null : Number(r.goal_id),
  priority: Number(r.priority),
  status: r.status as TaskStatus,
  dueAt: iso(r.due_at),
  dueIsDateOnly: Boolean(r.due_is_date_only),
  effortMin: r.effort_min == null ? null : Number(r.effort_min),
  isNextAction: Boolean(r.is_next_action),
  source: r.source as WorkSource,
  sourceRef: (r.source_ref as string | null) ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at ?? r.created_at)!,
  completedAt: iso(r.completed_at),
  postponedCount: Number(r.postponed_count ?? 0),
  person: (r.person as string | null) ?? null,
});

const toProject = (r: R): Project => ({
  id: Number(r.id),
  title: String(r.title),
  objective: (r.objective as string | null) ?? null,
  domain: r.domain as Domain,
  area: (r.area as string | null) ?? null,
  kind: r.kind as ProjectKind,
  status: r.status as ProjectStatus,
  priority: Number(r.priority),
  deadline: iso(r.deadline),
  source: r.source as WorkSource,
  sourceRef: (r.source_ref as string | null) ?? null,
  createdAt: iso(r.created_at)!,
  completedAt: iso(r.completed_at),
  openTasks: Number(r.open_tasks ?? 0),
  doneTasks: Number(r.done_tasks ?? 0),
});

const toItem = (r: R): ProjectItem => ({
  id: Number(r.id),
  projectId: Number(r.project_id),
  kind: r.kind as ProjectItemKind,
  body: String(r.body),
  ref: (r.ref as string | null) ?? null,
  resolvedAt: iso(r.resolved_at),
  createdAt: iso(r.created_at)!,
});

// --- validation (shared by the dashboard and chat tools) ---

export class WorkInputError extends Error {}

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const oneOf = <T extends string>(list: readonly T[], v: unknown, field: string): T => {
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  throw new WorkInputError(`${field} must be one of: ${list.join(", ")}`);
};
const priorityOf = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new WorkInputError("priority must be 1 (highest) to 4");
  return n;
};
const timeOf = (v: unknown, field: string) => {
  if (v === null || v === "") return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw new WorkInputError(`${field} must be an ISO date/time`);
  return new Date(t).toISOString();
};

/**
 * A due value from a form or the model: "YYYY-MM-DD" means end of that day in IST (date-only);
 * anything else must be a full timestamp.
 */
export function parseDue(v: unknown): { dueAt: string | null; dateOnly: boolean } {
  if (v === undefined || v === null || v === "") return { dueAt: null, dateOnly: false };
  const s = String(v).trim();
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) {
    // 23:59 IST on that date
    const at = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 23, 59) - 330 * 60_000;
    return { dueAt: new Date(at).toISOString(), dateOnly: true };
  }
  return { dueAt: timeOf(s, "due"), dateOnly: false };
}

export interface NewTask {
  title: string;
  notes?: string | null;
  domain?: Domain;
  area?: string | null;
  projectId?: number | null;
  goalId?: number | null;
  priority?: number;
  status?: TaskStatus;
  /** ISO timestamp, or YYYY-MM-DD for "by the end of that day" (IST). */
  due?: string | null;
  effortMin?: number | null;
  isNextAction?: boolean;
  source?: WorkSource;
  person?: string | null;
}

export async function createTask(sql: Sql, input: NewTask): Promise<Task> {
  const title = clean(input.title, 300);
  if (!title) throw new WorkInputError("title is required");
  const status = input.status ? oneOf(TASK_STATUSES, input.status, "status") : "todo";
  const { dueAt, dateOnly } = parseDue(input.due);
  let domain: Domain = input.domain ? oneOf(DOMAINS, input.domain, "domain") : "professional";
  let area = clean(input.area, 40) || null;
  if (input.projectId != null) {
    const [p] = await sql`select domain, area from jarvis.projects where id = ${input.projectId}`;
    if (!p) throw new WorkInputError(`project ${input.projectId} not found`);
    if (!input.domain) domain = p.domain as Domain;
    area ??= (p.area as string | null) ?? null;
  }
  if (input.goalId != null && !(await sql`select 1 from jarvis.goals where id = ${input.goalId}`).length) throw new WorkInputError(`goal ${input.goalId} not found`);
  const [row] = await sql`
    insert into jarvis.tasks (title, notes, domain, area, project_id, goal_id, priority, status, due_at, due_is_date_only, effort_min, is_next_action, source, completed_at, person)
    values (${title}, ${cleanText(input.notes, 4000) || null}, ${domain}, ${area}, ${input.projectId ?? null}, ${input.goalId ?? null},
            ${input.priority == null ? 2 : priorityOf(input.priority)}, ${status}, ${dueAt}, ${dateOnly},
            ${input.effortMin == null ? null : Math.max(1, Math.min(10000, Math.round(Number(input.effortMin)) || 1))},
            ${input.isNextAction ?? false}, ${input.source ?? "manual"}, ${status === "done" ? new Date().toISOString() : null}, ${clean(input.person, 80) || null})
    returning id`;
  if (status === "done") await syncTaskActivity(sql, Number(row!.id));
  return (await getTask(sql, Number(row!.id)))!;
}

export async function getTask(sql: Sql, id: number): Promise<Task | null> {
  const [r] = await sql`select t.*, p.title as project_title from jarvis.tasks t left join jarvis.projects p on p.id = t.project_id where t.id = ${id}`;
  return r ? toTask(r) : null;
}

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  priority?: number;
  status?: TaskStatus;
  due?: string | null;
  projectId?: number | null;
  goalId?: number | null;
  isNextAction?: boolean;
  person?: string | null;
  effortMin?: number | null;
}

/** Applies only the fields given. Completing stamps completed_at; reopening clears it. */
export async function updateTask(sql: Sql, id: number, patch: TaskPatch): Promise<Task | null> {
  const cur = await getTask(sql, id);
  if (!cur) return null;
  const next = { ...cur };
  if (patch.title !== undefined) {
    next.title = clean(patch.title, 300);
    if (!next.title) throw new WorkInputError("title can't be empty");
  }
  if (patch.notes !== undefined) next.notes = cleanText(patch.notes, 4000) || null;
  if (patch.priority !== undefined) next.priority = priorityOf(patch.priority);
  if (patch.status !== undefined) next.status = oneOf(TASK_STATUSES, patch.status, "status");
  if (patch.due !== undefined) {
    const due = parseDue(patch.due);
    next.dueAt = due.dueAt;
    next.dueIsDateOnly = due.dateOnly;
  }
  if (patch.isNextAction !== undefined) next.isNextAction = patch.isNextAction;
  if (patch.person !== undefined) next.person = clean(patch.person, 80) || null;
  if (patch.effortMin !== undefined) next.effortMin = patch.effortMin == null ? null : Math.max(1, Math.min(10000, Math.round(Number(patch.effortMin)) || 1));
  if (patch.projectId !== undefined) {
    if (patch.projectId != null && !(await sql`select 1 from jarvis.projects where id = ${patch.projectId}`).length) throw new WorkInputError(`project ${patch.projectId} not found`);
    next.projectId = patch.projectId;
  }
  if (patch.goalId !== undefined) {
    if (patch.goalId != null && !(await sql`select 1 from jarvis.goals where id = ${patch.goalId}`).length) throw new WorkInputError(`goal ${patch.goalId} not found`);
    next.goalId = patch.goalId;
  }
  const closing = next.status === "done" || next.status === "cancelled";
  // The owner pushing their own open task later (MESA tasks follow the LMS and never count).
  const postponed = cur.source !== "mesa" && !closing && !!cur.dueAt && !!next.dueAt && Date.parse(next.dueAt) > Date.parse(cur.dueAt);
  const completedAt = next.status === "done" ? (cur.status === "done" ? cur.completedAt : new Date().toISOString()) : null;
  await sql`
    update jarvis.tasks set title = ${next.title}, notes = ${next.notes}, priority = ${next.priority}, status = ${next.status},
           due_at = ${next.dueAt}, due_is_date_only = ${next.dueIsDateOnly}, is_next_action = ${closing ? false : next.isNextAction},
           effort_min = ${next.effortMin}, project_id = ${next.projectId}, goal_id = ${next.goalId}, completed_at = ${completedAt}, updated_at = now(),
           person = ${next.person}, postponed_count = postponed_count + ${postponed ? 1 : 0}, last_postponed_at = case when ${postponed} then now() else last_postponed_at end
     where id = ${id}`;
  if (cur.status !== next.status || cur.goalId !== next.goalId) await syncTaskActivity(sql, id);
  return getTask(sql, id);
}

export async function deleteTask(sql: Sql, id: number): Promise<boolean> {
  return (await sql`delete from jarvis.tasks where id = ${id} and source <> 'mesa' returning id`).length === 1;
}

export interface TaskFilter {
  view?: "today" | "upcoming" | "waiting" | "done" | "open" | "all";
  projectId?: number;
  domain?: Domain;
  search?: string;
  limit?: number;
  /** ISO bounds, half-open [from, to): due_at and completed_at ranges (on top of the view). */
  dueFrom?: string;
  dueTo?: string;
  doneFrom?: string;
  doneTo?: string;
}

/** IST end of today. */
const endOfTodayIst = (now: Date) => {
  const off = 330 * 60_000;
  const ist = new Date(now.getTime() + off);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - off).toISOString();
};

/**
 * Task lists:
 * - today: overdue, due today, or in progress (and next actions with no date)
 * - upcoming: open, due after today or undated
 * - waiting: waiting on someone else
 * - done: completed, newest first
 */
export async function listTasks(sql: Sql, f: TaskFilter = {}, now = new Date()): Promise<Task[]> {
  const view = f.view ?? "open";
  const limit = Math.min(500, Math.max(1, f.limit ?? 200));
  const eod = endOfTodayIst(now);
  const search = f.search ? `%${f.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await sql`
    select t.*, p.title as project_title from jarvis.tasks t left join jarvis.projects p on p.id = t.project_id
     where true
       ${f.projectId != null ? sql`and t.project_id = ${f.projectId}` : sql``}
       ${f.domain ? sql`and t.domain = ${f.domain}` : sql``}
       ${search ? sql`and (t.title ilike ${search} or t.notes ilike ${search})` : sql``}
       ${f.dueFrom ? sql`and t.due_at >= ${f.dueFrom}` : sql``}
       ${f.dueTo ? sql`and t.due_at < ${f.dueTo}` : sql``}
       ${f.doneFrom ? sql`and t.completed_at >= ${f.doneFrom}` : sql``}
       ${f.doneTo ? sql`and t.completed_at < ${f.doneTo}` : sql``}
       ${
         view === "today" ? sql`and t.status in ('todo', 'doing') and (t.due_at < ${eod} or t.status = 'doing' or (t.due_at is null and t.is_next_action))` :
         view === "upcoming" ? sql`and t.status in ('todo', 'doing') and (t.due_at >= ${eod} or t.due_at is null) and t.status <> 'doing' and not (t.due_at is null and t.is_next_action)` :
         view === "waiting" ? sql`and t.status = 'waiting'` :
         view === "done" ? sql`and t.status = 'done'` :
         view === "open" ? sql`and t.status in ('todo', 'doing', 'waiting')` : sql``
       }
     order by ${
       view === "done" ? sql`t.completed_at desc nulls last` :
       sql`(t.status = 'doing') desc, t.due_at asc nulls last, t.priority, t.id`
     }
     limit ${limit}`;
  return rows.map(toTask);
}

export async function taskCounts(sql: Sql, now = new Date()): Promise<{ today: number; overdue: number; upcoming: number; waiting: number }> {
  const eod = endOfTodayIst(now);
  const [r] = await sql`
    select count(*) filter (where status in ('todo', 'doing') and (due_at < ${eod} or status = 'doing' or (due_at is null and is_next_action)))::int as today,
           count(*) filter (where status in ('todo', 'doing') and due_at < ${now.toISOString()})::int as overdue,
           count(*) filter (where status in ('todo', 'doing') and (due_at >= ${eod} or due_at is null) and status <> 'doing' and not (due_at is null and is_next_action))::int as upcoming,
           count(*) filter (where status = 'waiting')::int as waiting
      from jarvis.tasks`;
  return { today: Number(r?.today ?? 0), overdue: Number(r?.overdue ?? 0), upcoming: Number(r?.upcoming ?? 0), waiting: Number(r?.waiting ?? 0) };
}

// --- projects ---

export interface NewProject {
  title: string;
  objective?: string | null;
  domain?: Domain;
  area?: string | null;
  kind?: ProjectKind;
  priority?: number;
  deadline?: string | null;
  source?: WorkSource;
}

export async function createProject(sql: Sql, input: NewProject): Promise<Project> {
  const title = clean(input.title, 300);
  if (!title) throw new WorkInputError("title is required");
  const kind = input.kind ? oneOf(PROJECT_KINDS, input.kind, "kind") : "other";
  if (kind === "mesa_assignment" || kind === "exam") throw new WorkInputError("MESA assignment and exam projects are created automatically");
  const { dueAt } = parseDue(input.deadline);
  const [row] = await sql`
    insert into jarvis.projects (title, objective, domain, area, kind, priority, deadline, source)
    values (${title}, ${cleanText(input.objective, 4000) || null}, ${input.domain ? oneOf(DOMAINS, input.domain, "domain") : kind === "personal" ? "personal" : "professional"},
            ${clean(input.area, 40) || null}, ${kind}, ${input.priority == null ? 2 : priorityOf(input.priority)}, ${dueAt}, ${input.source ?? "manual"})
    returning id`;
  return (await getProject(sql, Number(row!.id)))!;
}

const projectSelect = (sql: Sql) => sql`
  select p.*,
         (select count(*) from jarvis.tasks t where t.project_id = p.id and t.status in ('todo', 'doing', 'waiting')) as open_tasks,
         (select count(*) from jarvis.tasks t where t.project_id = p.id and t.status = 'done') as done_tasks
    from jarvis.projects p`;

export async function getProject(sql: Sql, id: number): Promise<Project | null> {
  const [r] = await sql`${projectSelect(sql)} where p.id = ${id}`;
  return r ? toProject(r) : null;
}

export async function listProjects(sql: Sql, f: { status?: "open" | "closed" | "all"; domain?: Domain; search?: string } = {}): Promise<Project[]> {
  const status = f.status ?? "open";
  const search = f.search ? `%${f.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await sql`
    ${projectSelect(sql)}
     where true
       ${status === "open" ? sql`and p.status in ('active', 'on_hold')` : status === "closed" ? sql`and p.status in ('done', 'cancelled')` : sql``}
       ${f.domain ? sql`and p.domain = ${f.domain}` : sql``}
       ${search ? sql`and p.title ilike ${search}` : sql``}
     order by ${status === "closed" ? sql`p.completed_at desc nulls last, p.id desc` : sql`p.status = 'on_hold', p.deadline asc nulls last, p.priority, p.id`}
     limit 300`;
  return rows.map(toProject);
}

export interface ProjectPatch {
  title?: string;
  objective?: string | null;
  status?: ProjectStatus;
  priority?: number;
  deadline?: string | null;
  area?: string | null;
}

export async function updateProject(sql: Sql, id: number, patch: ProjectPatch): Promise<Project | null> {
  const cur = await getProject(sql, id);
  if (!cur) return null;
  const title = patch.title !== undefined ? clean(patch.title, 300) : cur.title;
  if (!title) throw new WorkInputError("title can't be empty");
  const status = patch.status !== undefined ? oneOf(PROJECT_STATUSES, patch.status, "status") : cur.status;
  const closed = status === "done" || status === "cancelled";
  await sql`
    update jarvis.projects set title = ${title},
           objective = ${patch.objective !== undefined ? cleanText(patch.objective, 4000) || null : cur.objective},
           status = ${status},
           priority = ${patch.priority !== undefined ? priorityOf(patch.priority) : cur.priority},
           deadline = ${patch.deadline !== undefined ? parseDue(patch.deadline).dueAt : cur.deadline},
           area = ${patch.area !== undefined ? clean(patch.area, 40) || null : cur.area},
           completed_at = ${closed ? (cur.completedAt ?? new Date().toISOString()) : null},
           updated_at = now()
     where id = ${id}`;
  return getProject(sql, id);
}

/** The project's next action: the flagged one, else the earliest-due open task. */
export async function nextAction(sql: Sql, projectId: number): Promise<Task | null> {
  const [r] = await sql`
    select t.*, null as project_title from jarvis.tasks t
     where t.project_id = ${projectId} and t.status in ('todo', 'doing')
     order by t.is_next_action desc, (t.status = 'doing') desc, t.due_at asc nulls last, t.priority, t.id limit 1`;
  return r ? toTask(r) : null;
}

/** nextAction() over tasks already loaded (same order as the SQL), so a list of projects costs no extra queries. */
export function nextActionFrom(tasks: Task[], projectId: number): Task | null {
  const open = tasks.filter((t) => t.projectId === projectId && (t.status === "todo" || t.status === "doing"));
  open.sort(
    (a, b) =>
      Number(b.isNextAction) - Number(a.isNextAction) ||
      Number(b.status === "doing") - Number(a.status === "doing") ||
      (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿") ||
      a.priority - b.priority ||
      a.id - b.id,
  );
  return open[0] ?? null;
}

export async function projectItems(sql: Sql, projectId: number): Promise<ProjectItem[]> {
  const rows = await sql`select * from jarvis.project_items where project_id = ${projectId} order by resolved_at nulls first, created_at`;
  return rows.map(toItem);
}

export async function addProjectItem(sql: Sql, projectId: number, input: { kind: ProjectItemKind; body: string; ref?: string | null }): Promise<ProjectItem> {
  const kind = oneOf(PROJECT_ITEM_KINDS, input.kind, "kind");
  const body = cleanText(input.body, 4000);
  if (!body) throw new WorkInputError("body is required");
  if (!(await sql`select 1 from jarvis.projects where id = ${projectId}`).length) throw new WorkInputError(`project ${projectId} not found`);
  const [r] = await sql`
    insert into jarvis.project_items (project_id, kind, body, ref) values (${projectId}, ${kind}, ${body}, ${clean(input.ref, 1000) || null})
    returning *`;
  await sql`update jarvis.projects set updated_at = now() where id = ${projectId}`;
  return toItem(r!);
}

export async function setProjectItemResolved(sql: Sql, id: number, resolved: boolean): Promise<void> {
  await sql`update jarvis.project_items set resolved_at = ${resolved ? new Date().toISOString() : null} where id = ${id}`;
}

export async function deleteProjectItem(sql: Sql, id: number): Promise<void> {
  await sql`delete from jarvis.project_items where id = ${id}`;
}

/** The project for a MESA assignment, if JARVIS created one. */
export async function projectForAssignment(sql: Sql, assignmentId: string): Promise<Project | null> {
  const [r] = await sql`${projectSelect(sql)} where p.source = 'mesa' and p.source_ref = ${`assignment:${assignmentId}`}`;
  return r ? toProject(r) : null;
}

/** When a task linked to a goal is completed, it counts once toward that goal (undone if reopened). */
export async function syncTaskActivity(sql: Sql, taskId: number, now = new Date()): Promise<void> {
  const [t] = await sql`select id, status, goal_id, project_id, completed_at from jarvis.tasks where id = ${taskId}`;
  const key = `task_done:${taskId}`;
  if (!t || t.status !== "done" || t.goal_id == null) {
    await sql`delete from jarvis.activities where dedupe_key = ${key}`;
    return;
  }
  const at = t.completed_at ? new Date(t.completed_at as string) : now;
  await sql`
    insert into jarvis.activities (occurred_at, day, kind, goal_id, task_id, project_id, source, dedupe_key)
    values (${at.toISOString()}, ${istDay(at)}, 'task_done', ${t.goal_id}, ${taskId}, ${t.project_id}, 'rule', ${key})
    on conflict (dedupe_key) do update set goal_id = excluded.goal_id`;
}
