import { NextResponse, type NextRequest } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { requestDraft, requestRevision } from "@/lib/edge";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { assignmentId, instruction } = (await req.json().catch(() => ({}))) as { assignmentId?: string; instruction?: string };
  if (!assignmentId || !UUID.test(assignmentId)) return NextResponse.json({ error: "Bad assignment id" }, { status: 400 });
  try {
    if (typeof instruction === "string" && instruction.trim()) await requestRevision(assignmentId, instruction.trim().slice(0, 4000), "web");
    else await requestDraft(assignmentId);
    return NextResponse.json({ started: true }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
