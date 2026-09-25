// Pipes: the TCP connections of a stream page, carried between the viewer and the node whose
// desktop it shows, when there is no route between them. A pipe joins two ends on each node
// it crosses: a TCP socket (on the host, to its loopback stream proxy; on a viewing node, from
// its forwarder), a client (the phone's `remote.pipe.*`), or a node link (`pipe.*` frames),
// and the primary joins a pipe from one link to one on another. The bytes go as base64 in
// chunks of 48 KiB, and each end has a window of 256 KiB its far side may hold unacknowledged
// (what one read brought past it waits here, the socket paused, until acks come): a node
// acknowledges what it passed on only once the next end took it, so a slow reader slows the
// writer all the way back. A link carries at most 1 MiB for all its pipes together, so a
// stream cannot starve the link's own frames.

import { randomBytes } from "node:crypto";
import type { Socket } from "bun";
import type { Logger } from "../log.ts";

export const PIPE_WINDOW = 256 * 1024;
export const PIPE_CHUNK = 48 * 1024;
export const LINK_WINDOW = 1024 * 1024;

/** How a remote end's frames leave: to a client as `remote.pipe.*`, or on a link as `pipe.*`. */
export interface PipeWire {
  data(pipe: string, data: string): boolean;
  ack(pipe: string, bytes: number): void;
  close(pipe: string, reason: string): void;
}

/** One side of a pipe as this node holds it. */
interface End {
  /** Bytes toward this end's far side. */
  write(data: Uint8Array): void;
  /** Whether this end takes more now. */
  readonly room: boolean;
  /** Called when `room` came back. */
  onRoom?: () => void;
  close(reason: string): void;
}

/** What a remote end's link has in flight for all its pipes. */
interface Budget {
  inflight: number;
  waiting: Set<RemoteEnd>;
}

class RemoteEnd implements End {
  onRoom?: () => void;
  readonly pipe: string;
  private wire: PipeWire;
  private budget: Budget;
  /** Where the far side's bytes go; whether the next end had room for them. */
  private deliver: (data: Uint8Array) => boolean;
  /** Bytes the far side holds and has not acknowledged. */
  private inflight = 0;
  /** Bytes for the far side that wait for the window. */
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** Bytes taken from the far side and not yet acknowledged to it: the next end had no room. */
  private owed = 0;
  closed = false;

  constructor(pipe: string, wire: PipeWire, budget: Budget, deliver: (data: Uint8Array) => boolean) {
    this.pipe = pipe;
    this.wire = wire;
    this.budget = budget;
    this.deliver = deliver;
  }

  /** Whether this end takes more now: nothing waits, and the window and the link have room. */
  get room(): boolean {
    return !this.closed && this.pendingBytes === 0 && this.inflight < PIPE_WINDOW && this.budget.inflight < LINK_WINDOW;
  }

  write(data: Uint8Array): void {
    if (this.closed || data.length === 0) return;
    this.pending.push(data);
    this.pendingBytes += data.length;
    this.pump();
  }

  /** Sends what waits, as far as the window and the link allow; waits on the link when it is what stops it. */
  private pump(): void {
    while (!this.closed && this.pending.length > 0) {
      const space = Math.min(PIPE_WINDOW - this.inflight, LINK_WINDOW - this.budget.inflight, PIPE_CHUNK);
      if (space <= 0) {
        if (this.inflight < PIPE_WINDOW) this.budget.waiting.add(this);
        return;
      }
      const head = this.pending[0]!;
      const piece = head.subarray(0, Math.min(space, head.length));
      if (piece.length < head.length) this.pending[0] = head.subarray(piece.length);
      else this.pending.shift();
      this.pendingBytes -= piece.length;
      this.inflight += piece.length;
      this.budget.inflight += piece.length;
      this.wire.data(this.pipe, Buffer.from(piece).toString("base64"));
    }
  }

  /** The far side took `bytes`: what waits goes on, and the link's other pipes get their turn. */
  acked(bytes: number): void {
    const n = Math.min(bytes, this.inflight);
    this.inflight -= n;
    this.budget.inflight = Math.max(0, this.budget.inflight - n);
    this.pump();
    if (this.room) this.onRoom?.();
    this.wakeLink();
  }

  /** The link has room again for the pipes that waited on it. */
  private wakeLink(): void {
    if (this.budget.inflight >= LINK_WINDOW) return;
    for (const other of [...this.budget.waiting]) {
      this.budget.waiting.delete(other);
      other.pump();
      if (other.room) other.onRoom?.();
    }
  }

  /** Bytes from the far side: passed on, and acknowledged once the next end took them. */
  received(base64: string): void {
    if (this.closed) return;
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    const took = this.deliver(bytes);
    this.owed += bytes.length;
    if (took) this.settle();
  }

