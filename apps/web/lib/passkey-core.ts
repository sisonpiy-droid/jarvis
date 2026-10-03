import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

// Passkey (WebAuthn) and recovery-code logic for the single owner. No Next.js imports, so it is unit-tested
// directly (apps/web/test/passkey.test.ts). The routes in app/api/auth/* wire it to cookies and the database.

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The relying party is the dashboard's own origin. Passkeys are bound to its host name. */
export function relyingParty(base: string): { rpID: string; origin: string; rpName: string } {
  const u = new URL(base);
  return { rpID: u.hostname, origin: u.origin, rpName: "JARVIS" };
}

// One fixed WebAuthn user handle: JARVIS has exactly one owner.
const OWNER_ID = enc.encode("jarvis-owner");

export function registrationOptions(rp: { rpID: string; rpName: string }, existing: Array<{ credentialId: string; transports: string[] }>) {
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: OWNER_ID,
    userName: "owner",
    userDisplayName: "JARVIS owner",
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
    // Discoverable credential: sign in with no username, from any synced device (iCloud Keychain, Google Password Manager).
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
}

export interface NewPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  backedUp: boolean;
}

export async function verifyRegistration(response: RegistrationResponseJSON, expected: { challenge: string; origin: string; rpID: string }): Promise<NewPasskey> {
  const v = await verifyRegistrationResponse({ response, expectedChallenge: expected.challenge, expectedOrigin: expected.origin, expectedRPID: expected.rpID, requireUserVerification: false });
  if (!v.verified) throw new Error("Passkey registration could not be verified");
  const c = v.registrationInfo.credential;
  return { credentialId: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? response.response.transports ?? [], backedUp: v.registrationInfo.credentialBackedUp };
}

export function authenticationOptions(rp: { rpID: string }) {
  return generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred", allowCredentials: [] });
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expected: { challenge: string; origin: string; rpID: string },
  stored: { credentialId: string; publicKey: Uint8Array; counter: number; transports: string[] },
): Promise<{ newCounter: number }> {
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: expected.challenge,
    expectedOrigin: expected.origin,
    expectedRPID: expected.rpID,
    credential: { id: stored.credentialId, publicKey: stored.publicKey as never, counter: stored.counter, transports: stored.transports as never },
    requireUserVerification: false,
  });
  if (!v.verified) throw new Error("Passkey sign-in could not be verified");
  return { newCounter: v.authenticationInfo.newCounter };
}

// ── short-lived, signed challenge cookie ─────────────────────────────────────

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

const sameString = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

export const CHALLENGE_TTL_MS = 5 * 60_000;

/** `exp.purpose.challenge.sig` — binds the challenge to its purpose (register/login) and a 5-minute window. */
export async function sealChallenge(challenge: string, purpose: "register" | "login", secret: string, now = Date.now()): Promise<string> {
  const body = `${now + CHALLENGE_TTL_MS}.${purpose}.${challenge}`;
  return `${body}.${await hmac(secret, body)}`;
}

export async function openChallenge(value: string | undefined, purpose: "register" | "login", secret: string, now = Date.now()): Promise<string | null> {
  if (!value) return null;
  const at = value.lastIndexOf(".");
  const body = value.slice(0, at);
  const [exp, p, challenge] = body.split(".");
  if (!exp || !challenge || p !== purpose || Number(exp) < now) return null;
  return sameString(value.slice(at + 1), await hmac(secret, body)) ? challenge : null;
}

// ── recovery codes ───────────────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no I/L/O/U/0/1 — easy to read back

/** `XXXX-XXXX-XXXX` (≈ 59 bits each). Shown once; only hashes are stored. */
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export const normalizeRecoveryCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function hashRecoveryCode(code: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(`jarvis-recovery:${normalizeRecoveryCode(code)}`)));
}
