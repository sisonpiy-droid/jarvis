import { NextResponse, type NextRequest } from "next/server";
import { deletePasskey, renamePasskey } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  await deletePasskey(sql(), decodeURIComponent((await ctx.params).id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { name } = (await req.json().catch(() => ({}))) as { name?: unknown };
  if (typeof name !== "string" || !name.trim()) return NextResponse.json({ error: "Name required" }, { status: 400 });
  await renamePasskey(sql(), decodeURIComponent((await ctx.params).id), name.trim());
  return NextResponse.json({ ok: true });
}
