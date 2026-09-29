// AES-256-GCM envelope for secrets at rest (the saved LMS session).
// Format: "v1.<iv b64>.<tag b64>.<ciphertext b64>". Uses Web Crypto so the
// same code runs in Node and in Supabase Edge (Deno). The key lives in the
// environment, never next to the ciphertext.

const VERSION = "v1";
const TAG_BYTES = 16;

const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function generateKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromB64(keyB64);
  if (raw.length !== 32) throw new Error("Encryption key must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(plaintext: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), new TextEncoder().encode(plaintext)));
  const ct = out.slice(0, out.length - TAG_BYTES);
  const tag = out.slice(out.length - TAG_BYTES);
  return [VERSION, toB64(iv), toB64(tag), toB64(ct)].join(".");
}

export async function open(sealed: string, keyB64: string): Promise<string> {
  const [version, iv, tag, ct] = sealed.trim().split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("Unrecognised sealed-secret format");
  const ctBytes = fromB64(ct);
  const tagBytes = fromB64(tag);
  const joined = new Uint8Array(ctBytes.length + tagBytes.length);
  joined.set(ctBytes);
  joined.set(tagBytes, ctBytes.length);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await importKey(keyB64), joined);
  return new TextDecoder().decode(pt);
}
