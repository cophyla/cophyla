// Two raw readings to one sample: the machine's cpu from the busy share, a process's cpu as
// a percent of all cores, a new pid at 0, GPU rows and per-process VRAM, the trim, and the
// pressure tracker's hysteresis and the rollup on top of it.

import { describe, expect, test } from "bun:test";
import { MetricsSample as MetricsSampleSchema } from "@cophyla/protocol";
import type { MetricsSample } from "@cophyla/protocol";
import { FakeEngine } from "../src/metrics/fake.ts";
import { PressureTracker } from "../src/metrics/pressure.ts";
import { mergeHistory, minuteOf, rollup } from "../src/metrics/rollup.ts";
import { Sampler } from "../src/metrics/sampler.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const PROFILE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
const roots = { sessions: new Map([[30, SESSION]]), platform: 20, brain: 21, sidecars: new Map([[22, "tts-py"]]) };

describe("metrics sampler", () => {
  test("the first reading primes; the second yields cpu shares of all cores", () => {
    const sampler = new Sampler(NODE);
    // Four cores. Between the readings: 2 s of wall time, the machine 25% busy, pid 30 used 1 s of CPU (12.5% of four cores), pid 20 4 s (50%).
    const prev = FakeEngine.tree({}, { monoS: 0 });
    expect(sampler.build(prev, roots)).toBeUndefined();
    const a = FakeEngine.tree({ 30: 1, 20: 4 }, { monoS: 2 });
    a.cpu = { busyNs: prev.cpu.busyNs + 2e9, totalNs: prev.cpu.totalNs + 8e9 };
    const s = sampler.build(a, roots, { "gemini/gemini-3.8-flash": { in: 10, out: 2 } }, { [PROFILE]: { in: 1, out: 2, cached: 3, cost: 0.1 } })!;
    expect(MetricsSampleSchema.safeParse(s).success).toBe(true);
    expect(s.node).toBe(NODE);
    expect(s.cpu).toBe(25);
    const byPid = new Map(s.processes.map((p) => [p.pid, p]));
    expect(byPid.get(30)!.cpu).toBe(12.5);
    expect(byPid.get(30)!.owner).toEqual({ kind: "session", session: SESSION });
    expect(byPid.get(20)!.cpu).toBe(50);
    expect(byPid.get(20)!.owner).toEqual({ kind: "platform" });
    expect(byPid.get(21)!.owner).toEqual({ kind: "brain" });
    expect(byPid.get(22)!.owner).toEqual({ kind: "sidecar", name: "tts-py" });
    expect(byPid.get(30)!.memory).toBe(500_000_000);
    expect(s.llm).toEqual({ "gemini/gemini-3.8-flash": { in: 10, out: 2 } });
    expect(s.profiles).toEqual({ [PROFILE]: { in: 1, out: 2, cached: 3, cost: 0.1 } });
    expect(s.gpu).toBeUndefined();
  });

  test("a pid seen for the first time reads 0; a process that burned more than the interval is clamped", () => {
    const sampler = new Sampler(NODE);
    sampler.build(FakeEngine.raw({ monoS: 0, cores: 2, processes: [{ pid: 7, cpuTimeNs: 0 }] }), { sessions: new Map(), sidecars: new Map() });
    const s = sampler.build(FakeEngine.raw({ monoS: 1, cores: 2, processes: [{ pid: 7, cpuTimeNs: 9e9 }, { pid: 8, cpuTimeNs: 5e9 }] }), { sessions: new Map(), sidecars: new Map() })!;
    const byPid = new Map(s.processes.map((p) => [p.pid, p]));
    expect(byPid.get(7)!.cpu).toBe(100);
    expect(byPid.get(8)!.cpu).toBe(0);
  });

  test("GPU rows carry through and per-process VRAM lands on the row", () => {
    const sampler = new Sampler(NODE);
    const gpu = [{ name: "RTX", util: 42, vramUsed: 4e9, vramTotal: 16e9, processes: { 22: 3e9 } }];
    sampler.build(FakeEngine.raw({ monoS: 0, processes: [{ pid: 22, name: "python" }], gpu }), roots);
    const s = sampler.build(FakeEngine.raw({ monoS: 1, processes: [{ pid: 22, name: "python" }], gpu }), roots)!;
    expect(s.gpu).toEqual([{ name: "RTX", util: 42, vramUsed: 4e9, vramTotal: 16e9 }]);
    expect(s.processes[0]!.vram).toBe(3e9);
    expect(s.processes[0]!.owner).toEqual({ kind: "sidecar", name: "tts-py" });
  });

  test("the live sample keeps every owned row and ten others", () => {
    const sampler = new Sampler(NODE);
    const many = Array.from({ length: 30 }, (_, i) => ({ pid: 1000 + i, name: `o${i}`, rss: i }));
    const processes = [{ pid: 20, name: "bun" }, ...many];
    sampler.build(FakeEngine.raw({ monoS: 0, processes }), roots);
    const s = sampler.build(FakeEngine.raw({ monoS: 1, processes }), roots)!;
    expect(s.processes.length).toBe(11);
    expect(s.processes[0]!.owner).toEqual({ kind: "platform" });
    // Ties on cpu fall to memory, so the biggest others are the ones kept.
    expect(s.processes.slice(1).map((p) => p.pid)).toEqual([1029, 1028, 1027, 1026, 1025, 1024, 1023, 1022, 1021, 1020]);
  });
});

