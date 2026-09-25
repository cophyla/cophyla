// What a Claude session cophylad starts is started with, beyond what makes it cophylad's: a mode and
// the other flags. They come, first found, from what the user set in the app, `[[profiles]].args`
// in config, or the flags of the user's own last session under the profile, which cophylad reads
// off that process's command line once when it registers ("mirrored"). A mirror keeps only the
// flags that shape how a session works — permissions, settings, model, effort, directories,
// MCP servers, plugins, the system prompt's additions, the agent, the setting sources — never
// the ones that say which conversation it is (`--resume`, `--continue`, `--session-id`,
// `--name`) or what it is asked (`-p`, a prompt). Pure, but for `readSettingsValue`.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { LaunchMode } from "@cophyla/protocol";
import { permissionModeOf } from "./launch.ts";

/** How many values a flag takes: none, one, or every word up to the next flag. */
type Arity = "none" | "one" | "many";

/** The flags a mirror keeps, with their arity. */
export const MIRRORED: Readonly<Record<string, Arity>> = {
  "--dangerously-skip-permissions": "none",
  "--allow-dangerously-skip-permissions": "none",
  "--permission-mode": "one",
  "--settings": "one",
  "--model": "one",
  "--effort": "one",
  "--add-dir": "many",
  "--mcp-config": "many",
  "--strict-mcp-config": "none",
  "--plugin-dir": "one",
  "--append-system-prompt": "one",
  "--append-system-prompt-file": "one",
  "--agent": "one",
  "--setting-sources": "one",
};

/** Flags whose values are paths, made absolute against the session's directory when mirrored. */
const PATH_FLAGS = new Set(["--settings", "--add-dir", "--mcp-config", "--plugin-dir", "--append-system-prompt-file"]);

/**
 * Flags a launch may not carry: cophylad names the session and hands it its task, and a launch
 * that resumed, continued or printed would not be the session cophylad started.
 */
export const REFUSED = new Set(["--session-id", "--name", "-n", "--resume", "-r", "--continue", "-c", "--fork-session", "--print", "-p", "--output-format", "--input-format", "--from-pr"]);

/** The other flags that take a value, so a value is never read as a flag of its own. */
const VALUED: Readonly<Record<string, Arity>> = {
  ...MIRRORED,
  "--session-id": "one",
  "--name": "one",
  "-n": "one",
  "--output-format": "one",
  "--input-format": "one",
  "--allowedTools": "many",
  "--allowed-tools": "many",
  "--disallowedTools": "many",
  "--disallowed-tools": "many",
  "--tools": "many",
  "--fallback-model": "one",
  "--system-prompt": "one",
  "--system-prompt-file": "one",
  "--agents": "one",
  "--betas": "many",
  "--debug-file": "one",
  "--max-budget-usd": "one",
  "--json-schema": "one",
};

/** A flag and its values, as one command line has them: `["--add-dir", "a", "b"]`, or `["--model=opus"]`. */
export type FlagGroup = string[];

function arityOf(flag: string): Arity | undefined {
  return VALUED[flag];
}

/**
 * A command line's words after the program, grouped by flag. A known flag takes its own
 * number of values; an unknown one takes the words up to the next flag. Words before the
 * first flag, or after a flag that takes none, stand alone as positional groups.
 */
export function flagGroups(args: readonly string[]): FlagGroup[] {
  const out: FlagGroup[] = [];
  let i = 0;
  while (i < args.length) {
    const word = args[i]!;
    if (!word.startsWith("-") || word === "-" || word === "--") {
      out.push([word]);
      i++;
      continue;
    }
    const eq = word.startsWith("--") ? word.indexOf("=") : -1;
    if (eq > 0) {
      out.push([word]);
      i++;
      continue;
    }
    const arity = arityOf(word);
    const group = [word];
    i++;
    if (arity === "one") {
      if (i < args.length) group.push(args[i++]!);
    } else if (arity === "many" || arity === undefined) {
      while (i < args.length && !args[i]!.startsWith("-")) group.push(args[i++]!);
    }
    out.push(group);
  }
  return out;
}

/** A group's flag, without an `=value`. */
export function flagName(group: FlagGroup): string {
  const word = group[0]!;
  const eq = word.startsWith("--") ? word.indexOf("=") : -1;
  return eq > 0 ? word.slice(0, eq) : word;
}

