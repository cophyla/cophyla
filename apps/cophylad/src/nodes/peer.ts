// One end of a node link: the `RpcPeer` over the socket plus what the handshake settled
// about the other side. On the primary a `NodePeer` stands for a linked secondary; on a
// secondary, for the primary. Heartbeats are the secondary's: it sends one every
// `heartbeat_ms` and the primary answers; either side counts two misses as the link gone.

import type { Node } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { RpcPeer, RequestOptions } from "../rpc/peer.ts";

export interface NodePeerInfo {
  linkId: string;
  node: Node;
  epoch: number;
  backup: boolean;
  rank?: number;
  endpoints: string[];
  /** On the primary: the grant the node linked with, and whether it is hands only. */
  grant?: string;
  hands?: boolean;
}

export class NodePeer {
  readonly rpc: RpcPeer;
  readonly info: NodePeerInfo;
  private log: Logger;
  private closeSocket: (code: number, reason: string) => void | Promise<void>;
  private closed = false;
  private onClosed?: (reason: string) => void;
  /** The last moment the other side was heard from. */
  lastHeard: number;
  private missed = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(rpc: RpcPeer, info: NodePeerInfo, opts: { log: Logger; closeSocket: (code: number, reason: string) => void | Promise<void>; now?: number }) {
    this.rpc = rpc;
    this.info = info;
    this.log = opts.log;
    this.closeSocket = opts.closeSocket;
    this.lastHeard = opts.now ?? Date.now();
  }

  get id(): string {
    return this.info.node.id;
  }

  get open(): boolean {
    return !this.closed && this.rpc.open;
  }

  heard(now = Date.now()): void {
    this.lastHeard = now;
    this.missed = 0;
  }

  request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
    return this.rpc.request(method, params, opts);
  }

  notify(method: string, params?: unknown): boolean {
    return this.rpc.notify(method, params);
  }

  /**
   * Watches the link: `probe` runs every `intervalMs` (a heartbeat request on the secondary,
   * a silence check on the primary); two misses close the link.
   */
  watch(intervalMs: number, probe: () => Promise<boolean>): void {
    const tick = async () => {
      if (!this.open) return;
      let ok = false;
      try {
        ok = await probe();
      } catch {
        ok = false;
      }
      if (!this.open) return;
      if (ok) this.missed = 0;
      else if (++this.missed >= 2) {
        this.log.warn("node link lost: no heartbeat", { node: this.id, missed: this.missed });
        this.close(4408, "heartbeat missed");
        return;
      }
      this.timer = setTimeout(() => void tick(), intervalMs);
      if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    };
    this.timer = setTimeout(() => void tick(), intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  /** Called once, when the link is gone for any reason. */
  onClose(handler: (reason: string) => void): void {
    this.onClosed = handler;
  }

  /** Closes the link from this side; `closed()` is what the socket's close calls. Settles once the socket has closed, as far as it can tell. */
  close(code = 1000, reason = "closed"): Promise<void> {
    if (this.closed) return Promise.resolve();
    const done = this.closeSocket(code, reason);
    this.closedBy(reason);
    return Promise.resolve(done);
  }

  /** The socket went: rejects what is in flight and tells the owner, once. */
  closedBy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.rpc.close(reason);
    this.onClosed?.(reason);
  }
}
