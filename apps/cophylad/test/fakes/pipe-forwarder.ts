// The phone's stream forwarder, played in the tests: a listener on loopback whose every
// connection becomes a pipe (`remote.pipe.open`) on a client's link, its bytes sent as
// `remote.pipe.data` and what comes back written to the socket and acknowledged. Acks can be
// held, to see the node keep to the window, and let go.

import type { Socket, TCPSocketListener } from "bun";

/** A client link that can open pipes: a test client on a listener, or a phone on the relay. */
export interface PipeLink {
  request(method: string, params: unknown): Promise<unknown>;
  signal(method: string, params: unknown): void;
  /** Hears the link's notifications. */
  listen(handler: (method: string, params: unknown) => void): void;
}

interface Conn {
  pipe?: string;
  early: Uint8Array[];
}

const CHUNK = 48 * 1024;

export class TestForwarder {
  private link: PipeLink;
  private node: string;
  private listener: TCPSocketListener<Conn>;
  private byPipe = new Map<string, Socket<Conn>>();
  private held: { pipe: string; bytes: number }[] = [];
  /** Hold every ack until `release`. */
  holdAcks = false;
  /** Bytes the node sent, over every pipe. */
  received = 0;
  /** Pipes opened, and failures to open one. */
  opened = 0;
  failures: string[] = [];

  constructor(link: PipeLink, node: string) {
    this.link = link;
    this.node = node;
    link.listen((method, params) => this.onNotification(method, params as { pipe: string; data?: string; reason?: string }));
    this.listener = Bun.listen<Conn>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          s.data = { early: [] };
          void this.link.request("remote.pipe.open", { node: this.node }).then(
            (r) => {
              const pipe = (r as { pipe: string }).pipe;
              this.opened++;
              s.data.pipe = pipe;
              this.byPipe.set(pipe, s);
              for (const b of s.data.early.splice(0)) this.send(pipe, b);
            },
            (e: unknown) => {
              this.failures.push(e instanceof Error ? e.message : String(e));
              s.end();
            },
          );
        },
        data: (s, d) => {
          const bytes = new Uint8Array(d);
          if (s.data.pipe) this.send(s.data.pipe, bytes);
          else s.data.early.push(bytes);
        },
        close: (s) => {
          const pipe = s.data.pipe;
          if (!pipe || !this.byPipe.has(pipe)) return;
          this.byPipe.delete(pipe);
          this.link.signal("remote.pipe.close", { pipe, reason: "the page closed it" });
        },
      },
    });
  }

  get port(): number {
    return this.listener.port;
  }

  /** Pipes open now. */
  get open(): number {
    return this.byPipe.size;
  }

  private send(pipe: string, bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length; at += CHUNK) {
      this.link.signal("remote.pipe.data", { pipe, data: Buffer.from(bytes.subarray(at, at + CHUNK)).toString("base64") });
    }
  }

  private onNotification(method: string, p: { pipe: string; data?: string; reason?: string }): void {
    const s = this.byPipe.get(p.pipe);
    if (method === "remote.pipe.data" && p.data !== undefined) {
      const bytes = Buffer.from(p.data, "base64");
      this.received += bytes.length;
      s?.write(bytes);
      if (this.holdAcks) this.held.push({ pipe: p.pipe, bytes: bytes.length });
      else this.link.signal("remote.pipe.ack", { pipe: p.pipe, bytes: bytes.length });
      return;
    }
    if (method === "remote.pipe.close" && s) {
      this.byPipe.delete(p.pipe);
      s.end();
    }
  }

  /** Sends the acks held, and holds no more. */
  release(): void {
    this.holdAcks = false;
    for (const a of this.held.splice(0)) this.link.signal("remote.pipe.ack", a);
  }

  stop(): void {
    for (const s of this.byPipe.values()) s.end();
    this.byPipe.clear();
    this.listener.stop(true);
  }
}
