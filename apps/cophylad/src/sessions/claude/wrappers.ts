// Claude accounts the user starts through a wrapper script: a `claude-<name>` script (`.cmd`,
// `.bat`, `.ps1`, `.sh` or none) in a folder on PATH, WinGet's Links folder or `~/.local/bin`,
// that sets CLAUDE_CONFIG_DIR before it runs Claude, as `claude-work.cmd` does with
// `set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-work"`. Each one names an account the user
// runs, so discovery takes its directory as a Claude profile, named after the script, when the
// directory is there; one the user declared in config is theirs as they declared it.
//
// Discovery asks every few seconds, so a folder is read again only when its modification time
// moved, and a script only when its own did: one `stat` per folder and per script otherwise.
// A script past 16 KiB is no wrapper and is not read.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

/** A wrapper found: the account directory it sets, the name it gives the profile, and the script. */
export interface ClaudeWrapper {
  dir: string;
  name: string;
  script: string;
}

const MAX_SCRIPT = 16 * 1024;
/** `claude-<name>` or `claude_<name>`, with a script's extension or none. */
const NAME = /^claude[-_](.+?)(\.(cmd|bat|ps1|sh))?$/i;
/** The value CLAUDE_CONFIG_DIR is set to: quoted, or bare up to a quote, a space or a shell's operator. */
const ASSIGN = /CLAUDE_CONFIG_DIR\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'&|;]+))/;

/** The value a script sets CLAUDE_CONFIG_DIR to, its variables as written; undefined when it sets none. */
export function wrapperConfigDir(text: string): string | undefined {
  const m = ASSIGN.exec(text);
  const value = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  return value?.trim() || undefined;
}

/**
 * A path as the script's shell would make it: `%VAR%`, `$env:VAR`, `$VAR`, `${VAR}` and a
 * leading `~`, from the environment (names in any case on Windows; HOME and USERPROFILE fall
 * back on the home folder). Undefined when a variable is unknown or the path is not absolute.
 */
export function expandWrapperPath(raw: string, env: Record<string, string | undefined>, home: string, platform: NodeJS.Platform): string | undefined {
  const lookup = (name: string): string | undefined => {
    const hit = platform === "win32" ? Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1] : env[name];
    if (hit !== undefined && hit !== "") return hit;
    return name.toUpperCase() === "HOME" || name.toUpperCase() === "USERPROFILE" ? home : undefined;
  };
  let unknown = false;
  const take = (name: string): string => {
    const v = lookup(name);
    if (v === undefined) unknown = true;
    return v ?? "";
  };
  let s = raw.trim();
  s = s.replace(/%([A-Za-z0-9_]+)%/g, (_m, v: string) => take(v));
  s = s.replace(/\$env:([A-Za-z0-9_]+)/gi, (_m, v: string) => take(v));
  s = s.replace(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g, (_m, a: string | undefined, b: string | undefined) => take((a ?? b)!));
  if (unknown) return undefined;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = join(home, s.slice(1));
  return isAbsolute(s) ? resolve(s) : undefined;
}

/** The profile's name a wrapper gives: its own name past `claude-`, else the directory's. */
export function wrapperName(script: string, dir: string): string {
  const m = NAME.exec(basename(script));
  return m?.[1]?.trim() || basename(dir) || "wrapper";
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface FolderScan {
  mtime: number;
  /** The scripts in it whose names say wrapper. */
  scripts: string[];
}

interface ScriptRead {
  mtime: number;
  /** What it sets CLAUDE_CONFIG_DIR to, as written; undefined when it sets none or is too big. */
  value?: string;
}

/** Finds the wrappers, remembering each folder's listing and each script's value by their times. */
export class ClaudeWrappers {
  private folders = new Map<string, FolderScan>();
  private scripts = new Map<string, ScriptRead>();
  private env: Record<string, string | undefined>;
  private home: string;
  private platform: NodeJS.Platform;

  constructor(opts: { env: Record<string, string | undefined>; home: string; platform: NodeJS.Platform }) {
    this.env = opts.env;
    this.home = opts.home;
    this.platform = opts.platform;
  }

  /** The folders looked in: PATH's, then WinGet's Links folder on Windows and `~/.local/bin`, each once. */
  folderList(): string[] {
    const sep = this.platform === "win32" ? ";" : ":";
    const pathVar = this.platform === "win32" ? Object.entries(this.env).find(([k]) => k.toUpperCase() === "PATH")?.[1] : this.env["PATH"];
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (d: string | undefined) => {
      const t = d?.trim().replace(/^"(.*)"$/, "$1");
      if (!t || !isAbsolute(t)) return;
      const key = this.platform === "win32" ? resolve(t).toLowerCase() : resolve(t);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(resolve(t));
    };
    for (const d of (pathVar ?? "").split(sep)) add(d);
    const local = this.platform === "win32" ? Object.entries(this.env).find(([k]) => k.toUpperCase() === "LOCALAPPDATA")?.[1] : undefined;
    if (local) add(join(local, "Microsoft", "WinGet", "Links"));
    add(join(this.home, ".local", "bin"));
    return out;
  }

  /** Every wrapper whose directory is there, one per directory, in the folders' order. */
  list(): ClaudeWrapper[] {
    const out: ClaudeWrapper[] = [];
    const dirs = new Set<string>();
    const live = new Set<string>();
    for (const folder of this.folderList()) {
      live.add(folder);
      for (const script of this.scriptsIn(folder)) {
        const value = this.valueOf(script);
        if (value === undefined) continue;
        const dir = expandWrapperPath(value, this.env, this.home, this.platform);
        if (!dir || !isDir(dir)) continue;
        const key = this.platform === "win32" ? dir.toLowerCase() : dir;
        if (dirs.has(key)) continue;
        dirs.add(key);
        out.push({ dir, name: wrapperName(script, dir), script });
      }
    }
    for (const f of this.folders.keys()) if (!live.has(f)) this.folders.delete(f);
    return out;
  }

  private scriptsIn(folder: string): string[] {
    const mtime = mtimeOf(folder);
    if (mtime === undefined) {
      this.folders.delete(folder);
      return [];
    }
    const known = this.folders.get(folder);
    if (known && known.mtime === mtime) return known.scripts;
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      names = [];
    }
    const scripts = names.filter((n) => NAME.test(n) && (extname(n) === "" || /^\.(cmd|bat|ps1|sh)$/i.test(extname(n)))).map((n) => join(folder, n));
    this.folders.set(folder, { mtime, scripts });
    return scripts;
  }

  private valueOf(script: string): string | undefined {
    const mtime = mtimeOf(script);
    if (mtime === undefined) {
      this.scripts.delete(script);
      return undefined;
    }
    const known = this.scripts.get(script);
    if (known && known.mtime === mtime) return known.value;
    let value: string | undefined;
    try {
      const st = statSync(script);
      if (st.isFile() && st.size <= MAX_SCRIPT) value = wrapperConfigDir(readFileSync(script, "utf8"));
    } catch {
      value = undefined;
    }
    this.scripts.set(script, { mtime, ...(value !== undefined ? { value } : {}) });
    return value;
  }
}
