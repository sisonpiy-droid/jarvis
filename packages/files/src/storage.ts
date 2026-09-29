// Minimal Supabase Storage client over fetch (works in Node and Edge).
// Uses a server-side key only; files sit in a private bucket.

export interface BlobStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export class SupabaseStorage implements BlobStorage {
  constructor(
    private readonly projectUrl: string,
    private readonly serverKey: string,
    private readonly bucket = "mesa-files",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const headers: Record<string, string> = { apikey: this.serverKey, "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" };
    // Legacy service-role keys are JWTs and go in Authorization; new sb_secret_ keys only in apikey.
    if (this.serverKey.startsWith("eyJ")) headers.Authorization = `Bearer ${this.serverKey}`;
    const res = await this.fetchImpl(`${this.projectUrl.replace(/\/+$/, "")}/storage/v1/object/${this.bucket}/${path}`, {
      method: "POST",
      headers,
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    if (!res.ok) throw new Error(`Storage upload failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}
