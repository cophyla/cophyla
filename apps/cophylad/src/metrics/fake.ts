// A scripted engine for the tests: hands out the raw samples it was given, in order, the
// last one again when the script runs out, or whatever a function returns. `raw` builds a
// sample from a short spec and `tree` a process tree shaped like a working desktop: a shell
// running cophylad with the brain, a sidecar and an ACP agent under it, a user's own Claude
// session with a shell and an MCP server, the file manager and a browser.

import type { MetricsEngine, RawGpu, RawProcess, RawSample } from "./engine.ts";

export interface RawSpec {
  at?: number;
  /** Seconds of monotonic time; the default steps one second per sample. */
  monoS?: number;
  cores?: number;
  /** Percent busy over the whole life of the machine, or explicit nanoseconds. */
  busyPct?: number;
  cpu?: { busyNs: number; totalNs: number };
  memory?: { used: number; total: number };
  processes?: Partial<RawProcess>[];
  gpu?: (Partial<Omit<RawGpu, "processes">> & { processes?: Record<number, number> })[];
}

export class FakeEngine implements MetricsEngine {
  readonly name = "fake";
  private script: RawSample[];
  private next: (() => RawSample) | undefined;
  private index = 0;
  /** How many times `sample` was called. */
  samples = 0;

  constructor(script: RawSample[] | (() => RawSample) = []) {
    if (typeof script === "function") {
      this.script = [];
      this.next = script;
    } else this.script = [...script];
  }

  push(...samples: RawSample[]): void {
    this.script.push(...samples);
  }

  sample(): RawSample {
    this.samples++;
    if (this.next) return this.next();
    if (this.script.length === 0) throw new Error("fake engine: no sample scripted");
    const s = this.script[Math.min(this.index, this.script.length - 1)]!;
    this.index++;
    return s;
  }

  /** A raw sample from a spec: percentages become nanoseconds over a machine that has run 1000 s. */
  static raw(spec: RawSpec = {}): RawSample {
    const cores = spec.cores ?? 4;
    const monoS = spec.monoS ?? 0;
    const totalNs = (1000 + monoS) * cores * 1e9;
    const cpu = spec.cpu ?? { busyNs: (totalNs * (spec.busyPct ?? 0)) / 100, totalNs };
    const processes: RawProcess[] = (spec.processes ?? []).map((p, i) => ({
      pid: p.pid ?? 100 + i,
      parent: p.parent ?? 1,
      name: p.name ?? `p${p.pid ?? 100 + i}`,
      cpuTimeNs: p.cpuTimeNs ?? 0,
      rss: p.rss ?? 1_000_000,
    }));
    const out: RawSample = {
      at: spec.at ?? 1_700_000_000_000 + monoS * 1000,
      monoNs: BigInt(Math.round(monoS * 1e9)),
      cores,
      cpu,
      memory: spec.memory ?? { used: 4_000_000_000, total: 16_000_000_000 },
      processes,
    };
    if (spec.gpu) {
      out.gpu = spec.gpu.map((g, i) => ({
        name: g.name ?? `gpu${i}`,
        util: g.util ?? 0,
        vramUsed: g.vramUsed ?? 0,
        vramTotal: g.vramTotal ?? 8_000_000_000,
        processes: new Map(Object.entries(g.processes ?? {}).map(([pid, bytes]) => [Number(pid), bytes])),
      }));
    }
    return out;
  }

  /**
   * The desktop tree, pids fixed so a test can name them: 1 init; 10 shell → 20 cophylad (bun)
   * → 21 brain, 22 tts-py (python), 23 acp agent (node) → 24 claude; 30 user claude → 31 sh,
   * 32 mcp; 40 explorer; 50 chrome → 51, 52 chrome. `seconds` of CPU time per pid, cumulative.
   */
  static tree(seconds: Partial<Record<number, number>> = {}, opts: { monoS?: number; busyPct?: number; rss?: Partial<Record<number, number>> } = {}): RawSample {
    const t = (pid: number) => (seconds[pid] ?? 0) * 1e9;
    const rss = (pid: number, dflt: number) => opts.rss?.[pid] ?? dflt;
    const processes: Partial<RawProcess>[] = [
      { pid: 1, parent: 0, name: "init", cpuTimeNs: t(1), rss: rss(1, 1_000_000) },
      { pid: 10, parent: 1, name: "bash", cpuTimeNs: t(10), rss: rss(10, 5_000_000) },
      { pid: 20, parent: 10, name: "bun", cpuTimeNs: t(20), rss: rss(20, 90_000_000) },
      { pid: 21, parent: 20, name: "bun", cpuTimeNs: t(21), rss: rss(21, 60_000_000) },
      { pid: 22, parent: 20, name: "python", cpuTimeNs: t(22), rss: rss(22, 2_000_000_000) },
      { pid: 23, parent: 20, name: "node", cpuTimeNs: t(23), rss: rss(23, 80_000_000) },
      { pid: 24, parent: 23, name: "claude", cpuTimeNs: t(24), rss: rss(24, 300_000_000) },
      { pid: 30, parent: 1, name: "claude", cpuTimeNs: t(30), rss: rss(30, 500_000_000) },
      { pid: 31, parent: 30, name: "sh", cpuTimeNs: t(31), rss: rss(31, 4_000_000) },
      { pid: 32, parent: 30, name: "mcp-server", cpuTimeNs: t(32), rss: rss(32, 50_000_000) },
      { pid: 40, parent: 1, name: "explorer", cpuTimeNs: t(40), rss: rss(40, 100_000_000) },
      { pid: 50, parent: 1, name: "chrome", cpuTimeNs: t(50), rss: rss(50, 400_000_000) },
      { pid: 51, parent: 50, name: "chrome", cpuTimeNs: t(51), rss: rss(51, 200_000_000) },
      { pid: 52, parent: 50, name: "chrome", cpuTimeNs: t(52), rss: rss(52, 150_000_000) },
    ];
    return FakeEngine.raw({ processes, ...(opts.monoS !== undefined ? { monoS: opts.monoS } : {}), ...(opts.busyPct !== undefined ? { busyPct: opts.busyPct } : {}) });
  }
}
