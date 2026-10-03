import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../db/test/harness";
import { ingestSharedFile, SHARED_PATH_RE, toBase64 } from "../src/ingest";

// Files shared to JARVIS: stored once by content, text extracted, images read by the model, odd paths refused.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => t?.close());
beforeEach(async () => {
  await t.sql`truncate jarvis.files cascade`;
});

const PATH = "shared/0b0b0b0b-1111-4222-8333-444455556666.txt";
function fakeStorage(files: Record<string, Uint8Array>) {
  const removed: string[] = [];
  return {
    removed,
    async download(p: string) {
      const b = files[p];
      if (!b) throw new Error("missing");
      return b;
    },
    async remove(p: string) {
      removed.push(p);
    },
  };
}
const bytes = (s: string) => new TextEncoder().encode(s);

describe("ingestSharedFile", () => {
  it("stores a text file with its text, and a second copy only once", async () => {
    const storage = fakeStorage({ [PATH]: bytes("Class moved to 4 pm on Monday"), "shared/0b0b0b0b-1111-4222-8333-444455556667.txt": bytes("Class moved to 4 pm on Monday") });
    const r = await ingestSharedFile({ sql: t.sql, storage, readImage: null }, { path: PATH, name: "note.txt", mime: "text/plain" });
    expect([r.textStatus, r.chars, r.duplicate]).toEqual(["done", 29, false]);
    const [f] = await t.sql`select storage_path, original_filename, text_content from jarvis.files where sha256 = ${r.fileId}`;
    expect([f!.storage_path, f!.original_filename, f!.text_content]).toEqual([PATH, "note.txt", "Class moved to 4 pm on Monday"]);

    const again = await ingestSharedFile({ sql: t.sql, storage, readImage: null }, { path: "shared/0b0b0b0b-1111-4222-8333-444455556667.txt", name: "copy.txt", mime: "text/plain" });
    expect([again.fileId, again.duplicate]).toEqual([r.fileId, true]);
    expect(storage.removed).toEqual(["shared/0b0b0b0b-1111-4222-8333-444455556667.txt"]);
  });

  it("reads images with the model, and keeps them as originals without one", async () => {
    const img = "shared/0b0b0b0b-1111-4222-8333-444455556668.png";
    const storage = fakeStorage({ [img]: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) });
    const seen: string[] = [];
    const r = await ingestSharedFile({ sql: t.sql, storage, readImage: async (b64, mime) => (seen.push(`${mime}:${b64}`), "TEXT:\nQuiz on Friday\n\nDESCRIPTION:\nA WhatsApp message") }, { path: img, name: "chat.png", mime: "image/png" });
    expect(r.textStatus).toBe("done");
    expect(seen).toEqual([`image/png:${toBase64(new Uint8Array([137, 80, 78, 71, 1, 2, 3]))}`]);
    await t.sql`truncate jarvis.files cascade`;
    expect((await ingestSharedFile({ sql: t.sql, storage, readImage: null }, { path: img, name: "chat.png", mime: "image/png" })).textStatus).toBe("original");
  });

  it("only accepts paths the server signed", async () => {
    expect(SHARED_PATH_RE.test(PATH)).toBe(true);
    for (const p of ["mesa/aa/x.pdf", "shared/../mesa/x.pdf", "shared/abc.txt"]) {
      expect(SHARED_PATH_RE.test(p)).toBe(false);
      await expect(ingestSharedFile({ sql: t.sql, storage: fakeStorage({}), readImage: null }, { path: p, name: "x", mime: null })).rejects.toThrow("not a shared upload path");
    }
  });

  it("encodes base64 like the platform does", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(toBase64(big)).toBe(Buffer.from(big).toString("base64"));
  });
});
