// CPU affinity for the inference threads. On a hybrid Intel CPU Windows is free to schedule
// the daemon's ONNX threads onto the efficiency cores, where a streaming decode takes three
// times as long as on a performance core (spike 10). So when the first voice engine loads,
// the daemon pins itself to the performance cores and hands the same mask to every sidecar
// it spawns, since a child inherits the parent's affinity anyway.
//
// The detection asks Windows for the processor-core relationships and takes the union of
// the masks whose `EfficiencyClass` is the highest one present: on a hybrid part those are
// the P-cores, and on a uniform part every core shares one class and nothing is pinned.
// Anything unusual — more than one processor group, more than 64 logical CPUs, a call that
// fails, a platform that is not Windows — pins nothing and says so in the log.

import type { Logger } from "../log.ts";

/** `0-15`, `0,2,4` or a mix; the bit per logical CPU. Undefined when the text is not one of those. */
export function parseMask(text: string): bigint | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let mask = 0n;
  for (const part of trimmed.split(",")) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    const one = /^\s*(\d+)\s*$/.exec(part);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo || hi > 63) return undefined;
      for (let i = lo; i <= hi; i++) mask |= 1n << BigInt(i);
    } else if (one) {
      const i = Number(one[1]);
      if (!Number.isInteger(i) || i > 63) return undefined;
      mask |= 1n << BigInt(i);
    } else return undefined;
  }
  return mask === 0n ? undefined : mask;
}

/** A mask as the `--affinity` argument a sidecar reads: compact ranges, `0-15,20`. */
export function maskArg(mask: bigint): string {
  const parts: string[] = [];
  let i = 0;
  while (i < 64) {
    if ((mask >> BigInt(i)) & 1n) {
      const start = i;
      while (i < 64 && (mask >> BigInt(i)) & 1n) i++;
      parts.push(i - 1 === start ? `${start}` : `${start}-${i - 1}`);
    } else i++;
  }
  return parts.join(",");
}

/** The logical CPUs a mask names, for the log. */
export function maskCount(mask: bigint): number {
  let n = 0;
  for (let i = 0; i < 64; i++) if ((mask >> BigInt(i)) & 1n) n++;
  return n;
}

interface Kernel32 {
  GetLogicalProcessorInformationEx: (relationship: number, buffer: unknown, length: unknown) => number;
  GetCurrentProcess: () => bigint;
  SetProcessAffinityMask: (handle: bigint, mask: bigint) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => bigint;
  CloseHandle: (handle: bigint) => number;
}

let kernel32: Kernel32 | null | undefined;
let ffiPtr: ((view: ArrayBufferView) => unknown) | undefined;

