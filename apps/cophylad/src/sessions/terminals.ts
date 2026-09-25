// Where a session cophylad starts is shown: a terminal of its own, rather than a pipe nobody
// can see. Two openers, tried in order. The editor opener hands the command to a VS Code
// window that has said hello to this daemon, and the tab appears in the panel beside the
// user's own terminals. The OS opener starts a terminal the platform provides, and answers
// when no editor is listening.
//
// Reaching a terminal is not the same problem on each platform, and what differs is how a
// command line survives the trip. Windows was measured rather than assumed: a child spawned
// detached gets a console window but null handles, and the TUI exits at once; `conhost` does
// not start one either, and `wt.exe` cannot be spawned at all, being an app execution alias.
// `cmd /c start` is what works, and because `cmd` parses what it is handed — `%VAR%` expands,
// `&` separates — the command line is built here whole and quoted for `cmd`, rather than left
// to the C runtime's quoting, which `cmd` would read as syntax. macOS and Linux have to name
// a terminal program, and every one of them re-parses the command too, so nothing goes inline
// there either: the command goes into a launch script the terminal runs.
//
// Neither path carries the prompt. It is arbitrary prose, it would have to survive every
// parser above, and it does not need to: the session is injected with it over its messaging
// pipe once it registers, about a second and a half later.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";

export interface TerminalRequest {
  /** The program and its arguments, the program first. */
  argv: string[];
  cwd: string;
  /** Set beyond what the terminal already has. */
  env: Record<string, string>;
  /** Taken out of what the terminal would inherit from cophylad. */
  unset?: string[];
  /** The tab's title. */
  title: string;
}

export type TerminalKind = "vscode" | "os";

export interface TerminalOpener {
  readonly kind: TerminalKind;
  /** Whether a terminal can be opened now: an editor is listening, or a terminal program exists. */
  available(): Promise<boolean>;
  /** Opens it, or throws with why. */
  open(req: TerminalRequest): Promise<void>;
}

/** Quotes a word for a POSIX shell: single quotes, with the single quote spelled the long way. */
export function shellQuote(word: string): string {
  const quote = "'";
  return quote + word.split(quote).join(`'\\''`) + quote;
}

/**
 * Quotes a word for `cmd`. Double quotes stop `&`, `|` and the rest from being read as
 * syntax, and doubling `%` stops a variable expanding. A word carrying a double quote of its
 * own cannot be passed this way at all, so it loses it: nothing cophylad puts on a command line
 * has one, because the caller keeps to a safe alphabet.
 */
export function cmdQuote(word: string): string {
  return `"${word.replace(/%/g, "%%").replace(/"/g, "")}"`;
}

/**
 * The launch script a POSIX terminal runs: the environment, the directory, then the command
 * in the shell's place, so the terminal's window belongs to the session itself.
 */
export function launchScript(req: TerminalRequest): string {
  const lines = ["#!/bin/sh"];
  for (const k of req.unset ?? []) lines.push(`unset ${k}`);
  for (const [k, v] of Object.entries(req.env)) lines.push(`export ${k}=${shellQuote(v)}`);
  lines.push(`cd ${shellQuote(req.cwd)} || exit 1`);
  lines.push(`exec ${req.argv.map(shellQuote).join(" ")}`);
  return lines.join("\n") + "\n";
}

/** The `cmd` command line that opens one: `start` takes the title first, then the directory. */
export function windowsCommandLine(req: TerminalRequest): string {
  return ["/c", "start", cmdQuote(req.title), "/D", cmdQuote(req.cwd), ...req.argv.map(cmdQuote)].join(" ");
}

