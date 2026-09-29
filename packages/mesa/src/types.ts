// Normalized, source-agnostic shapes. These are what the database stores and
// what agents see; raw LMS responses never leave the mesa package.

export type SubmissionStatus = "submitted" | "submitted_late" | "not_submitted" | `other:${string}`;

export interface MesaAttachment {
  sourceId: string;
  title: string;
  kind: string; // "file" | "pdf" | "link" | "text" …
  fileName: string | null;
  mimeOrType: string | null;
  sizeBytes: number | null;
  /** URL with signing parameters removed — stable identity. */
  url: string | null;
  /** True when the LMS served a time-limited signed URL (fetch fresh to download). */
  signed: boolean;
}

export interface MesaAssignment {
  source: "mesa";
  sourceId: string;
  sourceUrl: string;
  courseId: string | null;
  courseTitle: string | null;
  instructor: string | null;
  title: string;
  descriptionText: string | null;
  instructionsText: string | null;
  descriptionHtml: string | null;
  instructionsHtml: string | null;
  links: string[];
  dueAt: string | null;
  dueAtIst: string | null;
  cutoffAt: string | null;
  availableFrom: string | null;
  allowLate: boolean | null;
  submissionType: string | null;
  isGroup: boolean;
  groupSize: number | null;
  maxMarks: number | null;
  maxAttempts: number | null;
  lmsStatus: string;
  submissionStatus: SubmissionStatus;
  materials: MesaAttachment[];
  lmsCreatedAt: string | null;
  contentHash: string;
}

export interface MesaMaterial extends MesaAttachment {
  courseId: string;
  topicId: string;
  topicTitle: string;
  category: string | null;
  textContent: string | null;
  downloadable: boolean;
  lmsCreatedAt: string | null;
  lmsUpdatedAt: string | null;
  contentHash: string;
}

export interface MesaRecording {
  sourceId: string;
  courseId: string;
  topicId: string;
  title: string;
  provider: string | null;
  videoUrl: string | null;
  recordedOn: string | null;
  contentHash: string;
}

export interface MesaTopic {
  sourceId: string;
  title: string;
  type: string;
  sequence: number | null;
}

export interface MesaCourse {
  source: "mesa";
  sourceId: string;
  sourceUrl: string;
  termId: string | null;
  termName: string | null;
  title: string;
  shortName: string | null;
  code: string | null;
  instructor: string | null;
  courseType: string | null;
  classType: string | null;
  descriptionText: string | null;
  topics: MesaTopic[];
  contentHash: string;
}

export interface MesaEvent {
  sourceId: string;
  title: string;
  eventType: string | null;
  status: string | null;
  courseId: string | null;
  courseName: string | null;
  instructor: string | null;
  startAt: string;
  endAt: string | null;
  startAtIst: string | null;
  room: string | null;
  meetingLink: string | null;
  descriptionText: string | null;
  attendanceRequired: boolean;
  attachments: MesaAttachment[];
  contentHash: string;
}

export interface MesaAnnouncement {
  sourceId: string;
  title: string;
  bodyText: string | null;
  author: string | null;
  courseId: string | null;
  courseName: string | null;
  pinned: boolean;
  createdAt: string;
  attachments: MesaAttachment[];
  contentHash: string;
}

export interface MesaStudent {
  name: string;
  email: string;
  enrollmentNo: string | null;
  program: string | null;
  batch: string | null;
  terms: Array<{ id: string; name: string }>;
}

export interface MesaWarning {
  where: string;
  message: string;
}

export type CollectionName = "courses" | "materials" | "recordings" | "assignments" | "events" | "announcements";

export interface MesaSnapshot {
  meta: {
    source: "mesa";
    /** "light" reads only assignments, events and announcements. */
    kind: "full" | "light";
    extractedAt: string;
    apiBase: string;
    requestCount: number;
    durationMs: number;
    counts: Record<string, number>;
    /** Collections fetched this run, and whether each was read without errors. Absent = not fetched. */
    complete: Partial<Record<CollectionName, boolean>>;
    /** The calendar range requested; events outside it are never treated as removed. */
    eventsWindow: { from: string; to: string };
    warnings: MesaWarning[];
    unavailable: string[];
  };
  student: MesaStudent | null;
  /** Run-scoped data that must never be stored or written to disk (signed download URLs). */
  transient?: { signedUrls: Record<string, string> };
  courses: MesaCourse[];
  materials: MesaMaterial[];
  recordings: MesaRecording[];
  assignments: MesaAssignment[];
  events: MesaEvent[];
  announcements: MesaAnnouncement[];
}
