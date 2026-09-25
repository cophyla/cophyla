// The grants' one timer: armed to the nearest end among the grants this node owns (a grant
// past its own `expiresAt`, a pending grant whose invite ran out), it ends each one that is
// due through the same path a revoke takes, then arms again. Any write to the grants re-arms
// it, and so does a change of role, since what this node owns follows the role: the
// primary's grants on the primary, and everywhere the ones minted on that node alone.

import type { Logger } from "../log.ts";
import type { GrantRow, Grants } from "./store.ts";

/** setTimeout's ceiling: a delay past it would fire at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface GrantClockDeps {
  grants: Grants;
  /** Whether this node ends `row` itself, or leaves it to the primary whose it is. */
  owns: (row: GrantRow) => boolean;
  /** Ends a grant that ran out, the way a revoke does. */
  end: (row: GrantRow, why: "expired" | "invite expired") => void;
  log: Logger;
  now?: () => number;
}

export class GrantClock {
  private deps: GrantClockDeps;
  private timer?: ReturnType<typeof setTimeout>;
  private off?: () => void;
  private stopped = false;

  constructor(deps: GrantClockDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  start(): void {
    this.off = this.deps.grants.onChange(() => this.arm());
    this.arm();
  }

  /** Grants that were due and could not be ended: left out until the role changes, so the timer never spins on them. */
  private stuck = new Set<string>();

  /** Arms the timer to the nearest end of what this node owns; `fresh` after a change of role forgets what was stuck. */
  arm(fresh = false): void {
    if (this.stopped) return;
    if (fresh) this.stuck.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const owned = this.deps.grants.rows().filter((r) => this.deps.owns(r) && !this.stuck.has(r.id));
    const next = this.deps.grants.nextEnd(owned);
    if (next === undefined) return;
    this.timer = setTimeout(() => this.fire(), Math.min(Math.max(0, next - this.now()), MAX_DELAY_MS));
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  private fire(): void {
    this.timer = undefined;
    const at = this.now();
    for (const row of this.deps.grants.rows()) {
      if (!this.deps.owns(row) || this.stuck.has(row.id)) continue;
      const why = this.deps.grants.ended(row, at);
      if (!why) continue;
      try {
        this.deps.end(row, why);
        this.deps.log.info("a grant ran out", { grant: row.id, kind: row.kind, name: row.name, why });
      } catch (e) {
        this.deps.log.warn("a grant that ran out could not be ended", { grant: row.id, why, error: e instanceof Error ? e.message : String(e) });
      }
      if (this.deps.grants.get(row.id) && this.deps.grants.ended(this.deps.grants.get(row.id)!, at)) this.stuck.add(row.id);
    }
    this.arm();
  }

  dispose(): void {
    this.stopped = true;
    this.off?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
