// The chat page's display model, shared by the server page and the client chat box. No imports on purpose:
// the client bundle must not pull in @jarvis/ai or @jarvis/db (they bring postgres with them). lib/chat.ts adds
// toChatView, which needs the server-side Markdown converter.

/** One bubble or divider on the chat page. `html` is already safe (escaped user text, or the escape-first converter's output). */
export interface ChatView {
  id: number;
  role: "user" | "jarvis" | "marker";
  html: string;
  at: string;
  /** "9:02 am" (IST). */
  timeLabel: string;
  /** "Today", "Yesterday" or "Mon 28 Sep" (IST); the sticky day separator. */
  dayLabel: string;
  /** Plain labels of the tools the answer checked ("focus list", "your week"). */
  sources: string[];
  /** The grounding guard fired on this answer: it was repaired, or some details couldn't be verified. */
  guarded: boolean;
}

/** Tool name → what the caption calls it. Tools that change data are not "checked", so they are left out. */
export const TOOL_LABEL: Record<string, string> = {
  get_focus: "focus list",
  get_week: "your week",
  get_attention: "risks",
  get_accomplished: "done items",
  get_commitments: "commitments",
  list_tasks: "tasks",
  list_goals: "goals",
  get_goal: "goals",
  list_projects: "projects",
  get_project: "project",
  get_assignment: "assignment",
  get_upcoming_assignments: "assignments",
  get_schedule: "schedule",
  search_lms: "LMS search",
  get_course_materials: "course materials",
  read_file_text: "files",
  get_announcements: "announcements",
  get_recent_updates: "LMS updates",
  get_status: "system status",
  search_memory: "memory",
};

const WRITE_TOOL = /^(create|update|log|respond|save|forget|resolve|draft|revise|add)_/;

/** Unique caption labels for the tools an answer used, in call order. An unknown read tool reads as its name. */
export function sourceLabels(tools: string[]): string[] {
  const out: string[] = [];
  for (const name of tools) {
    const label = TOOL_LABEL[name] ?? (WRITE_TOOL.test(name) ? null : name.replace(/^(get|list|search)_/, "").replace(/_/g, " "));
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Formatted by hand from a +05:30 shift (not Intl), so the server and the browser always agree.
const ist = (t: number) => new Date(t + IST_MS);
const istDayNo = (t: number) => Math.floor((t + IST_MS) / DAY_MS);

/** "9:02 am" (IST). */
export function timeLabel(iso: string): string {
  const d = ist(Date.parse(iso));
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "Today", "Yesterday", "Mon 28 Sep", or "Mon 28 Sep 2025" for another year (IST days). */
export function dayLabel(iso: string, now: Date): string {
  const t = Date.parse(iso);
  const diff = istDayNo(now.getTime()) - istDayNo(t);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = ist(t);
  const label = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === ist(now.getTime()).getUTCFullYear() ? label : `${label} ${d.getUTCFullYear()}`;
}

export const escapeChatText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The muted line under a JARVIS bubble: "Checked: focus list · your week · 9:02 am". */
export function chatCaption(v: Pick<ChatView, "sources" | "timeLabel" | "guarded">): string {
  const parts = [...(v.sources.length ? [`Checked: ${v.sources.join(" · ")}`] : []), v.timeLabel];
  if (v.guarded) parts.push("some details couldn't be verified");
  return parts.join(" · ");
}

/**
 * Where to draw "Earlier messages aren't in JARVIS's short-term context": before the item with `contextStartId`,
 * and only when an earlier message is shown and no "New conversation" divider already sits right before it.
 * Returns that item's index, or -1.
 */
export function contextDividerIndex(items: Array<Pick<ChatView, "id" | "role">>, contextStartId: number | null): number {
  if (contextStartId == null) return -1;
  const i = items.findIndex((it) => it.id === contextStartId);
  if (i <= 0 || items[i - 1]!.role === "marker") return -1;
  return items.slice(0, i).some((it) => it.role !== "marker") ? i : -1;
}

/** Consecutive items grouped under their day separator. */
export function groupByDay<T extends Pick<ChatView, "dayLabel">>(items: T[]): Array<{ day: string; items: T[] }> {
  const out: Array<{ day: string; items: T[] }> = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.day === it.dayLabel) last.items.push(it);
    else out.push({ day: it.dayLabel, items: [it] });
  }
  return out;
}

/** The one-tap starters shown on an empty conversation, or right after "New conversation". */
export const CHAT_STARTERS = [
  "What should I focus on today?",
  "What am I falling behind on?",
  "What's due this week?",
  "What did I accomplish this week?",
  "What should I defer?",
  "Review my week.",
];
