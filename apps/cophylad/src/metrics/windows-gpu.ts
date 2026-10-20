// Any GPU on Windows, where NVML has nothing to load (AMD's, Intel's): the performance
// counters Task Manager reads, through PDH. `GPU Engine` gives each process's share of each
// engine of each adapter, `GPU Adapter Memory` the dedicated memory in use, `GPU Process
// Memory` each process's; every instance names its adapter by LUID. An adapter's utilisation
// is that of its busiest engine, each engine the sum of the processes' shares, as Task
// Manager counts it. DXGI names the adapters and gives their dedicated memory, once at the
// first sample and again, at most once a minute, when the counters name an adapter it did not
// list (a driver restarted; one still unlisted after that is not looked for again). Software
// adapters, and those the counters never name or DXGI never lists (virtual displays, which
// DXGI also lists under the real card's name), are left out. The utilisation counters are
// rates, so the query is collected once when it opens and every sample reads against the
// collection before. The English counter names are added, so a localised Windows reads the
// same. Opening the query costs PDH's first counter its catalogue, 0.1 to 0.5 s once; a
// sample after it about a millisecond. A Windows without the counters is logged once and
// read as no GPU from then on.

import type { Logger } from "../log.ts";
import type { RawGpu } from "./engine.ts";

const PATHS = {
  engine: "\\GPU Engine(*)\\Utilization Percentage",
  adapterMemory: "\\GPU Adapter Memory(*)\\Dedicated Usage",
  processMemory: "\\GPU Process Memory(*)\\Dedicated Usage",
} as const;

const PDH_FMT_DOUBLE = 0x00000200;
const PDH_FMT_NOCAP100 = 0x00008000;
const PDH_MORE_DATA = 0x800007d2;
/** PDH_FMT_COUNTERVALUE_ITEM_W on x64: the name's pointer, CStatus at 8, the double at 16. */
const ITEM_BYTES = 24;
const PDH_CSTATUS_NEW_DATA = 1;

const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0;
const DXGI_ADAPTER_FLAG_SOFTWARE = 2;
/** DXGI_ADAPTER_DESC1: Description WCHAR[128], DedicatedVideoMemory at 272, AdapterLuid at 296, Flags at 304. */
const DESC1_BYTES = 312;
/** IID_IDXGIFactory1, {770aae78-f26f-4dba-a829-253c83d1b387}. */
const IID_IDXGI_FACTORY1 = new Uint8Array([0x78, 0xae, 0x0a, 0x77, 0x6f, 0xf2, 0xba, 0x4d, 0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]);
/** Vtable slots: IUnknown's Release, IDXGIFactory1's EnumAdapters1, IDXGIAdapter1's GetDesc1. */
const RELEASE = 2;
const ENUM_ADAPTERS1 = 12;
const GET_DESC1 = 10;
/** The least time between two listings of the adapters. */
const RELIST_MS = 60_000;

/** An adapter as DXGI lists it. */
export interface DxgiAdapter {
  luid: string;
  name: string;
  dedicated: number;
  software: boolean;
}

/** One instance's value: its name, as the counter set names it. */
export interface CounterValue {
  instance: string;
  value: number;
}

/** An adapter's LUID as the counters write it, `0x<high>_0x<low>`, the same whatever the case or the padding. */
export function luidKey(high: number, low: number): string {
  return `0x${(high >>> 0).toString(16)}_0x${(low >>> 0).toString(16)}`;
}

const LUID = /luid_0x([0-9a-f]+)_0x([0-9a-f]+)_phys_(\d+)/i;
const PID = /^pid_(\d+)_/i;
const ENGINE = /_eng_(\d+)_/i;

function luidOf(instance: string): { luid: string; phys: string } | undefined {
  const m = LUID.exec(instance);
  return m ? { luid: luidKey(parseInt(m[1]!, 16), parseInt(m[2]!, 16)), phys: m[3]! } : undefined;
}

