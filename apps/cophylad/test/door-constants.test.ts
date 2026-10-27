// The sign-in door's names and numbers are defined twice, once here (src/door/constants.ts)
// and once in the Windows service shim (apps/door/src/constants.rs): the service and the
// pipe, the folder and the binary, the shim's protocol and the exit code that asks for a
// restart. This reads the Rust file as text and pins each one equal.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOOR_EXE, DOOR_FOLDER, DOOR_PIPE, DOOR_SERVICE, EXIT_UPDATED, SHIM_PROTOCOL } from "../src/door/constants.ts";
import { DOOR_PATHS } from "../src/update/platform.ts";

const RUST = join(import.meta.dir, "..", "..", "door", "src", "constants.rs");

/** Every `pub const NAME: &str = "…";` and `pub const NAME: u32 = N;` of the Rust file. */
function rustConstants(): Map<string, string | number> {
  const out = new Map<string, string | number>();
  for (const line of readFileSync(RUST, "utf8").split(/\r?\n/)) {
    const str = /^pub const ([A-Z0-9_]+): &str = r?"([^"]*)";$/.exec(line.trim());
    if (str) out.set(str[1]!, line.includes('= r"') ? str[2]! : JSON.parse(`"${str[2]!}"`));
    const num = /^pub const ([A-Z0-9_]+): u32 = (\d+);$/.exec(line.trim());
    if (num) out.set(num[1]!, Number(num[2]));
  }
  return out;
}

describe("the door's constants, here and in the shim", () => {
  const rust = rustConstants();
  test("the service, the pipe, the folder and the binary", () => {
    expect(rust.get("SERVICE_NAME")).toBe(DOOR_SERVICE);
    expect(rust.get("PIPE_NAME")).toBe(DOOR_PIPE);
    expect(rust.get("FOLDER")).toBe(DOOR_FOLDER);
    expect(rust.get("EXE_NAME")).toBe(DOOR_EXE);
    expect(DOOR_PATHS.windows).toBe(`bin/${DOOR_EXE}`);
  });
  test("the shim's protocol and the exit code that starts the child again", () => {
    expect(rust.get("SHIM_PROTOCOL")).toBe(SHIM_PROTOCOL);
    expect(rust.get("EXIT_UPDATED")).toBe(EXIT_UPDATED);
  });
});
