// A forwarder on the viewing node's loopback, for a desktop app that shows another node's
// stream page when there is no route to that node: the app's window loads
// `http://127.0.0.1:<port>/remote/?t=…`, and each connection the window opens becomes a pipe
// to the host node's stream proxy. What a connection sends before its pipe is open waits,
// the socket paused. With no connection for five minutes the forwarder closes.

import type { Socket, TCPSocketListener } from "bun";
import type { Logger } from "../log.ts";
import type { PipeHub, SocketPipe } from "./pipes.ts";

export const FORWARDER_IDLE_MS = 5 * 60_000;

interface Conn {
  pipe?: SocketPipe;
  early: Uint8Array[];
  closed: boolean;
}

export interface ForwarderDeps {
  hub: PipeHub;
  /** The node whose stream proxy the connections reach. */
  node: string;
  log: Logger;
  idleMs?: number;
  /** It closed: idle, or stopped. */
  onClose?: () => void;
}

export class Forwarder {
  private deps: ForwarderDeps;
  private listener?: TCPSocketListener<Conn>;
  private conns = new Set<Socket<Conn>>();
  private idle?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(deps: ForwarderDeps) {
    this.deps = deps;
  }

  /** Starts listening and answers the port. */
  start(): number {
    if (this.listener) return this.listener.port;
    this.listener = Bun.listen<Conn>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          socket.data = { early: [], closed: false };
          this.conns.add(socket);
          this.touch();
          socket.pause();
          void this.deps.hub.openForSocket(socket as Socket<unknown>, this.deps.node).then(
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
              this.deps.log.warn("a stream connection found no pipe", { node: this.deps.node, error: e instanceof Error ? e.message : String(e) });
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
    this.touch();
    this.deps.log.info("stream forwarder listening", { node: this.deps.node, port: this.listener.port });
    return this.listener.port;
  }

  private gone(socket: Socket<Conn>, reason: string): void {
    if (socket.data.closed) return;
    socket.data.closed = true;
    this.conns.delete(socket);
    socket.data.pipe?.gone(reason);
    this.touch();
  }

  /** Arms the idle timer while nothing is connected. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (this.stopped || this.conns.size > 0) return;
    this.idle = setTimeout(() => this.stop(), this.deps.idleMs ?? FORWARDER_IDLE_MS);
    if (typeof this.idle === "object" && "unref" in this.idle) this.idle.unref();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idle) clearTimeout(this.idle);
    for (const s of [...this.conns]) s.end();
    this.conns.clear();
    this.listener?.stop(true);
    this.listener = undefined;
    this.deps.onClose?.();
  }
}