/**
 * The GPUs from one reading of the three counter sets: every adapter DXGI lists that is not
 * software and that the counters name, in DXGI's order, with its busiest engine's
 * utilisation, its dedicated memory in use and each process's.
 */
export function gpusFrom(adapters: DxgiAdapter[], read: { engine: CounterValue[]; adapterMemory: CounterValue[]; processMemory: CounterValue[] }): RawGpu[] {
  const engines = new Map<string, Map<string, number>>();
  for (const { instance, value } of read.engine) {
    const at = luidOf(instance);
    const eng = ENGINE.exec(instance);
    if (!at || !eng) continue;
    const of = engines.get(at.luid) ?? new Map<string, number>();
    const key = `${at.phys}_${eng[1]}`;
    of.set(key, (of.get(key) ?? 0) + value);
    engines.set(at.luid, of);
  }
  const used = new Map<string, number>();
  for (const { instance, value } of read.adapterMemory) {
    const at = luidOf(instance);
    if (at) used.set(at.luid, (used.get(at.luid) ?? 0) + value);
  }
  const processes = new Map<string, Map<number, number>>();
  for (const { instance, value } of read.processMemory) {
    const at = luidOf(instance);
    const pid = PID.exec(instance);
    if (!at || !pid || value <= 0) continue;
    const of = processes.get(at.luid) ?? new Map<number, number>();
    const p = Number(pid[1]);
    of.set(p, (of.get(p) ?? 0) + value);
    processes.set(at.luid, of);
  }
  const out: RawGpu[] = [];
  for (const a of adapters) {
    if (a.software || (!engines.has(a.luid) && !used.has(a.luid))) continue;
    const busiest = Math.max(0, ...(engines.get(a.luid)?.values() ?? []));
    // A process is charged what it shares too (the compositor most), so the rows can add up to
    // more than the adapter holds; one bigger than the whole card is a driver's error.
    const rows = new Map<number, number>();
    for (const [pid, bytes] of processes.get(a.luid) ?? []) if (a.dedicated <= 0 || bytes <= a.dedicated) rows.set(pid, Math.round(bytes));
    out.push({ name: a.name, util: Math.min(100, busiest), vramUsed: Math.round(used.get(a.luid) ?? 0), vramTotal: a.dedicated, processes: rows });
  }
  return out;
}

/** The adapters the counters name that are neither in the list nor among `ignored`. */
export function unlisted(adapters: DxgiAdapter[], instances: Iterable<CounterValue>, ignored: ReadonlySet<string> = new Set()): string[] {
  const known = new Set(adapters.map((a) => a.luid));
  const out = new Set<string>();
  for (const { instance } of instances) {
    const at = luidOf(instance);
    if (at && !known.has(at.luid) && !ignored.has(at.luid)) out.add(at.luid);
  }
  return [...out];
}

interface PdhSymbols {
  PdhOpenQueryW: (source: unknown, user: bigint, query: unknown) => number;
  PdhAddEnglishCounterW: (query: bigint, path: unknown, user: bigint, counter: unknown) => number;
  PdhCollectQueryData: (query: bigint) => number;
  PdhGetFormattedCounterArrayW: (counter: bigint, format: number, size: unknown, count: unknown, items: unknown) => number;
  PdhCloseQuery: (query: bigint) => number;
}

type Ffi = typeof import("bun:ffi");

export class WindowsGpu {
  private log: Logger;
  private state: "new" | "up" | "off" = "new";
  private ffi?: Ffi;
  private pdh?: PdhSymbols;
  private query = 0n;
  private counters?: Record<keyof typeof PATHS, bigint>;
  private adapters: DxgiAdapter[] = [];
  private listedAt = 0;
  /** The adapters the counters name that DXGI did not list after a second look. */
  private unnamed = new Set<string>();
  private told = false;
  private items = new Uint8Array(64 * 1024);
  private size = new Uint32Array(1);
  private count = new Uint32Array(1);
  private utf16 = new TextDecoder("utf-16le");

