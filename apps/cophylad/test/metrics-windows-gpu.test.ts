// The GPU from the Windows GPU counters. From fixed readings: an adapter's utilisation is
// its busiest engine, each engine summed over the processes and capped at 100; its memory in
// use and each process's come by LUID whatever the case and padding of the instance's hex; a
// software adapter, and one the counters never name, are left out; a process charged more
// than the whole card is dropped; an adapter the list does not know asks for the list again,
// once. `firstGpu` hands over to the next reader at the sample
// where the one before gives up, and not while it only had nothing to say. On a real Windows
// the reader reads every GPU the counters name, or none on a machine without one.

import { describe, expect, test } from "bun:test";
import { silentLogger } from "../src/log.ts";
import type { Logger } from "../src/log.ts";
import { firstGpu } from "../src/metrics/engine.ts";
import type { GpuReader, RawGpu } from "../src/metrics/engine.ts";
import { gpusFrom, luidKey, unlisted, WindowsGpu } from "../src/metrics/windows-gpu.ts";
import type { DxgiAdapter } from "../src/metrics/windows-gpu.ts";

const GB = 2 ** 30;
const RX = luidKey(0, 0xe4de);
const IGPU = luidKey(0, 0xbc09);
const ADAPTERS: DxgiAdapter[] = [
  { luid: RX, name: "AMD Radeon RX 9070 XT", dedicated: 16 * GB, software: false },
  { luid: IGPU, name: "AMD Radeon(TM) Graphics", dedicated: 2 * GB, software: false },
  { luid: luidKey(0, 0x1111), name: "Virtual Display", dedicated: 0, software: false },
  { luid: luidKey(0, 0x2222), name: "Microsoft Basic Render Driver", dedicated: 0, software: true },
];

const engine = (pid: number, low: string, eng: number, type: string, value: number) => ({ instance: `pid_${pid}_luid_0x00000000_0x${low}_phys_0_eng_${eng}_engtype_${type}`, value });

describe("the Windows GPU counters", () => {
  test("an adapter is its busiest engine, each the sum of its processes, and its memory by LUID", () => {
    const gpus = gpusFrom(ADAPTERS, {
      engine: [engine(10, "0000E4DE", 0, "3D", 30), engine(11, "0000E4DE", 0, "3D", 25), engine(10, "0000E4DE", 3, "Copy", 40), engine(12, "0000BC09", 0, "3D", 70), engine(12, "00002222", 0, "3D", 5)],
      adapterMemory: [
        { instance: "luid_0x00000000_0x0000E4DE_phys_0", value: 2.1 * GB },
        { instance: "luid_0x00000000_0x0000bc09_phys_0", value: 0.5 * GB },
        { instance: "luid_0x00000000_0x00002222_phys_0", value: 0 },
      ],
      processMemory: [
        { instance: "pid_10_luid_0x00000000_0x0000E4DE_phys_0", value: 1.5 * GB },
        { instance: "pid_11_luid_0x00000000_0x0000E4DE_phys_0", value: 0.25 * GB },
        { instance: "pid_13_luid_0x00000000_0x0000E4DE_phys_0", value: 19 * GB },
        { instance: "pid_12_luid_0x00000000_0x0000BC09_phys_0", value: 10 * 2 ** 40 },
        { instance: "pid_14_luid_0x00000000_0x0000E4DE_phys_0", value: 0 },
      ],
    });
    expect(gpus.map((g) => g.name)).toEqual(["AMD Radeon RX 9070 XT", "AMD Radeon(TM) Graphics"]);
    const [rx, igpu] = gpus as [RawGpu, RawGpu];
    expect(rx.util).toBe(55);
    expect(rx.vramUsed).toBe(Math.round(2.1 * GB));
    expect(rx.vramTotal).toBe(16 * GB);
    expect([...rx.processes]).toEqual([
      [10, 1.5 * GB],
      [11, 0.25 * GB],
    ]);
    expect(igpu.util).toBe(70);
    expect(igpu.vramUsed).toBe(0.5 * GB);
    expect(igpu.processes.size).toBe(0);
  });

  test("utilisation is capped at 100, and an adapter with engines but no memory reading is still read", () => {
    const [g] = gpusFrom(ADAPTERS, { engine: [engine(1, "e4de", 0, "3D", 80), engine(2, "e4de", 0, "3D", 45)], adapterMemory: [], processMemory: [] });
    expect(g!.util).toBe(100);
    expect(g!.vramUsed).toBe(0);
  });

  test("an adapter the list does not know means the list is read again, unless it was looked for already", () => {
    expect(unlisted(ADAPTERS, [{ instance: "luid_0x00000000_0x0000E4DE_phys_0", value: 1 }])).toEqual([]);
    const unknown = [
      { instance: "luid_0x00000000_0x0000ABCD_phys_0", value: 1 },
      { instance: "luid_0x00000000_0x0000abcd_phys_1", value: 1 },
    ];
    expect(unlisted(ADAPTERS, unknown)).toEqual([luidKey(0, 0xabcd)]);
    expect(unlisted(ADAPTERS, unknown, new Set([luidKey(0, 0xabcd)]))).toEqual([]);
  });

  test("firstGpu hands over when a reader is off, not when it only had nothing", () => {
    const lines: string[] = [];
    const log: Logger = { ...silentLogger, info: (m) => lines.push(m), child: () => log };
    const gpu: RawGpu = { name: "g", util: 1, vramUsed: 1, vramTotal: 2, processes: new Map() };
    let nvmlOff = false;
    const disposed: string[] = [];
    const nvml: GpuReader = { sample: () => undefined, dispose: () => disposed.push("nvml"), get off() { return nvmlOff; } };
    const counters: GpuReader = { sample: () => [gpu], dispose: () => disposed.push("counters"), off: false };
    const reader = firstGpu([nvml, counters], log);
    expect(reader.sample()).toBeUndefined();
    nvmlOff = true;
    expect(reader.sample()).toEqual([gpu]);
    expect(disposed).toEqual(["nvml"]);
    const none = firstGpu([{ sample: () => undefined, dispose: () => {}, off: true }], log);
    expect(none.sample()).toBeUndefined();
    expect(none.sample()).toBeUndefined();
    expect(lines.filter((l) => l === "no GPU metrics")).toHaveLength(1);
  });

  test.skipIf(process.platform !== "win32")("on this machine: every GPU the counters name, well-formed, or none", async () => {
    const reader = new WindowsGpu(silentLogger);
    try {
      reader.sample();
      await Bun.sleep(200);
      const gpus = reader.sample();
      // a machine with no GPU (a CI runner) has no counters to read, or no adapter in them
      for (const g of gpus ?? []) {
        expect(g.name.length).toBeGreaterThan(0);
        expect(g.util).toBeGreaterThanOrEqual(0);
        expect(g.util).toBeLessThanOrEqual(100);
        expect(g.vramUsed).toBeGreaterThanOrEqual(0);
        for (const bytes of g.processes.values()) expect(bytes).toBeGreaterThan(0);
      }
    } finally {
      reader.dispose();
    }
  });
});
