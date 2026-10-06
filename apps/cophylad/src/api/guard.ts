// The guard in front of the LAN listener and the stream listener. Three questions, asked of
// every request before anything else is looked at: who is asking (the peer's address: this
// machine, a private network this machine is directly on, or a range `[controller] networks`
// names), under which name (`Host`: one of this machine's own, so a page on some other name
// that was made to resolve here is refused), and from which page (`Origin`, on a WebSocket
// upgrade: none, as an app's plugin socket, the command line and a node link send, or this
// listener's own). It runs in the listener's `fetch`, so after the TLS handshake: Bun has no
// earlier hook. The answers are pure functions over what the request carries; `Guard` holds
// what they are asked against (the networks, the names), remembers the last refusal for
// `lan.info`, and says each one in the log with the key that would let it in.
//
// `PairLimiter` counts the misses of the requests that guess at a secret, per address, and
// the sockets that have not said who they are.

import { networkInterfaces } from "node:os";
import type { Logger } from "../log.ts";

// --- addresses -----------------------------------------------------------------------------

export interface Address {
  family: 4 | 6;
  bytes: Uint8Array;
}

/** A range of addresses: the base with its host bits cleared, and how many bits name the network. */
export interface Cidr extends Address {
  bits: number;
  text: string;
}

function parseV4(text: string): Uint8Array | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return undefined;
  const bytes = m.slice(1).map(Number);
  return bytes.some((b) => b > 255) ? undefined : Uint8Array.from(bytes);
}

