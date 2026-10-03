import { NextResponse } from "next/server";
import { listPasskeys } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { rememberChallenge, rp, sql } from "@/lib/passkey";
import { registrationOptions } from "@/lib/passkey-core";

export const dynamic = "force-dynamic";

/** Adding a passkey needs an existing session (another passkey, a recovery code, the local login link, or legacy Telegram). */
export async function POST() {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const existing = await listPasskeys(sql());
  const options = await registrationOptions(rp(), existing);
  await rememberChallenge(options.challenge, "register");
  return NextResponse.json(options);
}
