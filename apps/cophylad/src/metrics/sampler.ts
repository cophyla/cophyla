// From two raw readings to one MetricsSample: the machine's cpu is the busy share of the
// total time between them; a process's cpu is its own time between them over the interval
// times the cores, so it is a percent of all cores like the machine's; a pid seen for the
// first time reads 0 until the next reading. Owners come from the tree, VRAM from the GPU
// reader's per-pid map, and the rows are trimmed to the owned ones plus the busiest others.

import type { MetricsSample } from "@cophyla/protocol";
import type { RawSample } from "./engine.ts";
import { assignOwners, LIVE_OTHERS, trimProcesses } from "./owners.ts";
import type { OwnerRoots, SampleProcess } from "./owners.ts";

export type LlmCounts = MetricsSample["llm"];
export type ProfileCounts = NonNullable<MetricsSample["profiles"]>;

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

export class Sampler {
  private node: string;
  private prev?: RawSample;
  private keepOther: number;

  constructor(node: string, opts: { keepOther?: number } = {}) {
    this.node = node;
    this.keepOther = opts.keepOther ?? LIVE_OTHERS;
  }

  /** Forgets the previous reading: the next build primes again. */
  reset(): void {
    this.prev = undefined;
  }

  /** Whether a reading is held to diff the next against. */
  get primed(): boolean {
    return this.prev !== undefined;
  }

  /** The first call primes and returns nothing; every later one returns a sample against the previous reading. */
  build(raw: RawSample, roots: OwnerRoots, llm: LlmCounts = {}, profiles?: ProfileCounts): MetricsSample | undefined {
    const prev = this.prev;
    this.prev = raw;
    if (!prev) return undefined;
    const dBusy = raw.cpu.busyNs - prev.cpu.busyNs;
    const dTotal = raw.cpu.totalNs - prev.cpu.totalNs;
    const cpu = dTotal > 0 ? clamp((dBusy / dTotal) * 100) : 0;
    const dMono = Number(raw.monoNs - prev.monoNs);
    const before = new Map(prev.processes.map((p) => [p.pid, p.cpuTimeNs]));
    const owners = assignOwners(raw.processes, roots);
    const vram = new Map<number, number>();
    for (const g of raw.gpu ?? []) for (const [pid, bytes] of g.processes) vram.set(pid, (vram.get(pid) ?? 0) + bytes);
    const cores = Math.max(1, raw.cores);
    const rows: SampleProcess[] = raw.processes.map((p) => {
      const was = before.get(p.pid);
      const pct = was === undefined || dMono <= 0 ? 0 : clamp(((p.cpuTimeNs - was) / (dMono * cores)) * 100);
      const row: SampleProcess = { pid: p.pid, parent: p.parent, name: p.name, cpu: round1(pct), memory: p.rss, owner: owners.get(p.pid) ?? { kind: "other" } };
      const v = vram.get(p.pid);
      if (v !== undefined) row.vram = v;
      return row;
    });
    const sample: MetricsSample = {
      node: this.node,
      at: raw.at,
      cpu: round1(cpu),
      memory: { used: raw.memory.used, total: raw.memory.total },
      processes: trimProcesses(rows, this.keepOther),
      llm,
    };
    if (raw.gpu) sample.gpu = raw.gpu.map((g) => ({ name: g.name, util: round1(clamp(g.util)), vramUsed: g.vramUsed, vramTotal: g.vramTotal }));
    if (profiles && Object.keys(profiles).length > 0) sample.profiles = profiles;
    return sample;
  }
}
