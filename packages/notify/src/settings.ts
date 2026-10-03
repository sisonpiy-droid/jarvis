import { z } from "zod";

// Owner notification preferences (jarvis.settings key "notifications"). Missing or invalid fields fall back
// to the defaults, so a bad save can never stop delivery.

export const LEVELS = ["urgent", "high", "normal", "low"] as const;
export type Level = (typeof LEVELS)[number];

export const SETTINGS_KEY = "notifications";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const route = z.object({
  /** always · daytime (08:00–21:00 IST) · never */
  push: z.enum(["always", "daytime", "never"]),
  /** immediate · escalate (only if still unread after escalateAfterMinutes) · never */
  email: z.enum(["immediate", "escalate", "never"]),
});
export type Route = z.infer<typeof route>;

export const settingsSchema = z.object({
  routes: z.object({ urgent: route, high: route, normal: route, low: route }),
  quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
  daytime: z.object({ start: hhmm, end: hhmm }),
  /** Most pushes per rolling hour; critical items ignore the cap. */
  pushPerHour: z.number().int().min(1).max(60),
  escalateAfterMinutes: z.number().int().min(5).max(24 * 60),
  /** Categories that never push (they still land in the inbox). */
  mutedCategories: z.array(z.string()).max(20),
  /**
   * Legacy Telegram channel (kept for rollback until Phase 11):
   *  off      — never used
   *  fallback — used when no push device is registered, or a critical/high push fails
   *  mirror   — receives everything, as before Phase 1
   */
  telegram: z.enum(["off", "fallback", "mirror"]),
});
export type NotificationSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: NotificationSettings = {
  routes: {
    urgent: { push: "always", email: "escalate" },
    high: { push: "always", email: "never" },
    normal: { push: "daytime", email: "never" },
    low: { push: "never", email: "never" },
  },
  quietHours: { enabled: true, start: "01:00", end: "07:00" },
  daytime: { start: "08:00", end: "21:00" },
  pushPerHour: 6,
  escalateAfterMinutes: 30,
  mutedCategories: [],
  telegram: "fallback",
};

/** Deep-merges stored values over the defaults, then validates; anything invalid → defaults for that part. */
export function parseSettings(stored: unknown): NotificationSettings {
  if (!stored || typeof stored !== "object") return structuredClone(DEFAULT_SETTINGS);
  const s = stored as Record<string, unknown>;
  const merged = {
    ...DEFAULT_SETTINGS,
    ...s,
    routes: { ...DEFAULT_SETTINGS.routes, ...((s.routes as object | undefined) ?? {}) },
    quietHours: { ...DEFAULT_SETTINGS.quietHours, ...((s.quietHours as object | undefined) ?? {}) },
    daytime: { ...DEFAULT_SETTINGS.daytime, ...((s.daytime as object | undefined) ?? {}) },
  };
  const parsed = settingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Keep every top-level field that is valid on its own.
  const out = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
  for (const [k, schema] of Object.entries(settingsSchema.shape)) {
    const one = (schema as z.ZodType).safeParse((merged as Record<string, unknown>)[k]);
    if (one.success) out[k] = one.data;
  }
  return out as NotificationSettings;
}
