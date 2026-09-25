// One subscriber's share of the samples. A sample is sent when the subscriber's interval has
// passed since the last one it was sent; one that is skipped still hands its token counts
// on, so the next sample sent carries every `llm` and `profiles` delta since the last, and a
// client that sums what it is sent never misses a token however slowly it listens. With
// `processes: owners` the rows are summed per owner, one row each with `pid` 0: what a card
// that shows each owner's share needs, at a fraction of the bytes.

import type { ClientKind, MetricsSample, ProcessOwner } from "@cophyla/protocol";
import type { LlmCounts, ProfileCounts } from "./sampler.ts";

export type ProcessDetail = "all" | "owners";

/** The slowest a client may be sent samples by its kind: a phone or a browser is sent one every five seconds at most. */
export const CONTROLLER_MIN_INTERVAL_MS = 5000;

export function intervalFor(kind: ClientKind, intervalMs: number): number {
  return kind === "controller" ? Math.max(intervalMs, CONTROLLER_MIN_INTERVAL_MS) : intervalMs;
}

/** How early a sample may land and still be due: a timer's jitter, never a sample's worth, so a feed is sent no faster than its interval. */
const DUE_SLACK_MS = 250;

/** The slack for samples arriving `cadenceMs` apart. */
export function slackFor(cadenceMs: number): number {
  return Math.min(cadenceMs / 2, DUE_SLACK_MS);
}

export class SampleFeed {
  intervalMs: number;
  processes: ProcessDetail;
  private lastAt: number;
  /** The newest sample whose counts are held or sent: one offered again adds nothing. */
  private countedAt: number;
  private llm: LlmCounts = {};
  private profiles: ProfileCounts = {};

  /** `countedFrom`: the newest sample already counted elsewhere, in spend totals the subscriber was given. */
  constructor(intervalMs: number, processes: ProcessDetail = "all", countedFrom = 0) {
    this.intervalMs = intervalMs;
    this.processes = processes;
    this.lastAt = 0;
    this.countedAt = countedFrom;
  }

  /**
   * The sample to send now, or undefined while the interval has not passed. `slackMs` lets a
   * sample that lands a little early count as due, so a feed at the sampler's own rate is
   * never skipped for jitter.
   */
  offer(sample: MetricsSample, slackMs = 0): MetricsSample | undefined {
    this.count(sample);
    if (sample.at - this.lastAt < this.intervalMs - slackMs) return undefined;
    return this.take(sample);
  }

  /** The sample to send whatever the interval: the first one a subscriber is given, or the latest again when it subscribes again. */
  now(sample: MetricsSample): MetricsSample {
    this.count(sample);
    return this.take(sample);
  }

  /** Holds a sample's counts for the next one sent, without sending anything. */
  count(sample: MetricsSample): void {
    if (sample.at <= this.countedAt) return;
    this.countedAt = sample.at;
    addLlm(this.llm, sample.llm);
    addProfiles(this.profiles, sample.profiles);
  }

  private take(sample: MetricsSample): MetricsSample {
    this.lastAt = sample.at;
    const out: MetricsSample = { ...sample, llm: this.llm };
    if (Object.keys(this.profiles).length > 0) out.profiles = this.profiles;
    else delete out.profiles;
    if (this.processes === "owners") out.processes = byOwner(sample.processes);
    this.llm = {};
    this.profiles = {};
    return out;
  }
}

function addLlm(into: LlmCounts, from: LlmCounts): void {
  for (const [model, c] of Object.entries(from)) {
    const cur = into[model] ?? { in: 0, out: 0 };
    into[model] = { in: cur.in + c.in, out: cur.out + c.out };
  }
}

export function addProfiles(into: ProfileCounts, from: ProfileCounts | undefined): void {
  for (const [profile, c] of Object.entries(from ?? {})) {
    const cur = into[profile] ?? { in: 0, out: 0, cached: 0 };
    into[profile] = { in: cur.in + c.in, out: cur.out + c.out, cached: cur.cached + c.cached, ...(cur.cost !== undefined || c.cost !== undefined ? { cost: (cur.cost ?? 0) + (c.cost ?? 0) } : {}) };
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function ownerKey(owner: ProcessOwner): string {
  switch (owner.kind) {
    case "session":
      return `session:${owner.session}`;
    case "sidecar":
      return `sidecar:${owner.name}`;
    default:
      return owner.kind;
  }
}

function ownerName(owner: ProcessOwner): string {
  switch (owner.kind) {
    case "session":
      return owner.session;
    case "sidecar":
      return owner.name;
    default:
      return owner.kind;
  }
}

/** The rows summed per owner, in the order each owner first appears: `pid` and `parent` 0, `name` the owner's. */
export function byOwner(processes: MetricsSample["processes"]): MetricsSample["processes"] {
  const rows = new Map<string, MetricsSample["processes"][number]>();
  for (const p of processes) {
    const key = ownerKey(p.owner);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, { pid: 0, parent: 0, name: ownerName(p.owner), cpu: p.cpu, memory: p.memory, ...(p.vram !== undefined ? { vram: p.vram } : {}), owner: p.owner });
      continue;
    }
    row.cpu += p.cpu;
    row.memory += p.memory;
    if (p.vram !== undefined) row.vram = (row.vram ?? 0) + p.vram;
  }
  return [...rows.values()].map((r) => ({ ...r, cpu: round1(r.cpu) }));
}
