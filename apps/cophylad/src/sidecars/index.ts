// Supervising an external process: spawn it on a free loopback port, poll its health
// endpoint, restart it with backoff when it dies, and take it down with the daemon. A
// sidecar is always given an absolute command and binds to loopback only: the port comes
// from here, so nothing has to agree on one in advance. Its output goes to
// `data/sidecars/<name>.log`, rotated so a chatty engine cannot fill the disk. On a hybrid
// CPU the spawn carries the same affinity mask the daemon pinned itself to, because an
// inference process scheduled onto the efficiency cores runs three times slower.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Logger } from "../log.ts";

export type SidecarStatus = "starting" | "ready" | "unhealthy" | "restarting" | "failed" | "stopped";

export interface HealthSpec {
  /** Path on the sidecar's own port, `/health` by convention. */
  path: string;
  /** A whole URL instead, for a process that serves on a port of its own choosing; `{port}` is replaced. */
  url?: string;
  /** The endpoint speaks TLS with a certificate of its own: accepted, since it is loopback. */
  insecure?: boolean;
  intervalMs: number;
  /** The interval until the first check passes; `intervalMs` when absent. */
  startIntervalMs?: number;
  timeoutMs: number;
  /** How long the first health check may take to pass before the spawn is called failed. */
  startTimeoutMs: number;
}

export interface RestartSpec {
  backoffMs: number;
  maxMs: number;
  /** Restarts before the sidecar is given up on. */
  max: number;
}

export interface SidecarSpec {
  name: string;
  /** Absolute: a sidecar is never resolved through PATH. */
  command: string;
  /** `{port}` is replaced with the port this sidecar was given. */
  args: string[];
  /** A fixed port, for a process whose port its clients must know in advance; a free one otherwise. */
  port?: number;
  env?: Record<string, string>;
  cwd?: string;
  health: HealthSpec;
  /** The logical CPUs the child may run on; inherited by its own children. */
  affinity?: bigint;
  restart: RestartSpec;
}

export interface SidecarState {
  name: string;
  status: SidecarStatus;
  port: number;
  pid?: number;
  restarts: number;
  reason?: string;
}

/** Bytes a sidecar's log may reach before it is rotated to `<name>.log.1`. */
const LOG_CAP = 5 * 1024 * 1024;

