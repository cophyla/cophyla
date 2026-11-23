// Ports across the links, for a device of the user's that opens a machine's localhost: the
// share (`port.share`), its end (`port.unshare`) and its pipes (`port.pipe.open`, then `pipe.*`
// frames as a stream page's go). A request for this machine is served here: the share gated as
// the node on the link, unasked by default (the user opened it from their own device; a rule
// may still ask or deny), with the machine it is for as the primary vouches: the node on the
// link it came from, which the primary sets on every share and pipe it carries on, over what a
// secondary said. A request for another machine the primary carries on to it, and a pipe it
// joins from one link to the next.
//
// A port opens on the user's own machines alone, each sharing the whole machine: never one that
// lends some folders, a hands node either way, or a machine at its sign-in door (which is
// carried nothing but its desktop). And only where every link it crosses goes straight between
// the two machines, on the network or a data channel of their own, never through the relay:
// each node on the way checks the links it holds.

import { nodeLinkRequests, RpcError } from "@cophyla/protocol";
import type { Ask, NodeRecord } from "@cophyla/protocol";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { PipeHub } from "../remote/pipes.ts";
import type { Ports } from "../remote/ports.ts";
import { relayWords } from "../remote/ports.ts";
import type { LinkFrom } from "./streams.ts";
import { PIPE_OPEN_TIMEOUT_MS } from "./streams.ts";

export const PORT_LINK_REQUESTS: ReadonlySet<string> = new Set(["port.share", "port.unshare", "port.pipe.open"]);

/** How long a share may take to be answered, hop by hop: its host looks at what listens first. */
export const SHARE_TIMEOUT_MS = 15_000;
export { PIPE_OPEN_TIMEOUT_MS };

/** The node on the link a port request came from; `hands` when it joined as hands. */
export interface PortFrom extends LinkFrom {
  hands?: boolean;
}

export interface PortLinkDeps {
  selfId: () => string;
  /** This node is the primary: requests come from its secondaries, and what it carries on it vouches for. */
  primary: () => boolean;
  gate: Gate;
  ports: () => Ports | undefined;
  pipes: () => PipeHub | undefined;
  /** Carries a request on toward `node`: only the primary can, to a secondary linked to it. */
  carry: (node: string, method: string, params: unknown, opts: { timeoutMs?: number; onPending?: (ask: Ask) => void }) => Promise<unknown>;
  /** A node's row, as the registry has it. */
  row: (node: string) => NodeRecord | undefined;
  /** Whether the link between this node and `node` carries its frames straight, not through the relay. */
  straight: (node: string) => boolean;
  /** The node on the link is this node's primary, let work here unasked at the join. */
  trusted?: (node: string) => boolean;
  log: Logger;
}

export class PortLinks {
  private deps: PortLinkDeps;

  constructor(deps: PortLinkDeps) {
    this.deps = deps;
  }

  /** The machine a request is for, as this node may believe it: on the primary the node on the link, on a secondary what the primary said. */
  private viewerOf(from: PortFrom, said: string | undefined): string {
    if (this.deps.primary()) return from.id;
    return said ?? from.id;
  }

  async request(from: PortFrom, method: string, params: unknown, onPending?: (ask: Ask) => void): Promise<unknown> {
    const self = this.deps.selfId();
    // a hands node reaches no other machine, and nothing of the user's reaches into it this way
    if (from.hands) throw new RpcError("denied", "a hands node opens no port on another machine");
    switch (method) {
      case "port.share": {
        const parsed = nodeLinkRequests["port.share"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad port.share", parsed.error.issues);
        const p = parsed.data;
        const viewer = this.viewerOf(from, p.viewer);
        this.mustBeStraight(from.id, p.node);
        if (p.node !== self) {
          this.carriable(p.node);
          return this.deps.carry(p.node, method, { ...p, viewer }, { timeoutMs: SHARE_TIMEOUT_MS, ...(onPending ? { onPending } : {}) });
        }
        const ports = this.ports();
        return this.deps.gate.run(
          {
            principal: { kind: "node", id: from.id },
            action: "port.share",
            target: String(p.port),
            args: { port: p.port, viewer, ...(p.name !== undefined ? { name: p.name } : {}) },
            sessionKey: from.sessionKey,
            ...(this.deps.trusted?.(from.id) ? { trusted: true } : {}),
          },
          () => ports.share({ port: p.port, viewer, ...(p.name !== undefined ? { name: p.name } : {}), link: from.id }),
          onPending ? { onPending } : {},
        );
      }
      case "port.unshare": {
        const parsed = nodeLinkRequests["port.unshare"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad port.unshare", parsed.error.issues);
        const p = parsed.data;
        const viewer = this.viewerOf(from, p.viewer);
        if (p.node !== self) return this.deps.carry(p.node, method, { ...p, viewer }, {});
        const ports = this.ports();
        return this.deps.gate.run(
          { principal: { kind: "node", id: from.id }, action: "port.unshare", target: p.share, args: { share: p.share, viewer }, sessionKey: from.sessionKey, ...(this.deps.trusted?.(from.id) ? { trusted: true } : {}) },
          () => ports.unshare(p.share, viewer),
        );
      }
      case "port.pipe.open": {
        const parsed = nodeLinkRequests["port.pipe.open"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad port.pipe.open", parsed.error.issues);
        const p = parsed.data;
        const pipes = this.deps.pipes();
        if (!pipes) throw new RpcError("unsupported", "this node carries no pipes");
        if (p.node !== self) this.carriable(p.node);
        try {
          return await pipes.openForLink(from.id, p, { kind: "port", share: p.share, viewer: this.viewerOf(from, p.viewer) });
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
        }
      }
      default:
        throw new RpcError("unsupported", `${method} is not a port request`);
    }
  }

  /** The link to `node` went (`primary`: this node's link to its primary): the shares asked on it end, and the ports opened over it close. */
  gone(node: string, primary: boolean): void {
    this.deps.ports()?.linkGone(node, primary);
  }

  private ports(): Ports {
    const ports = this.deps.ports();
    if (!ports) throw new RpcError("unsupported", "this machine shares no ports");
    return ports;
  }

  /** The links a share crosses here go straight: the one it came on, and on the primary the one it goes on. */
  private mustBeStraight(from: string, node: string): void {
    const host = this.deps.row(node)?.name ?? "that machine";
    const viewer = this.deps.row(from)?.name ?? "that machine";
    if (!this.deps.straight(from)) throw new RpcError("unavailable", relayWords(host, viewer));
    if (node !== this.deps.selfId() && !this.deps.straight(node)) throw new RpcError("unavailable", relayWords(host, viewer));
  }

  /** A machine a port may be carried to: one of this user's, sharing the whole machine, with a Cophyla that shares ports. */
  private carriable(node: string): void {
    const row = this.deps.row(node);
    if (!row) throw new RpcError("not_found", `no node ${node}`);
    if (row.hands) throw new RpcError("denied", `${row.name} is lent as hands: its localhost is its owner's`);
    if (row.scope.kind !== "machine") throw new RpcError("denied", `${row.name} shares some folders alone, not its localhost`);
    if (row.door) throw new RpcError("unavailable", `${row.name} is at its sign-in screen: its localhost opens once someone signs in there`);
    if (!row.capabilities.ports) throw new RpcError("unsupported", `Update Cophyla on ${row.name} to open its localhost from here`);
  }
}
