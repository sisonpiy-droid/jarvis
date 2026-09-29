import { type NextRequest } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { disposition, storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  if (!(await isSignedIn())) return new Response("Not signed in", { status: 401 });
  const { id, fileId } = await params;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(fileId)) return new Response("Bad id", { status: 400 });
  const [f] = await db()`select kind, filename, storage_path from jarvis.draft_files where id = ${Number(fileId)} and draft_id = ${Number(id)}`;
  if (!f) return new Response("Not found", { status: 404 });
  const bytes = await storage().download(String(f.storage_path));
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": MIME[String(f.kind)] ?? "application/octet-stream", "Content-Disposition": disposition(String(f.filename)), "Cache-Control": "private, no-store" },
  });
}
