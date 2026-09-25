// A minute's samples folded into one row of the same shape: cpu, memory and GPU averaged,
// token counts and spend summed, processes averaged per pid (a process seen in some samples
// only is averaged over the ones it was in, its owner and name the last seen) and trimmed to
// the owned rows plus the five busiest others. `mergeHistory` joins stored rollups with the
// ring's live samples for the open minute, so a history never shows a minute twice.

import type { MetricsSample } from "@cophyla/protocol";
import { ROLLUP_OTHERS, trimProcesses } from "./owners.ts";
import type { SampleProcess } from "./owners.ts";

export const MINUTE_MS = 60_000;

export const minuteOf = (at: number): number => Math.floor(at / MINUTE_MS) * MINUTE_MS;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function rollup(samples: MetricsSample[], node: string, minute: number): MetricsSample | undefined {
  if (samples.length === 0) return undefined;
  const n = samples.length;
  const avg = (pick: (s: MetricsSample) => number) => samples.reduce((a, s) => a + pick(s), 0) / n;
  const llm: MetricsSample["llm"] = {};
  const profiles: NonNullable<MetricsSample["profiles"]> = {};
  const gpus = new Map<number, { name: string; util: number; vramUsed: number; vramTotal: number; n: number }>();
  const procs = new Map<number, { row: SampleProcess; cpu: number; memory: number; vram: number; vramSeen: boolean; n: number }>();
  for (const s of samples) {
    for (const [model, c] of Object.entries(s.llm)) {
      const cur = llm[model] ?? { in: 0, out: 0 };
      llm[model] = { in: cur.in + c.in, out: cur.out + c.out };
    }
    for (const [profile, c] of Object.entries(s.profiles ?? {})) {
      const cur = profiles[profile] ?? { in: 0, out: 0, cached: 0 };
      const next = { in: cur.in + c.in, out: cur.out + c.out, cached: cur.cached + c.cached, ...(cur.cost !== undefined || c.cost !== undefined ? { cost: (cur.cost ?? 0) + (c.cost ?? 0) } : {}) };
      profiles[profile] = next;
    }
    (s.gpu ?? []).forEach((g, i) => {
      const cur = gpus.get(i) ?? { name: g.name, util: 0, vramUsed: 0, vramTotal: g.vramTotal, n: 0 };
      gpus.set(i, { name: g.name, util: cur.util + g.util, vramUsed: cur.vramUsed + g.vramUsed, vramTotal: g.vramTotal, n: cur.n + 1 });
    });
    for (const p of s.processes) {
      const cur = procs.get(p.pid) ?? { row: p, cpu: 0, memory: 0, vram: 0, vramSeen: false, n: 0 };
      procs.set(p.pid, { row: p, cpu: cur.cpu + p.cpu, memory: cur.memory + p.memory, vram: cur.vram + (p.vram ?? 0), vramSeen: cur.vramSeen || p.vram !== undefined, n: cur.n + 1 });
    }
  }
  const processes: SampleProcess[] = [...procs.values()].map((p) => {
    const row: SampleProcess = { pid: p.row.pid, parent: p.row.parent, name: p.row.name, cpu: round1(p.cpu / p.n), memory: Math.round(p.memory / p.n), owner: p.row.owner };
    if (p.vramSeen) row.vram = Math.round(p.vram / p.n);
    return row;
  });
  const out: MetricsSample = {
    node,
    at: minute,
    cpu: round1(avg((s) => s.cpu)),
    memory: { used: Math.round(avg((s) => s.memory.used)), total: Math.round(avg((s) => s.memory.total)) },
    processes: trimProcesses(processes, ROLLUP_OTHERS),
    llm,
  };
  if (gpus.size > 0) out.gpu = [...gpus.values()].map((g) => ({ name: g.name, util: round1(g.util / g.n), vramUsed: Math.round(g.vramUsed / g.n), vramTotal: g.vramTotal }));
  if (Object.keys(profiles).length > 0) out.profiles = profiles;
  return out;
}

export interface HistoryInput {
  /** Stored rollups, oldest first. */
  rollups: MetricsSample[];
  /** The ring's live samples, oldest first. */
  ring: MetricsSample[];
  from?: number;
  to?: number;
  /** The minute the ring is still filling; its live samples stand in for the rollup it has not become. */
  currentMinuteStart: number;
}

/** Rollups within the range, then the open minute's live samples within it; nothing twice. */
export function mergeHistory(input: HistoryInput): MetricsSample[] {
  const from = input.from ?? 0;
  const to = input.to ?? Number.MAX_SAFE_INTEGER;
  const stored = input.rollups.filter((r) => r.at >= from && r.at <= to && r.at < input.currentMinuteStart);
  const live = input.ring.filter((s) => s.at >= input.currentMinuteStart && s.at >= from && s.at <= to);
  return [...stored, ...live];
}
