// A shared computer's session ends a little after its last socket closes: the tab was shut,
// the browser quit, the machine walked away from. Each paired session grant that holds no
// socket has a timer; a socket that says hello with it in time leaves it standing, and one
// that never comes ends it the way a revoke does. Its other ends are elsewhere: its own
// `expiresAt` (half a day at the latest, on the grants' clock), and the daemon stopping, since
// a session grant is kept in memory alone.

import type { Logger } from "../log.ts";
import type { Grants } from "./store.ts";

/** How long a session outlives its last socket: a reload's and a dropped connection's worth. */
export const SESSION_LINGER_MS = 2 * 60_000;

export interface SessionLingerDeps {
  grants: Grants;
  /** The sockets a grant holds now. */
  connected: (controller: string) => number;
  /** Ends a grant the way a revoke does. */
  end: (controller: string) => void;
  log: Logger;
  lingerMs?: number;
}

export class SessionLinger {
  private deps: SessionLingerDeps;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private off?: () => void;
  private stopped = false;

  constructor(deps: SessionLingerDeps) {
    this.deps = deps;
  }

  /** Follows the grants: a session that was just paired holds no socket yet, and has as long to say hello. */
  start(): void {
    this.off = this.deps.grants.onChange(() => this.sync());
    this.sync();
  }

  private paired(id: string): boolean {
    const row = this.deps.grants.get(id);
    return row !== undefined && row.session === true && this.deps.grants.status(row) === "active";
  }

  /** Arms a timer for every paired session with no socket and none running, and drops the timers of grants that went. */
  private sync(): void {
    if (this.stopped) return;
    for (const id of [...this.timers.keys()]) if (!this.paired(id)) this.disarm(id);
    // a timer already running is left to run: another grant's write never gives an idle session more time
    for (const row of this.deps.grants.rows()) if (row.session && this.paired(row.id) && !this.timers.has(row.id)) this.arm(row.id);
  }

  /** A socket of `id` closed: with none left, it has the whole linger to come back, from now. */
  closed(id: string): void {
    if (this.stopped || !this.paired(id)) return;
    this.disarm(id);
    this.arm(id);
  }

  private arm(id: string): void {
    if (this.deps.connected(id) > 0) return;
    const timer = setTimeout(() => this.fire(id), this.deps.lingerMs ?? SESSION_LINGER_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.timers.set(id, timer);
  }

  private disarm(id: string): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  private fire(id: string): void {
    this.timers.delete(id);
    if (this.stopped || !this.paired(id) || this.deps.connected(id) > 0) return;
    this.deps.log.info("a shared computer's session ended: its last socket closed", { grant: id });
    this.deps.end(id);
  }

  dispose(): void {
    this.stopped = true;
    this.off?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
