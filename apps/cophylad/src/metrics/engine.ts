// The engine interface behind the sampler: one raw reading of the machine, every process
// with its cumulative CPU time, parent, name, resident memory and start time, and the GPUs where a
// driver reports them (NVML for NVIDIA's, on Windows the GPU counters for any other, IOKit's
// IOAccelerator on a Mac). The OS engines live beside this file; `hostEngine` picks the one for
// this platform and falls back to an engine that reads nothing, logged once, so a machine
// the engines cannot read still runs the daemon.

import type { Logger } from "../log.ts";

export interface RawProcess {
  pid: number;
  parent: number;
  name: string;
  /** User plus kernel time, cumulative since the process started, in nanoseconds. */
  cpuTimeNs: number;
  /** Resident set, bytes. */
  rss: number;
  /** When the process started, ms since the epoch: with the pid, which process it is. Absent where unknown. */
  startedAt?: number;
}

export interface RawGpu {
  name: string;
  /** Percent busy. */
  util: number;
  vramUsed: number;
  vramTotal: number;
  /** VRAM by pid, where the driver reports it. */
  processes: Map<number, number>;
}

export interface RawSample {
  at: number;
  /** A monotonic clock, nanoseconds, for the per-process rates. */
  monoNs: bigint;
  cores: number;
  /** Busy and total time summed over every core, cumulative, nanoseconds. */
  cpu: { busyNs: number; totalNs: number };
  memory: { used: number; total: number };
  processes: RawProcess[];
  gpu?: RawGpu[];
}

export interface MetricsEngine {
  readonly name: string;
  sample(): RawSample | Promise<RawSample>;
  dispose?(): void;
}

export interface HostEngineOptions {
  platform?: NodeJS.Platform;
  /** Read the GPU: through NVML, then on Windows the GPU counters, or IOKit on a Mac. */
  gpu: boolean;
  log: Logger;
}

/** What reads the GPUs at each sample. */
export interface GpuReader {
  sample(): RawGpu[] | undefined;
  dispose(): void;
  /** Given up for good: the next reader in line takes over. */
  readonly off?: boolean;
}

/**
 * The first of `readers` that has not given up: each takes over once the one before it is
 * off, at the same sample. Logged once when none is left.
 */
export function firstGpu(readers: GpuReader[], log: Logger): GpuReader {
  let at = 0;
  return {
    sample() {
      while (at < readers.length) {
        const reader = readers[at]!;
        const gpu = reader.sample();
        if (gpu !== undefined || !reader.off) return gpu;
        reader.dispose();
        if (++at === readers.length) log.info("no GPU metrics");
      }
      return undefined;
    },
    dispose() {
      for (const reader of readers.slice(at)) reader.dispose();
    },
    get off() {
      return at >= readers.length;
    },
  };
}

/** An engine that reads nothing: zero everything, no processes. */
export function unavailableEngine(reason: string, log?: Logger): MetricsEngine {
  log?.warn("metrics engine unavailable", { reason });
  return {
    name: "unavailable",
    sample: () => ({ at: Date.now(), monoNs: process.hrtime.bigint(), cores: 1, cpu: { busyNs: 0, totalNs: 0 }, memory: { used: 0, total: 0 }, processes: [] }),
  };
}

/** The OS engine for this platform, with the GPU reader folded in when asked for. */
export function hostEngine(opts: HostEngineOptions): MetricsEngine {
  const platform = opts.platform ?? process.platform;
  let base: MetricsEngine;
  try {
    if (platform === "win32") {
      const { WindowsEngine } = require("./windows.ts") as typeof import("./windows.ts");
      base = new WindowsEngine();
    } else if (platform === "linux") {
      const { LinuxEngine } = require("./linux.ts") as typeof import("./linux.ts");
      base = new LinuxEngine();
    } else if (platform === "darwin") {
      const { MacEngine } = require("./macos.ts") as typeof import("./macos.ts");
      base = new MacEngine();
    } else {
      return unavailableEngine(`no engine for ${platform}`, opts.log);
    }
    // The first sample proves the engine: an FFI symbol missing or a struct wrong fails here, not in a tick.
    base.sample();
  } catch (e) {
    return unavailableEngine(e instanceof Error ? e.message : String(e), opts.log);
  }
  if (!opts.gpu) return base;
  let reader: GpuReader;
  if (platform === "darwin") {
    const { AppleGpu } = require("./apple-gpu.ts") as typeof import("./apple-gpu.ts");
    reader = new AppleGpu(opts.log.child("gpu"));
  } else {
    const { Nvml } = require("./nvml.ts") as typeof import("./nvml.ts");
    const readers: GpuReader[] = [new Nvml(opts.log.child("nvml"))];
    if (platform === "win32") {
      const { WindowsGpu } = require("./windows-gpu.ts") as typeof import("./windows-gpu.ts");
      readers.push(new WindowsGpu(opts.log.child("gpu")));
    }
    reader = firstGpu(readers, opts.log.child("gpu"));
  }
  return {
    name: base.name,
    sample: () => {
      const raw = base.sample() as RawSample;
      const gpu = reader.sample();
      return gpu ? { ...raw, gpu } : raw;
    },
    dispose: () => {
      reader.dispose();
      base.dispose?.();
    },
  };
}
