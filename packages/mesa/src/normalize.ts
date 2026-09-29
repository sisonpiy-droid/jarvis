import { contentHash } from "@jarvis/shared";
import { assignmentUrl, courseUrl } from "./config";
import type {
  RawAnnouncement,
  RawAssignment,
  RawContentMaterial,
  RawCourse,
  RawEvent,
  RawRecording,
  RawStudentMe,
  RawTopic,
} from "./schemas";
import { extractLinks, formatIst, htmlToText, instructorFromCourseTitle, isSignedUrl, stableUrl } from "./text";
import type {
  MesaAnnouncement,
  MesaAssignment,
  MesaAttachment,
  MesaCourse,
  MesaEvent,
  MesaMaterial,
  MesaRecording,
  MesaStudent,
  SubmissionStatus,
} from "./types";

// Pure functions: raw (schema-validated) LMS objects in, normalized records out.
// contentHash covers only fields whose change is meaningful to the student —
// never view counts, likes, signatures or other churn.

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const hashable = (a: MesaAttachment) => ({ id: a.sourceId, t: a.title, k: a.kind, f: a.fileName, s: a.sizeBytes, u: a.url });

export function normalizeSubmissionStatus(raw: string | null | undefined): SubmissionStatus {
  switch (raw) {
    case "submitted":
      return "submitted";
    case "late":
      return "submitted_late";
    case null:
    case undefined:
    case "":
      return "not_submitted";
    default:
      return `other:${raw}`;
  }
}

export function normalizeAttachment(a: {
  id: string;
  title?: string | null;
  kind?: string | null;
  fileName?: string | null | undefined;
  fileType?: string | null | undefined;
  fileSizeBytes?: number | string | null | undefined;
  sizeBytes?: number | string | null | undefined;
  url?: string | null | undefined;
}): MesaAttachment {
  return {
    sourceId: a.id,
    title: a.title ?? a.fileName ?? "Untitled",
    kind: a.kind ?? "file",
    fileName: a.fileName ?? null,
    mimeOrType: a.fileType ?? null,
    sizeBytes: num(a.fileSizeBytes ?? a.sizeBytes),
    url: stableUrl(a.url),
    signed: isSignedUrl(a.url),
  };
}

export function normalizeStudent(raw: RawStudentMe): MesaStudent {
  const c = raw.context;
  return {
    name: c.student.name,
    email: c.student.email,
    enrollmentNo: c.student.enrollmentNo ?? null,
    program: c.program?.name ?? null,
    batch: c.batch?.name ?? null,
    terms: [...c.terms].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((t) => ({ id: t.id, name: t.name })),
  };
}

export function normalizeCourse(raw: RawCourse, topics: RawTopic[], termName: string | null): MesaCourse {
  const normTopics = [...topics]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((t) => ({ sourceId: t.id, title: t.title, type: t.type, sequence: t.sequence ?? null }));
  const base = {
    title: raw.title,
    shortName: raw.shortName ?? null,
    code: raw.code ?? null,
    instructor: raw.instructorName ?? null,
    courseType: raw.courseType ?? null,
    classType: raw.classType ?? null,
    descriptionText: htmlToText(raw.description),
  };
  return {
    source: "mesa",
    sourceId: raw.id,
    sourceUrl: courseUrl(raw.id),
    termId: raw.termId,
    termName,
    ...base,
    topics: normTopics,
    contentHash: contentHash({ ...base, termId: raw.termId, topics: normTopics.map((t) => [t.sourceId, t.title, t.type]) }),
  };
}

export function normalizeMaterial(raw: RawContentMaterial, courseId: string, topic: RawTopic): MesaMaterial {
  const att = normalizeAttachment(raw);
  const textContent = raw.kind === "text" ? htmlToText(raw.content) : null;
  return {
    ...att,
    courseId,
    topicId: topic.id,
    topicTitle: topic.title,
    category: raw.category ?? null,
    textContent,
    downloadable: raw.kind === "file" && raw.allowDownload !== false,
    lmsCreatedAt: raw.createdAt ?? null,
    lmsUpdatedAt: raw.updatedAt ?? null,
    contentHash: contentHash({ ...hashable(att), topic: topic.id, text: textContent, updated: raw.updatedAt ?? null }),
  };
}

