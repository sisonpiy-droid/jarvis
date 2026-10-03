import type { Sql } from "@jarvis/db";

// MESA → projects and tasks. Deterministic and idempotent: each MESA run compares the LMS facts with the
// values last applied (source_data) and acts only on what changed there, so your own edits — a moved due
// date, a task you reopened — survive until the LMS itself changes again. The first run backfills.
//
// Assignment: project "<title>" + task "Submit <title>" (due = deadline). A finished JARVIS draft adds
// "Review the JARVIS draft". Submitted on the LMS → tasks and project done; removed → cancelled.
// Exam (event type "exam"): project + "Prepare for <title>"; cancelled/removed → cancelled; once it has
// started → done.

/** Older open assignments are left alone (they're already on the Assignments page): overdue by more than
 * this, or — with no deadline — created on the LMS longer ago than UNDATED_DAYS. */
const BACKFILL_DAYS = 7;
const UNDATED_DAYS = 14;

export interface AssignmentFact {
  id: string;
  title: string;
  course: string | null;
  dueAt: string | null;
  /** When it was posted on the LMS. */
  createdAt?: string | null;
  submitted: boolean;
  removed: boolean;
}

export interface ExamFact {
  id: string;
  title: string;
  course: string | null;
  startAt: string;
  cancelled: boolean;
  removed: boolean;
}

export interface Tracked {
  id: number;
  status: string;
  sourceData: Record<string, unknown> | null;
}

export interface WorkState {
  assignments: AssignmentFact[];
  exams: ExamFact[];
  /** Assignments with a finished deliverable draft → that draft's id. */
  drafts: Map<string, number>;
  projects: Map<string, Tracked>; // by source_ref
  tasks: Map<string, Tracked>; // by source_ref
}

export type WorkOp =
  | { op: "createProject"; ref: string; title: string; objective: string | null; kind: "mesa_assignment" | "exam"; deadline: string | null; status: "active" | "done"; sourceData: Record<string, unknown> }
  | { op: "updateProject"; ref: string; set: { title?: string; deadline?: string | null; status?: string }; sourceData: Record<string, unknown> }
  | { op: "createTask"; ref: string; projectRef: string; title: string; notes: string | null; dueAt: string | null; nextAction: boolean; priority: number; sourceData: Record<string, unknown> }
  | { op: "updateTask"; ref: string; set: { title?: string; dueAt?: string | null; status?: string }; sourceData: Record<string, unknown> };

