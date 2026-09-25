// A fake cophyla-net: the helper's side of the stdio protocol, in process. `hello` answers the
// protocol it is told to, `net.configure` takes the asked port (or the next free one) unless
// the test marked it taken, and `net.state` follows. A test crashes it with a line on its
// stderr, reads what cophylad asked and told it, and plays the peers: an offer or an answer is
// a fake SDP naming the peer, and `open` / `data` / `close` are the channel's events. Two
// fakes on one `FakeWire` join their channels: an offer on one answered on the other opens
// both once accepted, what one side sends the other hears, and a side that goes (closed, or
// its helper gone) leaves the other failed, as ICE would say it.

import { RpcError } from "@cophyla/protocol";
import type { HelperProcess, HelperSpawner, SpawnOptions } from "../../src/direct/helper.ts";

let nextPid = 70_000;

type End = { helper: FakeHelper; peer: string };

/** Joins the channels of the fakes on it. */
export class FakeWire {
  private offers = new Map<string, End>();
  private links = new Map<string, End>();
  /** No channel opens while set: a path that cannot be found. */
  blocked = false;
  /** How long ICE takes to call the far side failed. */
  failMs = 30;

  private key(e: End): string {
    return `${e.helper.pid}:${e.peer}`;
  }

  offered(sdp: string, end: End): void {
    this.offers.set(sdp, end);
  }

  answered(sdp: string, end: End): boolean {
    const offerer = this.offers.get(sdp);
    if (!offerer) return false;
    this.offers.delete(sdp);
    this.links.set(this.key(offerer), end);
    this.links.set(this.key(end), offerer);
    return true;
  }

  other(end: End): End | undefined {
    return this.links.get(this.key(end));
  }

  /** The offerer accepted the answer: both ends open, and name their path. */
  accepted(end: End): void {
    const other = this.other(end);
    if (!other || this.blocked) return;
    setTimeout(() => {
      for (const e of [end, other]) {
        e.helper.emit("peer.open", { peer: e.peer });
        e.helper.emit("peer.path", { peer: e.peer, type: "srflx", local: "192.0.2.10:50000", remote: "198.51.100.20:61000", rttMs: 12 });
      }
    }, 5);
  }

  /** One side sent: the other hears it, in order. */
  carry(end: End, data: string): void {
    const other = this.other(end);
    if (!other) return;
    queueMicrotask(() => other.helper.emit("peer.data", { peer: other.peer, data }));
  }

  /** One side went: the other is failed a moment later. */
  cut(end: End, state: "closed" | "failed"): void {
    const other = this.other(end);
    this.links.delete(this.key(end));
    if (!other) return;
    this.links.delete(this.key(other));
    setTimeout(() => other.helper.emit("peer.state", { peer: other.peer, state }), this.failMs);
  }
}

export class FakeHelper implements HelperProcess {
  readonly pid = ++nextPid;
  stderr = "";
  exited = false;
  port?: number;
  /** Every request cophylad made, in order. */
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  /** Every notification cophylad sent (`peer.send`, `shutdown`), in order. */
  readonly notified: { method: string; params: Record<string, unknown> }[] = [];
  /** The peers cophylad asked for, by id: the SDP each side gave, the candidates added. */
  readonly peers = new Map<string, { role: "offer" | "answer"; remoteSdp?: string; candidates: unknown[] }>();
  private net: FakeNet;
  private opts: SpawnOptions;

