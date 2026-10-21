// Pipes: byte streams carried over the node links. A stream page's TCP connections ride them
// between the viewer and the node whose desktop it shows, when there is no route between
// them; a transfer's files ride them from the machine that has a file to the one that pulls
// it. A pipe joins two ends on each node it crosses: a TCP socket (on the host, to its
// loopback stream proxy; on a viewing node, from its forwarder), a client (the phone's
// `remote.pipe.*`), a node link (`pipe.*` frames), or a file (on the sending machine, read
// from where the receiver asked; on the receiving one, written where the transfer keeps it),
// and the primary joins a pipe from one link to one on another. The bytes go as base64, a
// stream's in chunks of 48 KiB with a window of 256 KiB its far side may hold unacknowledged
// at each end, a file's in chunks of 128 KiB with a window of 1 MiB (what one read brought
// past it waits here, the socket or the file paused, until acks come): a node acknowledges
// what it passed on only once the next end took it, so a slow reader slows the writer all the
// way back. A stream's bytes are acknowledged as they pass; a file's once a quarter of its
// window passed, or a moment after the last that came, since through the relay every ack is a
// message the account pays for. A link carries at most 1 MiB for all its pipes together, so a
// pipe cannot starve the link's own frames, nor, through the relay, run past what its buffers
// hold.

import { randomBytes } from "node:crypto";
import type { Socket } from "bun";
import type { Logger } from "../log.ts";

export const PIPE_WINDOW = 256 * 1024;
export const PIPE_CHUNK = 48 * 1024;
export const LINK_WINDOW = 1024 * 1024;
/**
 * A file's pipe: as much in flight as the link allows, in chunks that keep the relay's messages
 * few, its acks one for a quarter of the window. A chunk stays at 128 KiB: base64'd and sealed
 * it is about 180 KB, under the 256 KiB a data channel's message may be.
 */
export const FILE_PIPE_WINDOW = LINK_WINDOW;
export const FILE_PIPE_CHUNK = 128 * 1024;
export const FILE_PIPE_ACK = FILE_PIPE_WINDOW / 4;
/** How long bytes taken wait for more before they are acknowledged anyway. */
const ACK_LINGER_MS = 20;

/** What a pipe reaches at its far end: a node's stream proxy, or one of its files read from `at` bytes in (`rel` under `path`, for a file of a folder). */
export type PipeTarget = { kind: "stream" } | FileTarget;
export interface FileTarget {
  kind: "file";
  path: string;
  rel?: string;
  at: number;
}

/** A file a pipe reads, as the sending machine found it when the pipe opened. */
export interface PipeFile {
  size: number;
  mtimeMs: number;
}

const STREAM: PipeTarget = { kind: "stream" };

/** A pipe's window, chunk, and the bytes it takes before it acknowledges them, by what it carries. */
interface PipeSizes {
  window: number;
  chunk: number;
  ack: number;
}

function sizesOf(target: PipeTarget): PipeSizes {
  return target.kind === "file" ? { window: FILE_PIPE_WINDOW, chunk: FILE_PIPE_CHUNK, ack: FILE_PIPE_ACK } : { window: PIPE_WINDOW, chunk: PIPE_CHUNK, ack: 0 };
}

/** No link leads toward the node now: the pipe may open once one does. */
export class PipeRouteError extends Error {}

/** How a remote end's frames leave: to a client as `remote.pipe.*`, or on a link as `pipe.*`. */
export interface PipeWire {
  data(pipe: string, data: string): boolean;
  ack(pipe: string, bytes: number): void;
  close(pipe: string, reason: string): void;
}

/** One side of a pipe as this node holds it. */
export interface End {
  /** Bytes toward this end's far side. */
  write(data: Uint8Array): void;
  /** Whether this end takes more now. */
  readonly room: boolean;
  /** Called when `room` came back. */
  onRoom?: () => void;
  /** Its partner has room again: what this end held back from its own far side goes on. */
  resume?(): void;
  /** The pipe is joined: an end that makes bytes of its own (a file it reads) may begin. */
  start?(): void;
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
  private window: number;
  private chunk: number;
  /** The bytes taken that make an ack go at once. */
  private ackAt: number;
  private ackTimer?: ReturnType<typeof setTimeout>;
  /** The next end had no room for the last bytes: nothing is acknowledged until it has. */
  private held = false;
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

  constructor(pipe: string, wire: PipeWire, budget: Budget, deliver: (data: Uint8Array) => boolean, sizes: PipeSizes = sizesOf(STREAM)) {
    this.pipe = pipe;
    this.wire = wire;
    this.budget = budget;
    this.deliver = deliver;
    this.window = sizes.window;
    this.chunk = sizes.chunk;
    this.ackAt = sizes.ack;
  }

  /** Whether this end takes more now: nothing waits, and the window and the link have room. */
  get room(): boolean {
    return !this.closed && this.pendingBytes === 0 && this.inflight < this.window && this.budget.inflight < LINK_WINDOW;
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
      const space = Math.min(this.window - this.inflight, LINK_WINDOW - this.budget.inflight, this.chunk);
      if (space <= 0) {
        if (this.inflight < this.window) this.budget.waiting.add(this);
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

  /** Bytes from the far side: passed on, and acknowledged once the next end took them, a file's a quarter window at a time. */
  received(base64: string): void {
    if (this.closed) return;
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    const took = this.deliver(bytes);
    this.owed += bytes.length;
    this.held = !took;
    if (!took) return;
    if (this.owed >= this.ackAt) this.settle();
    else this.ackTimer ??= setTimeout(() => {
      this.ackTimer = undefined;
      if (!this.held) this.settle();
    }, ACK_LINGER_MS);
  }

  /** The next end has room: what was taken is acknowledged. */
  settle(): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.owed === 0 || this.closed) return;
    const n = this.owed;
    this.owed = 0;
    this.wire.ack(this.pipe, n);
  }

