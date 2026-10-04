import type { Level, NotificationSettings } from "./settings";

// Routing policy: which channels a notification goes to, and when. Pure and deterministic — no AI, no I/O.
// The in-app inbox always gets every routed notification; this decides only the external channels.

const IST_OFFSET_MIN = 330;

/** Minutes since midnight, IST. */
export function istMinutes(now: Date): number {
  return Math.floor(((now.getTime() / 60_000 + IST_OFFSET_MIN) % 1440) + 1440) % 1440;
}

const toMin = (hhmm: string) => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

/** True if `now` (IST) falls in [start, end); the window may wrap past midnight. */
export function inWindow(now: Date, start: string, end: string): boolean {
  const t = istMinutes(now);
  const a = toMin(start);
  const b = toMin(end);
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

export const inQuietHours = (now: Date, s: NotificationSettings) => s.quietHours.enabled && inWindow(now, s.quietHours.start, s.quietHours.end);
export const isDaytime = (now: Date, s: NotificationSettings) => inWindow(now, s.daytime.start, s.daytime.end);

export interface ChannelAvailability {
  /** At least one active push subscription and VAPID keys configured. */
  push: boolean;
  /** Email provider configured. */
  email: boolean;
  /** Telegram configured (legacy). */
  telegram: boolean;
}

export interface RoutingDecision {
  /** Not now: quiet hours — stays queued and is routed when they end. Critical items are never deferred. */
  defer: boolean;
  /** External deliveries to create now. */
  deliveries: Array<{ channel: "push" | "email" | "telegram"; reason: string }>;
  /** Email later if still unread (critical items). */
  escalate: boolean;
}

export function route(n: { priority: Level; category: string }, s: NotificationSettings, now: Date, avail: ChannelAvailability): RoutingDecision {
  const critical = n.priority === "urgent";
  if (!critical && inQuietHours(now, s)) return { defer: true, deliveries: [], escalate: false };

  const r = s.routes[n.priority];
  const deliveries: RoutingDecision["deliveries"] = [];
  // Learned quiet: categories the owner keeps ignoring push no more — unless the item is high or urgent.
  const learned = (s.learnedQuiet ?? []).includes(n.category) && (n.priority === "normal" || n.priority === "low");
  const muted = s.mutedCategories.includes(n.category) || learned;
  const wantsPush = !muted && (r.push === "always" || (r.push === "daytime" && isDaytime(now, s)));
  if (wantsPush && avail.push) deliveries.push({ channel: "push", reason: "route" });

  let escalate = false;
  if (avail.email) {
    // Escalation needs a first channel to escalate from; without push, send the email straight away.
    if (r.email === "immediate" || (r.email === "escalate" && !avail.push)) deliveries.push({ channel: "email", reason: "route" });
    else if (r.email === "escalate") escalate = true;
  }

  if (avail.telegram) {
    if (s.telegram === "mirror") deliveries.push({ channel: "telegram", reason: "mirror" });
    // Until a push device exists, Telegram keeps receiving what it always did — nothing is lost during the move.
    else if (s.telegram === "fallback" && !avail.push) deliveries.push({ channel: "telegram", reason: "fallback:no_device" });
  }
  return { defer: false, deliveries, escalate };
}

/** After a push fails for good: should Telegram take over? (critical/high only, fallback mode) */
export const telegramFallbackOnPushFailure = (priority: Level, s: NotificationSettings, telegramAvailable: boolean) =>
  telegramAvailable && s.telegram === "fallback" && (priority === "urgent" || priority === "high");

/** How many pending pushes may go out now under the hourly cap; critical items are exempt. */
export function pushBudget(sentLastHour: number, s: NotificationSettings): number {
  return Math.max(0, s.pushPerHour - sentLastHour);
}