/** kernel32 through `bun:ffi`, or null where there is none (every non-Windows platform). */
function loadKernel32(log?: Logger): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  if (process.platform !== "win32") {
    kernel32 = null;
    return null;
  }
  try {
    // Imported here, not at the top: `bun:ffi` is Bun's alone and this file is read everywhere.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    ffiPtr = ffi.ptr as unknown as (view: ArrayBufferView) => unknown;
    const lib = ffi.dlopen("kernel32.dll", {
      GetLogicalProcessorInformationEx: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetCurrentProcess: { args: [], returns: FFIType.u64 },
      SetProcessAffinityMask: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    kernel32 = lib.symbols as unknown as Kernel32;
  } catch (e) {
    log?.debug("kernel32 not loaded; no affinity", { error: e instanceof Error ? e.message : String(e) });
    kernel32 = null;
  }
  return kernel32;
}

const RELATION_PROCESSOR_CORE = 0;

/**
 * The mask of the performance cores, or undefined when the machine is not hybrid or the
 * question cannot be answered. Windows gives each core an `EfficiencyClass`; the highest
 * class present is the fast one.
 */
export function pCoreMask(log?: Logger): bigint | undefined {
  const k = loadKernel32(log);
  if (!k || !ffiPtr) return undefined;
  try {
    const length = new Uint32Array(1);
    // First call sizes the buffer: it fails with ERROR_INSUFFICIENT_BUFFER and fills `length`.
    k.GetLogicalProcessorInformationEx(RELATION_PROCESSOR_CORE, null, ffiPtr(length));
    const size = length[0]!;
    if (size === 0 || size > 1 << 20) return undefined;
    const buffer = new Uint8Array(size);
    if (!k.GetLogicalProcessorInformationEx(RELATION_PROCESSOR_CORE, ffiPtr(buffer), ffiPtr(length))) return undefined;
    const view = new DataView(buffer.buffer);
    const cores: { efficiency: number; mask: bigint }[] = [];
    let offset = 0;
    while (offset + 8 <= size) {
      const relationship = view.getUint32(offset, true);
      const entrySize = view.getUint32(offset + 4, true);
      if (entrySize < 8 || offset + entrySize > size) break;
      if (relationship === RELATION_PROCESSOR_CORE) {
        // PROCESSOR_RELATIONSHIP: Flags, EfficiencyClass, Reserved[20], GroupCount, GroupMask[].
        const efficiency = view.getUint8(offset + 9);
        const groupCount = view.getUint16(offset + 30, true);
        let mask = 0n;
        let ok = true;
        for (let g = 0; g < groupCount; g++) {
          const at = offset + 32 + g * 16;
          if (at + 10 > offset + entrySize) {
            ok = false;
            break;
          }
          // More than one processor group means more than 64 CPUs: masks are per group and not comparable.
          if (view.getUint16(at + 8, true) !== 0) return undefined;
          mask |= view.getBigUint64(at, true);
        }
        if (!ok) break;
        cores.push({ efficiency, mask });
      }
      offset += entrySize;
    }
    if (cores.length === 0) return undefined;
    const classes = new Set(cores.map((c) => c.efficiency));
    if (classes.size < 2) return undefined;
    const best = Math.max(...classes);
    let mask = 0n;
    for (const c of cores) if (c.efficiency === best) mask |= c.mask;
    return mask === 0n ? undefined : mask;
  } catch (e) {
    log?.debug("processor information not read; no affinity", { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

/** Pins this process, and so its threads and its children, to `mask`. True when it took. */
export function applyProcessAffinity(mask: bigint, log?: Logger): boolean {
  const k = loadKernel32(log);
  if (!k) return false;
  try {
    const ok = k.SetProcessAffinityMask(k.GetCurrentProcess(), mask) !== 0;
    if (ok) log?.info("pinned to the performance cores", { cpus: maskArg(mask), count: maskCount(mask) });
    else log?.warn("affinity refused by the system", { cpus: maskArg(mask) });
    return ok;
  } catch (e) {
    log?.debug("affinity not applied", { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

const PROCESS_SET_INFORMATION = 0x0200;
const PROCESS_QUERY_INFORMATION = 0x0400;

/** Pins another process, a sidecar just spawned. True when it took. */
export function applyPidAffinity(pid: number, mask: bigint, log?: Logger): boolean {
  const k = loadKernel32(log);
  if (!k) return false;
  let handle = 0n;
  try {
    handle = k.OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION, 0, pid);
    if (handle === 0n) return false;
    const ok = k.SetProcessAffinityMask(handle, mask) !== 0;
    if (ok) log?.info("sidecar pinned to the performance cores", { pid, cpus: maskArg(mask) });
    return ok;
  } catch (e) {
    log?.debug("sidecar affinity not applied", { pid, error: e instanceof Error ? e.message : String(e) });
    return false;
  } finally {
    if (handle !== 0n) {
      try {
        k.CloseHandle(handle);
      } catch {
        // the handle goes with the process
      }
    }
  }
}

/**
 * The mask a config value asks for: `auto` detects the performance cores, `off` pins
 * nothing, anything else is a CPU list. Undefined means nothing is pinned.
 */
export function resolveAffinity(setting: string, log?: Logger): bigint | undefined {
  if (setting === "off") return undefined;
  if (setting === "auto") return pCoreMask(log);
  const mask = parseMask(setting);
  if (mask === undefined) log?.warn("[voice] cpu_affinity is not a CPU list; nothing pinned", { setting });
  return mask;
}
