// The door's end of its shim (apps/door): newline-delimited JSON-RPC notifications over the
// child's stdio. The shim says hello first (its protocol, the console, the power, the user
// its pipe lets in), then tells the console's changes (the sign-in screen, locked, someone
// working), mains power coming and going, and each client of its pipe: a connection the user
// opened (`pipe.open`, already checked to be that user), its lines, its end; and that the
// service is stopping. The door answers a client's lines with `pipe.send`, drops a client with
// `pipe.drop`, and says what the power rule needs (`power.want`): whether it is ready at the
// sign-in screen, and whether a stream is live. The shim holds the machine awake by its rule.

import type { Logger } from "../log.ts";
import { RpcPeer } from "../rpc/peer.ts";
import type { ConsoleState } from "./constants.ts";
import { SHIM_PROTOCOL } from "./constants.ts";

/** What carries the shim's lines: the child's stdio, or a test's pair of ends. */
export interface ShimIo {
  write(line: string): void;
  onLine(fn: (line: string) => void): void;
  onEnd(fn: () => void): void;
}

export interface ShimHello {
  protocol: number;
  version: string;
  console: ConsoleState;
  ac: boolean;
  userSid: string;
}

export interface ShimHandlers {
  console?: (state: ConsoleState) => void;
  power?: (ac: boolean) => void;
  open?: (conn: number, sid: string) => void;
  line?: (conn: number, line: string) => void;
  close?: (conn: number) => void;
  stop?: () => void;
  /** The shim went: its stdin closed. */
  end?: () => void;
}

const CONSOLE_STATES: ReadonlySet<string> = new Set(["signin", "locked", "active"]);

export class Shim {
  private rpc: RpcPeer;
  private log: Logger;
  private handlers: ShimHandlers = {};
  private helloWaiters: ((h: ShimHello) => void)[] = [];
  /** The shim's hello, once it came. */
  hello?: ShimHello;

  constructor(io: ShimIo, log: Logger) {
    this.log = log;
    this.rpc = new RpcPeer({
      write: (text) => {
        io.write(text + "\n");
        return true;
      },
      log,
      label: "shim",
      onNotification: (method, params) => this.onNotification(method, params as Record<string, unknown>),
    });
    io.onLine((line) => {
      const t = line.trim();
      if (t) this.rpc.onText(t);
    });
    io.onEnd(() => {
      this.rpc.close("the shim went");
      this.handlers.end?.();
    });
  }

  on(handlers: ShimHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /** Resolves with the shim's hello. */
  ready(): Promise<ShimHello> {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise((resolve) => this.helloWaiters.push(resolve));
  }

  private onNotification(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case "shim.hello": {
        const console = typeof p["console"] === "string" && CONSOLE_STATES.has(p["console"]) ? (p["console"] as ConsoleState) : "active";
        const hello: ShimHello = { protocol: Number(p["protocol"]) || 0, version: String(p["version"] ?? ""), console, ac: p["ac"] !== false, userSid: String(p["userSid"] ?? "") };
        if (hello.protocol !== SHIM_PROTOCOL) this.log.warn("the shim speaks another protocol; the door goes on as far as it can", { theirs: hello.protocol, mine: SHIM_PROTOCOL });
        this.hello = hello;
        for (const w of this.helloWaiters.splice(0)) w(hello);
        return;
      }
      case "console.state": {
        const c = p["console"];
        if (typeof c === "string" && CONSOLE_STATES.has(c)) this.handlers.console?.(c as ConsoleState);
        return;
      }
      case "power.state":
        this.handlers.power?.(p["ac"] !== false);
        return;
      case "pipe.open":
        if (typeof p["conn"] === "number") this.handlers.open?.(p["conn"], String(p["sid"] ?? ""));
        return;
      case "pipe.line":
        if (typeof p["conn"] === "number" && typeof p["line"] === "string") this.handlers.line?.(p["conn"], p["line"]);
        return;
      case "pipe.close":
        if (typeof p["conn"] === "number") this.handlers.close?.(p["conn"]);
        return;
      case "shim.stop":
        this.handlers.stop?.();
        return;
      default:
        this.log.debug("a line from the shim ignored", { method });
    }
  }

  /** A line to a client of the pipe. */
  send(conn: number, line: string): void {
    this.rpc.notify("pipe.send", { conn, line });
  }

  /** Drops a client of the pipe. */
  drop(conn: number): void {
    this.rpc.notify("pipe.drop", { conn });
  }

  /** What the power rule needs: ready at the sign-in screen, and a stream live. */
  want(ready: boolean, streaming: boolean): void {
    this.rpc.notify("power.want", { ready, streaming });
  }
}

/** The child's own stdio as the shim's lines. */
export function stdioShim(): ShimIo {
  return {
    write: (line) => void process.stdout.write(line),
    onLine: (fn) => {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          fn(line);
        }
      });
    },
    onEnd: (fn) => void process.stdin.on("end", fn),
  };
}
