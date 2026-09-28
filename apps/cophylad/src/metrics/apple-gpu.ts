// The GPU of a Mac through IOKit, where NVML has nothing to load: every IOAccelerator service
// (one per GPU; Apple Silicon has one) keeps a `PerformanceStatistics` dictionary that the
// driver refreshes, with "Device Utilization %" and "In use system memory" (bytes of the
// unified memory the GPU holds), and a "model" such as "Apple M2 Pro". The memory is the
// machine's own, so the total is the RAM. The services are found once and read at every
// sample; per-process use is not kept there, so `processes` is empty. A Mac whose IOKit
// answers nothing is logged once and read as no GPU from then on. Every CoreFoundation object
// is held as a 64-bit integer, not bun:ffi's pointer: a short CFString is a tagged pointer
// with its top bits set, which a pointer's double would round into another address.

import { totalmem } from "node:os";
import type { Logger } from "../log.ts";
import type { RawGpu } from "./engine.ts";

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const UTF8 = 0x08000100;
const SINT64 = 4;

/** The statistics' keys this reads, as the driver names them. */
export const STAT_KEYS = { util: "Device Utilization %", inUse: "In use system memory" } as const;

/** A CoreFoundation object, `0n` for none. */
type CF = bigint;

interface Symbols {
  IOServiceMatching: (name: unknown) => CF;
  IOServiceGetMatchingServices: (port: number, matching: CF, iterator: unknown) => number;
  IOIteratorNext: (iterator: number) => number;
  IOObjectRelease: (object: number) => number;
  IORegistryEntryCreateCFProperty: (entry: number, key: CF, allocator: CF, options: number) => CF;
  CFStringCreateWithCString: (allocator: CF, text: unknown, encoding: number) => CF;
  CFStringGetCString: (string: CF, buffer: unknown, size: number, encoding: number) => boolean;
  CFDictionaryGetValue: (dict: CF, key: CF) => CF;
  CFNumberGetValue: (number: CF, type: number, out: unknown) => boolean;
  CFRelease: (object: CF) => void;
}

export class AppleGpu {
  private log: Logger;
  private state: "new" | "up" | "off" = "new";
  private s?: Symbols;
  private ptr?: (view: ArrayBufferView) => unknown;
  private services: { entry: number; name: string }[] = [];
  private keys?: { stats: CF; util: CF; inUse: CF };
  private number = new BigInt64Array(1);
  private text = new Uint8Array(128);
  private decoder = new TextDecoder();

  constructor(log: Logger) {
    this.log = log;
  }

  private cfString(text: string): CF {
    const s = this.s!.CFStringCreateWithCString(0n, this.ptr!(Buffer.from(`${text}\0`, "utf8")), UTF8);
    if (s === 0n) throw new Error(`CFString ${text} not made`);
    return s;
  }

  /** A property of a registry entry as a string, or undefined. */
  private stringProperty(entry: number, key: string): string | undefined {
    const k = this.cfString(key);
    try {
      const v = this.s!.IORegistryEntryCreateCFProperty(entry, k, 0n, 0);
      if (v === 0n) return undefined;
      try {
        if (!this.s!.CFStringGetCString(v, this.ptr!(this.text), this.text.byteLength, UTF8)) return undefined;
        const end = this.text.indexOf(0);
        return this.decoder.decode(this.text.subarray(0, end < 0 ? this.text.byteLength : end)) || undefined;
      } finally {
        this.s!.CFRelease(v);
      }
    } finally {
      this.s!.CFRelease(k);
    }
  }

