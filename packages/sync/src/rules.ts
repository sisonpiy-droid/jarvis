import type { EventDraft, NotificationDraft, Priority, StoredItem } from "@jarvis/db";
import type { MesaAnnouncement, MesaAssignment, MesaAttachment, MesaCourse, MesaEvent, MesaMaterial, MesaRecording } from "@jarvis/mesa";
import { esc } from "@jarvis/notify";
import type { Diff } from "./diff";
import { deliveryTime, relative, reminderBucket } from "./time";

// Pure: a diff in, domain events + notification drafts out. Dedupe keys name
// the fact *and its version*, so the same unchanged fact is never announced
// twice — even across restarts — while a genuinely new version is.

export interface RuleContext {
  now: Date;
  courseTitle: (courseId: string | null | undefined) => string | null;
}

export interface RuleOutput {
  events: EventDraft[];
  notifications: NotificationDraft[];
}

const DAY = 86_400_000;
const CLASS_HORIZON = 7 * DAY;

const draft = (ctx: RuleContext, dedupeKey: string, priority: Priority, text: string): NotificationDraft => ({
  dedupeKey,
  priority,
  text,
  scheduledFor: deliveryTime(priority, ctx.now).toISOString(),
});

const link = (url: string, label = "Open in LMS") => `🔗 <a href="${esc(url)}">${label}</a>`;
const clip = (s: string | null | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const fileList = (files: MesaAttachment[]) => files.map((f) => `• ${esc(f.title)}${f.kind === "link" ? " (link)" : ""}`).join("\n");

// ── assignments ───────────────────────────────────────────────────────────────

const SUBMIT_AS: Record<string, string> = { link: "a link", file: "a file upload", text: "text", any: "file, link or text" };

function assignmentHeader(a: MesaAssignment): string {
  return `<b>${esc(a.courseTitle ?? "General")}</b>\n${esc(a.title)}`;
}

export function assignmentCreatedText(a: MesaAssignment, now: Date): string {
  const lines = [`🔔 <b>New MESA assignment</b>`, assignmentHeader(a), ""];
  lines.push(a.dueAt ? `⏰ Due: <b>${esc(a.dueAtIst)}</b> (${relative(a.dueAt, now)})` : "⏰ No deadline set");
  if (a.submissionType) lines.push(`📝 Submit as ${SUBMIT_AS[a.submissionType] ?? esc(a.submissionType)}${a.isGroup ? " · group work" : ""}`);
  if (a.instructor) lines.push(`👤 ${esc(a.instructor)}`);
  if (a.materials.length) lines.push(`📎 ${a.materials.length} attachment${a.materials.length > 1 ? "s" : ""}:\n${fileList(a.materials)}`);
  const brief = clip(a.descriptionText, 280);
  if (brief) lines.push("", `<i>${esc(brief)}</i>`);
  lines.push("", link(a.sourceUrl));
  return lines.join("\n");
}

export function assignmentRules(diff: Diff<MesaAssignment>, ctx: RuleContext): RuleOutput {
  const out: RuleOutput = { events: [], notifications: [] };
  for (const a of diff.created) {
    out.events.push({ type: "assignment.created", kind: "assignment", sourceId: a.sourceId, payload: { title: a.title, dueAt: a.dueAt }, dedupeKey: `assignment.created:${a.sourceId}` });
    out.notifications.push(draft(ctx, `assignment.created:${a.sourceId}`, "high", assignmentCreatedText(a, ctx.now)));
  }
  for (const { before, after: a } of diff.changed) {
    const prev = before as unknown as MesaAssignment;
    if (prev.dueAt !== a.dueAt) {
      const earlier = !!(prev.dueAt && a.dueAt && Date.parse(a.dueAt) < Date.parse(prev.dueAt));
      out.events.push({ type: "assignment.deadline_changed", kind: "assignment", sourceId: a.sourceId, payload: { from: prev.dueAt, to: a.dueAt }, dedupeKey: `assignment.deadline_changed:${a.sourceId}:${a.dueAt}` });
      out.notifications.push(
        draft(ctx, `assignment.deadline_changed:${a.sourceId}:${a.dueAt}`, earlier ? "urgent" : "high", [
          `🗓️ <b>Deadline ${earlier ? "moved EARLIER" : "changed"}</b>`,
          assignmentHeader(a),
          "",
          `Was: <s>${esc(prev.dueAtIst ?? "none")}</s>`,
          `Now: <b>${esc(a.dueAtIst ?? "none")}</b> (${relative(a.dueAt, ctx.now)})`,
          "",
          link(a.sourceUrl),
        ].join("\n")),
      );
    }
    const prevIds = new Set((prev.materials ?? []).map((m) => m.sourceId));
    const added = a.materials.filter((m) => !prevIds.has(m.sourceId));
    if (added.length) {
      const key = `assignment.material_added:${a.sourceId}:${added.map((m) => m.sourceId).sort().join(",")}`;
      out.events.push({ type: "assignment.material_added", kind: "assignment", sourceId: a.sourceId, payload: { added: added.map((m) => m.title) }, dedupeKey: key });
      out.notifications.push(draft(ctx, key, "high", [`📎 <b>New file on an assignment</b>`, assignmentHeader(a), "", fileList(added), "", link(a.sourceUrl)].join("\n")));
    }
    const edits = (
      [
        ["title", "title"],
        ["descriptionText", "brief"],
        ["instructionsText", "instructions"],
        ["submissionType", "submission type"],
        ["cutoffAt", "late cut-off"],
        ["allowLate", "late policy"],
        ["maxMarks", "marks"],
        ["isGroup", "group setting"],
      ] as const
    ).filter(([k]) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(a[k] ?? null)).map(([, label]) => label);
    if (edits.length) {
      const key = `assignment.updated:${a.sourceId}:${a.contentHash}`;
      out.events.push({ type: "assignment.updated", kind: "assignment", sourceId: a.sourceId, payload: { fields: edits }, dedupeKey: key });
      out.notifications.push(draft(ctx, key, "normal", [`✏️ <b>Assignment updated</b>: ${edits.join(", ")}`, assignmentHeader(a), "", link(a.sourceUrl)].join("\n")));
    }
    if (prev.submissionStatus !== a.submissionStatus) {
      // Recorded for history and future agents; you already know you submitted.
      out.events.push({ type: "assignment.submission_changed", kind: "assignment", sourceId: a.sourceId, payload: { from: prev.submissionStatus, to: a.submissionStatus }, dedupeKey: `assignment.submission_changed:${a.sourceId}:${a.submissionStatus}` });
    }
  }
  for (const r of diff.removed) {
    out.events.push({ type: "assignment.removed", kind: "assignment", sourceId: r.sourceId, payload: { title: r.data.title }, dedupeKey: `assignment.removed:${r.sourceId}:${r.contentHash}` });
  }
  return out;
}

const isPending = (a: MesaAssignment) => a.submissionStatus === "not_submitted" || a.submissionStatus.startsWith("other:");

/** Deadline reminders at 72 h / 24 h / 3 h for work not yet submitted. `suppress` = ids just announced as new. */
export function reminderRules(assignments: MesaAssignment[], ctx: RuleContext, suppress: Set<string>): NotificationDraft[] {
  const out: NotificationDraft[] = [];
  for (const a of assignments) {
    if (!isPending(a)) continue;
    const bucket = reminderBucket(a.dueAt, ctx.now);
    if (!bucket) continue;
    const text = [
      `⏰ <b>Due ${relative(a.dueAt, ctx.now)}</b>`,
      assignmentHeader(a),
      "",
      `Deadline: <b>${esc(a.dueAtIst)}</b>`,
      `Status: not submitted`,
      "",
      link(a.sourceUrl),
    ].join("\n");
    out.push({ ...draft(ctx, `reminder:${a.sourceId}:${bucket.name}:${a.dueAt}`, bucket.priority, text), suppressed: suppress.has(a.sourceId) });
  }
  return out;
}

export function baselineSummary(counts: { courses: number; assignments: MesaAssignment[]; upcomingClasses: number }, ctx: RuleContext): NotificationDraft {
  const soon = counts.assignments
    .filter((a) => isPending(a) && a.dueAt && Date.parse(a.dueAt) > ctx.now.getTime() && Date.parse(a.dueAt) - ctx.now.getTime() <= 7 * DAY)
    .sort((x, y) => (x.dueAt ?? "").localeCompare(y.dueAt ?? ""));
  const lines = [
    `✅ <b>JARVIS is now watching your MESA LMS</b>`,
    `${counts.courses} courses · ${counts.assignments.length} assignments · ${counts.upcomingClasses} upcoming classes`,
    "",
  ];
  if (soon.length) {
    lines.push(`<b>Not submitted, due in the next 7 days:</b>`);
    for (const a of soon) lines.push(`• ${esc(a.dueAtIst)} — ${esc(a.title)}${a.courseTitle ? ` <i>(${esc(clip(a.courseTitle.replace(/\s+with\s+.*$/i, ""), 40))})</i>` : ""}`);
  } else lines.push("Nothing unsubmitted is due in the next 7 days. 🎉");
  lines.push("", "I'll message you when something new appears, a deadline moves, or a deadline gets close.");
  return draft(ctx, "mesa.baseline.summary", "high", lines.join("\n"));
}

// ── classes (calendar events) ────────────────────────────────────────────────

const inHorizon = (iso: string | null | undefined, now: Date) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= now.getTime() && t - now.getTime() <= CLASS_HORIZON;
};

