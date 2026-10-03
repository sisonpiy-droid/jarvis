import type { NextRequest } from "next/server";
import { appIcon } from "@/lib/app-icon";

const SIZES = new Set([96, 192, 512]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ size: string }> }) {
  const size = Number((await ctx.params).size);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  const res = appIcon(size, { inset: req.nextUrl.searchParams.has("maskable") });
  res.headers.set("Cache-Control", "public, max-age=86400, immutable");
  return res;
}
