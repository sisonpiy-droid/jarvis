import { NextResponse, type NextRequest } from "next/server";
import { SHARED_MAX_BYTES, sharedExt } from "@jarvis/files";
import { isSignedIn } from "@/lib/auth";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

// POST {name, size} → {uploadUrl, path}: a one-time URL to PUT one shared file straight to Storage (no server
// size limit in the way). The server picks the path; /api/files/ingest then stores and reads the file.
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = ((await req.json().catch(() => null)) ?? {}) as { name?: unknown; size?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
  if (size > SHARED_MAX_BYTES) return NextResponse.json({ error: "Files up to 25 MB can be shared" }, { status: 413 });
  const ext = sharedExt(name);
  const path = `shared/${crypto.randomUUID()}${ext ? `.${ext}` : ""}`;
  try {
    return NextResponse.json({ uploadUrl: await storage().signUpload(path), path });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Failed" }, { status: 502 });
  }
}
