import type { Priority } from "@jarvis/db";

const IST_OFFSET_MS = 330 * 60_000; // Asia/Kolkata has no DST
const HOUR = 3_600_000;

/** Hour of day (0–23) in IST. */
export function istHour(now: Date): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
}

export const QUIET_START = 1; // 01:00 IST
export const QUIET_END = 7; //   07:00 IST

/**
 * When a notification may go out: immediately, unless it's quiet hours and the
 * item isn't urgent — then at 07:00 IST.
 */
export function deliveryTime(priority: Priority, now: Date): Date {
  if (priority === "urgent") return now;
  const h = istHour(now);
  if (h < QUIET_START || h >= QUIET_END) return now;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(QUIET_END, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/** "in 3 h", "in 2 days", "overdue by 5 h". */
export function relative(target: string | null | undefined, now: Date): string {
  if (!target) return "no deadline";
  const ms = Date.parse(target) - now.getTime();
  const abs = Math.abs(ms);
  const txt = abs < HOUR ? `${Math.max(1, Math.round(abs / 60_000))} min` : abs < 48 * HOUR ? `${Math.round(abs / HOUR)} h` : `${Math.round(abs / (24 * HOUR))} days`;
  return ms >= 0 ? `in ${txt}` : `overdue by ${txt}`;
}

export const REMINDER_BUCKETS = [
  { name: "T-3h", ms: 3 * HOUR, priority: "urgent" as const },
  { name: "T-24h", ms: 24 * HOUR, priority: "high" as const },
  { name: "T-72h", ms: 72 * HOUR, priority: "normal" as const },
];

/** The tightest reminder window a deadline currently falls in, or null if it's further out (or past). */
export function reminderBucket(dueAt: string | null, now: Date) {
  if (!dueAt) return null;
  const left = Date.parse(dueAt) - now.getTime();
  if (!(left > 0)) return null;
  return REMINDER_BUCKETS.find((b) => left <= b.ms) ?? null;
}
