// A message into a Codex turn while it runs, as the TUI's own steer puts one: `turn/steer` on
// the app-server that runs the thread, so the model reads it at its next step rather than once
// the turn ends. The app-server cophylad lists threads on hosts none, and could only queue it.
// A CLI runs its threads in the managed daemon it starts, which listens on a control socket
// under CODEX_HOME: WebSocket over a Unix socket. `codex app-server proxy` carries the bytes,
// since Bun on Windows opens no AF_UNIX socket; it fails when no daemon listens, and never
// starts one. A steer is a connection of its own: the upgrade, the handshake, the one request,
// and the close.
//
// `turn/steer` acts only on a thread its app-server has loaded, and only while the turn it
// names runs; it never loads a thread or starts a turn. A turn other than the one named is
// named back in the error, and steered once more; anything else is a steer not made, and the
// adapter queues the message instead.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { declineFor, OPT_OUT_NOTIFICATIONS } from "./appserver.ts";

export interface SteerOptions {
  command: string;
  /** Inserted before cophylad's own arguments, as for the app-server. */
  args: string[];
  env: Record<string, string | undefined>;
  version: string;
  /** The whole steer, from the spawn to the answer. */
  timeoutMs?: number;
}

export type SteerResult = { steered: true; turnId: string } | { steered: false; reason: string };

const TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 1000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MISMATCH = /expected active turn id `[^`]*` but found `([^`]+)`/;

/** Steers `text` into the thread's running turn, `turnId` as the rollout last named it. */
export async function steerTurn(opts: SteerOptions, threadId: string, turnId: string, text: string, clientId: string): Promise<SteerResult> {
  const conn = new ControlConnection(opts);
  const timer = setTimeout(() => conn.fail(new Error(`no answer within ${opts.timeoutMs ?? TIMEOUT_MS} ms`)), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    await conn.open();
    await conn.request("initialize", {
      clientInfo: { name: "cophylad", title: "cophylad", version: opts.version },
      capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    });
    conn.notify("initialized");
    const steer = (turn: string) => conn.request("turn/steer", { threadId, expectedTurnId: turn, clientUserMessageId: clientId, input: [{ type: "text", text }] }) as Promise<{ turnId?: string } | undefined>;
    let r: { turnId?: string } | undefined;
    try {
      r = await steer(turnId);
    } catch (e) {
      const found = e instanceof Error ? MISMATCH.exec(e.message)?.[1] : undefined;
      if (!found) throw e;
      r = await steer(found);
    }
    return { steered: true, turnId: r?.turnId ?? turnId };
  } catch (e) {
    return { steered: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    conn.close();
  }
}

/** JSON-RPC over WebSocket text frames, over the stdio of `codex app-server proxy`. */
class ControlConnection {
  private child: ChildProcess;
  private buf: Buffer = Buffer.alloc(0);
  private upgraded = false;
  private key = randomBytes(16).toString("base64");
  private parts: Buffer[] = [];
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private opening: { resolve: () => void; reject: (e: Error) => void } | undefined;
  private failed?: Error;
  private stderr = "";

  constructor(opts: SteerOptions) {
    this.child = spawn(opts.command, [...opts.args, "app-server", "proxy"], { stdio: ["pipe", "pipe", "pipe"], env: opts.env as NodeJS.ProcessEnv, windowsHide: true });
    this.child.on("error", (e) => this.fail(e));
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (d: string) => {
      if (this.stderr.length < 2000) this.stderr += d;
    });
    this.child.stdout?.on("data", (d: Buffer) => this.onData(d));
    this.child.on("exit", (code) => {
      const said = this.stderr.split(/\r?\n/).find((l) => l.trim());
      this.fail(new Error(said ? said.trim() : `proxy exited with ${code}`));
    });
  }

  open(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.opening = { resolve, reject };
      this.write(Buffer.from(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  /** Ends everything waiting with the error; the first one is kept. */
  fail(e: Error): void {
    this.failed ??= e;
    this.opening?.reject(this.failed);
    this.opening = undefined;
    for (const p of this.pending.values()) p.reject(this.failed);
    this.pending.clear();
  }

  close(): void {
    this.fail(new Error("closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (this.upgraded) this.frame(0x8, Buffer.alloc(0));
    this.child.stdin?.end();
    const kill = setTimeout(() => {
      try {
        this.child.kill();
      } catch {
        // already gone
      }
    }, CLOSE_GRACE_MS);
    kill.unref?.();
    this.child.once("exit", () => clearTimeout(kill));
  }

  private send(message: unknown): void {
    this.frame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
  }

  private write(bytes: Buffer): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed) stdin.write(bytes);
  }

  /** A client frame, masked as a client's must be. */
  private frame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    const n = payload.length;
    let head: Buffer;
    if (n < 126) head = Buffer.from([0x80 | opcode, 0x80 | n]);
    else if (n < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(n, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body[i] = payload[i]! ^ mask[i & 3]!;
    this.write(Buffer.concat([head, mask, body]));
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (!this.upgraded) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.buf.subarray(0, end).toString("latin1");
      this.buf = this.buf.subarray(end + 4);
      const accept = /^sec-websocket-accept:\s*(\S+)/im.exec(head)?.[1];
      const want = createHash("sha1").update(this.key + WS_GUID).digest("base64");
      if (!/^HTTP\/1\.1 101/.test(head) || accept !== want) return this.fail(new Error(`the control socket refused the upgrade: ${head.split("\r\n")[0]}`));
      this.upgraded = true;
      this.opening?.resolve();
      this.opening = undefined;
    }
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0]! & 0x80) !== 0;
      const opcode = this.buf[0]! & 0x0f;
      const masked = (this.buf[1]! & 0x80) !== 0;
      let n = this.buf[1]! & 0x7f;
      let at = 2;
      if (n === 126) {
        if (this.buf.length < 4) return;
        n = this.buf.readUInt16BE(2);
        at = 4;
      } else if (n === 127) {
        if (this.buf.length < 10) return;
        n = Number(this.buf.readBigUInt64BE(2));
        at = 10;
      }
      const maskAt = at;
      if (masked) at += 4;
      if (this.buf.length < at + n) return;
      const payload = Buffer.from(this.buf.subarray(at, at + n));
      if (masked) for (let i = 0; i < n; i++) payload[i] = payload[i]! ^ this.buf[maskAt + (i & 3)]!;
      this.buf = this.buf.subarray(at + n);
      if (opcode === 0x9) this.frame(0xa, payload);
      else if (opcode === 0x8) this.fail(new Error("the control socket closed"));
      else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.parts.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(this.parts).toString("utf8");
        this.parts = [];
        this.onMessage(text);
      }
    }
  }

  private onMessage(text: string): void {
    let m: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string; code?: number } | null };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (typeof m.method === "string") {
      // A request of the daemon's: this connection runs no turn, so it answers none.
      if (m.id !== undefined && m.id !== null) this.send({ jsonrpc: "2.0", id: m.id, ...declineFor(m.method) });
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error !== undefined && m.error !== null) p.reject(Object.assign(new Error(m.error.message ?? "app-server error"), { code: m.error.code }));
    else p.resolve(m.result);
  }
}