  constructor(net: FakeNet, opts: SpawnOptions) {
    this.net = net;
    this.opts = opts;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.exited) throw new RpcError("unavailable", "child exited");
    const p = (params ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params: p });
    await Promise.resolve();
    switch (method) {
      case "hello":
        return { protocol: this.net.protocol, version: "0.1.0-fake" };
      case "net.configure": {
        const port = typeof p["port"] === "number" && p["port"] !== 0 ? p["port"] : this.net.nextPort++;
        if (this.net.takenPorts.has(port)) throw new RpcError("unavailable", `port ${port} is taken`);
        this.port = port;
        const addresses = [`192.0.2.10:${port}`];
        queueMicrotask(() => this.emit("net.state", { port, addresses, reflexive: [], mapping: { status: this.net.mapping, protocols: this.net.mapping === "mapped" ? ["upnp"] : [] }, ipv6: false }));
        return { port, addresses };
      }
      case "peer.offer": {
        const peer = String(p["peer"]);
        this.peers.set(peer, { role: "offer", candidates: [] });
        const sdp = `fake-offer:${peer}`;
        this.net.wire?.offered(sdp, { helper: this, peer });
        return { sdp };
      }
      case "peer.answer": {
        const peer = String(p["peer"]);
        if (typeof p["sdp"] !== "string" || !p["sdp"].startsWith("fake-offer:")) throw new RpcError("invalid", "not an offer");
        this.peers.set(peer, { role: "answer", remoteSdp: p["sdp"], candidates: [] });
        this.net.wire?.answered(p["sdp"], { helper: this, peer });
        if (this.net.wire) queueMicrotask(() => this.emit("peer.candidate", { peer, candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host" } }));
        return { sdp: `fake-answer:${peer}` };
      }
      case "peer.accept": {
        const peer = this.peers.get(String(p["peer"]));
        if (!peer) throw new RpcError("not_found", `no peer ${String(p["peer"])}`);
        peer.remoteSdp = String(p["sdp"]);
        this.net.wire?.accepted({ helper: this, peer: String(p["peer"]) });
        return {};
      }
      case "peer.candidate": {
        const peer = this.peers.get(String(p["peer"]));
        if (!peer) throw new RpcError("not_found", `no peer ${String(p["peer"])}`);
        peer.candidates.push(p["candidate"]);
        return {};
      }
      case "peer.close":
        this.peers.delete(String(p["peer"]));
        this.net.wire?.cut({ helper: this, peer: String(p["peer"]) }, "closed");
        return {};
      case "map.ports":
        return { ports: (p["ports"] as number[] | undefined) ?? [] };
      default:
        throw new RpcError("unsupported", `unsupported: ${method}`);
    }
  }

  notify(method: string, params?: unknown): boolean {
    if (this.exited) return false;
    const p = (params ?? {}) as Record<string, unknown>;
    this.notified.push({ method, params: p });
    if (method === "shutdown") this.exit(0, null);
    if (method === "peer.send" && typeof p["data"] === "string") this.net.wire?.carry({ helper: this, peer: String(p["peer"]) }, p["data"]);
    return true;
  }

  async stop(): Promise<void> {
    this.exit(0, null);
    await Promise.resolve();
  }

  kill(): void {
    this.exit(null, "SIGTERM");
  }

  /** The helper dies on its own, having said `line` last. */
  crash(line = JSON.stringify({ level: "error", msg: "bind failed: address in use" })): void {
    this.stderr += `${line}\n`;
    this.exit(101, null);
  }

  /** A notification from the helper to cophylad. */
  emit(method: string, params: unknown): void {
    if (!this.exited) this.opts.onNotification(method, params);
  }

  private exit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    // every channel it held goes with it: the far ends are failed
    for (const peer of this.peers.keys()) this.net.wire?.cut({ helper: this, peer }, "failed");
    queueMicrotask(() => this.opts.onExit(code, signal));
  }
}

export class FakeNet {
  readonly helpers: FakeHelper[] = [];
  /** The wire this fake's channels are joined on, when a test has two. */
  wire?: FakeWire;
  protocol = 1;
  nextPort = 50_000;
  readonly takenPorts = new Set<number>();
  mapping: "off" | "probing" | "none" | "mapped" = "none";
  /** Set, every spawn throws it: a binary that will not start. */
  failSpawn?: string;

  readonly spawn: HelperSpawner = (opts) => {
    if (this.failSpawn) throw new Error(this.failSpawn);
    const h = new FakeHelper(this, opts);
    this.helpers.push(h);
    return h;
  };

  /** The helper running now. */
  get live(): FakeHelper | undefined {
    return [...this.helpers].reverse().find((h) => !h.exited);
  }
}
