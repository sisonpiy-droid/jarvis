import { type NextRequest } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { disposition, storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ sha: string }> }) {
  if (!(await isSignedIn())) return new Response("Not signed in", { status: 401 });
  const { sha } = await params;
  if (!/^[0-9a-f]{64}$/.test(sha)) return new Response("Bad id", { status: 400 });
  const [f] = await db()`select storage_path, mime_type, original_filename from jarvis.files where sha256 = ${sha}`;
  if (!f) return new Response("Not found", { status: 404 });
  const bytes = await storage().download(f.storage_path as string);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": (f.mime_type as string) || "application/octet-stream",
      "Content-Disposition": disposition((f.original_filename as string) || `${sha}.bin`),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
