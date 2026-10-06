// The grants: one row per credential that reaches this node from outside, a phone (`controller`,
// its id a controller id) or a node (`node`, a `grt_` id), each with its own key and access.
// A row lives in `kv` under one of two namespaces: `grants`, minted on the primary and
// replicated with the rest of its kv, so a backup the user makes the primary knows every
// phone and node; or `grants.local`, minted on a node that was not the primary (a phone
// paired on a secondary), which never leaves it. Reads take both; a write goes where the row lives, a new
// row where this node's role says.
//
// A phone's token is shown once, when it is minted, and kept only as a SHA-256 hash; the key
// its relay tunnel is keyed from is kept in the clear, since this node is the other end of
// that tunnel, and so is a node's link key. An invite keeps only its secret's hash. The
// shared `data/client.token` never authenticates here, and a phone's token never on the
// loopback listener. A row outlives its connections: `connected` comes from the client
// registry, `lastSeen` from the last `hello`.
//
// Rows from before grants, under `controllers/<id>`, are moved here in place at start with
// FULL access, since that is what every phone had.
//
// A browser's grant (`form: browser`) always has an end, fixed when it is minted: a page keeps
// its token where any script of its origin can read it. One minted for a browser carries its
// form and its end from the mint; a code or a phone's invite spent from a page in a browser
// becomes a browser's then, with an end no later than thirty days out and never later than
// the one it had.
//
// A shared computer's grant (`session`) lives in this daemon's memory and nowhere else: never
// in `kv`, so no restart, no replica and no backup holds it. It is one from its mint when the
// minter asks, or from its redemption when the browser says it is a shared computer, and then
// a row that was kept leaves `kv`. It ends half a day after it was paired at the latest.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FULL, newId, RpcError } from "@cophyla/protocol";
import type { Access, Controller, Grant, GrantForm, GrantKind, GrantRole, GrantStatus, PushPlatform } from "@cophyla/protocol";
import type { ClientRegistry } from "../api/clients.ts";
import type { Store } from "../store/index.ts";
import { CLUSTER_NS, GRANTS_NS, LEGACY_CONTROLLERS_NS, LOCAL_GRANTS_NS } from "./namespaces.ts";

/** Bytes of entropy in a phone's token, and in every key and secret. */
const TOKEN_BYTES = 32;
const KEY_BYTES = 32;

/** How long a browser's grant runs unless less is asked, and the most that may be asked. */
export const BROWSER_GRANT_MS = 30 * 86_400_000;
export const BROWSER_GRANT_MAX_MS = 90 * 86_400_000;
/** The longest a shared computer's session runs from when it was paired. */
export const SESSION_GRANT_MAX_MS = 12 * 3_600_000;

export interface PushDevice {
  platform: PushPlatform;
  token: string;
  registeredAt: number;
  /** The server has not acknowledged this registration yet; replayed at the next link-up. */
  pending?: boolean;
}

/** A pending grant's invite: its secret's hash, the throwaway relay peer it may be redeemed through, and until when. */
export interface InviteRow {
  secretHash: string;
  peer?: string;
  expiresAt: number;
}

/** One grant as the store keeps it. */
export interface GrantRow {
  id: string;
  kind: GrantKind;
  name: string;
  access: Access;
  /** 32 bytes as hex: a phone's relay key, a node's link key. Absent on a node grant until it is redeemed. */
  key?: string;
  /** A phone's token, hashed. */
  tokenHash?: string;
  invite?: InviteRow;
  expiresAt?: number;
  createdAt: number;
  lastSeen?: number;
  relay?: boolean;
  push?: PushDevice;
  /** The GitHub login a phone signed in with when it paired through the account. */
  account?: string;
  /** The node a node grant was bound to when it was redeemed. */
  node?: string;
  role?: GrantRole;
  /** A key this grant held went with a node that held the replica, and no live link could carry a new one: invite it again. */
  rekey?: boolean;
  /** This node grant's node took the replica once, and with it every other node's key: removing it re-keys them. */
  replica?: boolean;
  /** `browser`: a browser's, whose grant always has an end. */
  form?: GrantForm;
  /** A shared computer's: held in memory alone. */
  session?: boolean;
}

/** How an invite or a code is being spent: from a page in a browser, which makes the grant a browser's; on a shared computer, which makes it a session's. */
export interface RedeemHow {
  browser?: boolean;
  session?: boolean;
}

