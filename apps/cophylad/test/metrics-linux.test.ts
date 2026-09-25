// The Linux engine over a fixture `/proc` on every platform (the stat line parsed after its
// last parenthesis, ticks and pages scaled, a directory that is not a pid skipped, memory
// from MemTotal − MemAvailable), and over the real `/proc` on Linux: this process's own row
// matches what the process says about itself.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LinuxEngine, parseStat } from "../src/metrics/linux.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "proc");

describe("metrics linux engine", () => {
  test("parses the fixture tree", () => {
    const engine = new LinuxEngine({ procRoot: FIXTURE, cores: 2 });
    const s = engine.sample();
    expect(s.cores).toBe(2);
    // user 1000 nice 50 system 500 idle 8000 iowait 100 irq 10 softirq 20 steal 0: busy = 1580 ticks of 9680.
    expect(s.cpu.totalNs).toBe(9680 * 1e7);
    expect(s.cpu.busyNs).toBe(1580 * 1e7);
    expect(s.memory).toEqual({ total: 32736784 * 1024, used: (32736784 - 22754140) * 1024 });
    expect(s.processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([1, 42, 43]);
    const claude = s.processes.find((p) => p.pid === 42)!;
    expect(claude.name).toBe("claude (dev) x");
    expect(claude.parent).toBe(1);
    expect(claude.cpuTimeNs).toBe((1234 + 567) * 1e7);
    expect(claude.rss).toBe(51200 * 4096);
    expect(s.processes.find((p) => p.pid === 43)!.parent).toBe(42);
  });

  test("a stat line with spaces and parentheses in the name parses after the last one; a broken line is skipped", () => {
    expect(parseStat("7 (a (b) c) S 3 7 7 0 -1 0 0 0 0 0 10 20 0 0 20 0 1 0 5 100 25 0")).toEqual({ name: "a (b) c", parent: 3, ticks: 30, rssPages: 25 });
    expect(parseStat("garbage")).toBeUndefined();
  });

  test.skipIf(process.platform !== "linux")("reads the real /proc: this process is there with its parent and its own CPU time", () => {
    const engine = new LinuxEngine();
    const usage = process.cpuUsage();
    const s = engine.sample();
    const me = s.processes.find((p) => p.pid === process.pid)!;
    expect(me).toBeDefined();
    expect(me.parent).toBe(process.ppid);
    expect(me.name).toBe("bun");
    // Ticks are 10 ms; the walk itself burned a little since `cpuUsage` was read.
    expect(Math.abs(me.cpuTimeNs / 1e6 - (usage.user + usage.system) / 1000)).toBeLessThan(200);
    expect(me.rss).toBeGreaterThan(1_000_000);
    expect(s.memory.total).toBeGreaterThan(0);
    expect(s.cpu.totalNs).toBeGreaterThan(s.cpu.busyNs);
  });
});
