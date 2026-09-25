// A `codex app-server --stdio` child per Codex profile: newline-delimited JSON-RPC over
// stdio, stderr drained to the log, restarted with backoff when it exits, and on a new login.
// It is how cophylad lists threads and queues messages, over the thread store every app-server of
// the profile shares. The daemon a CLI starts to run its own threads (`--managed-daemon`) is
// the CLI's, and left alone. Server→client requests (approvals) only fire for threads this
// app-server hosts, which is never; any that arrive are declined.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "../../log.ts";

export interface CodexAppServerOptions {
  command: string;
  /** Inserted before cophylad's own arguments, so a fake or a wrapper can be named. */
  args: string[];
  env: Record<string, string | undefined>;
  log: Logger;
  version: string;
  onNotification?: (method: string, params: unknown) => void;
  callTimeoutMs?: number;
}

export interface InitializeResult {
  codexHome?: string;
  platformOs?: string;
  userAgent?: string;
}

/** Notification families cophylad never reads: deltas, diffs, search and realtime streams. */
export const OPT_OUT_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "command/exec/outputDelta",
  "process/outputDelta",
  "turn/diff/updated",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/item/started",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/item/completed",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
];

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const KILL_GRACE_MS = 1000;

/** What a declined approval looks like per request, and a JSON-RPC error for the rest. */
function declineFor(method: string): { result: unknown } | { error: { code: number; message: string } } {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { result: { decision: "denied" } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline" } };
    case "item/tool/requestUserInput":
      return { result: { answers: {} } };
    case "item/tool/call":
      return { result: { success: false, contentItems: [{ type: "inputText", text: "cophylad hosts no threads" }] } };
    default:
      return { error: { code: -32601, message: "cophylad hosts no threads" } };
  }
}

export class CodexAppServer {
  private opts: CodexAppServerOptions;
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopping = false;
  private backoffMs = BACKOFF_MIN_MS;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<InitializeResult>;
  private initialized?: InitializeResult;
  private log: Logger;

  constructor(opts: CodexAppServerOptions) {
    this.opts = opts;
    this.log = opts.log;
  }

  get alive(): boolean {
    return this.child !== undefined && this.initialized !== undefined;
  }

  get codexHome(): string | undefined {
    return this.initialized?.codexHome;
  }

  /** Spawns and completes the handshake. Concurrent callers share one attempt. */
  start(): Promise<InitializeResult> {
    if (this.initialized) return Promise.resolve(this.initialized);
    if (this.starting) return this.starting;
    this.starting = this.spawnAndInitialize().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawnAndInitialize(): Promise<InitializeResult> {
    this.stopping = false;
    const args = [...this.opts.args, "app-server", "--stdio", "-c", "check_for_update_on_startup=false"];
    const child = spawn(this.opts.command, args, { stdio: ["pipe", "pipe", "pipe"], env: this.opts.env as NodeJS.ProcessEnv, windowsHide: true });
    this.child = child;
    child.on("error", (e) => this.log.warn("app-server error", { error: e.message }));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      const line = d.trim();
      if (line) this.log.debug("app-server stderr", { line: line.slice(0, 500) });
    });
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.initialized = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("app-server exited"));
        this.pending.delete(id);
      }
      if (this.stopping) return;
      this.log.warn("app-server exited", { code, signal, restartInMs: this.backoffMs });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.start().catch((e) => this.log.warn("app-server restart failed", { error: e instanceof Error ? e.message : String(e) }));
      }, this.backoffMs);
      if (typeof this.restartTimer === "object" && "unref" in this.restartTimer) this.restartTimer.unref();
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    });

    const result = (await this.request("initialize", {
      clientInfo: { name: "cophylad", title: "cophylad", version: this.opts.version },
      capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    })) as InitializeResult;
    this.notify("initialized");
    this.initialized = result ?? {};
    this.backoffMs = BACKOFF_MIN_MS;
    this.log.info("app-server ready", { codexHome: result?.codexHome, platform: result?.platformOs });
    return this.initialized;
  }

  private onLine(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m === null || typeof m !== "object") return;
    const id = m["id"];
    if (typeof m["method"] === "string") {
      if (id !== undefined && id !== null) {
        // A server→client request: decline, cophylad hosts no threads.
        const answer = declineFor(m["method"]);
        this.write({ jsonrpc: "2.0", id, ...answer });
        this.log.debug("app-server request declined", { method: m["method"] });
        return;
      }
      this.opts.onNotification?.(m["method"], m["params"]);
      return;
    }
    if (typeof id === "number") {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (m["error"] !== undefined && m["error"] !== null) {
        const err = m["error"] as { code?: number; message?: string };
        p.reject(Object.assign(new Error(err.message ?? "app-server error"), { code: err.code }));
      } else p.resolve(m["result"]);
    }
  }

  private write(message: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(JSON.stringify(message) + "\n");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, this.opts.callTimeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** A request after the handshake; starts the child when it is down. */
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.initialized) await this.start();
    return (await this.request(method, params)) as T;
  }

  /** Stops the child; the next call starts a fresh one, which reads the profile's login anew. */
  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.initialized = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("app-server stopping"));
      this.pending.delete(id);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        resolve();
      }, KILL_GRACE_MS);
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
}
