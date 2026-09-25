// The engine interface behind the sampler: one raw reading of the machine, every process
// with its cumulative CPU time, parent, name and resident memory, and the GPUs where a
// driver reports them. The OS engines live beside this file; `hostEngine` picks the one for
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
  /** Read the GPU through NVML. */
  gpu: boolean;
  log: Logger;
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
  const { Nvml } = require("./nvml.ts") as typeof import("./nvml.ts");
  const nvml = new Nvml(opts.log.child("nvml"));
  return {
    name: base.name,
    sample: () => {
      const raw = base.sample() as RawSample;
      const gpu = nvml.sample();
      return gpu ? { ...raw, gpu } : raw;
    },
    dispose: () => {
      nvml.dispose();
      base.dispose?.();
    },
  };
}
