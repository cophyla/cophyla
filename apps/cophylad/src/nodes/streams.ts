// Streams across the links, for a viewer on a node with no route to the desktop it shows:
// the stream page's ticket (`remote.ticket`), its end (`remote.close`) and its pipes
// (`remote.pipe.open`, then `pipe.*` frames). A request for this node is served here, the
// ticket through the gate as the node on the link with the pairing's words, since it gives
// the screen and the input; the viewer is filed under that node, so the link going takes
// the viewer's sessions with it. A request for another node the primary carries on to it
// (the host gates it, the primary does not), and a pipe the primary joins from one link to
// the next. Both ends of a link share this.

import { nodeLinkFrames, nodeLinkRequests, RpcError } from "@cophyla/protocol";
import type { Ask } from "@cophyla/protocol";
import { pairAsk } from "../api/methods.ts";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { PipeHub } from "../remote/pipes.ts";
import type { Remote } from "../remote/index.ts";

export const STREAM_LINK_REQUESTS: ReadonlySet<string> = new Set(["remote.ticket", "remote.pipe.open", "remote.close"]);
export const PIPE_FRAMES: ReadonlySet<string> = new Set(["pipe.data", "pipe.ack", "pipe.close"]);

/** How long a ticket may take: the host may ask its owner first. */
export const TICKET_TIMEOUT_MS = 180_000;
/** How long a pipe may take to open, hop by hop. */
export const PIPE_OPEN_TIMEOUT_MS = 15_000;

export interface StreamLinkDeps {
  selfId: () => string;
  gate: Gate;
  remote: () => Remote | undefined;
  pipes: () => PipeHub | undefined;
  /** Carries a request on toward `node`: only the primary can, to a secondary linked to it. */
  carry: (node: string, method: string, params: unknown, opts: { timeoutMs?: number; onPending?: (ask: Ask) => void }) => Promise<unknown>;
  log: Logger;
}

/** The node on the other end of the link a request came on. */
export interface LinkFrom {
  id: string;
  /** The link id: the gate's session key. */
  sessionKey: string;
}

export class StreamLinks {
  private deps: StreamLinkDeps;

  constructor(deps: StreamLinkDeps) {
    this.deps = deps;
  }

  /** Where a viewer on another node is filed here: under the node on the link. */
  static viewerKey(from: string, viewer: string): string {
    return `${from}:${viewer}`;
  }

  async request(from: LinkFrom, method: string, params: unknown, onPending?: (ask: Ask) => void): Promise<unknown> {
    const self = this.deps.selfId();
    switch (method) {
      case "remote.ticket": {
        const parsed = nodeLinkRequests["remote.ticket"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad remote.ticket", parsed.error.issues);
        const p = parsed.data;
        if (p.node !== self) return this.deps.carry(p.node, method, p, { timeoutMs: TICKET_TIMEOUT_MS, ...(onPending ? { onPending } : {}) });
        const remote = this.deps.remote();
        if (!remote) throw new RpcError("unsupported", "this node has no remote module");
        const name = p.name ?? "a viewer on another node";
        return this.deps.gate.run(
          { principal: { kind: "node", id: from.id }, action: "remote.ticket", target: name, args: p, risk: "exec", sessionKey: from.sessionKey, ask: pairAsk(name) },
          () => remote.ticket(StreamLinks.viewerKey(from.id, p.viewer), p.name, p.transport, p.lowLatency ? { lowLatency: true } : {}),
          onPending ? { onPending } : {},
        );
      }
      case "remote.close": {
        const parsed = nodeLinkRequests["remote.close"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad remote.close", parsed.error.issues);
        const p = parsed.data;
        if (p.node !== self) return this.deps.carry(p.node, method, p, {});
        this.deps.remote()?.closeTicket(p.stream, StreamLinks.viewerKey(from.id, p.viewer));
        return {};
      }
      case "remote.pipe.open": {
        const parsed = nodeLinkRequests["remote.pipe.open"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad remote.pipe.open", parsed.error.issues);
        const pipes = this.deps.pipes();
        if (!pipes) throw new RpcError("unsupported", "this node carries no pipes");
        try {
          return await pipes.openForLink(from.id, parsed.data);
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
        }
      }
      default:
        throw new RpcError("unsupported", `${method} is not a stream request`);
    }
  }

  /** A pipe frame from the node on the link. */
  frame(from: string, method: string, params: unknown): void {
    const pipes = this.deps.pipes();
    if (!pipes || !PIPE_FRAMES.has(method)) return;
    const source = `link:${from}`;
    if (method === "pipe.data") {
      const p = nodeLinkFrames["pipe.data"].safeParse(params);
      if (p.success) pipes.data(source, p.data.pipe, p.data.data);
    } else if (method === "pipe.ack") {
      const p = nodeLinkFrames["pipe.ack"].safeParse(params);
      if (p.success) pipes.ack(source, p.data.pipe, p.data.bytes);
    } else {
      const p = nodeLinkFrames["pipe.close"].safeParse(params);
      if (p.success) pipes.closed(source, p.data.pipe, p.data.reason);
    }
  }

  /** The link to `node` went: its pipes close, and the sessions its viewers opened here end. */
  gone(node: string): void {
    this.deps.pipes()?.gone(`link:${node}`);
    this.deps.remote()?.linkGone(node);
  }
}
