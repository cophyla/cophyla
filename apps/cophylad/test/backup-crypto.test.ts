// The backup's cryptography: the passphrase and the header's salt give the same keys
// anywhere, a wrong passphrase gives another key id and opens nothing, an object is bound
// to its kind, name and version, names are opaque and deterministic, the key file round-trips.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupKeyFile, KEY_ID_BYTES, MAX_PLAINTEXT_BYTES, OBJECT_KEY_CHARS, SCRYPT_N, deriveKeys, newKdf, objectKey, open, sameKeyId, seal } from "../src/cloud/backup-crypto.ts";

describe("backup crypto", () => {
  test("a header's kdf and the passphrase give the same keys twice; another passphrase or salt gives others", () => {
    const kdf = newKdf();
    expect(kdf).toMatchObject({ name: "scrypt", n: SCRYPT_N, r: 8, p: 1 });
    expect(Buffer.from(kdf.salt, "base64").length).toBe(16);
    const a = deriveKeys("correct horse battery staple", kdf);
    const b = deriveKeys("correct horse battery staple", kdf);
    expect(a.master.equals(b.master)).toBe(true);
    expect(a.enc.equals(b.enc)).toBe(true);
    expect(a.mac.equals(b.mac)).toBe(true);
    expect(a.keyId).toBe(b.keyId);
    expect(Buffer.from(a.keyId, "base64url").length).toBe(KEY_ID_BYTES);
    // the three keys differ from one another and from the master
    expect(a.enc.equals(a.mac)).toBe(false);
    expect(a.enc.equals(a.master)).toBe(false);
    const wrong = deriveKeys("correct horse battery stapler", kdf);
    expect(wrong.keyId).not.toBe(a.keyId);
    expect(sameKeyId(wrong.keyId, a.keyId)).toBe(false);
    expect(sameKeyId(a.keyId, b.keyId)).toBe(true);
    const other = deriveKeys("correct horse battery staple", newKdf());
    expect(other.keyId).not.toBe(a.keyId);
    // the header's parameters decide the derivation: a different cost is a different key
    const cheaper = deriveKeys("correct horse battery staple", { ...kdf, n: 1024 });
    expect(cheaper.keyId).not.toBe(a.keyId);
    // unicode is normalised, so a passphrase typed on two keyboards is one passphrase
    expect(deriveKeys("café", kdf).keyId).toBe(deriveKeys("café", kdf).keyId);
  });

  test("names are opaque, deterministic and per kind", () => {
    const { mac } = deriveKeys("p", newKdf());
    const k1 = objectKey(mac, "chat", "thread:thr_1");
    expect(k1).toBe(objectKey(mac, "chat", "thread:thr_1"));
    expect(k1.length).toBe(OBJECT_KEY_CHARS);
    expect(k1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(k1).not.toContain("thr_1");
    expect(objectKey(mac, "tasks", "thread:thr_1")).not.toBe(k1);
    expect(objectKey(mac, "chat", "thread:thr_2")).not.toBe(k1);
    expect(objectKey(deriveKeys("q", newKdf()).mac, "chat", "thread:thr_1")).not.toBe(k1);
  });

  test("an object opens under its kind, name and version, and under nothing else", () => {
    const keys = deriveKeys("p", newKdf());
    const plaintext = Buffer.from(JSON.stringify({ id: "thread:thr_1", table: "threads", row: { id: "thr_1", topic: "secret topic" } }));
    const ct = seal(keys.enc, "chat", "k1", 3, plaintext);
    expect(ct).not.toContain("secret");
    expect(Buffer.from(ct, "base64").toString("latin1")).not.toContain("secret topic");
    // two seals differ: a fresh nonce each time
    expect(seal(keys.enc, "chat", "k1", 3, plaintext)).not.toBe(ct);
    expect(open(keys.enc, "chat", "k1", 3, ct).equals(plaintext)).toBe(true);
    expect(() => open(keys.enc, "tasks", "k1", 3, ct)).toThrow();
    expect(() => open(keys.enc, "chat", "k2", 3, ct)).toThrow();
    expect(() => open(keys.enc, "chat", "k1", 2, ct)).toThrow();
    expect(() => open(deriveKeys("wrong", newKdf()).enc, "chat", "k1", 3, ct)).toThrow();
    // a flipped byte in the body, the nonce or the tag
    const bytes = Buffer.from(ct, "base64");
    for (const at of [1, 20, bytes.length - 1]) {
      const flipped = Buffer.from(bytes);
      flipped[at] = flipped[at]! ^ 0x01;
      expect(() => open(keys.enc, "chat", "k1", 3, flipped.toString("base64"))).toThrow();
    }
    expect(() => open(keys.enc, "chat", "k1", 3, "AAAA")).toThrow();
    expect(MAX_PLAINTEXT_BYTES).toBe(2 * 1024 * 1024);
  });

  test("the key file keeps the master key at 0600 and nothing about the account; a bad file reads as no key", () => {
    const dir = mkdtempSync(join(tmpdir(), "cophyla-bk-"));
    try {
      const path = join(dir, "backup.key");
      const f = new BackupKeyFile(path);
      expect(f.read()).toBeUndefined();
      const keys = deriveKeys("p", newKdf());
      f.write(keys);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      const text = readFileSync(path, "utf8");
      expect(text).toContain(keys.keyId);
      expect(text).not.toContain(keys.enc.toString("base64"));
      const back = f.read()!;
      expect(back.master.equals(keys.master)).toBe(true);
      expect(back.enc.equals(keys.enc)).toBe(true);
      expect(back.keyId).toBe(keys.keyId);
      f.delete();
      expect(f.read()).toBeUndefined();
      const bad = new BackupKeyFile(join(dir, "bad.key"));
      require("node:fs").writeFileSync(join(dir, "bad.key"), "{}");
      expect(bad.read()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
