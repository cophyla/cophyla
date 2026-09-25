// macOS: every pid from libproc's `proc_listallpids`, each one's CPU time and resident size
// from `proc_pidinfo(PROC_PIDTASKINFO)` and its parent and name from `PROC_PIDTBSDINFO`;
// the machine's ticks from `host_statistics64(HOST_CPU_LOAD_INFO)`, memory from
// `hw.memsize` and `host_statistics64(HOST_VM_INFO64)`. Written from the headers
// (libproc.h, mach/host_info.h, mach/vm_statistics.h) and unverified until the Mac visit:
// any failure at the first sample makes `hostEngine` fall back to the unavailable engine.
//
// proc_taskinfo: pti_virtual_size u64 @0, pti_resident_size u64 @8, pti_total_user u64 @16,
// pti_total_system u64 @24 (mach absolute time units; scaled by mach_timebase_info).
// proc_bsdinfo: pbi_ppid u32 @16, pbi_comm char[16] @48, pbi_name char[32] @64.
// host_cpu_load_info: cpu_ticks[4] u32 = user, system, idle, nice.
// vm_statistics64: free u32 @0, active @4, inactive @8, wire @12, ..., compressor_page_count @128.

import { cpus } from "node:os";
import type { MetricsEngine, RawProcess, RawSample } from "./engine.ts";

const PROC_PIDTBSDINFO = 3;
const PROC_PIDTASKINFO = 4;
const HOST_CPU_LOAD_INFO = 3;
const HOST_VM_INFO64 = 4;
const HOST_CPU_LOAD_INFO_COUNT = 4;
const HOST_VM_INFO64_COUNT = 38;
const CLK_TCK = 100;

interface Libproc {
  proc_listallpids: (buffer: unknown, size: number) => number;
  proc_pidinfo: (pid: number, flavor: number, arg: bigint, buffer: unknown, size: number) => number;
}
interface LibSystem {
  mach_host_self: () => number;
  host_statistics64: (host: number, flavor: number, info: unknown, count: unknown) => number;
  sysctlbyname: (name: unknown, out: unknown, size: unknown, newp: unknown, newlen: number) => number;
  mach_timebase_info: (info: unknown) => number;
}

export class MacEngine implements MetricsEngine {
  readonly name = "macos";
  private libproc: Libproc;
  private sys: LibSystem;
  private ptr: (view: ArrayBufferView, offset?: number) => unknown;
  private cores = cpus().length;
  private pids = new Int32Array(1024);
  private task = new Uint8Array(128);
  private bsd = new Uint8Array(160);
  private load = new Uint32Array(HOST_CPU_LOAD_INFO_COUNT);
  private vm = new Uint32Array(HOST_VM_INFO64_COUNT);
  private count = new Uint32Array(1);
  private memTotal: number;
  private pageSize: number;
  /** Nanoseconds per mach time unit. */
  private tickNs: number;
  private decoder = new TextDecoder();

  constructor() {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    this.ptr = ffi.ptr as unknown as (view: ArrayBufferView, offset?: number) => unknown;
    this.libproc = ffi.dlopen("libproc.dylib", {
      proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols as unknown as Libproc;
    this.sys = ffi.dlopen("libSystem.B.dylib", {
      mach_host_self: { args: [], returns: FFIType.u32 },
      host_statistics64: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      sysctlbyname: { args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as LibSystem;
    const timebase = new Uint32Array(2);
    if (this.sys.mach_timebase_info(this.ptr(timebase)) !== 0) throw new Error("mach_timebase_info failed");
    this.tickNs = timebase[0]! / timebase[1]!;
    this.memTotal = this.sysctlU64("hw.memsize");
    this.pageSize = this.sysctlU64("hw.pagesize") || 16384;
  }

  private sysctlU64(name: string): number {
    const out = new BigUint64Array(1);
    const size = new BigUint64Array([8n]);
    const cname = Buffer.from(name + "\0", "utf8");
    if (this.sys.sysctlbyname(this.ptr(cname), this.ptr(out), this.ptr(size), null, 0) !== 0) throw new Error(`sysctlbyname ${name} failed`);
    return Number(out[0]!);
  }

  private cstring(buffer: Uint8Array, at: number, max: number): string {
    let end = at;
    while (end < at + max && buffer[end] !== 0) end++;
    return this.decoder.decode(buffer.subarray(at, end));
  }

  sample(): RawSample {
    const at = Date.now();
    const monoNs = process.hrtime.bigint();
    let n = this.libproc.proc_listallpids(null, 0);
    if (n <= 0) throw new Error("proc_listallpids failed");
    if (n > this.pids.length) this.pids = new Int32Array(n * 2);
    n = this.libproc.proc_listallpids(this.ptr(this.pids), this.pids.byteLength);
    const processes: RawProcess[] = [];
    const task = new DataView(this.task.buffer);
    const bsd = new DataView(this.bsd.buffer);
    for (let i = 0; i < n; i++) {
      const pid = this.pids[i]!;
      if (pid <= 0) continue;
      if (this.libproc.proc_pidinfo(pid, PROC_PIDTASKINFO, 0n, this.ptr(this.task), this.task.byteLength) <= 0) continue;
      if (this.libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, this.ptr(this.bsd), this.bsd.byteLength) <= 0) continue;
      const rss = Number(task.getBigUint64(8, true));
      const cpuUnits = Number(task.getBigUint64(16, true) + task.getBigUint64(24, true));
      const parent = bsd.getUint32(16, true);
      const name = this.cstring(this.bsd, 64, 32) || this.cstring(this.bsd, 48, 16) || "?";
      processes.push({ pid, parent, name, cpuTimeNs: cpuUnits * this.tickNs, rss });
    }

    const host = this.sys.mach_host_self();
    this.count[0] = HOST_CPU_LOAD_INFO_COUNT;
    if (this.sys.host_statistics64(host, HOST_CPU_LOAD_INFO, this.ptr(this.load), this.ptr(this.count)) !== 0) throw new Error("host_statistics64(cpu) failed");
    const [user, system, idle, nice] = [this.load[0]!, this.load[1]!, this.load[2]!, this.load[3]!];
    const busyNs = ((user + system + nice) * 1e9) / CLK_TCK;
    const totalNs = ((user + system + idle + nice) * 1e9) / CLK_TCK;

    this.count[0] = HOST_VM_INFO64_COUNT;
    if (this.sys.host_statistics64(host, HOST_VM_INFO64, this.ptr(this.vm), this.ptr(this.count)) !== 0) throw new Error("host_statistics64(vm) failed");
    const used = (this.vm[1]! + this.vm[3]! + this.vm[32]!) * this.pageSize;

    return { at, monoNs, cores: this.cores, cpu: { busyNs, totalNs }, memory: { used: Math.min(used, this.memTotal), total: this.memTotal }, processes };
  }
}
