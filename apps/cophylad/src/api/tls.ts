// The controller listener's certificate: self-signed, one per node, ECDSA P-256, with the
// node's addresses and its hostname in its subject alternative names, so a browser that
// accepts it once on `https://192.168.1.44:4818/` is not asked again while the address holds.
// The DER is written by hand from a few TLV helpers, so no tool outside `node:crypto` is needed.
// The pair is kept under `data/tls/` and made again only when it is missing, unreadable, near
// its end, or no longer names the one address the node is reached at (`[controller] address`,
// else its first private address on a real adapter): a hypervisor's switch that moved, or a
// VPN that came up, changes nothing. A browser then sees one more warning, which the log
// says. A certificate made again carries the addresses it is given and a few the last one
// had, so a machine that moves between two networks keeps one certificate for both.
//
// The user may bring a certificate of their own for a name of their own (`[controller]
// cert_file`, `key_file`): it is checked here before it is ever served, and served beside the
// node's own, by name. A connection by address, which names no host, gets the node's own.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Logger } from "../log.ts";

export interface CertificateSpec {
  dnsNames: string[];
  ips: string[];
  /** Validity in days from now. */
  days?: number;
  /** The common name of the subject and the issuer. */
  cn?: string;
  /**
   * The names a kept certificate must carry to be kept: the address the node is reached at.
   * Every name in the spec, when absent.
   */
  required?: { dnsNames?: string[]; ips?: string[] };
}

export interface KeyPair {
  keyPem: string;
  certPem: string;
}

// --- DER ---------------------------------------------------------------------------------

function len(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** One TLV: the tag, the length, the body. */
export function tlv(tag: number, body: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), len(body.length), body]);
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(parts));
const octets = (body: Uint8Array) => tlv(0x04, body);
const bool = (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0x00));
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const ia5 = (s: string) => tlv(0x16, new TextEncoder().encode(s));
/** A context-specific EXPLICIT tag around a value. */
const explicit = (n: number, body: Uint8Array) => tlv(0xa0 | n, body);
/** A context-specific IMPLICIT primitive tag around raw bytes. */
const implicit = (n: number, body: Uint8Array) => tlv(0x80 | n, body);

/** An INTEGER from big-endian magnitude bytes: a leading zero keeps it positive. */
function integer(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1]! & 0x80) === 0) i++;
  const body = bytes.subarray(i);
  return tlv(0x02, body[0]! & 0x80 ? concat([Uint8Array.of(0), body]) : body);
}

/** An OBJECT IDENTIFIER from its dotted form. */
export function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(out));
}

/** A BIT STRING with no unused bits. */
function bits(body: Uint8Array): Uint8Array {
  return tlv(0x03, concat([Uint8Array.of(0), body]));
}

/** UTCTime `YYMMDDHHMMSSZ`; X.509 reads two-digit years 50–99 as 1950–1999 and 00–49 as 2000–2049. */
function utcTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
}

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const CN = "2.5.4.3";
const SAN = "2.5.29.17";
const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";
const EXT_KEY_USAGE = "2.5.29.37";
const SUBJECT_KEY_ID = "2.5.29.14";
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

function name(cn: string): Uint8Array {
  return seq(set(seq(oid(CN), utf8(cn))));
}

function ipv4(ip: string): Uint8Array | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const bytes = m.slice(1).map(Number);
  if (bytes.some((b) => b > 255)) return undefined;
  return Uint8Array.from(bytes);
}

