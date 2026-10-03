import { NextResponse, type NextRequest } from "next/server";
import { removePushSubscription, savePushSubscription } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export const dynamic = "force-dynamic";

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** Registers this browser / installed app for push. Body: { subscription: PushSubscriptionJSON, label?: string }. */
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; label?: unknown } | null;
  const s = body?.subscription;
  const endpoint = typeof s?.endpoint === "string" ? s.endpoint : "";
  const p256dh = typeof s?.keys?.p256dh === "string" ? s.keys.p256dh : "";
  const auth = typeof s?.keys?.auth === "string" ? s.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !B64URL.test(p256dh) || !B64URL.test(auth)) {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }
  const label = typeof body?.label === "string" ? body.label.slice(0, 60) : null;
  const id = await savePushSubscription(sql(), { endpoint, p256dh, auth, deviceLabel: label, userAgent: req.headers.get("user-agent") });
  return NextResponse.json({ ok: true, id });
}

/** Body: { endpoint } (this device) or { id } (from the Settings device list). */
export async function DELETE(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { endpoint?: unknown; id?: unknown };
  if (typeof body.id === "number") await removePushSubscription(sql(), { id: body.id });
  else if (typeof body.endpoint === "string") await removePushSubscription(sql(), { endpoint: body.endpoint });
  else return NextResponse.json({ error: "endpoint or id required" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
