// Minimal Supabase Storage client over fetch (works in Node and Edge).
// Uses a server-side key only; files sit in a private bucket.

export interface BlobStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  download?(path: string): Promise<Uint8Array>;
}

export class SupabaseStorage implements BlobStorage {
  constructor(
    private readonly projectUrl: string,
    private readonly serverKey: string,
    private readonly bucket = "mesa-files",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.serverKey, ...extra };
    // Legacy service-role keys are JWTs and go in Authorization; new sb_secret_ keys only in apikey.
    if (this.serverKey.startsWith("eyJ")) h.Authorization = `Bearer ${this.serverKey}`;
    return h;
  }

  private url(path: string) {
    return `${this.projectUrl.replace(/\/+$/, "")}/storage/v1/object/${this.bucket}/${path}`;
  }

  async upload(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers({ "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" }),
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    if (!res.ok) throw new Error(`Storage upload failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  /**
   * A one-time URL the browser can PUT one file to (valid ~2 hours), so large shared files go straight to
   * Storage instead of through a size-limited server function. Only for paths the server chose.
   */
  async signUpload(path: string): Promise<string> {
    const base = this.projectUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${base}/storage/v1/object/upload/sign/${this.bucket}/${path}`, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: "{}" });
    const j = (await res.json().catch(() => ({}))) as { url?: string };
    if (!res.ok || !j.url) throw new Error(`Storage upload URL failed: HTTP ${res.status}`);
    return `${base}/storage/v1${j.url}`;
  }

  async remove(path: string): Promise<void> {
    const res = await this.fetchImpl(this.url(path), { method: "DELETE", headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed: HTTP ${res.status}`);
  }

  async download(path: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(this.url(path), { headers: this.headers() });
    if (!res.ok) throw new Error(`Storage download failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
