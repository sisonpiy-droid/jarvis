import { NextResponse, type NextRequest } from "next/server";
import { readImage } from "@jarvis/ai";
import type { Sql } from "@jarvis/db";
import { SHARED_PATH_RE, ingestSharedFile } from "@jarvis/files";
import { aiModel } from "@/lib/ai";
import { isSignedIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // a large PDF, or an image read by the model

// POST {path, name, type} → {fileId, name, textStatus, chars, duplicate}: stores an uploaded shared file once
// (by content) and extracts its text, so chat can read it with read_file_text.
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = ((await req.json().catch(() => null)) ?? {}) as { path?: unknown; name?: unknown; type?: unknown };
  const path = typeof body.path === "string" ? body.path : "";
  if (!SHARED_PATH_RE.test(path)) return NextResponse.json({ error: "Bad upload" }, { status: 400 });
  const model = aiModel(45_000);
  try {
    const r = await ingestSharedFile(
      { sql: db() as unknown as Sql, storage: storage(), readImage: model ? (b64, mime) => readImage(model, b64, mime) : null },
      { path, name: typeof body.name === "string" ? body.name : "shared file", mime: typeof body.type === "string" && body.type ? body.type : null },
    );
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Failed" }, { status: 500 });
  }
}
