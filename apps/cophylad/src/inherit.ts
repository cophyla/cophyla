// Windows hands every inheritable handle of a process to each child it starts, and Bun's sockets
// are inheritable: a child started while the daemon listens holds 4817, 4818 and 4820 for as long
// as it lives. A child that outlives the daemon then keeps the ports taking connections nobody
// answers, so the desktop app, which starts a daemon when its connection is refused, never starts
// one, and the next daemon could not bind them anyway. Orphaned remote-desktop stream workers did
// this twice (2026-09-25, 2026-10-07).
//
// So the daemon starts nothing with a handle it did not mean to give: `guardSpawns` makes every
// `Bun.spawn` and `Bun.spawnSync` (which `node:child_process` goes through) first clear the inherit
// flag on every handle of the process but the standard ones. A child still gets its own stdio,
// which the runtime duplicates for it as it starts it. Elsewhere this is nothing to do: sockets and
// files are opened close-on-exec.

/** OBJ_INHERIT in a handle's attributes. */
const OBJ_INHERIT = 0x2;
const HANDLE_FLAG_INHERIT = 0x1;
/** ProcessHandleInformation: the handles of a process, with their attributes (Windows 8 and later). */
const PROCESS_HANDLE_INFORMATION = 51;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;
/** PROCESS_HANDLE_SNAPSHOT_INFORMATION's header, then one PROCESS_HANDLE_TABLE_ENTRY_INFO a handle. */
const HEADER = 16;
const ENTRY = 40;
const ATTRIBUTES_AT = 32;
/** STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE. */
const STD_HANDLES = [-10, -11, -12];

interface Calls {
  query(buffer: Uint8Array, returned: Uint32Array): number;
  setHandleInformation(handle: number, mask: number, flags: number): number;
  getStdHandle(which: number): number;
}

let calls: Calls | null | undefined;
let buffer = new Uint8Array(64 * 1024);

function load(): Calls | null {
  if (calls !== undefined) return calls;
  if (process.platform !== "win32") return (calls = null);
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const kernel32 = ffi.dlopen("kernel32.dll", {
      SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.u64 },
    }).symbols;
    const ntdll = ffi.dlopen("ntdll.dll", {
      NtQueryInformationProcess: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    calls = {
      // -1: the current process's pseudo-handle
      query: (b, returned) => ntdll.NtQueryInformationProcess(-1, PROCESS_HANDLE_INFORMATION, ffi.ptr(b), b.byteLength, ffi.ptr(returned)) as number,
      setHandleInformation: (h, mask, flags) => kernel32.SetHandleInformation(h, mask, flags) as number,
      getStdHandle: (which) => Number(kernel32.GetStdHandle(which)),
    };
  } catch {
    calls = null;
  }
  return calls;
}

/** What a seal found: the process's handles, and how many of them it made not inheritable. */
export interface Sealed {
  handles: number;
  sealed: number;
}

/**
 * Clears the inherit flag on every handle of this process but the standard ones. Undefined off
 * Windows, or where the handles cannot be listed; a handle that will not take the flag is left.
 */
export function sealHandles(): Sealed | undefined {
  const c = load();
  if (!c) return undefined;
  const returned = new Uint32Array(1);
  let status = c.query(buffer, returned);
  for (let tries = 0; status === STATUS_INFO_LENGTH_MISMATCH && tries < 4; tries++) {
    buffer = new Uint8Array(Math.max(returned[0]! + 16 * ENTRY, buffer.byteLength * 2));
    status = c.query(buffer, returned);
  }
  if (status !== 0) return undefined;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = Math.min(Number(view.getBigUint64(0, true)), Math.floor((buffer.byteLength - HEADER) / ENTRY));
  const std = new Set(STD_HANDLES.map((w) => c.getStdHandle(w)));
  let sealed = 0;
  for (let i = 0; i < count; i++) {
    const at = HEADER + i * ENTRY;
    if ((view.getUint32(at + ATTRIBUTES_AT, true) & OBJ_INHERIT) === 0) continue;
    const handle = Number(view.getBigUint64(at, true));
    if (std.has(handle)) continue;
    if (c.setHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)) sealed++;
  }
  return { handles: count, sealed };
}

let guarded = false;

/** Whether this process's spawns are sealed. */
export function spawnsGuarded(): boolean {
  return guarded;
}

/**
 * From now on, every child this process starts is started with no handle of the process's but
 * what the runtime gives it: `Bun.spawn` and `Bun.spawnSync` seal the handles first. Once per
 * process; nothing off Windows.
 */
export function guardSpawns(): boolean {
  if (guarded) return true;
  if (!load()) return false;
  const bun = Bun as unknown as Record<"spawn" | "spawnSync", (...args: unknown[]) => unknown>;
  for (const name of ["spawn", "spawnSync"] as const) {
    const original = bun[name];
    bun[name] = function (this: unknown, ...args: unknown[]) {
      sealHandles();
      return original.apply(this, args);
    };
  }
  guarded = true;
  return true;
}
