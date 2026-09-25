// Where cophylad finds tether, in order: the config, `COPHYLA_TETHER`, the installed version folder
// (and only it, once installed), a checkout's release build, then its debug build; and the copy
// it runs from, one folder per version and content.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateTether, stageTether, TETHER_NAME } from "../src/sessions/tether/locate.ts";
import { TETHER_PATH } from "../src/update/platform.ts";
import { tempHome } from "./helpers.ts";

const CONFIG = { idle_exit_s: 600, window: "auto" as const, window_on_start: false, profiles: true, on_path: false };

describe("locating tether", () => {
  const all = (paths: string[]) => (p: string) => paths.includes(p);

  test("the config, then the environment, each alone when named", () => {
    expect(locateTether({ config: { ...CONFIG, command: "C:/t/tether.exe" }, env: { COPHYLA_TETHER: "C:/e/tether.exe" }, exists: all(["C:/t/tether.exe", "C:/e/tether.exe"]) })).toEqual({ path: "C:/t/tether.exe", origin: "config" });
    expect(locateTether({ config: { ...CONFIG, command: "C:/missing.exe" }, env: { COPHYLA_TETHER: "C:/e/tether.exe" }, exists: all(["C:/e/tether.exe"]) })).toBeUndefined();
    expect(locateTether({ config: CONFIG, env: { COPHYLA_TETHER: "C:/e/tether.exe" }, exists: all(["C:/e/tether.exe"]) })).toEqual({ path: "C:/e/tether.exe", origin: "env" });
  });

  test("an installed platform runs its own, never a checkout's", () => {
    const installed = join("V", TETHER_PATH);
    const built = join("R", "tether", "target", "release", TETHER_NAME);
    expect(locateTether({ config: CONFIG, env: {}, versionDir: "V", repoRoot: "R", exists: all([installed, built]) })).toEqual({ path: installed, origin: "installed" });
    expect(locateTether({ config: CONFIG, env: {}, versionDir: "V", repoRoot: "R", exists: all([built]) })).toBeUndefined();
  });

  test("a checkout's release build before its debug build; nothing found is nothing", () => {
    const release = join("R", "tether", "target", "release", TETHER_NAME);
    const debug = join("R", "tether", "target", "debug", TETHER_NAME);
    expect(locateTether({ config: CONFIG, env: {}, repoRoot: "R", exists: all([release, debug]) })?.path).toBe(release);
    expect(locateTether({ config: CONFIG, env: {}, repoRoot: "R", exists: all([debug]) })?.path).toBe(debug);
    expect(locateTether({ config: CONFIG, env: {}, repoRoot: "R", exists: all([]) })).toBeUndefined();
  });

  test("it runs from a copy per version and content, made once", () => {
    const home = tempHome();
    const src = join(home, "built", TETHER_NAME);
    mkdirSync(join(home, "built"), { recursive: true });
    writeFileSync(src, "one");
    const a = stageTether(src, join(home, "data"), "0.1.0");
    expect(a.startsWith(join(home, "data", "tether", "0.1.0-"))).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("one");
    expect(stageTether(src, join(home, "data"), "0.1.0")).toBe(a);
    // A rebuild of the same version is a copy of its own; the one a host may still run stays.
    writeFileSync(src, "two");
    const b = stageTether(src, join(home, "data"), "0.1.0");
    expect(b).not.toBe(a);
    expect(existsSync(a)).toBe(true);
  });
});