  /** The next end has room: what was taken is acknowledged. */
  settle(): void {
    if (this.owed === 0 || this.closed) return;
    const n = this.owed;
    this.owed = 0;
    this.wire.ack(this.pipe, n);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.end();
    this.wire.close(this.pipe, reason);
  }

  /** The far side closed it: nothing goes back. */
  gone(): void {
    if (this.closed) return;
    this.end();
  }

  private end(): void {
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.budget.inflight = Math.max(0, this.budget.inflight - this.inflight);
    this.budget.waiting.delete(this);
    this.wakeLink();
  }
}

class TcpEnd implements End {
  onRoom?: () => void;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  closed = false;
  socket?: Socket<unknown>;

  get room(): boolean {
    return !this.closed && this.pendingBytes < PIPE_WINDOW;
  }

  attach(socket: Socket<unknown>): void {
    this.socket = socket;
    this.flush();
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    this.pending.push(data);
    this.pendingBytes += data.length;
    this.flush();
  }

  /** Writes what waits until the socket takes no more; its drain calls this again. */
  flush(): void {
    const s = this.socket;
    if (!s || this.closed) return;
    while (this.pending.length > 0) {
      const head = this.pending[0]!;
      const n = s.write(head);
      if (n <= 0) return;
      this.pendingBytes -= n;
      if (n < head.length) {
        this.pending[0] = head.subarray(n);
        return;
      }
      this.pending.shift();
    }
    this.onRoom?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.end();
    } catch {
      // gone already
    }
  }
}

/** A forwarder's socket joined to a pipe: its bytes in, its drain and its end. */
export interface SocketPipe {
  feed(data: Uint8Array): void;
  drain(): void;
  gone(reason: string): void;
}

interface Joined {
  id: string;
  ends: [End, End];
  /** Where each remote end is filed, to forget it with the pipe. */
  keys: string[];
  closed: boolean;
}

export interface PipeHubDeps {
  selfId: () => string;
  /** The loopback stream proxy's port, started on the first ask. */
  loopbackPort: () => number;
  /** How to reach a client, and a node link. */
  clientWire: (client: string) => PipeWire;
  linkWire: (node: string) => PipeWire | undefined;
  /** The node the link toward `node` goes to: `node` itself when linked to it, the primary otherwise; none when unreachable. */
  nextHop: (node: string) => string | undefined;
  /** `remote.pipe.open` on the link to `hop`. */
  openOnLink: (hop: string, params: { node: string; pipe: string }) => Promise<{ window: number }>;
  log: Logger;
  connect?: typeof Bun.connect;
}

export class PipeHub {
  private deps: PipeHubDeps;
  private log: Logger;
  private pipes = new Map<string, Joined>();
  /** Remote ends by `client:<id>:<pipe>` and `link:<node>:<pipe>`. */
  private remote = new Map<string, { end: RemoteEnd; joined: Joined }>();
  private budgets = new Map<string, Budget>();

