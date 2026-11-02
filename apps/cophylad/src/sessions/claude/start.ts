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
import { dirname, join } from "node:path";
import { pathKey } from "../paths.ts";
import { launchFlags, readSettingsValue, withoutUserScope } from "./launch-args.ts";
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
  /** Goes on with the conversation `sessionId` names (`--resume`), which keeps its id and its name. */
  resume?: boolean;
  /** Leaves the profile's user scope out (`--setting-sources` less `user`), as a session with no status line runs. */
  noUserScope?: boolean;
}

/**
 * The command line a fresh session starts with, the program first, before cophylad's
 * `--settings`, or one that resumes a conversation under its own id. No prompt: a session
 * started with one is busy before its registry entry is written, and the text would have to
 * survive the terminal's parser.
 */
export function claudeArgv(start: ClaudeStart): string[] {
  const argv = [start.command, start.resume ? "--resume" : "--session-id", start.sessionId];
  const name = start.name && !start.resume ? sessionName(start.name) : "";
  if (name) argv.push("--name", name);
  const flags = launchFlags(start.launch, start.model ? { model: start.model } : {}).args;
  argv.push(...(start.noUserScope ? withoutUserScope(flags) : flags));
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
 *
 * `userSettings`, the profile's own `settings.json`, is for a session that leaves the user scope
 * out so as to run no status line: Claude has no switch for the status line alone, and every run
 * of one starts a shell. That file goes in first and the launch's over it, merged as Claude
 * merges its sources, so the session keeps cophylad's hooks and the rest of the user's settings;
 * the status lines come out.
 */
export function cophyladSettings(dataDir: string, profile?: string, launch?: { settings: string; cwd: string }, userSettings?: string): string {
  const path = join(dataDir, "claude", profile ? `settings-${profile}.json` : "cophylad-settings.json");
  let own = launch ? readSettingsValue(launch.settings, launch.cwd) : undefined;
  if (userSettings !== undefined) {
    own = mergeSettings(readSettingsValue(userSettings, dataDir) ?? {}, own ?? {});
    delete own["statusLine"];
    delete own["subagentStatusLine"];
  }
  writeWhenChanged(path, JSON.stringify({ ...own, showClearContextOnPlanAccept: true }, null, 2) + "\n");
  return path;
}

/**
 * The file `--mcp-config` names for a session that leaves the profile's user scope out: the
 * user-scope MCP servers in the profile's global config, cophyla-agents among them, which Claude
 * loads only with that scope. Written when its content differs; `undefined` when the global
 * config holds none or cannot be read.
 */
export function userMcpConfig(dataDir: string, profile: string, globalConfig: string): string | undefined {
  const doc = readSettingsValue(globalConfig, dataDir);
  const servers = doc?.["mcpServers"];
  if (!isObject(servers) || Object.keys(servers).length === 0) return undefined;
  const path = join(dataDir, "claude", `mcp-${profile}.json`);
  writeWhenChanged(path, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
  return path;
}

/** Two settings documents as Claude merges its sources: objects key by key, arrays joined without repeats, any other value the later one's. */
export function mergeSettings(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const was = out[key];
    if (isObject(was) && isObject(value)) out[key] = mergeSettings(was, value);
    else if (Array.isArray(was) && Array.isArray(value)) {
      const seen = new Set(was.map((v) => JSON.stringify(v)));
      out[key] = [...was, ...value.filter((v) => !seen.has(JSON.stringify(v)))];
    } else out[key] = value;
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function writeWhenChanged(path: string, content: string): void {
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Not written yet.
  }
  if (current !== content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
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
