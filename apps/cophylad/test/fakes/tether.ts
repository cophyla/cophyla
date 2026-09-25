// A tether host for cophylad's tests, speaking the real protocol (spec/protocol.md) over a real
// named pipe or Unix socket, so the daemon's side runs through the real SDK. Its sessions run
// nothing: a test sets what each screen shows, reads what was typed into it, writes its output,
// and says when it exits. A spawn can be answered by a hook, which is how a test plays the
// harness registering. A subscription that sizes sets the session's size, as the host's rule
// has it for the latest one.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_LABEL, Decoder, encodeJson, encodeSeq, FrameType, hex, HOST_LABEL, nonce, proof, unhex, verify } from "@tether-pty/client";
import type { HostFile, Run, SessionInfo } from "@tether-pty/client";

export interface FakeSpawn {
  argv: string[];
  cwd: string;
  env: { base?: string; set?: Record<string, string> };
  labels: Record<string, string>;
}

interface Stream {
  session: FakeSession;
  sizing: boolean;
}

interface Conn {
  sock: Socket;
  id: number;
  watching: boolean;
  streams: Map<number, Stream>;
}

export class FakeSession {
  readonly id: string;
  readonly pid: number;
  readonly spawn: FakeSpawn;
  cols = 120;
  rows = 32;
  status: "running" | "exited" = "running";
  exitCode?: number;
  /** The screen as rows of runs; `setScreen` fills it from text. */
  cells: Run[][] = [];
  /** Everything typed, in order: `paste:<text>`, `keys:<names>`, `write:<data>`. */
  typed: string[] = [];
  clients: SessionInfo["clients"] = [];
  seq = 0;
  private host: FakeTether;

  constructor(host: FakeTether, id: string, pid: number, spawn: FakeSpawn) {
    this.host = host;
    this.id = id;
    this.pid = pid;
    this.spawn = spawn;
  }

  /** The screen, one string per row; a row given as `[text, "dim"]` is drawn dim after its first two characters. */
  setScreen(rows: (string | [string, "dim"])[]): void {
    this.cells = rows.map((r) => (typeof r === "string" ? [{ t: r }] : [{ t: r[0].slice(0, 2) }, { t: r[0].slice(2), dim: true }]));
  }

  lines(): string[] {
    return this.cells.map((runs) => runs.map((r) => r.t).join(""));
  }

  info(): SessionInfo {
    return {
      session: this.id,
      pid: this.pid,
      argv: this.spawn.argv,
      cwd: this.spawn.cwd,
      cols: this.cols,
      rows: this.rows,
      labels: this.spawn.labels,
      status: this.status,
      ...(this.exitCode !== undefined ? { exit: { code: this.exitCode } } : {}),
      startedAt: 1,
      seq: this.seq,
      clients: this.clients,
    };
  }

  /** Output the program writes: to every stream on it. */
  output(text: string | Uint8Array): void {
    const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
    for (const c of this.host.conns) {
      for (const [stream, s] of c.streams) if (s.session === this) c.sock.write(encodeSeq(FrameType.Output, stream, this.seq, data));
    }
    this.seq += data.length;
  }

  /** The repaint a `vt` screen or a Resync carries: the rows, as text. */
  repaint(): string {
    return `\x1b[H\x1b[2J${this.lines().join("\r\n")}`;
  }

  /** Every stream on the session fell behind: each gets a Resync. */
  resync(): void {
    const data = new TextEncoder().encode(this.repaint());
    for (const c of this.host.conns) {
      for (const [stream, s] of c.streams) if (s.session === this) c.sock.write(encodeSeq(FrameType.Resync, stream, this.seq, data));
    }
  }

  /** The session's size changed, by a sizing subscription or a resize. */
  sized(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.host.emit({ ev: "resized", session: this.id, cols, rows });
  }

  exit(code: number): void {
    this.status = "exited";
    this.exitCode = code;
    this.host.emit({ ev: "exited", session: this.id, code });
  }

  /** A window attaches, as `tether attach` would. */
  attachWindow(pid: number): void {
    const client = { client: `c${pid}`, stream: pid, pid, role: "window" as const, input: true, sizing: true, attachedAt: Date.now() };
    this.clients = [...this.clients, client];
    this.host.emit({ ev: "attached", session: this.id, client });
  }
}

export class FakeTether {
  readonly dir: string;
  host!: HostFile;
  readonly sessions = new Map<string, FakeSession>();
  readonly conns = new Set<Conn>();
  /** Every request, by op. */
  readonly requests: { op: string; body: Record<string, unknown> }[] = [];
  /** Called on every spawn, after the session exists. */
  onSpawn?: (s: FakeSession) => void;
  private server?: Server;
  private next = 1;
  private nextPid = 7000;
  private nextConn = 1;
  private nextStream = 1;

  constructor(dir = join(tmpdir(), `cophylad-fake-tether-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)) {
    this.dir = dir;
  }

  async start(): Promise<this> {
    const name = `cophylad-fake-tether-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
    this.host = { host: hex(nonce()).slice(0, 16), pid: process.pid, version: "0.1.0", protocol: 1, endpoint, token: hex(nonce()), startedAt: Date.now() };
    this.server = createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(endpoint, () => resolve());
    });
    mkdirSync(join(this.dir, "hosts"), { recursive: true });
    writeFileSync(join(this.dir, "hosts", `${this.host.host}.json`), JSON.stringify(this.host));
    writeFileSync(join(this.dir, "current"), this.host.host);
    return this;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.sock.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** A session as if spawned by another client (`tether run` from a terminal profile). */
  add(spawn: Partial<FakeSpawn> & { argv: string[] }, pid = this.nextPid++): FakeSession {
    const s = new FakeSession(this, `t${this.next++}`, pid, { cwd: "/", env: {}, labels: {}, ...spawn });
    this.sessions.set(s.id, s);
    this.emit({ ev: "created", session: s.id, info: s.info() });
    return s;
  }

