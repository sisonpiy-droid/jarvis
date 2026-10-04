import type { Sql } from "./client";

// How the owner actually works, worked out from their own data — no AI. Real submission times (read from the LMS),
// tasks completed and when, and tasks pushed again and again. A pattern is only stated with enough data behind it,
// so early on most of this says nothing rather than something wrong.

export const MIN_FOR_PATTERN = 4;
/** Submitted within this many hours of the deadline counts as "last minute". */
export const LAST_MINUTE_HOURS = 3;

export interface CourseHabit {
  course: string;
  n: number;
  medianLeadHours: number;
  late: number;
}

export interface WorkPatterns {
  submissions: { known: number; medianLeadHours: number | null; lastMinute: number; submitted: number; late: number; lateCourses: string[]; tightest: CourseHabit | null };
  /** When work gets finished (submission times + own tasks done), by part of day, IST. */
  peak: { label: string; n: number; of: number } | null;
  ownTasks: { withDue: number; onTime: number };
  postponed: Array<{ id: number; title: string; times: number }>;
  /** Plain sentences for prompts and the check-in; empty when there's nothing solid yet. */
  lines: string[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** "6 h", "2 days", "40 min". */
export function fmtLead(hours: number): string {
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1) return `${Math.round(hours)} h`;
  return `${Math.max(1, Math.round(hours * 60))} min`;
}

const PARTS: Array<{ label: string; from: number; to: number }> = [
  { label: "in the morning (6 am–12 pm)", from: 6, to: 12 },
  { label: "in the afternoon (12–5 pm)", from: 12, to: 17 },
  { label: "in the evening (5–9 pm)", from: 17, to: 21 },
  { label: "at night (9 pm–2 am)", from: 21, to: 26 },
  { label: "in the small hours (2–6 am)", from: 2, to: 6 },
];
export function partOfDay(istHour: number): string {
  const h = istHour < 2 ? istHour + 24 : istHour;
  return (PARTS.find((p) => h >= p.from && h < p.to) ?? PARTS[4]!).label;
}
const istHourOf = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).getUTCHours();
const ms = (v: unknown) => new Date(v as string).getTime();
const isoOf = (v: unknown) => new Date(v as string).toISOString();

export async function workPatterns(sql: Sql, now: Date): Promise<WorkPatterns> {
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const [subs, counts, done, postponed] = await Promise.all([
    sql`
      select s.submitted_at, i.sort_at as due_at, coalesce(i.data ->> 'courseTitle', 'Other') as course
        from jarvis.submissions s join jarvis.lms_items i on i.kind = 'assignment' and i.source_id = s.assignment_id
       where s.submitted_at is not null and i.sort_at is not null`,
    sql`
      select coalesce(data ->> 'courseTitle', 'Other') as course,
             count(*) filter (where data ->> 'submissionStatus' like 'submitted%')::int as submitted,
             count(*) filter (where data ->> 'submissionStatus' = 'submitted_late')::int as late
        from jarvis.lms_items where kind = 'assignment' and removed_at is null group by 1`,
    sql`select completed_at, due_at from jarvis.tasks where status = 'done' and source <> 'mesa' and completed_at >= ${since}`,
    sql`select id, title, postponed_count from jarvis.tasks where status in ('todo', 'doing') and postponed_count >= 2 order by postponed_count desc, id limit 5`,
  ]);

  const leads = subs.map((r) => ({ course: String(r.course).replace(/\s+with\s+.*$/i, ""), lead: (ms(r.due_at) - ms(r.submitted_at)) / 3_600_000 }));
  const onTimeLeads = leads.filter((l) => l.lead >= 0).map((l) => l.lead);
  const byCourse = new Map<string, number[]>();
  for (const l of leads) byCourse.set(l.course, [...(byCourse.get(l.course) ?? []), l.lead]);
  const lateBy = new Map(counts.map((c) => [String(c.course).replace(/\s+with\s+.*$/i, ""), Number(c.late)]));
  const courses: CourseHabit[] = [...byCourse].filter(([, xs]) => xs.length >= 3).map(([course, xs]) => ({ course, n: xs.length, medianLeadHours: median(xs)!, late: lateBy.get(course) ?? 0 }));
  const tightest = courses.length > 1 ? [...courses].sort((a, b) => a.medianLeadHours - b.medianLeadHours)[0]! : null;
  const submitted = counts.reduce((n, c) => n + Number(c.submitted), 0);
  const late = counts.reduce((n, c) => n + Number(c.late), 0);

  const finishTimes = [...subs.map((r) => isoOf(r.submitted_at)), ...done.map((r) => isoOf(r.completed_at))];
  const parts = new Map<string, number>();
  for (const t of finishTimes) {
    const part = partOfDay(istHourOf(t));
    parts.set(part, (parts.get(part) ?? 0) + 1);
  }
  const top = [...parts].sort((a, b) => b[1] - a[1])[0];
  const peak = top && finishTimes.length >= MIN_FOR_PATTERN && top[1] / finishTimes.length >= 0.4 ? { label: top[0], n: top[1], of: finishTimes.length } : null;

  const withDue = done.filter((r) => r.due_at);
  const ownTasks = { withDue: withDue.length, onTime: withDue.filter((r) => ms(r.completed_at) <= ms(r.due_at)).length };

  const p: WorkPatterns = {
    submissions: {
      known: leads.length,
      medianLeadHours: onTimeLeads.length >= MIN_FOR_PATTERN ? median(onTimeLeads) : null,
      lastMinute: onTimeLeads.filter((h) => h < LAST_MINUTE_HOURS).length,
      submitted,
      late,
      lateCourses: [...lateBy].filter(([, n]) => n > 0).map(([c]) => c),
      tightest,
    },
    peak,
    ownTasks,
    postponed: postponed.map((r) => ({ id: Number(r.id), title: String(r.title), times: Number(r.postponed_count) })),
    lines: [],
  };
  p.lines = patternLines(p);
  return p;
}

/** The patterns as short factual sentences. */
export function patternLines(p: WorkPatterns): string[] {
  const out: string[] = [];
  const s = p.submissions;
  if (s.medianLeadHours != null)
    out.push(`Submits MESA work a median ${fmtLead(s.medianLeadHours)} before the deadline (${s.known} submission times known; ${s.lastMinute} within the last ${LAST_MINUTE_HOURS} h).`);
  if (s.submitted >= MIN_FOR_PATTERN) out.push(`Late submissions: ${s.late} of ${s.submitted}${s.lateCourses.length ? ` (${s.lateCourses.join(", ")})` : ""}.`);
  if (s.tightest && s.medianLeadHours != null && s.tightest.medianLeadHours < s.medianLeadHours / 2)
    out.push(`Cuts it closest in ${s.tightest.course}: a median ${fmtLead(s.tightest.medianLeadHours)} before the deadline.`);
  if (p.peak) out.push(`Gets most work finished ${p.peak.label} (${p.peak.n} of the last ${p.peak.of}).`);
  if (p.ownTasks.withDue >= MIN_FOR_PATTERN) out.push(`Own dated tasks: ${p.ownTasks.onTime} of ${p.ownTasks.withDue} done on time.`);
  for (const t of p.postponed) out.push(`Keeps postponing "${t.title}" (moved ${t.times} times) [task #${t.id}].`);
  return out;
}
