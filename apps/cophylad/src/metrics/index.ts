// The metrics module: samples this machine through an engine on an adaptive timer, owns
// every process by the tree, keeps the live samples in a ring, folds each finished minute
// into a rollup in the store, watches the thresholds, counts the tokens the platform routed
// and the sessions spent, carries each profile's plan limits (`limits.ts`, read while a
// client subscribes), and delivers samples to the clients that subscribed at the rate
// each asked for (see `delivery.ts`), and sums a range's spend per profile for a client
// that shows it. The timer is an unref'd `setTimeout` chain, never an interval: a tick
// that runs long delays the next rather than piling up, and a sampler alone never keeps the
// process alive. `tick` is public so the tests drive it without a clock.

import { RpcError } from "@cophyla/protocol";
import type { MetricsSample, ProfileLimits, Session, SpendTotals } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { MetricsConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { addProfiles, SampleFeed, slackFor } from "./delivery.ts";
import type { ProcessDetail } from "./delivery.ts";
import type { MetricsEngine, RawSample } from "./engine.ts";
import { PressureTracker } from "./pressure.ts";
import type { Level, Resource } from "./pressure.ts";
import { mergeHistory, MINUTE_MS, minuteOf, rollup } from "./rollup.ts";
import { Sampler } from "./sampler.ts";
import type { ProfileCounts } from "./sampler.ts";
import { LlmCounter, ProfileSpend } from "./tokens.ts";

export interface MetricsDeps {
  config: MetricsConfig;
  nodeId: string;
  store: Store;
  bus: Bus;
  log: Logger;
  engine: MetricsEngine;
  sessions: { pids(): Map<number, string>; list(): Session[] };
  brainPid: () => number | undefined;
  sidecarPids: () => Map<number, string>;
  /** Delivers one sample to one subscriber; false when the subscriber is gone. */
  deliver: (client: string, sample: MetricsSample) => boolean;
  /** Each profile's plan limits: the latest readings, and a refresh of the ones due. */
  limits?: { latest(): Record<string, ProfileLimits> | undefined; refresh(): Promise<void> };
  now?: () => number;
  /** No timer: the owner drives `tick()`. For tests. */
  manual?: boolean;
}

export interface MetricsSnapshot {
  intervalMs: number;
  subscribers: { client: string; intervalMs: number; processes: ProcessDetail }[];
  ring: number;
  pressure: { resource: Resource; level: Level }[];
  engine: string;
}

export interface TimeRange {
  from?: number;
  to?: number;
}

/** Live samples kept: 15 minutes at the one-second floor. */
export const RING_CAP = 900;
/** Rollups written between two prunes. */
const PRUNE_EVERY = 60;
/** Rollups `query` returns without a range, and the most with one. */
const QUERY_RECENT = 5;
const QUERY_MAX = 60;
/** The range `spend` sums without one. */
const SPEND_DAY_MS = 86_400_000;

export class Metrics {
  private deps: MetricsDeps;
  private log: Logger;
  private sampler: Sampler;
  private pressure: PressureTracker;
  private llm = new LlmCounter();
  private profileSpend = new ProfileSpend();
  private ring: MetricsSample[] = [];
  private open: MetricsSample[] = [];
  private openMinute?: number;
  private latestSample?: MetricsSample;
  private subscribers = new Map<string, SampleFeed>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  private started = false;
  private disposed = false;
  private puts = 0;
  private offBus: (() => void)[] = [];

  constructor(deps: MetricsDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.sampler = new Sampler(deps.nodeId);
    this.pressure = new PressureTracker({ warn: deps.config.warn, critical: deps.config.critical });
    // A session of another node reaches this bus through the link; its owner counts it.
    this.offBus.push(deps.bus.on("session.state", (s) => s.node === deps.nodeId && this.profileSpend.observe(s)));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get enabled(): boolean {
    return this.deps.config.enabled;
  }

  /** Milliseconds between samples now: the smallest subscribed interval, floored, or the idle one. */
  intervalMs(): number {
    let min = Infinity;
    for (const s of this.subscribers.values()) min = Math.min(min, s.intervalMs);
    return min === Infinity ? this.deps.config.idle_interval_ms : Math.max(min, this.deps.config.min_interval_ms);
  }

  // --- lifecycle ------------------------------------------------------------------------

  /** Primes the sampler with a first reading and starts the timer. */
  async start(): Promise<void> {
    if (!this.enabled || this.started || this.disposed) return;
    this.started = true;
    this.profileSpend.prime(this.deps.sessions.list());
    await this.tick();
    this.arm();
    this.log.info("metrics on", { engine: this.deps.engine.name, idleMs: this.deps.config.idle_interval_ms, retentionDays: this.deps.config.retention_days });
  }

  private arm(): void {
    if (!this.started || this.disposed || this.deps.manual) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.arm());
    }, this.intervalMs());
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  /** Flushes the open minute, shuts the engine. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const off of this.offBus) off();
    this.offBus = [];
    this.flushMinute();
    this.deps.engine.dispose?.();
  }

  // --- the tick ------------------------------------------------------------------------

  /** One sample: build, ring, rollup at the minute change, pressure, delivery. Serialised. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    if (this.disposed) return;
    let raw: RawSample;
    try {
      raw = await this.deps.engine.sample();
    } catch (e) {
      this.log.warn("sample failed", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const roots = {
      sessions: this.deps.sessions.pids(),
      platform: process.pid,
      brain: this.deps.brainPid(),
      sidecars: this.deps.sidecarPids(),
    };
    // The counters are drained only into a sample: what was counted before the priming reading belongs to no sample.
    const primed = this.sampler.primed;
    const sample = this.sampler.build(raw, roots, primed ? this.llm.drain() : {}, primed ? this.profileSpend.drain() : undefined);
    if (!sample) return;
    // The limits are read only while someone looks at them; each sample carries the latest.
    if (this.subscribers.size > 0) this.refreshLimits();
    const limits = this.deps.limits?.latest();
    if (limits) sample.limits = limits;
    this.latestSample = sample;
    this.ring.push(sample);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    const minute = minuteOf(sample.at);
    if (this.openMinute !== undefined && minute !== this.openMinute) this.flushMinute();
    this.openMinute = minute;
    this.open.push(sample);
    this.watch(sample);
    const slack = slackFor(this.intervalMs());
    for (const [client, feed] of [...this.subscribers]) {
      const due = feed.offer(sample, slack);
      if (due && !this.deps.deliver(client, due)) this.subscribers.delete(client);
    }
  }

  /** Writes the open minute's rollup and prunes now and then. */
  private flushMinute(): void {
    if (this.openMinute === undefined || this.open.length === 0) return;
    const row = rollup(this.open, this.deps.nodeId, this.openMinute);
    this.open = [];
    if (!row) return;
    try {
      this.deps.store.metrics.put(this.deps.nodeId, this.openMinute, row);
      if (++this.puts % PRUNE_EVERY === 0) {
        const gone = this.deps.store.metrics.prune(this.now() - this.deps.config.retention_days * 86_400_000);
        if (gone > 0) this.log.debug("metrics pruned", { rows: gone });
      }
    } catch (e) {
      this.log.warn("rollup not stored", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private watch(s: MetricsSample): void {
    const readings: [Resource, number][] = [
      ["cpu", s.cpu],
      ["memory", s.memory.total > 0 ? (s.memory.used / s.memory.total) * 100 : 0],
    ];
    if (s.gpu && s.gpu.length > 0) {
      readings.push(["gpu", Math.max(...s.gpu.map((g) => g.util))]);
      readings.push(["vram", Math.max(...s.gpu.map((g) => (g.vramTotal > 0 ? (g.vramUsed / g.vramTotal) * 100 : 0)))]);
    }
    for (const [resource, pct] of readings) {
      const level = this.pressure.update(resource, pct);
      if (level === undefined) continue;
      this.log.info("node pressure", { resource, level, pct: Math.round(pct) });
      this.deps.bus.emit("node.pressure", { at: s.at, node: this.deps.nodeId, resource, level });
    }
  }

  // --- subscribers ------------------------------------------------------------------------

  /**
   * Delivers `latest()` at once and every sample due at `intervalMs` (floored) from then on.
   * A subscriber that subscribes again is given the latest again, carrying the counts it had
   * not been sent yet and none twice. With `spend`, the range's spend is summed through that
   * latest in the same turn: every count before it is in the totals, every one after it in
   * the samples to come.
   */
  subscribe(client: string, intervalMs: number, processes: ProcessDetail = "all", spend?: TimeRange): SpendTotals | undefined {
    if (!this.enabled) throw new RpcError("unsupported", "metrics are off on this node");
    const floored = Math.max(intervalMs, this.deps.config.min_interval_ms);
    const latest = this.latestSample;
    let feed = this.subscribers.get(client);
    if (feed) {
      feed.intervalMs = floored;
      feed.processes = processes;
    } else {
      feed = new SampleFeed(floored, processes);
      this.subscribers.set(client, feed);
    }
    if (latest && !this.deps.deliver(client, feed.now(latest))) this.subscribers.delete(client);
    this.refreshLimits();
    this.arm();
    return spend ? this.spend(this.deps.nodeId, spend) : undefined;
  }

  unsubscribe(client: string): boolean {
    const had = this.subscribers.delete(client);
    if (had) this.arm();
    return had;
  }

  private refreshLimits(): void {
    this.deps.limits?.refresh().catch((e: unknown) => this.log.debug("plan limits failed", { error: e instanceof Error ? e.message : String(e) }));
  }

  onDisconnect(client: string): void {
    this.unsubscribe(client);
  }

  subscribed(client: string): boolean {
    return this.subscribers.has(client);
  }

  // --- reads --------------------------------------------------------------------------------

  latest(): MetricsSample | undefined {
    return this.latestSample;
  }

  /** The stored rollups within the range, then the open minute's live samples. Only this node's: a peer's are forwarded before they get here. */
  history(node: string, range: TimeRange = {}): MetricsSample[] {
    if (!this.enabled) throw new RpcError("unsupported", "metrics are off on this node");
    if (node !== this.deps.nodeId) throw new RpcError("not_found", `no node ${node} here`);
    const current = this.openMinute ?? minuteOf(this.now());
    const rollups = this.deps.store.metrics.range(this.deps.nodeId, { ...(range.from !== undefined ? { from: minuteOf(range.from) } : {}), ...(range.to !== undefined ? { to: range.to } : {}) });
    return mergeHistory({ rollups, ring: this.ring, ...(range.from !== undefined ? { from: range.from } : {}), ...(range.to !== undefined ? { to: range.to } : {}), currentMinuteStart: current });
  }

  /**
   * Each profile's tokens and cost over the range, the last day without one: the stored
   * minutes' rollups, read for their spend alone, then the open minute's live samples. `at`
   * is the newest sample counted; `subscribe` sums it in the turn that starts a feed, so the
   * feed's samples after `at` count none twice.
   */
  spend(node: string, range: TimeRange = {}): SpendTotals {
    if (!this.enabled) throw new RpcError("unsupported", "metrics are off on this node");
    if (node !== this.deps.nodeId) throw new RpcError("not_found", `no node ${node} here`);
    const now = this.now();
    const from = range.from ?? now - SPEND_DAY_MS;
    const to = range.to ?? Number.MAX_SAFE_INTEGER;
    const current = this.openMinute ?? minuteOf(now);
    const profiles: ProfileCounts = {};
    let at = 0;
    for (const row of this.deps.store.metrics.profiles(this.deps.nodeId, { from: minuteOf(from), to: Math.min(to, current - 1) })) {
      addProfiles(profiles, row.profiles);
      at = Math.max(at, row.minute);
    }
    for (const s of this.ring) {
      if (s.at < current || s.at < from || s.at > to) continue;
      addProfiles(profiles, s.profiles);
      at = Math.max(at, s.at);
    }
    // Without an end the sums reach the newest sample, whether or not it spent anything.
    if (range.to === undefined && this.latestSample) at = Math.max(at, this.latestSample.at);
    return { at, profiles };
  }

  /** For the brain: without a range the last five rollups and the latest sample; with one, the newest sixty within it. */
  query(node: string, range?: TimeRange): MetricsSample[] {
    if (!this.enabled) throw new RpcError("unsupported", "metrics are off on this node");
    if (node !== this.deps.nodeId) throw new RpcError("not_found", `no node ${node} here`);
    if (!range || (range.from === undefined && range.to === undefined)) {
      const recent = this.deps.store.metrics.latest(this.deps.nodeId, QUERY_RECENT);
      return this.latestSample ? [...recent, this.latestSample] : recent;
    }
    const all = this.history(node, range);
    return all.slice(-QUERY_MAX);
  }

  countLlm(model: string, usage: { in: number; out: number }): void {
    this.llm.count(model, usage);
  }

  snapshot(): MetricsSnapshot {
    return {
      intervalMs: this.intervalMs(),
      subscribers: [...this.subscribers].map(([client, s]) => ({ client, intervalMs: s.intervalMs, processes: s.processes })),
      ring: this.ring.length,
      pressure: this.pressure.raised(),
      engine: this.deps.engine.name,
    };
  }
}

export { MINUTE_MS };
