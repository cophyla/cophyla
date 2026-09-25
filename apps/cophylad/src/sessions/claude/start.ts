// Starting a Claude Code session in a terminal of its own, rather than as a child speaking
// ACP over a pipe. Two things shape this module. The session id is decided here rather than
// read back afterwards, so the daemon can recognise the session the moment it writes its
// registry entry: `--session-id` takes a UUID and the CLI keeps it. And nothing cophylad writes
// itself reaches the command line but a fixed alphabet, because a terminal program's
// arguments are parsed twice — once by the terminal (`wt.exe` reads `;` as a tab separator, a
// shell reads quotes) and once by the CLI. The prompt, which is arbitrary prose, never goes
// there: it is typed, or sent over the messaging pipe, once the session registers. The
// profile's launch flags do go there, as the user starts their own sessions with them
// (`launch-args.ts`), and its `--settings` is folded into cophylad's own file, so one is passed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathKey } from "../paths.ts";
import { launchFlags, readSettingsValue } from "./launch-args.ts";
import type { Launch } from "./launch-args.ts";

/** The characters a session name may carry onto a command line: no quote, no separator, no control. */
const NAME_SAFE = /[^A-Za-z0-9 _.,\-()[\]]/g;
/** Claude shows the name in the prompt box, the `/resume` picker and the terminal title. */
const NAME_MAX = 60;

/**
 * A session name from what the agent was asked to do: one line, a safe alphabet, short
 * enough to read in a tab title. Empty when nothing survives, and the flag is then left off
 * rather than passed empty.
 */
export function sessionName(intent: string): string {
  return intent.replace(/\s+/g, " ").replace(NAME_SAFE, "").trim().slice(0, NAME_MAX).trim();
}

/** A fresh session id for `--session-id`; the CLI takes a UUID and nothing else. */
export function newSessionId(): string {
  return crypto.randomUUID();
}

export interface ClaudeStart {
  /** The `claude` binary: the profile's own, or the one on PATH. */
  command: string;
  sessionId: string;
  /** What the agent was asked to do, for the prompt box and the tab title. */
  name?: string;
  /** What the profile's sessions start with: a mode and other flags. A `--settings` among them is `cophyladSettings`'s. */
  launch?: Launch;
  /** The model the brain asked for, over the launch's own. */
  model?: string;
}

/**
 * The command line a fresh session starts with, the program first, before cophylad's
 * `--settings`. No prompt: a session started with one is busy before its registry entry is
 * written, and the text would have to survive the terminal's parser.
 */
export function claudeArgv(start: ClaudeStart): string[] {
  const argv = [start.command, "--session-id", start.sessionId];
  const name = start.name ? sessionName(start.name) : "";
  if (name) argv.push("--name", name);
  argv.push(...launchFlags(start.launch, start.model ? { model: start.model } : {}).args);
  if (start.model) argv.push("--model", start.model);
  return argv;
}

/**
 * cophylad's own settings file, the one `--settings` a session cophylad starts is passed: it shows
 * the plan dialog's "Yes, clear context" row, which cophylad presses when that is the answer, on
 * top of what the launch's own `--settings` held (a file, resolved against `cwd`, or inline
 * JSON), so the CLI reads one. A profile's sessions get a file of their own, since their
 * launches differ; without one it is the file cophylad's other entry points share. Written when
 * its content differs; its path.
 */
export function cophyladSettings(dataDir: string, profile?: string, launch?: { settings: string; cwd: string }): string {
  const dir = join(dataDir, "claude");
  const path = join(dir, profile ? `settings-${profile}.json` : "cophylad-settings.json");
  const own = launch ? readSettingsValue(launch.settings, launch.cwd) : undefined;
  const content = JSON.stringify({ ...own, showClearContextOnPlanAccept: true }, null, 2) + "\n";
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Not written yet.
  }
  if (current !== content) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return path;
}

/** Whether a directory is Claude's own, `~/.claude`: the one it uses when CLAUDE_CONFIG_DIR is unset. */
export function isClaudeHome(configDir: string, home = homedir()): boolean {
  return pathKey(configDir) === pathKey(join(home, ".claude"));
}

/**
 * The environment a session needs beyond the terminal's own: the profile it belongs to.
 * Claude's own directory is named by leaving CLAUDE_CONFIG_DIR unset, and an inherited one is
 * taken out (`unset`): set, even to `~/.claude`, Claude keeps its global config in
 * `~/.claude/.claude.json` rather than `~/.claude.json`, finds it never onboarded, and greets
 * the session with its login screen.
 */
export function claudeEnv(configDir: string, home?: string): { set: Record<string, string>; unset: string[] } {
  return isClaudeHome(configDir, home) ? { set: {}, unset: ["CLAUDE_CONFIG_DIR"] } : { set: { CLAUDE_CONFIG_DIR: configDir }, unset: [] };
}
