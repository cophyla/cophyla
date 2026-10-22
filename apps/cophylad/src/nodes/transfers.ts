// Transfers across the links, for the machine a transfer goes to: what a path holds
// (`files.tree`) and a pipe of a file's bytes (`files.pipe.open`, then `pipe.*` frames as a
// stream page's go). A request for this node is served here, gated as the node on the link
// (a read: the primary's own, unasked where this machine trusted it at the join), within the
// folders a confined node shares; a pipe is gated once per path a while, so the files of one
// folder make one audit row and not one each. A request for another node the primary
// carries on to it, a listing forwarded and a pipe joined from one link to the next, never to
// a node that sends no files or lends folders of another person's machine. Both ends of a
// link share this.
//
// A hands node is driven and drives nothing, yet a transfer to it is pulled by it: so the
// primary serves a hands node's pulls only for what the primary itself sent it, the source
// and path of each transfer it forwarded there (`HandsPulls`), never any other path, here or
// on another node. Pulling from a hands node needs no such word: its primary drives it.

import { nodeLinkRequests, RpcError } from "@cophyla/protocol";
import type { NodeRecord, Transfer } from "@cophyla/protocol";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import type { PipeHub } from "../remote/pipes.ts";
import { TREE_TIMEOUT_MS } from "../transfers/index.ts";
import type { TreeCache, TreePage } from "../transfers/tree.ts";
import type { LinkFrom } from "./streams.ts";
import { PIPE_OPEN_TIMEOUT_MS } from "./streams.ts";

export const FILE_LINK_REQUESTS: ReadonlySet<string> = new Set(["files.tree", "files.pipe.open"]);

/** How long a path a link was let read stays let: about as long as a big folder takes. */
const ALLOWED_MS = 60 * 60_000;

/** The kv namespace of what the primary sent its hands nodes, by transfer id. */
export const HANDS_PULLS_NS = "hands-pulls";
/** How long a hands node may pull what it was sent, failed and retried included. */
const HANDS_PULL_MS = 7 * 24 * 60 * 60_000;

/** The kv namespace of transfers the user ended while their machine was offline, by transfer id. */
export const TRANSFER_ENDS_NS = "transfer-ends";
/** How long such an end waits for its machine to come back. */
const TRANSFER_END_MS = 30 * 24 * 60 * 60_000;

/** The node on the link a transfer request came from; `hands` when it joined as hands. */
export interface TransferFrom extends LinkFrom {
  hands?: boolean;
}

interface HandsPull {
  hands: string;
  node: string;
  path: string;
  until: number;
}

interface TransferEnd {
  node: string;
  cancel: boolean;
  until: number;
}

/**
 * At the primary, what the user asked of a transfer while its machine was offline: the transfer
 * goes from every list at once, and is cancelled and dismissed on that machine when it is back.
 * Kept in the store, so a restart here brings no cancelled transfer back to life; forgotten
 * after 30 days.
 */
export class TransferEnds {
  private kv: Store["kv"];
  private now: () => number;

  constructor(kv: Store["kv"], now: () => number = Date.now) {
    this.kv = kv;
    this.now = now;
  }

  /** The user cancelled (`cancel`) or dismissed transfer `id` of offline machine `node`. */
  asked(node: string, id: string, cancel: boolean): void {
    const was = this.kv.get(TRANSFER_ENDS_NS, id) as TransferEnd | undefined;
    this.kv.put(TRANSFER_ENDS_NS, id, { node, cancel: cancel || was?.cancel === true, until: this.now() + TRANSFER_END_MS } satisfies TransferEnd);
  }

  /** What was asked of `node`'s transfers, taken from the store: it is back. */
  take(node: string): { id: string; cancel: boolean }[] {
    const at = this.now();
    const taken: { id: string; cancel: boolean }[] = [];
    for (const id of this.kv.list(TRANSFER_ENDS_NS)) {
      const v = this.kv.get(TRANSFER_ENDS_NS, id) as TransferEnd | undefined;
      if (!v) continue;
      if (v.until > at && v.node !== node) continue;
      this.kv.delete(TRANSFER_ENDS_NS, id);
      if (v.until > at) taken.push({ id, cancel: v.cancel });
    }
    return taken;
  }
}

