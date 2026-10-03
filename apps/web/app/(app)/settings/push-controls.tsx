"use client";

import { useEffect, useState } from "react";
import { deviceLabel, isIos, isStandalone, pushSupported, registerServiceWorker, saveSubscription, urlBase64ToUint8Array } from "@/lib/pwa-client";

type State = "loading" | "unconfigured" | "unsupported" | "ios-install" | "blocked" | "off" | "on";

const btn = "rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50";

/** Turn push on/off for THIS browser or installed app, and send a test. */
export function PushControls({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [label, setLabel] = useState("This device");

  useEffect(() => {
    setLabel(deviceLabel());
    void (async () => {
      if (!vapidPublicKey) return setState("unconfigured");
      if (isIos() && !isStandalone()) return setState("ios-install");
      if (!pushSupported()) return setState("unsupported");
      if (Notification.permission === "denied") return setState("blocked");
      const reg = await registerServiceWorker();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub && Notification.permission === "granted" ? "on" : "off");
    })();
  }, [vapidPublicKey]);

  async function enable() {
    setBusy(true);
    setNote(null);
    try {
      // Must run straight from the tap: iPhone only shows the permission prompt for a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!) }));
      if (!(await saveSubscription(sub, label))) throw new Error("The server didn't accept this device.");
      setState("on");
      setNote("Notifications are on for this device. Send a test to check.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't turn on notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscription", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState("off");
      setNote("Notifications are off for this device. Everything still arrives in the inbox.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    const r = await fetch("/api/push/test", { method: "POST" });
    setBusy(false);
    setNote(r.ok ? "Test queued. It should arrive within about a minute (not during quiet hours)." : "Couldn't queue a test.");
  }

  return (
    <div className="space-y-3 text-sm">
      {state === "loading" && <p className="text-[var(--color-muted)]">Checking this device…</p>}
      {state === "unconfigured" && <p className="text-[var(--color-muted)]">Push isn&apos;t set up on the server yet (VAPID keys missing).</p>}
      {state === "unsupported" && <p className="text-[var(--color-muted)]">This browser can&apos;t receive push notifications. Use Chrome on Android, or install JARVIS on your iPhone.</p>}
      {state === "ios-install" && (
        <div className="rounded-lg border border-[var(--color-line)] p-3">
          <p className="font-medium">On iPhone, install JARVIS to get notifications</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              In Safari, tap the <b>Share</b> button (square with an arrow).
            </li>
            <li>
              Choose <b>Add to Home Screen</b>, then <b>Add</b>.
            </li>
            <li>
              Open <b>JARVIS from your Home Screen</b>, sign in, and come back to Settings to turn notifications on.
            </li>
          </ol>
          <p className="mt-2 text-[var(--color-muted)]">Needs iOS 16.4 or later.</p>
        </div>
      )}
      {state === "blocked" && (
        <p className="text-[var(--color-warn)]">
          Notifications are blocked for JARVIS on this device. Allow them in the browser&apos;s site settings (or iPhone Settings → Notifications → JARVIS), then reload.
        </p>
      )}
      {(state === "off" || state === "on") && (
        <div className="flex flex-wrap items-center gap-2">
          {state === "off" ? (
            <>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={60}
                aria-label="Device name"
                className="w-40 rounded-lg border border-[var(--color-line)] bg-transparent px-2 py-1.5 outline-none focus:border-[var(--color-accent)]"
              />
              <button onClick={() => void enable()} disabled={busy} className={`${btn} bg-[var(--color-accent)] text-white`}>
                Turn on notifications
              </button>
            </>
          ) : (
            <>
              <span className="rounded-full bg-[color-mix(in_srgb,var(--color-good)_14%,transparent)] px-2 py-0.5 text-xs font-medium text-[var(--color-good)]">On for this device</span>
              <button onClick={() => void test()} disabled={busy} className={`${btn} bg-[var(--color-accent)] text-white`}>
                Send test notification
              </button>
              <button onClick={() => void disable()} disabled={busy} className={`${btn} border border-[var(--color-line)]`}>
                Turn off here
              </button>
            </>
          )}
        </div>
      )}
      {note && <p className="text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}