const OPEN_PROJECT = new Set(["active", "on_hold"]);
const OPEN_TASK = new Set(["todo", "doing", "waiting"]);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Pure: the facts and what was last applied in, the changes to make out. */
export function planWork(s: WorkState, now: Date): WorkOp[] {
  const ops: WorkOp[] = [];

  for (const a of s.assignments) {
    const pRef = `assignment:${a.id}`;
    const submitRef = `mesa:submit:${a.id}`;
    const reviewRef = `mesa:review:${a.id}`;
    const fact = { title: a.title, dueAt: a.dueAt, submitted: a.submitted, removed: a.removed };
    const project = s.projects.get(pRef);

    if (!project) {
      const recent = a.dueAt
        ? Date.parse(a.dueAt) >= now.getTime() - BACKFILL_DAYS * 86_400_000
        : !a.createdAt || Date.parse(a.createdAt) >= now.getTime() - UNDATED_DAYS * 86_400_000;
      if (a.removed || a.submitted || !recent) continue;
      ops.push({ op: "createProject", ref: pRef, title: a.title, objective: a.course ? `MESA · ${a.course}` : "MESA assignment", kind: "mesa_assignment", deadline: a.dueAt, status: "active", sourceData: fact });
      ops.push({ op: "createTask", ref: submitRef, projectRef: pRef, title: `Submit ${a.title}`, notes: null, dueAt: a.dueAt, nextAction: true, priority: 1, sourceData: fact });
      const draftId = s.drafts.get(a.id);
      if (draftId != null) ops.push(reviewTask(reviewRef, pRef, a, draftId));
      continue;
    }

    const prev = (project.sourceData ?? {}) as Partial<typeof fact>;
    const submit = s.tasks.get(submitRef);
    const review = s.tasks.get(reviewRef);
    const pSet: { title?: string; deadline?: string | null; status?: string } = {};
    const submitSet: { title?: string; dueAt?: string | null; status?: string } = {};
    const reviewSet: { status?: string } = {};

    if (prev.title !== a.title) {
      pSet.title = a.title;
      submitSet.title = `Submit ${a.title}`;
    }
    if (!same(prev.dueAt, a.dueAt)) {
      pSet.deadline = a.dueAt;
      submitSet.dueAt = a.dueAt;
    }
    if (prev.submitted !== a.submitted) {
      if (a.submitted) {
        if (submit && OPEN_TASK.has(submit.status)) submitSet.status = "done";
        if (review && OPEN_TASK.has(review.status)) reviewSet.status = "done";
        if (OPEN_PROJECT.has(project.status)) pSet.status = "done";
      } else if (prev.submitted === true) {
        if (submit?.status === "done") submitSet.status = "todo";
        if (project.status === "done") pSet.status = "active";
      }
    }
    if (prev.removed !== a.removed) {
      if (a.removed) {
        if (submit && OPEN_TASK.has(submit.status)) submitSet.status = "cancelled";
        if (review && OPEN_TASK.has(review.status)) reviewSet.status = "cancelled";
        if (OPEN_PROJECT.has(project.status)) pSet.status = "cancelled";
      } else if (prev.removed === true) {
        if (submit?.status === "cancelled" && !a.submitted) submitSet.status = "todo";
        if (project.status === "cancelled") pSet.status = a.submitted ? "done" : "active";
      }
    }

    if (Object.keys(pSet).length || !same(prev, fact)) ops.push({ op: "updateProject", ref: pRef, set: pSet, sourceData: fact });
    if (submit && (Object.keys(submitSet).length || !same(submit.sourceData, fact))) ops.push({ op: "updateTask", ref: submitRef, set: submitSet, sourceData: fact });
    if (review && Object.keys(reviewSet).length) ops.push({ op: "updateTask", ref: reviewRef, set: reviewSet, sourceData: review.sourceData ?? {} });

    // A draft finished for an assignment that's still open: add the review step once.
    const draftId = s.drafts.get(a.id);
    const projectOpen = OPEN_PROJECT.has(pSet.status ?? project.status);
    if (draftId != null && !review && projectOpen && !a.submitted && !a.removed) ops.push(reviewTask(reviewRef, pRef, a, draftId));
  }

  for (const e of s.exams) {
    const pRef = `exam:${e.id}`;
    const prepRef = `mesa:prep:${e.id}`;
    const started = Date.parse(e.startAt) <= now.getTime();
    const fact = { title: e.title, startAt: e.startAt, cancelled: e.cancelled, removed: e.removed, started };
    const project = s.projects.get(pRef);

    if (!project) {
      if (e.removed || e.cancelled || started) continue;
      ops.push({ op: "createProject", ref: pRef, title: e.title, objective: e.course ? `MESA exam · ${e.course}` : "MESA exam", kind: "exam", deadline: e.startAt, status: "active", sourceData: fact });
      ops.push({ op: "createTask", ref: prepRef, projectRef: pRef, title: `Prepare for ${e.title}`, notes: null, dueAt: e.startAt, nextAction: true, priority: 1, sourceData: fact });
      continue;
    }

    const prev = (project.sourceData ?? {}) as Partial<typeof fact>;
    const prep = s.tasks.get(prepRef);
    const pSet: { title?: string; deadline?: string | null; status?: string } = {};
    const tSet: { title?: string; dueAt?: string | null; status?: string } = {};
    if (prev.title !== e.title) {
      pSet.title = e.title;
      tSet.title = `Prepare for ${e.title}`;
    }
    if (prev.startAt !== e.startAt) {
      pSet.deadline = e.startAt;
      tSet.dueAt = e.startAt;
    }
    const off = e.cancelled || e.removed;
    const wasOff = !!(prev.cancelled || prev.removed);
    if (off !== wasOff) {
      if (off) {
        if (prep && OPEN_TASK.has(prep.status)) tSet.status = "cancelled";
        if (OPEN_PROJECT.has(project.status)) pSet.status = "cancelled";
      } else {
        if (prep?.status === "cancelled" && !started) tSet.status = "todo";
        if (project.status === "cancelled") pSet.status = started ? "done" : "active";
      }
    }
    if (!off && started && prev.started !== true) {
      if (prep && OPEN_TASK.has(prep.status)) tSet.status = "done";
      if (OPEN_PROJECT.has(project.status)) pSet.status = "done";
    }
    if (Object.keys(pSet).length || !same(prev, fact)) ops.push({ op: "updateProject", ref: pRef, set: pSet, sourceData: fact });
    if (prep && (Object.keys(tSet).length || !same(prep.sourceData, fact))) ops.push({ op: "updateTask", ref: prepRef, set: tSet, sourceData: fact });
  }
  return ops;
}

function reviewTask(ref: string, projectRef: string, a: AssignmentFact, draftId: number): WorkOp {
  // A day before the deadline when there's time, so the review doesn't collide with submitting.
  const due = a.dueAt ? new Date(Date.parse(a.dueAt) - 86_400_000).toISOString() : null;
  return {
    op: "createTask",
    ref,
    projectRef,
    title: `Review the JARVIS draft for ${a.title}`,
    notes: `Draft: /drafts/${draftId}`,
    dueAt: due,
    nextAction: false,
    priority: 2,
    sourceData: { draftId },
  };
}

