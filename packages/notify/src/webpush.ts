// Web Push with only Web Crypto, so the same code runs in Supabase Edge (Deno) and Node:
//  - payload encryption: RFC 8291 (Message Encryption for Web Push) using RFC 8188 "aes128gcm"
//  - sender identity: RFC 8292 VAPID (an ES256 JWT signed with our private key)
// Works with every push service: FCM (Android Chrome), Apple Web Push (iPhone home-screen apps), Mozilla, Edge.

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}

/** HKDF (RFC 5869) with a single expand block — every length we need is ≤ 32 bytes. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** Imports a P-256 key pair from raw bytes: public = 65-byte uncompressed point, private = 32-byte scalar. */
async function importEcPrivate(publicRaw: Uint8Array, privateRaw: Uint8Array, usage: "ecdh" | "ecdsa"): Promise<CryptoKey> {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error("public key must be a 65-byte uncompressed P-256 point");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(publicRaw.slice(1, 33)),
    y: b64urlEncode(publicRaw.slice(33, 65)),
    d: b64urlEncode(privateRaw),
    ext: true,
  };
  return usage === "ecdh"
    ? crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
    : crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export interface EncryptOptions {
  /** For tests only: fixed salt and application-server key pair (RFC 8291 Appendix A). */
  salt?: Uint8Array;
  serverKeys?: { publicRaw: Uint8Array; privateRaw: Uint8Array };
  recordSize?: number;
}

/** Encrypts one push message body (single aes128gcm record). */
export async function encryptPayload(plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  let asPublic: Uint8Array;
  let asPrivate: CryptoKey;
  if (opts.serverKeys) {
    asPublic = opts.serverKeys.publicRaw;
    asPrivate = await importEcPrivate(opts.serverKeys.publicRaw, opts.serverKeys.privateRaw, "ecdh");
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));

  // RFC 8291 §3.3–3.4
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const recordSize = opts.recordSize ?? 4096;
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = last (only) record, no padding
  if (padded.length + 16 > recordSize) throw new Error("push payload too large");
  const key = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, key, buf(padded)));

  // RFC 8188 header: salt(16) | rs(4) | idlen(1) | keyid(as_public)
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 public key (also given to browsers as applicationServerKey). */
  publicKey: string;
  /** base64url, 32-byte private scalar. */
  privateKey: string;
  /** mailto: or https: contact, required by Apple and Mozilla. */
  subject: string;
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push-service origin (RFC 8292). */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })));
  const signingKey = await importEcPrivate(b64urlDecode(keys.publicKey), b64urlDecode(keys.privateKey), "ecdsa");
  // Web Crypto ECDSA signatures are already the raw r||s (64 bytes) that JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d! };
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Absolute or dashboard-relative URL opened on tap. */
  url: string;
  /** Same tag replaces an earlier notification on the device instead of stacking. */
  tag?: string;
  /** Notification ids, so a tap can mark them read. */
  ids?: number[];
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Seconds the push service keeps it for an offline device. */
  ttl?: number;
  /** Ask the device for action buttons (Android); ignored where unsupported. */
  actions?: Array<{ action: string; title: string }>;
}

export type PushOutcome = { ok: true; status: number } | { ok: false; gone: boolean; status: number; error: string };

/** Sends one encrypted message to one browser. Never throws for HTTP errors. */
export async function sendPush(target: PushTarget, msg: PushMessage, keys: VapidKeys, fetchImpl: typeof fetch = fetch): Promise<PushOutcome> {
  const payload = enc.encode(JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag, ids: msg.ids ?? [], actions: msg.actions ?? [] }));
  try {
    const body = await encryptPayload(payload, b64urlDecode(target.p256dh), b64urlDecode(target.auth));
    const res = await fetchImpl(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(target.endpoint, keys),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(msg.ttl ?? 24 * 3600),
        Urgency: msg.urgency ?? "normal",
        ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
      },
      body: buf(body),
    });
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status, error: `HTTP ${res.status} ${text}`.trim() };
  } catch (err) {
    return { ok: false, gone: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