function extension(id: string, value: Uint8Array, critical = false): Uint8Array {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A fresh P-256 key and a self-signed certificate over it, both as PEM. */
/**
 * A self-signed certificate for `spec`, over a fresh P-256 key or `existingKey` when the
 * caller keeps one: a native app pins the key (its SPKI hash) at pairing, so a certificate
 * made again for a new address or a new year must sit on the same key.
 */
export function generateSelfSigned(spec: CertificateSpec, existingKey?: KeyObject): KeyPair {
  const { privateKey, publicKey } = existingKey ? { privateKey: existingKey, publicKey: createPublicKey(existingKey) } : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const cn = spec.cn ?? "cophylad";
  const days = spec.days ?? 3650;
  // Validity starts a few minutes back, for a phone whose clock runs ahead of the node's.
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(notBefore.getTime() + days * 86_400_000);
  const dns = [...new Set(spec.dnsNames.map((d) => d.trim()).filter(Boolean))];
  const ips = [...new Set(spec.ips.map((ip) => ip.trim()).filter(Boolean))];
  const names: Uint8Array[] = [];
  for (const d of dns) names.push(implicit(2, new TextEncoder().encode(d)));
  for (const ip of ips) {
    const raw = ipv4(ip);
    if (raw) names.push(implicit(7, raw));
  }
  // The key id is the SHA-1 of the public key bits, as RFC 5280 suggests (not used for trust).
  const bitString = spki.subarray(spki.length - 65);
  const keyId = createHash("sha1").update(bitString).digest();
  const extensions = explicit(
    3,
    seq(
      extension(BASIC_CONSTRAINTS, seq(), true),
      extension(KEY_USAGE, tlv(0x03, Uint8Array.of(0x07, 0x80)), true),
      extension(EXT_KEY_USAGE, seq(oid(SERVER_AUTH))),
      extension(SUBJECT_KEY_ID, octets(new Uint8Array(keyId))),
      extension(SAN, seq(...names)),
    ),
  );
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const tbs = seq(
    explicit(0, integer(Uint8Array.of(2))),
    integer(new Uint8Array(serial)),
    seq(oid(ECDSA_WITH_SHA256)),
    name(cn),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(cn),
    spki,
    extensions,
  );
  // node:crypto's ECDSA signature is DER-encoded by default: exactly what the BIT STRING holds.
  const signature = new Uint8Array(sign("sha256", tbs, privateKey));
  const cert = seq(tbs, seq(oid(ECDSA_WITH_SHA256)), bits(signature));
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    certPem: pem("CERTIFICATE", cert),
  };
}

// --- the node's pair -----------------------------------------------------------------------

export const KEY_FILE = "key.pem";
export const CERT_FILE = "cert.pem";
/** A certificate this close to its end is made again. */
const RENEW_BEFORE_MS = 30 * 86_400_000;

/** The names a certificate carries, from its SAN line: `DNS:a, IP Address:1.2.3.4`. */
export function certificateNames(certPem: string): { dns: string[]; ips: string[]; validTo: number } | undefined {
  try {
    const x = new X509Certificate(certPem);
    const dns: string[] = [];
    const ips: string[] = [];
    for (const part of (x.subjectAltName ?? "").split(",")) {
      const [kind, ...rest] = part.trim().split(":");
      const value = rest.join(":").trim();
      if (!value) continue;
      if (kind === "DNS") dns.push(value);
      else if (kind === "IP Address") ips.push(value);
    }
    return { dns, ips, validTo: new Date(x.validTo).getTime() };
  } catch {
    return undefined;
  }
}

/** Addresses of the certificate before that a new one still carries: a network the machine was on, and may be on again. */
export const PAST_ADDRESSES = 4;

/** Why a stored pair is not good enough for `spec`, or nothing when it is: unreadable, near its end, or without a name it must carry. */
export function certificateStale(certPem: string, spec: CertificateSpec, now = Date.now()): string | undefined {
  const names = certificateNames(certPem);
  if (!names) return "unreadable";
  if (!Number.isFinite(names.validTo) || names.validTo < now + RENEW_BEFORE_MS) return "expiring";
  const must = spec.required ?? { dnsNames: spec.dnsNames, ips: spec.ips };
  const missing = [...(must.dnsNames ?? []).filter((d) => !names.dns.includes(d)), ...(must.ips ?? []).filter((ip) => !names.ips.includes(ip))];
  if (missing.length > 0) return `missing ${missing.join(", ")}`;
  return undefined;
}