/** A loopback port nothing is listening on. Racy in principle; the child binds it at once. */
export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export interface SidecarDeps {
  dir: string;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

export class Sidecar {
  readonly spec: SidecarSpec;
  readonly port: number;
  private deps: SidecarDeps;
  private log: Logger;
  private proc?: Subprocess<"ignore", "pipe", "pipe">;
  private status: SidecarStatus = "stopped";
  private reason?: string;
  private restarts = 0;
  private misses = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private handlers = new Set<(s: SidecarState) => void>();
  private ready?: { resolve: () => void; reject: (e: Error) => void };
  private logPath: string;

  constructor(spec: SidecarSpec, deps: SidecarDeps) {
    this.spec = spec;
    this.deps = deps;
    this.log = deps.log.child(spec.name);
    this.port = spec.port ?? freePort();
    this.logPath = join(deps.dir, `${spec.name}.log`);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  state(): SidecarState {
    return {
      name: this.spec.name,
      status: this.status,
      port: this.port,
      ...(this.proc?.pid !== undefined ? { pid: this.proc.pid } : {}),
      restarts: this.restarts,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    };
  }

  onChange(handler: (s: SidecarState) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private set(status: SidecarStatus, reason?: string): void {
    this.status = status;
    this.reason = reason;
    const s = this.state();
    for (const h of this.handlers) h(s);
  }

  /** Spawns and resolves when the health endpoint first answers; rejects when it never does. */
  start(): Promise<void> {
    if (this.status === "ready") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
      this.spawn();
    });
  }

  private settle(error?: Error): void {
    const ready = this.ready;
    if (!ready) return;
    this.ready = undefined;
    if (error) ready.reject(error);
    else ready.resolve();
  }

  private write(line: string): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true });
      try {
        if (statSync(this.logPath).size > LOG_CAP) renameSync(this.logPath, this.logPath + ".1");
      } catch {
        // no log yet, or another process holds it: appending is still fine
      }
      appendFileSync(this.logPath, line);
    } catch {
      // a log that cannot be written never stops the sidecar
    }
  }

  private pipe(stream: ReadableStream<Uint8Array> | undefined, tag: string): void {
    if (!stream) return;
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.write(decoder.decode(chunk).replace(/^/gm, `[${tag}] `));
    })().catch(() => {});
  }

  private spawn(): void {
    if (this.stopping) return;
    const args = this.spec.args.map((a) => a.replaceAll("{port}", String(this.port)));
    this.set("starting");
    this.write(`\n=== ${new Date().toISOString()} ${this.spec.command} ${args.join(" ")} (port ${this.port}) ===\n`);
    try {
      this.proc = Bun.spawn([this.spec.command, ...args], {
        ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}),
        env: { ...process.env, ...(this.spec.env ?? {}) },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      }) as Subprocess<"ignore", "pipe", "pipe">;
    } catch (e) {
      // A command that is not there throws here rather than exiting: a failure, not a restart.
      const reason = e instanceof Error ? e.message : String(e);
      this.log.error("sidecar could not start", { command: this.spec.command, error: reason });
      this.set("failed", reason);
      this.settle(new Error(`${this.spec.name}: ${reason}`));
      return;
    }
    this.pipe(this.proc.stdout as ReadableStream<Uint8Array>, "out");
    this.pipe(this.proc.stderr as ReadableStream<Uint8Array>, "err");
    this.log.info("sidecar started", { pid: this.proc.pid, port: this.port });
    if (this.spec.affinity !== undefined && this.proc.pid !== undefined) applyPid(this.proc.pid, this.spec.affinity, this.log);
    const proc = this.proc;
    void proc.exited.then((code) => this.onExit(proc, code));
    this.misses = 0;
    const startedAt = (this.deps.now ?? Date.now)();
    this.poll(startedAt);
  }

  private onExit(proc: Subprocess, code: number): void {
    if (this.proc !== proc) return;
    if (this.stopping || this.status === "stopped") return;
    // An exit before the first health check is a failure to start, not a healthy run that died.
    const before = this.status === "starting";
    this.log.warn("sidecar exited", { code, restarts: this.restarts, started: !before });
    if (before && this.restarts === 0) {
      this.set("failed", `exited ${code} before it was ready`);
      this.settle(new Error(`${this.spec.name}: exited ${code} before it was ready`));
      return;
    }
    this.restart(`exited ${code}`);
  }

  private restart(reason: string): void {
    if (this.stopping) return;
    if (this.restarts >= this.spec.restart.max) {
      this.log.error("sidecar given up on", { reason, restarts: this.restarts });
      this.set("failed", reason);
      this.settle(new Error(`${this.spec.name}: ${reason}`));
      return;
    }
    const delay = Math.min(this.spec.restart.maxMs, this.spec.restart.backoffMs * 2 ** this.restarts);
    this.restarts++;
    this.set("restarting", reason);
    this.log.info("sidecar restarting", { in: delay, attempt: this.restarts, reason });
    this.clearTimer();
    this.timer = setTimeout(() => this.spawn(), delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private poll(startedAt: number): void {
    this.clearTimer();
    // A starting process is checked on its own, shorter interval when it has one: most answer within a second.
    const ms = this.status === "starting" ? (this.spec.health.startIntervalMs ?? this.spec.health.intervalMs) : this.spec.health.intervalMs;
    this.timer = setTimeout(() => void this.check(startedAt), ms);
    this.timer.unref?.();
  }

  private async check(startedAt: number): Promise<void> {
    if (this.stopping) return;
    // The life this check asks about. An answer that comes back after that life ended says
    // nothing of the next, and must leave the timer alone: it holds the respawn by then.
    const proc = this.proc;
    const doFetch = this.deps.fetch ?? fetch;
    let ok = false;
    try {
      const url = this.spec.health.url ? this.spec.health.url.replaceAll("{port}", String(this.port)) : `${this.url}${this.spec.health.path}`;
      // Bun's fetch takes the TLS options beside the standard ones.
      const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { signal: AbortSignal.timeout(this.spec.health.timeoutMs) };
      if (this.spec.health.insecure) init.tls = { rejectUnauthorized: false };
      const res = await doFetch(url, init);
      ok = res.ok;
      // The body is not read: a health endpoint says everything in its status.
      await res.body?.cancel().catch(() => {});
    } catch {
      ok = false;
    }
    if (this.stopping || this.proc !== proc || this.status === "restarting" || this.status === "failed") return;
    if (ok) {
      this.misses = 0;
      if (this.status !== "ready") {
        this.log.info("sidecar ready", { port: this.port, restarts: this.restarts });
        this.set("ready");
        this.settle();
      }
      this.poll(startedAt);
      return;
    }
    if (this.status === "starting") {
      const now = (this.deps.now ?? Date.now)();
      if (now - startedAt > this.spec.health.startTimeoutMs) {
        this.log.error("sidecar never answered its health check", { after: now - startedAt });
        this.kill();
        this.set("failed", "health check never passed");
        this.settle(new Error(`${this.spec.name}: health check never passed`));
        return;
      }
      this.poll(startedAt);
      return;
    }
    this.misses++;
    // One miss is a slow answer; two says the process is there but not serving.
    if (this.misses >= 2 && this.status === "ready") this.set("unhealthy", "health check missed twice");
    this.poll(startedAt);
  }

  private kill(): void {
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
  }

  /** Stops for good: no restart follows. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    const proc = this.proc;
    this.settle(new Error(`${this.spec.name}: stopped`));
    if (!proc) {
      this.set("stopped");
      return;
    }
    this.kill();
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) {
      this.log.warn("sidecar did not stop; killing", { pid: proc.pid });
      try {
        proc.kill(9);
      } catch {
        // already gone
      }
      await Promise.race([proc.exited, Bun.sleep(1000)]);
    }
    this.proc = undefined;
    this.set("stopped");
    this.log.info("sidecar stopped");
  }
}

/** Applies a CPU affinity mask to a spawned child; a no-op where it is not supported. */
function applyPid(pid: number, mask: bigint, log: Logger): void {
  void (async () => {
    try {
      const { applyPidAffinity } = await import("../voice/affinity.ts");
      applyPidAffinity(pid, mask, log);
    } catch (e) {
      log.debug("affinity not applied to the sidecar", { error: e instanceof Error ? e.message : String(e) });
    }
  })();
}

export class Sidecars {
  private deps: SidecarDeps;
  private byName = new Map<string, Sidecar>();

  constructor(deps: SidecarDeps) {
    this.deps = deps;
    mkdirSync(deps.dir, { recursive: true });
  }

  /** Starts one, or returns the one already running under that name. */
  spawn(spec: SidecarSpec): Sidecar {
    const running = this.byName.get(spec.name);
    if (running) return running;
    const sidecar = new Sidecar(spec, this.deps);
    this.byName.set(spec.name, sidecar);
    return sidecar;
  }

  get(name: string): Sidecar | undefined {
    return this.byName.get(name);
  }

  list(): SidecarState[] {
    return [...this.byName.values()].map((s) => s.state());
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.byName.values()].map((s) => s.stop()));
    this.byName.clear();
  }

  /** Removes a stopped sidecar's record, so a later `spawn` starts a fresh one. */
  forget(name: string): void {
    this.byName.delete(name);
  }

  /** Empties the log directory; only the tests use it. */
  clearLogs(): void {
    rmSync(this.deps.dir, { recursive: true, force: true });
    mkdirSync(this.deps.dir, { recursive: true });
  }
}
