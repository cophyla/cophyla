// What is in front on this machine, for whether the user is looking at a session's own window
// or at the app. Windows only: the foreground window's process through user32 and kernel32
// over `bun:ffi`, loaded the first time it is asked and never again once it failed. Elsewhere,
// and where the calls fail, nothing is known and nothing is said: what the app reports stands.
//
// A session's window is found by process: the window in front belongs to one of the processes
// from the session's roots (its own process, or the processes of the terminal windows tether
// attached to it) up through their ancestors. The walk stops at the first ancestor that stands
// for many sessions at once, so a desktop, a service host, the daemon, the app or a tether host
// in front never counts as any session's window. The chains are read in the background, through
// the daemon's process tree, and kept a while: a check asks only what is already known.

import { basename } from "node:path";
import type { Logger } from "../log.ts";
import type { ProcessInfo, ProcessTree } from "../sessions/focus.ts";

/** The process whose window is in front, and its executable's file name in lower case when it could be read. */
export interface ForegroundWindow {
  pid: number;
  exe?: string;
}

/** Asks what is in front now; undefined when nothing can be told. */
export type Foreground = () => ForegroundWindow | undefined;

/** The desktop app's executable. */
export const APP_EXE = "cophyla-ui.exe";

/** Ancestors past which no session's window is looked for: each stands for many sessions, or none. */
export const CHAIN_STOPS: ReadonlySet<string> = new Set(["explorer.exe", "svchost.exe", "services.exe", "wininit.exe", "winlogon.exe", "cophylad.exe", APP_EXE, "tether.exe", "tether"]);

/** How long a chain is kept before it is read again. */
export const CHAIN_TTL_MS = 30_000;

interface User32 {
  GetForegroundWindow: () => bigint;
  GetWindowThreadProcessId: (hwnd: bigint, pid: unknown) => number;
}

interface Kernel32 {
  OpenProcess: (access: number, inherit: number, pid: number) => bigint;
  QueryFullProcessImageNameW: (handle: bigint, flags: number, name: unknown, size: unknown) => number;
  CloseHandle: (handle: bigint) => number;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

let libs: { user32: User32; kernel32: Kernel32; ptr: (view: ArrayBufferView) => unknown } | null | undefined;

/** user32 and kernel32 through `bun:ffi`, or null where there are none. */
function load(log?: Logger): typeof libs {
  if (libs !== undefined) return libs;
  if (process.platform !== "win32") return (libs = null);
  try {
    // Imported here, not at the top: `bun:ffi` is Bun's alone and this file is read everywhere.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const user32 = ffi.dlopen("user32.dll", {
      GetForegroundWindow: { args: [], returns: FFIType.u64 },
      GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    });
    const kernel32 = ffi.dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      QueryFullProcessImageNameW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    libs = { user32: user32.symbols as unknown as User32, kernel32: kernel32.symbols as unknown as Kernel32, ptr: ffi.ptr as unknown as (view: ArrayBufferView) => unknown };
  } catch (e) {
    log?.debug("user32 not loaded; nothing is known of the window in front", { error: e instanceof Error ? e.message : String(e) });
    libs = null;
  }
  return libs;
}

/** A process's executable file name in lower case, or undefined when it cannot be opened. */
function exeOf(l: NonNullable<typeof libs>, pid: number): string | undefined {
  const handle = l.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return undefined;
  try {
    const name = new Uint16Array(1024);
    const size = new Uint32Array([name.length]);
    if (!l.kernel32.QueryFullProcessImageNameW(handle, 0, l.ptr(name), l.ptr(size))) return undefined;
    const path = new TextDecoder("utf-16le").decode(name.subarray(0, size[0]!));
    return basename(path.replaceAll("\\", "/")).toLowerCase();
  } finally {
    l.kernel32.CloseHandle(handle);
  }
}

/** This machine's window in front, where it can be told: Windows, with user32 loaded. */
export function windowsForeground(log?: Logger): Foreground | undefined {
  const l = load(log);
  if (!l) return undefined;
  return () => {
    try {
      const hwnd = l.user32.GetForegroundWindow();
      if (!hwnd) return undefined;
      const pid = new Uint32Array(1);
      l.user32.GetWindowThreadProcessId(hwnd, l.ptr(pid));
      if (!pid[0]) return undefined;
      const exe = exeOf(l, pid[0]);
      return { pid: pid[0], ...(exe !== undefined ? { exe } : {}) };
    } catch {
      return undefined;
    }
  };
}

/** The pids a root's window may belong to: the root, then its ancestors up to the first that stops the walk. */
export function cutChain(chain: ProcessInfo[], stop: (p: ProcessInfo) => boolean): number[] {
  const out: number[] = [];
  for (const [i, p] of chain.entries()) {
    if (i > 0 && stop(p)) break;
    out.push(p.pid);
  }
  return out;
}

export interface WindowChainsDeps {
  tree: ProcessTree;
  /** The daemon's own pid, a stop whatever it is called (`bun.exe` in development). */
  selfPid?: number;
  now?: () => number;
  log?: Logger;
}

/** Each root's cut chain, read through the process tree in the background and kept `CHAIN_TTL_MS`. */
export class WindowChains {
  private deps: WindowChainsDeps;
  private chains = new Map<number, { pids: number[]; at: number }>();
  private reading?: Promise<void>;

  constructor(deps: WindowChainsDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private stop = (p: ProcessInfo): boolean => p.pid === this.deps.selfPid || CHAIN_STOPS.has(p.name.toLowerCase());

  /** The pids a root's window may belong to, as last read; undefined until it has been. */
  chain(root: number): number[] | undefined {
    return this.chains.get(root)?.pids;
  }

  /** Reads the chains of the roots not known or older than the ttl, one read at a time; the rest are forgotten. */
  async refresh(roots: number[]): Promise<void> {
    if (this.reading) return this.reading;
    const at = this.now();
    for (const root of [...this.chains.keys()]) if (!roots.includes(root)) this.chains.delete(root);
    const stale = roots.filter((r) => {
      const known = this.chains.get(r);
      return !known || at - known.at >= CHAIN_TTL_MS;
    });
    if (stale.length === 0) return;
    this.reading = (async () => {
      try {
        const tree = this.deps.tree;
        const read = tree.ancestorsOf ? await tree.ancestorsOf(stale) : new Map(await Promise.all(stale.map(async (pid) => [pid, await tree.ancestors(pid)] as const)));
        for (const root of stale) {
          const chain = read.get(root) ?? [];
          this.chains.set(root, { pids: chain.length > 0 ? cutChain(chain, this.stop) : [root], at: this.now() });
        }
      } catch (e) {
        this.deps.log?.debug("window chains not read", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.reading = undefined;
      }
    })();
    return this.reading;
  }
}
