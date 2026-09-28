// Paths compared the way the platform's filesystem compares them: case-folded on Windows
// and macOS, where the default filesystems are case-insensitive, byte for byte on Linux; and
// on macOS in one Unicode form too, since APFS takes "é" typed (NFC) and "é" as the Finder
// may spell it (NFD, e and a combining accent) as the same name, where NTFS and ext4 do not.
// The one place every adapter goes through when it matches a path a harness reported (a
// transcript, a rollout, a hooks file) against a directory it owns.

import { resolve } from "node:path";

/** Whether the platform's default filesystem folds case. */
export function foldsCase(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * A path as a key: resolved, case-folded where the filesystem is, and in NFC on macOS. Keeps
 * the host's separators, so a key made on Windows is what `profileKey` has always stored.
 */
export function pathKey(p: string, platform: string = process.platform): string {
  const r = platform === "darwin" ? resolve(p).normalize("NFC") : resolve(p);
  return foldsCase(platform) ? r.toLowerCase() : r;
}

/** The key with every separator forward, so `a\b` and `a/b` compare equal. */
function slashed(p: string, platform?: string): string {
  return pathKey(p, platform).replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Whether two paths name the same file, whichever separators and case each was written with. */
export function samePath(a: string | undefined, b: string | undefined, platform?: string): boolean {
  if (a === undefined || b === undefined) return false;
  return slashed(a, platform) === slashed(b, platform);
}

/** Whether `path` is `dir` or lies under it: a separator boundary, so `/a/bc` is not within `/a/b`. */
export function isWithin(path: string, dir: string, platform?: string): boolean {
  const p = slashed(path, platform);
  const d = slashed(dir, platform);
  return p === d || p.startsWith(d + "/");
}

/** A Windows path without the `\\?\` long-path prefix a harness may report it with (Muse does). */
export function plainPath(p: string): string {
  return p.replace(/^\\\\\?\\/, "");
}
