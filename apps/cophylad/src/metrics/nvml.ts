// NVIDIA GPUs through NVML: `nvml.dll` comes with the driver on Windows, `libnvidia-ml.so.1`
// on Linux. Initialised once at the first sample; a machine without the library, or with a
// driver that refuses, is logged once and read as no GPU from then on. Per-process VRAM is
// taken where the driver reports it (Linux, TCC); WDDM answers `NVML_VALUE_NOT_AVAILABLE`
// for every process and those rows are skipped. Spike 13 has the layouts.

import type { Logger } from "../log.ts";
import type { RawGpu } from "./engine.ts";

const NVML_ERROR_INSUFFICIENT_SIZE = 7;
const NOT_AVAILABLE = 0xffffffffffffffffn;
const PROCESS_INFO_BYTES = 24;

interface NvmlSymbols {
  nvmlInit_v2: () => number;
  nvmlShutdown: () => number;
  nvmlDeviceGetCount_v2: (count: unknown) => number;
  nvmlDeviceGetHandleByIndex_v2: (index: number, handle: unknown) => number;
  nvmlDeviceGetName: (device: bigint, name: unknown, length: number) => number;
  nvmlDeviceGetUtilizationRates: (device: bigint, util: unknown) => number;
  nvmlDeviceGetMemoryInfo: (device: bigint, memory: unknown) => number;
  nvmlDeviceGetComputeRunningProcesses_v3: (device: bigint, count: unknown, infos: unknown) => number;
  nvmlDeviceGetGraphicsRunningProcesses_v3: (device: bigint, count: unknown, infos: unknown) => number;
}

export class Nvml {
  private log: Logger;
  private symbols?: NvmlSymbols;
  private ptr?: (view: ArrayBufferView, offset?: number) => unknown;
  private state: "new" | "up" | "off" = "new";
  private count = new Uint32Array(1);
  private handle = new BigUint64Array(1);
  private name = new Uint8Array(96);
  private util = new Uint32Array(2);
  private memory = new BigUint64Array(3);
  private procCount = new Uint32Array(1);
  private procs = new Uint8Array(PROCESS_INFO_BYTES * 64);
  private decoder = new TextDecoder();

  constructor(log: Logger) {
    this.log = log;
  }

  private init(): boolean {
    if (this.state !== "new") return this.state === "up";
    try {
      const ffi = require("bun:ffi") as typeof import("bun:ffi");
      const { FFIType } = ffi;
      this.ptr = ffi.ptr as unknown as (view: ArrayBufferView, offset?: number) => unknown;
      const lib = process.platform === "win32" ? "nvml.dll" : "libnvidia-ml.so.1";
      const symbols = ffi.dlopen(lib, {
        nvmlInit_v2: { args: [], returns: FFIType.i32 },
        nvmlShutdown: { args: [], returns: FFIType.i32 },
        nvmlDeviceGetCount_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
        nvmlDeviceGetHandleByIndex_v2: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
        nvmlDeviceGetName: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        nvmlDeviceGetUtilizationRates: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
        nvmlDeviceGetMemoryInfo: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
        nvmlDeviceGetComputeRunningProcesses_v3: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        nvmlDeviceGetGraphicsRunningProcesses_v3: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      }).symbols as unknown as NvmlSymbols;
      const rc = symbols.nvmlInit_v2();
      if (rc !== 0) {
        this.log.info("no GPU metrics: NVML refused", { rc });
        this.state = "off";
        return false;
      }
      this.symbols = symbols;
      this.state = "up";
      return true;
    } catch (e) {
      this.log.info("no GPU metrics: NVML not loaded", { error: e instanceof Error ? e.message : String(e) });
      this.state = "off";
      return false;
    }
  }

  private processesOf(device: bigint, fn: (device: bigint, count: unknown, infos: unknown) => number, into: Map<number, number>): void {
    const ptr = this.ptr!;
    for (;;) {
      this.procCount[0] = this.procs.byteLength / PROCESS_INFO_BYTES;
      const rc = fn(device, ptr(this.procCount), ptr(this.procs));
      if (rc === NVML_ERROR_INSUFFICIENT_SIZE) {
        this.procs = new Uint8Array(PROCESS_INFO_BYTES * Math.max(this.procCount[0]!, (this.procs.byteLength / PROCESS_INFO_BYTES) * 2));
        continue;
      }
      if (rc !== 0) return;
      break;
    }
    const view = new DataView(this.procs.buffer);
    for (let i = 0; i < this.procCount[0]!; i++) {
      const used = view.getBigUint64(i * PROCESS_INFO_BYTES + 8, true);
      if (used === NOT_AVAILABLE) continue;
      const pid = view.getUint32(i * PROCESS_INFO_BYTES, true);
      into.set(pid, (into.get(pid) ?? 0) + Number(used));
    }
  }

  /** Every GPU's name, utilisation and VRAM, or undefined when NVML is not there. */
  sample(): RawGpu[] | undefined {
    if (!this.init()) return undefined;
    const s = this.symbols!;
    const ptr = this.ptr!;
    try {
      if (s.nvmlDeviceGetCount_v2(ptr(this.count)) !== 0) return undefined;
      const out: RawGpu[] = [];
      for (let i = 0; i < this.count[0]!; i++) {
        if (s.nvmlDeviceGetHandleByIndex_v2(i, ptr(this.handle)) !== 0) continue;
        const device = this.handle[0]!;
        let name = `gpu${i}`;
        if (s.nvmlDeviceGetName(device, ptr(this.name), this.name.byteLength) === 0) {
          const end = this.name.indexOf(0);
          name = this.decoder.decode(this.name.subarray(0, end < 0 ? this.name.byteLength : end)) || name;
        }
        const util = s.nvmlDeviceGetUtilizationRates(device, ptr(this.util)) === 0 ? this.util[0]! : 0;
        let vramTotal = 0;
        let vramUsed = 0;
        if (s.nvmlDeviceGetMemoryInfo(device, ptr(this.memory)) === 0) {
          vramTotal = Number(this.memory[0]!);
          vramUsed = Number(this.memory[2]!);
        }
        const processes = new Map<number, number>();
        this.processesOf(device, s.nvmlDeviceGetComputeRunningProcesses_v3, processes);
        this.processesOf(device, s.nvmlDeviceGetGraphicsRunningProcesses_v3, processes);
        out.push({ name, util, vramUsed, vramTotal, processes });
      }
      return out;
    } catch (e) {
      this.log.warn("GPU sample failed; GPU metrics off", { error: e instanceof Error ? e.message : String(e) });
      this.dispose();
      this.state = "off";
      return undefined;
    }
  }

  dispose(): void {
    if (this.state === "up") {
      try {
        this.symbols?.nvmlShutdown();
      } catch {
        // the driver is going away with us
      }
    }
    this.symbols = undefined;
    this.state = "off";
  }
}
