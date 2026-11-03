// The registry client: the nodes module's window on the server's arbitration. `active`
// says whether the server may be asked at all (the link is up, the plan has the relay,
// `[nodes] relay` is on); the three calls carry the role machine's claims, registers and
// heartbeats. A node claims the role only where the user chose it, and a primary holds it
// for the same reason, so both say `chosen`: the server lets no other higher epoch take a
// live lease; `onUp` fires once the link is up and the entitlement refreshed, so a
// listener that registers on it knows the plan; `onPrimary` carries the server's
// `registry.primary` frames, the grant that went to another node. Nothing here decides a
// role: the nodes module does, with the grant invariant described there. A secondary's
// relayed link to its primary is not the account's: it holds its own grant's relay token.
//
// Every call says the cluster this node is in, and every answer the account's: the cluster
// the account's machines are in. A machine signed in to the account outside it asks to be
// let in with `join`, for itself or a machine it leads, and the server hands over an invite
// the account's primary minted; the primary's side is `onInvite`, the server's
// `account.invite` to it.

import { RpcError, serverLinkInbound } from "@cophyla/protocol";
import type { GrantRole, Node } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export interface ClaimAnswer {
  granted: boolean;
  primary?: string;
  epoch?: number;
  cluster?: string;
}

export interface HolderAnswer {
  primary?: string;
  epoch?: number;
  /** The account's cluster, the one its machines are in, when the server knows one. */
  cluster?: string;
  /** This node's cluster was moved into the account's, and this node was not reached then. */
  merged?: boolean;
}

/** The server's `account.invite`: a machine of the account asked to join, for itself or one it leads. */
export interface InviteAsk {
  node: { id: string; name: string };
  role: GrantRole;
  by: string;
}

/** What the nodes module holds: see nodes/index.ts for the rules it applies. */
export interface Arbiter {
  /** The server may be asked now: link up, the plan has the relay, `[nodes] relay` on. */
  active(): boolean;
  /** The link is up and the plan known, whatever it grants: what a starting primary waits for. */
  ready(): boolean;
  register(node: Node, epoch: number, cluster?: string): Promise<HolderAnswer>;
  claim(epoch: number, cluster?: string): Promise<ClaimAnswer>;
  heartbeat(): Promise<HolderAnswer>;
  /** `account.join`: an invite into the account's machines for `node`, this one or one it leads; `from`, on its own, the cluster it moves in. */
  join(node: { id: string; name: string }, role?: GrantRole, from?: string): Promise<string>;
  onUp(fn: () => void): () => void;
  onPrimary(fn: (primary: string, epoch: number, cluster?: string) => void): () => void;
  /** The server asks this node, the account's primary, for an invite; one answerer at a time. */
  onInvite(fn: ((ask: InviteAsk) => Promise<string>) | undefined): void;
}

export interface RegistryClientDeps {
  log: Logger;
  nodeId: string;
  active: () => boolean;
  request: (method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
}

const REQUEST_TIMEOUT_MS = 15_000;
/** `account.join` waits on the account's primary as well as the server, which gives it 20 s. */
const JOIN_TIMEOUT_MS = 30_000;

export class RegistryClient implements Arbiter {
  private deps: RegistryClientDeps;
  private ups = new Set<() => void>();
  private primaries = new Set<(primary: string, epoch: number, cluster?: string) => void>();
  private inviter: ((ask: InviteAsk) => Promise<string>) | undefined;
  private up = false;

  constructor(deps: RegistryClientDeps) {
    this.deps = deps;
  }

  active(): boolean {
    return this.up && this.deps.active();
  }

  ready(): boolean {
    return this.up;
  }

  /** The cloud module: the link went down. */
  linkDown(): void {
    this.up = false;
  }

  private holder(r: unknown): HolderAnswer {
    const a = (r ?? {}) as { primary?: unknown; epoch?: unknown; cluster?: unknown };
    const out: HolderAnswer = {};
    if (typeof a.primary === "string") out.primary = a.primary;
    if (typeof a.epoch === "number") out.epoch = a.epoch;
    if (typeof a.cluster === "string") out.cluster = a.cluster;
    if ((a as { merged?: unknown }).merged === true) out.merged = true;
    return out;
  }

  async register(node: Node, epoch: number, cluster?: string): Promise<HolderAnswer> {
    return this.holder(await this.deps.request("registry.register", { node, epoch, ...(node.role === "primary" ? { chosen: true } : {}), ...(cluster !== undefined ? { cluster } : {}) }, { timeoutMs: REQUEST_TIMEOUT_MS }));
  }

  async claim(epoch: number, cluster?: string): Promise<ClaimAnswer> {
    const r = (await this.deps.request("registry.claim", { node: this.deps.nodeId, epoch, chosen: true, ...(cluster !== undefined ? { cluster } : {}) }, { timeoutMs: REQUEST_TIMEOUT_MS })) as { granted?: unknown };
    return { granted: r?.granted === true, ...this.holder(r) };
  }

  async heartbeat(): Promise<HolderAnswer> {
    return this.holder(await this.deps.request("registry.heartbeat", { node: this.deps.nodeId }, { timeoutMs: REQUEST_TIMEOUT_MS }));
  }

  async join(node: { id: string; name: string }, role?: GrantRole, from?: string): Promise<string> {
    const r = (await this.deps.request("account.join", { node, ...(role !== undefined ? { role } : {}), ...(from !== undefined ? { from } : {}) }, { timeoutMs: JOIN_TIMEOUT_MS })) as { invite?: unknown };
    if (typeof r?.invite !== "string" || r.invite.length === 0) throw new RpcError("unavailable", "the server answered no invite");
    return r.invite;
  }

  onUp(fn: () => void): () => void {
    this.ups.add(fn);
    return () => this.ups.delete(fn);
  }

  onPrimary(fn: (primary: string, epoch: number, cluster?: string) => void): () => void {
    this.primaries.add(fn);
    return () => this.primaries.delete(fn);
  }

  onInvite(fn: ((ask: InviteAsk) => Promise<string>) | undefined): void {
    this.inviter = fn;
  }

  /** The cloud module: the server's `account.invite`, answered by the nodes module or refused. */
  async invite(params: unknown): Promise<{ invite: string }> {
    const parsed = serverLinkInbound["account.invite"].params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", "account.invite: node, role and by required");
    if (!this.inviter) throw new RpcError("unavailable", "this node lets no machine in now");
    return { invite: await this.inviter(parsed.data) };
  }

  /** The cloud module: the link is up and the entitlement known. */
  emitUp(): void {
    this.up = true;
    for (const fn of [...this.ups]) {
      try {
        fn();
      } catch (e) {
        this.deps.log.warn("registry up handler failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** The cloud module: a `registry.primary` frame. */
  emitPrimary(params: unknown): void {
    const p = (params ?? {}) as { primary?: unknown; epoch?: unknown; cluster?: unknown };
    if (typeof p.primary !== "string") return;
    const epoch = typeof p.epoch === "number" ? p.epoch : 0;
    const cluster = typeof p.cluster === "string" ? p.cluster : undefined;
    for (const fn of [...this.primaries]) {
      try {
        fn(p.primary, epoch, cluster);
      } catch (e) {
        this.deps.log.warn("registry primary handler failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}
