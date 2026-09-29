import type { z } from "zod";
import type { Logger } from "@jarvis/shared";
import { MESA_API_BASE } from "./config";
import { MesaApiError, type MesaClient } from "./client";
import * as S from "./schemas";
import {
  normalizeAnnouncement,
  normalizeAssignment,
  normalizeCourse,
  normalizeEvent,
  normalizeMaterial,
  normalizeRecording,
  normalizeStudent,
} from "./normalize";
import type { CollectionName, MesaMaterial, MesaRecording, MesaSnapshot, MesaWarning } from "./types";

// Topic types whose content lives under /materials vs /recordings. The rest
// ("assignments", "announcements") are views over endpoints we read directly.
const RECORDING_TOPICS = new Set(["recordings"]);
const NON_CONTENT_TOPICS = new Set(["assignments", "announcements"]);
const DAY = 86_400_000;

export interface ExtractOptions {
  now?: Date;
  eventsPastDays?: number;
  eventsFutureDays?: number;
  announcementPages?: number;
  /** Light mode only: courseId → instructor, from the DB (courses aren't re-fetched). */
  instructorByCourse?: Map<string, string | null>;
  log?: Logger;
}

type Data = { data?: Record<string, unknown> };

/** Per-run bookkeeping: warnings, unavailable endpoints, and which collections were read completely. */
class Run {
  warnings: MesaWarning[] = [];
  unavailable: string[] = [];
  incomplete = new Set<CollectionName>();

  constructor(readonly client: MesaClient) {}

  /** Validates each item on its own, so one malformed record is a warning, not a lost list. */
  validateEach<T extends z.ZodType>(schema: T, items: unknown, where: string, col: CollectionName): z.infer<T>[] {
    if (!Array.isArray(items)) {
      this.warnings.push({ where, message: "expected an array — the response shape has changed" });
      this.incomplete.add(col);
      return [];
    }
    const out: z.infer<T>[] = [];
    items.forEach((item, i) => {
      const r = schema.safeParse(item);
      if (r.success) out.push(r.data);
      else {
        this.incomplete.add(col);
        this.warnings.push({ where: `${where}[${i}]`, message: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      }
    });
    return out;
  }

  /** API errors on one endpoint degrade that collection; auth and network failures abort the run. */
  async soft<T>(where: string, col: CollectionName, fn: () => Promise<T>, fallback: T, notFoundIsEmpty = false): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof MesaApiError)) throw err;
      const notFound = err.status === 403 || err.status === 404;
      if (notFound) this.unavailable.push(where);
      // A per-topic 404 (e.g. a "custom" quiz topic with no materials) is not data loss; anything else is.
      if (!(notFound && notFoundIsEmpty)) {
        this.warnings.push({ where, message: err.message });
        this.incomplete.add(col);
      }
      return fallback;
    }
  }
}

async function fetchAssignments(run: Run, instructorByCourse: Map<string, string | null>) {
  return run.soft("assignments/my", "assignments", async () => {
    const r = await run.client.get<Data>("/assignments/my");
    return run.validateEach(S.Assignment, r.data?.assignments, "assignments", "assignments").map((a) => normalizeAssignment(a, instructorByCourse));
  }, []);
}