/** Loads the facts and what was last applied. */
export async function loadWorkState(sql: Sql): Promise<WorkState> {
  const [assignments, exams, drafts, projects, tasks] = await Promise.all([
    sql`select source_id, title, data, removed_at from jarvis.lms_items where kind = 'assignment'`,
    sql`select source_id, title, data, removed_at from jarvis.lms_items where kind = 'event' and data ->> 'eventType' = 'exam'`,
    sql`select distinct on (assignment_id) assignment_id, id from jarvis.drafts where status = 'done' order by assignment_id, id desc`,
    sql`select id, status, source_ref, source_data from jarvis.projects where source = 'mesa'`,
    sql`select id, status, source_ref, source_data from jarvis.tasks where source = 'mesa'`,
  ]);
  const tracked = (rows: Array<Record<string, unknown>>) =>
    new Map(rows.map((r) => [String(r.source_ref), { id: Number(r.id), status: String(r.status), sourceData: (r.source_data as Record<string, unknown> | null) ?? null }]));
  return {
    assignments: assignments.map((r) => {
      const d = r.data as Record<string, unknown>;
      return {
        id: String(r.source_id),
        title: String(r.title),
        course: (d.courseTitle as string | null) ?? null,
        dueAt: (d.dueAt as string | null) ?? null,
        createdAt: (d.lmsCreatedAt as string | null) ?? null,
        submitted: String(d.submissionStatus ?? "").startsWith("submitted"),
        removed: !!r.removed_at,
      };
    }),
    exams: exams.map((r) => {
      const d = r.data as Record<string, unknown>;
      return {
        id: String(r.source_id),
        title: String(r.title),
        course: (d.courseName as string | null) ?? null,
        startAt: new Date(String(d.startAt)).toISOString(),
        cancelled: String(d.status ?? "").toLowerCase() === "cancelled",
        removed: !!r.removed_at,
      };
    }),
    drafts: new Map(drafts.map((r) => [String(r.assignment_id), Number(r.id)])),
    projects: tracked(projects),
    tasks: tracked(tasks),
  };
}

export interface WorkSummary {
  projectsCreated: number;
  tasksCreated: number;
  updated: number;
}

/** One reconcile pass, applied atomically. Safe to run any number of times. */
export async function syncWork(sql: Sql, now: Date): Promise<WorkSummary> {
  const ops = planWork(await loadWorkState(sql), now);
  const summary: WorkSummary = { projectsCreated: 0, tasksCreated: 0, updated: 0 };
  if (!ops.length) return summary;
  await sql.begin(async (tx) => {
    for (const o of ops) {
      if (o.op === "createProject") {
        const r = await tx`
          insert into jarvis.projects (title, objective, domain, area, kind, status, priority, deadline, source, source_ref, source_data)
          values (${o.title.slice(0, 300)}, ${o.objective}, 'professional', 'mesa', ${o.kind}, ${o.status}, 1, ${o.deadline}, 'mesa', ${o.ref}, ${tx.json(o.sourceData as never)})
          on conflict (source, source_ref) where source_ref is not null do nothing returning id`;
        summary.projectsCreated += r.length;
      } else if (o.op === "createTask") {
        const r = await tx`
          insert into jarvis.tasks (title, notes, domain, area, project_id, priority, due_at, is_next_action, source, source_ref, source_data)
          select ${o.title.slice(0, 300)}, ${o.notes}, 'professional', 'mesa', p.id, ${o.priority}, ${o.dueAt}, ${o.nextAction}, 'mesa', ${o.ref}, ${tx.json(o.sourceData as never)}
            from jarvis.projects p where p.source = 'mesa' and p.source_ref = ${o.projectRef}
          on conflict (source, source_ref) where source_ref is not null do nothing returning id`;
        summary.tasksCreated += r.length;
      } else if (o.op === "updateProject") {
        const s = o.set;
        const closing = s.status === "done" || s.status === "cancelled";
        await tx`
          update jarvis.projects set
                 title = ${s.title !== undefined ? s.title.slice(0, 300) : tx`title`},
                 deadline = ${s.deadline !== undefined ? s.deadline : tx`deadline`},
                 status = ${s.status ?? tx`status`},
                 completed_at = ${s.status === undefined ? tx`completed_at` : closing ? tx`coalesce(completed_at, now())` : null},
                 source_data = ${tx.json(o.sourceData as never)}, updated_at = now()
           where source = 'mesa' and source_ref = ${o.ref}`;
        if (Object.keys(s).length) summary.updated++;
      } else {
        const s = o.set;
        const open = s.status !== undefined && OPEN_TASK.has(s.status);
        await tx`
          update jarvis.tasks set
                 title = ${s.title !== undefined ? s.title.slice(0, 300) : tx`title`},
                 due_at = ${s.dueAt !== undefined ? s.dueAt : tx`due_at`},
                 due_is_date_only = ${s.dueAt !== undefined ? false : tx`due_is_date_only`},
                 status = ${s.status ?? tx`status`},
                 completed_at = ${s.status === undefined ? tx`completed_at` : s.status === "done" ? tx`coalesce(completed_at, now())` : null},
                 is_next_action = ${s.status === undefined ? tx`is_next_action` : open && o.ref.startsWith("mesa:review:") === false},
                 source_data = ${tx.json(o.sourceData as never)}, updated_at = now()
           where source = 'mesa' and source_ref = ${o.ref}`;
        if (Object.keys(s).length) summary.updated++;
      }
    }
  });
  return summary;
}
