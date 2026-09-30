// Images a browser cannot draw, made into ones it can: a TIFF or a HEIC (HEIF) image becomes a
// PNG by the computer's own codecs, scaled to fit CONVERT_MAX pixels a side, for a viewer to
// draw. On Windows that is WIC, through PowerShell and WPF's imaging classes, which read HEIC
// once Microsoft's HEIF and HEVC extensions are installed; on a Mac `sips`; on Linux ImageMagick
// (`magick`, or IM6's `convert`) when it is on the PATH, else `heif-convert` for a HEIC. The
// codecs are the computer's own because the alternative, a decoder shipped in the view, would
// be LGPL code carrying HEVC's patents. A failure says why in words the viewer shows.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The longest side a converted image is drawn at. */
export const CONVERT_MAX = 4096;
/** How long one conversion may run. */
const CONVERT_TIMEOUT_MS = 60_000;

/** The kinds converted, by extension, and what each is called. */
const CONVERTED: Readonly<Record<string, string>> = { tif: "TIFF", tiff: "TIFF", heic: "HEIC", heif: "HEIF" };

/** What kind of image a path names that is converted before it is drawn: TIFF, HEIC or HEIF; undefined for any other. */
export function convertKind(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(CONVERTED, ext) ? CONVERTED[ext] : undefined;
}

/** Why an image could not be made a PNG: its message is the viewer's words. */
export class ConvertError extends Error {}

/** Makes the image at `path`, a `kind` of `convertKind`'s, a PNG; throws ConvertError saying why it could not. */
export type ImageConverter = (path: string, kind: string) => Promise<Uint8Array>;

export interface ConvertDeps {
  platform: NodeJS.Platform;
  which: (command: string) => string | null;
  /** Runs a program to its end: its exit code and what it wrote to stderr. */
  run: (command: string, args: string[], env?: Record<string, string>) => Promise<{ code: number | null; err: string }>;
}

function run(command: string, args: string[], env?: Record<string, string>): Promise<{ code: number | null; err: string }> {
  return new Promise((done) => {
    let err = "";
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
    const timer = setTimeout(() => child.kill(), CONVERT_TIMEOUT_MS);
    child.stderr?.on("data", (b: Buffer) => {
      if (err.length < 8000) err += b.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, err: e.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, err });
    });
  });
}

const defaults: ConvertDeps = { platform: process.platform, which: (c) => Bun.which(c), run };

/**
 * WIC through WPF: the first frame decoded, scaled through WIC's own scaler when it is larger
 * than the most, and encoded as PNG. The paths come in the environment, so nothing in them is
 * ever read as PowerShell.
 */
const WIC_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName PresentationCore",
  "$max = [double]$env:COPHYLA_CONVERT_MAX",
  "$in = [IO.File]::Open($env:COPHYLA_CONVERT_IN, 'Open', 'Read', 'ReadWrite')",
  "try {",
  "  $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create($in, [Windows.Media.Imaging.BitmapCreateOptions]::None, [Windows.Media.Imaging.BitmapCacheOption]::None)",
  "  $frame = $decoder.Frames[0]",
  "  $scale = [Math]::Min(1.0, $max / [Math]::Max($frame.PixelWidth, $frame.PixelHeight))",
  "  $image = $frame",
  "  if ($scale -lt 1.0) { $image = New-Object Windows.Media.Imaging.TransformedBitmap($frame, (New-Object Windows.Media.ScaleTransform($scale, $scale))) }",
  "  $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder",
  "  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($image))",
  "  $out = [IO.File]::Create($env:COPHYLA_CONVERT_OUT)",
  "  try { $encoder.Save($out) } finally { $out.Close() }",
  "} finally { $in.Close() }",
].join("\n");

/** The words for an image no codec here reads, by platform. */
function noDecoder(platform: NodeJS.Platform, kind: string): ConvertError {
  const heic = kind === "HEIC" || kind === "HEIF";
  if (platform === "win32") return new ConvertError(heic ? `This computer has no decoder for ${kind} images: install the HEIF Image Extensions and the HEVC Video Extensions from the Microsoft Store.` : `This computer has no decoder for this ${kind} image.`);
  if (platform === "darwin") return new ConvertError(`This Mac could not read this ${kind} image.`);
  return new ConvertError(heic ? `This computer has no decoder for ${kind} images: install ImageMagick, or libheif's heif-convert.` : `This computer has no decoder for ${kind} images: install ImageMagick.`);
}

/** The computer's own codecs, as `platform` has them. */
export function systemConverter(over: Partial<ConvertDeps> = {}): ImageConverter {
  const deps: ConvertDeps = { ...defaults, ...over };
  return async (path, kind) => {
    const dir = await mkdtemp(join(tmpdir(), "cophyla-convert-"));
    const out = join(dir, "image.png");
    try {
      let r: { code: number | null; err: string };
      if (deps.platform === "win32") {
        const script = Buffer.from(WIC_SCRIPT, "utf16le").toString("base64");
        r = await deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", script], { COPHYLA_CONVERT_IN: path, COPHYLA_CONVERT_OUT: out, COPHYLA_CONVERT_MAX: String(CONVERT_MAX) });
        // WINCODEC_ERR_COMPONENTNOTFOUND: no codec for the format.
        if (r.code !== 0 && /88982F50|imaging component suitable/i.test(r.err)) throw noDecoder(deps.platform, kind);
      } else if (deps.platform === "darwin") {
        r = await deps.run("sips", ["-s", "format", "png", "-Z", String(CONVERT_MAX), path, "--out", out]);
      } else {
        const magick = deps.which("magick") ?? deps.which("convert");
        const heif = kind === "HEIC" || kind === "HEIF" ? deps.which("heif-convert") : null;
        if (magick) r = await deps.run(magick, [`${path}[0]`, "-auto-orient", "-resize", `${CONVERT_MAX}x${CONVERT_MAX}>`, `png:${out}`]);
        else if (heif) r = await deps.run(heif, [path, out]);
        else throw noDecoder(deps.platform, kind);
      }
      if (r.code !== 0) throw new ConvertError(`This ${kind} image could not be read here${r.err.trim() ? `: ${firstLine(r.err)}` : "."}`);
      try {
        return new Uint8Array(await readFile(out));
      } catch {
        throw new ConvertError(`This ${kind} image could not be read here.`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** A program's first line of complaint, short enough for the viewer's note. */
function firstLine(err: string): string {
  const line = err
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !/^(At line|\+ |CategoryInfo|FullyQualifiedErrorId)/.test(l)) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