function parseV6(text: string): Uint8Array | undefined {
  let s = text;
  let tail: Uint8Array | undefined;
  // a dotted quad at the end is the last 32 bits: two groups stand in for it while the rest is read
  if (s.includes(".")) {
    const at = s.lastIndexOf(":");
    tail = parseV4(s.slice(at + 1));
    if (!tail || at < 0) return undefined;
    s = `${s.slice(0, at + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const all = [...head, ...Array<string>(fill).fill("0"), ...rest];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = all[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

/**
 * An address as bytes: brackets and a zone (`%eth0`) dropped, and an IPv4 address that came in
 * an IPv6 socket (`::ffff:192.168.1.7`) read as the IPv4 address it is.
 */
export function parseAddress(text: string): Address | undefined {
  let s = text.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = parseV4(s);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseV6(s);
  if (!v6) return undefined;
  const mapped = v6.subarray(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? { family: 4, bytes: v6.slice(12) } : { family: 6, bytes: v6 };
}

/** An address as text again: dotted for IPv4, eight groups for IPv6. */
export function formatAddress(a: Address): string {
  if (a.family === 4) return [...a.bytes].join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((a.bytes[i]! << 8) | a.bytes[i + 1]!).toString(16));
  return groups.join(":");
}

/** `192.168.1.0/24`, `fd00::/8`, or one address, which is a range of itself. */
export function parseCidr(text: string): Cidr | undefined {
  const [base, len, ...more] = text.trim().split("/");
  if (more.length > 0 || base === undefined) return undefined;
  const address = parseAddress(base);
  if (!address) return undefined;
  const max = address.family === 4 ? 32 : 128;
  if (len !== undefined && !/^\d{1,3}$/.test(len)) return undefined;
  const bits = len === undefined ? max : Number(len);
  if (bits > max) return undefined;
  const bytes = address.bytes.slice();
  for (let i = 0; i < bytes.length; i++) {
    const keep = Math.min(8, Math.max(0, bits - i * 8));
    bytes[i] = bytes[i]! & (0xff << (8 - keep));
  }
  return { family: address.family, bytes, bits, text: `${formatAddress({ family: address.family, bytes })}/${bits}` };
}

export function inCidr(a: Address, cidr: Cidr): boolean {
  if (a.family !== cidr.family) return false;
  for (let i = 0; i * 8 < cidr.bits; i++) {
    const keep = Math.min(8, cidr.bits - i * 8);
    const mask = (0xff << (8 - keep)) & 0xff;
    if ((a.bytes[i]! & mask) !== cidr.bytes[i]!) return false;
  }
  return true;
}

const cidrs = (...texts: string[]): Cidr[] => texts.map((t) => parseCidr(t)!);
const LOOPBACK = cidrs("127.0.0.0/8", "::1/128");
/** The ranges no router on the internet carries: RFC 1918, link-local, and IPv6's unique-local and link-local. */
const PRIVATE = cidrs("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10");

export function isLoopback(a: Address): boolean {
  return LOOPBACK.some((c) => inCidr(a, c));
}

export function isPrivate(a: Address): boolean {
  return PRIVATE.some((c) => inCidr(a, c));
}

type Interfaces = ReturnType<typeof networkInterfaces>;

function prefixOf(netmask: string): number | undefined {
  const mask = parseAddress(netmask);
  if (!mask) return undefined;
  let bits = 0;
  for (const b of mask.bytes) {
    if (b === 0xff) bits += 8;
    else {
      for (let m = 0x80; m > 0 && b & m; m >>= 1) bits++;
      break;
    }
  }
  return bits;
}

/**
 * The private subnets this machine is directly on: each adapter's own range, when its address
 * is a private one. An adapter with a public address lends nothing: its neighbours are strangers.
 */
export function attachedSubnets(interfaces: Interfaces = networkInterfaces()): Cidr[] {
  const out = new Map<string, Cidr>();
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      const address = parseAddress(i.address);
      if (!address || !isPrivate(address)) continue;
      const bits = i.cidr ? Number(i.cidr.split("/")[1]) : prefixOf(i.netmask);
      if (bits === undefined || !Number.isFinite(bits)) continue;
      const cidr = parseCidr(`${formatAddress(address)}/${bits}`);
      if (cidr) out.set(cidr.text, cidr);
    }
  }
  return [...out.values()];
}

/** `[controller] networks` read: `local` is this machine's own private subnets, `any` is everyone, the rest are ranges. */
export interface Networks {
  any: boolean;
  local: boolean;
  cidrs: Cidr[];
}

/** Why an entry of `[controller] networks` cannot be read, or nothing. */
export function badNetwork(entry: string): string | undefined {
  if (entry === "local" || entry === "any") return undefined;
  return parseCidr(entry) ? undefined : `"${entry}" is not "local", "any" or a range like 192.168.1.0/24`;
}

export function parseNetworks(list: readonly string[]): Networks {
  const out: Networks = { any: false, local: false, cidrs: [] };
  for (const entry of list) {
    if (entry === "any") out.any = true;
    else if (entry === "local") out.local = true;
    else {
      const cidr = parseCidr(entry);
      if (!cidr) throw new Error(`[controller] networks: ${badNetwork(entry)}`);
      out.cidrs.push(cidr);
    }
  }
  return out;
}

/** Whether a peer at `address` is served: this machine always, then what the networks say. */
export function peerAllowed(address: string, networks: Networks, subnets: () => Cidr[]): boolean {
  if (networks.any) return true;
  const a = parseAddress(address);
  if (!a) return false;
  if (isLoopback(a)) return true;
  if (networks.cidrs.some((c) => inCidr(a, c))) return true;
  return networks.local && subnets().some((c) => inCidr(a, c));
}

/** The range to add for a refused peer, as the log suggests it: its /24, or its /64. */
export function rangeFor(address: string): string | undefined {
  const a = parseAddress(address);
  if (!a) return undefined;
  return parseCidr(`${formatAddress(a)}/${a.family === 4 ? 24 : 64}`)?.text;
}

// --- Host and Origin -----------------------------------------------------------------------

/** A `Host` header safe to put in a URL and a content-security policy. */
const HOST = /^[A-Za-z0-9._-]+(:\d{1,5})?$/;
const HOST_IPV6 = /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/** Whether a `Host` header is one a URL can be made of. */
export function validHost(host: string | null | undefined): host is string {
  return typeof host === "string" && (HOST.test(host) || HOST_IPV6.test(host));
}

/** The name in a `Host` header: lowercased, without the port (so a port mapping still works) or an IPv6 literal's brackets. */
export function hostName(host: string | null | undefined): string | undefined {
  if (!validHost(host)) return undefined;
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]")).toLowerCase();
  const colon = host.lastIndexOf(":");
  return (colon >= 0 ? host.slice(0, colon) : host).toLowerCase().replace(/\.$/, "");
}

/** A name on this machine's loopback. */
export function loopbackName(name: string | undefined): boolean {
  if (name === undefined) return false;
  if (name === "localhost") return true;
  const a = parseAddress(name);
  return a !== undefined && isLoopback(a);
}

/** Whether `name` is one of `names`, a wildcard certificate name (`*.home.example`) standing for one label. */
export function nameAllowed(name: string, names: Iterable<string>): boolean {
  // an address is compared as the address it is, however it was written
  const address = parseAddress(name);
  const same = address ? formatAddress(address) : undefined;
  for (const n of names) {
    const own = n.toLowerCase();
    if (own === name) return true;
    if (same !== undefined) {
      const other = parseAddress(own);
      if (other && formatAddress(other) === same) return true;
      continue;
    }
    if (own.startsWith("*.") && name.endsWith(own.slice(1)) && !name.slice(0, -own.length + 1).includes(".") && name.length > own.length - 1) return true;
  }
  return false;
}

/**
 * Where a WebSocket upgrade came from, by its `Origin`: `none` (an app's socket, the command
 * line, a node link), `own` (a page this listener served: a browser), `forwarder` (a stream
 * page read through a forwarder on the viewer's own loopback, over plain HTTP), or refused.
 */
export type OriginKind = "none" | "own" | "forwarder" | "refused";

export function originKind(origin: string | null | undefined, host: string, scheme: "http" | "https", opts: { remote?: boolean } = {}): OriginKind {
  if (origin === null || origin === undefined || origin === "") return "none";
  const o = origin.toLowerCase();
  const h = host.toLowerCase();
  if (o === `${scheme}://${h}`) return "own";
  if (opts.remote && loopbackName(hostName(host)) && o === `http://${h}`) return "forwarder";
  return "refused";
}

// --- the verdict ----------------------------------------------------------------------------

export interface GuardRequest {
  /** The peer's address as the socket says it. */
  address: string;
  host: string | null;
  origin: string | null;
  /** A WebSocket upgrade: the only request whose `Origin` is judged. */
  upgrade: boolean;
  path: string;
}

export interface Refusal {
  status: 403 | 421;
  why: "peer" | "host" | "origin";
  /** One sentence for the log and for `lan.info`. */
  detail: string;
}

export type Verdict = { ok: true; origin: OriginKind } | ({ ok: false } & Refusal);

export interface GuardRules {
  networks: Networks;
  subnets: () => Cidr[];
  /** This machine's names: its certificate's, its addresses and hostname now, its own certificate's. */
  names: () => Iterable<string>;
  scheme: "http" | "https";
  /** `/remote` behind a loopback `Host` is the phone's forwarder; only the listener that serves it says so. */
  forwarder?: boolean;
}

const underRemote = (path: string): boolean => path === "/remote" || path.startsWith("/remote/");

/** The three questions, in order; the first no is the answer. */
export function judge(req: GuardRequest, rules: GuardRules): Verdict {
  if (!peerAllowed(req.address, rules.networks, rules.subnets)) {
    const range = rangeFor(req.address);
    return { ok: false, status: 403, why: "peer", detail: `${req.address} is not on a network this machine is on${range ? `; to serve it, add "${range}" to [controller] networks` : ""}` };
  }
  const remote = rules.forwarder === true && underRemote(req.path);
  const name = hostName(req.host);
  if (name === undefined || !(nameAllowed(name, rules.names()) || (remote && loopbackName(name)))) {
    return { ok: false, status: 421, why: "host", detail: `${req.host ?? "no Host"} is not a name of this machine${name !== undefined ? `; if it is, set [controller] address = "${name}"` : ""}` };
  }
  if (!req.upgrade) return { ok: true, origin: "none" };
  const origin = originKind(req.origin, req.host!, rules.scheme, { remote });
  if (origin === "refused") return { ok: false, status: 403, why: "origin", detail: `a socket from ${req.origin} is not this listener's own page` };
  return { ok: true, origin };
}

export interface LastRefusal {
  at: number;
  address: string;
  why: Refusal["why"];
  detail: string;
}

export interface GuardDeps extends Omit<GuardRules, "subnets"> {
  interfaces?: () => Interfaces;
  log?: Logger;
  now?: () => number;
}

/** How long the adapters' subnets and the machine's names are believed before they are read again. */
const READ_TTL_MS = 5000;
/** One line in the log per address and reason in this long. */
const LOG_EVERY_MS = 60_000;
const LOGGED_CAP = 256;

/** The rules held for one listener, with the adapters and the names read at most every few seconds and the last refusal kept. */
export class Guard {
  private deps: GuardDeps;
  private subnets: Cidr[] = [];
  private names: string[] = [];
  private readAt = -Infinity;
  private logged = new Map<string, number>();
  last?: LastRefusal;

  constructor(deps: GuardDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private read(fresh = false): void {
    const now = this.now();
    if (!fresh && now - this.readAt <= READ_TTL_MS) return;
    this.subnets = attachedSubnets(this.deps.interfaces ? this.deps.interfaces() : networkInterfaces());
    this.names = [...this.deps.names()];
    this.readAt = now;
  }

  check(req: GuardRequest): Verdict {
    this.read();
    const rules: GuardRules = { ...this.deps, subnets: () => this.subnets, names: () => this.names };
    let verdict = judge(req, rules);
    // an adapter that came up a moment ago, an address it brought: read again before a peer or a name is turned away
    if (!verdict.ok && verdict.why !== "origin") {
      this.read(true);
      verdict = judge(req, rules);
    }
    if (!verdict.ok) this.refused(req, verdict);
    return verdict;
  }

  private refused(req: GuardRequest, refusal: Refusal): void {
    const now = this.now();
    this.last = { at: now, address: req.address, why: refusal.why, detail: refusal.detail };
    const key = `${refusal.why} ${req.address}`;
    const before = this.logged.get(key);
    if (before !== undefined && now - before < LOG_EVERY_MS) return;
    this.logged.delete(key);
    this.logged.set(key, now);
    if (this.logged.size > LOGGED_CAP) this.logged.delete(this.logged.keys().next().value!);
    this.deps.log?.warn("request refused", { remote: req.address, why: refusal.why, detail: refusal.detail, path: req.path });
  }
}

/** The response a refusal is: its status and one line, never cached. */
export function refusalResponse(refusal: Refusal): Response {
  const text = refusal.why === "peer" ? "not served on this network" : refusal.why === "host" ? "not a name of this machine" : "not this page's socket";
  return new Response(text, { status: refusal.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

// --- response headers -------------------------------------------------------------------------

/**
 * The headers a file of the controller app is served with. The policy goes on the page alone:
 * a worker's script takes its policy from its own response, and the wake word's must keep
 * compiling WebAssembly. No HSTS: it would bind every port of the host.
 */
export function appHeaders(mime: string, csp?: string): Record<string, string> {
  const html = mime.startsWith("text/html");
  return {
    "content-type": mime,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(html ? { "cross-origin-opener-policy": "same-origin" } : {}),
    ...(html && csp !== undefined ? { "content-security-policy": csp } : {}),
  };
}

// --- the limiter --------------------------------------------------------------------------------

export interface LimiterOptions {
  now?: () => number;
  /** Misses in `windowMs` that block an address's pairing requests. */
  misses?: number;
  windowMs?: number;
  /** The first block, doubled at each one after it up to `maxBlockMs`. */
  blockMs?: number;
  maxBlockMs?: number;
  /** Sockets one address may hold that have not said hello. */
  sockets?: number;
  /** Addresses remembered; the one heard from longest ago is forgotten past it. */
  entries?: number;
}

interface Entry {
  /** When each miss in the window happened. */
  misses: number[];
  blockedUntil: number;
  /** How many blocks in a row: what the next one is doubled by. */
  strikes: number;
  sockets: number;
  seen: number;
}

/**
 * Per address, IPv6 by its /64: the misses of the requests that guess at a secret (a pairing
 * code, a key, an invite, a token), and the sockets that have not said hello. Past the misses
 * an address's pairing requests are refused for a while, a while that doubles; it still
 * connects and says hello, so a paired device behind an address someone else is guessing from
 * is never locked out. This machine itself is never counted.
 */
export class PairLimiter {
  private entries = new Map<string, Entry>();
  private now: () => number;
  private maxMisses: number;
  private windowMs: number;
  private blockMs: number;
  private maxBlockMs: number;
  private maxSockets: number;
  private cap: number;

  constructor(opts: LimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxMisses = opts.misses ?? 10;
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.blockMs = opts.blockMs ?? 60_000;
    this.maxBlockMs = opts.maxBlockMs ?? 15 * 60_000;
    this.maxSockets = opts.sockets ?? 16;
    this.cap = opts.entries ?? 4096;
  }

  /** What an address is counted under; nothing for this machine, which is not counted. */
  key(address: string): string | undefined {
    const a = parseAddress(address);
    if (!a) return `? ${address}`;
    if (isLoopback(a)) return undefined;
    return a.family === 4 ? formatAddress(a) : parseCidr(`${formatAddress(a)}/64`)!.text;
  }

  private entry(key: string): Entry {
    const now = this.now();
    let e = this.entries.get(key);
    if (e) this.entries.delete(key);
    else e = { misses: [], blockedUntil: 0, strikes: 0, sockets: 0, seen: now };
    e.seen = now;
    this.entries.set(key, e);
    if (this.entries.size > this.cap) {
      // the one heard from longest ago that holds no socket
      for (const [k, old] of this.entries) {
        if (old.sockets > 0 || k === key) continue;
        this.entries.delete(k);
        break;
      }
    }
    return e;
  }

  /** How long an address's pairing requests are still refused, in milliseconds; nothing while they are served. */
  blocked(address: string): number | undefined {
    const key = this.key(address);
    if (key === undefined) return undefined;
    const e = this.entries.get(key);
    if (!e) return undefined;
    const left = e.blockedUntil - this.now();
    return left > 0 ? left : undefined;
  }

  /** A wrong code, key, invite or token from `address`. */
  miss(address: string): void {
    const key = this.key(address);
    if (key === undefined) return;
    const now = this.now();
    const e = this.entry(key);
    e.misses = e.misses.filter((at) => now - at < this.windowMs);
    e.misses.push(now);
    if (e.misses.length < this.maxMisses) return;
    // a block that ended long ago is forgotten: the next one starts short again
    if (e.strikes > 0 && now - e.blockedUntil > this.maxBlockMs) e.strikes = 0;
    e.blockedUntil = now + Math.min(this.maxBlockMs, this.blockMs * 2 ** e.strikes);
    e.strikes++;
    e.misses = [];
  }

  /** A socket opened from `address` that has not said hello: false when it holds too many already. */
  open(address: string): boolean {
    const key = this.key(address);
    if (key === undefined) return true;
    const e = this.entry(key);
    if (e.sockets >= this.maxSockets) return false;
    e.sockets++;
    return true;
  }

  /** That socket said hello, or closed without. */
  done(address: string): void {
    const key = this.key(address);
    if (key === undefined) return;
    const e = this.entries.get(key);
    if (!e) return;
    e.sockets = Math.max(0, e.sockets - 1);
    if (e.sockets === 0 && e.misses.length === 0 && e.blockedUntil <= this.now() && e.strikes === 0) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
