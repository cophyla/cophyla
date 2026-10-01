// The folders a terminal may start in, for New terminal's picker: one folder of this computer
// at a time, as `terminal.folders` answers it. The path is resolved as this computer resolves
// one (`~` is the user's home, a relative path is under it); its folders are the entries that
// are folders, or links to one, by name, up to 2000, without the hidden ones: a name starting
// with a dot, and on Windows what File Explorer hides (the hidden attribute). With them, its
// parent, the home, and the roots to start from: the drives on Windows, `/` elsewhere.

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { FolderPick } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";

/** The most folders one answer lists. */
export const FOLDERS_MAX = 2000;

export interface FolderDeps {
  home?: string;
  platform?: NodeJS.Platform;
  /** Whether File Explorer hides an entry: its hidden attribute, on Windows; nothing elsewhere. */
  hidden?: (path: string) => boolean;
  /** The roots to start from: the drives on Windows. */
  roots?: () => string[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || (a.name < b.name ? -1 : 1);

/** The folders in `path` (the user's home without it), as the picker shows them. */
export async function listFolders(path: string | undefined, deps: FolderDeps = {}): Promise<FolderPick> {
  const platform = deps.platform ?? process.platform;
  const p = platform === "win32" ? win32 : posix;
  const home = deps.home ?? homedir();
  const asked = path === undefined || path === "~" ? home : /^~[\\/]/.test(path) ? p.join(home, path.slice(2)) : path;
  const abs = p.resolve(home, asked);
  let isDir: boolean;
  try {
    isDir = (await stat(abs)).isDirectory();
  } catch (e) {
    throw refusal(e, abs);
  }
  if (!isDir) throw new RpcError("invalid", `${abs} is not a folder`);
  let entries: Dirent[];
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    throw refusal(e, abs);
  }
  const folders: { name: string; path: string }[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = p.join(abs, e.name);
    let dir = e.isDirectory();
    // a link, or a junction, to a folder is one; a broken one is nothing
    if (!dir && e.isSymbolicLink()) dir = await stat(full).then((s) => s.isDirectory(), () => false);
    if (!dir || deps.hidden?.(full)) continue;
    folders.push({ name: e.name, path: full });
  }
  folders.sort(byName);
  const parent = p.dirname(abs);
  return {
    path: abs,
    ...(parent !== abs ? { parent } : {}),
    folders: folders.slice(0, FOLDERS_MAX),
    ...(folders.length > FOLDERS_MAX ? { truncated: true as const } : {}),
    home,
    roots: deps.roots?.() ?? [p.parse(abs).root || "/"],
  };
}

/** A listing as its audit row keeps it: the folder and how many folders it holds, not their names. */
export function folderSummary(r: FolderPick): { path: string; folders: number; truncated?: true } {
  return { path: r.path, folders: r.folders.length, ...(r.truncated ? { truncated: true as const } : {}) };
}

function refusal(e: unknown, path: string): RpcError {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new RpcError("not_found", `no folder ${path}`);
  if (code === "ENOTDIR") return new RpcError("invalid", `${path} is not a folder`);
  if (code === "EACCES" || code === "EPERM") return new RpcError("denied", `${path} cannot be read`);
  return new RpcError("unavailable", `${path}: ${e instanceof Error ? e.message : String(e)}`);
}

interface Kernel32 {
  GetFileAttributesW: (path: unknown) => number;
  GetLogicalDrives: () => number;
}

const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const FILE_ATTRIBUTE_HIDDEN = 0x2;

let kernel32: { k: Kernel32; ptr: (view: ArrayBufferView) => unknown } | null | undefined;

/** kernel32 through `bun:ffi`, or null where there is none. */
function load(log?: Logger): typeof kernel32 {
  if (kernel32 !== undefined) return kernel32;
  if (process.platform !== "win32") return (kernel32 = null);
  try {
    // Imported here, not at the top: `bun:ffi` is Bun's alone and this file is read everywhere.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { FFIType } = ffi;
    const lib = ffi.dlopen("kernel32.dll", {
      GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetLogicalDrives: { args: [], returns: FFIType.u32 },
    });
    kernel32 = { k: lib.symbols as unknown as Kernel32, ptr: ffi.ptr as unknown as (view: ArrayBufferView) => unknown };
  } catch (e) {
    log?.debug("kernel32 not loaded; the folder picker shows hidden folders and no drives", { error: e instanceof Error ? e.message : String(e) });
    kernel32 = null;
  }
  return kernel32;
}

/** What this computer's picker reads beyond the folders themselves: on Windows, the hidden attribute and the drives. */
export function systemFolderDeps(log?: Logger): FolderDeps {
  const l = load(log);
  if (!l) return {};
  return {
    hidden: (path) => {
      const attrs = l.k.GetFileAttributesW(l.ptr(Buffer.from(`${path}\0`, "utf16le"))) >>> 0;
      return attrs !== INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_HIDDEN) !== 0;
    },
    roots: () => {
      const mask = l.k.GetLogicalDrives() >>> 0;
      const drives: string[] = [];
      for (let i = 0; i < 26; i++) if (mask & (1 << i)) drives.push(`${String.fromCharCode(65 + i)}:\\`);
      return drives;
    },
  };
}
