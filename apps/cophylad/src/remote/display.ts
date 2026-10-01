// The primary display's current mode in physical pixels: what Apollo and Sunshine capture by
// default, so what a stream of this desktop is sized to. Windows reads it with
// `EnumDisplaySettingsW(NULL, ENUM_CURRENT_SETTINGS)`, which answers the mode itself whatever
// this process's DPI awareness; macOS with CoreGraphics' main display mode, its pixel size
// rather than its points. Linux has no one way to ask (X11, each Wayland compositor), so it
// answers nothing and the stream falls back. Each read is one native call, cheap enough for
// every poll of the host, so a resolution change shows at the next one.

import type { DisplaySize } from "@cophyla/protocol";
import type { HostOs } from "../update/platform.ts";

/** `sizeof(DEVMODEW)`, and where its pixel width and height are. */
const DEVMODEW_SIZE = 220;
const DM_SIZE = 68;
const DM_PELS_WIDTH = 172;
const DM_PELS_HEIGHT = 176;
const ENUM_CURRENT_SETTINGS = -1;

let windowsCalls: { read: () => DisplaySize | undefined } | null | undefined;
let darwinCalls: { read: () => DisplaySize | undefined } | null | undefined;

function loadWindows(): { read: () => DisplaySize | undefined } | null {
  if (windowsCalls !== undefined) return windowsCalls;
  if (process.platform !== "win32") return (windowsCalls = null);
  try {
    // Imported here, not at the top: `bun:ffi` is Bun's alone and this file is typechecked everywhere.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const user32 = ffi.dlopen("user32.dll", {
      EnumDisplaySettingsW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as { EnumDisplaySettingsW: (device: unknown, mode: number, devmode: unknown) => number };
    const ptr = ffi.ptr as unknown as (view: ArrayBufferView) => unknown;
    const mode = new Uint8Array(DEVMODEW_SIZE);
    const view = new DataView(mode.buffer);
    windowsCalls = {
      read: () => {
        mode.fill(0);
        view.setUint16(DM_SIZE, DEVMODEW_SIZE, true);
        if (user32.EnumDisplaySettingsW(null, ENUM_CURRENT_SETTINGS >>> 0, ptr(mode)) === 0) return undefined;
        return sized(view.getUint32(DM_PELS_WIDTH, true), view.getUint32(DM_PELS_HEIGHT, true));
      },
    };
  } catch {
    windowsCalls = null;
  }
  return windowsCalls;
}

function loadDarwin(): { read: () => DisplaySize | undefined } | null {
  if (darwinCalls !== undefined) return darwinCalls;
  if (process.platform !== "darwin") return (darwinCalls = null);
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const cg = ffi.dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGMainDisplayID: { args: [], returns: FFIType.u32 },
      CGDisplayCopyDisplayMode: { args: [FFIType.u32], returns: FFIType.ptr },
      CGDisplayModeGetPixelWidth: { args: [FFIType.ptr], returns: FFIType.u64 },
      CGDisplayModeGetPixelHeight: { args: [FFIType.ptr], returns: FFIType.u64 },
      CGDisplayModeRelease: { args: [FFIType.ptr], returns: FFIType.void },
    }).symbols as unknown as {
      CGMainDisplayID: () => number;
      CGDisplayCopyDisplayMode: (display: number) => unknown;
      CGDisplayModeGetPixelWidth: (mode: unknown) => number | bigint;
      CGDisplayModeGetPixelHeight: (mode: unknown) => number | bigint;
      CGDisplayModeRelease: (mode: unknown) => void;
    };
    darwinCalls = {
      read: () => {
        const mode = cg.CGDisplayCopyDisplayMode(cg.CGMainDisplayID());
        if (!mode) return undefined;
        try {
          return sized(Number(cg.CGDisplayModeGetPixelWidth(mode)), Number(cg.CGDisplayModeGetPixelHeight(mode)));
        } finally {
          cg.CGDisplayModeRelease(mode);
        }
      },
    };
  } catch {
    darwinCalls = null;
  }
  return darwinCalls;
}

function sized(width: number, height: number): DisplaySize | undefined {
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 ? { width, height } : undefined;
}

/** The primary display's size in physical pixels; undefined on Linux, or where it cannot be read. */
export function displaySize(os: HostOs): DisplaySize | undefined {
  try {
    if (os === "windows") return loadWindows()?.read();
    if (os === "macos") return loadDarwin()?.read();
  } catch {
    // a failed read is an unknown size
  }
  return undefined;
}
