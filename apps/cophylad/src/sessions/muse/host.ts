// A `muse serve` host per Muse profile: MSP, JSON-RPC 2.0 over stdio, through the shared
// `StdioRpc`. It is how cophylad lists the profile's sessions, reads the view of one live in a
// terminal, reads the plan's usage, and runs the sessions it starts headless. Restarted with
// backoff when it exits, and when the launcher names a new active binary, so it never holds
// on to one the launcher is replacing. Calls start it when it is down.

import type { RpcId } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import { ChildRpcError, StdioRpc } from "../../rpc/stdio.ts";
import type { MuseBinary } from "./locate.ts";
import { versionMoved } from "./locate.ts";

export interface MuseHostOptions {
  /** Picks the binary afresh at every start. */
  binary: () => MuseBinary;
  env: Record<string, string | undefined>;
  log: Logger;
  version: string;
  onNotification?: (method: string, params: unknown) => void;
  /** A request from the host (`approval/request`, `userInput/request`): answer with the receipt. */
  onRequest?: (method: string, params: unknown, id: RpcId) => unknown;
  /** Every session the host had loaded is gone with it. */
  onExit?: () => void;
  callTimeoutMs?: number;
}

export interface MuseInitialize {
  /** The data directory: `<XDG_DATA_HOME>/muse`. */
  museHome?: string;
  serverInfo?: { name?: string; version?: string };
  platformOs?: string;
}

/** Streaming appends cophylad never reads: a completed item carries the whole of it. */
const OPT_OUT_NOTIFICATIONS = ["item/delta"];

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const CALL_TIMEOUT_MS = 30000;

/** A Muse error's kind (`sessionNotFound`, `commandRejected`…), when the host said one. */
export function museErrorKind(e: unknown): string | undefined {
  if (!(e instanceof ChildRpcError)) return undefined;
  const data = e.raw.data as { kind?: unknown } | undefined;
  return typeof data?.kind === "string" ? data.kind : undefined;
}

export class MuseHost {
  private opts: MuseHostOptions;
  private rpc?: StdioRpc;
  private bin?: MuseBinary;
  private starting?: Promise<MuseInitialize>;
  private initialized?: MuseInitialize;
  private stopping = false;
  private backoffMs = BACKOFF_MIN_MS;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private log: Logger;

  constructor(opts: MuseHostOptions) {
    this.opts = opts;
    this.log = opts.log;
  }

  get alive(): boolean {
    return this.rpc !== undefined && this.initialized !== undefined;
  }

  get museHome(): string | undefined {
    return this.initialized?.museHome;
  }

  get pid(): number | undefined {
    return this.rpc?.pid;
  }

  /** Spawns and completes the handshake. Concurrent callers share one attempt. */
  start(): Promise<MuseInitialize> {
    if (this.initialized) return Promise.resolve(this.initialized);
    if (this.starting) return this.starting;
    this.starting = this.spawnAndInitialize().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawnAndInitialize(): Promise<MuseInitialize> {
    this.stopping = false;
    const bin = this.opts.binary();
    this.bin = bin;
    const rpc = new StdioRpc({
      command: bin.command,
      args: [...bin.args, "serve"],
      env: this.opts.env,
      log: this.log,
      ...(this.opts.onNotification ? { onNotification: this.opts.onNotification } : {}),
      ...(this.opts.onRequest ? { onRequest: this.opts.onRequest } : {}),
      onStderr: (line) => this.log.debug("serve stderr", { line: line.slice(0, 500) }),
      onExit: (code, signal) => this.onExit(rpc, code, signal),
    });
    this.rpc = rpc;
    try {
      const result = (await rpc.request(
        "initialize",
        { clientInfo: { name: "cophylad", version: this.opts.version }, capabilities: { optOutNotificationMethods: OPT_OUT_NOTIFICATIONS } },
        { timeoutMs: this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS },
      )) as MuseInitialize | null;
      rpc.notify("initialized");
      this.initialized = result ?? {};
      this.backoffMs = BACKOFF_MIN_MS;
      this.log.info("muse serve ready", { binary: bin.command, version: result?.serverInfo?.version, museHome: result?.museHome });
      return this.initialized;
    } catch (e) {
      rpc.kill();
      if (this.rpc === rpc) this.rpc = undefined;
      const tail = rpc.stderr.trim().split(/\r?\n/).slice(-3).join("\n");
      throw new Error(`muse serve did not start: ${e instanceof Error ? e.message : String(e)}${tail ? `\n${tail}` : ""}`);
    }
  }

  private onExit(rpc: StdioRpc, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.rpc !== rpc) return;
    this.rpc = undefined;
    const was = this.initialized !== undefined;
    this.initialized = undefined;
    if (was) this.opts.onExit?.();
    if (this.stopping) return;
    this.log.warn("muse serve exited", { code, signal, restartInMs: this.backoffMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start().catch((e) => this.log.warn("muse serve restart failed", { error: e instanceof Error ? e.message : String(e) }));
    }, this.backoffMs);
    if (typeof this.restartTimer === "object" && "unref" in this.restartTimer) this.restartTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  /** A request after the handshake; starts the host when it is down. */
  async call<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (!this.initialized) await this.start();
    const rpc = this.rpc;
    if (!rpc) throw new Error("muse serve is not running");
    return (await rpc.request(method, params, { timeoutMs: opts.timeoutMs ?? this.opts.callTimeoutMs ?? CALL_TIMEOUT_MS })) as T;
  }

  /**
   * The launcher has named a new binary since this one started: a host with no session of
   * cophylad's loaded is restarted on it. One that holds sessions keeps running until they end.
   */
  async refresh(busy: boolean): Promise<void> {
    if (!this.bin || !this.rpc || busy || !versionMoved(this.bin)) return;
    this.log.info("muse was updated; restarting its host", { was: this.bin.version });
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const rpc = this.rpc;
    this.rpc = undefined;
    const was = this.initialized !== undefined;
    this.initialized = undefined;
    if (rpc) await rpc.stop(1000);
    if (was) this.opts.onExit?.();
  }
}
