// The end-to-end layer of a relay tunnel, and of every node link, WebCrypto only so the
// daemon, the phone's web view and the tests share one implementation. A tunnel is set up by
// one round trip (the initiator's ephemeral public key out, the responder's back: `relay.open`
// through the server, the sealed hello on the LAN) and keyed from the ECDH secret and a
// pre-shared secret both ends already hold: the grant's key for a phone or a node, an invite's
// secret for a machine enrolling (`enroll`), so a server or a proxy that forwards the
// handshake can derive nothing, and a peer that lacks the secret fails on its first record.
// Fresh ephemerals per tunnel give forward secrecy: a secret learnt later opens no record
// taken before. The one
// exception is the tunnel a phone pairs through when it signed in with the account: the two
// ends share nothing yet, so its secret is a public constant (`pairingPsk`), and that tunnel
// is only as private as the server that routes it is honest. Every frame
// of the inner protocol is one AES-256-GCM record with an implicit sequence number per
// direction: a record out of order, replayed or tampered with fails to open, and the tunnel
// closes on that. No rekeying; a direction closes at 2^32 records; fresh ephemerals per tunnel.
//
//   shared = ECDH(e_self, E_peer)                       X25519, or P-256 where the platform lacks it
//   k_dir  = HKDF-SHA256(salt = psk, ikm = shared, info = "cophyla-relay/1" | kind | peer | epk_i | epk_r | dir)
//   record = AES-256-GCM(k_dir, nonce = dirTag(4) | seq(8, big-endian), aad = nonce, utf8(frame))
//   frame  = base64(ciphertext | tag)

export const RELAY_VERSION = "cophyla-relay/1";

export type RelayCurve = "x25519" | "p256";
export type TunnelRole = "initiator" | "responder";
/**
 * What a tunnel joins: a phone (`controller`), a node linking to its primary (`node`), a
 * phone pairing through the account (`pair`), or a machine redeeming an invite (`enroll`);
 * on a data channel a phone or a node (`direct`), keyed from the same secret but never from
 * the same keys.
 */
export type TunnelKind = "controller" | "node" | "pair" | "enroll" | "direct";

/** A fresh key pair for one tunnel, and its public half as it travels. */
export interface Ephemeral {
  curve: RelayCurve;
  publicKey: string;
  privateKey: CryptoKey;
}

/** Bytes backed by a plain `ArrayBuffer`, which is what WebCrypto takes. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** A pre-shared secret, as raw bytes. */
export type Psk = Bytes;

export interface TunnelBinding {
  kind: TunnelKind;
  /** The initiator's peer id: the controller id, or the secondary node's id. */
  peer: string;
}

/** Records per direction before a tunnel must close: the 64-bit sequence never wraps, the cap is policy. */
export const MAX_RECORDS = 2 ** 32;
const TAG_I2R = new Uint8Array([0, 0, 0, 1]);
const TAG_R2I = new Uint8Array([0, 0, 0, 2]);

const subtle = () => crypto.subtle;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The platform's own base64 on bytes, where it has it (Bun, recent browsers): seventy times the loop below on a large record. */
const nativeBase64 = Uint8Array as unknown as { fromBase64?: (s: string) => Bytes; prototype: { toBase64?: () => string } };

