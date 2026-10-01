// Windows: every process from one NtQuerySystemInformation(SystemProcessInformation) call,
// the machine's busy and total time from GetSystemTimes, memory from GlobalMemoryStatusEx.
// No shell, no WMI, no per-process handles. Spike 13 verified the x64 layout below against
// the daemon's own row and measured the call at ~12 ms for 780 processes: the kernel copies
// every thread's record too, and no cheaper class carries CPU time and parent.
//
// SYSTEM_PROCESS_INFORMATION, x64: NextEntryOffset u32 @0, CreateTime i64 @32, UserTime i64
// @40, KernelTime i64 @48, ImageName {Length u16 @56, Buffer ptr @64}, UniqueProcessId @80,
// InheritedFromUniqueProcessId @88, WorkingSetSize @144.
//
// A process's command line is read here too (`windowsCommandLine`), through
// NtQueryInformationProcess(ProcessCommandLineInformation) on a handle that may only query:
// a call of a millisecond where PowerShell's CIM query takes a second, and five under load.

import { cpus } from "node:os";
import type { MetricsEngine, RawProcess, RawSample } from "./engine.ts";

const SYSTEM_PROCESS_INFORMATION = 5;
/** 0xC0000004 as the i32 the call returns: the buffer is too small, and `returned` says by how much. */
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;
const INITIAL_BUFFER = 512 * 1024;
const MAX_BUFFER = 64 * 1024 * 1024;
const MEMORYSTATUSEX_LENGTH = 64;
/** 1970-01-01 as a FILETIME. */
const FILETIME_EPOCH = 116444736000000000n;

interface Ntdll {
  NtQuerySystemInformation: (cls: number, buffer: unknown, length: number, returned: unknown) => number;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_COMMAND_LINE_INFORMATION = 60;
/** 0xC0000003 as an i32: the class is unknown, before Windows 8.1. */
const STATUS_INVALID_INFO_CLASS = -1073741821;

interface CommandLineCalls {
  OpenProcess: (access: number, inherit: number, pid: number) => bigint;
  CloseHandle: (handle: bigint) => number;
  NtQueryInformationProcess: (handle: bigint, cls: number, buffer: unknown, length: number, returned: unknown) => number;
  ptr: (view: ArrayBufferView) => unknown;
  /** A UNICODE_STRING (16 bytes) and the text it points at, which is at most 65535 bytes: no call needs more. */
  buffer: Uint8Array;
  decoder: TextDecoder;
}

let commandLineCalls: CommandLineCalls | null | undefined;

/** kernel32 and ntdll through `bun:ffi`, loaded at the first read; null off Windows or where they cannot be. */
function loadCommandLineCalls(): CommandLineCalls | null {
  if (commandLineCalls !== undefined) return commandLineCalls;
  if (process.platform !== "win32") return (commandLineCalls = null);
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const kernel32 = ffi.dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols;
    const ntdll = ffi.dlopen("ntdll.dll", {
      NtQueryInformationProcess: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    commandLineCalls = {
      ...(kernel32 as unknown as Pick<CommandLineCalls, "OpenProcess" | "CloseHandle">),
      ...(ntdll as unknown as Pick<CommandLineCalls, "NtQueryInformationProcess">),
      ptr: ffi.ptr as unknown as (view: ArrayBufferView) => unknown,
      buffer: new Uint8Array(16 + 65536),
      decoder: new TextDecoder("utf-16le"),
    };
  } catch {
    commandLineCalls = null;
  }
  return commandLineCalls;
}

/**
 * A process's command line as one string, read natively: `undefined` when the process cannot
 * be opened or read (gone, or not this user's to read), `null` when there is no native way to
 * read it here (off Windows, no FFI, or a Windows before 8.1), where the caller asks PowerShell.
 */
export function windowsCommandLine(pid: number): string | undefined | null {
  const c = loadCommandLineCalls();
  if (!c) return null;
  const handle = c.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return undefined;
  try {
    const returned = new Uint32Array(1);
    const status = c.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, c.ptr(c.buffer), c.buffer.byteLength, c.ptr(returned));
    if (status === STATUS_INVALID_INFO_CLASS) return null;
    if (status !== 0) return undefined;
    const view = new DataView(c.buffer.buffer, c.buffer.byteOffset, c.buffer.byteLength);
    const length = view.getUint16(0, true);
    if (length === 0) return "";
    // The text lives inside the same buffer, after the UNICODE_STRING; only a pointer within it is followed.
    const rel = Number(view.getBigUint64(8, true)) - Number(c.ptr(c.buffer));
    if (rel < 16 || rel + length > c.buffer.byteLength) return undefined;
    return c.decoder.decode(c.buffer.subarray(rel, rel + length));
  } finally {
    c.CloseHandle(handle);
  }
}
interface Kernel32 {
  GetSystemTimes: (idle: unknown, kernel: unknown, user: unknown) => number;
  GlobalMemoryStatusEx: (status: unknown) => number;
}

export class WindowsEngine implements MetricsEngine {
  readonly name = "windows";
  private ntdll: Ntdll;
  private kernel32: Kernel32;
  private ptr: (view: ArrayBufferView, offset?: number) => unknown;
  private buffer = new Uint8Array(INITIAL_BUFFER);
  private returned = new Uint32Array(1);
  private times = new BigUint64Array(3);
  private memory = new Uint8Array(MEMORYSTATUSEX_LENGTH);
  private decoder = new TextDecoder("utf-16le");
  private cores = cpus().length;