export function normalizeRecording(raw: RawRecording, courseId: string, topicId: string): MesaRecording {
  const r = {
    title: raw.title,
    provider: raw.provider ?? null,
    videoUrl: raw.videoUrl ?? raw.embedUrl ?? null,
    recordedOn: raw.recordedOn ?? null,
  };
  return { sourceId: raw.id, courseId, topicId, ...r, contentHash: contentHash(r) };
}

export function normalizeAssignment(raw: RawAssignment, instructorByCourse: Map<string, string | null>): MesaAssignment {
  const materials = [...raw.materials].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(normalizeAttachment);
  const links = [
    ...new Set([
      ...extractLinks(raw.description),
      ...extractLinks(raw.instructions),
      ...materials.filter((m) => m.kind === "link" && m.url).map((m) => m.url as string),
    ]),
  ];
  const fields = {
    courseId: raw.courseId,
    courseTitle: raw.courseTitle ?? null,
    title: raw.title,
    descriptionText: htmlToText(raw.description),
    instructionsText: htmlToText(raw.instructions),
    dueAt: raw.dueAt,
    cutoffAt: raw.cutoffDate ?? null,
    availableFrom: raw.allowSubmissionsFrom ?? null,
    allowLate: raw.allowLate ?? null,
    submissionType: raw.submissionType ?? null,
    isGroup: raw.isGroup ?? false,
    groupSize: num(raw.groupSize),
    maxMarks: num(raw.maxMarks),
    maxAttempts: num(raw.maxAttempts),
    lmsStatus: raw.status,
    submissionStatus: normalizeSubmissionStatus(raw.mySubmissionStatus),
  };
  return {
    source: "mesa",
    sourceId: raw.id,
    sourceUrl: assignmentUrl(raw.id),
    ...fields,
    instructor: (raw.courseId ? instructorByCourse.get(raw.courseId) : null) ?? instructorFromCourseTitle(raw.courseTitle),
    descriptionHtml: raw.description ?? null,
    instructionsHtml: raw.instructions ?? null,
    links,
    dueAtIst: formatIst(raw.dueAt),
    materials,
    lmsCreatedAt: raw.createdAt ?? null,
    contentHash: contentHash({ ...fields, materials: materials.map(hashable) }),
  };
}

export function normalizeEvent(raw: RawEvent): MesaEvent {
  const attachments = raw.attachments.map((a) => normalizeAttachment({ ...a, title: a.fileName, kind: "file" }));
  const fields = {
    title: raw.title,
    eventType: raw.eventType ?? null,
    status: raw.status ?? null,
    courseId: raw.courseId ?? null,
    courseName: raw.courseName ?? null,
    instructor: raw.instructorName ?? null,
    startAt: raw.startAt,
    endAt: raw.endAt ?? null,
    room: raw.room ?? null,
    meetingLink: raw.meetingLink ?? null,
    descriptionText: htmlToText(raw.description),
    attendanceRequired: raw.attendanceRequired ?? false,
  };
  return {
    sourceId: raw.id,
    ...fields,
    startAtIst: formatIst(raw.startAt),
    attachments,
    contentHash: contentHash({ ...fields, attachments: attachments.map(hashable) }),
  };
}

export function normalizeAnnouncement(raw: RawAnnouncement): MesaAnnouncement {
  const attachments = raw.attachments.map((a) => normalizeAttachment({ ...a, title: a.fileName, kind: "file" }));
  const fields = {
    title: raw.title,
    bodyText: htmlToText(raw.body),
    author: raw.authorName ?? null,
    courseId: raw.courseId ?? null,
    courseName: raw.courseName ?? null,
    createdAt: raw.createdAt,
  };
  return {
    sourceId: raw.id,
    ...fields,
    // Pinning is display state, not content: kept out of the hash so a re-pin is not "updated".
    pinned: raw.isPinned ?? false,
    attachments,
    contentHash: contentHash({ ...fields, attachments: attachments.map(hashable) }),
  };
}
