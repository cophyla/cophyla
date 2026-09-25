// Token counting between samples. `LlmCounter` sums every `llm.complete` the platform
// routed, by `vendor/model`, and hands the sums over at the next sample. `ProfileSpend`
// watches the sessions' running stats: each `session.state` is diffed against the last
// counts seen for that session id, the delta credited to the session's harness profile, so
// a session that reports cumulative totals is counted once however often it is announced,
// and a session that ended is credited its last delta and then forgotten.

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

/** Ended session ids remembered, so a repeated `ended` announcement is not counted again. */
const ENDED_CAP = 1024;

export class ProfileSpend {
  private last = new Map<string, Seen>();
  private ended = new Set<string>();
  private pending: ProfileCounts = {};

  /** The sessions live at start: their totals are the baseline, not spend of this run. */
  prime(sessions: Session[]): void {
    for (const s of sessions) {
      const seen = seenOf(s);
      if (seen) this.last.set(s.id, seen);
    }
  }

  observe(session: Session): void {
    if (this.ended.has(session.id)) return;
    const now = seenOf(session);
    const was = this.last.get(session.id);
    if (now) {
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
    if (session.status === "ended") {
      this.last.delete(session.id);
      this.ended.add(session.id);
      if (this.ended.size > ENDED_CAP) this.ended.delete(this.ended.values().next().value!);
    } else if (now) this.last.set(session.id, now);
  }

  /** The per-profile deltas since the last drain; undefined when there were none. */
  drain(): ProfileCounts | undefined {
    const out = this.pending;
    this.pending = {};
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
