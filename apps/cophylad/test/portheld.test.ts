// The daemon's port before it starts (portheld.ts): free, nothing to do; held by what a stopped
// daemon left running, those leftovers are ended and the start goes on; held by anything else,
// the start stops naming it. Only Cophyla's own helpers with their parent gone are ever ended:
// never a tether host, an agents' shim, a helper of a live daemon, or a program of the user's.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../src/log.ts";
import { bindable, freeOwnPort, helperPaths, leftovers } from "../src/portheld.ts";
import type { ProcessRow } from "../src/portheld.ts";
import { freePort } from "../src/sidecars/index.ts";

const DATA = "C:\\Users\\u\\.cophyla\\data";
const INSTALL = "C:\\Users\\u\\AppData\\Local\\Cophyla";
const isHelper = helperPaths(DATA, INSTALL);

const rows: ProcessRow[] = [
  { pid: 10, ppid: 1, name: "explorer.exe", path: "C:\\Windows\\explorer.exe" },
  // a stopped daemon's stream worker: its sidecar is gone
  { pid: 20, ppid: 999, name: "streamer.exe", path: `${DATA}\\sidecars\\moonlight-web\\v2.10.0\\package\\streamer.exe` },
  // a live daemon's sidecar: its parent is there
  { pid: 30, ppid: 10, name: "web-server.exe", path: `${DATA}\\sidecars\\moonlight-web\\v2.10.0\\package\\web-server.exe` },
  // never ended, wherever they run from
  { pid: 40, ppid: 998, name: "tether.exe", path: `${INSTALL}\\bin\\tether.exe` },
  { pid: 41, ppid: 998, name: "tether.exe", path: `${DATA}\\tether\\0.2.0-abc\\tether.exe` },
  { pid: 42, ppid: 997, name: "cophyla-mcp.exe", path: `${INSTALL}\\bin\\cophyla-mcp.exe` },
  // the direct connections' helper of an install, its daemon gone
  { pid: 50, ppid: 996, name: "cophyla-net.exe", path: `${INSTALL}\\versions\\0.14.0\\bin\\cophyla-net.exe` },
  // a program of the user's whose parent is gone
  { pid: 60, ppid: 995, name: "node.exe", path: "C:\\Program Files\\nodejs\\node.exe" },
];

describe("the daemon's port", () => {
  test("the helpers ended are Cophyla's own with their parent gone, and nothing else", () => {
    expect(leftovers(rows, isHelper, 1).map((r) => r.pid)).toEqual([20, 50]);
    expect(isHelper(`${DATA}/sidecars/tts-py/python.exe`)).toBe(true);
    expect(isHelper(`${DATA}\\net\\cophyla-net.exe`)).toBe(true);
    expect(isHelper(`${INSTALL}\\bin\\cophyla-net.exe`)).toBe(true);
    expect(isHelper(`${INSTALL}\\bin\\tether.exe`)).toBe(false);
    expect(isHelper(`${DATA}\\tether\\0.2.0\\tether.exe`)).toBe(false);
    expect(isHelper(`${DATA}\\mcp\\cophyla-mcp.exe`)).toBe(false);
  });

  test("free: nothing is listed or ended", async () => {
    let listed = false;
    const r = await freeOwnPort({ host: "127.0.0.1", port: 4817, helpers: isHelper, log: silentLogger, bindable: () => true, processes: () => ((listed = true), rows) });
    expect(r).toBe("free");
    expect(listed).toBe(false);
  });

  test("held by a stopped daemon's leftovers: they are ended and the start goes on", async () => {
    const ended: number[] = [];
    const r = await freeOwnPort({
      host: "127.0.0.1",
      port: 4817,
      helpers: isHelper,
      log: silentLogger,
      bindable: () => ended.includes(20),
      processes: () => rows,
      end: (pid) => (ended.push(pid), true),
      wait: async () => {},
    });
    expect(r).toBe("freed");
    expect(ended.sort()).toEqual([20, 50]);
  });

  test("held by anything else: the start stops, naming what holds it", async () => {
    const ended: number[] = [];
    const held = freeOwnPort({
      host: "127.0.0.1",
      port: 4817,
      helpers: isHelper,
      log: silentLogger,
      bindable: () => false,
      processes: () => rows.filter((r) => r.pid !== 20 && r.pid !== 50),
      end: (pid) => (ended.push(pid), true),
      holder: () => 10,
      wait: async () => {},
    });
    await expect(held).rejects.toThrow(/port 4817 is held by explorer\.exe \(pid 10/);
    expect(ended).toEqual([]);
    const gone = freeOwnPort({ host: "127.0.0.1", port: 4817, helpers: isHelper, log: silentLogger, bindable: () => false, processes: () => [], holder: () => 4242, wait: async () => {} });
    await expect(gone).rejects.toThrow(/pid 4242, which has exited/);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")("the daemon's port, for real (Windows)", () => {
  test("a stream worker a dead daemon left holding its port is ended, and the port is free", async () => {
    const data = mkdtempSync(join(tmpdir(), "cophyla-portheld-"));
    dirs.push(data);
    const folder = join(data, "sidecars", "moonlight-web", "package");
    mkdirSync(folder, { recursive: true });
    const exe = join(folder, "streamer.exe");
    copyFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "PING.EXE"), exe);
    const port = freePort();
    const r = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "fakes", "orphan-holder.ts"), String(port), exe], { stdout: "pipe", stderr: "pipe" });
    const helper = Number(/helper (\d+)/.exec(r.stdout.toString())?.[1]);
    expect(helper).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(helper, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(alive()).toBe(true);
      // the daemon is gone, its helper holds the socket: a new daemon could not listen
      expect(bindable("127.0.0.1", port)).toBe(false);
      expect(await freeOwnPort({ host: "127.0.0.1", port, helpers: helperPaths(data), log: silentLogger })).toBe("freed");
      expect(alive()).toBe(false);
      expect(bindable("127.0.0.1", port)).toBe(true);
    } finally {
      if (alive()) process.kill(helper);
    }
  }, 30_000);
});