async function fetchEvents(run: Run, from: string, to: string) {
  return run.soft("events/my", "events", async () => {
    const r = await run.client.get<Data>(`/events/my?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    return run.validateEach(S.Event, r.data?.events, "events", "events").map(normalizeEvent);
  }, []);
}

async function fetchAnnouncements(run: Run, pages: number) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await run.soft(`announcements?page=${page}`, "announcements", async () => {
      const r = await run.client.get<Data>(`/announcements?page=${page}&limit=50`);
      return run.validateEach(S.Announcement, r.data?.announcements, `announcements(p${page})`, "announcements").map(normalizeAnnouncement);
    }, []);
    out.push(...batch);
    if (batch.length < 50) break;
  }
  return out;
}

const byId = <T extends { sourceId: string }>(xs: T[]) => [...xs].sort((a, b) => a.sourceId.localeCompare(b.sourceId));

function finish(
  run: Run,
  kind: "full" | "light",
  started: number,
  now: Date,
  window: { from: string; to: string },
  fetched: CollectionName[],
  parts: Omit<MesaSnapshot, "meta">,
): MesaSnapshot {
  const complete = Object.fromEntries(fetched.map((c) => [c, !run.incomplete.has(c)])) as MesaSnapshot["meta"]["complete"];
  return {
    meta: {
      source: "mesa",
      kind,
      extractedAt: now.toISOString(),
      apiBase: MESA_API_BASE,
      requestCount: run.client.requestCount,
      durationMs: Date.now() - started,
      counts: Object.fromEntries(fetched.map((c) => [c, parts[c].length])),
      complete,
      eventsWindow: window,
      warnings: run.warnings,
      unavailable: run.unavailable,
    },
    ...parts,
    assignments: [...parts.assignments].sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || a.sourceId.localeCompare(b.sourceId)),
    events: [...parts.events].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.sourceId.localeCompare(b.sourceId)),
    announcements: [...parts.announcements].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sourceId.localeCompare(b.sourceId)),
  };
}

function eventsWindow(now: Date, opts: ExtractOptions) {
  return {
    from: new Date(now.getTime() - (opts.eventsPastDays ?? 14) * DAY).toISOString(),
    to: new Date(now.getTime() + (opts.eventsFutureDays ?? 60) * DAY).toISOString(),
  };
}

/**
 * Light check (~4 GETs): the high-signal, frequently-changing collections.
 * Courses, materials and recordings are left untouched (complete=false → never treated as removed).
 */
export async function extractLight(client: MesaClient, opts: ExtractOptions = {}): Promise<MesaSnapshot> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const run = new Run(client);
  const window = eventsWindow(now, opts);
  const [assignments, events, announcements] = await Promise.all([
    fetchAssignments(run, opts.instructorByCourse ?? new Map()),
    fetchEvents(run, window.from, window.to),
    fetchAnnouncements(run, 1),
  ]);
  return finish(run, "light", started, now, window, ["assignments", "events", "announcements"], {
    student: null,
    courses: [],
    materials: [],
    recordings: [],
    assignments,
    events,
    announcements,
  });
}

/** Full read-only snapshot of everything V1 cares about (~100 GETs). */
export async function extractSnapshot(client: MesaClient, opts: ExtractOptions = {}): Promise<MesaSnapshot> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const run = new Run(client);
  const log = opts.log;

  // 1. Who am I, which terms exist. A failure here is fatal: nothing else is trustworthy.
  const meRaw = await client.get<Data>("/student/me");
  const student = normalizeStudent(S.StudentMe.parse(meRaw.data));
  log?.info("student context loaded", { terms: student.terms.length });

  // 2. Courses per term, then topics per course.
  const termName = new Map(student.terms.map((t) => [t.id, t.name]));
  const rawCourses = (
    await Promise.all(
      student.terms.map((t) =>
        run.soft(`courses?termId=${t.id}`, "courses", async () => {
          const r = await client.get<Data>(`/curriculum/courses?termId=${encodeURIComponent(t.id)}`);
          return run.validateEach(S.Course, r.data?.courses, `courses(${t.name})`, "courses");
        }, []),
      ),
    )
  ).flat();
  const uniqueCourses = [...new Map(rawCourses.map((c) => [c.id, c])).values()];

  const topicsByCourse = new Map<string, S.RawTopic[]>();
  await Promise.all(
    uniqueCourses.map(async (c) => {
      const topics = await run.soft(`topics?courseId=${c.id}`, "courses", async () => {
        const r = await client.get<Data>(`/curriculum/topics?courseId=${encodeURIComponent(c.id)}`);
        return run.validateEach(S.Topic, r.data?.topics, `topics(${c.title})`, "courses");
      }, []);
      topicsByCourse.set(c.id, topics);
    }),
  );
  const courses = uniqueCourses.map((c) => normalizeCourse(c, topicsByCourse.get(c.id) ?? [], c.termId ? termName.get(c.termId) ?? null : null));
  log?.info("courses loaded", { courses: courses.length });

  // 3. Materials and recordings per content topic.
  const materials: MesaMaterial[] = [];
  const recordings: MesaRecording[] = [];
  await Promise.all(
    uniqueCourses.flatMap((c) =>
      (topicsByCourse.get(c.id) ?? [])
        .filter((t) => !NON_CONTENT_TOPICS.has(t.type))
        .map(async (t) => {
          const tid = encodeURIComponent(t.id);
          const where = `${c.title}/${t.title}`;
          if (RECORDING_TOPICS.has(t.type)) {
            const recs = await run.soft(`recordings(${where})`, "recordings", async () => {
              const r = await client.get<Data>(`/content/topics/${tid}/recordings`);
              return run.validateEach(S.Recording, r.data?.recordings, `recordings(${where})`, "recordings");
            }, [], true);
            recordings.push(...recs.map((x) => normalizeRecording(x, c.id, t.id)));
          } else {
            const mats = await run.soft(`materials(${where})`, "materials", async () => {
              const r = await client.get<Data>(`/content/topics/${tid}/materials`);
              return run.validateEach(S.ContentMaterial, r.data?.materials, `materials(${where})`, "materials");
            }, [], true);
            materials.push(...mats.map((m) => normalizeMaterial(m, c.id, t)));
          }
        }),
    ),
  );
  log?.info("materials loaded", { materials: materials.length, recordings: recordings.length });

  // 4–6. Assignments, calendar, announcements.
  const instructorByCourse = new Map(uniqueCourses.map((c) => [c.id, c.instructorName ?? null]));
  const window = eventsWindow(now, opts);
  const [assignments, events, announcements] = await Promise.all([
    fetchAssignments(run, instructorByCourse),
    fetchEvents(run, window.from, window.to),
    fetchAnnouncements(run, opts.announcementPages ?? 1),
  ]);
  log?.info("assignments loaded", { assignments: assignments.length });

  return finish(run, "full", started, now, window, ["courses", "materials", "recordings", "assignments", "events", "announcements"], {
    student,
    courses: byId(courses),
    materials: byId(materials),
    recordings: byId(recordings),
    assignments,
    events,
    announcements,
  });
}
