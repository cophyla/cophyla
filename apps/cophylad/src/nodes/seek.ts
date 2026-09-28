// Seeking the primary: the ways to it in order (`linkCandidates`), and the loop that tries
// them (`Seeker`). A round tries each way once: a LAN endpoint the last primary told us to
// go to, the configured one, the enrollment's, the ones heard on the network newest first,
// the registry's primary and backups by rank, and the relay last (first after a step-down
// to a node with no LAN endpoint). A refusal that names the primary puts it next. A round
// that finds no one waits, twice as long each time up to a cap, and tries again while the
// owner still seeks. The machine's own membership (`Nodes`) and each workspace node's
// (`GuestMember`) seek with it; what a fruitless round means beyond waiting is the owner's.

import { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { LinkTarget } from "./outbound.ts";

export interface CandidateSources {
  /** An endpoint to try first: the primary that told us where to go. */
  preferred?: string;
  /** `[nodes] primary`. */
  configured?: string;
  /** Where the primary's LAN listener was at the enrollment. */
  membership?: readonly string[];
  /** Primaries heard on the network. */
  heard?: readonly { endpoint: string; heardAt: number }[];
  /** The registry's last primary's endpoints, then each backup's by rank. */
  registryPrimary?: readonly string[];
  registryBackups?: readonly (readonly string[])[];
  /** This node's own endpoints: never a way to the primary. */
  self?: readonly string[];
  /** The relay, when this node's grant has a token for it. */
  relay?: LinkTarget;
  /** The relay before the LAN: after a step-down to a node with no LAN endpoint. */
  relayFirst?: boolean;
}

/** The LAN endpoints to try, in order, each once. */
export function endpointCandidates(o: CandidateSources): string[] {
  const out: string[] = [];
  const push = (e: string | undefined) => {
    if (e && !out.includes(e)) out.push(e);
  };
  push(o.preferred);
  push(o.configured);
  for (const e of o.membership ?? []) push(e);
  for (const c of [...(o.heard ?? [])].sort((a, b) => b.heardAt - a.heardAt)) push(c.endpoint);
  for (const e of o.registryPrimary ?? []) push(e);
  for (const b of o.registryBackups ?? []) for (const e of b) push(e);
  const self = o.self ?? [];
  return out.filter((e) => !self.includes(e));
}

/** Every way to the primary, in order: the LAN endpoints, then the relay (first, when asked). */
export function linkCandidates(o: CandidateSources): LinkTarget[] {
  const direct: LinkTarget[] = endpointCandidates(o).map((endpoint) => ({ kind: "direct", endpoint }));
  if (!o.relay) return direct;
  return o.relayFirst ? [o.relay, ...direct] : [...direct, o.relay];
}

export interface SeekerDeps {
  /** The ways to try this round, in order. */
  candidates: () => LinkTarget[];
  /** Links over one way; resolves once linked, rejects when that way is no good now. */
  connect: (target: LinkTarget) => Promise<unknown>;
  /** Whether the owner still seeks. */
  active: () => boolean;
  reconnectMs: number;
  reconnectMaxMs: number;
  /** A way answered: the owner forgets what pointed it there. */
  linked?: () => void;
  /** A round found no one; true when that settled things (a promotion) and no round follows. */
  missed?: () => Promise<boolean>;
  log: Logger;
}

export class Seeker {
  private deps: SeekerDeps;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private backoffMs: number;

  constructor(deps: SeekerDeps) {
    this.deps = deps;
    this.backoffMs = deps.reconnectMs;
  }

  /** Whether a round is running now. */
  get seeking(): boolean {
    return this.running;
  }

  /** Runs one round now, then again after the backoff while the owner still seeks. */
  kick(): void {
    this.clearTimer();
    void this.once();
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The owner stopped seeking (it took the role, or left): no round is taken for running. */
  abandon(): void {
    this.clearTimer();
    this.running = false;
  }

  /** The next wait is the shortest again: a fresh membership. */
  resetBackoff(): void {
    this.backoffMs = this.deps.reconnectMs;
  }

  private async once(): Promise<void> {
    if (this.running || !this.deps.active()) return;
    this.running = true;
    try {
      const tried = new Set<string>();
      const queue = this.deps.candidates();
      while (queue.length > 0 && this.deps.active()) {
        const target = queue.shift()!;
        const key = target.kind === "direct" ? target.endpoint : "relay";
        if (tried.has(key)) continue;
        tried.add(key);
        try {
          await this.deps.connect(target);
          this.deps.linked?.();
          this.backoffMs = this.deps.reconnectMs;
          return;
        } catch (e) {
          const hint = e instanceof RpcError ? (e.error.data as { primary?: string } | undefined)?.primary : undefined;
          this.deps.log.debug("candidate refused", { endpoint: key, error: e instanceof Error ? e.message : String(e), ...(hint ? { primary: hint } : {}) });
          if (hint && !tried.has(hint)) queue.unshift({ kind: "direct", endpoint: hint });
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.deps.active()) return;
    if (this.deps.missed && (await this.deps.missed())) return;
    if (!this.deps.active()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.once();
    }, this.backoffMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, this.deps.reconnectMaxMs);
  }
}
