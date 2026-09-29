// SYNTHETIC FIXTURES. Field names and shapes mirror real MESA API responses
// observed on 2026-09-28; every value here is invented. No real student data.

export const TERM_PRE = "00000000-0000-4000-8000-00000000a001";
export const TERM_1 = "00000000-0000-4000-8000-00000000a002";
export const COURSE_BF = "00000000-0000-4000-8000-00000000c001";
export const COURSE_ENT = "00000000-0000-4000-8000-00000000c002";

const signed = (path: string, sig: string) =>
  `https://storage.googleapis.com/example-bucket/${path}?GoogleAccessId=svc%40example.iam.gserviceaccount.com&Expires=1790000000&Signature=${sig}`;

export const studentMe = {
  data: {
    context: {
      student: { id: "stu-1", name: "Test Student", email: "student@example.com", enrollmentNo: "TEST_001", avatarUrl: null },
      program: { id: "prog-1", name: "PGP Test Cohort", code: "PGP_TEST" },
      batch: { id: "batch-1", name: "Batch 2099", code: "B2099" },
      enrollment: { id: "enr-1", enrolledAt: "2026-07-01T00:00:00.000Z" },
      terms: [
        { id: TERM_1, name: "Term 1", sequence: 1, minElectives: 0 },
        { id: TERM_PRE, name: "Pre-Term", sequence: 0, minElectives: 0 },
      ],
    },
  },
};

export const course = (id: string, termId: string, title: string, instructorName: string | null) => ({
  id,
  termId,
  title,
  shortName: title.slice(0, 4).toUpperCase(),
  code: null,
  description: null,
  courseType: "core",
  classType: "in-class",
  instructorName,
  coverImageUrl: null,
  visible: true,
  startDate: null,
  endDate: null,
  sequence: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

export const topics = (courseId: string) => ({
  data: {
    topics: [
      { id: `${courseId}-t-outline`, courseId, title: "Outlines", type: "outline", sequence: 0 },
      { id: `${courseId}-t-res`, courseId, title: "Resources", type: "resources", sequence: 1 },
      { id: `${courseId}-t-asg`, courseId, title: "Assignments", type: "assignments", sequence: 2 },
      { id: `${courseId}-t-rec`, courseId, title: "Class Recordings", type: "recordings", sequence: 3 },
      { id: `${courseId}-t-ann`, courseId, title: "Announcements", type: "announcements", sequence: 4 },
    ],
  },
});

export const fileMaterial = (id: string, topicId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  topicId,
  title: "Session 1: Case Pre-Read",
  kind: "file",
  category: "resource",
  fileName: "case-pre-read.pdf",
  fileType: "pdf",
  sizeBytes: 795219,
  url: null,
  content: null,
  allowDownload: true,
  isPublished: true,
  resourceSessionId: "rs-1",
  session: null,
  createdAt: "2026-09-17T17:13:59.922Z",
  updatedAt: "2026-09-17T17:14:04.460Z",
  ...overrides,
});

export const recording = (id: string, topicId: string) => ({
  id,
  topicId,
  title: "Session 1 recording",
  provider: "youtube",
  videoUrl: "https://youtube.com/live/EXAMPLE",
  embedUrl: "https://www.youtube-nocookie.com/embed/EXAMPLE",
  thumbnailUrl: null,
  recordedOn: "2026-08-21",
  durationSec: null,
  isPublished: true,
  createdAt: "2026-08-21T07:13:26.841Z",
  updatedAt: "2026-08-21T07:13:29.594Z",
});

export const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: "asg-1",
  title: "Framework Application Case",
  courseId: COURSE_BF,
  courseTitle: "Business Frameworks with Prof. Example Person",
  description:
    '<p><strong>Framework Application</strong> — apply <em>two</em> frameworks.</p><ul><li>Part A</li><li>Part B &amp; C</li></ul>',
  instructions: '<p>Make a copy of <a target="_blank" rel="noopener" href="https://docs.google.com/spreadsheets/d/EXAMPLE">this sheet</a>.</p>',
  status: "published",
  mySubmissionStatus: null,
  submissionType: "file",
  dueAt: "2026-09-30T18:29:00.000Z",
  cutoffDate: "2026-10-01T18:29:00.000Z",
  allowSubmissionsFrom: "2026-09-20T00:00:00.000Z",
  allowLate: true,
  isGroup: false,
  groupSize: null,
  groupingId: null,
  maxMarks: "10.00",
  maxAttempts: 1,
  materials: [
    {
      id: "mat-pdf",
      title: "Assignment brief",
      kind: "pdf",
      url: signed("briefs/brief.pdf", "AAAA"),
      fileName: "brief.pdf",
      fileType: "application/pdf",
      fileSizeBytes: 123456,
      position: 1,
    },
    {
      id: "mat-link",
      title: "Data sheet",
      kind: "link",
      url: "https://docs.google.com/spreadsheets/d/EXAMPLE",
      fileName: null,
      fileType: null,
      fileSizeBytes: null,
      position: 0,
    },
  ],
  restrictions: [],
  selectedGroupIds: [],
  topicId: null,
  createdAt: "2026-09-20T06:41:26.821Z",
  ...overrides,
});

