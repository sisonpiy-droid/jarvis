import { NextResponse } from "next/server";
import { enqueueNotifications } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/**
 * Queues a test notification. The `notify` job (every minute) routes it like any other: inbox + push to every
 * registered device (+ legacy Telegram only per your Telegram setting). High priority, so quiet hours defer it.
 */
export async function POST() {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const at = new Date();
  const time = at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  await enqueueNotifications(sql(), [
    {
      dedupeKey: `system.test:${at.getTime()}`,
      priority: "high",
      text: `🔔 <b>Test notification</b>\nSent ${time}. If this reached your phone, push works on this device.`,
      scheduledFor: at.toISOString(),
      url: "/settings",
    },
  ]);
  return NextResponse.json({ ok: true, queuedAt: at.toISOString() });
}
