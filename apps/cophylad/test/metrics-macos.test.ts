// The macOS engine against the real libproc: this process is there with its parent, its own
// CPU time and its start; another user's process (launchd, root's) is listed with its parent, so a walk up the
// tree passes through it; a process run from a `versions/` folder is named after its install,
// as Claude Code's native install is; the GPU is read from IOKit, the engine's too. Skipped off macOS.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { constants, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../src/log.ts";
import { AppleGpu } from "../src/metrics/apple-gpu.ts";
import { hostEngine } from "../src/metrics/engine.ts";
import type { RawSample } from "../src/metrics/engine.ts";
import { darwinArgv, installNameOf, parseProcArgs } from "../src/metrics/macos.ts";

const onMac = process.platform === "darwin";
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test("the install a versioned executable belongs to", () => {
  expect(installNameOf("/Users/u/.local/share/claude/versions/2.1.243")).toBe("claude");
  expect(installNameOf("/opt/tool/versions/v1.2")).toBe("tool");
  expect(installNameOf("/usr/bin/2.1.243")).toBeUndefined();
  expect(installNameOf("/opt/tool/versions/latest")).toBeUndefined();
  expect(installNameOf("versions/1.0")).toBeUndefined();
});

test("a KERN_PROCARGS2 answer: argc, the executable, its padding, then the arguments whole", () => {
  const enc = new TextEncoder();
  const body = enc.encode("/bin/tool\0\0\0\0tool\0--settings\0{\"a\": \"b c\"}\0/x/Application Support/y\0HOME=/h\0");
  const bytes = new Uint8Array(4 + body.length);
  new DataView(bytes.buffer).setInt32(0, 4, true);
  bytes.set(body, 4);
  expect(parseProcArgs(bytes)).toEqual(["tool", "--settings", '{"a": "b c"}', "/x/Application Support/y"]);
  expect(parseProcArgs(bytes.subarray(0, 2))).toBeUndefined();
  // cut short: fewer arguments than argc says
  expect(parseProcArgs(bytes.subarray(0, 20))).toBeUndefined();
});

describe.skipIf(!onMac)("metrics macos engine", () => {
  test("this process with its parent and CPU time; root's launchd listed; the machine's CPU and memory", async () => {
    const { MacEngine } = await import("../src/metrics/macos.ts");
    const engine = new MacEngine();
    expect(engine.name).toBe("macos");
    const s = engine.sample();
    const self = s.processes.find((p) => p.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.parent).toBe(process.ppid);
    expect(self!.cpuTimeNs).toBeGreaterThan(0);
    expect(self!.rss).toBeGreaterThan(1_000_000);
    expect(Math.abs(self!.startedAt! - performance.timeOrigin)).toBeLessThan(5000);
    expect(s.processes.every((p) => p.startedAt === undefined || p.startedAt <= Date.now())).toBe(true);
    const launchd = s.processes.find((p) => p.pid === 1);
    expect(launchd).toMatchObject({ pid: 1, parent: 0, name: "launchd" });
    expect(s.cores).toBeGreaterThan(0);
    expect(s.cpu.totalNs).toBeGreaterThan(s.cpu.busyNs);
    expect(s.memory.used).toBeGreaterThan(0);
    expect(s.memory.used).toBeLessThanOrEqual(s.memory.total);
    // a second sample: the CPU counters only grow
    const again = engine.sample();
    expect(again.cpu.totalNs).toBeGreaterThanOrEqual(s.cpu.totalNs);
  });

  test("a process run from a versions/ folder is named after its install", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cophyla-metrics-")));
    scratch.push(dir);
    const exe = join(dir, "tool", "versions", "1.2.3");
    mkdirSync(join(dir, "tool", "versions"), { recursive: true });
    // Bun's own executable, cloned: a system one (/bin/sleep) is a platform binary macOS kills
    // when it runs from anywhere else.
    copyFileSync(process.execPath, exe, constants.COPYFILE_FICLONE);
    const child = spawn(exe, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const { MacEngine } = await import("../src/metrics/macos.ts");
      const row = new MacEngine().sample().processes.find((p) => p.pid === child.pid);
      expect(row).toMatchObject({ pid: child.pid, parent: process.pid, name: "tool" });
    } finally {
      child.kill();
    }
  });

  test("a process's arguments exactly, spaces and all; none for another user's", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--settings", '{"a": "b c"}', "/x/Application Support/y"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(darwinArgv(child.pid!)?.slice(1)).toEqual(["-e", "setTimeout(() => {}, 30000)", "--settings", '{"a": "b c"}', "/x/Application Support/y"]);
      expect(darwinArgv(1)).toBeUndefined();
    } finally {
      child.kill();
    }
  });

  test("the GPU from IOKit: its model, utilisation, and the unified memory it holds out of the RAM", () => {
    const gpu = new AppleGpu(silentLogger);
    try {
      const first = gpu.sample();
      expect(first?.length).toBeGreaterThan(0);
      const g = first![0]!;
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.util).toBeGreaterThanOrEqual(0);
      expect(g.util).toBeLessThanOrEqual(100);
      expect(g.vramTotal).toBeGreaterThan(0);
      expect(g.vramUsed).toBeLessThanOrEqual(g.vramTotal);
      // read again from the same services
      expect(gpu.sample()![0]!.name).toBe(g.name);
    } finally {
      gpu.dispose();
    }
    const engine = hostEngine({ gpu: true, log: silentLogger });
    try {
      expect(((engine.sample() as RawSample).gpu ?? []).length).toBeGreaterThan(0);
    } finally {
      engine.dispose?.();
    }
  });
});
