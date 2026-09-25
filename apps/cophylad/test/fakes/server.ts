// A stand-in for the account server on loopback: the device-code HTTP, the beta feed behind
// the bearer, and the link (`/ws/link`) with its exact method table. It signs entitlements
// with its own Ed25519 key (the daemon is started with the public half), can sign with
// another key to forge one, flips the plan, pushes a token, answers `llm.complete` from a
// script like the Gemini fake, records every method and path it saw, and can restart to
// drop every link. Everything it must never receive answers `unsupported`, as the real one does.
// Since grants a relay grant has a kind and an end (a node's grant tunnels to the primary
// the registry names), and an account token is bound to the node that first linked with it.
// Since milestone 12 it also plays the relay (`/ws/relay` for a phone, `relay.grant`,
// `relay.open` forwarded to the far link, `relay` and `relay.close` routed between its
// sockets with `peer` rewritten, never parsed further), the registry (a lease per account
// with the real server's rule, `registry.primary` pushed to the other links, `holdLease`
// for a test that wants the role elsewhere) and push (the registrations and sends recorded).
// Since milestone 13 it keeps a backup (the objects verbatim, the header, the owner and the
// version rule of the real server, the bytes gauge against a cap a test can lower) and
// answers `compute.embed` with deterministic vectors of a small width. Since milestone 16 it
// mints TURN credentials (`turn.credentials`, recorded by username) and keeps every
// `direct.report`.

import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { BackupKind, FREE_ENTITLEMENT, failure, protocolError } from "@cophyla/protocol";
import type { Entitlement, LlmComplete, LlmResult, Node, Release, RpcId } from "@cophyla/protocol";
import type { ServerWebSocket } from "bun";
import type { EntitlementKey } from "../../src/cloud/keys.ts";
import { lastUserText } from "./gemini.ts";

export interface ServerKey {
  key: KeyObject;
  spki: string;
}

