// The local usage counters: what this node sent to the hosted capabilities this calendar
// month (UTC), for the account card, and the caps the server last reported at a refresh.
// The server's count is the one that is billed, so a refresh replaces what was counted here;
// between refreshes the local count grows with every call. A cap of 0 means unknown (or
// nothing hosted): the card draws no bar for it.

import type { Usage, UsageMetric } from "@cophyla/protocol";
import type { Store } from "../store/index.ts";

/** `YYYY-MM` of the instant, in UTC: the same period the server meters by. */
export function period(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class UsageCounters {
  private store: Store;
  private now: () => number;

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  add(metric: UsageMetric, amount: number): void {
    if (!(amount > 0)) return;
    this.store.usage.add(period(this.now()), metric, amount);
  }

  /** What the server reported at a refresh: its counts and caps replace the local ones. */
  reported(usage: Usage): void {
    for (const [metric, m] of Object.entries(usage.metrics)) this.store.usage.setCap(usage.period, metric, m.used, m.cap);
  }

  /** This period's counters; every metric the server named, plus any counted here since. */
  snapshot(): Usage {
    const p = period(this.now());
    const rows = this.store.usage.get(p);
    const metrics: Usage["metrics"] = {};
    for (const [metric, r] of Object.entries(rows)) metrics[metric] = { used: r.used, cap: r.cap ?? 0 };
    return { period: p, metrics };
  }

  clear(): void {
    this.store.usage.clear();
  }
}
