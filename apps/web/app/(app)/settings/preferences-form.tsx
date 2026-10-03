"use client";

import { useActionState } from "react";
import type { NotificationSettings } from "@jarvis/notify";
import { saveNotificationSettings, type SaveState } from "./actions";

const LEVELS = [
  ["urgent", "Critical", "Session expired, deadline moved earlier, due in 3 h"],
  ["high", "High", "New assignment, class cancelled or moved, due tomorrow"],
  ["normal", "Normal", "Announcements, morning brief, due in 3 days"],
  ["low", "Low", "New recordings and materials"],
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  deadline: "Deadlines",
  assignment: "Assignments",
  class: "Classes",
  announcement: "Announcements",
  material: "Materials & recordings",
  calendar: "Google Calendar",
  brief: "Morning brief",
  draft: "Drafts",
  reminder: "Your reminders",
  system: "System",
};

const field = "rounded-lg border border-[var(--color-line)] bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";

export function PreferencesForm({ settings, categories, telegramConfigured }: { settings: NotificationSettings; categories: readonly string[]; telegramConfigured: boolean }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveNotificationSettings, { status: "idle" });
  return (
    <form action={action} className="space-y-5 text-sm">
      <div>
        <p className="mb-2 font-medium">What reaches you, by importance</p>
        <p className="mb-2 text-[var(--color-muted)]">Everything always lands in the inbox. These choose what also goes to your phone or email.</p>
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[480px]">
            <thead className="text-left text-[var(--color-muted)]">
              <tr>
                <th className="py-1 pl-4 font-medium sm:pl-0">Level</th>
                <th className="font-medium">Push</th>
                <th className="pr-4 font-medium sm:pr-0">Email</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {LEVELS.map(([key, label, hint]) => (
                <tr key={key}>
                  <td className="py-2 pl-4 sm:pl-0">
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-[var(--color-muted)]">{hint}</span>
                  </td>
                  <td>
                    <select name={`push_${key}`} defaultValue={settings.routes[key].push} className={field}>
                      <option value="always">Always</option>
                      <option value="daytime">Daytime only</option>
                      <option value="never">Never</option>
                    </select>
                  </td>
                  <td className="pr-4 sm:pr-0">
                    <select name={`email_${key}`} defaultValue={settings.routes[key].email} className={field}>
                      <option value="never">Never</option>
                      <option value="escalate">If unread after {settings.escalateAfterMinutes} min</option>
                      <option value="immediate">Immediately</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium">Quiet hours (IST)</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="quiet_enabled" defaultChecked={settings.quietHours.enabled} /> Hold everything except critical
          </label>
          <div className="flex items-center gap-2">
            <input type="time" name="quiet_start" defaultValue={settings.quietHours.start} className={field} aria-label="Quiet hours start" /> to
            <input type="time" name="quiet_end" defaultValue={settings.quietHours.end} className={field} aria-label="Quiet hours end" />
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium">“Daytime” (IST)</legend>
          <div className="flex items-center gap-2">
            <input type="time" name="day_start" defaultValue={settings.daytime.start} className={field} aria-label="Daytime start" /> to
            <input type="time" name="day_end" defaultValue={settings.daytime.end} className={field} aria-label="Daytime end" />
          </div>
        </fieldset>
        <label className="space-y-1">
          <span className="block font-medium">Most pushes per hour</span>
          <input type="number" name="push_per_hour" min={1} max={60} defaultValue={settings.pushPerHour} className={`${field} w-24`} />
          <span className="block text-xs text-[var(--color-muted)]">Extra ones wait in the inbox. Critical items are never capped.</span>
        </label>
        <label className="space-y-1">
          <span className="block font-medium">Email unread critical items after</span>
          <span className="flex items-center gap-2">
            <input type="number" name="escalate_after" min={5} max={1440} defaultValue={settings.escalateAfterMinutes} className={`${field} w-24`} /> minutes
          </span>
        </label>
      </div>

      <fieldset>
        <legend className="mb-1 font-medium">Never push these (inbox only)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {categories.map((c) => (
            <label key={c} className="flex items-center gap-1.5">
              <input type="checkbox" name={`mute_${c}`} defaultChecked={settings.mutedCategories.includes(c)} /> {CATEGORY_LABEL[c] ?? c}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1">
        <span className="block font-medium">Telegram (legacy)</span>
        <select name="telegram" defaultValue={settings.telegram} className={field}>
          <option value="fallback">Fallback: only if no phone is set up, or a critical push fails</option>
          <option value="off">Off: never use Telegram</option>
          <option value="mirror">Mirror: send everything to Telegram too (old behaviour)</option>
        </select>
        {!telegramConfigured && <span className="block text-xs text-[var(--color-muted)]">Telegram isn&apos;t configured, so this has no effect.</span>}
      </label>

      <div className="flex items-center gap-3">
        <button disabled={pending} className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 font-medium text-white disabled:opacity-50">
          {pending ? "Saving…" : "Save preferences"}
        </button>
        {state.status === "saved" && <span className="text-[var(--color-good)]">Saved ✓</span>}
        {state.status === "error" && <span className="text-[var(--color-bad)]">{state.message}</span>}
      </div>
    </form>
  );
}
