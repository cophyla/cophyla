// Running the door's shim as an administrator, once to install it and once to remove it:
// `ShellExecuteExW` with the `runas` verb through `bun:ffi`, as `remote/display.ts` reads the
// screen. Windows shows its consent prompt on this machine's own screen; the call returns
// once it was answered, and the process is then watched until it exits, its exit code read
// without blocking the daemon (no wait on the handle: a poll every half second). Declining
// the prompt is ERROR_CANCELLED (1223), said in words. The elevated process cannot be read on
// its stdout, so it writes its outcome to a file the daemon names (`--result`). The user's
// SID is passed explicitly: the administrator who approves the prompt may be someone else,
// and the door's pipe is the user's alone.

import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Exec } from "../sidecars/tts-py.ts";

/** What an elevated run came to: its exit code, and the outcome it wrote. */
export interface Elevated {
  code: number;
  result?: { ok: boolean; error?: string; version?: string };
}

/** Starts `exe` elevated; resolves with its exit code once it ended. */
export type Elevator = (exe: string, args: string[], opts: { resultFile: string; timeoutMs: number }) => Promise<Elevated>;

const ERROR_CANCELLED = 1223;
const SE_ERR_ACCESSDENIED = 5;
const STILL_ACTIVE = 259;
/** `sizeof(SHELLEXECUTEINFOW)` on 64-bit Windows, and where its fields are. */
const SEI_SIZE = 112;
const SEI = { cbSize: 0, fMask: 4, lpVerb: 16, lpFile: 24, lpParameters: 32, lpDirectory: 40, nShow: 48, hInstApp: 56, hProcess: 104 } as const;
const SEE_MASK_NOCLOSEPROCESS = 0x40;
const SEE_MASK_NOASYNC = 0x100;
const SEE_MASK_FLAG_NO_UI = 0x400;
const SW_HIDE = 0;

/** A Windows command line's quoting of one argument (CommandLineToArgvW's rules). */
export function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/** Why an elevated run failed, in words, or undefined when it did what it was asked. */
export function elevationError(e: Elevated): string | undefined {
  if (e.code === ERROR_CANCELLED) return "the administrator prompt was declined";
  if (e.code === 0 && e.result?.ok !== false) return undefined;
  if (e.result?.error) return e.result.error;
  if (e.code === 5) return "it needs an administrator";
  if (e.code === 2) return "the door's installer was given what it cannot use";
  return `the door's installer failed (exit ${e.code})`;
}

function wide(s: string): Uint16Array {
  const out = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

interface Calls {
  run(file: string, params: string): { ok: true; process: bigint } | { ok: false; error: number };
  exitCode(process: bigint): number | undefined;
  close(process: bigint): void;
}

let calls: Calls | null | undefined;

function load(): Calls | null {
  if (calls !== undefined) return calls;
  if (process.platform !== "win32") return (calls = null);
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const shell32 = ffi.dlopen("shell32.dll", { ShellExecuteExW: { args: [FFIType.ptr], returns: FFIType.i32 } }).symbols as unknown as { ShellExecuteExW: (info: unknown) => number };
    const kernel32 = ffi.dlopen("kernel32.dll", {
      GetLastError: { args: [], returns: FFIType.u32 },
      GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols as unknown as { GetLastError: () => number; GetExitCodeProcess: (h: bigint, out: unknown) => number; CloseHandle: (h: bigint) => number };
    const ptr = ffi.ptr as unknown as (view: ArrayBufferView) => number;
    calls = {
      run: (file, params) => {
        const verb = wide("runas");
        const f = wide(file);
        const p = wide(params);
        const info = new Uint8Array(SEI_SIZE);
        const v = new DataView(info.buffer);
        v.setUint32(SEI.cbSize, SEI_SIZE, true);
        v.setUint32(SEI.fMask, SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI, true);
        v.setBigUint64(SEI.lpVerb, BigInt(ptr(verb)), true);
        v.setBigUint64(SEI.lpFile, BigInt(ptr(f)), true);
        v.setBigUint64(SEI.lpParameters, BigInt(ptr(p)), true);
        v.setInt32(SEI.nShow, SW_HIDE, true);
        const ok = shell32.ShellExecuteExW(ptr(info));
        if (!ok) {
          const error = kernel32.GetLastError();
          const inst = Number(v.getBigUint64(SEI.hInstApp, true));
          return { ok: false, error: error || (inst === SE_ERR_ACCESSDENIED ? ERROR_CANCELLED : inst) };
        }
        return { ok: true, process: v.getBigUint64(SEI.hProcess, true) };
      },
      exitCode: (h) => {
        const out = new Uint32Array(1);
        if (!kernel32.GetExitCodeProcess(h, ptr(out))) return 1;
        return out[0] === STILL_ACTIVE ? undefined : out[0]!;
      },
      close: (h) => void kernel32.CloseHandle(h),
    };
  } catch {
    calls = null;
  }
  return calls;
}

/** The elevator Windows has: the consent prompt, then the process watched to its end. */
export const runElevated: Elevator = async (exe, args, opts) => {
  const c = load();
  if (!c) return { code: 1, result: { ok: false, error: "an administrator's run needs Windows" } };
  rmSync(opts.resultFile, { force: true });
  const started = c.run(exe, args.map(quoteArg).join(" "));
  if (!started.ok) return { code: started.error };
  const end = Date.now() + opts.timeoutMs;
  try {
    for (;;) {
      const code = c.exitCode(started.process);
      if (code !== undefined) return { code, ...readResult(opts.resultFile) };
      if (Date.now() > end) return { code: 1, result: { ok: false, error: "the door's installer did not finish in time" } };
      await Bun.sleep(500);
    }
  } finally {
    c.close(started.process);
  }
};

function readResult(file: string): { result?: Elevated["result"] } {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { ok?: unknown; error?: unknown; version?: unknown };
    rmSync(file, { force: true });
    return { result: { ok: v.ok === true, ...(typeof v.error === "string" ? { error: v.error } : {}), ...(typeof v.version === "string" ? { version: v.version } : {}) } };
  } catch {
    return {};
  }
}

/** The signed-in user's SID, which the door's pipe lets in: `whoami /user`. */
export async function currentUserSid(exec: Exec): Promise<string> {
  const r = await exec(["whoami", "/user", "/fo", "csv", "/nh"], {});
  const sid = /"?(S-1-[0-9-]+)"?\s*$/m.exec(r.stdout.trim())?.[1];
  if (r.code !== 0 || !sid) throw new Error(`could not read this user's SID: ${r.stderr.trim() || r.stdout.trim()}`);
  return sid;
}
