import { expect, test } from "bun:test";
import { packPackets, unpackPackets } from "../src/audio.ts";

test("packets round-trip through the length-prefixed framing", () => {
  const packets = [new Uint8Array([1, 2, 3]), new Uint8Array(300).fill(7), new Uint8Array([9])];
  const packed = packPackets(packets);
  expect(packed.length).toBe(3 + 300 + 1 + 6);
  expect(unpackPackets(packed).map((p) => [...p])).toEqual(packets.map((p) => [...p]));
  expect(unpackPackets(new Uint8Array(0))).toEqual([]);
});

test("a frame cut short or naming an empty packet is refused", () => {
  const packed = packPackets([new Uint8Array([1, 2, 3])]);
  expect(() => unpackPackets(packed.subarray(0, 4))).toThrow();
  expect(() => unpackPackets(packed.subarray(0, 1))).toThrow();
  expect(() => unpackPackets(new Uint8Array([0, 0]))).toThrow();
});
