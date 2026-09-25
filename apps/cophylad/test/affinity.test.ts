// CPU masks: parsing what the config allows, printing a mask back as the argument a sidecar
// reads, and what the detection does on this machine. The detection itself is only asserted
// where it can be: on a hybrid CPU it names a subset of the cores, and anywhere else it
// declines rather than guessing.

import { describe, expect, test } from "bun:test";
import { maskArg, maskCount, parseMask, pCoreMask, resolveAffinity } from "../src/voice/affinity.ts";

describe("masks", () => {
  test("a range, a list and a mix parse; anything else does not", () => {
    expect(parseMask("0-15")).toBe(0xffffn);
    expect(parseMask("0,2,4")).toBe(0b10101n);
    expect(parseMask("0-3,8")).toBe(0b1_0000_1111n);
    expect(parseMask(" 4 ")).toBe(16n);
    for (const bad of ["", "nope", "0-99", "3-1", "-1", "0-", "1.5", "0;1"]) expect(parseMask(bad)).toBeUndefined();
  });

  test("a mask prints back as the argument it came from", () => {
    expect(maskArg(0xffffn)).toBe("0-15");
    expect(maskArg(parseMask("0-15,20")!)).toBe("0-15,20");
    expect(maskArg(0b10101n)).toBe("0,2,4");
    expect(maskCount(0xffffn)).toBe(16);
    expect(maskCount(0n)).toBe(0);
  });

  test("the config's three forms resolve", () => {
    expect(resolveAffinity("off")).toBeUndefined();
    expect(resolveAffinity("0-3")).toBe(0b1111n);
    expect(resolveAffinity("rubbish")).toBeUndefined();
    // `auto` is the machine's answer: a mask on a hybrid CPU, nothing elsewhere.
    const auto = resolveAffinity("auto");
    expect(auto === undefined || auto > 0n).toBe(true);
  });

  test("detection either names a subset of this machine's CPUs or declines", () => {
    const mask = pCoreMask();
    if (mask === undefined) return;
    const cpus = navigator.hardwareConcurrency;
    expect(maskCount(mask)).toBeGreaterThan(0);
    expect(maskCount(mask)).toBeLessThanOrEqual(cpus);
    // A hybrid part has more logical CPUs than performance ones; a uniform one is declined above.
    expect(maskCount(mask)).toBeLessThan(cpus);
  });
});
