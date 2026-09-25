// The backup's cryptography, all of it local: the passphrase becomes a master key by scrypt
// with a salt the server keeps in the header, the master key becomes three by HKDF (one to
// seal objects, one to name them, one eight-byte id that is public and proves the
// passphrase), and each object is AES-256-GCM under a fresh nonce with its kind, its name
// and its version bound in as the associated data, so the server can neither swap two
// objects nor hand back an older version of one unnoticed. Object names are HMACs of the
// logical id: the same row always lands under the same name, and the name says nothing.
// The key file keeps the master key and nothing that identifies the account.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { BackupHeader, BackupKind } from "@cophyla/protocol";

export type Kdf = BackupHeader["kdf"];

/** scrypt at 2^15, r 8, p 1: about 32 MiB and a tenth of a second on a laptop, once per enable or restore. */
export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SCRYPT_MAX_MEM = 128 * 1024 * 1024;
export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_ID_BYTES = 8;
export const OBJECT_KEY_CHARS = 22;
export const FORMAT_VERSION = 1;
/** Plaintext over this is not backed up: the frame it would need is bigger than the link allows. */
export const MAX_PLAINTEXT_BYTES = 2 * 1024 * 1024;

export interface BackupKeys {
  master: Buffer;
  enc: Buffer;
  mac: Buffer;
  /** Public: base64url of eight bytes. */
  keyId: string;
}

const b64url = (b: Buffer): string => b.toString("base64url");

/** A fresh KDF header part: a random salt at the platform's parameters. */
export function newKdf(): Kdf {
  return { name: "scrypt", salt: randomBytes(SALT_BYTES).toString("base64"), n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
}

/** The three keys and the id from a master key. */
export function expandKeys(master: Buffer): BackupKeys {
  const sub = (info: string, len: number) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(`cophyla backup ${info}`, "utf8"), len));
  return { master, enc: sub("enc", KEY_BYTES), mac: sub("mac", KEY_BYTES), keyId: b64url(sub("id", KEY_ID_BYTES)) };
}

/** The keys a passphrase gives under a header's KDF: the same passphrase and salt, the same keys, on any machine. */
export function deriveKeys(passphrase: string, kdf: Kdf): BackupKeys {
  if (kdf.name !== "scrypt") throw new Error(`unknown kdf ${String(kdf.name)}`);
  if (kdf.n > 2 ** 20 || kdf.r > 32 || kdf.p > 16) throw new Error("the backup's kdf parameters are beyond what this node will run");
  const master = scryptSync(Buffer.from(passphrase.normalize("NFKC"), "utf8"), Buffer.from(kdf.salt, "base64"), KEY_BYTES, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAX_MEM });
  return expandKeys(master);
}

/** Constant-time equality of two key ids. */
export function sameKeyId(a: string, b: string): boolean {
  const x = Buffer.from(a, "base64url");
  const y = Buffer.from(b, "base64url");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The server's name for an object: an HMAC of its kind and logical id, deterministic and opaque. */
export function objectKey(mac: Buffer, kind: BackupKind, id: string): string {
  return b64url(createHmac("sha256", mac).update(`${kind}\0${id}`, "utf8").digest()).slice(0, OBJECT_KEY_CHARS);
}

const aad = (kind: BackupKind, key: string, version: number): Buffer => Buffer.from(`${kind}|${key}|${version}`, "utf8");

/** `v(1) | nonce(12) | ciphertext | tag(16)`, base64. */
export function seal(enc: Buffer, kind: BackupKind, key: string, version: number, plaintext: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", enc, nonce);
  cipher.setAAD(aad(kind, key, version));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, ct, cipher.getAuthTag()]).toString("base64");
}

/** The plaintext of a sealed object, or a throw when the key, the kind, the name, the version or a byte is not what it was sealed with. */
export function open(enc: Buffer, kind: BackupKind, key: string, version: number, ciphertext: string): Buffer {
  const blob = Buffer.from(ciphertext, "base64");
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error("the object is too short to be one");
  if (blob[0] !== FORMAT_VERSION) throw new Error(`the object's format ${blob[0]} is not one this node reads`);
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ct = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", enc, nonce);
  decipher.setAAD(aad(kind, key, version));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** The key file: `data/backup.key`, mode 0600, the master key and its id; deleted when backup is turned off. */
export class BackupKeyFile {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): BackupKeys | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8")) as { v?: unknown; master?: unknown };
      if (j.v !== FORMAT_VERSION || typeof j.master !== "string") return undefined;
      const master = Buffer.from(j.master, "base64");
      if (master.length !== KEY_BYTES) return undefined;
      return expandKeys(master);
    } catch {
      return undefined;
    }
  }

  write(keys: BackupKeys): void {
    writeFileSync(this.path, JSON.stringify({ v: FORMAT_VERSION, keyId: keys.keyId, master: keys.master.toString("base64") }) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  delete(): void {
    rmSync(this.path, { force: true });
  }
}
