// macOS: every pid from libproc's `proc_listallpids`, each one's CPU time and resident size
// from `proc_pidinfo(PROC_PIDTASKINFO)` and its parent and name from `PROC_PIDTBSDINFO`;
// the machine's ticks from `host_statistics64(HOST_CPU_LOAD_INFO)`, memory from
// `hw.memsize` and `host_statistics64(HOST_VM_INFO64)`. Written from the headers
// (libproc.h, mach/host_info.h, mach/vm_statistics.h), checked against the macOS 14 SDK
// and on an Apple Silicon Mac; any failure at the first sample makes `hostEngine` fall back
// to the unavailable engine.
//
// Another user's process (root's `login` between Terminal and every shell it runs,
// WindowServer) refuses both, but `PROC_PIDT_SHORTBSDINFO` still gives its parent and name:
// it is listed with no CPU time or memory of its own, so a walk up the tree passes through it.
// A process whose name is a version (Claude Code's native install runs
// `~/.local/share/claude/versions/2.1.243`, and macOS names a process by its file) is named
// after the folder its `versions/` is in, from `proc_pidpath`.
//
// proc_taskinfo: pti_virtual_size u64 @0, pti_resident_size u64 @8, pti_total_user u64 @16,
// pti_total_system u64 @24 (mach absolute time units; scaled by mach_timebase_info).
// proc_bsdinfo: pbi_ppid u32 @16, pbi_comm char[16] @48, pbi_name char[32] @64.
// proc_bsdshortinfo (64 bytes): pbsi_ppid u32 @4, pbsi_comm char[16] @16.
// host_cpu_load_info: cpu_ticks[4] u32 = user, system, idle, nice.
// vm_statistics64: free u32 @0, active @4, inactive @8, wire @12, ..., compressor_page_count @128.

import { cpus } from "node:os";
import type { MetricsEngine, RawProcess, RawSample } from "./engine.ts";

const PROC_PIDTBSDINFO = 3;
const PROC_PIDTASKINFO = 4;
const PROC_PIDT_SHORTBSDINFO = 13;
const PROC_PIDPATHINFO_MAXSIZE = 4096;
const HOST_CPU_LOAD_INFO = 3;
const HOST_VM_INFO64 = 4;
const HOST_CPU_LOAD_INFO_COUNT = 4;
const HOST_VM_INFO64_COUNT = 38;
const CLK_TCK = 100;

interface Libproc {
  proc_listallpids: (buffer: unknown, size: number) => number;
  proc_pidinfo: (pid: number, flavor: number, arg: bigint, buffer: unknown, size: number) => number;
  proc_pidpath: (pid: number, buffer: unknown, size: number) => number;
}
interface LibSystem {
  mach_host_self: () => number;
  host_statistics64: (host: number, flavor: number, info: unknown, count: unknown) => number;
  sysctlbyname: (name: unknown, out: unknown, size: unknown, newp: unknown, newlen: number) => number;
  mach_timebase_info: (info: unknown) => number;
}

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;

type Sysctl = (mib: unknown, len: number, out: unknown, size: unknown, newp: unknown, newlen: number) => number;
let procargs: { sysctl: Sysctl; ptr: (v: ArrayBufferView) => unknown; buffer: Uint8Array } | null | undefined;

/**
 * A process's arguments exactly as it was started, from `sysctl(KERN_PROCARGS2)`: argc, the
 * executable's path, padding, then argv, each NUL-terminated. `ps` joins them with spaces, so
 * an argument holding one ("Application Support", `--settings '{…}'`) cannot be told apart
 * there. Undefined off macOS, for another user's process, or when the call fails.
 */
export function darwinArgv(pid: number): string[] | undefined {
  if (process.platform !== "darwin") return undefined;
  if (procargs === undefined) {
    try {
      const ffi = require("bun:ffi") as typeof import("bun:ffi");
      const { FFIType } = ffi;
      const sysctl = ffi.dlopen("libSystem.B.dylib", {
        sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      }).symbols.sysctl as unknown as Sysctl;
      const ptr = ffi.ptr as unknown as (v: ArrayBufferView) => unknown;
      const max = new Int32Array(1);
      const size = new BigUint64Array([4n]);
      const argmax = sysctl(ptr(new Int32Array([CTL_KERN, KERN_ARGMAX])), 2, ptr(max), ptr(size), null, 0) === 0 && max[0]! > 0 ? max[0]! : 1 << 20;
      procargs = { sysctl, ptr, buffer: new Uint8Array(argmax) };
    } catch {
      procargs = null;
    }
  }
  if (!procargs) return undefined;
  const { sysctl, ptr, buffer } = procargs;
  const size = new BigUint64Array([BigInt(buffer.byteLength)]);
  if (sysctl(ptr(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid])), 3, ptr(buffer), ptr(size), null, 0) !== 0) return undefined;
  return parseProcArgs(buffer.subarray(0, Number(size[0]!)));
}

