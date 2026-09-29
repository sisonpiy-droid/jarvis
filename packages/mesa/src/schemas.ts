import { z } from "zod";

// Schemas cover only the fields JARVIS relies on. Objects are "loose" so new
// LMS fields pass through; a *changed* field we depend on fails validation and
// surfaces as a schema-drift warning instead of silently producing bad data.

const id = z.string().min(1);
const iso = z.string().datetime({ offset: true });
const nstr = z.string().nullable().optional();
const nnum = z.union([z.number(), z.string()]).nullable().optional();

export const envelope = <T extends z.ZodType>(data: T) => z.looseObject({ data });

export const StudentMe = z.looseObject({
  context: z.looseObject({
    student: z.looseObject({ id, name: z.string(), email: z.string(), enrollmentNo: nstr }),
    program: z.looseObject({ id, name: z.string(), code: nstr }).nullable().optional(),
    batch: z.looseObject({ id, name: z.string(), code: nstr }).nullable().optional(),
    terms: z.array(z.looseObject({ id, name: z.string(), sequence: z.number().nullable().optional() })),
  }),
});

export const Course = z.looseObject({
  id,
  termId: z.string().nullable(),
  title: z.string(),
  shortName: nstr,
  code: nstr,
  description: nstr,
  courseType: nstr,
  classType: nstr,
  instructorName: nstr,
  visible: z.boolean().optional(),
  updatedAt: iso.optional(),
});

export const Topic = z.looseObject({
  id,
  courseId: id,
  title: z.string(),
  type: z.string(),
  sequence: z.number().nullable().optional(),
});

export const ContentMaterial = z.looseObject({
  id,
  topicId: z.string().nullable().optional(),
  title: z.string(),
  kind: z.string(), // "file" | "link" | "text" observed/expected
  category: nstr,
  fileName: nstr,
  fileType: nstr,
  sizeBytes: nnum,
  url: nstr,
  content: nstr,
  allowDownload: z.boolean().optional(),
  isPublished: z.boolean().optional(),
  createdAt: iso.optional(),
  updatedAt: iso.optional(),
});

export const Recording = z.looseObject({
  id,
  topicId: z.string().nullable().optional(),
  title: z.string(),
  provider: nstr,
  videoUrl: nstr,
  embedUrl: nstr,
  recordedOn: nstr,
  durationSec: nnum,
  isPublished: z.boolean().optional(),
  updatedAt: iso.optional(),
});

export const AssignmentMaterial = z.looseObject({
  id,
  title: z.string(),
  kind: z.string(), // "link" | "pdf" observed
  url: nstr,
  fileName: nstr,
  fileType: nstr,
  fileSizeBytes: nnum,
  position: z.number().nullable().optional(),
});

export const Assignment = z.looseObject({
  id,
  title: z.string(),
  courseId: z.string().nullable(),
  courseTitle: nstr,
  description: nstr,
  instructions: nstr,
  status: z.string(),
  mySubmissionStatus: z.string().nullable().optional(),
  submissionType: nstr,
  dueAt: iso.nullable(),
  cutoffDate: iso.nullable().optional(),
  allowSubmissionsFrom: iso.nullable().optional(),
  allowLate: z.boolean().optional(),
  isGroup: z.boolean().optional(),
  groupSize: nnum,
  maxMarks: nnum,
  maxAttempts: nnum,
  materials: z.array(AssignmentMaterial).default([]),
  createdAt: iso.optional(),
  accessible: z.boolean().optional(),
});

export const Attachment = z.looseObject({
  id,
  fileName: nstr,
  fileType: nstr,
  fileSizeBytes: nnum,
  url: nstr,
});

export const Event = z.looseObject({
  id,
  title: z.string(),
  eventType: nstr,
  status: nstr,
  courseId: z.string().nullable().optional(),
  courseName: nstr,
  instructorName: nstr,
  startAt: iso,
  endAt: iso.nullable().optional(),
  timezone: nstr,
  room: nstr,
  meetingLink: nstr,
  description: nstr,
  attendanceRequired: z.boolean().optional(),
  attachments: z.array(Attachment).default([]),
  updatedAt: iso.optional(),
});

export const Announcement = z.looseObject({
  id,
  title: z.string(),
  body: nstr,
  authorName: nstr,
  courseId: z.string().nullable().optional(),
  courseName: nstr,
  isPinned: z.boolean().optional(),
  createdAt: iso,
  attachments: z.array(Attachment).default([]),
});

export type RawStudentMe = z.infer<typeof StudentMe>;
export type RawCourse = z.infer<typeof Course>;
export type RawTopic = z.infer<typeof Topic>;
export type RawContentMaterial = z.infer<typeof ContentMaterial>;
export type RawRecording = z.infer<typeof Recording>;
export type RawAssignment = z.infer<typeof Assignment>;
export type RawEvent = z.infer<typeof Event>;
export type RawAnnouncement = z.infer<typeof Announcement>;
