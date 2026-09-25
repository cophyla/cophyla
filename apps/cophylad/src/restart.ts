// `node.restart`: the daemon stops and starts again. It is refused with `conflict` while
// something would be cut off, the reasons `update.apply` gives (an open ask, a held hook
// response, an agent prompt or a brain request in flight), unless forced. Who starts the
// next daemon depends on who is attached: a desktop app on this machine starts cophylad
// whenever it finds none, as after an update, so the daemon leaves it that; otherwise the
// daemon starts its own successor: the same runtime, script, arguments, working directory
// and environment, detached, its output appended to `data/cophylad.log`, told the
// predecessor's pid in `COPHYLAD_RESTART` so it waits for that process to be gone before it
// opens the home. It is started once the daemon has stopped, never before: a child started
// while the listeners are open inherits their sockets on Windows, and could then never bind
// the port itself. What it needs is checked before the answer, so a restart that could not
// bring a successor up is refused while the daemon still runs. The answer goes out, the
// daemon stops (a stop that hangs is cut short), the successor starts, the daemon exits.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { RpcError } from "@cophyla/protocol";
import type { Logger } from "./log.ts";

/** Names the predecessor's pid in a successor's environment. */
export const RESTART_ENV = "COPHYLAD_RESTART";

/** Between the answer and the stop, so the answer and the audit row reach the client. */
const DELAY_MS = 200;
/** How long the stop may take before the daemon exits anyway. */
const STOP_TIMEOUT_MS = 20_000;
/** How long a successor waits for its predecessor to exit. */
export const SUCCESSOR_WAIT_MS = 60_000;

export interface RestartDeps {
  /** Why the daemon is not idle; empty means nothing is cut off. */
  busy: () => string[];
  /** A desktop app on this machine is attached: its shell starts the next daemon. */
  desktopAttached: () => boolean;
  /** Throws when a successor could not be started; `checkSuccessor` in production. */
  preflight: () => void;
  /** Starts the next daemon, once this one has stopped, and answers its pid; `spawnSuccessor` in production. */
  respawn: () => number;
  stop: () => Promise<void>;
  exit: (code: number) => void;
  log: Logger;
  delayMs?: number;
  stopTimeoutMs?: number;
}

export class Restart {
  private deps: RestartDeps;
  private restarting = false;

  constructor(deps: RestartDeps) {
    this.deps = deps;
  }

  /** Answers once the next daemon is sure to come up; the stop follows the answer. */
  request(opts: { force?: boolean; by: string }): void {
    if (this.restarting) throw new RpcError("conflict", "already restarting");
    const reasons = this.deps.busy();
    if (reasons.length > 0 && !opts.force) throw new RpcError("conflict", `busy: ${reasons.join("; ")}`, { reasons });
    const desktop = this.deps.desktopAttached();
    if (!desktop) {
      try {
        this.deps.preflight();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.deps.log.error("restart refused: the next daemon could not be started", { error: message });
        throw new RpcError("unavailable", `the next daemon could not be started: ${message}`);
      }
    }
    this.restarting = true;
    this.deps.log.info("restarting", {
      by: opts.by,
      next: desktop ? "the desktop app starts it" : "a successor, once this daemon has stopped",
      ...(reasons.length > 0 ? { cutOff: reasons } : {}),
    });
    const t = setTimeout(() => void this.run(desktop), this.deps.delayMs ?? DELAY_MS);
    t.unref?.();
  }

  private async run(desktop: boolean): Promise<void> {
    await this.stop();
    if (!desktop) {
      try {
        this.deps.log.info("successor started", { pid: this.deps.respawn() });
      } catch (e) {
        this.deps.log.error("the next daemon could not be started; start cophylad by hand", { error: e instanceof Error ? e.message : String(e) });
        this.deps.exit(1);
        return;
      }
    }
    this.deps.exit(0);
  }

  private async stop(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.deps.log.warn("the stop is taking too long; exiting");
        resolve();
      }, this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.deps.stop(), late]);
    } catch (e) {
      this.deps.log.error("stop failed; exiting", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What a successor needs: the runtime, the script, and the log it writes to. */
export function checkSuccessor(logPath: string): void {
  if (!existsSync(process.execPath)) throw new Error(`the runtime ${process.execPath} is gone`);
  const script = process.argv[1];
  if (!script || !existsSync(script)) throw new Error(`the daemon's script ${script ?? "(none)"} is gone`);
  closeSync(openSync(logPath, "a"));
}

/** The next daemon as this one was started: detached, no console, its output appended to the log. */
export function spawnSuccessor(logPath: string): number {
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, [RESTART_ENV]: String(process.pid) },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    // A spawn that failed also raises `error`; the throw below is what reports it.
    child.once("error", () => {});
    if (child.pid === undefined) throw new Error(`${process.execPath} did not start`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Whether a process is alive: one this user may not signal is. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Waits for a process to exit; false when it is still there at the deadline. */
export async function waitForExit(pid: number, timeoutMs = SUCCESSOR_WAIT_MS, pollMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > end) return false;
    await Bun.sleep(pollMs);
  }
  return true;
}