  constructor() {
    // Imported here, not at the top: `bun:ffi` is Bun's alone and this file is typechecked everywhere.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    this.ptr = ffi.ptr as unknown as (view: ArrayBufferView, offset?: number) => unknown;
    this.ntdll = ffi.dlopen("ntdll.dll", {
      NtQuerySystemInformation: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as Ntdll;
    this.kernel32 = ffi.dlopen("kernel32.dll", {
      GetSystemTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GlobalMemoryStatusEx: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as Kernel32;
  }

  /** The process buffer's size, for the tests: it grows on demand and is kept. */
  get bufferBytes(): number {
    return this.buffer.byteLength;
  }

  sample(): RawSample {
    for (;;) {
      const status = this.ntdll.NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, this.ptr(this.buffer), this.buffer.byteLength, this.ptr(this.returned));
      if (status === STATUS_INFO_LENGTH_MISMATCH) {
        if (this.buffer.byteLength >= MAX_BUFFER) throw new Error("process list over 64 MB");
        this.buffer = new Uint8Array(this.buffer.byteLength * 2);
        continue;
      }
      if (status !== 0) throw new Error(`NtQuerySystemInformation failed: 0x${(status >>> 0).toString(16)}`);
      break;
    }
    const at = Date.now();
    const monoNs = process.hrtime.bigint();
    const buffer = this.buffer;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const base = Number(this.ptr(buffer));
    const processes: RawProcess[] = [];
    let offset = 0;
    for (;;) {
      const next = view.getUint32(offset, true);
      // Handles and sizes are 64-bit; read as two halves, since none of them nears 2^53.
      const pid = view.getUint32(offset + 80, true) + view.getUint32(offset + 84, true) * 4294967296;
      const parent = view.getUint32(offset + 88, true) + view.getUint32(offset + 92, true) * 4294967296;
      const cpu100ns = view.getUint32(offset + 40, true) + view.getUint32(offset + 44, true) * 4294967296 + view.getUint32(offset + 48, true) + view.getUint32(offset + 52, true) * 4294967296;
      const rss = view.getUint32(offset + 144, true) + view.getUint32(offset + 148, true) * 4294967296;
      // A FILETIME, 100 ns since 1601; the Idle and System processes have none.
      const created = view.getBigUint64(offset + 32, true);
      const nameLen = view.getUint16(offset + 56, true);
      const nameAddr = view.getUint32(offset + 64, true) + view.getUint32(offset + 68, true) * 4294967296;
      let name = "?";
      if (nameLen > 0 && nameAddr !== 0) {
        // The name lives inside this same buffer; only a pointer within it is followed.
        const rel = nameAddr - base;
        if (rel >= 0 && rel + nameLen <= buffer.byteLength) name = this.decoder.decode(buffer.subarray(rel, rel + nameLen)) || "?";
      }
      if (pid !== 0) processes.push({ pid, parent, name, cpuTimeNs: cpu100ns * 100, rss, ...(created > 0n ? { startedAt: Number((created - FILETIME_EPOCH) / 10000n) } : {}) });
      if (next === 0) break;
      offset += next;
    }

    if (!this.kernel32.GetSystemTimes(this.ptr(this.times, 0), this.ptr(this.times, 8), this.ptr(this.times, 16))) throw new Error("GetSystemTimes failed");
    const idle = this.times[0]!;
    const kernel = this.times[1]!;
    const user = this.times[2]!;
    // Kernel time includes idle; all three are summed over every core, in 100 ns units.
    const busyNs = Number(kernel - idle + user) * 100;
    const totalNs = Number(kernel + user) * 100;

    const mv = new DataView(this.memory.buffer);
    mv.setUint32(0, MEMORYSTATUSEX_LENGTH, true);
    if (!this.kernel32.GlobalMemoryStatusEx(this.ptr(this.memory))) throw new Error("GlobalMemoryStatusEx failed");
    const total = Number(mv.getBigUint64(8, true));
    const available = Number(mv.getBigUint64(16, true));

    return { at, monoNs, cores: this.cores, cpu: { busyNs, totalNs }, memory: { used: total - available, total }, processes };
  }
}
