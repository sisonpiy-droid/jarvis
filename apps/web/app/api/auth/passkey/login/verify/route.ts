import { NextResponse, type NextRequest } from "next/server";
import { getPasskey, touchPasskey } from "@jarvis/db";
import { startSession } from "@/lib/auth";
import { rp, sql, takeChallenge } from "@/lib/passkey";
import { verifyAuthentication } from "@/lib/passkey-core";

export const dynamic = "force-dynamic";

const fail = (error: string) => NextResponse.json({ error }, { status: 401 });

export async function POST(req: NextRequest) {
  const challenge = await takeChallenge("login");
  if (!challenge) return fail("This sign-in request expired. Try again.");
  const body = (await req.json().catch(() => null)) as { response?: { id?: unknown } } | null;
  const id = typeof body?.response?.id === "string" ? body.response.id : "";
  const stored = id ? await getPasskey(sql(), id) : null;
  if (!stored) return fail("This passkey is not registered with JARVIS.");
  try {
    const r = rp();
    const { newCounter } = await verifyAuthentication(body!.response as never, { challenge, origin: r.origin, rpID: r.rpID }, stored);
    await touchPasskey(sql(), stored.credentialId, newCounter);
  } catch {
    return fail("Passkey check failed.");
  }
  const res = NextResponse.json({ ok: true });
  await startSession(res);
  return res;
}
