import { type NextRequest } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { disposition, storage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSignedIn())) return new Response("Not signed in", { status: 401 });
  const { id } = await params;
  if (!/^\d+$/.test(id)) return new Response("Bad id", { status: 400 });
  const [d] = await db()`
    select d.storage_path, i.title from jarvis.drafts d left join jarvis.lms_items i on i.kind = 'assignment' and i.source_id = d.assignment_id
     where d.id = ${Number(id)} and d.status = 'done'`;
  if (!d?.storage_path) return new Response("Not found", { status: 404 });
  const bytes = await storage().download(d.storage_path as string);
  const name = `${String(d.title ?? "Assignment").replace(/[^\w\s.-]+/g, "").trim().slice(0, 80)} - JARVIS draft.docx`;
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": disposition(name),
      "Cache-Control": "private, no-store",
    },
  });
}
