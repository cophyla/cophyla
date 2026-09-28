// The metrics module driven by `tick()` over a scripted engine and a fixed clock: the
// adaptive rate, the ring's bound, the rollup at the minute change and the prune, pressure
// with hysteresis and its bus payload, per-client delivery at each client's interval and
// the drop of a client that is gone, history merged from rollups and the ring, the query's
// caps, llm counts and profile spend landing in the next sample, a slow subscriber sent the
// counts of the samples it skipped, the rows summed per owner, a controller's floor, and the
// spend totals a subscription starts from, which its later samples complete; and the plan
// limits every sample carries, read only while someone subscribes.

import { describe, expect, test } from "bun:test";
import { MetricsSample as MetricsSampleSchema } from "@cophyla/protocol";
import type { MetricsSample, ProfileLimits, Session } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { parseConfig } from "../src/config/load.ts";
import { silentLogger } from "../src/log.ts";
import { CONTROLLER_MIN_INTERVAL_MS, intervalFor } from "../src/metrics/delivery.ts";
import { FakeEngine } from "../src/metrics/fake.ts";
import type { RawSample } from "../src/metrics/engine.ts";
import { Metrics, RING_CAP } from "../src/metrics/index.ts";
import type { MetricsDeps } from "../src/metrics/index.ts";
import { Store } from "../src/store/index.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const PROFILE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
const T0 = Math.floor(1_700_000_000_000 / 60000) * 60000 + 40_000; // 40 s into a minute

interface Rig {
  metrics: Metrics;
  engine: FakeEngine;
  store: Store;
  bus: Bus;
  delivered: Map<string, MetricsSample[]>;
  gone: Set<string>;
  clock: { now: number };
  /** Advances the clock by `ms` and feeds one reading at the machine's `busyPct`, then ticks. */
  step(ms?: number, spec?: { busyPct?: number; memPct?: number; gpuUtil?: number }): Promise<MetricsSample | undefined>;
  dispose(): void;
}

