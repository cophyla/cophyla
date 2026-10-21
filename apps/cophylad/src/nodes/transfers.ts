// Transfers across the links, for the machine a transfer goes to: what a path holds
// (`files.tree`) and a pipe of a file's bytes (`files.pipe.open`, then `pipe.*` frames as a
// stream page's go). A request for this node is served here, gated as the node on the link
// (a read: the primary's own, unasked where this machine trusted it at the join), within the
// folders a confined node shares; a pipe is gated once per path a while, so the files of one
// folder make one audit row and not one each. A request for another node the primary
// carries on to it, a listing forwarded and a pipe joined from one link to the next, never to
// a hands node or one that sends no files. Both ends of a link share this.

import { nodeLinkRequests, RpcError } from "@cophyla/protocol";
import type { NodeRecord } from "@cophyla/protocol";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { PipeHub } from "../remote/pipes.ts";
import { TREE_TIMEOUT_MS } from "../transfers/index.ts";
import type { TreeCache, TreePage } from "../transfers/tree.ts";
import type { LinkFrom } from "./streams.ts";
import { PIPE_OPEN_TIMEOUT_MS } from "./streams.ts";

export const FILE_LINK_REQUESTS: ReadonlySet<string> = new Set(["files.tree", "files.pipe.open"]);

/** How long a path a link was let read stays let: about as long as a big folder takes. */
const ALLOWED_MS = 60 * 60_000;

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
  /** Whether this node sends files at all: never a hands one. */
  sends: () => boolean;
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

  async request(from: LinkFrom, method: string, params: unknown): Promise<unknown> {
    const self = this.deps.selfId();
    switch (method) {
      case "files.tree": {
        const parsed = nodeLinkRequests["files.tree"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad files.tree", parsed.error.issues);
        const p = parsed.data;
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

  /** This node sends files: a hands node never does. */
  private sending(): void {
    if (!this.deps.sends()) throw new RpcError("denied", "this machine sends no files");
  }

  /** A node a transfer may be carried to: a full member that sends files. */
  private carriable(node: string): void {
    const row = this.deps.row(node);
    if (!row) throw new RpcError("not_found", `no node ${node}`);
    if (row.hands) throw new RpcError("denied", `${row.name} joined as hands: it sends no files`);
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