  resume(): void {
    this.held = false;
    this.settle();
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
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
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

  resume(): void {
    this.socket?.resume();
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
  /** `files.pipe.open` on the link to `hop`: what the far side answers of the file. */
  openFileOnLink?: (hop: string, params: { node: string; pipe: string; path: string; rel?: string; at: number }) => Promise<{ window: number } & PipeFile>;
  /**
   * One of this node's files as a pipe's far end, its bytes going to `deliver`, which says
   * whether there is room for more; `gone` closes the pipe from that end (a read that failed).
   */
  openFile?: (target: FileTarget, deliver: (data: Uint8Array) => boolean, gone: (end: End, reason: string) => void) => Promise<{ end: End; file: PipeFile }>;
  log: Logger;
  connect?: typeof Bun.connect;
}

/** A pipe's far end, the keys its remote ends are filed under, and the file it reads, when it does. */
interface Far {
  end: End;
  keys: string[];
  file?: PipeFile;
}

/** A pipe from a file of a node's to an end of this node's: the file as it was found, and how to close the pipe from here. */
export interface FilePipe {
  file: PipeFile;
  close(reason: string): void;
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

  /**
   * A link's `remote.pipe.open`, or its `files.pipe.open` (`target` the file), from `from`,
   * for `node`: served here, or carried on toward it. A file's pipe answers the file as it is.
   */
  async openForLink(from: string, params: { node: string; pipe: string }, target: PipeTarget = STREAM): Promise<{ window: number; size?: number; mtimeMs?: number }> {
    const wire = this.deps.linkWire(from);
    if (!wire) throw new Error(`no link to ${from}`);
    // never back the way it came: a secondary asked by its primary for a node it is not
    if (params.node !== this.deps.selfId() && this.deps.nextHop(params.node) === from) throw new Error(`no route to ${params.node} from here`);
    const file = await this.openPipe(`link:${from}`, wire, this.budget(`link:${from}`), params.pipe, params.node, target);
    return { window: sizesOf(target).window, ...(file ? { size: file.size, mtimeMs: file.mtimeMs } : {}) };
  }

  /**
   * A pipe from a file of `node`'s (this node's too) to `near`, an end of this node's that
   * takes its bytes: what a transfer pulls with. Resolves once the far side found the file,
   * with what it found; `near` is closed with the pipe, from either side.
   */
  async openForFile(node: string, target: FileTarget, near: End): Promise<FilePipe> {
    const id = `t_${randomBytes(8).toString("hex")}`;
    const far = await this.towards(node, target, (data) => {
      near.write(data);
      return near.room;
    });
    const joined = this.join(id, near, far.end, far.keys);
    far.end.start?.();
    return {
      file: far.file ?? { size: 0, mtimeMs: 0 },
      close: (reason) => this.close(joined, reason, near),
    };
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
    const far = await this.towards(node, STREAM, (data) => {
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

  /** The pipe's near end (a client or a link) and its far end toward `node`, joined; the file it reads, when it does. */
  private async openPipe(source: string, wire: PipeWire, budget: Budget, pipe: string, node: string, target: PipeTarget = STREAM): Promise<PipeFile | undefined> {
    const key = `${source}:${pipe}`;
    if (this.remote.has(key)) throw new Error(`pipe ${pipe} is open already`);
    let far: Far | undefined;
    const near = new RemoteEnd(
      pipe,
      wire,
      budget,
      (data) => {
        if (!far) return false;
        far.end.write(data);
        return far.end.room;
      },
      sizesOf(target),
    );
    far = await this.towards(node, target, (data) => {
      near.write(data);
      return near.room;
    });
    const joined = this.join(pipe, near, far.end, [key, ...far.keys]);
    this.remote.set(key, { end: near, joined });
    far.end.start?.();
    return far.file;
  }

  /** The far end toward `node`: this node's loopback proxy or one of its files, or the link that leads there. */
  private async towards(node: string, target: PipeTarget, deliver: (data: Uint8Array) => boolean): Promise<Far> {
    if (node === this.deps.selfId() && target.kind === "file") {
      if (!this.deps.openFile) throw new Error("this node sends no files");
      const opened = await this.deps.openFile(target, deliver, (end, reason) => this.endClosed(end, reason));
      return { end: opened.end, keys: [], file: opened.file };
    }
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
    if (!hop || !wire) throw new PipeRouteError(`no link toward ${node}`);
    const pipe = `p_${randomBytes(8).toString("hex")}`;
    const key = `link:${hop}:${pipe}`;
    const end = new RemoteEnd(pipe, wire, this.budget(`link:${hop}`), deliver, sizesOf(target));
    // filed before the far side answers: its first bytes can come with the answer
    this.remote.set(key, { end, joined: { id: pipe, ends: [end, end], keys: [key], closed: false } });
    try {
      if (target.kind === "file") {
        if (!this.deps.openFileOnLink) throw new Error("this node carries no files");
        const a = await this.deps.openFileOnLink(hop, { node, pipe, path: target.path, ...(target.rel !== undefined ? { rel: target.rel } : {}), at: target.at });
        return { end, keys: [key], file: { size: a.size, mtimeMs: a.mtimeMs } };
      }
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
    end.resume?.();
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
