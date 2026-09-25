// The helper process: cophyla-net over newline-delimited JSON-RPC on its stdio. It is said
// `hello` (the protocol must match), then `net.configure`d on the port this node keeps (a new
// one when that is taken, kept from then on), and is `ready` once it answered with the
// addresses it listens on. An exit it did not ask for starts it again, a second later and
// doubling up to the configured cap; five exits within five minutes leave it `unavailable`,
// with the last line it wrote to stderr as the reason, until the next start. Its log lines
// (JSON on stderr) go to this node's log.

import { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { StdioRpc } from "../rpc/stdio.ts";
import type { RequestOptions } from "../rpc/stdio.ts";

/** The protocol this node speaks to the helper; a helper that answers another is not used. */
export const NET_PROTOCOL = 1;
const EXITS_MAX = 5;
const EXITS_WINDOW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** What runs the helper: `StdioRpc` over the real binary, or a fake in the tests. */
export interface HelperProcess {
  readonly pid: number | undefined;
  /** The last of what it wrote to stderr. */
  readonly stderr: string;
  request(method: string, params?: unknown, opts?: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): boolean;
  stop(graceMs?: number): Promise<void>;
  kill(): void;
}

export interface SpawnOptions {
  command: string;
  env: Record<string, string | undefined>;
  log: Logger;
  onNotification: (method: string, params: unknown) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onStderr: (line: string) => void;
}

export type HelperSpawner = (opts: SpawnOptions) => HelperProcess;

export const spawnHelper: HelperSpawner = (opts) =>
  new StdioRpc({ command: opts.command, args: [], env: opts.env, log: opts.log, onNotification: opts.onNotification, onExit: (code, signal) => opts.onExit(code, signal), onStderr: opts.onStderr });

/** What the helper is given of the daemon's environment: where things are, and its own log switches; no keys. */
const ENV_KEEP = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_RUNTIME_DIR", "RUST_BACKTRACE", "RUST_LOG"];

export function helperEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEEP) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

export type HelperStatus =
  | { state: "stopped" }
  | { state: "starting"; reason?: string }
  | { state: "ready"; port: number; addresses: string[]; version?: string }
  | { state: "unavailable"; reason: string };

export interface NetHelperDeps {
  command: string;
  env: Record<string, string | undefined>;
  log: Logger;
  /** `net.configure`'s params for a port. */
  configure: (port: number) => Record<string, unknown>;
  /** The port to ask for first: the one this node kept, or the configured one. */
  port: () => number;
  /** The port the helper settled on, to keep. */
  onPort: (port: number) => void;
  onStatus: (status: HelperStatus) => void;
  /** The helper's notifications: `peer.*` and `net.state`. */
  onNotification: (method: string, params: unknown) => void;
  backoffMs: number;
  backoffMaxMs: number;
  spawn?: HelperSpawner;
  now?: () => number;
}

interface Configured {
  port: number;
  addresses: string[];
}

export class NetHelper {
  private deps: NetHelperDeps;
  private log: Logger;
  private proc?: HelperProcess;
  private current: HelperStatus = { state: "stopped" };
  private exits: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  /** Bumped by every launch and stop, so what an old process says is not heard. */
  private generation = 0;