const classLine = (e: MesaEvent) =>
  `<b>${esc(e.courseName ?? "Class")}</b>${e.title !== e.courseName ? `\n${esc(e.title)}` : ""}\n🕘 ${esc(e.startAtIst)}${e.room ? ` · ${esc(e.room)}` : ""}`;

export function eventRules(diff: Diff<MesaEvent>, ctx: RuleContext): RuleOutput {
  const out: RuleOutput = { events: [], notifications: [] };
  for (const e of diff.created) {
    out.events.push({ type: "class.created", kind: "event", sourceId: e.sourceId, payload: { startAt: e.startAt }, dedupeKey: `class.created:${e.sourceId}` });
    if (inHorizon(e.startAt, ctx.now) && e.status !== "cancelled") out.notifications.push(draft(ctx, `class.created:${e.sourceId}`, "normal", `🏫 <b>New class scheduled</b>\n${classLine(e)}`));
  }
  for (const { before, after: e } of diff.changed) {
    const prev = before as unknown as MesaEvent;
    const relevant = inHorizon(e.startAt, ctx.now) || inHorizon(prev.startAt, ctx.now);
    if (e.status === "cancelled" && prev.status !== "cancelled") {
      out.events.push({ type: "class.cancelled", kind: "event", sourceId: e.sourceId, payload: {}, dedupeKey: `class.cancelled:${e.sourceId}:${e.startAt}` });
      if (relevant) out.notifications.push(draft(ctx, `class.cancelled:${e.sourceId}:${e.startAt}`, "high", `❌ <b>Class cancelled</b>\n${classLine(e)}`));
    } else if (prev.startAt !== e.startAt) {
      out.events.push({ type: "class.rescheduled", kind: "event", sourceId: e.sourceId, payload: { from: prev.startAt, to: e.startAt }, dedupeKey: `class.rescheduled:${e.sourceId}:${e.startAt}` });
      if (relevant) out.notifications.push(draft(ctx, `class.rescheduled:${e.sourceId}:${e.startAt}`, "high", `🔁 <b>Class rescheduled</b>\n${classLine(e)}\nWas: <s>${esc(prev.startAtIst)}</s>`));
    } else if (prev.room !== e.room || prev.meetingLink !== e.meetingLink) {
      const key = `class.updated:${e.sourceId}:${e.contentHash}`;
      out.events.push({ type: "class.updated", kind: "event", sourceId: e.sourceId, payload: {}, dedupeKey: key });
      if (relevant) out.notifications.push(draft(ctx, key, "normal", `📍 <b>Class details changed</b>\n${classLine(e)}${e.meetingLink ? `\n${link(e.meetingLink, "Join link")}` : ""}`));
    }
  }
  for (const r of diff.removed) {
    const e = r.data as unknown as MesaEvent;
    out.events.push({ type: "class.removed", kind: "event", sourceId: r.sourceId, payload: {}, dedupeKey: `class.removed:${r.sourceId}:${e.startAt}` });
    if (inHorizon(e.startAt, ctx.now)) out.notifications.push(draft(ctx, `class.removed:${r.sourceId}:${e.startAt}`, "high", `❌ <b>Class removed from the calendar</b>\n${classLine(e)}`));
  }
  return out;
}

