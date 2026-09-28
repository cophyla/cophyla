// The environment a Mac app started from the Finder or at login lacks. launchd gives it
// `/usr/bin:/bin:/usr/sbin:/sbin` and no `LANG`: no Homebrew, no `~/.local/bin`, no nvm, so
// neither `claude` nor `codex` is found, an npm-installed CLI finds no `node`, a session's MCP
// servers find no `npx`, and a shell a session runs in mangles anything outside ASCII. A daemon
// started so takes the PATH the user's login shell sets (what a terminal would have), keeps
// its own entries after it, then adds the usual install folders that exist; and the locale the
// user picked in System Settings. A daemon started from a terminal (`TERM` set) already has the
// user's environment and is left alone, as is every platform but macOS.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import type { Exec, ExecResult } from "./sessions/focus.ts";

// macOS's paths and PATH, whichever platform runs the tests
const { delimiter, isAbsolute, join } = posix;

const MARK = "__COPHYLA_LOGIN_ENV__";
/** A login shell that sources a slow profile (nvm, conda) still answers well within this. */
export const SHELL_TIMEOUT_MS = 8000;

export interface LoginEnvDeps {
  exec: Exec;
  exists: (path: string) => boolean;
  /** The text of a small file, or undefined. */
  read: (path: string) => string | undefined;
  home: string;
}

/** What was changed, for the log: where the PATH came from and what it gained. */
export interface LoginEnvNote {
  source: "shell" | "path_helper" | "none";
  added: string[];
  lang?: string;
  /** The PATH the user's own shells have (the login shell's, else path_helper's): where a command they type is found. */
  shellPath?: string;
}

/**
 * Runs a command with no stdin and settles by the timeout whatever it does: an interactive
 * shell ignores SIGTERM, so it is killed outright, and a job its profile started in the
 * background may hold the output open after it exits, so its exit settles it.
 */
export function execSettled(file: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const settle = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      settle(null);
    }, opts.timeoutMs ?? SHELL_TIMEOUT_MS);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      settle(null);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => (out += s));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (s: string) => (err += s));
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
    // what is still buffered arrives within a moment of the exit
    child.on("exit", (code) => setTimeout(() => settle(code), 200));
  });
}

const defaults: LoginEnvDeps = {
  exec: execSettled,
  exists: existsSync,
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  home: homedir(),
};

/** The `KEY=value` lines `env` printed between the two marks, as a map. */
export function parseMarkedEnv(out: string): Map<string, string> | undefined {
  const start = out.indexOf(MARK);
  const end = out.lastIndexOf(MARK);
  if (start < 0 || end <= start) return undefined;
  const vars = new Map<string, string>();
  for (const line of out.slice(start + MARK.length, end).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq))) vars.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return vars;
}

/** The PATH in `path_helper -s`'s answer: `PATH="…"; export PATH;`. */
export function parsePathHelper(out: string): string | undefined {
  return /PATH="([^"]*)"/.exec(out)?.[1];
}

/** The folders of `lists`, in order, each once, empty and relative entries dropped. */
export function mergePaths(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of lists.flat()) {
    const d = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
    if (!d || !isAbsolute(d) || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

/** The folders a CLI is commonly installed in on a Mac, whether or not a profile names them. */
export function installFolders(home: string, read: LoginEnvDeps["read"]): string[] {
  const dirs = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
  ];
  // nvm's default, when it names one installed version exactly (`22.19.0` or `v22.19.0`).
  const alias = read(join(home, ".nvm", "alias", "default"))?.trim();
  if (alias && /^v?\d+\.\d+\.\d+$/.test(alias)) dirs.push(join(home, ".nvm", "versions", "node", alias.startsWith("v") ? alias : `v${alias}`, "bin"));
  return dirs;
}

/** `en_GB.UTF-8` for an AppleLocale of `en_GB` (or `en_GB@rg=trzzzz`) when the system has it; `en_US.UTF-8` otherwise. */
export function localeOf(appleLocale: string | undefined, exists: (path: string) => boolean): string {
  const base = appleLocale?.trim().split("@")[0] ?? "";
  if (/^[a-z]{2,3}_[A-Z]{2}$/.test(base) && exists(`/usr/share/locale/${base}.UTF-8`)) return `${base}.UTF-8`;
  return "en_US.UTF-8";
}

/**
 * The variables to set on a macOS daemon started outside a terminal, and a note of what
 * changed; nothing anywhere else. Never throws: a shell that hangs or fails leaves the
 * system's `path_helper` and the install folders.
 */
export async function loginEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  deps: Partial<LoginEnvDeps> = {},
): Promise<{ vars: Record<string, string>; note: LoginEnvNote } | undefined> {
  if (platform !== "darwin" || env["TERM"]) return undefined;
  const d = { ...defaults, ...deps };
  const current = (env["PATH"] ?? "").split(delimiter);
  const shell = env["SHELL"] && isAbsolute(env["SHELL"]) ? env["SHELL"] : "/bin/zsh";

  let source: LoginEnvNote["source"] = "none";
  let first: string[] = [];
  // Interactive as well as login: nvm, pyenv and most PATH lines live in `.zshrc`/`.bashrc`.
  // `env` rather than `$PATH`, so a fish list prints joined as the environment has it.
  const r = await d.exec(shell, ["-ilc", `echo ${MARK}; /usr/bin/env; echo ${MARK}`], { timeoutMs: SHELL_TIMEOUT_MS });
  const shellVars = r.code === 0 ? parseMarkedEnv(r.out) : undefined;
  const shellPath = shellVars?.get("PATH");
  if (shellPath) {
    source = "shell";
    first = shellPath.split(delimiter);
  } else {
    const h = await d.exec("/usr/libexec/path_helper", ["-s"], { timeoutMs: 3000 });
    const helped = h.code === 0 ? parsePathHelper(h.out) : undefined;
    if (helped) {
      source = "path_helper";
      first = helped.split(delimiter);
    }
  }
  const merged = mergePaths(first, current, installFolders(d.home, d.read).filter((dir) => d.exists(dir)));
  const had = new Set(current);
  const vars: Record<string, string> = { PATH: merged.join(delimiter) };
  const note: LoginEnvNote = { source, added: merged.filter((dir) => !had.has(dir)), ...(first.length > 0 ? { shellPath: first.join(delimiter) } : {}) };

  if (!env["LANG"] && !env["LC_ALL"] && !env["LC_CTYPE"]) {
    const fromShell = shellVars?.get("LANG");
    let lang = fromShell;
    if (!lang) {
      const l = await d.exec("/usr/bin/defaults", ["read", "-g", "AppleLocale"], { timeoutMs: 3000 });
      lang = localeOf(l.code === 0 ? l.out : undefined, d.exists);
    }
    vars["LANG"] = lang;
    note.lang = lang;
  }
  return { vars, note };
}