  constructor(log: Logger) {
    this.log = log;
  }

  /** Given up for good: the counters are not there, or a sample failed. */
  get off(): boolean {
    return this.state === "off";
  }

  private wide(text: string): Uint8Array {
    return new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
  }

  private init(): boolean {
    if (this.state !== "new") return this.state === "up";
    try {
      const ffi = require("bun:ffi") as Ffi;
      const { FFIType } = ffi;
      this.ffi = ffi;
      const pdh = ffi.dlopen("pdh.dll", {
        PdhOpenQueryW: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
        PdhAddEnglishCounterW: { args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
        PdhCollectQueryData: { args: [FFIType.u64], returns: FFIType.u32 },
        PdhGetFormattedCounterArrayW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
        PdhCloseQuery: { args: [FFIType.u64], returns: FFIType.u32 },
      }).symbols as unknown as PdhSymbols;
      this.pdh = pdh;
      const handle = new BigUint64Array(1);
      let rc = pdh.PdhOpenQueryW(null, 0n, ffi.ptr(handle));
      if (rc !== 0) throw new Error(`PdhOpenQueryW 0x${rc.toString(16)}`);
      this.query = handle[0]!;
      const counters = {} as Record<keyof typeof PATHS, bigint>;
      for (const [key, path] of Object.entries(PATHS) as [keyof typeof PATHS, string][]) {
        rc = pdh.PdhAddEnglishCounterW(this.query, ffi.ptr(this.wide(path)), 0n, ffi.ptr(handle));
        if (rc !== 0) throw new Error(`${path}: 0x${rc.toString(16)}`);
        counters[key] = handle[0]!;
      }
      this.counters = counters;
      this.list();
      // the first collection primes the rates
      pdh.PdhCollectQueryData(this.query);
      this.state = "up";
      return true;
    } catch (e) {
      this.log.info("no GPU metrics: the Windows GPU counters not read", { error: e instanceof Error ? e.message : String(e) });
      this.dispose();
      return false;
    }
  }

  /** The adapters, through DXGI's factory: a COM object, called through its vtable. */
  private list(): void {
    const ffi = this.ffi!;
    const { FFIType, CFunction, read } = ffi;
    const dxgi = ffi.dlopen("dxgi.dll", { CreateDXGIFactory1: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
    const out = new BigUint64Array(1);
    const method = (self: number, slot: number, args: import("bun:ffi").FFITypeOrString[]) =>
      CFunction({ ptr: read.ptr(read.ptr(self as never, 0) as never, slot * 8) as never, args: [FFIType.ptr, ...args], returns: FFIType.i32 }) as unknown as (...a: unknown[]) => number;
    const release = (self: number) => method(self, RELEASE, [])(self);
    try {
      const hr = dxgi.symbols.CreateDXGIFactory1(ffi.ptr(IID_IDXGI_FACTORY1), ffi.ptr(out));
      if (hr < 0) throw new Error(`CreateDXGIFactory1 0x${(hr >>> 0).toString(16)}`);
      const factory = Number(out[0]!);
      const adapters: DxgiAdapter[] = [];
      try {
        const enumAdapters = method(factory, ENUM_ADAPTERS1, [FFIType.u32, FFIType.ptr]);
        const desc = new Uint8Array(DESC1_BYTES);
        const view = new DataView(desc.buffer);
        for (let i = 0; ; i++) {
          const rc = enumAdapters(factory, i, ffi.ptr(out));
          if (rc === DXGI_ERROR_NOT_FOUND) break;
          if (rc < 0) throw new Error(`EnumAdapters1 0x${(rc >>> 0).toString(16)}`);
          const adapter = Number(out[0]!);
          try {
            if (method(adapter, GET_DESC1, [FFIType.ptr])(adapter, ffi.ptr(desc)) < 0) continue;
            const chars = new Uint16Array(desc.buffer, 0, 128);
            const end = chars.indexOf(0);
            const name = this.utf16.decode(chars.subarray(0, end < 0 ? 128 : end)).trim() || `gpu${i}`;
            adapters.push({
              luid: luidKey(view.getInt32(300, true), view.getUint32(296, true)),
              name,
              dedicated: Number(view.getBigUint64(272, true)),
              software: (view.getUint32(304, true) & DXGI_ADAPTER_FLAG_SOFTWARE) !== 0,
            });
          } finally {
            release(adapter);
          }
        }
      } finally {
        release(factory);
      }
      this.adapters = adapters;
    } finally {
      dxgi.close();
      this.listedAt = Date.now();
    }
  }

  /** One counter's every instance with a value, read from the last collection. */
  private values(counter: bigint): CounterValue[] {
    const ffi = this.ffi!;
    const pdh = this.pdh!;
    for (;;) {
      this.size[0] = this.items.byteLength;
      const rc = pdh.PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, ffi.ptr(this.size), ffi.ptr(this.count), ffi.ptr(this.items));
      if (rc === PDH_MORE_DATA) {
        this.items = new Uint8Array(Math.max(this.size[0]!, this.items.byteLength * 2));
        continue;
      }
      // no instance has a value yet: nothing on the GPU, or a rate not primed
      if (rc !== 0) return [];
      break;
    }
    const base = ffi.ptr(this.items) as unknown as number;
    const view = new DataView(this.items.buffer, this.items.byteOffset, this.items.byteLength);
    const chars = new Uint16Array(this.items.buffer, this.items.byteOffset, this.items.byteLength >> 1);
    const out: CounterValue[] = [];
    for (let i = 0; i < this.count[0]!; i++) {
      const at = i * ITEM_BYTES;
      const status = view.getUint32(at + 8, true);
      if (status > PDH_CSTATUS_NEW_DATA) continue;
      // the names live in the same buffer, after the items
      const from = (Number(view.getBigUint64(at, true)) - base) >> 1;
      if (from < 0 || from >= chars.length) continue;
      let end = from;
      while (end < chars.length && chars[end] !== 0) end++;
      out.push({ instance: this.utf16.decode(chars.subarray(from, end)), value: view.getFloat64(at + 16, true) });
    }
    return out;
  }

  /** Every GPU's name, utilisation and dedicated memory, or undefined when the counters cannot be read. */
  sample(): RawGpu[] | undefined {
    if (!this.init()) return undefined;
    try {
      this.pdh!.PdhCollectQueryData(this.query);
      const c = this.counters!;
      const read = { engine: this.values(c.engine), adapterMemory: this.values(c.adapterMemory), processMemory: this.values(c.processMemory) };
      if (Date.now() - this.listedAt >= RELIST_MS && unlisted(this.adapters, read.adapterMemory, this.unnamed).length > 0) {
        this.list();
        // one DXGI still does not list is not one it shows (a virtual display's): not looked for again
        for (const luid of unlisted(this.adapters, read.adapterMemory, this.unnamed)) this.unnamed.add(luid);
      }
      const gpus = gpusFrom(this.adapters, read);
      if (!this.told) {
        this.told = true;
        this.log.info("GPU metrics from the Windows GPU counters", { gpus: gpus.map((g) => g.name) });
      }
      return gpus;
    } catch (e) {
      this.log.warn("GPU sample failed; GPU metrics off", { error: e instanceof Error ? e.message : String(e) });
      this.dispose();
      return undefined;
    }
  }

  dispose(): void {
    if (this.query !== 0n) {
      try {
        this.pdh?.PdhCloseQuery(this.query);
      } catch {
        // going away with us
      }
    }
    this.query = 0n;
    this.counters = undefined;
    this.pdh = undefined;
    this.state = "off";
  }
}
