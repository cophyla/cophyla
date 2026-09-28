// The `tether` and `cophyla` commands in the user's own shells, on an installed platform. The
// daemon runs tether from a copy of its own (see locate.ts); the command is one more copy, in
// a folder that never moves, `<root>/bin/`, so the PATH names it once and every later version
// lands under the same name. On Windows that folder goes on the user's PATH; elsewhere a link
// in `~/.local/bin` names the file, and one already there that is not the platform's is left be.
//
// A host started from the command runs from that file, which `placeBinary` replaces by
// moving it aside.
//
// `cophyla` is a launcher beside it: `cophyla.cmd` on Windows, a shell script elsewhere. It
// holds the install root and the Cophyla home it was placed from, reads `<root>/current` each
// time it runs, and runs that version's own runtime on that version's `cophyla.ts`, so it
// follows every update without being placed again.

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../log.ts";
import { placeBinary, placeFile } from "../../update/place.ts";
import { BUN_NAMES } from "../../update/platform.ts";
import { runCommand, type Exec } from "../focus.ts";
import { TETHER_NAME } from "./locate.ts";

/** `<root>/bin/`: the folder the command lives in. */
export function commandDir(root: string): string {
  return join(root, "bin");
}

/**
 * Makes `<dir>/tether` a copy of `source` when it is not one already, and removes what earlier
 * versions moved aside. Answers whether the file changed.
 */
export function placeCommand(source: string, dir: string): boolean {
  return placeBinary(source, dir, TETHER_NAME);
}

/** Whether a PATH value (`;`-separated on Windows) already names `dir`. */
export function pathHas(pathValue: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const sep = platform === "win32" ? ";" : ":";
  const norm = (p: string) => {
    const t = p.trim().replace(/[\\/]+$/, "");
    return platform === "win32" ? t.toLowerCase() : t;
  };
  const want = norm(dir);
  return pathValue.split(sep).some((p) => p.trim() !== "" && norm(p) === want);
}

/**
 * Adds a folder to the user's PATH in the registry, as the value's own kind (an expandable
 * string when there is none), and tells running programs the environment changed. Clearing a
 * user variable that is not there is what makes .NET broadcast that, with no side effect.
 * `$key` is another key under HKCU for the tests.
 */
export const ADD_TO_USER_PATH = `param([string]$dir, [string]$key = 'Environment')
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($key)
$v = ''
$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
if ($k.GetValueNames() -contains 'Path') { $v = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $kind = $k.GetValueKind('Path') }
$want = $dir.TrimEnd('\\')
foreach ($p in $v -split ';') { if ($p -and [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\\') -eq $want) { 'present'; return } }
$k.SetValue('Path', ((@($v.TrimEnd(';'), $dir) | Where-Object { $_ }) -join ';'), $kind)
if ($key -eq 'Environment') { [Environment]::SetEnvironmentVariable('COPHYLA_PATH_CHANGED', $null, 'User') }
'added'`;

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export type OnPathResult = "added" | "present" | "linked" | "taken" | "failed";