type Ns = typeof GRANTS_NS | typeof LOCAL_GRANTS_NS;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A fresh 32-byte secret as hex: a token, a key, an invite's secret. */
export function freshSecret(bytes = KEY_BYTES): string {
  return randomBytes(bytes).toString("hex");
}

/** Whether a secret matches its hash, in constant time. */
export function secretMatches(secret: string, hash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  let b: Buffer;
  try {
    b = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GrantsDeps {
  store: Store;
  /** For `connected` on each row, and for closing a revoked phone's sockets. */
  registry?: ClientRegistry;
  /** Whether this node is not the primary now: what it mints then is its own alone. */
  local?: () => boolean;
  now?: () => number;
}

export class Grants {
  private deps: GrantsDeps;
  private changed = new Set<() => void>();
  /** The session grants: this daemon's alone, gone when it stops. */
  private memory = new Map<string, GrantRow>();

  constructor(deps: GrantsDeps) {
    this.deps = deps;
  }

  /** Hears every write and removal made through this store: what the clock of ends re-arms on. */
  onChange(fn: () => void): () => void {
    this.changed.add(fn);
    return () => this.changed.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.changed]) fn();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- rows -----------------------------------------------------------------------------------

  private read(ns: Ns, id: string): GrantRow | undefined {
    const value = this.deps.store.kv.get(ns, id);
    if (!value || typeof value !== "object") return undefined;
    const row = value as Partial<GrantRow>;
    if (typeof row.id !== "string" || (row.kind !== "controller" && row.kind !== "node") || typeof row.name !== "string" || !row.access) return undefined;
    return row as GrantRow;
  }

  /** Where a kept row lives: the namespace, or nothing when no namespace holds such a grant. */
  private where(id: string): Ns | undefined {
    if (this.read(GRANTS_NS, id)) return GRANTS_NS;
    if (this.read(LOCAL_GRANTS_NS, id)) return LOCAL_GRANTS_NS;
    return undefined;
  }

  /** A grant's row: a session's from memory, any other from either namespace. */
  get(id: string): GrantRow | undefined {
    return this.memory.get(id) ?? this.read(GRANTS_NS, id) ?? this.read(LOCAL_GRANTS_NS, id);
  }

  /** Whether the row is this node's alone: minted here off the primary, or a session in its memory. */
  isLocal(id: string): boolean {
    return this.memory.has(id) || this.where(id) === LOCAL_GRANTS_NS;
  }

  /** Every row: the primary's, this node's own, and the sessions in its memory. */
  rows(): GrantRow[] {
    const out: GrantRow[] = [...this.memory.values()];
    for (const ns of [GRANTS_NS, LOCAL_GRANTS_NS] as const) {
      for (const key of this.deps.store.kv.list(ns)) {
        const row = this.read(ns, key);
        if (row) out.push(row);
      }
    }
    return out;
  }

  /**
   * Writes a row where it lives, or, for a new one, where `into` or this node's role says. A
   * session's row lives in memory: one that was kept until now leaves its namespace, and one
   * that is a session no more (its invite opened again) goes back to one.
   */
  private write(row: GrantRow, at = this.now(), into?: Ns): void {
    if (row.session) {
      const kept = this.where(row.id);
      if (kept) this.deps.store.kv.delete(kept, row.id);
      this.memory.set(row.id, row);
    } else {
      this.memory.delete(row.id);
      const ns = this.where(row.id) ?? into ?? (this.deps.local?.() ? LOCAL_GRANTS_NS : GRANTS_NS);
      this.deps.store.kv.put(ns, row.id, row, at);
    }
    this.emit();
  }

  private update(id: string, patch: (row: GrantRow) => GrantRow | undefined): GrantRow | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    const next = patch({ ...row });
    if (next) this.write(next);
    return next;
  }

  /** A row's status: pending until its invite is redeemed, `reinvite` once its key could not be replaced. */
  status(row: GrantRow): GrantStatus {
    if (row.rekey) return "reinvite";
    const redeemed = row.kind === "controller" ? row.tokenHash !== undefined : row.key !== undefined && row.node !== undefined;
    return redeemed ? "active" : "pending";
  }

  /** Whether a row is past its own end. */
  expired(row: GrantRow, at = this.now()): boolean {
    return row.expiresAt !== undefined && row.expiresAt <= at;
  }

  private connected(row: GrantRow): boolean {
    if (row.kind === "controller") return (this.deps.registry?.byController(row.id).length ?? 0) > 0;
    return false;
  }

  /** The row as a client sees it: no key, no hash, no secret. */
  entity(row: GrantRow, connected = this.connected(row)): Grant {
    const out: Grant = { id: row.id, kind: row.kind, name: row.name, access: row.access, status: this.status(row), createdAt: row.createdAt, connected };
    if (row.role !== undefined) out.role = row.role;
    if (row.node !== undefined) out.node = row.node;
    if (row.expiresAt !== undefined) out.expiresAt = row.expiresAt;
    if (row.invite && out.status === "pending") out.inviteExpiresAt = row.invite.expiresAt;
    if (row.lastSeen !== undefined) out.lastSeen = row.lastSeen;
    if (row.relay) out.relay = true;
    if (row.push) out.push = { platform: row.push.platform, registeredAt: row.push.registeredAt };
    if (row.account !== undefined) out.account = row.account;
    if (this.isLocal(row.id)) out.local = true;
    if (row.form !== undefined) out.form = row.form;
    if (row.session) out.session = true;
    return out;
  }

  list(): Grant[] {
    return this.rows()
      .map((r) => this.entity(r))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.createdAt - a.createdAt);
  }

  /** Forgets a grant; its live connections and its relay access are the caller's to end. */
  revoke(id: string): GrantRow | undefined {
    const session = this.memory.get(id);
    if (session) {
      this.memory.delete(id);
      this.emit();
      return session;
    }
    const ns = this.where(id);
    if (!ns) return undefined;
    const row = this.read(ns, id);
    this.deps.store.kv.delete(ns, id);
    this.emit();
    return row;
  }

  // --- phones ---------------------------------------------------------------------------------

  /** A phone's row as the controller protocol has always shown it. */
  controllerEntity(row: GrantRow): Controller {
    const entries = this.deps.registry?.byController(row.id) ?? [];
    const out: Controller = { id: row.id, name: row.name, pairedAt: row.createdAt, connected: entries.length > 0, access: row.access };
    // how it reaches the node now: the best of its connections
    const p2p = entries.find((e) => e.listener === "p2p");
    if (p2p) out.path = p2p.client.path === "turn" ? "turn" : "direct";
    else if (entries.some((e) => e.listener === "cloud")) out.path = "relay";
    else if (entries.some((e) => e.listener === "controller")) out.path = "lan";
    if (row.lastSeen !== undefined) out.lastSeen = row.lastSeen;
    if (row.relay) out.relay = true;
    if (row.push) out.push = { platform: row.push.platform, registeredAt: row.push.registeredAt };
    if (row.account !== undefined) out.account = row.account;
    if (row.expiresAt !== undefined) out.expiresAt = row.expiresAt;
    if (row.form !== undefined) out.form = row.form;
    if (row.session) out.session = true;
    return out;
  }

  /**
   * A new phone, with the token it keeps and its relay key; the token is never stored and
   * never shown again. `account` for a phone that paired through the account; `form` for a
   * browser, whose grant must come with an end; `session` for a shared computer's.
   */
  createController(name: string, opts: { account?: string; access?: Access; expiresAt?: number; form?: GrantForm; session?: boolean } = {}): { controller: Controller; token: string; key: string } {
    const now = this.now();
    const token = freshSecret(TOKEN_BYTES);
    const key = freshSecret();
    const row: GrantRow = {
      id: newId("controller", now),
      kind: "controller",
      name,
      access: opts.access ?? FULL,
      key,
      tokenHash: hashSecret(token),
      createdAt: now,
      ...(opts.account !== undefined ? { account: opts.account } : {}),
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.form !== undefined ? { form: opts.form } : {}),
      ...(opts.session ? { session: true } : {}),
    };
    if (row.form === "browser" && row.expiresAt === undefined) row.expiresAt = now + BROWSER_GRANT_MS;
    if (row.session) row.expiresAt = Math.min(row.expiresAt ?? Infinity, now + SESSION_GRANT_MAX_MS);
    this.write(row, now);
    return { controller: this.controllerEntity(row), token, key };
  }

  /** The phone a token belongs to, compared against every hash in constant time; an expired grant authenticates nothing. */
  authenticate(token: string): Controller | undefined {
    const candidate = Buffer.from(hashSecret(token), "hex");
    let found: GrantRow | undefined;
    for (const row of this.rows()) {
      if (row.kind !== "controller" || row.tokenHash === undefined) continue;
      let stored: Buffer;
      try {
        stored = Buffer.from(row.tokenHash, "hex");
      } catch {
        continue;
      }
      // Every row is compared, so the time taken does not say which one matched.
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) found = row;
    }
    if (!found || this.expired(found)) return undefined;
    return this.controllerEntity(found);
  }

  /** The phones, as `controller.list` answers them. */
  controllers(): Controller[] {
    return this.rows()
      .filter((r) => r.kind === "controller" && this.status(r) === "active")
      .map((r) => this.controllerEntity(r))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.pairedAt - a.pairedAt);
  }

  controller(id: string): Controller | undefined {
    const row = this.get(id);
    return row?.kind === "controller" ? this.controllerEntity(row) : undefined;
  }

  /** Whether a phone's grant authenticates now: its row is there, redeemed, and not past its end. What a hello checks again once it has been answered. */
  stands(id: string, at = this.now()): boolean {
    const row = this.get(id);
    return row !== undefined && row.kind === "controller" && row.tokenHash !== undefined && !this.expired(row, at);
  }

  /** Records that a grant's holder said `hello`, or linked. */
  touch(id: string, at = this.now()): void {
    this.update(id, (row) => ({ ...row, lastSeen: at }));
  }

  // --- keys and the relay -----------------------------------------------------------------------

  /** The key a grant's tunnels are keyed from; a phone's is minted on the way in when an older row lacks it. */
  key(id: string): string | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    if (row.key === undefined && row.kind === "controller") {
      row.key = freshSecret();
      this.write(row);
    }
    return row.key;
  }

  /** Whether the server relay was granted to the grant. */
  setRelay(id: string, granted: boolean): void {
    this.update(id, (row) => ({ ...row, relay: granted }));
  }

  // --- push -----------------------------------------------------------------------------------

  setPush(id: string, device: PushDevice | undefined): void {
    this.update(id, (row) => {
      const next: GrantRow = { ...row };
      if (device) next.push = device;
      else delete next.push;
      return next;
    });
  }

  pushOf(id: string): PushDevice | undefined {
    return this.get(id)?.push;
  }

  /** Every phone with a push device, for the push module. */
  withPush(): { id: string; name: string; access: Access; push: PushDevice }[] {
    return this.rows().flatMap((r) => (r.kind === "controller" && r.push && !this.expired(r) ? [{ id: r.id, name: r.name, access: r.access, push: r.push }] : []));
  }

  // --- invites ---------------------------------------------------------------------------------

  /**
   * A pending grant and the one secret its invite carries, returned once and kept only as its
   * hash. A node's grant is a `grt_` id; a phone's is its controller id. `invitePeer` is the
   * throwaway relay peer the invite may be redeemed through. `secret` is the invite's when the
   * caller makes it itself (a browser's key, which a person types).
   */
  mint(opts: { kind: GrantKind; name: string; access: Access; role?: GrantRole; expiresAt?: number; inviteExpiresAt: number; invitePeer?: string; form?: GrantForm; session?: boolean; secret?: string }): { row: GrantRow; secret: string } {
    const now = this.now();
    const secret = opts.secret ?? freshSecret();
    if (opts.form === "browser" && opts.expiresAt === undefined) throw new RpcError("invalid", "a browser's grant has an end");
    const row: GrantRow = {
      id: newId(opts.kind === "node" ? "grant" : "controller", now),
      kind: opts.kind,
      name: opts.name,
      access: opts.access,
      invite: { secretHash: hashSecret(secret), expiresAt: opts.inviteExpiresAt, ...(opts.invitePeer !== undefined ? { peer: opts.invitePeer } : {}) },
      createdAt: now,
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.form !== undefined ? { form: opts.form } : {}),
      ...(opts.session && opts.kind === "controller" ? { session: true } : {}),
    };
    this.write(row, now);
    return { row, secret };
  }

  /** A pending grant whose invite may still be redeemed now, by the grant's id. */
  pending(id: string, at = this.now()): GrantRow | undefined {
    const row = this.get(id);
    if (!row?.invite || this.status(row) !== "pending" || row.invite.expiresAt <= at || this.expired(row, at)) return undefined;
    return row;
  }

  /**
   * The pending browser grant a key opens. The key's hash is compared against every browser
   * invite's, each one, so the time taken says nothing of which matched; a phone's invite is
   * never found by a key.
   */
  browserInvite(key: string, at = this.now()): GrantRow | undefined {
    const candidate = Buffer.from(hashSecret(key), "hex");
    let found: GrantRow | undefined;
    for (const row of this.rows()) {
      if (row.kind !== "controller" || row.form !== "browser" || !row.invite) continue;
      let stored: Buffer;
      try {
        stored = Buffer.from(row.invite.secretHash, "hex");
      } catch {
        continue;
      }
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) found = row;
    }
    return found ? this.pending(found.id, at) : undefined;
  }

  /** A pending grant by the throwaway relay peer its invite is redeemed through. */
  byInvitePeer(peer: string, at = this.now()): GrantRow | undefined {
    const row = this.rows().find((r) => r.invite?.peer === peer);
    return row ? this.pending(row.id, at) : undefined;
  }

  /** The node grant bound to a node id. */
  forNode(node: string): GrantRow | undefined {
    return this.rows().find((r) => r.kind === "node" && r.node === node);
  }

  /**
   * Redeems a node grant's invite: the grant is bound to `node` and given a fresh key, and the
   * invite burns. The check and the burn happen with nothing in between, so two redemptions
   * racing each other cannot both win. Refused: an invite that is not open, a node id that is
   * this node's own or another grant's.
   */
  enrollNode(id: string, node: string, selfId: string): { row: GrantRow; key: string } {
    const row = this.pending(id);
    if (!row || row.kind !== "node") throw new RpcError("denied", "that invite is not open");
    if (node === selfId) throw new RpcError("conflict", "a node cannot join itself");
    const bound = this.forNode(node);
    if (bound && bound.id !== id) throw new RpcError("conflict", `node ${node} already holds grant ${bound.id}`);
    const key = freshSecret();
    const { invite: _invite, ...rest } = row;
    const next: GrantRow = { ...rest, key, node, lastSeen: this.now() };
    this.write(next);
    return { row: next, key };
  }

  /**
   * Redeems a phone's invite: the grant gets a token and a key of its own, and the invite
   * burns. The check and the burn happen with nothing in between, so two redemptions racing
   * each other cannot both win. `peer` is the relay peer the redemption came in on, which
   * must be the invite's own. Refused alike: an invite that is not open, the wrong secret,
   * another invite's peer. Returns the token, shown once, the invite it burnt, and the row as
   * it was, for `reopen`. Spent from a page in a browser, a grant that was not minted for one
   * becomes a browser's, with an end thirty days out at the latest and never later than its own.
   * Spent on a shared computer, or minted for one, it is a session's from here: in memory
   * alone, and ended half a day from now at the latest.
   */
  redeemController(id: string, secret: string, peer?: string, how: RedeemHow = {}): { row: GrantRow; token: string; invite: InviteRow; pending: GrantRow } {
    const row = this.pending(id);
    if (!row?.invite || row.kind !== "controller" || !secretMatches(secret, row.invite.secretHash) || (peer !== undefined && row.invite.peer !== peer)) {
      throw new RpcError("denied", "that invite is not open");
    }
    const now = this.now();
    const token = freshSecret(TOKEN_BYTES);
    const { invite, ...rest } = row;
    const next: GrantRow = { ...rest, key: freshSecret(), tokenHash: hashSecret(token), lastSeen: now };
    if (how.browser && next.form !== "browser") {
      next.form = "browser";
      next.expiresAt = Math.min(next.expiresAt ?? Infinity, now + BROWSER_GRANT_MS);
    }
    if (how.session || next.session) {
      next.session = true;
      next.expiresAt = Math.min(next.expiresAt ?? Infinity, now + SESSION_GRANT_MAX_MS);
    }
    this.write(next);
    return { row: next, token, invite, pending: row };
  }

  /** Opens a phone's invite again, the row as it was before it was spent: the phone that redeemed it left before its answer, so it never held the token. */
  reopen(pending: GrantRow): void {
    this.update(pending.id, () => ({ ...pending }));
  }

  /**
   * The grant this node keeps for itself, a full member's, bound to its own id: minted once, by
   * the cluster's first primary, among the primary's grants, so a backup that takes the role
   * over knows it when this node comes back.
   */
  ensureSelf(nodeId: string, name: string): GrantRow {
    const existing = this.forNode(nodeId);
    if (existing?.key) return existing;
    const now = this.now();
    const row: GrantRow = { id: newId("grant", now), kind: "node", name, access: FULL, role: "full", key: freshSecret(), node: nodeId, createdAt: now };
    this.write(row, now, GRANTS_NS);
    return row;
  }

  /** A grant's key replaced, by `key` or a fresh one: what re-keying after a replica holder went does. */
  rekey(id: string, key = freshSecret()): string | undefined {
    return this.update(id, (row) => {
      const { rekey: _rekey, ...rest } = row;
      return { ...rest, key };
    })
      ? key
      : undefined;
  }

  /** Marks a node grant whose node took the replica. */
  markReplica(id: string): void {
    const row = this.get(id);
    if (row && row.kind === "node" && !row.replica) this.update(id, (r) => ({ ...r, replica: true }));
  }

  /** The nearest moment one of `rows` ends by itself: its own end, or a pending grant's invite's. */
  nextEnd(rows = this.rows()): number | undefined {
    let next: number | undefined;
    for (const row of rows) {
      for (const at of [row.expiresAt, this.status(row) === "pending" ? row.invite?.expiresAt : undefined]) {
        if (at !== undefined && (next === undefined || at < next)) next = at;
      }
    }
    return next;
  }

  /** Why a row has ended by `at`: its own end, or its invite's while it is pending; undefined while it runs. */
  ended(row: GrantRow, at = this.now()): "expired" | "invite expired" | undefined {
    if (this.expired(row, at)) return "expired";
    if (this.status(row) === "pending" && row.invite !== undefined && row.invite.expiresAt <= at) return "invite expired";
    return undefined;
  }

  /** A grant whose key could not be replaced over a live link: its machine must be invited again. */
  markReinvite(id: string): void {
    this.update(id, (row) => ({ ...row, rekey: true }));
  }

  // --- the cluster -----------------------------------------------------------------------------

  /** The cluster's id, minted by its first primary and replicated with the grants; none on a node that never was one. */
  cluster(create = false): string | undefined {
    const id = this.deps.store.kv.get(CLUSTER_NS, "id");
    if (typeof id === "string") return id;
    if (!create) return undefined;
    const fresh = randomBytes(8).toString("hex");
    this.deps.store.kv.put(CLUSTER_NS, "id", fresh);
    return fresh;
  }

  /** Records the cluster's id where the primary keeps it: a primary whose store lost it, or never had it, takes its membership's. */
  setCluster(id: string): void {
    if (this.deps.store.kv.get(CLUSTER_NS, "id") !== id) this.deps.store.kv.put(CLUSTER_NS, "id", id);
  }

  /**
   * Forgets the cluster this node was in: its id and every node grant, keys and pending invites
   * alike. What a node that leaves, or gives up a cluster of its own to join another, keeps no
   * more; its phones stay.
   */
  forgetCluster(): number {
    let n = 0;
    for (const row of this.rows()) {
      if (row.kind !== "node") continue;
      const ns = this.where(row.id);
      if (ns && this.deps.store.kv.delete(ns, row.id)) n++;
    }
    this.deps.store.kv.delete(CLUSTER_NS, "id");
    if (n > 0) this.emit();
    return n;
  }

  // --- the rows from before grants ------------------------------------------------------------

  /**
   * Moves every `controllers/<id>` row into a grant with FULL access, in `into`: `grants` on a
   * node whose rows are the primary's (a primary, a backup), `grants.local` on one whose rows
   * are its own. Returns how many moved.
   */
  migrate(into: Ns): number {
    let moved = 0;
    for (const id of this.deps.store.kv.list(LEGACY_CONTROLLERS_NS)) {
      const value = this.deps.store.kv.get(LEGACY_CONTROLLERS_NS, id) as Partial<{ id: string; name: string; tokenHash: string; pairedAt: number; lastSeen: number; relayKey: string; relay: boolean; push: PushDevice; account: string }> | undefined;
      if (value && typeof value.id === "string" && typeof value.name === "string" && typeof value.tokenHash === "string" && !this.get(value.id)) {
        const row: GrantRow = {
          id: value.id,
          kind: "controller",
          name: value.name,
          access: FULL,
          key: typeof value.relayKey === "string" ? value.relayKey : freshSecret(),
          tokenHash: value.tokenHash,
          createdAt: value.pairedAt ?? 0,
          ...(value.lastSeen !== undefined ? { lastSeen: value.lastSeen } : {}),
          ...(value.relay !== undefined ? { relay: value.relay } : {}),
          ...(value.push && typeof value.push.token === "string" ? { push: value.push } : {}),
          ...(typeof value.account === "string" ? { account: value.account } : {}),
        };
        this.deps.store.kv.put(into, row.id, row);
        moved++;
      }
      this.deps.store.kv.delete(LEGACY_CONTROLLERS_NS, id);
    }
    return moved;
  }
}
