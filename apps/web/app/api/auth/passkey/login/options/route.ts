import { NextResponse } from "next/server";
import { rememberChallenge, rp } from "@/lib/passkey";
import { authenticationOptions } from "@/lib/passkey-core";

export const dynamic = "force-dynamic";

export async function POST() {
  const options = await authenticationOptions(rp());
  await rememberChallenge(options.challenge, "login");
  return NextResponse.json(options);
}
