import Link from "next/link";
import { countMemories } from "@jarvis/ai";
import { activePushSubscriptions, categoryLabel, getLearnedRouting, listPasskeys, NOTIFICATION_CATEGORIES, recoveryCodesLeft, workPatterns } from "@jarvis/db";
import { loadNotificationSettings } from "@jarvis/notify";
import { relative } from "@/lib/format";
import { sql } from "@/lib/passkey";
import { Section } from "../ui";
import { keepAlertAction, removeDevice } from "./actions";
import { Passkeys } from "./passkeys";
import { PreferencesForm } from "./preferences-form";
import { PushControls } from "./push-controls";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = sql();
  const [settings, devices, passkeys, codesLeft, memories, learned, patterns] = await Promise.all([
    loadNotificationSettings(s),
    activePushSubscriptions(s),
    listPasskeys(s),
    recoveryCodesLeft(s),
    countMemories(s).catch(() => null),
    getLearnedRouting(s),
    workPatterns(s, new Date()).catch(() => null),
  ]);
  const vapid = process.env.VAPID_PUBLIC_KEY || null;
  const telegramConfigured = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Section title="Memory">
        <Link href="/settings/memory" className="text-sm no-underline">
          What JARVIS remembers{memories ? ` (${memories.active})` : ""} →
        </Link>
        {memories && memories.legacy > 0 && (
          <span className="ml-2 text-xs text-[var(--color-muted)]">
            {memories.legacy} old {memories.legacy === 1 ? "note" : "notes"} to review
          </span>
        )}
      </Section>

      <Section title="What JARVIS learned" id="learned">
        <h3 className="text-sm font-medium">How you work</h3>
        {patterns?.lines.length ? (
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {patterns.lines.map((l) => (
              <li key={l}>{l.split(" [task #")[0]}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-[var(--color-muted)]">Not enough history yet. JARVIS learns from your submission times and the tasks you finish or keep moving.</p>
        )}
        <h3 className="mt-4 text-sm font-medium">Quietened alerts</h3>
        {Object.keys(learned.quiet).length ? (
          <ul className="mt-1 space-y-2 text-sm">
            {Object.entries(learned.quiet).map(([c, q]) => (
              <li key={c} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  🔕 {categoryLabel(c)} go to your inbox only{" "}
                  <span className="text-[var(--color-muted)]">
                    — you didn&apos;t open the last {q.ignored} ({relative(q.since)})
                  </span>
                </span>
                <form action={keepAlertAction}>
                  <input type="hidden" name="category" value={c} />
                  <button className="min-h-11 rounded-lg border border-[var(--color-line)] px-3 text-sm hover:bg-[var(--color-line)]">Turn back on</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-[var(--color-muted)]">None. If you never open a kind of push for two weeks, it moves to your inbox only. Deadlines, classes and urgent alerts always reach your phone.</p>
        )}
      </Section>

      <Section title="Notifications on this device">
        <PushControls vapidPublicKey={vapid} />
      </Section>

      <Section title="Devices that get push">
        {devices.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">None yet. Turn notifications on from each phone (Android: in Chrome; iPhone: from the JARVIS app on your Home Screen).</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">📱 {d.deviceLabel ?? "Device"}</span>
                <span className="text-[var(--color-muted)]">
                  {new URL(d.endpoint).hostname.includes("apple") ? "Apple" : new URL(d.endpoint).hostname.includes("google") ? "Google" : new URL(d.endpoint).hostname} · added {relative(d.createdAt)}
                  {d.lastSuccessAt ? ` · last delivered ${relative(d.lastSuccessAt)}` : ""}
                  {d.consecutiveFailures > 0 ? ` · ${d.consecutiveFailures} recent failures` : ""}
                </span>
                <form action={removeDevice} className="ml-auto">
                  <input type="hidden" name="id" value={d.id} />
                  <button className="text-[var(--color-bad)]">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Notification preferences">
        <PreferencesForm settings={settings} categories={NOTIFICATION_CATEGORIES} telegramConfigured={telegramConfigured} />
      </Section>

      <Section title="Sign-in: passkeys & recovery">
        <Passkeys
          passkeys={passkeys.map((p) => ({ id: p.credentialId, name: p.deviceName, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, synced: p.backedUp }))}
          codesLeft={codesLeft}
        />
      </Section>
    </main>
  );
}
