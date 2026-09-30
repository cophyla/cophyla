// The desktop's copy of the document frame is the protocol's: the page the `doc` scheme serves
// (src-tauri/src/docframe.html, embedded with `include_str!`), its policy and its path
// (docframe.rs), since the shell's Rust cannot import them. Line endings aside, which a
// checkout may change.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_FRAME_CSP, DOC_FRAME_HTML, DOC_FRAME_PATH } from "@cophyla/protocol";

const SRC = join(import.meta.dir, "..", "src-tauri", "src");

describe("the desktop's document frame", () => {
  test("serves the protocol's page, under its policy, at its path", () => {
    expect(readFileSync(join(SRC, "docframe.html"), "utf8").replace(/\r\n/g, "\n")).toBe(DOC_FRAME_HTML);
    const rust = readFileSync(join(SRC, "docframe.rs"), "utf8");
    expect(rust).toContain(`pub const CSP: &str = "${DOC_FRAME_CSP}";`);
    expect(rust).toContain(`pub const PATH: &str = "${DOC_FRAME_PATH}";`);
  });
});
