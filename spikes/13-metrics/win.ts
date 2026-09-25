// Windows: every process with its CPU time, parent, name and working set from one
// NtQuerySystemInformation(SystemProcessInformation) call; the machine's busy and total
// time from GetSystemTimes; memory from GlobalMemoryStatusEx. No shell, no WMI.
//
//   bun run win.ts          one sample, timings, cophylad's own row (verifies the offsets)
//
// Layout of SYSTEM_PROCESS_INFORMATION on x64 (ntexapi.h, verified against this process's row):
//   NextEntryOffset u32 @0, NumberOfThreads u32 @4, WorkingSetPrivateSize i64 @8, HardFaultCount u32 @16,
//   NumberOfThreadsHighWatermark u32 @20, CycleTime u64 @24, CreateTime i64 @32, UserTime i64 @40,
//   KernelTime i64 @48, ImageName UNICODE_STRING {Length u16 @56, MaximumLength u16 @58, Buffer ptr @64},
//   BasePriority i32 @72, UniqueProcessId ptr @80, InheritedFromUniqueProcessId ptr @88, HandleCount u32 @96,
//   SessionId u32 @100, UniqueProcessKey @104, PeakVirtualSize @112, VirtualSize @120, PageFaultCount u32 @128,
//   PeakWorkingSetSize @136, WorkingSetSize @144, ...

import { dlopen, FFIType, ptr } from "bun:ffi";
import { cpus } from "node:os";
import type { RawProcess, RawSample } from "./_shared.ts";

const SYSTEM_PROCESS_INFORMATION = 5;
const STATUS_INFO_LENGTH_MISMATCH = -1073741820; // 0xC0000004 as i32

const ntdll = dlopen("ntdll.dll", {
  NtQuerySystemInformation: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
});
const kernel32 = dlopen("kernel32.dll", {
  GetSystemTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  GlobalMemoryStatusEx: { args: [FFIType.ptr], returns: FFIType.i32 },
});

let buffer = new Uint8Array(512 * 1024);
const returned = new Uint32Array(1);
const times = new BigUint64Array(3);
const memStatus = new Uint8Array(64);
const decoder = new TextDecoder("utf-16le");
const cores = cpus().length;

export function grows(): number {
  return buffer.byteLength;
}

export function sample(): RawSample {
  // The process list: grow until it fits, keep the buffer for next time.
  for (;;) {
    const status = ntdll.symbols.NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, ptr(buffer), buffer.byteLength, ptr(returned));
    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      buffer = new Uint8Array(buffer.byteLength * 2);
      continue;
    }
    if (status !== 0) throw new Error(`NtQuerySystemInformation: 0x${(status >>> 0).toString(16)}`);
    break;
  }
  const at = Date.now();
  const monoNs = process.hrtime.bigint();
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const base = BigInt(ptr(buffer));
  const processes: RawProcess[] = [];
  let offset = 0;
  for (;;) {
    const next = view.getUint32(offset, true);
    const pid = Number(view.getBigUint64(offset + 80, true));
    const parent = Number(view.getBigUint64(offset + 88, true));
    const user = view.getBigInt64(offset + 40, true);
    const kernel = view.getBigInt64(offset + 48, true);
    const rss = Number(view.getBigUint64(offset + 144, true));
    const nameLen = view.getUint16(offset + 56, true);
    const nameBuf = view.getBigUint64(offset + 64, true);
    let name = "?";
    if (nameLen > 0 && nameBuf !== 0n) {
      const rel = Number(nameBuf - base);
      if (rel >= 0 && rel + nameLen <= buffer.byteLength) name = decoder.decode(buffer.subarray(rel, rel + nameLen));
    }
    if (pid !== 0) processes.push({ pid, parent, name, cpuTimeNs: Number(user + kernel) * 100, rss });
    if (next === 0) break;
    offset += next;
  }

  if (!kernel32.symbols.GetSystemTimes(ptr(times, 0), ptr(times, 8), ptr(times, 16))) throw new Error("GetSystemTimes failed");
  const idle = times[0]!;
  const kernel = times[1]!;
  const user = times[2]!;
  // Kernel time includes idle; all three are summed over every core, in 100 ns units.
  const busyNs = Number(kernel - idle + user) * 100;
  const totalNs = Number(kernel + user) * 100;

  const mv = new DataView(memStatus.buffer);
  mv.setUint32(0, 64, true);
  if (!kernel32.symbols.GlobalMemoryStatusEx(ptr(memStatus))) throw new Error("GlobalMemoryStatusEx failed");
  const total = Number(mv.getBigUint64(8, true));
  const avail = Number(mv.getBigUint64(16, true));

  return { at, monoNs, cores, cpu: { busyNs, totalNs }, memory: { used: total - avail, total }, processes };
}

if (import.meta.main) {
  const t0 = performance.now();
  const s = sample();
  const t1 = performance.now();
  const me = s.processes.find((p) => p.pid === process.pid);
  const parent = s.processes.find((p) => p.pid === process.ppid);
  console.log(`processes ${s.processes.length} in ${(t1 - t0).toFixed(2)} ms, buffer ${grows() / 1024} KB, cores ${s.cores}`);
  console.log("me:", me, "cpuUsage:", process.cpuUsage(), "rss:", process.memoryUsage().rss);
  console.log("parent:", parent);
  console.log("memory:", s.memory, "busy/total ns:", s.cpu);
  const runs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    sample();
    runs.push(performance.now() - a);
  }
  runs.sort((a, b) => a - b);
  console.log(`20 walks: min ${runs[0]!.toFixed(2)} median ${runs[10]!.toFixed(2)} max ${runs[19]!.toFixed(2)} ms`);
}
