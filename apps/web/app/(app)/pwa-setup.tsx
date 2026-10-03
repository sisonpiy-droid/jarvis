"use client";

import { useEffect } from "react";
import { deviceLabel, registerServiceWorker, saveSubscription } from "@/lib/pwa-client";

/**
 * Registers the service worker on every signed-in page, and re-sends this device's push subscription when
 * notifications are already allowed — so a subscription the server dropped (e.g. after a 410) heals itself.
 * Also clears the app-icon badge once the app is open.
 */
export function PwaSetup() {
  useEffect(() => {
    void (async () => {
      const reg = await registerServiceWorker();
      if ("clearAppBadge" in navigator) void (navigator as Navigator & { clearAppBadge(): Promise<void> }).clearAppBadge().catch(() => {});
      if (!reg || !("PushManager" in window) || Notification.permission !== "granted") return;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await saveSubscription(sub, deviceLabel()).catch(() => {});
    })();
  }, []);
  return null;
}