  emit(ev: Record<string, unknown>): void {
    const bytes = encodeJson(FrameType.Message, ev);
    for (const c of this.conns) {
      const streamed = [...c.streams.values()].some((s) => s.session.id === ev["session"]);
      if (c.watching || streamed) c.sock.write(bytes);
    }
  }

  private accept(sock: Socket): void {
    const dec = new Decoder();
    const conn: Conn = { sock, id: this.nextConn++, watching: false, streams: new Map() };
    let clientNonce: Uint8Array | undefined;
    let hostNonce: Uint8Array | undefined;
    let open = false;
    sock.on("error", () => undefined);
    sock.on("close", () => this.conns.delete(conn));
    sock.on("data", (b: Buffer) => {
      dec.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      for (let f = dec.next(); f; f = dec.next()) {
        if (!open) {
          if (f.type !== "handshake") return void sock.destroy();
          const j = f.json as Record<string, unknown>;
          if (!clientNonce) {
            clientNonce = unhex(String(j["nonce"]));
            hostNonce = nonce();
            sock.write(encodeJson(FrameType.Handshake, { protocol: 1, nonce: hex(hostNonce), proof: hex(proof(this.host.token, HOST_LABEL, clientNonce!, hostNonce)) }));
          } else {
            if (!verify(this.host.token, CLIENT_LABEL, clientNonce, hostNonce!, unhex(String(j["proof"])) ?? new Uint8Array())) return void sock.destroy();
            open = true;
            this.conns.add(conn);
            sock.write(encodeJson(FrameType.Handshake, { welcome: { host: this.host.host, version: "0.1.0", protocol: 1, pid: process.pid, caps: [] } }));
          }
          continue;
        }
        if (f.type === "message") this.request(conn, f.json as Record<string, unknown>);
        if (f.type === "input") {
          const s = conn.streams.get(f.stream);
          if (s) s.session.typed.push(`write:${new TextDecoder().decode(f.data)}`);
        }
      }
    });
  }

  private request(conn: Conn, m: Record<string, unknown>): void {
    const id = m["id"] as number;
    const op = m["op"] as string;
    this.requests.push({ op, body: m });
    const ok = (v: unknown): void => void conn.sock.write(encodeJson(FrameType.Message, { re: id, ok: v }));
    const fail = (code: string, message: string): void => void conn.sock.write(encodeJson(FrameType.Message, { re: id, error: { code, message } }));
    const session = typeof m["session"] === "string" ? this.sessions.get(m["session"]) : undefined;
    switch (op) {
      case "watch":
        conn.watching = true;
        return ok({});
      case "list":
        return ok({ sessions: [...this.sessions.values()].map((s) => s.info()) });
      case "unsubscribe":
        conn.streams.delete(m["stream"] as number);
        return ok({});
      case "host":
        return ok({ host: this.host.host, pid: process.pid, version: "0.1.0", protocol: 1, startedAt: 1, draining: false, sessions: this.sessions.size, clients: this.conns.size });
      case "spawn": {
        const s = new FakeSession(this, `t${this.next++}`, this.nextPid++, { argv: m["argv"] as string[], cwd: (m["cwd"] as string) ?? "/", env: (m["env"] as FakeSpawn["env"]) ?? {}, labels: (m["labels"] as Record<string, string>) ?? {} });
        this.sessions.set(s.id, s);
        ok({ session: s.id, pid: s.pid });
        this.emit({ ev: "created", session: s.id, info: s.info() });
        this.onSpawn?.(s);
        return;
      }
    }
    if (!session) return fail("not_found", `no session ${String(m["session"])}`);
    switch (op) {
      case "info":
        return ok(session.info());
      case "screen":
        return ok({ format: m["format"] ?? "text", cols: session.cols, rows: session.rows, cursor: { row: 0, col: 0, visible: true }, seq: session.seq, altScreen: false, bracketedPaste: true, appCursor: false, ...(m["format"] === "cells" ? { cells: session.cells } : m["format"] === "vt" ? { data: session.repaint() } : { lines: session.lines() }) });
      case "paste":
        session.typed.push(`paste:${String(m["text"])}`);
        return ok({ bracketed: true });
      case "keys":
        session.typed.push(`keys:${(m["keys"] as string[]).join(",")}`);
        return ok({});
      case "write":
        session.typed.push(`write:${String(m["data"])}`);
        return ok({});
      case "resize":
        session.sized(m["cols"] as number, m["rows"] as number);
        return ok({});
      case "kill":
        ok({});
        session.exit(1);
        return;
      case "subscribe": {
        const stream = this.nextStream++;
        const size = m["size"] as { cols: number; rows: number } | undefined;
        conn.streams.set(stream, { session, sizing: m["sizing"] === true });
        if (m["sizing"] === true && size) session.sized(size.cols, size.rows);
        ok({ stream, seq: session.seq, cols: session.cols, rows: session.rows });
        if ((m["from"] ?? "snapshot") === "snapshot") conn.sock.write(encodeSeq(FrameType.Resync, stream, session.seq, new TextEncoder().encode(session.repaint())));
        return;
      }
      default:
        return fail("unsupported", `the fake has no ${op}`);
    }
  }
}