/** A group's values: an `=value`, or the words after the flag. */
export function flagValues(group: FlagGroup): string[] {
  const word = group[0]!;
  const eq = word.startsWith("--") ? word.indexOf("=") : -1;
  return eq > 0 ? [word.slice(eq + 1)] : group.slice(1);
}

export interface Launch {
  mode?: LaunchMode;
  /** The flags beyond the mode, in order. */
  args: string[];
}

/** The mode flags taken out of a launch's flags: `--dangerously-skip-permissions` wins over `--permission-mode`. */
export function splitMode(args: readonly string[]): Launch {
  let mode: LaunchMode | undefined;
  let bypass = false;
  const rest: string[] = [];
  for (const group of flagGroups(args)) {
    const name = flagName(group);
    if (name === "--dangerously-skip-permissions") bypass = true;
    else if (name === "--permission-mode") {
      const m = permissionModeOf(flagValues(group)[0]);
      if (m) mode = m;
    } else rest.push(...group);
  }
  if (bypass) mode = "bypassPermissions";
  return { ...(mode ? { mode } : {}), args: rest };
}

/** The flags that put a session in a mode. */
export function modeFlags(mode: LaunchMode | undefined): string[] {
  if (!mode) return [];
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode];
}

/**
 * What a mirror keeps of a session's command line (the program first): the allow-listed
 * flags, paths made absolute against its directory, the mode apart. `undefined` for a command
 * line cophylad built — one whose `--settings` is cophylad's own file, as its Windows Terminal
 * entry's is — which holds the user's launch folded away, not as they typed it.
 */
export function mirrorArgs(argv: readonly string[], cwd: string, cophyladDir?: string): Launch | undefined {
  const kept: string[] = [];
  for (const group of flagGroups(argv.slice(1))) {
    const name = flagName(group);
    if (!(name in MIRRORED)) continue;
    let values = flagValues(group);
    if (PATH_FLAGS.has(name)) values = values.map((v) => (v.trim().startsWith("{") ? v : resolve(cwd, v)));
    if (name === "--settings" && cophyladDir !== undefined && values[0] !== undefined && isWithinDir(values[0], cophyladDir)) return undefined;
    kept.push(name, ...values);
  }
  return splitMode(kept);
}

function isWithinDir(path: string, dir: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  const p = norm(path);
  const d = norm(dir);
  return p === d || p.startsWith(d + "/") || p.startsWith(d + "\\");
}

/** Why a launch the user set cannot be used, or `undefined` when it can. */
export function launchProblem(args: readonly string[]): string | undefined {
  const groups = flagGroups(args);
  const loose = groups.find((g) => !g[0]!.startsWith("-") || g[0] === "-" || g[0] === "--");
  if (loose) return `"${loose[0]}" is not a flag`;
  const refused = groups.find((g) => REFUSED.has(flagName(g)));
  if (refused) return `${flagName(refused)} is cophylad's to set`;
  return undefined;
}

/**
 * The launch's flags as the command line gets them: the mode's flags, then the rest, less a
 * `--settings` (cophylad merges its content into its own settings file, so one is passed) and,
 * when the brain names a model, less the launch's own `--model`. `settings` is the value that
 * was taken out.
 */
export function launchFlags(launch: Launch | undefined, opts: { model?: string } = {}): { args: string[]; settings?: string } {
  if (!launch) return { args: [] };
  const args = [...modeFlags(launch.mode)];
  let settings: string | undefined;
  for (const group of flagGroups(launch.args)) {
    const name = flagName(group);
    if (name === "--settings") {
      settings = flagValues(group)[0];
      continue;
    }
    if (name === "--model" && opts.model) continue;
    args.push(...group);
  }
  return { args, ...(settings !== undefined ? { settings } : {}) };
}

/**
 * The settings a `--settings` value holds: inline JSON, or a file resolved against `cwd` as
 * the CLI resolves it. `undefined` when it cannot be read or is not an object.
 */
export function readSettingsValue(value: string, cwd: string): Record<string, unknown> | undefined {
  const s = value.trim();
  let text: string;
  if (s.startsWith("{")) text = s;
  else {
    try {
      text = readFileSync(isAbsolute(s) ? s : join(cwd, s), "utf8");
    } catch {
      return undefined;
    }
  }
  try {
    const doc = JSON.parse(text) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
