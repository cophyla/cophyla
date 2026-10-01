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

import type { Node } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export interface ClaimAnswer {
  granted: boolean;
  primary?: string;
  epoch?: number;
}

export interface HolderAnswer {
  primary?: string;
  epoch?: number;
}

/** What the nodes module holds: see nodes/index.ts for the rules it applies. */
export interface Arbiter {
  /** The server may be asked now: link up, the plan has the relay, `[nodes] relay` on. */
  active(): boolean;
  /** The link is up and the plan known, whatever it grants: what a starting primary waits for. */
  ready(): boolean;
  register(node: Node, epoch: number): Promise<HolderAnswer>;
  claim(epoch: number): Promise<ClaimAnswer>;
  heartbeat(): Promise<HolderAnswer>;
  onUp(fn: () => void): () => void;
  onPrimary(fn: (primary: string, epoch: number) => void): () => void;
}

export interface RegistryClientDeps {
  log: Logger;
  nodeId: string;
  active: () => boolean;
  request: (method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class RegistryClient implements Arbiter {
  private deps: RegistryClientDeps;
  private ups = new Set<() => void>();
  private primaries = new Set<(primary: string, epoch: number) => void>();
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
    const a = (r ?? {}) as { primary?: unknown; epoch?: unknown };
    const out: HolderAnswer = {};
    if (typeof a.primary === "string") out.primary = a.primary;
    if (typeof a.epoch === "number") out.epoch = a.epoch;
    return out;
  }

  async register(node: Node, epoch: number): Promise<HolderAnswer> {
    return this.holder(await this.deps.request("registry.register", { node, epoch, ...(node.role === "primary" ? { chosen: true } : {}) }, { timeoutMs: REQUEST_TIMEOUT_MS }));
  }

  async claim(epoch: number): Promise<ClaimAnswer> {
    const r = (await this.deps.request("registry.claim", { node: this.deps.nodeId, epoch, chosen: true }, { timeoutMs: REQUEST_TIMEOUT_MS })) as { granted?: unknown };
    return { granted: r?.granted === true, ...this.holder(r) };
  }

  async heartbeat(): Promise<HolderAnswer> {
    return this.holder(await this.deps.request("registry.heartbeat", { node: this.deps.nodeId }, { timeoutMs: REQUEST_TIMEOUT_MS }));
  }

  onUp(fn: () => void): () => void {
    this.ups.add(fn);
    return () => this.ups.delete(fn);
  }

  onPrimary(fn: (primary: string, epoch: number) => void): () => void {
    this.primaries.add(fn);
    return () => this.primaries.delete(fn);
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
    const p = (params ?? {}) as { primary?: unknown; epoch?: unknown };
    if (typeof p.primary !== "string") return;
    const epoch = typeof p.epoch === "number" ? p.epoch : 0;
    for (const fn of [...this.primaries]) {
      try {
        fn(p.primary, epoch);
      } catch (e) {
        this.deps.log.warn("registry primary handler failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}