/** argv from a `KERN_PROCARGS2` answer: argc (int32), the executable path, NUL padding, then argc strings. */
export function parseProcArgs(bytes: Uint8Array): string[] | undefined {
  if (bytes.byteLength < 4) return undefined;
  const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
  if (argc <= 0) return undefined;
  let at = 4;
  while (at < bytes.length && bytes[at] !== 0) at++; // the executable's path
  while (at < bytes.length && bytes[at] === 0) at++; // its padding
  const decoder = new TextDecoder();
  const argv: string[] = [];
  while (argv.length < argc && at < bytes.length) {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    argv.push(decoder.decode(bytes.subarray(at, end)));
    at = end + 1;
  }
  return argv.length === argc ? argv : undefined;
}

/** A name that is a version number: `2.1.243`, `v1.2`. */
const VERSION = /^v?\d+(\.\d+)+$/;

/** The folder a versioned install keeps its `versions/` in: `claude` for `/…/claude/versions/2.1.243`. */
export function installNameOf(path: string): string | undefined {
  const parts = path.split("/");
  return parts.length >= 3 && parts[parts.length - 2] === "versions" && VERSION.test(parts[parts.length - 1]!) ? parts[parts.length - 3] || undefined : undefined;
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
  private short = new Uint8Array(64);
  private path = new Uint8Array(PROC_PIDPATHINFO_MAXSIZE);
  /** The name a version-named process was given, by pid and the name it had: read once. */
  private renamed = new Map<number, { from: string; to: string }>();
  private host: number;
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
      proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
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
    // a send right of this task's own, held for the engine's life: asked for once, not per sample
    this.host = this.sys.mach_host_self();
  }

  private sysctlU64(name: string): number {
    const out = new BigUint64Array(1);
    const size = new BigUint64Array([8n]);
    const cname = Buffer.from(name + "\0", "utf8");
    if (this.sys.sysctlbyname(this.ptr(cname), this.ptr(out), this.ptr(size), null, 0) !== 0) throw new Error(`sysctlbyname ${name} failed`);
    return Number(out[0]!);
  }

  /** `claude` for `…/claude/versions/2.1.243`; the version itself for anything else. */
  private installName(pid: number, name: string): string {
    const known = this.renamed.get(pid);
    if (known?.from === name) return known.to;
    const len = this.libproc.proc_pidpath(pid, this.ptr(this.path), this.path.byteLength);
    const to = len > 0 ? installNameOf(this.decoder.decode(this.path.subarray(0, len))) ?? name : name;
    this.renamed.set(pid, { from: name, to });
    return to;
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
    const short = new DataView(this.short.buffer);
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const pid = this.pids[i]!;
      if (pid <= 0) continue;
      let parent: number;
      let name: string;
      if (this.libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, this.ptr(this.bsd), this.bsd.byteLength) > 0) {
        parent = bsd.getUint32(16, true);
        name = this.cstring(this.bsd, 64, 32) || this.cstring(this.bsd, 48, 16) || "?";
      } else if (this.libproc.proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0n, this.ptr(this.short), this.short.byteLength) > 0) {
        parent = short.getUint32(4, true);
        name = this.cstring(this.short, 16, 16) || "?";
      } else continue;
      seen.add(pid);
      if (VERSION.test(name)) name = this.installName(pid, name);
      let rss = 0;
      let cpuTimeNs = 0;
      if (this.libproc.proc_pidinfo(pid, PROC_PIDTASKINFO, 0n, this.ptr(this.task), this.task.byteLength) > 0) {
        rss = Number(task.getBigUint64(8, true));
        cpuTimeNs = Number(task.getBigUint64(16, true) + task.getBigUint64(24, true)) * this.tickNs;
      }
      processes.push({ pid, parent, name, cpuTimeNs, rss });
    }
    for (const pid of this.renamed.keys()) if (!seen.has(pid)) this.renamed.delete(pid);

    const host = this.host;
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
