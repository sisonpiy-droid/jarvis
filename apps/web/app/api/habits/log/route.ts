import { NextResponse, type NextRequest } from "next/server";
import { logHabit, WorkInputError } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/**
 * Habit check-in. Body: { id: number, day?: "YYYY-MM-DD", status?: "done" | "skipped", source?: "push_action" | "ui" }.
 * Called by the service worker when Done / Skip is pressed on a reminder, and by the quick check-in page.
 */
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; day?: unknown; status?: unknown; source?: unknown };
  if (!Number.isInteger(b.id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const status = b.status === "skipped" ? "skipped" : "done";
  try {
    const a = await logHabit(sql(), b.id as number, {
      status,
      ...(typeof b.day === "string" ? { day: b.day } : {}),
      source: b.source === "push_action" ? "push_action" : "ui",
    });
    return NextResponse.json({ ok: true, day: a.day, status: a.status });
  } catch (err) {
    if (err instanceof WorkInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