export function toBase64(bytes: Uint8Array): string {
  if (typeof nativeBase64.prototype.toBase64 === "function") return (bytes as unknown as { toBase64(): string }).toBase64();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Bytes {
  if (typeof nativeBase64.fromBase64 === "function") return nativeBase64.fromBase64(text);
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("expected hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function algorithm(curve: RelayCurve): { name: string; namedCurve?: string } {
  return curve === "p256" ? { name: "ECDH", namedCurve: "P-256" } : { name: "X25519" };
}

/** A fresh ephemeral key pair; X25519 unless asked for P-256. */
export async function ephemeral(curve: RelayCurve = "x25519"): Promise<Ephemeral> {
  const pair = (await subtle().generateKey(algorithm(curve), true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return { curve, publicKey: toBase64(raw), privateKey: pair.privateKey };
}

/** The pairing secret as `RelayAccess.key` carries it: 32 bytes as hex. */
export function pskFromHex(hex: string): Psk {
  const bytes = fromHex(hex);
  if (bytes.length !== 32) throw new Error("expected a 32-byte secret");
  return bytes;
}

/**
 * An invite's pre-shared secret: SHA-256 of the secret's text, which is what the node that
 * minted it keeps (the hash as hex, so `pskFromHex` of it gives the same bytes there).
 */
export async function pskFromSecret(secret: string): Promise<Psk> {
  return new Uint8Array(await subtle().digest("SHA-256", utf8.encode(secret)));
}

/**
 * The pairing tunnel's pre-shared secret: SHA-256 of a public label. The phone and the node
 * share no secret before the pairing, so this keys the tunnel against the wire and the
 * server's logs, and against nothing else; the relay secret handed over inside it keys
 * every tunnel after.
 */
export async function pairingPsk(): Promise<Psk> {
  return new Uint8Array(await subtle().digest("SHA-256", utf8.encode(`${RELAY_VERSION} pair`)));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One direction of a tunnel: its key, its tag, and the sequence of the next record. */
class Direction {
  private key: CryptoKey;
  private tag: Bytes;
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(key: CryptoKey, tag: Bytes) {
    this.key = key;
    this.tag = tag;
  }

  private nonce(seq: number): Bytes {
    const n = new Uint8Array(12);
    n.set(this.tag, 0);
    new DataView(n.buffer).setBigUint64(4, BigInt(seq));
    return n;
  }

  /** Serialized: the records leave in sequence order however the callers interleave. */
  private next<T>(work: (seq: number) => Promise<T>): Promise<T> {
    if (this.seq >= MAX_RECORDS) return Promise.reject(new TunnelError("exhausted", "the tunnel reached its record limit"));
    const seq = this.seq++;
    const p = this.chain.then(() => work(seq));
    this.chain = p.catch(() => undefined);
    return p;
  }

  seal(text: string): Promise<string> {
    return this.next(async (seq) => {
      const nonce = this.nonce(seq);
      const ct = await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: nonce }, this.key, utf8.encode(text));
      return toBase64(new Uint8Array(ct));
    });
  }

  open(frame: string): Promise<string> {
    return this.next(async (seq) => {
      const nonce = this.nonce(seq);
      let bytes: Bytes;
      try {
        bytes = fromBase64(frame);
      } catch {
        throw new TunnelError("bad_record", "a record was not base64");
      }
      let pt: ArrayBuffer;
      try {
        pt = await subtle().decrypt({ name: "AES-GCM", iv: nonce, additionalData: nonce }, this.key, bytes);
      } catch {
        throw new TunnelError("bad_record", `record ${seq} failed to open`);
      }
      try {
        return fromUtf8.decode(pt);
      } catch {
        throw new TunnelError("bad_record", `record ${seq} was not utf-8`);
      }
    });
  }
}

export type TunnelErrorCode = "bad_record" | "exhausted" | "bad_key";

export class TunnelError extends Error {
  readonly code: TunnelErrorCode;
  constructor(code: TunnelErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A keyed tunnel: `seal` for what goes out, `open` for what comes in, each serialized. */
export class Tunnel {
  readonly role: TunnelRole;
  readonly binding: TunnelBinding;
  private out: Direction;
  private in: Direction;

  constructor(role: TunnelRole, binding: TunnelBinding, out: Direction, inbound: Direction) {
    this.role = role;
    this.binding = binding;
    this.out = out;
    this.in = inbound;
  }

  /** Encrypts one frame of the inner protocol into a record. */
  seal(text: string): Promise<string> {
    return this.out.seal(text);
  }

  /** Decrypts one record; throws `TunnelError` on anything that does not open, after which the tunnel must close. */
  open(frame: string): Promise<string> {
    return this.in.open(frame);
  }
}

async function importPublic(curve: RelayCurve, b64: string): Promise<CryptoKey> {
  let raw: Bytes;
  try {
    raw = fromBase64(b64);
  } catch {
    throw new TunnelError("bad_key", "the peer's key was not base64");
  }
  try {
    return await subtle().importKey("raw", raw, algorithm(curve), true, []);
  } catch {
    throw new TunnelError("bad_key", "the peer's key is not a point on the curve");
  }
}

/**
 * Derives the tunnel from one's own ephemeral, the peer's public key, the pre-shared
 * secret and the binding. The initiator's key comes first in `info` on both sides, so the
 * two ends agree; a different `binding` or `psk` on either side yields keys that never
 * open a record.
 */
export async function derive(role: TunnelRole, self: Ephemeral, peerPublicKey: string, psk: Psk, binding: TunnelBinding): Promise<Tunnel> {
  const peerKey = await importPublic(self.curve, peerPublicKey);
  const shared = new Uint8Array(await subtle().deriveBits({ name: algorithm(self.curve).name, public: peerKey }, self.privateKey, 256));
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const epkI = role === "initiator" ? self.publicKey : peerPublicKey;
  const epkR = role === "initiator" ? peerPublicKey : self.publicKey;
  const base = concat(utf8.encode(RELAY_VERSION), utf8.encode("|" + binding.kind + "|" + binding.peer + "|" + epkI + "|" + epkR + "|"));
  const keyFor = async (dir: "i2r" | "r2i"): Promise<CryptoKey> => {
    const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: psk, info: concat(base, utf8.encode(dir)) }, ikm, 256);
    return subtle().importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  };
  const [kI2R, kR2I] = await Promise.all([keyFor("i2r"), keyFor("r2i")]);
  const i2r = new Direction(kI2R, TAG_I2R);
  const r2i = new Direction(kR2I, TAG_R2I);
  return role === "initiator" ? new Tunnel(role, binding, i2r, r2i) : new Tunnel(role, binding, r2i, i2r);
}