/** The names a certificate made now carries: what it must, what the spec gives, and a few addresses the one before it had. */
export function certificateNamesFor(spec: CertificateSpec, before?: string): { dnsNames: string[]; ips: string[] } {
  const dnsNames = [...new Set([...(spec.required?.dnsNames ?? []), ...spec.dnsNames])];
  const ips = [...new Set([...(spec.required?.ips ?? []), ...spec.ips])];
  const past = (before !== undefined ? (certificateNames(before)?.ips ?? []) : []).filter((ip) => !ips.includes(ip)).slice(0, PAST_ADDRESSES);
  return { dnsNames, ips: [...ips, ...past] };
}

/**
 * The pair under `dir`, reused while it parses, has a month left and carries the names it
 * must; made again otherwise, on the same key. Returns the PEMs and whether they are new.
 */
export function ensureCertificate(dir: string, spec: CertificateSpec, log?: Logger): KeyPair & { fresh: boolean } {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, KEY_FILE);
  const certPath = join(dir, CERT_FILE);
  let key: KeyObject | undefined;
  let before: string | undefined;
  if (existsSync(keyPath)) {
    const keyPem = readFileSync(keyPath, "utf8");
    try {
      key = createPrivateKey(keyPem);
      if (key.asymmetricKeyType !== "ec") key = undefined;
    } catch {
      key = undefined;
    }
    if (key && existsSync(certPath)) {
      before = readFileSync(certPath, "utf8");
      const why = certificateStale(before, spec);
      if (!why) return { keyPem, certPem: before, fresh: false };
      // the key stays: a phone that pinned it at pairing keeps trusting the node
      log?.info("controller certificate made again on the same key", { reason: why });
    } else if (!key) log?.warn("controller key unreadable; a new pair is made and a paired phone must pair again", { path: keyPath });
  }
  const names = certificateNamesFor(spec, before);
  const pair = generateSelfSigned({ ...spec, ...names }, key);
  writeFileSync(keyPath, pair.keyPem, { encoding: "utf8", mode: 0o600 });
  writeFileSync(certPath, pair.certPem, "utf8");
  log?.info("controller certificate written", { dir, names: [...names.dnsNames, ...names.ips] });
  return { ...pair, fresh: true };
}

// --- the user's own certificate -----------------------------------------------------------------

/** A certificate the user brought, checked: what is served for the names it carries. */
export interface OwnCertificate {
  certPem: string;
  keyPem: string;
  /** The host names it is served for: its subject alternative names. */
  names: string[];
  validTo: number;
}

/**
 * The user's certificate and key, read and checked before anything serves them: both files
 * read, the certificate parses, the key is the certificate's, today is inside its dates, and
 * it names a host. Throws with the reason, in words for the user, on anything else.
 */
