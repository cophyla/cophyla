// Signing and checking a release entry, and hashing an artifact. Ed25519 over the canonical
// payload from `@cophyla/protocol` (`releasePayload`: the entry without `url` and `signature`);
// public keys are SPKI DER in base64, private keys PKCS#8 PEM, both from `node:crypto`.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { releasePayload, SIGNATURE_PREFIX } from "@cophyla/protocol";

/** Signs `release` (its `signature`, if any, is replaced) and returns the entry with the new signature. */
export function signRelease<T extends Record<string, unknown>>(release: T, privateKeyPem: string): T & { signature: string } {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(releasePayload(release), "utf8"), key);
  return { ...release, signature: SIGNATURE_PREFIX + sig.toString("base64") };
}

function publicKey(spkiBase64: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

/**
 * True when `release.signature` checks against one of `keys`. Takes the entry as it came off
 * the wire so unknown fields stay covered; `url` may differ from what was signed.
 */
export function verifyRelease(release: Record<string, unknown>, keys: string[]): boolean {
  const signature = release["signature"];
  if (typeof signature !== "string" || !signature.startsWith(SIGNATURE_PREFIX)) return false;
  const sig = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), "base64");
  if (sig.length !== 64) return false;
  const data = Buffer.from(releasePayload(release), "utf8");
  for (const k of keys) {
    const key = publicKey(k);
    if (!key) continue;
    try {
      if (verify(null, data, key, sig)) return true;
    } catch {
      // a malformed key or signature is a failed check, not an error
    }
  }
  return false;
}

/** The file's SHA-256 as lowercase hex, streamed. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
