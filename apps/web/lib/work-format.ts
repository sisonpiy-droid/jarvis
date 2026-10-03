import type { Task } from "@jarvis/db";

// Display helpers for tasks and projects (IST). Safe for server and client.

export const KIND_LABEL: Record<string, string> = {
  mesa_assignment: "Assignment",
  exam: "Exam",
  case_comp: "Case competition",
  startup: "Startup",
  job_search: "Job search",
  product: "Product",
  research: "Research",
  personal: "Personal",
  other: "Project",
};

const IST = "Asia/Kolkata";
/** YYYY-MM-DD and HH:MM in IST, for date/time inputs. */
export function istParts(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}` };
}

export const fmtDate = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));

/** Where a MESA-managed task points on the LMS side. */
export function sourceLink(t: Pick<Task, "source" | "sourceRef">): { href: string; label: string } | null {
  if (t.source !== "mesa" || !t.sourceRef) return null;
  const [, kind, id] = t.sourceRef.split(":");
  if (!id) return null;
  if (kind === "submit" || kind === "review") return { href: `/assignments/${id}`, label: "Assignment" };
  if (kind === "prep") return { href: "/classes", label: "Exam" };
  return null;
}