export const event = (overrides: Record<string, unknown> = {}) => ({
  id: "evt-1",
  title: "Business Frameworks — Session 7",
  eventType: "class",
  status: "scheduled",
  courseId: COURSE_BF,
  courseName: "Business Frameworks",
  courseLabel: "Business Frameworks",
  instructorName: "Prof. Example Person",
  startAt: "2026-09-29T04:30:00.000Z",
  endAt: "2026-09-29T06:00:00.000Z",
  timezone: "Asia/Kolkata",
  room: "LT-1",
  meetingLink: null,
  description: null,
  attendanceRequired: true,
  attachments: [],
  gcalSyncStatus: "not_synced",
  sectionIds: ["sec-a"],
  sectionNames: ["Section A"],
  createdAt: "2026-08-25T06:51:29.023Z",
  updatedAt: "2026-08-25T06:51:29.023Z",
  ...overrides,
});

export const announcement = (overrides: Record<string, unknown> = {}) => ({
  id: "ann-1",
  title: "Groups for next week",
  body: "<p>Hello everyone!</p><p>Groups are attached.</p>",
  authorName: "Programme Office",
  courseId: null,
  courseName: null,
  isPinned: false,
  createdAt: "2026-09-26T07:25:52.416Z",
  attachments: [{ id: "att-1", fileName: "groups.xlsx", fileType: "xlsx", fileSizeBytes: 2048, url: signed("ann/groups.xlsx", "BBBB") }],
  likesCount: 3,
  viewsCount: 159,
  replies: [],
  ...overrides,
});

/** Routes GET paths to fixture bodies, like the real API would. */
export function fixtureRoutes(): Record<string, unknown> {
  const bf = COURSE_BF;
  const ent = COURSE_ENT;
  return {
    "/student/me": studentMe,
    [`/curriculum/courses?termId=${TERM_PRE}`]: { data: { courses: [course(ent, TERM_PRE, "Entrepreneurship", null)] } },
    // The same course appearing under two terms must not be duplicated.
    [`/curriculum/courses?termId=${TERM_1}`]: {
      data: { courses: [course(bf, TERM_1, "Business Frameworks", "Prof. Example Person"), course(ent, TERM_PRE, "Entrepreneurship", null)] },
    },
    [`/curriculum/topics?courseId=${bf}`]: topics(bf),
    [`/curriculum/topics?courseId=${ent}`]: topics(ent),
    [`/content/topics/${bf}-t-outline/materials`]: { data: { materials: [] } },
    [`/content/topics/${bf}-t-res/materials`]: {
      data: {
        materials: [
          fileMaterial("m-1", `${bf}-t-res`),
          { ...fileMaterial("m-2", `${bf}-t-res`), kind: "link", fileName: null, fileType: null, sizeBytes: null, url: "https://example.com/reading" },
          { ...fileMaterial("m-bad", `${bf}-t-res`), title: 42 }, // malformed → warning, not a crash
        ],
      },
    },
    [`/content/topics/${bf}-t-rec/recordings`]: { data: { recordings: [recording("r-1", `${bf}-t-rec`)] } },
    // ent's outline 404s → recorded as unavailable
    [`/content/topics/${ent}-t-res/materials`]: { data: { materials: [fileMaterial("m-3", `${ent}-t-res`, { title: "Zostel case" })] } },
    [`/content/topics/${ent}-t-rec/recordings`]: { data: { recordings: [] } },
    "/assignments/my": {
      data: {
        assignments: [
          assignment(),
          assignment({ id: "asg-0", title: "Pre-work", courseId: null, courseTitle: null, description: null, instructions: null, materials: [], mySubmissionStatus: "submitted", dueAt: "2026-08-18T06:30:00.000Z" }),
          assignment({ id: "asg-late", mySubmissionStatus: "late", dueAt: "2026-09-01T18:29:00.000Z" }),
        ],
      },
    },
    "/announcements?page=1&limit=50": { data: { announcements: [announcement()], page: 1, limit: 50, total: 1 } },
  };
}
