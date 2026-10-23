// Token counting between samples. `LlmCounter` sums every `llm.complete` the platform
// routed, by `vendor/model`, and hands the sums over at the next sample. `ProfileSpend`
// watches the sessions' running stats: each `session.state` is diffed against the last
// counts seen for that session id, the delta credited to the session's harness profile, so
// a session that reports cumulative totals is counted once however often it is announced. A
// session that ended keeps its counts, for a resume under the same id to count on from, and is
// still credited what its totals climb by after the end (Claude's cost record, read as the
// session leaves). The counts kept are the highest seen: totals that read lower
// for a while (a transcript read again, another thread's stats briefly in their place) are not
// spent again when they climb back. Nothing
// is credited until `prime`: the sessions announce themselves as the daemon starts, each
// transcript read again whole, and those totals are what was spent before this run, not spend
// of it. Counted, every restart would spend every live session's whole history again. For the
// same reason a session met for the first time after it, but started before it or already
// ended (one closed before the daemon started, reopened or announced again), counts from what
// it shows then.

import type { Session } from "@cophyla/protocol";
import type { LlmCounts, ProfileCounts } from "./sampler.ts";

export class LlmCounter {
  private counts: LlmCounts = {};

  count(model: string, usage: { in: number; out: number }): void {
    const cur = this.counts[model] ?? { in: 0, out: 0 };
    this.counts[model] = { in: cur.in + usage.in, out: cur.out + usage.out };
  }

  /** The counts since the last drain; empty when nothing was counted. */
  drain(): LlmCounts {
    const out = this.counts;
    this.counts = {};
    return out;
  }
}

interface Seen {
  in: number;
  out: number;
  cached: number;
  cost: number;
}

const seenOf = (s: Session): Seen | undefined => {
  const t = s.stats?.tokens;
  if (!t) return undefined;
  return { in: t.in, out: t.out, cached: (t.cacheRead ?? 0) + (t.cacheWrite ?? 0), cost: s.stats?.cost ?? 0 };
};

const highest = (a: Seen, b: Seen): Seen => ({ in: Math.max(a.in, b.in), out: Math.max(a.out, b.out), cached: Math.max(a.cached, b.cached), cost: Math.max(a.cost, b.cost) });

/**
 * How many ended sessions keep their counts, so a late climb (a cost record) or a resume under
 * the same id counts on from where they stood; the oldest is forgotten past it.
 */
const ENDED_CAP = 1024;

export class ProfileSpend {
  private last = new Map<string, Seen>();
  private ended = new Set<string>();
  /** The sessions whose growth is spend of this run: live at priming, or met live since. */
  private counting = new Set<string>();
  private pending: ProfileCounts = {};
  private primed = false;
  private primedAt = -Infinity;

  /**
   * The sessions live at start: their totals as they stand now are the baseline, not spend of
   * this run, whatever they were announced as before; spend counts from here, `at`.
   */
  prime(sessions: Session[], at = Date.now()): void {
    for (const s of sessions) {
      this.last.set(s.id, seenOf(s) ?? { in: 0, out: 0, cached: 0, cost: 0 });
      this.counting.add(s.id);
    }
    this.pending = {};
    this.primed = true;
    this.primedAt = at;
  }

  observe(session: Session): void {
    const ended = session.status === "ended";
    // Resumed: what it spends from here is past the counts it ended with.
    if (!ended) this.ended.delete(session.id);
    const now = seenOf(session);
    let was = this.last.get(session.id);
    if (this.primed && !this.counting.has(session.id) && !ended) {
      // Met live for the first time since priming. Started before it (running unseen, or closed
      // before the daemon started and reopened), what it shows was spent before: the baseline.
      this.counting.add(session.id);
      if (session.startedAt < this.primedAt && now) was = was ? highest(was, now) : now;
    }
    if (now && this.counting.has(session.id)) {
      const delta = {
        in: Math.max(0, now.in - (was?.in ?? 0)),
        out: Math.max(0, now.out - (was?.out ?? 0)),
        cached: Math.max(0, now.cached - (was?.cached ?? 0)),
        cost: Math.max(0, now.cost - (was?.cost ?? 0)),
      };
      if (delta.in + delta.out + delta.cached + delta.cost > 0) {
        const cur = this.pending[session.profile] ?? { in: 0, out: 0, cached: 0, cost: 0 };
        this.pending[session.profile] = { in: cur.in + delta.in, out: cur.out + delta.out, cached: cur.cached + delta.cached, cost: (cur.cost ?? 0) + delta.cost };
      }
    }
    if (now) this.last.set(session.id, was ? highest(was, now) : now);
    if (ended && !this.ended.has(session.id)) {
      this.ended.add(session.id);
      if (this.ended.size > ENDED_CAP) {
        const oldest = this.ended.values().next().value!;
        this.ended.delete(oldest);
        this.last.delete(oldest);
        this.counting.delete(oldest);
      }
    }
  }

  /** The per-profile deltas since the last drain; undefined when there were none. */
  drain(): ProfileCounts | undefined {
    const out = this.pending;
    this.pending = {};
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