describe("metrics pressure", () => {
  test("rises at once, falls only below the line less the hysteresis for two readings, and reports each change once", () => {
    const t = new PressureTracker({ warn: 80, critical: 95 });
    expect(t.update("cpu", 50)).toBeUndefined();
    expect(t.update("cpu", 81)).toBe("warn");
    expect(t.update("cpu", 85)).toBeUndefined();
    expect(t.update("cpu", 96)).toBe("critical");
    expect(t.update("cpu", 96)).toBeUndefined();
    // Hovering just under critical is still critical; under critical − 5 once is not enough.
    expect(t.update("cpu", 92)).toBeUndefined();
    expect(t.update("cpu", 89)).toBeUndefined();
    expect(t.update("cpu", 89)).toBe("warn");
    expect(t.level("cpu")).toBe("warn");
    expect(t.raised()).toEqual([{ resource: "cpu", level: "warn" }]);
    // Back up within warn is quiet; down past warn − 5 twice is normal.
    expect(t.update("cpu", 90)).toBeUndefined();
    expect(t.update("cpu", 70)).toBeUndefined();
    expect(t.update("cpu", 70)).toBe("normal");
    expect(t.raised()).toEqual([]);
    // A broken run of readings resets the count.
    expect(t.update("memory", 97)).toBe("critical");
    expect(t.update("memory", 10)).toBeUndefined();
    expect(t.update("memory", 93)).toBeUndefined();
    expect(t.update("memory", 10)).toBeUndefined();
    expect(t.update("memory", 10)).toBe("normal");
  });
});

describe("metrics rollup", () => {
  const sample = (at: number, cpu: number, extra: Partial<MetricsSample> = {}): MetricsSample => ({
    node: NODE,
    at,
    cpu,
    memory: { used: 1000, total: 2000 },
    processes: [{ pid: 20, parent: 1, name: "bun", cpu, memory: 100, owner: { kind: "platform" } }],
    llm: { "gemini/flash": { in: 10, out: 1 } },
    ...extra,
  });

  test("averages the machine and the processes, sums the tokens, trims to owned plus five others", () => {
    const others = Array.from({ length: 8 }, (_, i) => ({ pid: 500 + i, parent: 1, name: `o${i}`, cpu: i, memory: 1, owner: { kind: "other" } as const }));
    const minute = minuteOf(1_700_000_000_000);
    const a = sample(minute + 1000, 10, { gpu: [{ name: "g", util: 10, vramUsed: 100, vramTotal: 1000 }], profiles: { [PROFILE]: { in: 1, out: 1, cached: 1, cost: 0.5 } } });
    const b = sample(minute + 2000, 30, { gpu: [{ name: "g", util: 30, vramUsed: 300, vramTotal: 1000 }], processes: [{ pid: 20, parent: 1, name: "bun", cpu: 30, memory: 300, owner: { kind: "platform" } }, ...others], profiles: { [PROFILE]: { in: 2, out: 2, cached: 2 } } });
    const r = rollup([a, b], NODE, minute)!;
    expect(MetricsSampleSchema.safeParse(r).success).toBe(true);
    expect(r.at).toBe(minute);
    expect(r.cpu).toBe(20);
    expect(r.gpu).toEqual([{ name: "g", util: 20, vramUsed: 200, vramTotal: 1000 }]);
    expect(r.llm).toEqual({ "gemini/flash": { in: 20, out: 2 } });
    expect(r.profiles).toEqual({ [PROFILE]: { in: 3, out: 3, cached: 3, cost: 0.5 } });
    expect(r.processes[0]).toEqual({ pid: 20, parent: 1, name: "bun", cpu: 20, memory: 200, owner: { kind: "platform" } });
    // The others were in one sample only and average over that one; five of eight stay.
    expect(r.processes.length).toBe(6);
    expect(r.processes.slice(1).map((p) => p.pid)).toEqual([507, 506, 505, 504, 503]);
    expect(rollup([], NODE, minute)).toBeUndefined();
  });

  test("history is the rollups before the open minute, then the ring's samples in it, within the range", () => {
    const m0 = minuteOf(1_700_000_000_000);
    const rollups = [sample(m0 - 120_000, 1), sample(m0 - 60_000, 2), sample(m0, 99)];
    const ring = [sample(m0 - 60_000 + 30_000, 5), sample(m0 + 1000, 3), sample(m0 + 2000, 4)];
    const merged = mergeHistory({ rollups, ring, currentMinuteStart: m0 });
    // The stored row for the open minute (a stale one) is left out in favour of the live samples; the ring's older sample belongs to a closed minute and is not repeated.
    expect(merged.map((s) => s.cpu)).toEqual([1, 2, 3, 4]);
    expect(mergeHistory({ rollups, ring, from: m0 - 60_000, to: m0 + 1000, currentMinuteStart: m0 }).map((s) => s.cpu)).toEqual([2, 3]);
  });
});
