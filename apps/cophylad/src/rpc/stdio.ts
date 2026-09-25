// Newline-delimited JSON-RPC 2.0 over a child process's stdio: what brain-link speaks to the
// brain and the ACP adapter to an agent. An `RpcPeer` does the protocol; this owns the
// process: spawn, the line reader, stderr, exit. No default timeout and no restart: the
// owner decides both. Exit rejects everything in flight with `unavailable`.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { RpcId } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { ChildRpcError, RpcPeer } from "./peer.ts";
import type { RequestOptions } from "./peer.ts";

export { ChildRpcError };
export type { RequestOptions };

export interface StdioRpcOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  log: Logger;
  /** A request from the child. Return the result; throw an `RpcError` to answer with a failure. */
  onRequest?: (method: string, params: unknown, id: RpcId) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Lines the child writes to stderr, trimmed. */
  onStderr?: (line: string) => void;
  /** Bytes of stderr kept for error messages. */
  stderrTail?: number;
}

const STDERR_TAIL = 4096;

export class StdioRpc {
  readonly pid: number | undefined;
  private child: ChildProcess;
  private opts: StdioRpcOptions;
  private peer: RpcPeer;
  private exited = false;
  private exitCode: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private stderrBuf = "";
  private stopping = false;

  constructor(opts: StdioRpcOptions) {
    this.opts = opts;
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.pid = child.pid;
    this.peer = new RpcPeer({
      write: (text) => this.writeLine(text),
      log: opts.log,
      label: opts.command,
      ...(opts.onRequest ? { onRequest: opts.onRequest } : {}),
      ...(opts.onNotification ? { onNotification: opts.onNotification } : {}),
    });
    child.on("error", (e) => {
      opts.log.warn("child error", { command: opts.command, error: e.message });
      this.onExit(null, null, e.message);
    });
    // A write racing the child's exit fails asynchronously on the pipe (EPIPE); without a
    // listener that is an uncaught error. The exit handler already deals with the child.
    child.stdin?.on("error", (e) => opts.log.debug("write to child failed", { error: e.message }));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      this.stderrBuf = (this.stderrBuf + d).slice(-(opts.stderrTail ?? STDERR_TAIL));
      if (opts.onStderr) for (const line of d.split(/\r?\n/)) if (line.trim()) opts.onStderr(line.trim());
    });
    if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => this.peer.onText(line));
    child.on("exit", (code, signal) => this.onExit(code, signal));
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** The last few KB of stderr, for an error message. */
  get stderr(): string {
    return this.stderrBuf;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, reason?: string): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = { code, signal };
    this.peer.close(reason ?? `child exited (${signal ?? code})`);
    this.opts.onExit?.(code, signal);
  }

  private writeLine(text: string): boolean {
    const stdin = this.child.stdin;
    if (this.exited || !stdin || stdin.destroyed) return false;
    stdin.write(text + "\n");
    return true;
  }

  write(message: unknown): boolean {
    return this.peer.write(message);
  }

  notify(method: string, params?: unknown): boolean {
    return this.peer.notify(method, params);
  }

  /** Sends a request. Rejects with `cancelled` on abort, `timeout` past `timeoutMs`, `unavailable` on exit. */
  request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
    return this.peer.request(method, params, opts);
  }

  /** Closes stdin, waits `graceMs` for the exit, then kills. Resolves once the child is gone. */
  async stop(graceMs = 1000): Promise<void> {
    this.stopping = true;
    if (this.exited) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        // A process that ignores the kill still resolves: nothing else can be done here.
        setTimeout(resolve, 500);
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
    });
  }

  /** Kills at once. */
  kill(): void {
    this.stopping = true;
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }

  get wasStopped(): boolean {
    return this.stopping;
  }

  get exit(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exitCode;
  }
}
