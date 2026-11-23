// A forwarder on the viewing node's loopback, for a desktop app that reads a page of another
// node's through pipes: a stream page when there is no route to that node (the app's window
// loads `http://127.0.0.1:<port>/remote/?t=…`, each connection a pipe to the host node's
// stream proxy), or a port of that node's the user opened (`port.open`: each connection a pipe
// to the port the host shared). What a connection sends before its pipe is open waits, the
// socket paused. With no connection for a while (five minutes for a stream, ten for a port,
// whose open page keeps its live-reload socket) the forwarder closes.
//
// A port's forwarder listens where the page would be on its own machine: 127.0.0.1 and [::1],
// never another address, on the same port number when nothing here has it (so links, redirects
// and login callbacks that name the port still work), else on a free one, the same on both.
// Any program on this computer may use it while it is open, as with an SSH tunnel.

import type { Socket, TCPSocketListener } from "bun";
import type { Logger } from "../log.ts";
import type { PipeHub, PipeTarget, SocketPipe } from "./pipes.ts";

export const FORWARDER_IDLE_MS = 5 * 60_000;
/**
 * How long a port's forwarder waits with no connection before it closes: a port is open while it
 * is used, and an open dev page keeps its live-reload connection, so this is the page closed.
 */
export const PORT_IDLE_MS = 2 * 60_000;

interface Conn {
  pipe?: SocketPipe;
  early: Uint8Array[];
  closed: boolean;
}

export interface ForwarderDeps {
  hub: PipeHub;
  /** The node whose stream proxy, or whose port, the connections reach. */
  node: string;
  /** What the connections reach there: the stream proxy without it. */
  target?: PipeTarget;
  /** The port to listen on when it is free here, on both loopback addresses; any free one otherwise, on 127.0.0.1 alone without it. */
  port?: number;
  log: Logger;
  idleMs?: number;
  /** It closed: idle, or stopped. */
  onClose?: () => void;
  /** A connection opened or closed here: how many are open now. */
  onConnections?: (open: number) => void;
  /** Whether a port is free here: nothing listens on it on either loopback address. The seam the tests take. */
  free?: (port: number) => Promise<boolean>;
}

