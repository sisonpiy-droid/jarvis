import "server-only";
import { SupabaseStorage } from "@jarvis/files";

export function storage(): SupabaseStorage {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Storage isn't configured");
  return new SupabaseStorage(url, key);
}

/** RFC 5987 filename for Content-Disposition. */
export function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