function rig(toml = "", opts: { sessions?: Session[]; limits?: MetricsDeps["limits"]; pids?: Map<number, string>; partitions?: MetricsDeps["partitions"] } = {}): Rig {
  const config = parseConfig(toml).metrics;
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const clock = { now: T0 };
  const delivered = new Map<string, MetricsSample[]>();
  const gone = new Set<string>();
  let monoS = 0;
  let last: RawSample = FakeEngine.tree({}, { monoS: 0 });
  last.at = clock.now;
  last.cpu = { busyNs: 0, totalNs: 0 };
  const engine = new FakeEngine(() => last);
  const metrics = new Metrics({
    config,
    nodeId: NODE,
    store,
    bus,
    log: silentLogger,
    engine,
    sessions: { pids: () => opts.pids ?? new Map([[30, SESSION]]), list: () => opts.sessions ?? [] },
    ...(opts.partitions ? { partitions: opts.partitions } : {}),
    brainPid: () => 21,
    sidecarPids: () => new Map([[22, "tts-py"]]),
    deliver: (client, sample) => {
      if (gone.has(client)) return false;
      let list = delivered.get(client);
      if (!list) delivered.set(client, (list = []));
      list.push(sample);
      return true;
    },
    now: () => clock.now,
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  const step: Rig["step"] = async (ms = 1000, spec = {}) => {
    clock.now += ms;
    monoS += ms / 1000;
    const busy = spec.busyPct ?? 10;
    const prev = last;
    const raw = FakeEngine.tree({ 30: monoS * 0.1 }, { monoS });
    raw.at = clock.now;
    // Busy time grows at `busy` percent of the interval since the previous reading.
    const dTotal = Number(raw.monoNs - prev.monoNs) * raw.cores;
    raw.cpu = { busyNs: prev.cpu.busyNs + (dTotal * busy) / 100, totalNs: prev.cpu.totalNs + dTotal };
    if (spec.memPct !== undefined) raw.memory = { used: (16e9 * spec.memPct) / 100, total: 16e9 };
    if (spec.gpuUtil !== undefined) raw.gpu = [{ name: "g", util: spec.gpuUtil, vramUsed: 1e9, vramTotal: 8e9, processes: new Map() }];
    last = raw;
    await metrics.tick();
    return metrics.latest();
  };
  return { metrics, engine, store, bus, delivered, gone, clock, step, dispose: () => metrics.dispose() };
}

describe("metrics module", () => {
  test("the first tick primes, the second yields a sample; the rate follows the subscribers", async () => {
    const r = rig("[metrics]\nidle_interval_ms = 15000\nmin_interval_ms = 1000\n");
    expect(await r.step()).toBeUndefined();
    const s = (await r.step(1000, { busyPct: 25 }))!;
    expect(MetricsSampleSchema.safeParse(s).success).toBe(true);
    expect(s.cpu).toBe(25);
    expect(s.node).toBe(NODE);
    expect(r.metrics.intervalMs()).toBe(15000);
    r.metrics.subscribe("cli_a", 2000);
    expect(r.metrics.intervalMs()).toBe(2000);
    // Under the floor: floored. Off again: the idle rate.
    r.metrics.subscribe("cli_b", 10);
    expect(r.metrics.intervalMs()).toBe(1000);
    expect(r.metrics.snapshot().subscribers).toEqual([
      { client: "cli_a", intervalMs: 2000, processes: "all" },
      { client: "cli_b", intervalMs: 1000, processes: "all" },
    ]);
    r.metrics.unsubscribe("cli_b");
    r.metrics.onDisconnect("cli_a");
    expect(r.metrics.intervalMs()).toBe(15000);
    r.dispose();
  });

  test("a subscriber gets the latest at once, then every sample due at its own interval; a gone client is dropped", async () => {
    const r = rig();
    await r.step();
    await r.step();
    r.metrics.subscribe("fast", 1000);
    r.metrics.subscribe("slow", 3000);
    expect(r.delivered.get("fast")!.length).toBe(1);
    expect(r.delivered.get("slow")!.length).toBe(1);
    for (let i = 0; i < 6; i++) await r.step(1000);
    expect(r.delivered.get("fast")!.length).toBe(7);
    expect(r.delivered.get("slow")!.length).toBe(3);
    expect(r.delivered.get("slow")!.map((s) => s.at)).toEqual([T0 + 2000, T0 + 5000, T0 + 8000]);
    r.gone.add("fast");
    await r.step(1000);
    expect(r.metrics.subscribed("fast")).toBe(false);
    expect(r.metrics.subscribed("slow")).toBe(true);
    r.dispose();
  });

  test("the ring is bounded and a finished minute becomes one rollup; the retention prune runs", async () => {
    const r = rig("[metrics]\nretention_days = 1\n");
    // 40 s into the minute: 20 samples close it, the 21st opens the next.
    for (let i = 0; i < 22; i++) await r.step(1000);
    expect(r.store.metrics.count(NODE)).toBe(1);
    const row = r.store.metrics.range(NODE)[0]!;
    expect(row.at).toBe(Math.floor(T0 / 60000) * 60000);
    expect(MetricsSampleSchema.safeParse(row).success).toBe(true);
    expect(row.processes.some((p) => p.owner.kind === "session")).toBe(true);
    for (let i = 0; i < RING_CAP + 50; i++) await r.step(1000);
    expect(r.metrics.snapshot().ring).toBe(RING_CAP);
    // Every 60 rollups the store is pruned to the retention: an old row planted before is gone after.
    r.store.metrics.put(NODE, 1, row);
    for (let i = 0; i < 60 * 60 + 10; i++) await r.step(1000);
    expect(r.store.metrics.range(NODE, { to: 1 })).toEqual([]);
    // Disposing flushes the open minute.
    const before = r.store.metrics.count(NODE);
    r.dispose();
    expect(r.store.metrics.count(NODE)).toBe(before + 1);
    r.dispose();
  }, 20_000);

  test("pressure crosses on the bus with the node and resource, with hysteresis, for every resource", async () => {
    const r = rig("[metrics]\nwarn = 80\ncritical = 95\n");
    const seen: { resource: string; level: string; node: string; at: number }[] = [];
    r.bus.on("node.pressure", (p) => seen.push(p));
    await r.step();
    await r.step(1000, { busyPct: 10 });
    await r.step(1000, { busyPct: 85 });
    expect(seen).toEqual([{ at: T0 + 3000, node: NODE, resource: "cpu", level: "warn" }]);
    await r.step(1000, { busyPct: 96, memPct: 96, gpuUtil: 50 });
    expect(seen.map((p) => `${p.resource}:${p.level}`)).toEqual(["cpu:warn", "cpu:critical", "memory:critical"]);
    await r.step(1000, { busyPct: 50, memPct: 50, gpuUtil: 99 });
    await r.step(1000, { busyPct: 50, memPct: 50, gpuUtil: 99 });
    expect(seen.map((p) => `${p.resource}:${p.level}`)).toEqual(["cpu:warn", "cpu:critical", "memory:critical", "gpu:critical", "cpu:normal", "memory:normal"]);
    expect(r.metrics.snapshot().pressure).toEqual([{ resource: "gpu", level: "critical" }]);
    r.dispose();
  });

  test("history merges rollups and the open minute; query caps at five rollups plus the latest, or sixty in a range", async () => {
    const r = rig();
    await r.step();
    for (let i = 0; i < 20 * 60; i++) await r.step(1000);
    expect(r.store.metrics.count(NODE)).toBe(20);
    const all = r.metrics.history(NODE, {});
    const rollups = r.store.metrics.range(NODE);
    expect(all.slice(0, 20)).toEqual(rollups);
    // The open minute's samples follow the rollups, from its start.
    const live = all.slice(20);
    expect(live.length).toBe(42);
    expect(live[0]!.at).toBe(rollups[19]!.at + 60_000);
    expect(r.metrics.history(NODE, { from: r.clock.now - 90_000 }).length).toBeLessThan(all.length);
    expect(() => r.metrics.history("node_01ARZ3NDEKTSV4RRFFQ69G5FAW", {})).toThrow(/no node/);
    const q = r.metrics.query(NODE);
    expect(q.length).toBe(6);
    expect(q[5]).toBe(r.metrics.latest());
    expect(r.metrics.query(NODE, { from: 0 }).length).toBe(60);
    r.dispose();
  }, 20_000);

  test("llm counts and profile spend land in the next sample and only there", async () => {
    const live: Session = { id: SESSION, node: NODE, harness: "claude", profile: PROFILE, native: { id: "n", pid: 30, transport: "pipe" }, origin: "user", cwd: "/w", tags: [], status: "busy", startedAt: 1, lastActivity: 2, stats: { turns: 1, cost: 0.5, tokens: { in: 100, out: 10 } } };
    const r = rig("", { sessions: [live] });
    await r.metrics.start();
    // Counted before any sample: the priming reading swallows nothing; the first sample carries it.
    r.metrics.countLlm("gemini/gemini-3.8-flash", { in: 10, out: 2 });
    r.bus.emit("session.state", { ...live, stats: { turns: 2, cost: 0.75, tokens: { in: 160, out: 20, cacheRead: 40 } } });
    const s1 = (await r.step())!;
    expect(s1.llm).toEqual({ "gemini/gemini-3.8-flash": { in: 10, out: 2 } });
    expect(s1.profiles).toEqual({ [PROFILE]: { in: 60, out: 10, cached: 40, cost: 0.25 } });
    const s2 = (await r.step())!;
    expect(s2.llm).toEqual({});
    expect(s2.profiles).toBeUndefined();
    r.dispose();
  });

  test("a slow subscriber is sent every count of the samples it skipped, and subscribing again counts none twice", async () => {
    const r = rig();
    let total = 0;
    const spendTo = (n: number) => r.bus.emit("session.state", { ...liveSession, stats: { turns: 1, cost: n / 1000, tokens: { in: n, out: 0 } } });
    await r.step();
    await r.step();
    r.metrics.subscribe("fast", 1000);
    r.metrics.subscribe("slow", 5000);
    for (let i = 1; i <= 12; i++) {
      total += 10 * i;
      spendTo(total);
      r.metrics.countLlm("m", { in: i, out: 0 });
      await r.step(1000);
      // A second subscribe mid-way hands the latest over again, its counts not added twice.
      if (i === 7) r.metrics.subscribe("slow", 5000);
    }
    const sum = (list: MetricsSample[], pick: (s: MetricsSample) => number) => list.reduce((a, s) => a + pick(s), 0);
    const fast = r.delivered.get("fast")!;
    const slow = r.delivered.get("slow")!;
    expect(slow.length).toBeLessThan(fast.length);
    for (const list of [fast, slow]) {
      expect(sum(list, (s) => s.profiles?.[PROFILE]?.in ?? 0)).toBe(total);
      expect(sum(list, (s) => s.llm["m"]?.in ?? 0)).toBe(78);
    }
    r.dispose();
  });

  test("processes: owners sums the rows into one per owner; a controller is floored at five seconds", async () => {
    const r = rig();
    await r.step();
    await r.step();
    r.metrics.subscribe("card", 1000, "owners");
    r.metrics.subscribe("all", 1000);
    await r.step(1000);
    const card = r.delivered.get("card")!.at(-1)!;
    const all = r.delivered.get("all")!.at(-1)!;
    expect(MetricsSampleSchema.safeParse(card).success).toBe(true);
    const keys = card.processes.map((p) => (p.owner.kind === "session" ? `session:${p.owner.session}` : p.owner.kind === "sidecar" ? `sidecar:${p.owner.name}` : p.owner.kind));
    expect(new Set(keys).size).toBe(keys.length);
    expect(card.processes.every((p) => p.pid === 0)).toBe(true);
    expect(card.processes.length).toBeLessThan(all.processes.length);
    const byKind = (s: MetricsSample, kind: string) => s.processes.filter((p) => p.owner.kind === kind).reduce((a, p) => a + p.memory, 0);
    for (const kind of ["session", "platform", "brain", "sidecar", "other"]) expect(byKind(card, kind)).toBe(byKind(all, kind));
    expect(intervalFor("controller", 2000)).toBe(CONTROLLER_MIN_INTERVAL_MS);
    expect(intervalFor("controller", 9000)).toBe(9000);
    expect(intervalFor("ui", 2000)).toBe(2000);
    r.dispose();
  });

  test("a controller's feed is sent no faster than five seconds while a desktop drives the sampler at two; a feed at the sampler's rate keeps every sample through jitter", async () => {
    const r = rig("[metrics]\nmin_interval_ms = 1000\n");
    await r.step();
    await r.step();
    r.metrics.subscribe("phone", intervalFor("controller", 2000), "owners");
    r.metrics.subscribe("desk", 2000);
    for (let i = 0; i < 12; i++) await r.step(i % 3 === 0 ? 1990 : 2005);
    const gaps = (list: MetricsSample[]) => list.slice(1).map((s, i) => s.at - list[i]!.at);
    expect(Math.min(...gaps(r.delivered.get("phone")!))).toBeGreaterThanOrEqual(CONTROLLER_MIN_INTERVAL_MS);
    // The desk hears every sample, the one that landed 10 ms early included.
    expect(r.delivered.get("desk")!.length).toBe(13);
    r.dispose();
  });

  test("a subscription's spend sums the stored minutes and the open minute; its totals plus what the subscriber is sent after `at` is every token, subscribing again too", async () => {
    const r = rig();
    let total = 0;
    const spendTo = (n: number) => r.bus.emit("session.state", { ...liveSession, stats: { turns: 1, cost: n / 1000, tokens: { in: n, out: 0 } } });
    const sentAfter = (at: number) => r.delivered.get("view")!.filter((s) => s.at > at).reduce((a, s) => a + (s.profiles?.[PROFILE]?.in ?? 0), 0);
    // Quiet seconds past the interval: whatever the feed still holds is sent.
    const settle = async () => {
      for (let i = 0; i < 5; i++) await r.step(1000);
    };
    await r.step();
    // 90 seconds of spend: a stored minute's rollup, then the open minute's live samples.
    for (let i = 0; i < 90; i++) {
      total += 5;
      spendTo(total);
      await r.step(1000);
    }
    const totals = r.metrics.subscribe("view", 5000, "owners", {})!;
    expect(totals.at).toBe(r.metrics.latest()!.at);
    expect(totals.profiles[PROFILE]!.in).toBe(total);
    expect(totals.profiles[PROFILE]!.cost).toBeCloseTo(total / 1000, 9);
    for (let i = 0; i < 12; i++) {
      total += 7;
      spendTo(total);
      await r.step(1000);
    }
    await settle();
    expect(totals.profiles[PROFILE]!.in + sentAfter(totals.at)).toBe(total);
    // A reconnect subscribes again while counts wait in the feed: the totals take them, the next sample does not repeat them.
    for (let i = 0; i < 3; i++) {
      total += 3;
      spendTo(total);
      await r.step(1000);
    }
    const again = r.metrics.subscribe("view", 5000, "owners", {})!;
    expect(again.profiles[PROFILE]!.in).toBe(total);
    for (let i = 0; i < 7; i++) {
      total += 2;
      spendTo(total);
      await r.step(1000);
    }
    await settle();
    expect(again.profiles[PROFILE]!.in + sentAfter(again.at)).toBe(total);
    expect(r.metrics.subscribe("plain", 5000)).toBeUndefined();
    // A range that ends before the newest minute leaves it out.
    const early = r.metrics.spend(NODE, { from: 0, to: T0 + 20_000 });
    expect(early.profiles[PROFILE]!.in).toBeLessThan(total);
    expect(() => r.metrics.spend("node_other")).toThrow(/no node/);
    r.dispose();
  });

  test("every sample carries the latest plan limits, and they are refreshed only while a client subscribes", async () => {
    let readings: Record<string, ProfileLimits> | undefined;
    let refreshes = 0;
    const r = rig("", { limits: { latest: () => readings, refresh: async () => void refreshes++ } });
    await r.step();
    const bare = (await r.step())!;
    expect(bare.limits).toBeUndefined();
    // No one watches: nothing is read.
    expect(refreshes).toBe(0);
    readings = { [PROFILE]: { at: T0, session: { percent: 4, resetsAt: T0 + 3_600_000 }, weekly: { percent: 55 } } };
    r.metrics.subscribe("cli_a", 1000);
    // Subscribing reads at once, and so does every tick while the subscription lasts.
    expect(refreshes).toBe(1);
    const s = (await r.step())!;
    expect(refreshes).toBe(2);
    expect(s.limits).toEqual(readings);
    expect(MetricsSampleSchema.safeParse(s).success).toBe(true);
    expect(r.delivered.get("cli_a")!.at(-1)!.limits).toEqual(readings);
    r.metrics.unsubscribe("cli_a");
    await r.step();
    expect(refreshes).toBe(2);
    r.dispose();
  });

  test("a workspace node's sessions are `other` to the machine's audience; its own link gets its sessions, the machine's totals, and nothing of the owner's", async () => {
    const GUEST = "node_01ARZ3NDEKTSV4RRFFQ69G5FC0";
    const THEIRS = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC3";
    const nodes: Record<string, string> = { [SESSION]: NODE, [THEIRS]: GUEST };
    let readings: Record<string, ProfileLimits> | undefined = { [PROFILE]: { at: T0, session: { percent: 4 } } };
    let refreshes = 0;
    const r = rig("", {
      pids: new Map([
        [30, SESSION],
        [50, THEIRS],
      ]),
      partitions: { sessionNode: (id) => nodes[id], isPrivate: (n) => n === GUEST },
      limits: { latest: () => readings, refresh: async () => void refreshes++ },
    });
    await r.step();
    r.metrics.countLlm("gemini/x", { in: 5, out: 1 });
    r.metrics.subscribe(`guest:${GUEST}:link-1`, 1000, "owners");
    // a workspace node's link reads no plan limits
    expect(refreshes).toBe(0);
    r.metrics.subscribe("cli_a", 1000, "owners");
    const machine = (await r.step())!;
    const owners = (s: MetricsSample) => s.processes.map((p) => (p.owner.kind === "session" ? p.owner.session : p.owner.kind));
    // the machine's own: its session, and the workspace node's as part of `other`
    expect(owners(machine)).toContain(SESSION);
    expect(JSON.stringify(machine)).not.toContain(THEIRS);
    expect(JSON.stringify(r.metrics.history(NODE))).not.toContain(THEIRS);
    expect(JSON.stringify(r.delivered.get("cli_a"))).not.toContain(THEIRS);
    // the workspace node's: its id, its session, the rest as `other`, the machine's totals, no counts, spend or limits
    const theirs = r.delivered.get(`guest:${GUEST}:link-1`)!.at(-1)!;
    expect(theirs.node).toBe(GUEST);
    expect(owners(theirs).sort()).toEqual([THEIRS, "other"].sort());
    expect(theirs.cpu).toBe(machine.cpu);
    expect(theirs.memory).toEqual(machine.memory);
    expect(theirs.llm).toEqual({});
    expect(theirs.profiles).toBeUndefined();
    expect(theirs.limits).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain(SESSION);
    expect(MetricsSampleSchema.safeParse(theirs).success).toBe(true);
    // the whole is conserved: what the workspace node's `other` holds is everything but its own
    const cpuOf = (s: MetricsSample) => s.processes.reduce((n, p) => n + p.cpu, 0);
    expect(Math.round(cpuOf(theirs) * 10)).toBe(Math.round(cpuOf(machine) * 10));
    expect(r.metrics.guestLatest(GUEST)[0]!.node).toBe(GUEST);
    // no spend for it either
    expect(r.metrics.subscribe(`guest:${GUEST}:link-1`, 1000, "owners", { from: 0 })).toBeUndefined();
    readings = undefined;
    r.dispose();
  });

  test("off in config: no ticks, and the reads answer unsupported", async () => {
    const r = rig("[metrics]\nenabled = false\n");
    await r.metrics.start();
    expect(r.engine.samples).toBe(0);
    expect(() => r.metrics.subscribe("c", 1000)).toThrow(/off/);
    expect(() => r.metrics.history(NODE)).toThrow(/off/);
    expect(() => r.metrics.spend(NODE)).toThrow(/off/);
    r.dispose();
  });
});

const liveSession: Session = { id: SESSION, node: NODE, harness: "claude", profile: PROFILE, native: { id: "n", pid: 30, transport: "pipe" }, origin: "user", cwd: "/w", tags: [], status: "busy", startedAt: 1, lastActivity: 2 };
