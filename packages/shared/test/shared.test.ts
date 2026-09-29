import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash, generateKey, open, redact, seal } from "../src/index";

describe("secret-box", () => {
  it("round-trips", async () => {
    const key = generateKey();
    expect(await open(await seal("hello ✓", key), key)).toBe("hello ✓");
  });
  it("uses a fresh IV each time", async () => {
    const key = generateKey();
    expect(await seal("x", key)).not.toBe(await seal("x", key));
  });
  it("detects tampering and wrong keys", async () => {
    const key = generateKey();
    const sealed = await seal("secret session", key);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered!!!!!!").toString("base64");
    await expect(open(parts.join("."), key)).rejects.toThrow();
    await expect(open(sealed, generateKey())).rejects.toThrow();
  });
  it("reads envelopes written by the previous node:crypto implementation", async () => {
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update("legacy", "utf8"), c.final()]);
    const legacy = ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
    expect(await open(legacy, key.toString("base64"))).toBe("legacy");
  });
  it("rejects short keys", async () => {
    await expect(seal("x", Buffer.from("short").toString("base64"))).rejects.toThrow(/32 bytes/);
  });
});

describe("canonical hashing", () => {
  it("ignores key order and undefined fields", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
  it("distinguishes array order", () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });
});

describe("redact", () => {
  it("scrubs secret-named keys, JWTs, bearer headers and URL signatures", () => {
    const out = redact({
      password: "hunter2",
      headers: { Authorization: "Bearer abc.def", cookie: "sid=1" },
      msg: "token eyJhbGciOi.eyJzdWIiOi.sig in text",
      url: "https://storage.googleapis.com/b/f?GoogleAccessId=svc&Expires=1&Signature=SECRET",
      count: 3,
    });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|abc\.def|sid=1|eyJhbGciOi|SECRET|GoogleAccessId=svc/);
    expect(out).toMatchObject({ count: 3 });
  });
});
