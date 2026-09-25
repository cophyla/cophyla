// NVIDIA GPUs through NVML: name, utilisation, VRAM in total and per process. `nvml.dll`
// comes with the driver on Windows (System32), `libnvidia-ml.so.1` on Linux.
//
//   bun run nvml.ts        init, one sample per device, per-process memory, timings, shutdown
//
// Structs: nvmlUtilization_t {gpu u32, memory u32}; nvmlMemory_t {total u64, free u64, used u64};
// nvmlProcessInfo_t (v2+, what the _v3 process calls fill): {pid u32, pad, usedGpuMemory u64 @8,
// gpuInstanceId u32 @16, computeInstanceId u32 @20} = 24 bytes.

import { dlopen, FFIType, ptr } from "bun:ffi";

export interface GpuInfo {
  name: string;
  util: number;
  vramUsed: number;
  vramTotal: number;
  processes: Map<number, number>;
}

const NOT_AVAILABLE = 0xffffffffffffffffn;
const lib = process.platform === "win32" ? "nvml.dll" : "libnvidia-ml.so.1";

let nvml: ReturnType<typeof open> | null | undefined;

function open() {
  return dlopen(lib, {
    nvmlInit_v2: { args: [], returns: FFIType.i32 },
    nvmlShutdown: { args: [], returns: FFIType.i32 },
    nvmlDeviceGetCount_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
    nvmlDeviceGetHandleByIndex_v2: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    nvmlDeviceGetName: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    nvmlDeviceGetUtilizationRates: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    nvmlDeviceGetMemoryInfo: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    nvmlDeviceGetComputeRunningProcesses_v3: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    nvmlDeviceGetGraphicsRunningProcesses_v3: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
}

export function init(): boolean {
  if (nvml !== undefined) return nvml !== null;
  try {
    const lib = open();
    const rc = lib.symbols.nvmlInit_v2();
    if (rc !== 0) {
      nvml = null;
      return false;
    }
    nvml = lib;
    return true;
  } catch {
    nvml = null;
    return false;
  }
}

export function shutdown(): void {
  if (nvml) nvml.symbols.nvmlShutdown();
  nvml = undefined;
}

const decoder = new TextDecoder();
const count = new Uint32Array(1);
const handle = new BigUint64Array(1);
const name = new Uint8Array(96);
const util = new Uint32Array(2);
const mem = new BigUint64Array(3);
const procCount = new Uint32Array(1);
let procs = new Uint8Array(24 * 64);

function processesOf(dev: bigint, fn: (dev: bigint, count: unknown, infos: unknown) => number, into: Map<number, number>): void {
  for (;;) {
    procCount[0] = procs.byteLength / 24;
    const rc = fn(dev, ptr(procCount), ptr(procs));
    if (rc === 7 /* NVML_ERROR_INSUFFICIENT_SIZE */) {
      procs = new Uint8Array(24 * Math.max(procCount[0]!, procs.byteLength / 24 * 2));
      continue;
    }
    if (rc !== 0) return;
    break;
  }
  const view = new DataView(procs.buffer);
  for (let i = 0; i < procCount[0]!; i++) {
    const pid = view.getUint32(i * 24, true);
    const used = view.getBigUint64(i * 24 + 8, true);
    if (used === NOT_AVAILABLE) continue;
    into.set(pid, (into.get(pid) ?? 0) + Number(used));
  }
}

export function sample(): GpuInfo[] | undefined {
  if (!nvml) return undefined;
  const s = nvml.symbols;
  if (s.nvmlDeviceGetCount_v2(ptr(count)) !== 0) return undefined;
  const out: GpuInfo[] = [];
  for (let i = 0; i < count[0]!; i++) {
    if (s.nvmlDeviceGetHandleByIndex_v2(i, ptr(handle)) !== 0) continue;
    const dev = handle[0]!;
    let label = `gpu${i}`;
    if (s.nvmlDeviceGetName(dev, ptr(name), name.byteLength) === 0) {
      const end = name.indexOf(0);
      label = decoder.decode(name.subarray(0, end < 0 ? name.byteLength : end));
    }
    let u = 0;
    if (s.nvmlDeviceGetUtilizationRates(dev, ptr(util)) === 0) u = util[0]!;
    let total = 0, used = 0;
    if (s.nvmlDeviceGetMemoryInfo(dev, ptr(mem)) === 0) {
      total = Number(mem[0]!);
      used = Number(mem[2]!);
    }
    const processes = new Map<number, number>();
    processesOf(dev, s.nvmlDeviceGetComputeRunningProcesses_v3 as never, processes);
    processesOf(dev, s.nvmlDeviceGetGraphicsRunningProcesses_v3 as never, processes);
    out.push({ name: label, util: u, vramUsed: used, vramTotal: total, processes });
  }
  return out;
}

if (import.meta.main) {
  const t0 = performance.now();
  const ok = init();
  console.log("init:", ok, `${(performance.now() - t0).toFixed(1)} ms`);
  if (ok) {
    const s = sample();
    console.log(s);
    const runs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const a = performance.now();
      sample();
      runs.push(performance.now() - a);
    }
    runs.sort((a, b) => a - b);
    console.log(`20 samples: min ${runs[0]!.toFixed(2)} median ${runs[10]!.toFixed(2)} max ${runs[19]!.toFixed(2)} ms`);
    shutdown();
  }
}