/**
 * What the primary sent each hands node: the machine and path of every transfer it forwarded
 * to one, which that node may then pull and nothing else. Kept in the store, so a restarted or
 * a backup primary still serves a transfer that waits; forgotten once it ends, or after a week.
 */
export class HandsPulls {
  private kv: Store["kv"];
  private now: () => number;

  constructor(kv: Store["kv"], now: () => number = Date.now) {
    this.kv = kv;
    this.now = now;
  }

  /** The primary forwarded `t` to hands node `hands`: its source may be pulled. */
  sent(hands: string, t: Pick<Transfer, "id" | "from">): void {
    this.kv.put(HANDS_PULLS_NS, t.id, { hands, node: t.from.node, path: t.from.path, until: this.now() + HANDS_PULL_MS } satisfies HandsPull);
  }

  /** A retry: the transfer is pulled again, for another week. */
  renew(id: string): void {
    const v = this.kv.get(HANDS_PULLS_NS, id) as HandsPull | undefined;
    if (v) this.kv.put(HANDS_PULLS_NS, id, { ...v, until: this.now() + HANDS_PULL_MS });
  }

  /** It ended, or was dismissed: nothing of it is pulled again. */
  ended(id: string): void {
    this.kv.delete(HANDS_PULLS_NS, id);
  }

  /** Whether hands node `hands` was sent `path` on `node`. */
  allows(hands: string, node: string, path: string): boolean {
    const at = this.now();
    for (const id of this.kv.list(HANDS_PULLS_NS)) {
      const v = this.kv.get(HANDS_PULLS_NS, id) as HandsPull | undefined;
      if (!v) continue;
      if (v.until <= at) {
        this.kv.delete(HANDS_PULLS_NS, id);
        continue;
      }
      if (v.hands === hands && v.node === node && v.path === path) return true;
    }
    return false;
  }
}

export interface TransferLinkDeps {
  selfId: () => string;
  gate: Gate;
  pipes: () => PipeHub | undefined;
  /** Carries a request on toward `node`: only the primary can, to a secondary linked to it. */
  carry: (node: string, method: string, params: unknown, opts: { timeoutMs?: number }) => Promise<unknown>;
  /** A node's row, as the registry has it. */
  row: (node: string) => NodeRecord | undefined;
  /** This node's own walks, kept for their next pages. */
  trees: TreeCache;
  /** Refuses a path outside the folders this node shares, when it shares some alone. */
  require?: () => ((path: string) => void) | undefined;
  /** Whether this node sends files at all. */
  sends: () => boolean;
  /** On the primary: whether hands node `hands` was sent `path` on `node`, which it may then pull. */
  handsPull?: (hands: string, node: string, path: string) => boolean;
  /** The node on the link is this node's primary, let work here unasked at the join. */
  trusted?: (node: string) => boolean;
  log: Logger;
  now?: () => number;
}

/** What a listing's audit row keeps: how much, not the names. */
function treeSummary(r: unknown): unknown {
  const p = r as TreePage;
  return { kind: p.kind, name: p.name, entries: p.entries.length, count: p.count, total: p.total, files: p.files, skipped: p.skipped };
}

export class TransferLinks {
  private deps: TransferLinkDeps;
  /** Paths a link was let read, by `<link> <path>`, until when. */
  private allowed = new Map<string, number>();

