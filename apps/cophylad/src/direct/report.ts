// How direct connections fare, counted for the server: per day (UTC), how many connections
// opened on each kind of path, and how many failed, for phones and for nodes. Nothing that
// names the account, the node, a peer or an address is kept or sent. The counts wait in the
// store until a day is over; at every link-up the finished days go as `direct.report` (the
// server takes a node's day once) and are dropped. `[direct] report = false` counts nothing.

import type { DirectPathType, DirectReport } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";

const KEY = "direct_paths";
/** Days kept while the link is down; older ones are dropped unsent. */
const KEEP_DAYS = 7;
const COUNT_MAX = 1_000_000;

export type ReportKind = "client" | "node";
export type ReportPath = DirectPathType | "failed";

type Days = Record<string, Record<string, number>>;

export interface PathReportDeps {
  store: Store;
  enabled: boolean;
  /** Sends one day's report; throws when it could not. */
  send: (report: DirectReport) => Promise<void>;
  log: Logger;
  now?: () => number;
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export class PathReport {
  private deps: PathReportDeps;
  private flushing = false;

  constructor(deps: PathReportDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private read(): Days {
    try {
      const raw = this.deps.store.meta.get(KEY);
      return raw ? (JSON.parse(raw) as Days) : {};
    } catch {
      return {};
    }
  }

  private write(days: Days): void {
    this.deps.store.meta.set(KEY, JSON.stringify(days));
  }

  /** One connection that opened on `path`, or failed. */
  count(kind: ReportKind, path: ReportPath): void {
    if (!this.deps.enabled) return;
    const days = this.read();
    const day = utcDay(this.now());
    const counts = (days[day] ??= {});
    const key = `${kind}:${path}`;
    counts[key] = Math.min(COUNT_MAX, (counts[key] ?? 0) + 1);
    this.write(days);
  }

  /** Sends every finished day and drops it; a day too old goes unsent. */
  async flush(): Promise<void> {
    if (!this.deps.enabled || this.flushing) return;
    this.flushing = true;
    try {
      const today = utcDay(this.now());
      const oldest = utcDay(this.now() - KEEP_DAYS * 86_400_000);
      for (const day of Object.keys(this.read()).sort()) {
        if (day >= today) continue;
        const counts = this.read()[day] ?? {};
        if (day >= oldest && Object.keys(counts).length > 0) {
          const report: DirectReport = {
            day,
            counts: Object.entries(counts)
              .slice(0, 64)
              .map(([key, count]) => {
                const [kind, path] = key.split(":") as [ReportKind, ReportPath];
                return { kind, path, count };
              }),
          };
          try {
            await this.deps.send(report);
          } catch (e) {
            this.deps.log.debug("direct path report not sent; kept for the next link-up", { day, error: e instanceof Error ? e.message : String(e) });
            return;
          }
        }
        const left = this.read();
        delete left[day];
        this.write(left);
      }
    } finally {
      this.flushing = false;
    }
  }
}
