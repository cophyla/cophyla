// Starting a Codex session in a tether terminal, as the user starts one: the CLI under the
// profile, its first prompt the CLI's own argument after `--`, so a word like `resume` is never
// read as a subcommand. Codex holds that prompt through its first screens (a folder's trust,
// the sandbox's setup) and submits it once its composer is up, which makes the thread and
// fires its first hook. tether hands a native binary its arguments as they are; a batch file
// runs under `cmd`, which would read the prompt's `&`, `|`, `%` and quotes, so there the
// prompt is typed instead, once the composer shows (`screen.ts`).

import { homedir } from "node:os";
import { join } from "node:path";
import { pathKey } from "../paths.ts";

/** What bypass permissions is to Codex: no approval asked, no sandbox. */
export const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";

/** Whether a directory is Codex's own, `~/.codex`: the one it uses when CODEX_HOME is unset. */
export function isCodexHome(configDir: string, home = homedir()): boolean {
  return pathKey(configDir) === pathKey(join(home, ".codex"));
}

/**
 * The profile's directory as the CLI is told it: `~/.codex` by leaving CODEX_HOME unset, as a
 * shell of the user's does, and an inherited one taken out; another by naming it.
 */
export function codexEnv(configDir: string, home?: string): { set: Record<string, string>; unset: string[] } {
  return isCodexHome(configDir, home) ? { set: {}, unset: ["CODEX_HOME"] } : { set: { CODEX_HOME: configDir }, unset: [] };
}

/** Whether tether would run the command under `cmd`, which re-reads its arguments. */
export function runsUnderCmd(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export interface CodexStart {
  /** The `codex` binary: the profile's own, or the one on PATH. */
  command: string;
  /** The profile's own arguments, before cophylad's. */
  args?: readonly string[];
  model?: string;
  bypass?: boolean;
  /** The first prompt; left off when it is to be typed. */
  prompt?: string;
}

export function codexArgv(start: CodexStart): string[] {
  return [start.command, ...(start.args ?? []), ...(start.model ? ["--model", start.model] : []), ...(start.bypass ? [CODEX_BYPASS] : []), ...(start.prompt !== undefined ? ["--", start.prompt] : [])];
}
