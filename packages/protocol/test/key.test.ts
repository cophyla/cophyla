// A browser's key: ten bytes as sixteen characters in fours, read back however a person
// types it, and carried by a link in its fragment.

import { describe, expect, test } from "bun:test";
import { encodeKey, formatKey, KEY_BYTES, KEY_CHARS, keyFromFragment, keyLink, newKey, parseKey } from "../src/index.ts";

describe("a browser's key", () => {
  test("ten bytes are sixteen characters of Crockford's base32, shown in fours", () => {
    expect(encodeKey(new Uint8Array(KEY_BYTES))).toBe("0000000000000000");
    expect(encodeKey(new Uint8Array(KEY_BYTES).fill(0xff))).toBe("ZZZZZZZZZZZZZZZZ");
    // 0x00 0x44 0x32 0x14 0xc7 0x42 0x54 0xb6 0x35 0xcf is the alphabet's first sixteen, five bits each
    expect(encodeKey(Uint8Array.of(0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0x54, 0xb6, 0x35, 0xcf))).toBe("0123456789ABCDEF");
    expect(formatKey("0123456789ABCDEF")).toBe("0123-4567-89AB-CDEF");
    expect(() => encodeKey(new Uint8Array(9))).toThrow();
  });

  test("a fresh key is sixteen characters with no letter that reads as a digit, and no two alike", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const key = newKey();
      expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      expect(key.length).toBe(KEY_CHARS);
      seen.add(key);
    }
    expect(seen.size).toBe(200);
    expect(newKey((b) => b.fill(7))).toBe(encodeKey(new Uint8Array(KEY_BYTES).fill(7)));
  });

  test("what a person types reads back: any case, spaces or dashes, and the letters that look like digits", () => {
    const key = "7KQ2M9XF3ZTAB6WD";
    for (const typed of ["7KQ2-M9XF-3ZTA-B6WD", "7kq2-m9xf-3zta-b6wd", " 7kq2 m9xf 3zta b6wd ", "7KQ2M9XF3ZTAB6WD", "7kq2_m9xf.3zta-b6wd\n"]) expect(parseKey(typed)).toBe(key);
    // O for zero, I and L for one
    expect(parseKey("OOOO-IIII-LLLL-oil0")).toBe("0000111111110110");
    expect(parseKey(formatKey(key))).toBe(key);
  });

  test("anything else is no key", () => {
    for (const bad of ["", "482913", "7KQ2-M9XF-3ZTA-B6W", "7KQ2-M9XF-3ZTA-B6WDX", "7KQ2-M9XF-3ZTA-B6WU", "7KQ2-M9XF-3ZTA-B6W!", "cophyla-invite:abc"]) expect(parseKey(bad)).toBeUndefined();
  });

  test("a link carries the key in its fragment, which a page reads back", () => {
    const link = keyLink("https://192.168.1.44:4818/", "7KQ2M9XF3ZTAB6WD");
    expect(link).toBe("https://192.168.1.44:4818/#k=7KQ2-M9XF-3ZTA-B6WD");
    expect(keyFromFragment(new URL(link).hash)).toBe("7KQ2M9XF3ZTAB6WD");
    expect(keyFromFragment("#x=1&k=7kq2-m9xf-3zta-b6wd")).toBe("7KQ2M9XF3ZTAB6WD");
    expect(keyFromFragment("k=7KQ2%2DM9XF%2D3ZTA%2DB6WD")).toBe("7KQ2M9XF3ZTAB6WD");
    for (const none of ["", "#", "#code=482913", "#k=", "#k=short", "#k=%E0%A4%A"]) expect(keyFromFragment(none)).toBeUndefined();
  });
});