  constructor(deps: TransferLinkDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async request(from: TransferFrom, method: string, params: unknown): Promise<unknown> {
    const self = this.deps.selfId();
    switch (method) {
      case "files.tree": {
        const parsed = nodeLinkRequests["files.tree"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad files.tree", parsed.error.issues);
        const p = parsed.data;
        this.handsMay(from, p.node, p.path);
        if (p.node !== self) {
          this.carriable(p.node);
          return this.deps.carry(p.node, method, p, { timeoutMs: TREE_TIMEOUT_MS });
        }
        this.sending();
        const require = this.deps.require?.();
        // a later page of a listing the link was let read is the same walk's
        if (p.from && this.isAllowed(from, p.path)) return this.deps.trees.page(p.path, p.from, require ? { require } : {});
        const page = await this.gated(from, "files.tree", p.path, p, () => this.deps.trees.page(p.path, p.from, require ? { require } : {}), treeSummary);
        this.allow(from, p.path);
        return page;
      }
      case "files.pipe.open": {
        const parsed = nodeLinkRequests["files.pipe.open"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad files.pipe.open", parsed.error.issues);
        const p = parsed.data;
        this.handsMay(from, p.node, p.path);
        const pipes = this.deps.pipes();
        if (!pipes) throw new RpcError("unsupported", "this node carries no pipes");
        const target = { kind: "file" as const, path: p.path, ...(p.rel !== undefined ? { rel: p.rel } : {}), at: p.at };
        if (p.node !== self) this.carriable(p.node);
        else {
          this.sending();
          if (!this.isAllowed(from, p.path)) {
            await this.gated(from, "files.pipe.open", p.path, { path: p.path, ...(p.rel !== undefined ? { rel: p.rel } : {}), at: p.at }, () => undefined);
            this.allow(from, p.path);
          }
        }
        try {
          return await pipes.openForLink(from.id, p, target);
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
        }
      }
      default:
        throw new RpcError("unsupported", `${method} is not a transfer request`);
    }
  }

  private gated<T>(from: LinkFrom, action: "files.tree" | "files.pipe.open", target: string, args: unknown, handler: () => Promise<T> | T, redactResult?: (r: unknown) => unknown): Promise<T> {
    return this.deps.gate.run(
      {
        principal: { kind: "node", id: from.id },
        action,
        target,
        args,
        sessionKey: from.sessionKey,
        ...(this.deps.trusted?.(from.id) ? { trusted: true } : {}),
        ...(redactResult ? { redactResult } : {}),
      },
      handler,
    );
  }

  /** This node sends files. */
  private sending(): void {
    if (!this.deps.sends()) throw new RpcError("denied", "this machine sends no files");
  }

  /** A hands node pulls only what the primary sent it. */
  private handsMay(from: TransferFrom, node: string, path: string): void {
    if (from.hands && !this.deps.handsPull?.(from.id, node, path)) throw new RpcError("denied", "a hands node pulls only what its primary sent it");
  }

  /** A node a transfer may be carried to: one of this user's that sends files. */
  private carriable(node: string): void {
    const row = this.deps.row(node);
    if (!row) throw new RpcError("not_found", `no node ${node}`);
    if (row.scope.kind === "workspaces" && row.hands) throw new RpcError("denied", `${row.name} lends folders of another person's machine: it sends no files`);
    if (!row.capabilities.files) throw new RpcError("unsupported", `${row.name} runs an older Cophyla: update it to send files`);
  }

  private key(from: LinkFrom, path: string): string {
    return `${from.sessionKey} ${path}`;
  }

  private isAllowed(from: LinkFrom, path: string): boolean {
    const until = this.allowed.get(this.key(from, path));
    return until !== undefined && until > this.now();
  }

  private allow(from: LinkFrom, path: string): void {
    const at = this.now();
    for (const [k, until] of this.allowed) if (until <= at) this.allowed.delete(k);
    this.allowed.set(this.key(from, path), at + ALLOWED_MS);
  }
}

/** How long a file's pipe may take to open, hop by hop: as long as a stream's. */
export const FILE_PIPE_OPEN_TIMEOUT_MS = PIPE_OPEN_TIMEOUT_MS;