  constructor(deps: NetHelperDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  get status(): HelperStatus {
    return this.current;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private set(status: HelperStatus): void {
    this.current = status;
    this.deps.onStatus(status);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.exits = [];
    this.launch();
  }

  private launch(): void {
    const gen = ++this.generation;
    this.set({ state: "starting" });
    let proc: HelperProcess;
    try {
      proc = (this.deps.spawn ?? spawnHelper)({
        command: this.deps.command,
        env: this.deps.env,
        log: this.log,
        onNotification: (method, params) => {
          if (gen === this.generation) this.deps.onNotification(method, params);
        },
        onExit: (code, signal) => this.exited(gen, `exited (${signal ?? code})`),
        onStderr: (line) => this.stderrLine(line),
      });
    } catch (e) {
      this.exited(gen, `could not be started (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    this.proc = proc;
    void this.handshake(gen, proc);
  }

  private async handshake(gen: number, proc: HelperProcess): Promise<void> {
    try {
      const hello = (await proc.request("hello", { protocol: NET_PROTOCOL }, { timeoutMs: REQUEST_TIMEOUT_MS })) as { protocol?: unknown; version?: unknown };
      if (hello?.protocol !== NET_PROTOCOL) {
        if (gen !== this.generation) return;
        // a helper from another version will not do better on a second try
        this.generation++;
        this.proc = undefined;
        proc.kill();
        this.set({ state: "unavailable", reason: `the helper speaks protocol ${String(hello?.protocol)}, this node ${NET_PROTOCOL}` });
        return;
      }
      let port = this.deps.port();
      let configured: Configured;
      try {
        configured = (await proc.request("net.configure", this.deps.configure(port), { timeoutMs: REQUEST_TIMEOUT_MS })) as Configured;
      } catch (e) {
        if (port === 0 || gen !== this.generation) throw e;
        this.log.warn("the kept port did not bind; taking a new one", { port, error: e instanceof Error ? e.message : String(e) });
        port = 0;
        configured = (await proc.request("net.configure", this.deps.configure(0), { timeoutMs: REQUEST_TIMEOUT_MS })) as Configured;
      }
      if (gen !== this.generation) return;
      this.deps.onPort(configured.port);
      this.log.info("direct helper ready", { port: configured.port, addresses: configured.addresses.length, pid: proc.pid });
      this.set({ state: "ready", port: configured.port, addresses: configured.addresses, ...(typeof hello.version === "string" ? { version: hello.version } : {}) });
    } catch (e) {
      if (gen !== this.generation) return;
      this.log.warn("direct helper did not start", { error: e instanceof Error ? e.message : String(e) });
      // its exit brings the next try
      proc.kill();
    }
  }

  private exited(gen: number, why: string): void {
    if (gen !== this.generation || this.stopped) return;
    const proc = this.proc;
    this.proc = undefined;
    const now = this.now();
    this.exits = [...this.exits.filter((t) => now - t < EXITS_WINDOW_MS), now];
    const said = lastLine(proc?.stderr ?? "");
    if (this.exits.length >= EXITS_MAX) {
      this.log.error("direct helper keeps exiting; left off until the next start", { exits: this.exits.length, last: said });
      this.set({ state: "unavailable", reason: `the helper exited ${EXITS_MAX} times in five minutes${said ? `: ${said}` : ""}` });
      return;
    }
    const delay = Math.min(this.deps.backoffMaxMs, this.deps.backoffMs * 2 ** (this.exits.length - 1));
    this.log.warn("direct helper exited; starting it again", { why, inMs: delay, last: said });
    this.set({ state: "starting", reason: `the helper ${why}; starting it again` });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.launch();
    }, delay);
  }

  /** A line of the helper's log: JSON with its level, or a panic's plain text. */
  private stderrLine(line: string): void {
    try {
      const { level, msg, ...fields } = JSON.parse(line) as { level?: string; msg?: string };
      const at = level === "error" ? "error" : level === "warn" ? "warn" : level === "info" ? "info" : "debug";
      this.log[at](msg ?? "helper", fields);
    } catch {
      this.log.warn("helper", { line: line.slice(0, 500) });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const proc = this.proc;
    this.proc = undefined;
    if (proc) {
      proc.notify("shutdown");
      await proc.stop(1000);
    }
    this.set({ state: "stopped" });
  }

  /** A request to the helper once it is ready; `unavailable` before. */
  request(method: string, params: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (!this.proc || this.current.state !== "ready") return Promise.reject(new RpcError("unavailable", "the direct helper is not running"));
    return this.proc.request(method, params, { timeoutMs: REQUEST_TIMEOUT_MS, ...opts });
  }

  notify(method: string, params: unknown): boolean {
    if (!this.proc || this.current.state !== "ready") return false;
    return this.proc.notify(method, params);
  }
}

/** The last thing a process said on stderr, for a reason: a log line's message, or the text. */
function lastLine(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).pop()?.trim() ?? "";
  try {
    const msg = (JSON.parse(line) as { msg?: unknown }).msg;
    if (typeof msg === "string") return msg.slice(0, 200);
  } catch {
    // plain text
  }
  return line.slice(0, 200);
}