  constructor(deps: PipeHubDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  /** Pipes open through this node now. */
  get count(): number {
    return this.pipes.size;
  }

  private budget(key: string): Budget {
    let b = this.budgets.get(key);
    if (!b) {
      b = { inflight: 0, waiting: new Set() };
      this.budgets.set(key, b);
    }
    return b;
  }

  // --- opening ----------------------------------------------------------------------------------

  /** A client's `remote.pipe.open`: a pipe from it to `node`'s stream proxy. */
  async openForClient(client: string, node: string | undefined): Promise<{ pipe: string; window: number }> {
    const pipe = `p_${randomBytes(8).toString("hex")}`;
    await this.openPipe(`client:${client}`, this.deps.clientWire(client), this.budget(`client:${client}`), pipe, node ?? this.deps.selfId());
    return { pipe, window: PIPE_WINDOW };
  }

  /** A link's `remote.pipe.open` from `from`, for `node`: served here, or carried on toward it. */
  async openForLink(from: string, params: { node: string; pipe: string }): Promise<{ window: number }> {
    const wire = this.deps.linkWire(from);
    if (!wire) throw new Error(`no link to ${from}`);
    // never back the way it came: a secondary asked by its primary for a node it is not
    if (params.node !== this.deps.selfId() && this.deps.nextHop(params.node) === from) throw new Error(`no route to ${params.node} from here`);
    await this.openPipe(`link:${from}`, wire, this.budget(`link:${from}`), params.pipe, params.node);
    return { window: PIPE_WINDOW };
  }

  /**
   * A connection a forwarder on this node accepted, to `node`'s stream proxy. What the
   * forwarder reads from the socket it hands to `feed` (it holds what came before this
   * resolves); the socket's drain and close go to `drain` and `gone`.
   */
  async openForSocket(socket: Socket<unknown>, node: string): Promise<SocketPipe> {
    const near = new TcpEnd();
    near.attach(socket);
    const id = `f_${randomBytes(8).toString("hex")}`;
    const far = await this.towards(node, (data) => {
      near.write(data);
      return near.room;
    });
    const joined = this.join(id, near, far.end, far.keys);
    return {
      feed: (data) => {
        if (joined.closed) return;
        far.end.write(data);
        if (!far.end.room) socket.pause();
      },
      drain: () => near.flush(),
      gone: (reason) => {
        near.closed = true;
        this.close(joined, reason, near);
      },
    };
  }

  /** The pipe's near end (a client or a link) and its far end toward `node`, joined. */
  private async openPipe(source: string, wire: PipeWire, budget: Budget, pipe: string, node: string): Promise<void> {
    const key = `${source}:${pipe}`;
    if (this.remote.has(key)) throw new Error(`pipe ${pipe} is open already`);
    let far: { end: End; keys: string[] } | undefined;
    const near = new RemoteEnd(pipe, wire, budget, (data) => {
      if (!far) return false;
      far.end.write(data);
      return far.end.room;
    });
    far = await this.towards(node, (data) => {
      near.write(data);
      return near.room;
    });
    const joined = this.join(pipe, near, far.end, [key, ...far.keys]);
    this.remote.set(key, { end: near, joined });
  }

  /** The far end toward `node`: this node's loopback proxy, or the link that leads there. */
  private async towards(node: string, deliver: (data: Uint8Array) => boolean): Promise<{ end: End; keys: string[] }> {
    if (node === this.deps.selfId()) {
      const end = new TcpEnd();
      const connect = this.deps.connect ?? Bun.connect;
      const socket = await connect({
        hostname: "127.0.0.1",
        port: this.deps.loopbackPort(),
        socket: {
          data: (_s, data) => {
            if (!deliver(new Uint8Array(data))) _s.pause();
          },
          drain: () => end.flush(),
          close: () => this.endClosed(end, "the stream proxy closed"),
          error: () => this.endClosed(end, "the stream proxy failed"),
        },
      });
      end.attach(socket as Socket<unknown>);
      return { end, keys: [] };
    }
    const hop = this.deps.nextHop(node);
    const wire = hop ? this.deps.linkWire(hop) : undefined;
    if (!hop || !wire) throw new Error(`no link toward ${node}`);
    const pipe = `p_${randomBytes(8).toString("hex")}`;
    const key = `link:${hop}:${pipe}`;
    const end = new RemoteEnd(pipe, wire, this.budget(`link:${hop}`), deliver);
    // filed before the far side answers: its first bytes can come with the answer
    this.remote.set(key, { end, joined: { id: pipe, ends: [end, end], keys: [key], closed: false } });
    try {
      await this.deps.openOnLink(hop, { node, pipe });
    } catch (e) {
      this.remote.delete(key);
      throw e;
    }
    return { end, keys: [key] };
  }

  private join(id: string, a: End, b: End, keys: string[]): Joined {
    const joined: Joined = { id, ends: [a, b], keys, closed: false };
    for (const k of keys) {
      const r = this.remote.get(k);
      if (r) r.joined = joined;
    }
    this.pipes.set(id, joined);
    // room on one side lets the other take again: a paused socket resumes, owed acks go
    a.onRoom = () => this.roomOn(b);
    b.onRoom = () => this.roomOn(a);
    return joined;
  }

  /** `end`'s partner has room again: whatever `end` held back from its own far side goes on. */
  private roomOn(end: End): void {
    if (end instanceof RemoteEnd) end.settle();
    else if (end instanceof TcpEnd) end.socket?.resume();
  }

  private endClosed(end: End, reason: string): void {
    for (const j of this.pipes.values()) if (j.ends[0] === end || j.ends[1] === end) this.close(j, reason, end);
  }

  private close(joined: Joined, reason: string, from?: End): void {
    if (joined.closed) return;
    joined.closed = true;
    this.pipes.delete(joined.id);
    for (const k of joined.keys) this.remote.delete(k);
    for (const end of joined.ends) {
      if (end === from) continue;
      end.close(reason);
    }
  }

  // --- frames -----------------------------------------------------------------------------------

  data(source: string, pipe: string, data: string): void {
    this.remote.get(`${source}:${pipe}`)?.end.received(data);
  }

  ack(source: string, pipe: string, bytes: number): void {
    this.remote.get(`${source}:${pipe}`)?.end.acked(bytes);
  }

  /** The far side of a remote end closed its pipe: the rest of the pipe closes. */
  closed(source: string, pipe: string, reason = "closed"): void {
    const r = this.remote.get(`${source}:${pipe}`);
    if (!r) return;
    r.end.gone();
    this.close(r.joined, reason, r.end);
  }

  /** A client or a link went: every pipe through it closes. */
  gone(source: string): void {
    for (const [k, r] of [...this.remote]) {
      if (!k.startsWith(`${source}:`)) continue;
      r.end.gone();
      this.close(r.joined, `${source} went`, r.end);
    }
    this.budgets.delete(source);
  }

  closeAll(reason: string): void {
    for (const j of [...this.pipes.values()]) this.close(j, reason);
  }
}
