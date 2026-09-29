import * as db from "@jarvis/db";
import type { ChangeSet, NotificationDraft, Sql, StoredItem } from "@jarvis/db";
import { readCalendar, type GcalEvent } from "@jarvis/calendar";
import { esc } from "@jarvis/notify";
import type { Logger } from "@jarvis/shared";
import { diffItems, type Diff } from "./diff";
import { deliveryTime } from "./time";

// Google Calendar (private iCal feed): new/moved/cancelled events in the next
// week, and a heads-up ~30 minutes before each timed event. Same diff, dedupe
// and baseline rules as the LMS.

const PROVIDER = "gcal";
const KIND = "gcal_event" as const;
const HORIZON = 7 * 86_400_000;
const HEADS_UP_MS = 35 * 60_000; // runs every 5 min → fires 30–35 min before

const line = (e: GcalEvent) => `<b>${esc(e.title)}</b>\n🕘 ${esc(e.startAtIst)}${e.room ? ` · ${esc(e.room)}` : ""}`;
const soon = (iso: string, now: Date) => {
  const t = Date.parse(iso) - now.getTime();
  return t >= 0 && t <= HORIZON;
};

export function calendarRules(diff: Diff<GcalEvent>, now: Date): { notifications: NotificationDraft[]; events: ChangeSet["events"] } {
  const n: NotificationDraft[] = [];
  const events: ChangeSet["events"] = [];
  const add = (key: string, priority: NotificationDraft["priority"], text: string) =>
    n.push({ dedupeKey: key, priority, text, scheduledFor: deliveryTime(priority, now).toISOString() });

  for (const e of diff.created) {
    events.push({ type: "gcal.created", kind: KIND, sourceId: e.sourceId, payload: { startAt: e.startAt }, dedupeKey: `gcal.created:${e.sourceId}` });
    // Recurring series expand into new instances as the window rolls forward; only one-offs are news.
    if (!e.recurring && e.status !== "cancelled" && soon(e.startAt, now)) add(`gcal.created:${e.sourceId}`, "normal", `📅 <b>New calendar event</b>\n${line(e)}`);
  }
  for (const { before, after: e } of diff.changed) {
    const prev = before as unknown as GcalEvent;
    const relevant = soon(e.startAt, now) || soon(prev.startAt, now);
    if (e.status === "cancelled" && prev.status !== "cancelled") {
      events.push({ type: "gcal.cancelled", kind: KIND, sourceId: e.sourceId, payload: {}, dedupeKey: `gcal.cancelled:${e.sourceId}` });
      if (relevant) add(`gcal.cancelled:${e.sourceId}`, "high", `❌ <b>Event cancelled</b>\n${line(e)}`);
    } else if (prev.startAt !== e.startAt) {
      events.push({ type: "gcal.moved", kind: KIND, sourceId: e.sourceId, payload: { from: prev.startAt, to: e.startAt }, dedupeKey: `gcal.moved:${e.sourceId}:${e.startAt}` });
      if (relevant) add(`gcal.moved:${e.sourceId}:${e.startAt}`, "high", `🔁 <b>Event moved</b>\n${line(e)}\nWas: <s>${esc(prev.startAtIst)}</s>`);
    }
  }
  for (const r of diff.removed) {
    const e = r.data as unknown as GcalEvent;
    events.push({ type: "gcal.removed", kind: KIND, sourceId: r.sourceId, payload: {}, dedupeKey: `gcal.removed:${r.sourceId}` });
    if (!e.recurring && soon(e.startAt, now)) add(`gcal.removed:${r.sourceId}`, "high", `❌ <b>Event removed from your calendar</b>\n${line(e)}`);
  }
  return { notifications: n, events };
}

/**
 * Heads-up ~30 min before timed one-off events (urgent: an event at 2 am still deserves a nudge).
 * Recurring routines are skipped — you know your daily 8:30 — unless includeRecurring is set.
 */
export function headsUps(evts: GcalEvent[], now: Date, includeRecurring = false): NotificationDraft[] {
  return evts
    .filter((e) => !e.allDay && e.status !== "cancelled" && (includeRecurring || !e.recurring))
    .filter((e) => {
      const t = Date.parse(e.startAt) - now.getTime();
      return t > 0 && t <= HEADS_UP_MS;
    })
    .map((e) => ({
      dedupeKey: `gcal.soon:${e.sourceId}:${e.startAt}`,
      priority: "urgent" as const,
      text: `⏳ <b>In ${Math.max(1, Math.round((Date.parse(e.startAt) - now.getTime()) / 60_000))} min</b>\n${line(e)}`,
      scheduledFor: now.toISOString(),
    }));
}

export interface CalendarSyncResult {
  events: number;
  created: number;
  changed: number;
  removed: number;
  queued: number;
}

export async function syncCalendar(sql: Sql, icsUrl: string, now: Date, log?: Logger, fetchImpl?: typeof fetch): Promise<CalendarSyncResult> {
  const read = await readCalendar(icsUrl, now, fetchImpl ? { fetch: fetchImpl } : {});
  const existing = await db.loadItems(sql, KIND as db.ItemKind);
  const diff = diffItems(existing, read.events, {
    enabled: true,
    inScope: (s: StoredItem) => !!s.sortAt && s.sortAt >= read.window.from && s.sortAt <= read.window.to,
  });
  const integ = await db.getIntegration(sql, PROVIDER);
  const baselined = integ?.baselinedKinds.includes(KIND) ?? false;
  const row = (e: GcalEvent): db.ItemRow => ({ kind: KIND as db.ItemKind, sourceId: e.sourceId, contentHash: e.contentHash, data: e, courseId: null, title: e.title, sortAt: e.startAt });

  const rules = baselined ? calendarRules(diff, now) : { notifications: [], events: [] };
  const cs: ChangeSet = {
    upserts: [...diff.created, ...diff.changed.map((c) => c.after), ...diff.reappeared].map(row),
    versions: [...diff.created, ...diff.changed.map((c) => c.after)].map(row),
    touched: [{ kind: KIND as db.ItemKind, sourceIds: diff.unchanged.map((e) => e.sourceId) }],
    removed: [{ kind: KIND as db.ItemKind, sourceIds: diff.removed.map((r) => r.sourceId) }],
    events: rules.events,
    notifications: [...rules.notifications, ...headsUps(read.events, now)],
  };
  const { newNotifications } = await db.applyChanges(sql, cs);
  await db.recordSuccess(sql, PROVIDER, { full: true, baselined: baselined ? [] : [KIND] });
  const r = { events: read.events.length, created: diff.created.length, changed: diff.changed.length, removed: diff.removed.length, queued: newNotifications };
  log?.info("calendar synced", { ...r });
  return r;
}