/** Windows: the folder on the user's PATH, unless the environment this daemon was given has it already. */
export async function addToUserPath(dir: string, env: Record<string, string | undefined>, exec: Exec = runCommand): Promise<OnPathResult> {
  if (pathHas(env["Path"] ?? env["PATH"] ?? "", dir, "win32")) return "present";
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& {${ADD_TO_USER_PATH}} ${psQuote(dir)}`], { timeoutMs: 30_000 });
  const said = r.out.trim().split(/\s+/).pop();
  return r.code === 0 && (said === "added" || said === "present") ? said : "failed";
}

/** macOS and Linux: `<linkDir>/<name>` names the command, unless something else holds that name. */
export function linkCommand(target: string, linkDir: string, name = "tether"): OnPathResult {
  const link = join(linkDir, name);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(link);
  } catch {
    // Not there.
  }
  if (st) {
    if (!st.isSymbolicLink()) return "taken";
    if (readlinkSync(link) === target) return "present";
    // Another link is the user's own, unless it names nowhere: then it is a platform's gone since.
    if (existsSync(link)) return "taken";
    rmSync(link);
  }
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(target, link);
  return "linked";
}

export interface CommandOptions {
  /** The staged binary the daemon runs. */
  exe: string;
  /** The install root. */
  root: string;
  env: Record<string, string | undefined>;
  log: Logger;
  exec?: Exec;
  /** Where the link goes on macOS and Linux. */
  linkDir?: string;
}

/** A path for a batch file's `set "…"`: `%` doubled, which is the one character it would expand. */
function batchQuote(s: string): string {
  return s.replace(/%/g, "%%");
}

/** A path as a single-quoted shell word. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Where a version's `cophyla.ts` is, under its version directory. */
const COPHYLA_TS = ["cophylad", "apps", "cophylad", "src", "cophyla.ts"];

/**
 * The `cophyla` launcher for Windows (`cophyla.cmd`) or a POSIX shell (`cophyla`): the root and
 * the default home it was placed from, the version `<root>/current` names when it runs.
 */
export function cophylaLauncher(root: string, home: string, kind: "windows" | "posix"): { name: string; text: string } {
  if (kind === "windows") {
    const ts = ["%V%", ...COPHYLA_TS].join("\\");
    return {
      name: "cophyla.cmd",
      text: [
        "@echo off",
        "rem The cophyla command: the Cophyla version current names, with its own runtime. Placed by cophylad.",
        "setlocal",
        `set "COPHYLA_ROOT=${batchQuote(root)}"`,
        `if not defined COPHYLA_HOME set "COPHYLA_HOME=${batchQuote(home)}"`,
        'set "V="',
        'set /p V=<"%COPHYLA_ROOT%\\current"',
        // a label, not a parenthesised block: a root with a parenthesis in it would end the block
        "if not defined V goto nocurrent",
        `"%COPHYLA_ROOT%\\versions\\%V%\\${BUN_NAMES.windows}" "%COPHYLA_ROOT%\\versions\\${ts}" %*`,
        "exit /b %ERRORLEVEL%",
        ":nocurrent",
        'echo cophyla: no current version under "%COPHYLA_ROOT%" 1>&2',
        "exit /b 1",
        "",
      ].join("\r\n"),
    };
  }
  // the home inside double quotes: a quote, a backslash, a dollar or a backtick escaped
  const h = home.replace(/["\\$\x60]/g, (c) => "\\" + c);
  return {
    name: "cophyla",
    text: [
      "#!/bin/sh",
      "# The cophyla command: the Cophyla version current names, with its own runtime. Placed by cophylad.",
      `root=${shQuote(root)}`,
      ': "${COPHYLA_HOME:=' + h + '}"',
      "export COPHYLA_HOME",
      'v=$(head -n 1 "$root/current" 2>/dev/null | tr -d \'[:space:]\')',
      'if [ -z "$v" ]; then echo "cophyla: no current version under $root" >&2; exit 1; fi',
      `exec "$root/versions/$v/${BUN_NAMES.linux}" "$root/versions/$v/${COPHYLA_TS.join("/")}" "$@"`,
      "",
    ].join("\n"),
  };
}

/** Writes the launcher for this platform into `<root>/bin/` when it is not there as it should be. Answers whether it changed. */
export function placeCophyla(root: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  const l = cophylaLauncher(root, home, platform === "win32" ? "windows" : "posix");
  return placeFile(Buffer.from(l.text, "utf8"), commandDir(root), l.name, { executable: true });
}

/** Keeps the `cophyla` command current and on the PATH beside tether; never throws. */
export async function putCophylaOnPath(opts: Omit<CommandOptions, "exe"> & { home: string }): Promise<void> {
  const dir = commandDir(opts.root);
  try {
    if (placeCophyla(opts.root, opts.home)) opts.log.info("cophyla command in place", { dir });
  } catch (e) {
    opts.log.warn("cophyla command not placed", { dir, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  try {
    if (process.platform === "win32") {
      const r = await addToUserPath(dir, opts.env, opts.exec);
      if (r === "failed") opts.log.warn("cophyla command's folder not added to the user's PATH", { dir });
    } else {
      const linkDir = opts.linkDir ?? join(homedir(), ".local", "bin");
      const r = linkCommand(join(dir, "cophyla"), linkDir, "cophyla");
      if (r === "linked") opts.log.info("cophyla command linked", { link: join(linkDir, "cophyla") });
      else if (r === "taken") opts.log.info("cophyla command not linked: another cophyla is there", { link: join(linkDir, "cophyla") });
    }
  } catch (e) {
    opts.log.warn("cophyla command not on the PATH", { dir, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Keeps the command current and on the PATH; never throws. */
export async function putCommandOnPath(opts: CommandOptions): Promise<void> {
  const dir = commandDir(opts.root);
  try {
    if (placeCommand(opts.exe, dir)) opts.log.info("tether command in place", { path: join(dir, TETHER_NAME) });
  } catch (e) {
    opts.log.warn("tether command not placed", { dir, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  try {
    if (process.platform === "win32") {
      const r = await addToUserPath(dir, opts.env, opts.exec);
      if (r === "added") opts.log.info("tether command's folder added to the user's PATH; terminals opened from now on have it", { dir });
      else if (r === "failed") opts.log.warn("tether command's folder not added to the user's PATH", { dir });
    } else {
      const linkDir = opts.linkDir ?? join(homedir(), ".local", "bin");
      const r = linkCommand(join(dir, TETHER_NAME), linkDir);
      if (r === "linked") opts.log.info("tether command linked", { link: join(linkDir, "tether"), onPath: pathHas(opts.env["PATH"] ?? "", linkDir) });
      else if (r === "taken") opts.log.info("tether command not linked: another tether is there", { link: join(linkDir, "tether") });
    }
  } catch (e) {
    opts.log.warn("tether command not on the PATH", { dir, error: e instanceof Error ? e.message : String(e) });
  }
}
