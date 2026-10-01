// The Windows engine on a real machine: this process is in the walk as `bun.exe` with its
// parent, a CPU time near `process.cpuUsage`, a working set near `memoryUsage().rss` and its
// start time;
// the machine's totals grow between two readings; and through the module, the row comes
// out owned by the platform. `hostEngine` on this platform is that engine with NVML folded
// in, and a GPU reading, when there is one, is well-formed.

import { describe, expect, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { parseConfig } from "../src/config/load.ts";
import { silentLogger } from "../src/log.ts";
import { hostEngine } from "../src/metrics/engine.ts";
import { Metrics } from "../src/metrics/index.ts";
import { Store } from "../src/store/index.ts";

const onWindows = process.platform === "win32";

describe.skipIf(!onWindows)("metrics windows engine", () => {
  test("this process is in the walk with the right parent, CPU time and working set", async () => {
    const { WindowsEngine } = await import("../src/metrics/windows.ts");
    const engine = new WindowsEngine();
    const usage = process.cpuUsage();
    const rss = process.memoryUsage().rss;
    const a = engine.sample();
    const me = a.processes.find((p) => p.pid === process.pid)!;
    expect(me).toBeDefined();
    expect(me.name).toBe("bun.exe");
    expect(me.parent).toBe(process.ppid);
    expect(Math.abs(me.cpuTimeNs / 1e6 - (usage.user + usage.system) / 1000)).toBeLessThan(250);
    expect(Math.abs(me.rss - rss) / rss).toBeLessThan(0.25);
    // Its start, from the walk's creation time.
    expect(Math.abs(me.startedAt! - performance.timeOrigin)).toBeLessThan(5000);
    expect(a.processes.every((p) => p.startedAt === undefined || p.startedAt <= Date.now())).toBe(true);
    expect(a.processes.length).toBeGreaterThan(20);
    expect(a.processes.every((p) => p.pid > 0 && p.name.length > 0)).toBe(true);
    expect(a.memory.total).toBeGreaterThan(a.memory.used);
    expect(a.cores).toBeGreaterThan(0);
    // The buffer grew to fit and is kept; the totals move between readings.
    expect(engine.bufferBytes).toBeGreaterThanOrEqual(512 * 1024);
    const spin = Date.now() + 30;
    while (Date.now() < spin) {
      // burn a little
    }
    const b = engine.sample();
    expect(b.cpu.totalNs).toBeGreaterThan(a.cpu.totalNs);
    expect(b.cpu.busyNs).toBeGreaterThanOrEqual(a.cpu.busyNs);
    expect(b.monoNs > a.monoNs).toBe(true);
  });

  test("through the module the row is the platform's, and the host engine reads the GPU when there is one", async () => {
    const store = new Store(":memory:");
    store.migrate();
    const engine = hostEngine({ gpu: true, log: silentLogger });
    expect(engine.name).toBe("windows");
    const metrics = new Metrics({
      config: parseConfig("").metrics,
      nodeId: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      store,
      bus: new Bus(),
      log: silentLogger,
      engine,
      sessions: { pids: () => new Map(), list: () => [] },
      brainPid: () => undefined,
      sidecarPids: () => new Map(),
      deliver: () => true,
    });
    await metrics.tick();
    await metrics.tick();
    const s = metrics.latest()!;
    expect(s).toBeDefined();
    const me = s.processes.find((p) => p.pid === process.pid)!;
    expect(me.owner).toEqual({ kind: "platform" });
    expect(me.name).toBe("bun.exe");
    expect(s.cpu).toBeGreaterThanOrEqual(0);
    expect(s.cpu).toBeLessThanOrEqual(100);
    // Owned rows plus at most ten others.
    expect(s.processes.filter((p) => p.owner.kind === "other").length).toBeLessThanOrEqual(10);
    for (const g of s.gpu ?? []) {
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.vramTotal).toBeGreaterThan(0);
      expect(g.util).toBeGreaterThanOrEqual(0);
    }
    metrics.dispose();
    store.close();
  });
});