// ── announcements, materials, recordings, courses ─────────────────────────────

export function announcementRules(diff: Diff<MesaAnnouncement>, ctx: RuleContext): RuleOutput {
  const out: RuleOutput = { events: [], notifications: [] };
  for (const a of diff.created) {
    const key = `announcement.created:${a.sourceId}`;
    out.events.push({ type: "announcement.created", kind: "announcement", sourceId: a.sourceId, payload: { title: a.title }, dedupeKey: key });
    if (ctx.now.getTime() - Date.parse(a.createdAt) > 7 * DAY) continue; // an old post surfacing via pagination isn't news
    const lines = [`📢 <b>${esc(a.title)}</b>`, `${esc(a.author ?? "MESA")}${a.courseName ? ` · ${esc(a.courseName)}` : ""}`];
    const body = clip(a.bodyText, 500);
    if (body) lines.push("", esc(body));
    if (a.attachments.length) lines.push("", `📎 ${a.attachments.map((f) => esc(f.fileName ?? f.title)).join(", ")}`);
    out.notifications.push(draft(ctx, key, "normal", lines.join("\n")));
  }
  return out;
}

export function materialRules(diff: Diff<MesaMaterial>, ctx: RuleContext): RuleOutput {
  const out: RuleOutput = { events: [], notifications: [] };
  for (const m of diff.created) {
    const key = `material.added:${m.sourceId}`;
    out.events.push({ type: "material.added", kind: "material", sourceId: m.sourceId, payload: { courseId: m.courseId, title: m.title }, dedupeKey: key });
    const type = m.kind === "file" ? (m.mimeOrType ?? "file").toUpperCase() : m.kind;
    out.notifications.push(
      draft(ctx, key, "normal", `📚 <b>New class material</b>\n<b>${esc(ctx.courseTitle(m.courseId) ?? "Course")}</b>\n${esc(m.topicTitle)}: ${esc(m.title)} <i>(${esc(type)})</i>`),
    );
  }
  for (const { after: m } of diff.changed) {
    out.events.push({ type: "material.updated", kind: "material", sourceId: m.sourceId, payload: {}, dedupeKey: `material.updated:${m.sourceId}:${m.contentHash}` });
  }
  return out;
}

