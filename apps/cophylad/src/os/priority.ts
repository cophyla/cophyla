// How Windows schedules the daemon's threads and processes. A worker running background work
// (embedding, backfills, retention) puts its own thread in background mode, which lowers its
// CPU, I/O and memory priority together, so on a busy machine it waits for idle time instead of
// taking it from the user's work or from the daemon's own main thread; a read a client waits
// on runs below normal, and the main thread a step above. The daemon, the speech process and
// the app also opt out of EcoQoS: a process Windows decides is in the background is put on the
// efficiency cores at low clocks, and Cophyla's main thread answers the user, so it is not.
//
// Every call is Windows only and a no-op elsewhere, and none throws: a machine that refuses
// keeps the default and the caller carries on. The thread handle is the pseudo-handle -2
// (`GetCurrentThread()`), declared `i64` and passed as a BigInt: a `ptr` loses its sign bits.

export type ThreadLevel = "background" | "below" | "normal" | "above";

const THREAD_MODE_BACKGROUND_BEGIN = 0x00010000;
const THREAD_MODE_BACKGROUND_END = 0x00020000;
const LEVELS: Record<Exclude<ThreadLevel, "background">, number> = { below: -1, normal: 0, above: 1 };
const CURRENT_THREAD = -2n;
const CURRENT_PROCESS = -1n;
/** PROCESS_INFORMATION_CLASS ProcessPowerThrottling, and its state's one control bit. */
const PROCESS_POWER_THROTTLING = 4;
const POWER_THROTTLING_EXECUTION_SPEED = 0x1;

interface Kernel32 {
  SetThreadPriority(thread: bigint, priority: number): number;
  SetProcessInformation(process: bigint, cls: number, info: unknown, size: number): number;
}

let kernel32: Kernel32 | null | undefined;
let ptrOf: ((view: ArrayBufferView) => unknown) | undefined;

function load(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  if (process.platform !== "win32") return (kernel32 = null);
  try {
    // `bun:ffi` is Bun's alone and this file is read everywhere: required here, not imported.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    ptrOf = ffi.ptr as unknown as (view: ArrayBufferView) => unknown;
    const lib = ffi.dlopen("kernel32.dll", {
      SetThreadPriority: { args: [ffi.FFIType.i64, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
      SetProcessInformation: { args: [ffi.FFIType.i64, ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.u32], returns: ffi.FFIType.i32 },
    });
    kernel32 = lib.symbols as unknown as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

/** Whether this thread is in background mode, which must be left before any other level is set. */
let inBackground = false;
let level: ThreadLevel = "normal";

/** Sets the calling thread's priority; true when it took (always false off Windows). */
export function setThreadLevel(next: ThreadLevel): boolean {
  const k = load();
  if (!k) return false;
  if (next === level) return true;
  try {
    if (inBackground) {
      k.SetThreadPriority(CURRENT_THREAD, THREAD_MODE_BACKGROUND_END);
      inBackground = false;
    }
    let ok: boolean;
    if (next === "background") {
      ok = k.SetThreadPriority(CURRENT_THREAD, THREAD_MODE_BACKGROUND_BEGIN) !== 0;
      inBackground = ok;
    } else ok = k.SetThreadPriority(CURRENT_THREAD, LEVELS[next]) !== 0;
    level = ok ? next : "normal";
    return ok;
  } catch {
    return false;
  }
}

/** The level `setThreadLevel` last set on this thread. */
export function threadLevel(): ThreadLevel {
  return level;
}

/** Opts this process out of EcoQoS: Windows keeps it at full speed when it decides it is in the background. True when it took. */
export function optOutOfEcoQos(): boolean {
  const k = load();
  if (!k || !ptrOf) return false;
  try {
    // PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = EXECUTION_SPEED, StateMask = 0 }
    const state = new Uint32Array([1, POWER_THROTTLING_EXECUTION_SPEED, 0]);
    return k.SetProcessInformation(CURRENT_PROCESS, PROCESS_POWER_THROTTLING, ptrOf(state), state.byteLength) !== 0;
  } catch {
    return false;
  }
}