/** Whether something answers on `port` at `hostname`: a listener there, on that address or on every one. */
async function answers(hostname: string, port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname, port, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

/** Whether nothing listens on `port` here, on either loopback address. */
export async function portFree(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([answers("127.0.0.1", port), answers("::1", port)]);
  return !v4 && !v6;
}

export class Forwarder {
  private deps: ForwarderDeps;
  private listeners: TCPSocketListener<Conn>[] = [];
  private conns = new Set<Socket<Conn>>();
  private idle?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private bound?: number;

  constructor(deps: ForwarderDeps) {
    this.deps = deps;
  }

  /** The port it listens on, once started. */
  get port(): number | undefined {
    return this.bound;
  }

  /** The addresses it listens on, once started. */
  get addresses(): string[] {
    return this.listeners.map((l) => l.hostname);
  }

  /** How many connections are open through it now. */
  get connections(): number {
    return this.conns.size;
  }

  /** Starts listening on 127.0.0.1 and answers the port: a stream's forwarder. */
  start(): number {
    if (this.bound !== undefined) return this.bound;
    const l = this.listen("127.0.0.1", 0);
    this.listeners.push(l);
    this.bound = l.port;
    this.touch();
    this.deps.log.info("stream forwarder listening", { node: this.deps.node, port: l.port });
    return l.port;
  }

  /**
   * Starts listening on both loopback addresses, on the wanted port when nothing here has it,
   * else on a free one, and answers it: a port's forwarder. A machine with no IPv6 loopback
   * listens on 127.0.0.1 alone.
   */
  async startBoth(): Promise<number> {
    if (this.bound !== undefined) return this.bound;
    const wanted = this.deps.port;
    const free = this.deps.free ?? portFree;
    if (wanted !== undefined && (await free(wanted))) {
      const both = this.bindBoth(wanted);
      if (both) return this.started(both, wanted);
    }
    // a free port of the system's, taken on [::1] too; tried again when that one is held there
    for (let i = 0; i < 5; i++) {
      const v4 = this.listen("127.0.0.1", 0);
      const v6 = this.tryListen("::1", v4.port);
      if (v6 || !ipv6Loopback()) return this.started(v6 ? [v4, v6] : [v4], wanted);
      v4.stop(true);
    }
    return this.started([this.listen("127.0.0.1", 0)], wanted);
  }

  private started(listeners: TCPSocketListener<Conn>[], wanted: number | undefined): number {
    this.listeners = listeners;
    const port = listeners[0]!.port;
    this.bound = port;
    this.touch();
    this.deps.log.info("port forwarder listening", { node: this.deps.node, port, ...(wanted !== undefined && wanted !== port ? { wanted } : {}), addresses: listeners.map((l) => l.hostname) });
    return port;
  }

  /** The wanted port on both loopback addresses, or none when either is held. */
  private bindBoth(port: number): TCPSocketListener<Conn>[] | undefined {
    const v4 = this.tryListen("127.0.0.1", port);
    if (!v4) return undefined;
    const v6 = this.tryListen("::1", port);
    if (v6) return [v4, v6];
    if (!ipv6Loopback()) return [v4];
    v4.stop(true);
    return undefined;
  }

  private tryListen(hostname: string, port: number): TCPSocketListener<Conn> | undefined {
    try {
      return this.listen(hostname, port);
    } catch {
      return undefined;
    }
  }

  private listen(hostname: string, port: number): TCPSocketListener<Conn> {
    return Bun.listen<Conn>({
      hostname,
      port,
      socket: {
        open: (socket) => {
          socket.data = { early: [], closed: false };
          this.conns.add(socket);
          this.touch();
          this.deps.onConnections?.(this.conns.size);
          socket.pause();
          void this.deps.hub.openForSocket(socket as Socket<unknown>, this.deps.node, this.deps.target).then(
            (pipe) => {
              if (socket.data.closed) {
                pipe.gone("closed before its pipe opened");
                return;
              }
              socket.data.pipe = pipe;
              for (const chunk of socket.data.early.splice(0)) pipe.feed(chunk);
              socket.resume();
            },
            (e: unknown) => {
              this.deps.log.warn(this.deps.target?.kind === "port" ? "a port's connection found no pipe" : "a stream connection found no pipe", { node: this.deps.node, error: e instanceof Error ? e.message : String(e) });
              socket.end();
            },
          );
        },
        data: (socket, data) => {
          const bytes = new Uint8Array(data);
          if (socket.data.pipe) socket.data.pipe.feed(bytes);
          else socket.data.early.push(bytes);
        },
        drain: (socket) => socket.data.pipe?.drain(),
        close: (socket) => this.gone(socket, "the window closed the connection"),
        error: (socket) => this.gone(socket, "the connection failed"),
      },
    });
  }

  private gone(socket: Socket<Conn>, reason: string): void {
    if (socket.data.closed) return;
    socket.data.closed = true;
    this.conns.delete(socket);
    socket.data.pipe?.gone(reason);
    this.touch();
    if (!this.stopped) this.deps.onConnections?.(this.conns.size);
  }

  /** Arms the idle timer while nothing is connected. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (this.stopped || this.conns.size > 0) return;
    this.idle = setTimeout(() => this.stop(), this.deps.idleMs ?? FORWARDER_IDLE_MS);
    if (typeof this.idle === "object" && "unref" in this.idle) this.idle.unref();
  }

  /** Stops listening and ends every connection, the pipes with them. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idle) clearTimeout(this.idle);
    for (const s of [...this.conns]) {
      s.data.closed = true;
      s.data.pipe?.gone("the forwarder closed");
      s.end();
    }
    this.conns.clear();
    for (const l of this.listeners) l.stop(true);
    this.listeners = [];
    this.deps.onClose?.();
  }
}

let v6Loopback: boolean | undefined;

/** Whether this machine has an IPv6 loopback to listen on, found once. */
function ipv6Loopback(): boolean {
  if (v6Loopback !== undefined) return v6Loopback;
  try {
    const l = Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    l.stop(true);
    v6Loopback = true;
  } catch {
    v6Loopback = false;
  }
  return v6Loopback;
}
