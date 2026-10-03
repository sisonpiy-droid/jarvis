import type { Sql } from "@jarvis/db";
import { extractOfficeText, officeKind } from "./office-text";
import { extractPdfText, isPdf } from "./pdf-text";

// Files the owner shares to JARVIS (phone share sheet, or 📎 in chat). The browser uploads straight to Storage
// under shared/<random>.<ext>; this reads it back, stores it once by content (sha256, like LMS files) and
// extracts its text so chat can read it with read_file_text. Images are read by the model (readImage).

export const SHARED_MAX_BYTES = 25 * 2 ** 20;
/** shared/<uuid>.<ext> — the only paths ingest accepts (the server chose them when signing the upload). */
export const SHARED_PATH_RE = /^shared\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]{1,8})?$/;
const TEXT_MAX_CHARS = 400_000;

export interface SharedStorage {
  download(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
}

export interface IngestResult {
  fileId: string;
  name: string;
  /** "done" with text, "original" (scanned PDF, unreadable image), or "unsupported". */
  textStatus: string;
  chars: number;
  /** The same content was already stored (this upload was removed). */
  duplicate: boolean;
}

export const sharedExt = (name: string) => name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? null;
export const isImage = (name: string, mime: string | null) => /^image\//i.test(mime ?? "") || /\.(png|jpe?g|webp|heic|heif|gif)$/i.test(name);
const isPlain = (name: string, mime: string | null) => /^text\//i.test(mime ?? "") || /\.(txt|md|csv)$/i.test(name);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Base64 without Buffer (this package also runs on Deno). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Text of a shared file, or null with the reason as status. */
async function textOf(bytes: Uint8Array, name: string, mime: string | null, readImage: ((b64: string, mime: string) => Promise<string>) | null) {
  const office = officeKind(name, mime);
  if (office) return { status: "done", text: extractOfficeText(bytes, office) };
  if (isPdf(name, mime)) {
    const text = await extractPdfText(bytes);
    return text ? { status: "done", text } : { status: "original", text: null };
  }
  if (isPlain(name, mime)) return { status: "done", text: new TextDecoder().decode(bytes).slice(0, TEXT_MAX_CHARS) };
  if (isImage(name, mime)) {
    if (!readImage || bytes.length > 15 * 2 ** 20) return { status: "original", text: null };
    const b64 = toBase64(bytes);
    const text = (await readImage(b64, mime && /^image\//.test(mime) ? mime : "image/jpeg")).trim();
    return text ? { status: "done", text } : { status: "original", text: null };
  }
  return { status: "unsupported", text: null };
}

export async function ingestSharedFile(
  deps: { sql: Sql; storage: SharedStorage; readImage: ((b64: string, mime: string) => Promise<string>) | null },
  input: { path: string; name: string; mime: string | null },
): Promise<IngestResult> {
  if (!SHARED_PATH_RE.test(input.path)) throw new Error("not a shared upload path");
  const name = input.name.replace(/[\\/\0]/g, "_").slice(0, 200) || "shared file";
  const bytes = await deps.storage.download(input.path);
  if (bytes.length > SHARED_MAX_BYTES) {
    await deps.storage.remove(input.path).catch(() => {});
    throw new Error("file is larger than 25 MB");
  }
  const sha = await sha256Hex(bytes);
  const [known] = await deps.sql`select sha256, original_filename, text_status, length(coalesce(text_content, ''))::int as chars from jarvis.files where sha256 = ${sha}`;
  if (known) {
    await deps.storage.remove(input.path).catch(() => {});
    return { fileId: sha, name, textStatus: String(known.text_status), chars: Number(known.chars), duplicate: true };
  }
  let status: string;
  let text: string | null = null;
  try {
    ({ status, text } = await textOf(bytes, name, input.mime, deps.readImage));
  } catch {
    status = "failed"; // stored anyway: the original is still there to open
  }
  await deps.sql`
    insert into jarvis.files (sha256, storage_path, mime_type, size_bytes, original_filename, text_status, text_content)
    values (${sha}, ${input.path}, ${input.mime ?? "application/octet-stream"}, ${bytes.length}, ${name}, ${status}, ${text})
    on conflict (sha256) do nothing`;
  return { fileId: sha, name, textStatus: status, chars: text?.length ?? 0, duplicate: false };
}
