import { NextResponse, type NextRequest } from "next/server";
import { recoveryCodesLeft, replaceRecoveryCodes, savePasskey } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { rp, sql, takeChallenge } from "@/lib/passkey";
import { generateRecoveryCodes, hashRecoveryCode, verifyRegistration } from "@/lib/passkey-core";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const challenge = await takeChallenge("register");
  if (!challenge) return NextResponse.json({ error: "This request expired. Try again." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { response?: unknown; name?: unknown } | null;
  if (!body?.response) return NextResponse.json({ error: "Missing passkey response" }, { status: 400 });
  try {
    const r = rp();
    const pk = await verifyRegistration(body.response as never, { challenge, origin: r.origin, rpID: r.rpID });
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Passkey";
    await savePasskey(sql(), { ...pk, deviceName: name });
    // First passkey (or no codes left): issue recovery codes, shown once.
    let recoveryCodes: string[] | null = null;
    if ((await recoveryCodesLeft(sql())) === 0) {
      recoveryCodes = generateRecoveryCodes();
      await replaceRecoveryCodes(sql(), await Promise.all(recoveryCodes.map(hashRecoveryCode)));
    }
    return NextResponse.json({ ok: true, recoveryCodes });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not verify the passkey" }, { status: 400 });
  }
}
