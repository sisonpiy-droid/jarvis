import { NextResponse } from "next/server";
import { replaceRecoveryCodes } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/passkey-core";

export const dynamic = "force-dynamic";

/** A new set of recovery codes; the old ones stop working. Shown once. */
export async function POST() {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const codes = generateRecoveryCodes();
  await replaceRecoveryCodes(sql(), await Promise.all(codes.map(hashRecoveryCode)));
  return NextResponse.json({ recoveryCodes: codes });
}
