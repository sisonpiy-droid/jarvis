import { NextResponse, type NextRequest } from "next/server";
import { consumeRecoveryCode } from "@jarvis/db";
import { startSession } from "@/lib/auth";
import { sql } from "@/lib/passkey";
import { hashRecoveryCode, normalizeRecoveryCode } from "@/lib/passkey-core";

export const dynamic = "force-dynamic";

/** Signs in with a one-time recovery code (for a lost phone). Each code works once. */
export async function POST(req: NextRequest) {
  const { code } = (await req.json().catch(() => ({}))) as { code?: unknown };
  const ok = typeof code === "string" && normalizeRecoveryCode(code).length === 12 && (await consumeRecoveryCode(sql(), await hashRecoveryCode(code)));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 750)); // slows guessing; each code has ~59 bits anyway
    return NextResponse.json({ error: "That code is not valid or was already used." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  await startSession(res);
  return res;
}