export function recordingRules(diff: Diff<MesaRecording>, ctx: RuleContext): RuleOutput {
  const out: RuleOutput = { events: [], notifications: [] };
  for (const r of diff.created) {
    const key = `recording.added:${r.sourceId}`;
    out.events.push({ type: "recording.added", kind: "recording", sourceId: r.sourceId, payload: {}, dedupeKey: key });
    out.notifications.push(
      draft(ctx, key, "low", `🎥 <b>New class recording</b>\n<b>${esc(ctx.courseTitle(r.courseId) ?? "Course")}</b>\n${esc(r.title)}${r.videoUrl ? `\n${link(r.videoUrl, "Watch")}` : ""}`),
    );
  }
  return out;
}

export function courseRules(diff: Diff<MesaCourse>, ctx: RuleContext): RuleOutput {
  const out: RuleOutput = { events: [], notifications: [] };
  for (const c of diff.created) {
    const key = `course.created:${c.sourceId}`;
    out.events.push({ type: "course.created", kind: "course", sourceId: c.sourceId, payload: { title: c.title }, dedupeKey: key });
    out.notifications.push(draft(ctx, key, "normal", `🎓 <b>New course on the LMS</b>\n${esc(c.title)}${c.instructor ? ` — ${esc(c.instructor)}` : ""}\n${link(c.sourceUrl)}`));
  }
  return out;
}

export type { StoredItem };
