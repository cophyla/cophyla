// One frame of a display for the brain, with no host running: the OS's own capture, scaled
// to `screenshot_width`, as a JPEG. Windows draws through System.Drawing in a PowerShell
// script written to disk once — Defender's AMSI calls a script that pairs `CopyFromScreen`
// with the JPEG encoder-parameters path, or with an in-memory stream and base64,
// "malicious content", while capture → scale → `Save(path, Jpeg)` passes, so the file is
// read back here and encoded here. macOS uses `screencapture` and `sips`; Linux `grim` on
// Wayland, ImageMagick's `import` on X11, and answers `unsupported` with no display at all.
// Without Screen Recording, macOS's `screencapture` still exits 0 with a picture of the
// wallpaper alone, so the permission is checked first (CoreGraphics' preflight, which answers
// for the app cophylad runs under); the first refusal also asks, which puts Cophyla in the
// Screen Recording list for the user to switch on.

import { dlopen, FFIType } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { runCommand } from "../sessions/focus.ts";
import type { Exec as RunExec } from "../sessions/focus.ts";
import type { HostOs } from "../update/platform.ts";

export interface Screenshot {
  mime: string;
  base64: string;
  width: number;
  height: number;
  display: number;
}

export type Capture = (display: number | undefined, maxWidth: number) => Promise<Screenshot>;

export interface ScreenshotDeps {
  /** `<home>/data/remote`: where the capture script lives. */
  dir: string;
  os: HostOs;
  log: Logger;
  exec?: RunExec;
  env?: Record<string, string | undefined>;
  /** macOS: whether the app may record the screen; `ask` shows the system's request. */
  screenAccess?: ScreenAccess;
}

export interface ScreenAccess {
  allowed(): boolean;
  ask(): void;
}

let coreGraphics: { preflight: () => boolean; request: () => boolean } | undefined;

/** CoreGraphics' Screen Recording preflight and request, through bun:ffi. */
export function darwinScreenAccess(): ScreenAccess {
  const cg = () => {
    if (!coreGraphics) {
      const lib = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
        CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
        CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
      });
      coreGraphics = { preflight: () => lib.symbols.CGPreflightScreenCaptureAccess(), request: () => lib.symbols.CGRequestScreenCaptureAccess() };
    }
    return coreGraphics;
  };
  return { allowed: () => cg().preflight(), ask: () => void cg().request() };
}

export const SCREEN_RECORDING_REFUSED = "macOS has not allowed Cophyla to record the screen: switch it on in System Settings → Privacy & Security → Screen Recording, then quit and reopen Cophyla";

/** The dimensions from a JPEG's SOF marker, so every platform reports them the same way. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof) return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    i += 2 + length;
  }
  return undefined;
}

export const WINDOWS_SCRIPT = `param([int]$Display = 0, [int]$MaxWidth = 1280, [string]$Out = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($Display -lt 0 -or $Display -ge $screens.Count) { throw "no display $Display (this node has $($screens.Count))" }
$b = $screens[$Display].Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$w = $b.Width; $h = $b.Height
if ($w -gt $MaxWidth) { $h = [int][Math]::Round($h * $MaxWidth / $w); $w = $MaxWidth }
$scaled = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($scaled)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $w, $h)
$g2.Dispose(); $bmp.Dispose()
$scaled.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$scaled.Dispose()
"$w" + "x" + "$h"
`;

/** The capture for this OS, through the given command runner. */
export function screenshotter(deps: ScreenshotDeps): Capture {
  const exec = deps.exec ?? runCommand;
  const env = deps.env ?? process.env;
  let access = deps.screenAccess;
  let asked = false;
  return async (display, maxWidth) => {
    const index = display ?? 0;
    mkdirSync(deps.dir, { recursive: true });
    const out = join(deps.dir, `shot-${process.pid}-${Date.now()}.jpg`);
    try {
      switch (deps.os) {
        case "windows": {
          const script = join(deps.dir, "screenshot.ps1");
          if (!existsSync(script) || readFileSync(script, "utf8") !== WINDOWS_SCRIPT) writeFileSync(script, WINDOWS_SCRIPT);
          const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Display", String(index), "-MaxWidth", String(maxWidth), "-Out", out], { timeoutMs: 20_000 });
          if (r.code !== 0 || !existsSync(out)) throw new RpcError(/no display/.test(r.err) ? "not_found" : "unavailable", `screenshot failed: ${(r.err || r.out).trim().slice(0, 300) || `exit ${r.code}`}`);
          break;
        }
        case "macos": {
          access ??= darwinScreenAccess();
          if (!access.allowed()) {
            if (!asked) {
              asked = true;
              access.ask();
            }
            throw new RpcError("unavailable", SCREEN_RECORDING_REFUSED);
          }
          const r = await exec("screencapture", ["-x", "-t", "jpg", "-D", String(index + 1), out], { timeoutMs: 20_000 });
          if (r.code !== 0 || !existsSync(out)) throw new RpcError("unavailable", `screencapture failed: ${r.err.trim().slice(0, 300) || `exit ${r.code}`}`);
          const s = await exec("sips", ["-Z", String(maxWidth), out], { timeoutMs: 20_000 });
          if (s.code !== 0) throw new RpcError("unavailable", `sips failed: ${s.err.trim().slice(0, 300)}`);
          break;
        }
        default: {
          if (env["WAYLAND_DISPLAY"]) {
            const r = await exec("grim", ["-t", "jpeg", "-q", "80", out], { timeoutMs: 20_000 });
            if (r.code !== 0 || !existsSync(out)) throw new RpcError("unavailable", `grim failed: ${r.err.trim().slice(0, 300) || `exit ${r.code}`}`);
            const c = await exec("convert", [out, "-resize", `${maxWidth}>`, out], { timeoutMs: 20_000 });
            if (c.code !== 0) deps.log.debug("screenshot left unscaled: no ImageMagick", { error: c.err.trim().slice(0, 100) });
          } else if (env["DISPLAY"]) {
            const r = await exec("import", ["-window", "root", "-resize", `${maxWidth}>`, "-quality", "80", out], { timeoutMs: 20_000 });
            if (r.code !== 0 || !existsSync(out)) throw new RpcError("unavailable", `import failed: ${r.err.trim().slice(0, 300) || `exit ${r.code}`}`);
          } else {
            throw new RpcError("unsupported", "this node has no display to capture");
          }
        }
      }
      const bytes = readFileSync(out);
      const size = jpegSize(bytes);
      if (!size) throw new RpcError("unavailable", "the capture is not a JPEG");
      return { mime: "image/jpeg", base64: bytes.toString("base64"), width: size.width, height: size.height, display: index };
    } finally {
      rmSync(out, { force: true });
    }
  };
}
