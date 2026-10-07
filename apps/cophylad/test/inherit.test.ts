// No child of the daemon holds its sockets (inherit.ts): on Windows a child started while the
// daemon listens inherits the listening socket, and one that outlives the daemon kept its ports
// taking connections nobody answered, so no daemon came back after a restart.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sealHandles } from "../src/inherit.ts";

const FIXTURE = join(import.meta.dir, "fakes", "inherit-listen.ts");
const windows = process.platform === "win32";

function run(guard: boolean): { verdict: string } {
  const r = Bun.spawnSync([process.execPath, "run", FIXTURE, guard ? "1" : "0"], { stdout: "pipe", stderr: "pipe" });
  const line = r.stdout.toString().trim().split(/\r?\n/).pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`the fixture said nothing: ${r.stderr.toString()}`);
  return JSON.parse(line) as { verdict: string };
}

describe.skipIf(!windows)("a child does not hold the daemon's sockets (Windows)", () => {
  test("unguarded, a child keeps a listener's port taking connections after the server stopped", () => {
    // what the guard is for: if this ever comes back free, the runtime no longer hands sockets on
    expect(run(false).verdict).toBe("held");
  }, 20_000);

  test("guarded, the port is refused once the server stopped, the child still running", () => {
    expect(run(true).verdict).toBe("free");
  }, 20_000);

  test("a seal lists this process's handles and leaves none of them inheritable", () => {
    const first = sealHandles();
    expect(first).toBeDefined();
    expect(first!.handles).toBeGreaterThan(0);
    expect(sealHandles()!.sealed).toBe(0);
  });
});

describe.skipIf(windows)("elsewhere", () => {
  test("there is nothing to seal", () => {
    expect(sealHandles()).toBeUndefined();
  });
});
