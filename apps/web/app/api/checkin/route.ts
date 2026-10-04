import { NextResponse, type NextRequest } from "next/server";
import { moveOpenToTomorrow } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export const dynamic = "force-dynamic";

// POST {action: "move"} → {moved}: the evening check-in's "Move the rest to tomorrow" (push button or page).
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = ((await req.json().catch(() => null)) ?? {}) as { action?: unknown };
  if (body.action !== "move") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  return NextResponse.json({ moved: await moveOpenToTomorrow(sql(), new Date()) });
}
