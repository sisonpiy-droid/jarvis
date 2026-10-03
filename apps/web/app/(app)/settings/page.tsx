import Link from "next/link";
import { countMemories } from "@jarvis/ai";
import { activePushSubscriptions, listPasskeys, NOTIFICATION_CATEGORIES, recoveryCodesLeft } from "@jarvis/db";
import { loadNotificationSettings } from "@jarvis/notify";
import { relative } from "@/lib/format";
import { sql } from "@/lib/passkey";
import { Section } from "../ui";
import { removeDevice } from "./actions";
import { Passkeys } from "./passkeys";
import { PreferencesForm } from "./preferences-form";
import { PushControls } from "./push-controls";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = sql();
  const [settings, devices, passkeys, codesLeft, memories] = await Promise.all([
    loadNotificationSettings(s),
    activePushSubscriptions(s),
    listPasskeys(s),
    recoveryCodesLeft(s),
    countMemories(s).catch(() => null),
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