  private init(): boolean {
    if (this.state !== "new") return this.state === "up";
    try {
      const ffi = require("bun:ffi") as typeof import("bun:ffi");
      const { FFIType } = ffi;
      this.ptr = ffi.ptr as unknown as (view: ArrayBufferView) => unknown;
      const { u64 } = FFIType;
      const io = ffi.dlopen(IOKIT, {
        IOServiceMatching: { args: [FFIType.ptr], returns: u64 },
        IOServiceGetMatchingServices: { args: [FFIType.u32, u64, FFIType.ptr], returns: FFIType.i32 },
        IOIteratorNext: { args: [FFIType.u32], returns: FFIType.u32 },
        IOObjectRelease: { args: [FFIType.u32], returns: FFIType.i32 },
        IORegistryEntryCreateCFProperty: { args: [FFIType.u32, u64, u64, FFIType.u32], returns: u64 },
      });
      const cf = ffi.dlopen(CORE_FOUNDATION, {
        CFStringCreateWithCString: { args: [u64, FFIType.ptr, FFIType.u32], returns: u64 },
        CFStringGetCString: { args: [u64, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
        CFDictionaryGetValue: { args: [u64, u64], returns: u64 },
        CFNumberGetValue: { args: [u64, FFIType.i64, FFIType.ptr], returns: FFIType.bool },
        CFRelease: { args: [u64], returns: FFIType.void },
      });
      this.s = { ...io.symbols, ...cf.symbols } as unknown as Symbols;
      const matching = this.s.IOServiceMatching(this.ptr(Buffer.from("IOAccelerator\0", "utf8")));
      if (matching === 0n) throw new Error("IOServiceMatching answered nothing");
      const iterator = new Uint32Array(1);
      // The matching dictionary is consumed by the call.
      const rc = this.s.IOServiceGetMatchingServices(0, matching, this.ptr(iterator));
      if (rc !== 0) throw new Error(`IOServiceGetMatchingServices ${rc}`);
      for (let entry = this.s.IOIteratorNext(iterator[0]!), i = 0; entry !== 0; entry = this.s.IOIteratorNext(iterator[0]!), i++) {
        this.services.push({ entry, name: this.stringProperty(entry, "model") ?? `gpu${i}` });
      }
      this.s.IOObjectRelease(iterator[0]!);
      if (this.services.length === 0) {
        this.log.info("no GPU metrics: no IOAccelerator");
        this.state = "off";
        return false;
      }
      this.keys = { stats: this.cfString("PerformanceStatistics"), util: this.cfString(STAT_KEYS.util), inUse: this.cfString(STAT_KEYS.inUse) };
      this.state = "up";
      return true;
    } catch (e) {
      this.log.info("no GPU metrics: IOKit not read", { error: e instanceof Error ? e.message : String(e) });
      this.dispose();
      this.state = "off";
      return false;
    }
  }

  private numberIn(dict: CF, key: CF): number | undefined {
    const v = this.s!.CFDictionaryGetValue(dict, key);
    if (v === 0n || !this.s!.CFNumberGetValue(v, SINT64, this.ptr!(this.number))) return undefined;
    return Number(this.number[0]!);
  }

  /** Every GPU's name, utilisation and unified memory in use, or undefined when IOKit has none. */
  sample(): RawGpu[] | undefined {
    if (!this.init()) return undefined;
    const s = this.s!;
    const keys = this.keys!;
    const total = totalmem();
    const out: RawGpu[] = [];
    for (const { entry, name } of this.services) {
      const stats = s.IORegistryEntryCreateCFProperty(entry, keys.stats, 0n, 0);
      if (stats === 0n) continue;
      try {
        const util = Math.min(100, Math.max(0, this.numberIn(stats, keys.util) ?? 0));
        out.push({ name, util, vramUsed: this.numberIn(stats, keys.inUse) ?? 0, vramTotal: total, processes: new Map() });
      } finally {
        s.CFRelease(stats);
      }
    }
    return out;
  }

  dispose(): void {
    const s = this.s;
    if (!s) return;
    for (const { entry } of this.services) s.IOObjectRelease(entry);
    this.services = [];
    if (this.keys) for (const k of Object.values(this.keys)) s.CFRelease(k);
    this.keys = undefined;
  }
}