export function loadOwnCertificate(certFile: string, keyFile: string, now = Date.now()): OwnCertificate {
  let certPem: string;
  let keyPem: string;
  try {
    certPem = readFileSync(certFile, "utf8");
  } catch (e) {
    throw new Error(`the certificate cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    keyPem = readFileSync(keyFile, "utf8");
  } catch (e) {
    throw new Error(`the key cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  let x: X509Certificate;
  try {
    // a file that holds a chain has the host's own certificate first
    x = new X509Certificate(certPem);
  } catch {
    throw new Error("the certificate file holds no certificate");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error("the key file holds no private key (one protected by a passphrase cannot be used)");
  }
  if (!x.checkPrivateKey(key)) throw new Error("the key does not match the certificate");
  const from = new Date(x.validFrom).getTime();
  const validTo = new Date(x.validTo).getTime();
  if (Number.isFinite(from) && now < from) throw new Error(`the certificate is not valid before ${new Date(from).toISOString().slice(0, 10)}`);
  if (!Number.isFinite(validTo) || now >= validTo) throw new Error(`the certificate ran out on ${Number.isFinite(validTo) ? new Date(validTo).toISOString().slice(0, 10) : "a date that cannot be read"}`);
  const names = [...new Set((certificateNames(certPem)?.dns ?? []).map((n) => n.toLowerCase()))];
  if (names.length === 0) throw new Error("the certificate names no host (it has no DNS name among its subject alternative names)");
  return { certPem, keyPem, names, validTo };
}

/** What changes when either file is written again: their sizes and times, or nothing while one is missing. */
export function fileStamp(...files: string[]): string | undefined {
  try {
    return files.map((f) => `${statSync(f).mtimeMs}:${statSync(f).size}`).join("|");
  } catch {
    return undefined;
  }
}

/** SHA-256 of the certificate's SubjectPublicKeyInfo as base64: what a native app pins at pairing. */
export function spkiHash(certPem: string): string {
  const x = new X509Certificate(certPem);
  return createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest("base64");
}

/** Every IPv4 address a phone could reach this node on, loopback included, and the names it goes by. */
export function lanEndpoints(): { ips: string[]; dnsNames: string[] } {
  const ips = new Set<string>(["127.0.0.1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      ips.add(i.address);
    }
  }
  const host = hostname().toLowerCase();
  const dnsNames = new Set<string>(["localhost"]);
  if (host) {
    dnsNames.add(host);
    // the name the local network resolves it under
    if (!host.includes(".")) dnsNames.add(`${host}.local`);
  }
  return { ips: [...ips], dnsNames: [...dnsNames] };
}

/**
 * An adapter that is no network other devices are on: a hypervisor's switch, a container's
 * bridge, a VPN's tunnel, a peer-to-peer radio link. Told by its name, which is all the
 * system says of it here.
 */
export function virtualAdapter(name: string): boolean {
  return /^(vEthernet|vboxnet|vmnet|docker|br-|veth|virbr|lxc|lxd|podman|cni|flannel|utun|tun|tap|wg|tailscale|zt|ham|bridge|awdl|llw|anpi|ap\d)/i.test(name) || /Hyper-V|WSL|VirtualBox|VMware|Virtual|Loopback|Tailscale|ZeroTier|WireGuard|Bluetooth|Local Area Connection\*/i.test(name);
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * The address other devices on the network reach this machine at: its first private IPv4 on
 * a real adapter; failing that a private one on any adapter, then any that is not loopback.
 */
export function pickAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
  const real: string[] = [];
  const other: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      (virtualAdapter(name) ? other : real).push(i.address);
    }
  }
  return real.find((ip) => PRIVATE_V4.test(ip)) ?? other.find((ip) => PRIVATE_V4.test(ip)) ?? real[0] ?? other[0];
}

/**
 * Every address another device might type to reach this machine: its private IPv4 addresses
 * on real adapters, in the system's order. A hypervisor's switch or a VPN's tunnel is no
 * network another computer is on, so its address is still this machine's (`machineNames`)
 * and is not offered to anyone.
 */
export function reachableAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (virtualAdapter(name)) continue;
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && PRIVATE_V4.test(i.address)) out.push(i.address);
  }
  return out;
}

/**
 * What a request's `Host` may call this machine: its addresses now, IPv6 ones too, its
 * hostname, and that name as the local network resolves it (`desk.local`).
 */
export function machineNames(): string[] {
  const names = new Set<string>(["127.0.0.1", "::1", "localhost"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      const zone = i.address.indexOf("%");
      names.add((zone >= 0 ? i.address.slice(0, zone) : i.address).toLowerCase());
    }
  }
  const host = hostname().toLowerCase();
  if (host) {
    names.add(host);
    if (!host.includes(".")) names.add(`${host}.local`);
  }
  return [...names];
}

/** The LAN IPv4 for the URL a device types: the node's own pick among its adapters, or, from a list of addresses, the first private one. */
export function lanAddress(ips?: string[]): string | undefined {
  if (ips === undefined) return pickAddress();
  return ips.find((ip) => PRIVATE_V4.test(ip)) ?? ips.find((ip) => ip !== "127.0.0.1");
}
