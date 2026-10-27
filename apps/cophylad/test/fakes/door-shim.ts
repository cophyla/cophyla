// The sign-in door's shim (apps/door), played in the tests: a pipe of its own (a named pipe
// under `\\.\pipe\LOCAL\` on Windows, a socket file elsewhere) that a daemon attaches to, its
// clients bridged to a `Door` in this process the shim's way (`pipe.open`, `pipe.line`,
// `pipe.close`, answered with `pipe.send` and `pipe.drop`), and the console and the power the
// test sets. What the door asks of the power rule is recorded.

import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleState } from "../../src/door/constants.ts";
import type { ShimIo } from "../../src/door/shim.ts";

/** A pipe name no other test uses. */
export function testPipe(): string {
  const id = randomBytes(6).toString("hex");
  return process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cophyla-door-test-${id}` : join(tmpdir(), `cophyla-door-test-${id}.sock`);
}

export class FakeShim {
  readonly pipe: string;
  readonly io: ShimIo;
  /** What the door asked of the power rule, in order. */
  readonly powers: { ready: boolean; streaming: boolean }[] = [];
  /** Connections the door dropped. */
  dropped = 0;
  private toDoor?: (line: string) => void;
  private endDoor?: () => void;
  private conns = new Map<number, Socket>();
  private next = 0;
  private server?: Server;
  private consoleState: ConsoleState;
  private ac: boolean;

  constructor(opts: { console?: ConsoleState; ac?: boolean; pipe?: string } = {}) {
    this.pipe = opts.pipe ?? testPipe();
    this.consoleState = opts.console ?? "active";
    this.ac = opts.ac ?? true;
    this.io = {
      write: (line) => this.fromDoor(line),
      onLine: (fn) => {
        this.toDoor = fn;
      },
      onEnd: (fn) => {
        this.endDoor = fn;
      },
    };
  }

  private notify(method: string, params: unknown): void {
    this.toDoor?.(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private fromDoor(text: string): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const m = JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
      const p = m.params ?? {};
      if (m.method === "pipe.send") this.conns.get(p["conn"] as number)?.write(`${p["line"] as string}\n`);
      else if (m.method === "pipe.drop") {
        this.dropped++;
        this.conns.get(p["conn"] as number)?.destroy();
      } else if (m.method === "power.want") this.powers.push({ ready: p["ready"] === true, streaming: p["streaming"] === true });
    }
  }

  /** Opens the pipe and says hello to the door. */
  async start(): Promise<void> {
    this.notify("shim.hello", { protocol: 1, version: "0.1.0-test", console: this.consoleState, ac: this.ac, userSid: "S-1-5-21-0-0-0-1001" });
    const server = createServer((sock) => {
      const conn = ++this.next;
      this.conns.set(conn, sock);
      this.notify("pipe.open", { conn, sid: "S-1-5-21-0-0-0-1001" });
      let buffer = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line.trim()) this.notify("pipe.line", { conn, line });
        }
      });
      const gone = () => {
        if (!this.conns.delete(conn)) return;
        this.notify("pipe.close", { conn });
      };
      sock.on("close", gone);
      sock.on("error", gone);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.pipe, () => resolve());
    });
  }

  console(state: ConsoleState): void {
    this.consoleState = state;
    this.notify("console.state", { console: state });
  }

  power(ac: boolean): void {
    this.ac = ac;
    this.notify("power.state", { ac });
  }

  /** How many daemons hold the pipe now. */
  get clients(): number {
    return this.conns.size;
  }

  async stop(): Promise<void> {
    for (const s of this.conns.values()) s.destroy();
    this.conns.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.endDoor?.();
  }
}
