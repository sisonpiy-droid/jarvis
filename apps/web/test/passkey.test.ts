import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as db from "@jarvis/db";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import {
  authenticationOptions,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  openChallenge,
  registrationOptions,
  relyingParty,
  sealChallenge,
  verifyAuthentication,
  verifyRegistration,
} from "../lib/passkey-core";

// A software authenticator (ES256, "none" attestation) drives the real @simplewebauthn verification end to end.

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as ArrayBuffer));
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

/** Minimal CBOR encoder: ints, byte strings, text, maps (enough for attestation objects and COSE keys). */
function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24 ? Uint8Array.of((major << 5) | n) : n < 256 ? Uint8Array.of((major << 5) | 24, n) : Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return cat(head(3, b.length), b);
  }
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as object);
  return cat(head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

/** Raw r||s → ASN.1 DER, which WebAuthn signatures use. */
function der(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let b = x.slice(i);
    if (b[0]! & 0x80) b = cat(Uint8Array.of(0), b);
    return cat(Uint8Array.of(2, b.length), b);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

class SoftAuthenticator {
  private keys!: { publicKey: CryptoKey; privateKey: CryptoKey };
  readonly credId = crypto.getRandomValues(new Uint8Array(16));
  private count = 0;
  constructor(private readonly rpID: string, private readonly origin: string) {}

  async create(challenge: string) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", this.keys.publicKey));
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]));
    const authData = cat(await sha256(enc.encode(this.rpID)), Uint8Array.of(0x45), Uint8Array.of(0, 0, 0, 0), new Uint8Array(16), Uint8Array.of(0, this.credId.length), this.credId, cose);
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge, origin: this.origin, crossOrigin: false }));
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key" as const,
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal" as const] },
      clientExtensionResults: {},
    };
  }

  async get(challenge: string, origin = this.origin) {
    this.count++;
    const authData = cat(await sha256(enc.encode(this.rpID)), Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, this.count));
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, cat(authData, await sha256(clientData)) as unknown as ArrayBuffer));
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key" as const,
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(der(sig)), userHandle: b64url(enc.encode("jarvis-owner")) },
      clientExtensionResults: {},
    };
  }
}

const rp = relyingParty("https://jarvis.example.app/");

describe("passkeys (WebAuthn)", () => {
  it("derives the relying party from the dashboard origin", () => {
    expect(rp).toEqual({ rpID: "jarvis.example.app", origin: "https://jarvis.example.app", rpName: "JARVIS" });
  });

  it("registers, then signs in; rejects a wrong origin, a replayed challenge and a wrong key", async () => {
    const auth = new SoftAuthenticator(rp.rpID, rp.origin);
    const reg = await registrationOptions(rp, []);
    expect(reg.authenticatorSelection?.residentKey).toBe("required");
    const pk = await verifyRegistration(await auth.create(reg.challenge), { challenge: reg.challenge, origin: rp.origin, rpID: rp.rpID });
    expect(pk.credentialId).toBe(b64url(auth.credId));

    const login = await authenticationOptions(rp);
    const ok = await verifyAuthentication(await auth.get(login.challenge), { challenge: login.challenge, origin: rp.origin, rpID: rp.rpID }, pk);
    expect(ok.newCounter).toBe(1);

    const phish = await auth.get(login.challenge, "https://evil.example");
    await expect(verifyAuthentication(phish, { challenge: login.challenge, origin: rp.origin, rpID: rp.rpID }, pk)).rejects.toThrow();
    const other = await authenticationOptions(rp);
    await expect(verifyAuthentication(await auth.get(login.challenge), { challenge: other.challenge, origin: rp.origin, rpID: rp.rpID }, pk)).rejects.toThrow();

    const impostor = new SoftAuthenticator(rp.rpID, rp.origin);
    const r2 = await registrationOptions(rp, []);
    await impostor.create(r2.challenge);
    await expect(verifyAuthentication(await impostor.get(login.challenge), { challenge: login.challenge, origin: rp.origin, rpID: rp.rpID }, pk)).rejects.toThrow();
  });

  it("excludes already-registered credentials", async () => {
    const reg = await registrationOptions(rp, [{ credentialId: "abc", transports: ["internal"] }]);
    expect(reg.excludeCredentials?.map((c) => c.id)).toEqual(["abc"]);
  });
});

describe("challenge cookie", () => {
  const secret = "s".repeat(40);
  it("round-trips and binds purpose, time and integrity", async () => {
    const v = await sealChallenge("chal-1", "login", secret, 1_000);
    expect(await openChallenge(v, "login", secret, 2_000)).toBe("chal-1");
    expect(await openChallenge(v, "register", secret, 2_000)).toBeNull();
    expect(await openChallenge(v, "login", secret, 1_000 + 5 * 60_000 + 1)).toBeNull();
    expect(await openChallenge(v.replace("chal-1", "chal-2"), "login", secret, 2_000)).toBeNull();
    expect(await openChallenge(v, "login", "x".repeat(40), 2_000)).toBeNull();
    expect(await openChallenge(undefined, "login", secret)).toBeNull();
  });
});

describe("recovery codes", () => {
  it("are readable, unique, and hashed after normalisation", async () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    expect(normalizeRecoveryCode(" abcd-efgh-jkmn ")).toBe("ABCDEFGHJKMN");
    expect(await hashRecoveryCode(codes[0]!.toLowerCase())).toBe(await hashRecoveryCode(codes[0]!));
  });
});

describe("auth storage (database)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => t?.close());

  it("stores passkeys and only moves the counter forward", async () => {
    await db.savePasskey(t.sql, { credentialId: "c1", publicKey: Uint8Array.of(1, 2, 3), counter: 0, transports: ["internal"], deviceName: "iPhone", backedUp: true });
    await db.touchPasskey(t.sql, "c1", 5);
    await db.touchPasskey(t.sql, "c1", 2);
    const p = await db.getPasskey(t.sql, "c1");
    expect(p).toMatchObject({ counter: 5, transports: ["internal"], deviceName: "iPhone", backedUp: true });
    expect([...p!.publicKey]).toEqual([1, 2, 3]);
    await db.deletePasskey(t.sql, "c1");
    expect(await db.listPasskeys(t.sql)).toEqual([]);
  });

  it("lets each recovery code work exactly once, and regeneration revokes old codes", async () => {
    const codes = generateRecoveryCodes(3);
    await db.replaceRecoveryCodes(t.sql, await Promise.all(codes.map(hashRecoveryCode)));
    expect(await db.consumeRecoveryCode(t.sql, await hashRecoveryCode(codes[0]!))).toBe(true);
    expect(await db.consumeRecoveryCode(t.sql, await hashRecoveryCode(codes[0]!))).toBe(false);
    expect(await db.recoveryCodesLeft(t.sql)).toBe(2);
    await db.replaceRecoveryCodes(t.sql, await Promise.all(generateRecoveryCodes(2).map(hashRecoveryCode)));
    expect(await db.consumeRecoveryCode(t.sql, await hashRecoveryCode(codes[1]!))).toBe(false);
  });
});
