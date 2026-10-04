import { NextResponse, type NextRequest } from "next/server";
import { dismiss, markOpened, markRead } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/**
 * Inbox actions. Body: { action: "read", ids: number[] | "all" }, { action: "dismiss", ids: number[] }, or
 * { action: "open", ids: number[] } from the service worker when a push is tapped (read + opened, which stops
 * email escalation and tells alert learning the push mattered).
 */
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; ids?: unknown };
  const ids = body.ids === "all" ? "all" : Array.isArray(body.ids) ? body.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 500) : null;
  if (!ids) return NextResponse.json({ error: "ids required" }, { status: 400 });
  if (body.action === "read") await markRead(sql(), ids);
  // A push tapped or answered: read, and counted as opened (what alert learning measures).
  else if (body.action === "open" && ids !== "all") await markOpened(sql(), ids);
  else if (body.action === "dismiss" && ids !== "all") await dismiss(sql(), ids);
  else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
