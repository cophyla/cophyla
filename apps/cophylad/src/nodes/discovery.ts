// Finding the primary on one network: a UDP socket on the discovery port with `reuseAddr`
// (two homes on one machine share it) and broadcast on. A seeker sends a query to every
// interface's subnet broadcast and to 255.255.255.255; a primary answers it by unicast and
// beacons on its own every `beacon_ms`. Datagrams are small JSON naming the cluster (its
// random id, no secret), the node, its listener port, its epoch and role; a foreign cluster
// is ignored, and what a datagram names is acted on only once a probe completed a sealed link
// with this node's own key. Spike 13 measured the whole thing, WSL included. The transport is
// a seam: `udpTransport` for real, `MemoryLan` for the tests.

import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { NodeRole } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export interface Datagram {
  cophyla: 1;
  /** query, answer, beacon */
  t: "q" | "a" | "b";
  cluster: string;
  nonce?: string;
  nodeId: string;
  name: string;
  /** The node's LAN listener port; 0 for a seeker. */
  port: number;
  epoch: number;
  role: NodeRole;
}

export interface Remote {
  address: string;
  port: number;
}

export interface DiscoverySocket {
  port: number;
  send(msg: Datagram, port: number, host: string): void;
  broadcast(msg: Datagram, port: number): void;
  close(): void;
}

export interface DiscoveryTransport {
  open(opts: { port: number; onMessage: (msg: Datagram, from: Remote) => void; log?: Logger }): Promise<DiscoverySocket>;
}

const MAX_DATAGRAM = 512;

/** Every IPv4 interface's subnet broadcast, plus the limited broadcast. */
export function broadcastAddresses(): string[] {
  const out = new Set<string>(["255.255.255.255"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const ip = i.address.split(".").map(Number);
      const mask = i.netmask.split(".").map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((b, k) => (b & mask[k]!) | (~mask[k]! & 255)).join("."));
    }
  }
  return [...out];
}

export function parseDatagram(buf: Buffer | string): Datagram | undefined {
  try {
    const m = JSON.parse(typeof buf === "string" ? buf : buf.toString("utf8")) as Partial<Datagram>;
    if (m.cophyla !== 1 || (m.t !== "q" && m.t !== "a" && m.t !== "b")) return undefined;
    if (typeof m.cluster !== "string" || typeof m.nodeId !== "string" || typeof m.port !== "number") return undefined;
    return { cophyla: 1, t: m.t, cluster: m.cluster, nodeId: m.nodeId, name: typeof m.name === "string" ? m.name : "?", port: m.port, epoch: typeof m.epoch === "number" ? m.epoch : 0, role: m.role === "primary" ? "primary" : "secondary", ...(typeof m.nonce === "string" ? { nonce: m.nonce } : {}) };
  } catch {
    return undefined;
  }
}

/** `node:dgram`, since `Bun.udpSocket` has broadcast but no address reuse. EADDRINUSE falls back to an ephemeral port: a seeker can still ask; a primary is then reachable only by `[nodes] primary`. */
export function udpTransport(): DiscoveryTransport {
  return {
    open: ({ port, onMessage, log }) =>
      new Promise((resolve, reject) => {
        const bind = (p: number, retry: boolean) => {
          const sock: Socket = createSocket({ type: "udp4", reuseAddr: true });
          sock.on("error", (e) => {
            if (retry && (e as NodeJS.ErrnoException).code === "EADDRINUSE") {
              log?.warn("discovery port in use; listening on an ephemeral port instead", { port: p });
              sock.close();
              bind(0, false);
              return;
            }
            log?.warn("discovery socket error", { error: e.message });
            reject(e);
          });
          sock.on("message", (buf, rinfo) => {
            if (buf.length > MAX_DATAGRAM) return;
            const msg = parseDatagram(buf);
            if (msg) onMessage(msg, { address: rinfo.address, port: rinfo.port });
          });
          sock.bind(p, "0.0.0.0", () => {
            try {
              sock.setBroadcast(true);
            } catch (e) {
              log?.debug("setBroadcast failed", { error: e instanceof Error ? e.message : String(e) });
            }
            sock.unref();
            const bound = sock.address().port;
            resolve({
              port: bound,
              send: (msg, to, host) => sock.send(JSON.stringify(msg), to, host, () => undefined),
              broadcast: (msg, to) => {
                const text = JSON.stringify(msg);
                for (const host of broadcastAddresses()) sock.send(text, to, host, () => undefined);
              },
              close: () => {
                try {
                  sock.close();
                } catch {
                  // already closed
                }
              },
            });
          });
        };
        bind(port, true);
      }),
  };
}

/**
 * A LAN in memory, every socket at 127.0.0.1 as the daemons of a test are: a datagram to a
 * port reaches every other socket bound to it, sent or broadcast alike, which is what
 * `reuseAddr` gives two homes on one machine.
 */
export class MemoryLan implements DiscoveryTransport {
  private sockets = new Map<number, { port: number; onMessage: (msg: Datagram, from: Remote) => void }>();
  private next = 1;
  /** Every datagram seen, for the tests. */
  readonly log: { msg: Datagram; to: number }[] = [];

  open({ port, onMessage }: { port: number; onMessage: (msg: Datagram, from: Remote) => void }): Promise<DiscoverySocket> {
    const id = this.next++;
    const bound = port === 0 ? 40000 + id : port;
    this.sockets.set(id, { port: bound, onMessage });
    const deliver = (msg: Datagram, to: number) => {
      this.log.push({ msg, to });
      for (const [other, s] of this.sockets) {
        if (other === id || s.port !== to) continue;
        queueMicrotask(() => s.onMessage(msg, { address: "127.0.0.1", port: bound }));
      }
    };
    return Promise.resolve({
      port: bound,
      send: (msg, to) => deliver(msg, to),
      broadcast: (msg, to) => deliver(msg, to),
      close: () => {
        this.sockets.delete(id);
      },
    });
  }
}
