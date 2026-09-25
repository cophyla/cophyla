// The default view's copies of xterm.js and marked are the files `scripts/vendor-view.ts`
// pins, byte for byte: never edited by hand, never converted on checkout.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256, VENDOR_DIR, VENDORED } from "../scripts/vendor-view.ts";

describe("the default view's vendored libraries", () => {
  for (const f of VENDORED) {
    test(`${f.to} is the pinned ${f.pkg} ${f.from}`, () => {
      expect(sha256(readFileSync(join(VENDOR_DIR, f.to)))).toBe(f.sha256);
    });
  }
});
