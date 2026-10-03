// Category and dashboard deep link for a notification, derived from its dedupe key. Producers keep writing
// only dedupe key + text; this keeps every existing rule unchanged. Pure, deterministic, no AI.

export type NotificationCategory =
  | "deadline"
  | "assignment"
  | "class"
  | "announcement"
  | "material"
  | "calendar"
  | "brief"
  | "draft"
  | "reminder"
  | "habit"
  | "goal"
  | "task"
  | "system";

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "deadline",
  "assignment",
  "class",
  "announcement",
  "material",
  "calendar",
  "brief",
  "draft",
  "reminder",
  "habit",
  "goal",
  "task",
  "system",
];

export interface NotificationMeta {
  category: NotificationCategory;
  /** Path inside the dashboard (always starts with "/"). */
  url: string;
}

const seg = (key: string, i: number) => key.split(":")[i] ?? "";
const path = (base: string, id: string) => (id ? `${base}/${encodeURIComponent(id)}` : base);

export function notificationMeta(dedupeKey: string): NotificationMeta {
  const [prefix = ""] = dedupeKey.split(":");
  const [family = "", event = ""] = prefix.split(".");
  switch (family) {
    case "reminder": // reminder:<assignmentId>:<bucket>:<due>
      return { category: "deadline", url: path("/assignments", seg(dedupeKey, 1)) };
    case "assignment":
      return { category: event === "deadline_changed" ? "deadline" : "assignment", url: event === "removed" ? "/assignments" : path("/assignments", seg(dedupeKey, 1)) };
    case "class":
      return { category: "class", url: "/classes" };
    case "gcal":
      return { category: "calendar", url: "/classes" };
    case "announcement":
      return { category: "announcement", url: "/" };
    case "material":
    case "recording":
    case "course":
      return { category: "material", url: "/" };
    case "brief":
      return { category: "brief", url: "/" };
    case "draft": // draft.done:<draftId>
      return { category: "draft", url: path("/drafts", seg(dedupeKey, 1)) };
    case "user":
      return { category: "reminder", url: "/inbox" };
    case "habit": // habit.reminder:<habitId>:<YYYY-MM-DD> → the one-tap check-in page
      if (event === "reminder") return { category: "habit", url: `${path("/q/habit", seg(dedupeKey, 1))}${seg(dedupeKey, 2) ? `?d=${encodeURIComponent(seg(dedupeKey, 2))}` : ""}` };
      return { category: "habit", url: "/goals" };
    case "goal": // goal.risk:<goalId>:… / goal.neglect:<goalId>:…
      return { category: "goal", url: path("/goals", seg(dedupeKey, 1)) };
    case "task": // task.due:<taskId>:<due> / task.prep:<taskId>:<due>
      return { category: "task", url: "/tasks" };
    case "mesa":
      return { category: "system", url: "/status" };
    case "memory": // memory.review:v1 — the one-time review of old goal/project notes
      return { category: "system", url: "/settings/memory" };
    default:
      return { category: "system", url: "/inbox" };
  }
}
