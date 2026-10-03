import "server-only";
import { cookies } from "next/headers";
import type { Sql } from "@jarvis/db";
import { baseUrl, sessionSecret } from "./auth";
import { db } from "./db";
import { CHALLENGE_TTL_MS, openChallenge, relyingParty, sealChallenge } from "./passkey-core";

// Glue between passkey-core (pure) and Next: the relying party, the challenge cookie, and the database.

export const CHALLENGE_COOKIE = "jarvis_webauthn";

export const rp = () => relyingParty(baseUrl());
export const sql = () => db() as unknown as Sql;

export async function rememberChallenge(challenge: string, purpose: "register" | "login"): Promise<void> {
  (await cookies()).set(CHALLENGE_COOKIE, await sealChallenge(challenge, purpose, sessionSecret()), {
    httpOnly: true,
    secure: baseUrl().startsWith("https"),
    sameSite: "strict",
    path: "/api/auth/passkey",
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
}

/** Reads and clears the challenge — each one is usable once. */
export async function takeChallenge(purpose: "register" | "login"): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(CHALLENGE_COOKIE)?.value;
  jar.delete({ name: CHALLENGE_COOKIE, path: "/api/auth/passkey" });
  return openChallenge(value, purpose, sessionSecret());
}
