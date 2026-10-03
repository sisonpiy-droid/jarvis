import { NextResponse, type NextRequest } from "next/server";
import { dismiss, markRead } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/**
 * Inbox actions. Body: { action: "read", ids: number[] | "all" } or { action: "dismiss", ids: number[] }.
 * Also called by the service worker when a push is tapped (marks it read, which stops email escalation).
 */
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; ids?: unknown };
  const ids = body.ids === "all" ? "all" : Array.isArray(body.ids) ? body.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 500) : null;
  if (!ids) return NextResponse.json({ error: "ids required" }, { status: 400 });
  if (body.action === "read") await markRead(sql(), ids);
  else if (body.action === "dismiss" && ids !== "all") await dismiss(sql(), ids);
  else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