/** The terminal programs to try on Linux, and how each takes a script. `TERMINAL` comes first when set. */
const LINUX_TERMINALS: { command: string; args: (script: string) => string[] }[] = [
  { command: "x-terminal-emulator", args: (s) => ["-e", "/bin/sh", s] },
  { command: "gnome-terminal", args: (s) => ["--", "/bin/sh", s] },
  { command: "konsole", args: (s) => ["-e", "/bin/sh", s] },
  { command: "xfce4-terminal", args: (s) => ["-e", `/bin/sh ${s}`] },
  { command: "alacritty", args: (s) => ["-e", "/bin/sh", s] },
  { command: "kitty", args: (s) => ["/bin/sh", s] },
  { command: "xterm", args: (s) => ["-e", "/bin/sh", s] },
];

export interface OsTerminalOptions {
  platform: NodeJS.Platform;
  /** Where launch scripts are written: the daemon's data directory. */
  dataDir: string;
  log: Logger;
  which?: (command: string) => string | null;
  spawnDetached?: (command: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; verbatim?: boolean }) => void;
  env?: Record<string, string | undefined>;
}

function detach(command: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; verbatim?: boolean }): void {
  const child = spawn(command, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    // The terminal outlives the daemon that opened it.
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    ...(opts.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  child.unref();
}

/** A terminal the platform provides. */
export class OsTerminalOpener implements TerminalOpener {
  readonly kind = "os" as const;
  private opts: OsTerminalOptions;
  private which: (command: string) => string | null;
  private spawnDetached: NonNullable<OsTerminalOptions["spawnDetached"]>;

  constructor(opts: OsTerminalOptions) {
    this.opts = opts;
    this.which = opts.which ?? ((c) => Bun.which(c));
    this.spawnDetached = opts.spawnDetached ?? detach;
  }

  /** The terminal program to run a script with, where one has to be named. */
  private linuxTerminal(): { command: string; args: (script: string) => string[] } | undefined {
    const named = this.opts.env?.["TERMINAL"];
    const list = named ? [{ command: named, args: (s: string) => ["-e", "/bin/sh", s] }, ...LINUX_TERMINALS] : LINUX_TERMINALS;
    return list.find((t) => this.which(t.command) !== null);
  }

  async available(): Promise<boolean> {
    if (this.opts.platform === "win32") return true;
    if (this.opts.platform === "darwin") return this.which("open") !== null;
    // A terminal needs a display to open on.
    if (!this.opts.env?.["DISPLAY"] && !this.opts.env?.["WAYLAND_DISPLAY"]) return false;
    return this.linuxTerminal() !== undefined;
  }

  /** Writes the launch script for one session and returns its path. */
  private writeScript(req: TerminalRequest, suffix: string): string {
    const dir = join(this.opts.dataDir, "launch");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
    writeFileSync(path, launchScript(req), "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  async open(req: TerminalRequest): Promise<void> {
    if (this.opts.platform === "win32") {
      // `start` is what gives the TUI a console it can draw in; the command line is built
      // whole because `cmd` would read the C runtime's quoting as syntax of its own.
      const env: Record<string, string | undefined> = { ...this.opts.env, ...req.env };
      for (const k of req.unset ?? []) for (const name of Object.keys(env)) if (name.toUpperCase() === k.toUpperCase()) delete env[name];
      this.spawnDetached("cmd.exe", [windowsCommandLine(req)], { cwd: req.cwd, env, verbatim: true });
      return;
    }
    if (this.opts.platform === "darwin") {
      // A `.command` file is what Terminal opens and runs; `open` puts it in a window.
      const script = this.writeScript(req, ".command");
      this.spawnDetached("open", ["-a", "Terminal", script], {});
      return;
    }
    const terminal = this.linuxTerminal();
    if (!terminal) throw new Error("no terminal program found");
    const script = this.writeScript(req, ".sh");
    this.spawnDetached(terminal.command, terminal.args(script), {});
  }
}

/** The first opener that can open one now; `undefined` when none can. */
export async function pickOpener(openers: readonly TerminalOpener[]): Promise<TerminalOpener | undefined> {
  for (const opener of openers) {
    try {
      if (await opener.available()) return opener;
    } catch {
      // An opener that cannot say is one that cannot open.
    }
  }
  return undefined;
}
