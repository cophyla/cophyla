// The module loader over a temporary directory: a rewritten file is seen on the next load
// (the deciding assertion for the cache-busting approach), a syntax error rejects with the
// file's name, a relative helper import resolves, and a bare package import from a directory
// with no `node_modules` fails with a readable message. Plus the croner facts the scheduler
// relies on.

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { describeImportError, ModuleLoader, stemOf } from "../src/editable/modules.ts";
import { tempHome } from "./helpers.ts";

describe("module loader", () => {
  test("a rewritten file is evaluated again on the next load", async () => {
    const home = tempHome();
    const dir = join(home, "tools");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "my.tool.ts");
    const loader = new ModuleLoader();
    writeFileSync(file, "export const v: number = 1;\n");
    expect((await loader.load(file))["v"]).toBe(1);
    writeFileSync(file, "export const v: number = 2;\n");
    expect((await loader.load(file))["v"]).toBe(2);
    // A second loader in the same process sees the current file too.
    expect((await new ModuleLoader().load(file))["v"]).toBe(2);
    rmSync(home, { recursive: true, force: true });
  });

  test("a syntax error rejects, and the description names the file", async () => {
    const home = tempHome();
    const file = join(home, "tools", "bad.ts");
    mkdirSync(join(home, "tools"), { recursive: true });
    writeFileSync(file, "export const = ;\n");
    const loader = new ModuleLoader();
    let error: unknown;
    try {
      await loader.load(file);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    const described = describeImportError(file, error);
    expect(described.startsWith("bad.ts: ")).toBe(true);
    expect(described.split("\n")).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  test("a relative helper import resolves; a bare package import from a bare directory fails readably", async () => {
    const home = tempHome();
    const dir = join(home, "tools");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "_lib.ts"), "export const double = (n: number): number => n * 2;\n");
    writeFileSync(join(dir, "uses.ts"), 'import { double } from "./_lib.ts";\nexport const v = double(21);\n');
    const loader = new ModuleLoader();
    expect((await loader.load(join(dir, "uses.ts")))["v"]).toBe(42);
    writeFileSync(join(dir, "pkg.ts"), 'import { z } from "zod";\nexport const v = z;\n');
    let error: unknown;
    try {
      await loader.load(join(dir, "pkg.ts"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(describeImportError(join(dir, "pkg.ts"), error)).toMatch(/^pkg\.ts: .*zod/);
    rmSync(home, { recursive: true, force: true });
  });

  test("stemOf drops the extension only", () => {
    expect(stemOf("/a/b/my.tool.ts")).toBe("my.tool");
    if (process.platform === "win32") expect(stemOf("C:\\x\\hook.mjs")).toBe("hook");
    expect(stemOf("plain")).toBe("plain");
  });
});

describe("croner facts", () => {
  test("nextRun is strictly after the previous run; a bad expression throws at construction", () => {
    const prev = new Date("2026-03-10T09:00:00Z");
    const next = new Cron("0 9 * * *", { timezone: "UTC" }).nextRun(prev)!;
    expect(next.getTime()).toBeGreaterThan(prev.getTime());
    expect(next.toISOString()).toBe("2026-03-11T09:00:00.000Z");
    expect(() => new Cron("99 99 * * *")).toThrow();
    expect(() => new Cron("not a cron")).toThrow();
  });

  test("a bad time zone throws only on nextRun; an expression that never matches yields null", () => {
    const bad = new Cron("0 9 * * *", { timezone: "Mars/Olympus" });
    expect(() => bad.nextRun(new Date())).toThrow();
    expect(new Cron("0 0 30 2 *", { timezone: "UTC" }).nextRun(new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });
});