export function serverKey(): ServerKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { key: privateKey, spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

const BACKUP_KINDS: readonly string[] = BackupKind.options;

const b64url = (s: string | Buffer): string => (typeof s === "string" ? Buffer.from(s, "utf8") : s).toString("base64url");

/** A JWT the way the server issues one: `EdDSA`, the claims the `Entitlement` entity. */
export function signEntitlement(claims: Entitlement, key: KeyObject, kid: string): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${header}.${payload}`, "utf8"), key);
  return `${header}.${payload}.${b64url(sig)}`;
}

export const PRO: Pick<Entitlement, "limits" | "hosted" | "brainChannel"> = {
  limits: { sessions: 8, nodes: 5, memoryTier: "full", planning: [...FREE_ENTITLEMENT.limits.planning], backupBytes: 256 * 1024 * 1024 },
  hosted: { llm: true, voice: true, compute: true, relay: true, push: true, backup: true, direct: true },
  brainChannel: "beta",
};

/** The fake's embedding model: a vector of `FAKE_EMBED_DIM` from the text's characters, unit length, the same text the same vector. */
export const FAKE_EMBED_MODEL = "fake/embed-v1";
export const FAKE_EMBED_DIM = 8;
export function fakeEmbed(text: string, dim = FAKE_EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 7 + i) % dim] = (v[(text.charCodeAt(i) * 7 + i) % dim] ?? 0) + 1 + (text.charCodeAt(i) % 5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** A script for `llm.complete`: text chunks, then the result; or a function of the last user text. */
export type LlmScript = { deltas: string[]; usage?: { in: number; out: number }; model?: string } | ((trigger: string, params: LlmComplete) => { deltas: string[]; usage?: { in: number; out: number } });

interface LinkData {
  kind: "link" | "peer";
  token?: string;
  subject?: string;
  node?: string;
  /** A peer socket after `relay.auth`: the controller id it speaks as and the node it was granted by. */
  peer?: string;
  peerNode?: string;
  /** Which kind of grant the peer's token is: a phone's goes to its granting node, a node's to the primary. */
  peerKind?: "controller" | "node";
  /** A pairing peer: the account its grant signed in as, and the node it asked for. */
  pairing?: { subject: string; login: string; node?: string };
}

/** One tunnel: the initiator's socket (a phone or a secondary's link) and the node's link. */
interface Tunnel {
  a: ServerWebSocket<LinkData>;
  aId: string;
  b: ServerWebSocket<LinkData>;
  bId: string;
  kind: "controller" | "node" | "pair";
  frames: number;
}

interface Lease {
  node: string;
  epoch: number;
  until: number;
}

export const FAKE_LEASE_MS = 45_000;
export const FAKE_CLOSE_GRACE_MS = 15_000;

export interface FakeServerOptions {
  kid?: string;
  /** Token good for this many hours; the grace after that. */
  tokenHours?: number;
  graceSeconds?: number;
  now?: () => number;
  /** The registry's lease and close grace, shorter in a failover test. */
  leaseMs?: number;
  closeGraceMs?: number;
}

export class FakeServer {
  readonly key: ServerKey;
  readonly kid: string;
  /** Every link method seen, in order. */
  readonly seen: string[] = [];
  /** Every HTTP request: `METHOD /path`. */
  readonly http: { method: string; path: string; headers: Record<string, string> }[] = [];
  /** Every `stt.transcribe`: the sample count and the language. */
  readonly stt: { samples: number; language?: string }[] = [];
  /** Every `tts.speak` text. */
  readonly tts: string[] = [];
  /** Every `cancel` id. */
  readonly cancels: RpcId[] = [];
  /** Every `llm.complete` request, whole. */
  readonly llm: LlmComplete[] = [];
  /** The tokens minted, with their subject and whether revoked. */
  readonly tokens = new Map<string, { subject: string; revoked: boolean; node?: string; boundNode?: string }>();
  /** The device codes handed out, with their state. */
  readonly devices = new Map<string, { userCode: string; state: "pending" | "approved" | "consumed" | "denied"; token?: string }>();
  plan = "pro";
  /** Milliseconds `relay.grant` takes: a pairing slow enough for the phone to leave before its answer. */
  grantDelayMs = 0;
  subject = "usr_fake";
  /** Answers `llm.complete` with `quota_exceeded {metric, resetsAt}` while set. */
  quota: { metric: string; resetsAt: number } | undefined;
  /** Answers `llm.complete` with `unavailable` while set. */
  unavailable = false;
  scripts: Record<string, LlmScript> = { default: { deltas: ["Nothing ", "is open."] } };
  transcript = "what is open";
  /** The speech chunks a `tts.speak` sends back: a ramp of this many samples per chunk, this many chunks. */
  speech = { chunkSamples: 2400, chunks: 3 };
  /** The beta feed body and the artifacts, served behind the bearer. */
  betaFeed: { releases: Release[] } | undefined;
  artifacts = new Map<string, Uint8Array>();
  /** A `refresh` failure while set. */
  refuseRefresh = false;
  private heldUntil = 0;
  /** Accept `auth` only for tokens in `tokens` that are not revoked; when false, every auth is denied (a server that lost its database). */
  acceptTokens = true;
  /** The relay tokens granted, by controller id. */
  readonly relayTokens = new Map<string, { token: string; node: string; kind: "controller" | "node"; name?: string; expiresAt?: number; revoked: boolean }>();
  /** The grants of the app's sign-in, as the real server's page would hand them out; spent at `relay.auth`. */
  readonly pairGrants = new Map<string, { subject: string; login: string; node?: string }>();
  private nextPairing = 0;
  /** Every `push.register`, `push.unregister` and `push.send`, in order. */
  readonly pushes: { method: string; params: Record<string, unknown> }[] = [];
  /** Push devices by peer. */
  readonly pushDevices = new Map<string, { platform: string; token: string }>();
  /** Answers `push.send` with `unavailable` while set. */
  pushUnavailable = false;
  /** The backup: the header with its owner, and the objects verbatim by `kind/key`. */
  backupHeader: { header: Record<string, unknown> & { keyId: string; node: string }; node: string } | undefined;
  readonly backups = new Map<string, { kind: string; key: string; version: number; ciphertext: string; size: number; updatedAt: number }>();
  /** The plan's bytes; lowered by a quota test. */
  backupBytesCap = PRO.limits.backupBytes!;
  /** Every `backup.begin`, `backup.put`, `backup.delete` and `backup.clear`, in order: the kind and key, never the ciphertext. */
  readonly backupLog: { method: string; kind: string; key: string; version?: number; node?: string }[] = [];
  /** Answers `compute.embed` with `unavailable` while set; with `quota_exceeded {metric, resetsAt}` while `embedQuota` is set. */
  embedUnavailable = false;
  embedQuota: { resetsAt: number } | undefined;
  /** Every `turn.credentials` answer: the username of each credential minted. */
  readonly turnGrants: { username: string; ttl: number }[] = [];
  /** Answers `turn.credentials` with `unavailable` while set, as a server without the TURN key does. */
  turnUnavailable = false;
  /** Every `direct.report`, whole. */
  readonly directReports: { day: string; counts: { kind: string; path: string; count: number }[] }[] = [];
  /** Every `compute.embed` batch's texts. */
  readonly embeds: string[][] = [];
  /** The width the fake answers; changed by a test that wants a wrong-length vector. */
  embedDim = FAKE_EMBED_DIM;
  /** The registry: one lease for the one account, and every node row seen. */
  lease: Lease | undefined;
  readonly nodeRows = new Map<string, { role: string; epoch: number; via: string }>();
  /** Every `registry.*` answer, for the tests. */
  readonly registryLog: { method: string; node: string; answer: unknown }[] = [];
  private tunnels = new Set<Tunnel>();
  private nextRequest = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private server: ReturnType<typeof Bun.serve<LinkData>>;
  private sockets = new Set<ServerWebSocket<LinkData>>();
  private opts: FakeServerOptions;
  private signer: KeyObject;

  constructor(opts: FakeServerOptions = {}) {
    this.opts = opts;
    this.key = serverKey();
    this.signer = this.key.key;
    this.kid = opts.kid ?? "fake-1";
    this.server = Bun.serve<LinkData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, server) => this.fetch(req, server),
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
        },
        message: (ws, message) => this.message(ws, typeof message === "string" ? message : Buffer.from(message).toString("utf8")),
        close: (ws) => {
          this.sockets.delete(ws);
          this.socketGone(ws);
        },
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** The public key entry the daemon is started with. */
  get publicKey(): EntitlementKey {
    return { kid: this.kid, key: this.key.spki };
  }

  get links(): number {
    return [...this.sockets].filter((s) => s.data.kind === "link" && s.data.token).length;
  }

  /** The open tunnels, for the tests. */
  get tunnelCount(): number {
    return this.tunnels.size;
  }

  /** Node tunnels open: the `relayed_nodes` gauge. */
  get relayedNodes(): number {
    return [...this.tunnels].filter((t) => t.kind === "node").length;
  }

  /** Whether a node holds a link now. */
  linked(node: string): boolean {
    return this.linkOf(node) !== undefined;
  }

  private linkOf(node: string): ServerWebSocket<LinkData> | undefined {
    for (const s of this.sockets) if (s.data.kind === "link" && s.data.token && s.data.node === node) return s;
    return undefined;
  }

  // --- the registry ------------------------------------------------------------------------

  private leaseMs(): number {
    return this.opts.leaseMs ?? FAKE_LEASE_MS;
  }

  /** The holder while its lease holds. */
  primaryOf(): { primary: string; epoch: number } | undefined {
    const l = this.lease;
    if (!l || l.until <= this.now()) return undefined;
    return { primary: l.node, epoch: l.epoch };
  }

  /** For a test: the role is held elsewhere (a node this fake never sees) until released. */
  holdLease(node: string, epoch: number, forMs = 3600_000): void {
    this.lease = { node, epoch, until: this.now() + forMs };
  }

  /** For a test: the held lease lapses now (the row stays, as on the real server, so the next grant lands above its epoch). */
  releaseLease(): void {
    if (this.lease) this.lease.until = this.now() - 1;
  }

  /** The real server's rule: the tie rule only for two primaries meeting (a register), never for a claim. */
  private arbitrate(claim: { node: string; epoch: number }, mode: "claim" | "register" = "claim"): boolean {
    const l = this.lease;
    const now = this.now();
    if (!l || l.until <= now) return true;
    if (l.node === claim.node) return true;
    if (claim.epoch > l.epoch) return true;
    if (mode === "register" && claim.epoch === l.epoch && claim.node < l.node) return true;
    return false;
  }

  /** A grant that changes hands lands above the previous holder's epoch. */
  private grant(node: string, epoch: number): { primary: string; epoch: number } {
    const prev = this.lease;
    const held = prev !== undefined && prev.node === node;
    const next = !prev ? epoch : held ? Math.max(epoch, prev.epoch) : Math.max(epoch, prev.epoch + 1);
    this.lease = { node, epoch: next, until: this.now() + this.leaseMs() };
    if (!held) {
      for (const s of this.sockets) {
        if (s.data.kind !== "link" || !s.data.token || s.data.node === node) continue;
        this.write(s, { jsonrpc: "2.0", method: "registry.primary", params: { primary: node, epoch: next } });
      }
    }
    return { primary: node, epoch: next };
  }

  private holder(): { primary?: string; epoch?: number } {
    const h = this.primaryOf();
    return h ? { primary: h.primary, epoch: h.epoch } : {};
  }

  // --- the relay ---------------------------------------------------------------------------

  private tunnelFor(ws: ServerWebSocket<LinkData>, peer: string): Tunnel | undefined {
    for (const t of this.tunnels) {
      if (t.a === ws && t.bId === peer) return t;
      if (t.b === ws && t.aId === peer) return t;
    }
    return undefined;
  }

  private closeTunnel(t: Tunnel, reason: string, by?: ServerWebSocket<LinkData>): void {
    if (!this.tunnels.delete(t)) return;
    if (t.a !== by) {
      this.write(t.a, { jsonrpc: "2.0", method: "relay.close", params: { peer: t.bId, reason } });
      if (t.a.data.kind === "peer") t.a.close(4409, reason);
    }
    if (t.b !== by) this.write(t.b, { jsonrpc: "2.0", method: "relay.close", params: { peer: t.aId, reason } });
  }

  /** A request of the fake to a daemon's link (only `relay.open`), answered on the same socket. */
  private requestOf(ws: ServerWebSocket<LinkData>, method: string, params: unknown): Promise<unknown> {
    const id = `s${++this.nextRequest}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer`));
      }, 5000);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write(ws, { jsonrpc: "2.0", id, method, params });
    });
  }

  private async openTunnel(kind: Tunnel["kind"], a: ServerWebSocket<LinkData>, aId: string, b: ServerWebSocket<LinkData>, bId: string, epk: string, curve: unknown, extra: Record<string, unknown> = {}): Promise<{ peer: string; epk: string }> {
    const existing = this.tunnelFor(a, bId);
    if (existing) this.closeTunnel(existing, "replaced", a);
    const answer = (await this.requestOf(b, "relay.open", { peer: aId, kind, epk, ...(curve !== undefined ? { curve } : {}), ...extra })) as { epk?: unknown };
    if (typeof answer?.epk !== "string") throw new Error("the node answered without a key");
    this.tunnels.add({ a, aId, b, bId, kind, frames: 0 });
    return { peer: bId, epk: answer.epk };
  }

  private forward(from: ServerWebSocket<LinkData>, peer: string, frame: string): void {
    const t = this.tunnelFor(from, peer);
    if (!t) return;
    t.frames++;
    this.used["relay_messages"] = (this.used["relay_messages"] ?? 0) + 1;
    if (from === t.a) this.write(t.b, { jsonrpc: "2.0", method: "relay", params: { peer: t.aId, frame } });
    else this.write(t.a, { jsonrpc: "2.0", method: "relay", params: { peer: t.bId, frame } });
  }

  private socketGone(ws: ServerWebSocket<LinkData>): void {
    for (const t of [...this.tunnels]) if (t.a === ws || t.b === ws) this.closeTunnel(t, ws.data.kind === "peer" ? "peer left" : "node link closed", ws);
    if (ws.data.kind === "link" && ws.data.node && this.lease && this.lease.node === ws.data.node && !this.linkOf(ws.data.node)) {
      this.lease.until = Math.min(this.lease.until, this.now() + (this.opts.closeGraceMs ?? FAKE_CLOSE_GRACE_MS));
    }
  }

  /** Drops a phone's peer sockets and their tunnels: the relay had a moment. */
  dropPeers(): number {
    let n = 0;
    for (const s of [...this.sockets]) {
      if (s.data.kind !== "peer") continue;
      s.close(1012, "restart");
      n++;
    }
    return n;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Signs every entitlement from now on with another key: what a forger would do. */
  signWith(key: KeyObject | undefined): void {
    this.signer = key ?? this.key.key;
  }

  claims(overrides: Partial<Entitlement> = {}): Entitlement {
    const now = this.now();
    const base = this.plan === "pro" ? PRO : { limits: FREE_ENTITLEMENT.limits, hosted: FREE_ENTITLEMENT.hosted, brainChannel: FREE_ENTITLEMENT.brainChannel };
    return {
      subject: this.subject,
      plan: this.plan,
      issuedAt: now,
      expiresAt: now + (this.opts.tokenHours ?? 24) * 3600_000,
      graceSeconds: this.opts.graceSeconds ?? 604800,
      ...base,
      ...overrides,
    };
  }

  /** A signed entitlement for the current plan (or the overrides), by the current signer. */
  entitlement(overrides: Partial<Entitlement> = {}): string {
    return signEntitlement(this.claims(overrides), this.signer, this.kid);
  }

  /** A fresh account token, as a completed login would leave it. */
  /** A grant as the sign-in page would hand the app: the account (this fake's by default) and the login. */
  pairGrant(opts: { subject?: string; login?: string; node?: string } = {}): string {
    const grant = `prg_fake_${Math.random().toString(36).slice(2)}`;
    this.pairGrants.set(grant, { subject: opts.subject ?? this.subject, login: opts.login ?? "octocat", ...(opts.node ? { node: opts.node } : {}) });
    return grant;
  }

  mintToken(node?: string): string {
    const token = `tok_fake_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    this.tokens.set(token, { subject: this.subject, revoked: false, ...(node ? { node } : {}) });
    return token;
  }

  /** The user signed in on the page: the pending device code is approved. */
  approve(userCode?: string): void {
    for (const [, d] of this.devices) {
      if (d.state !== "pending") continue;
      if (userCode && d.userCode !== userCode) continue;
      d.state = "approved";
      d.token = this.mintToken();
      return;
    }
    throw new Error("no pending device code");
  }

  deny(): void {
    for (const [, d] of this.devices) if (d.state === "pending") d.state = "denied";
  }

  /** Flips the plan and pushes a fresh token to every open link, as the webhook does. */
  setPlan(plan: string, push = true): number {
    this.plan = plan;
    return push ? this.pushEntitlement() : 0;
  }

  pushEntitlement(token = this.entitlement()): number {
    let n = 0;
    for (const s of this.sockets) {
      if (!s.data.token) continue;
      s.send(JSON.stringify({ jsonrpc: "2.0", method: "entitlement.updated", params: { token } }));
      n++;
    }
    return n;
  }

  /**
   * Drops every link (1012); the daemon reconnects with backoff. `holdMs` refuses links that long,
   * so a test sees the link down however fast the daemon comes back.
   */
  restart(holdMs = 0): void {
    this.heldUntil = Date.now() + holdMs;
    for (const s of [...this.sockets]) s.close(1012, "restart");
    this.sockets.clear();
  }

  async stop(): Promise<void> {
    for (const s of [...this.sockets]) s.close(1001, "stopping");
    // Bun 1.3.14 on Windows: once a socket was closed from the server side, `stop(true)` never settles (see api/server.ts). Bound it.
    await Promise.race([this.server.stop(true), Bun.sleep(500)]);
  }

  private async fetch(req: Request, server: ReturnType<typeof Bun.serve<LinkData>>): Promise<Response> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    this.http.push({ method: req.method, path: url.pathname, headers });
    const bearer = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1];
    if (url.pathname === "/ws/link") {
      if (Date.now() < this.heldUntil) return new Response("restarting", { status: 503 });
      if (server.upgrade(req, { data: { kind: "link" } })) return new Response(null, { status: 101 });
      return new Response("upgrade", { status: 426 });
    }
    if (url.pathname === "/ws/relay") {
      if (server.upgrade(req, { data: { kind: "peer" } })) return new Response(null, { status: 101 });
      return new Response("upgrade", { status: 426 });
    }
    if (url.pathname === "/auth/device" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { node?: string };
      const deviceCode = `dc_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      const userCode = `BCDF-${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z]/g, "G").padEnd(4, "H")}`;
      this.devices.set(deviceCode, { userCode, state: "pending" });
      void body;
      return Response.json({ deviceCode, userCode, verificationUrl: `${this.url}/login?code=${userCode}`, expiresAt: this.now() + 15 * 60_000, intervalMs: 20 });
    }
    if (url.pathname === "/auth/token" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { deviceCode?: string };
      const d = body.deviceCode ? this.devices.get(body.deviceCode) : undefined;
      if (!d) return Response.json({ error: "unknown" }, { status: 410 });
      if (d.state === "pending") return Response.json({ pending: true }, { status: 202 });
      if (d.state === "approved" && d.token) {
        d.state = "consumed";
        return Response.json({ token: d.token, subject: this.subject, expiresAt: this.now() + 365 * 86400_000 });
      }
      return Response.json({ error: "expired or denied" }, { status: 410 });
    }
    if (url.pathname === "/auth/revoke" && req.method === "POST") {
      if (!bearer) return Response.json({ error: "bearer" }, { status: 401 });
      const t = this.tokens.get(bearer);
      if (t) {
        t.revoked = true;
        for (const s of [...this.sockets]) if (s.data.token === bearer) s.close(1008, "token revoked");
      }
      return Response.json({});
    }
    const beta = /^\/releases\/beta\/([^/]+)$/.exec(url.pathname);
    if (beta) {
      const t = bearer ? this.tokens.get(bearer) : undefined;
      if (!t || t.revoked) return Response.json({ error: "bearer" }, { status: 401 });
      if (this.plan !== "pro") return Response.json({ error: "no beta" }, { status: 403 });
      if (!this.betaFeed) return Response.json({ error: "no feed" }, { status: 404 });
      return Response.json({ ...this.betaFeed, releases: this.betaFeed.releases.map((r) => ({ ...r, url: `${this.url}/releases/artifacts/${encodeURIComponent(r.url.slice(r.url.lastIndexOf("/") + 1))}` })) });
    }
    const artifact = /^\/releases\/artifacts\/([^/]+)$/.exec(url.pathname);
    if (artifact) {
      const t = bearer ? this.tokens.get(bearer) : undefined;
      if (!t || t.revoked) return Response.json({ error: "bearer" }, { status: 401 });
      const bytes = this.artifacts.get(decodeURIComponent(artifact[1]!));
      if (!bytes) return new Response("no", { status: 404 });
      return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
    }
    const stable = /^\/releases\/stable\/([^/]+)$/.exec(url.pathname);
    if (stable) return new Response(null, { status: 302, headers: { location: `https://feed.example/stable/${stable[1]}` } });
    return new Response("not found", { status: 404 });
  }

  private write(ws: ServerWebSocket<LinkData>, message: unknown): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // gone
    }
  }

  private message(ws: ServerWebSocket<LinkData>, text: string): void {
    let m: { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { message?: string; data?: { code?: string; message?: string } } };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (typeof m.method !== "string") {
      // an answer to a request of ours (relay.open)
      if (typeof m.id === "string") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.data?.message ?? m.error.message ?? "refused"), { error: protocolError((m.error.data?.code ?? "unavailable") as never, m.error.data?.message ?? "refused") }));
        else p.resolve(m.result);
      }
      return;
    }
    if (m.id === undefined || m.id === null) {
      // the relay's notifications, routed by peer and never parsed further
      const p = (m.params ?? {}) as { peer?: unknown; frame?: unknown; reason?: unknown };
      const authed = ws.data.kind === "peer" ? ws.data.peer !== undefined : ws.data.token !== undefined;
      if (!authed || typeof p.peer !== "string") return;
      if (m.method === "relay" && typeof p.frame === "string") {
        this.seen.push("relay");
        this.forward(ws, p.peer, p.frame);
      } else if (m.method === "relay.close") {
        this.seen.push("relay.close");
        const t = this.tunnelFor(ws, p.peer);
        if (t) this.closeTunnel(t, typeof p.reason === "string" ? p.reason : "closed", ws);
      }
      return;
    }
    const id = m.id;
    if (ws.data.kind === "peer") {
      void this.servePeer(ws, m.method, m.params).then(
        (result) => this.write(ws, { jsonrpc: "2.0", id, result: result ?? {} }),
        (e: unknown) => {
          const err = e instanceof Error && "error" in e ? (e as { error: ReturnType<typeof protocolError> }).error : protocolError("unavailable", e instanceof Error ? e.message : String(e));
          this.write(ws, failure(id, err));
          if (m.method === "relay.auth" || !ws.data.peer) ws.close(4401, "auth");
        },
      );
      return;
    }
    this.seen.push(m.method);
    void this.serve(ws, id, m.method, m.params).then(
      (result) => this.write(ws, { jsonrpc: "2.0", id, result: result ?? {} }),
      (e: unknown) => {
        const err = e instanceof Error && "error" in e ? (e as { error: ReturnType<typeof protocolError> }).error : protocolError("unavailable", e instanceof Error ? e.message : String(e));
        this.write(ws, failure(id, err));
        if (m.method === "auth" || !ws.data.token) ws.close(1008, "auth");
      },
    );
  }

  /** The phone's socket: `relay.auth` by relay token, then one `relay.open` forwarded to the granting node. */
  private async servePeer(ws: ServerWebSocket<LinkData>, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const fail = (code: Parameters<typeof protocolError>[0], message: string, data?: unknown) => Object.assign(new Error(message), { error: protocolError(code, message, data) });
    if (method === "relay.auth" && typeof p["grant"] === "string") {
      const g = this.pairGrants.get(p["grant"]);
      this.pairGrants.delete(p["grant"]);
      if (!g) throw fail("denied", "the sign-in's grant is unknown, spent, expired or not this phone's");
      if (this.plan !== "pro") throw fail("denied", "the plan has no relay");
      ws.data.peer = `pair_fake${++this.nextPairing}`;
      ws.data.pairing = g;
      return { peer: ws.data.peer, subject: g.subject, login: g.login };
    }
    if (method === "relay.auth") {
      const token = typeof p["token"] === "string" ? p["token"] : "";
      const entry = [...this.relayTokens.entries()].find(([, v]) => v.token === token);
      if (!entry || entry[1].revoked) throw fail("denied", "the relay token is unknown or revoked");
      if (entry[1].expiresAt !== undefined && entry[1].expiresAt <= this.now()) throw fail("denied", "the relay token's grant has ended");
      if (this.plan !== "pro") throw fail("denied", "the plan has no relay");
      ws.data.peer = entry[0];
      ws.data.peerNode = entry[1].node;
      ws.data.peerKind = entry[1].kind;
      return { peer: entry[0] };
    }
    if (!ws.data.peer) throw fail("denied", "auth first");
    if (method === "relay.open" && ws.data.pairing) {
      if (this.plan !== "pro") throw fail("denied", "the plan has no relay");
      const pairing = ws.data.pairing;
      const asked = typeof p["node"] === "string" ? p["node"] : pairing.node;
      const target = asked ? this.linkOf(asked) : [...this.sockets].find((s) => s.data.kind === "link" && s.data.token && s.data.node);
      if (!target) throw fail("unavailable", "none of the account's computers is linked to the server", { provider: "server" });
      try {
        return await this.openTunnel("pair", ws, ws.data.peer, target, target.data.node!, String(p["epk"] ?? ""), p["curve"], { subject: pairing.subject, login: pairing.login });
      } catch (e) {
        if (e instanceof Error && "error" in e) throw e;
        throw fail("unavailable", e instanceof Error ? e.message : String(e), { provider: "server" });
      }
    }
    if (method === "relay.open" && ws.data.peerKind === "node") {
      // a node's grant: to the primary the registry names now, against the plan's relayed nodes
      if (this.plan !== "pro") throw fail("denied", "the plan has no relay");
      const holder = this.primaryOf();
      if (!holder) throw fail("unavailable", "no primary is registered for the account", { provider: "server" });
      const target = this.linkOf(holder.primary);
      if (!target) throw fail("unavailable", "the primary is not linked to the server", { provider: "server" });
      if (!this.tunnelFor(ws, holder.primary) && this.relayedNodes >= PRO.limits.nodes) throw fail("quota_exceeded", "the plan allows 5 relayed nodes", { metric: "relayed_nodes" });
      try {
        return await this.openTunnel("node", ws, ws.data.peer, target, holder.primary, String(p["epk"] ?? ""), p["curve"]);
      } catch (e) {
        if (e instanceof Error && "error" in e) throw e;
        throw fail("unavailable", e instanceof Error ? e.message : String(e), { provider: "server" });
      }
    }
    if (method === "relay.open") {
      if (this.plan !== "pro") throw fail("denied", "the plan has no relay");
      const target = this.linkOf(ws.data.peerNode!);
      if (!target) throw fail("unavailable", "the pairing node is not linked to the server", { provider: "server" });
      try {
        return await this.openTunnel("controller", ws, ws.data.peer, target, ws.data.peerNode!, String(p["epk"] ?? ""), p["curve"]);
      } catch (e) {
        if (e instanceof Error && "error" in e) throw e;
        throw fail("unavailable", e instanceof Error ? e.message : String(e), { provider: "server" });
      }
    }
    throw fail("unsupported", `unsupported: ${method}`);
  }

  private async serve(ws: ServerWebSocket<LinkData>, id: RpcId, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const fail = (code: Parameters<typeof protocolError>[0], message: string, data?: unknown) => Object.assign(new Error(message), { error: protocolError(code, message, data) });
    if (method === "auth") {
      const token = typeof p["token"] === "string" ? p["token"] : "";
      const t = this.tokens.get(token);
      if (!this.acceptTokens || !t || t.revoked) throw fail("denied", "the account token is unknown, revoked or expired");
      // as the real server: a token is the node's that first linked with it
      const node = typeof p["node"] === "string" ? p["node"] : undefined;
      if (node !== undefined) {
        t.boundNode ??= node;
        if (t.boundNode !== node) throw fail("denied", "the account token belongs to another node");
      }
      ws.data.token = token;
      ws.data.subject = t.subject;
      ws.data.node = typeof p["node"] === "string" ? p["node"] : undefined;
      return { subject: t.subject, expiresAt: this.now() + 365 * 86400_000 };
    }
    if (!ws.data.token) throw fail("denied", "auth first");
    switch (method) {
      case "entitlement.refresh": {
        if (this.refuseRefresh) throw fail("unavailable", "refresh refused for the test");
        const caps = this.plan === "pro" ? { llm_tokens_in: 2_000_000, llm_tokens_out: 500_000, stt_seconds: 600, tts_chars: 200_000, embed_tokens: 10_000_000, relay_messages: 2_000_000, push_count: 2000, turn_credentials: 3000 } : {};
        const metrics: Record<string, { used: number; cap: number }> = {};
        for (const [k, cap] of Object.entries(caps)) metrics[k] = { used: this.used[k] ?? 0, cap };
        if (this.plan === "pro") metrics["relayed_nodes"] = { used: this.relayedNodes, cap: PRO.limits.nodes };
        if (this.plan === "pro") metrics["backup_bytes"] = { used: this.backupBytes, cap: this.backupBytesCap };
        return { token: this.entitlement(), usage: { period: "2026-09", metrics } };
      }
      case "relay.grant": {
        if (this.grantDelayMs > 0) await new Promise((r) => setTimeout(r, this.grantDelayMs));
        if (this.plan !== "pro") throw fail("denied", "the plan has no relay");
        const peer = String(p["peer"] ?? "");
        const kind = p["kind"] === "node" ? "node" : "controller";
        if (!peer.startsWith(kind === "node" ? "grt_" : "ctl_")) throw fail("invalid", `a ${kind} grant's peer is a ${kind === "node" ? "grt_" : "ctl_"} id`);
        const expiresAt = typeof p["expiresAt"] === "number" ? p["expiresAt"] : undefined;
        if (expiresAt !== undefined && expiresAt <= this.now()) throw fail("invalid", "the grant has already ended");
        const token = `rly_fake_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
        this.relayTokens.set(peer, { token, node: ws.data.node!, kind, ...(typeof p["name"] === "string" ? { name: p["name"] } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), revoked: false });
        for (const s of [...this.sockets]) if (s.data.kind === "peer" && s.data.peer === peer) s.close(4401, "token replaced");
        return { token };
      }
      case "relay.revoke": {
        const peer = String(p["peer"] ?? "");
        const row = this.relayTokens.get(peer);
        if (!row) throw fail("not_found", `no relay peer ${peer}`);
        row.revoked = true;
        for (const s of [...this.sockets]) {
          if (s.data.kind !== "peer" || s.data.peer !== peer) continue;
          for (const t of [...this.tunnels]) if (t.a === s) this.closeTunnel(t, "revoked", s);
          s.close(4401, "revoked");
        }
        return {};
      }
      case "registry.register": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no relay: the registry is part of it");
        const node = p["node"] as Node;
        const epoch = typeof p["epoch"] === "number" ? p["epoch"] : 0;
        this.nodeRows.set(node.id, { role: node.role, epoch, via: node.via });
        let answer: unknown;
        if (node.role !== "primary") answer = this.holder();
        else if (this.arbitrate({ node: node.id, epoch }, "register")) answer = this.grant(node.id, epoch);
        else answer = { primary: this.lease!.node, epoch: this.lease!.epoch };
        this.registryLog.push({ method, node: node.id, answer });
        return answer;
      }
      case "registry.heartbeat": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no relay: the registry is part of it");
        const node = String(p["node"] ?? "");
        const l = this.lease;
        const answer = l && l.until > this.now() && l.node !== node ? { primary: l.node, epoch: l.epoch } : this.grant(node, l?.epoch ?? 0);
        this.registryLog.push({ method, node, answer });
        return answer;
      }
      case "registry.claim": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no relay: the registry is part of it");
        const node = String(p["node"] ?? "");
        const epoch = typeof p["epoch"] === "number" ? p["epoch"] : 0;
        const answer = this.arbitrate({ node, epoch }) ? { granted: true, ...this.grant(node, epoch) } : { granted: false, primary: this.lease!.node, epoch: this.lease!.epoch };
        this.registryLog.push({ method, node, answer });
        return answer;
      }
      case "push.register": {
        this.pushes.push({ method, params: p });
        this.pushDevices.set(String(p["peer"]), { platform: String(p["platform"]), token: String(p["token"]) });
        return {};
      }
      case "push.unregister": {
        this.pushes.push({ method, params: p });
        this.pushDevices.delete(String(p["peer"]));
        return {};
      }
      case "push.send": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no push");
        this.pushes.push({ method, params: p });
        if (this.pushUnavailable) throw fail("unavailable", "the push service did not accept the message", { provider: "server" });
        if (!this.pushDevices.has(String(p["peer"]))) throw fail("not_found", `no push device for ${String(p["peer"])}`);
        this.used["push_count"] = (this.used["push_count"] ?? 0) + 1;
        return {};
      }
      case "llm.complete": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no hosted model");
        if (this.quota) throw fail("quota_exceeded", `the plan's ${this.quota.metric} allowance is used up`, { ...this.quota });
        if (this.unavailable) throw fail("unavailable", "the hosted model is having a moment", { provider: "gemini", status: 503 });
        const req = p as unknown as LlmComplete;
        this.llm.push(req);
        const trigger = lastUserText({ contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: m.content.map((b) => (b.type === "text" ? { text: b.text } : b.type === "tool_result" ? { functionResponse: {} } : {})) })) });
        const key = Object.keys(this.scripts).find((k) => k !== "default" && trigger.toLowerCase().includes(k.toLowerCase())) ?? "default";
        const s = this.scripts[key]!;
        const script = typeof s === "function" ? s(trigger, req) : s;
        const text: string[] = [];
        for (const d of script.deltas) {
          this.write(ws, { jsonrpc: "2.0", method: "llm.delta", params: { id, delta: { type: "text", text: d } } });
          text.push(d);
          await new Promise((r) => setTimeout(r, 5));
        }
        const usage = script.usage ?? { in: 42, out: 7 };
        this.used["llm_tokens_in"] = (this.used["llm_tokens_in"] ?? 0) + usage.in;
        this.used["llm_tokens_out"] = (this.used["llm_tokens_out"] ?? 0) + usage.out;
        const result: LlmResult = { content: [{ type: "text", text: text.join("") }], stopReason: "end", usage, model: (typeof s === "object" && s.model) || "gemini/gemini-fake" };
        return result;
      }
      case "stt.transcribe": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no hosted voice");
        const audio = typeof p["audio"] === "string" ? p["audio"] : "";
        const samples = Math.floor(Buffer.from(audio, "base64").length / 2);
        this.stt.push({ samples, ...(typeof p["language"] === "string" ? { language: p["language"] } : {}) });
        this.used["stt_seconds"] = (this.used["stt_seconds"] ?? 0) + Math.ceil(samples / 16000);
        return { text: this.transcript };
      }
      case "tts.speak": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no hosted voice");
        const text = typeof p["text"] === "string" ? p["text"] : "";
        this.tts.push(text);
        for (let c = 0; c < this.speech.chunks; c++) {
          const chunk = new Int16Array(this.speech.chunkSamples);
          for (let i = 0; i < chunk.length; i++) chunk[i] = ((c * this.speech.chunkSamples + i) % 2000) - 1000;
          this.write(ws, { jsonrpc: "2.0", method: "tts.delta", params: { id, chunk: Buffer.from(chunk.buffer).toString("base64") } });
          await new Promise((r) => setTimeout(r, 5));
        }
        this.used["tts_chars"] = (this.used["tts_chars"] ?? 0) + text.length;
        return {};
      }
      case "cancel":
        this.cancels.push(p["id"] as RpcId);
        return {};
      case "backup.status": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        if (!this.backupHeader) return {};
        let updatedAt = 0;
        for (const o of this.backups.values()) updatedAt = Math.max(updatedAt, o.updatedAt);
        return { header: this.backupHeader.header, objects: this.backups.size, bytes: this.backupBytes, ...(updatedAt > 0 ? { updatedAt } : {}) };
      }
      case "backup.begin": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        const header = p["header"] as Record<string, unknown> & { keyId: string; node: string };
        if (typeof header?.keyId !== "string" || typeof header?.node !== "string") throw fail("invalid", "backup.begin: header");
        if (header.node !== ws.data.node) throw fail("invalid", "backup.begin: the header names another node");
        if (this.backupHeader && this.backupHeader.header.keyId !== header.keyId) {
          if (p["replace"] !== true) throw fail("conflict", "the account's backup is under another passphrase", { keyId: this.backupHeader.header.keyId, node: this.backupHeader.node });
          this.backups.clear();
        }
        this.backupHeader = { header, node: header.node };
        this.backupLog.push({ method, kind: "", key: "", node: header.node });
        return {};
      }
      case "backup.put": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        const kind = String(p["kind"]);
        const key = String(p["key"]);
        const version = Number(p["version"]);
        const ciphertext = String(p["ciphertext"] ?? "");
        if (!BACKUP_KINDS.includes(kind)) throw fail("invalid", `backup.put: kind ${kind}`);
        if (!this.backupHeader) throw fail("conflict", "the account has no backup; begin one first");
        if (this.backupHeader.node !== ws.data.node) throw fail("conflict", "another node owns the account's backup", { node: this.backupHeader.node });
        const size = Buffer.from(ciphertext, "base64").length;
        if (size === 0) throw fail("invalid", "backup.put: empty ciphertext");
        const have = this.backups.get(`${kind}/${key}`);
        if (have && version < have.version) throw fail("conflict", `backup.put: version ${version} is behind ${have.version}`, { version: have.version });
        if (this.backupBytes - (have?.size ?? 0) + size > this.backupBytesCap) throw fail("quota_exceeded", "the plan's backup is full", { metric: "backup_bytes", resetsAt: 0 });
        this.backups.set(`${kind}/${key}`, { kind, key, version, ciphertext, size, updatedAt: this.now() });
        this.backupLog.push({ method, kind, key, version, node: ws.data.node ?? "" });
        return {};
      }
      case "backup.delete": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        if (!this.backupHeader) throw fail("conflict", "the account has no backup; begin one first");
        if (this.backupHeader.node !== ws.data.node) throw fail("conflict", "another node owns the account's backup", { node: this.backupHeader.node });
        const kind = String(p["kind"]);
        const key = String(p["key"]);
        this.backups.delete(`${kind}/${key}`);
        this.backupLog.push({ method, kind, key, node: ws.data.node ?? "" });
        return {};
      }
      case "backup.list": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        const kind = typeof p["kind"] === "string" ? p["kind"] : undefined;
        const entries = [...this.backups.values()]
          .filter((o) => kind === undefined || o.kind === kind)
          .sort((a, b) => a.kind.localeCompare(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map((o) => ({ kind: o.kind, key: o.key, version: o.version, size: o.size }));
        return { entries };
      }
      case "backup.get": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        const o = this.backups.get(`${String(p["kind"])}/${String(p["key"])}`);
        if (!o) throw fail("not_found", "no such object");
        return { ciphertext: o.ciphertext, version: o.version };
      }
      case "backup.pull": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        const kind = String(p["kind"]);
        const after = typeof p["after"] === "string" ? p["after"] : "";
        const limit = Math.min(typeof p["limit"] === "number" ? p["limit"] : 200, 500);
        const all = [...this.backups.values()].filter((o) => o.kind === kind && o.key > after).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const page = all.slice(0, limit);
        const entries = page.map((o) => ({ key: o.key, version: o.version, ciphertext: o.ciphertext }));
        const last = page[page.length - 1];
        return page.length === limit && last ? { entries, next: last.key } : { entries };
      }
      case "backup.clear": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no backup");
        this.backups.clear();
        this.backupHeader = undefined;
        this.backupLog.push({ method, kind: "", key: "", node: ws.data.node ?? "" });
        return {};
      }
      case "compute.embed": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no hosted compute");
        if (this.embedUnavailable) throw fail("unavailable", "embeddings are not configured", { provider: "server" });
        const texts = Array.isArray(p["texts"]) ? (p["texts"] as string[]) : undefined;
        if (!texts) throw fail("invalid", "compute.embed: texts");
        if (texts.length === 0) return { vectors: [], model: FAKE_EMBED_MODEL, dim: this.embedDim };
        if (this.embedQuota) throw fail("quota_exceeded", "the plan's embed_tokens allowance is used up", { metric: "embed_tokens", resetsAt: this.embedQuota.resetsAt });
        this.embeds.push(texts);
        this.used["embed_tokens"] = (this.used["embed_tokens"] ?? 0) + Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
        return { vectors: texts.map((t) => fakeEmbed(t, this.embedDim)), model: FAKE_EMBED_MODEL, dim: this.embedDim };
      }
      case "turn.credentials": {
        if (this.plan !== "pro") throw fail("denied", "the plan has no direct connections");
        if (this.turnUnavailable) throw fail("unavailable", "TURN is not configured", { provider: "server" });
        const ttl = Math.min(typeof p["ttl"] === "number" ? (p["ttl"] as number) : 86_400, 86_400);
        const username = `turn-user-${this.turnGrants.length + 1}`;
        this.turnGrants.push({ username, ttl });
        this.used["turn_credentials"] = (this.used["turn_credentials"] ?? 0) + 1;
        return {
          iceServers: [
            { urls: ["stun:stun.cloudflare.test:3478"] },
            { urls: ["turn:turn.cloudflare.test:3478?transport=udp", "turns:turn.cloudflare.test:443?transport=tcp"], username, credential: `secret-${username}` },
          ],
          expiresAt: this.now() + ttl * 1000,
        };
      }
      case "direct.report": {
        const report = p["report"] as { day: string; counts: { kind: string; path: string; count: number }[] } | undefined;
        if (!report || typeof report.day !== "string" || !Array.isArray(report.counts)) throw fail("invalid", "direct.report: report");
        this.directReports.push(report);
        return {};
      }
      default:
        throw fail("unsupported", `unsupported: ${method}`);
    }
  }

  /** The bytes the backup holds. */
  get backupBytes(): number {
    let n = 0;
    for (const o of this.backups.values()) n += o.size;
    return n;
  }

  /** The meter, per metric. */
  readonly used: Record<string, number> = {};

  /** The ramp `tts.speak` sends, whole, for a test to compare against what the phone heard. */
  ramp(): Int16Array {
    const out = new Int16Array(this.speech.chunkSamples * this.speech.chunks);
    for (let i = 0; i < out.length; i++) out[i] = (i % 2000) - 1000;
    return out;
  }
}
