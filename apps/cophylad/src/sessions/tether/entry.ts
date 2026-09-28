// The ways into tether for the user's own work. A running `claude` cannot move into a
// pseudo-terminal, so a session is typeable only if it started in one; plain `claude` is left
// alone, and these are opt-in entry points beside it. A Windows Terminal profile (a fragment
// tether writes; on a Mac with iTerm2, an iTerm2 dynamic profile) runs `tether run -- claude <launch> --settings <cophylad's file>`, so the session
// is the user's own, started as their sessions under Claude's own directory are, with the plan
// dialog's clear-context row on. The tether VS Code extension's
// "tether" terminal is the window's own shell in tether, and `<home>/editors/tether.json` tells
// it the tether command as cophylad runs it, so the shell lands on the host cophylad watches and a
// `claude` started in it is met in the terminal it runs below. Written at start and whenever
// what they run changes, and left as they are otherwise.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../log.ts";
import { homedir } from "node:os";
import { flagGroups, launchFlags } from "../claude/launch-args.ts";
import { isClaudeHome, cophyladSettings } from "../claude/start.ts";
import type { Profiles } from "../profiles.ts";
import type { Tether } from "./index.ts";

export const PROFILE_APP = "Cophyla";
export const PROFILE_NAME = "Claude (Cophyla)";

/** What the editor extension runs tether as: `<home>/editors/tether.json`. */
export interface EditorTether {
  /** The binary and its state folder; the extension adds `run -- <shell>`. */
  argv: string[];
}

export function writeEditorTether(editorsDir: string, tether: EditorTether): boolean {
  const path = join(editorsDir, "tether.json");
  const content = JSON.stringify(tether, null, 2) + "\n";
  try {
    if (readFileSync(path, "utf8") === content) return false;
  } catch {
    // Not written yet.
  }
  mkdirSync(editorsDir, { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

/** What a Windows Terminal profile's command line can hold: no flag whose value carries a double quote or a control character. */
function entrySafe(args: string[]): string[] {
  return flagGroups(args)
    .filter((g) => !g.some((w) => /["\x00-\x1f]/.test(w)))
    .flat();
}

export async function writeEntryPoints(opts: { tether: Tether; profiles: Profiles; dataDir: string; editorsDir: string; log: Logger }): Promise<void> {
  try {
    if (writeEditorTether(opts.editorsDir, { argv: opts.tether.commandArgv() })) opts.log.info("editor's tether command written", { dir: opts.editorsDir });
  } catch (e) {
    opts.log.warn("editor's tether command not written", { error: e instanceof Error ? e.message : String(e) });
  }
  // The profile runs under the terminal's own environment, which names no directory: Claude's own.
  const profile = opts.profiles.list().find((p) => p.harness === "claude" && isClaudeHome(p.configDir)) ?? opts.profiles.defaultFor("claude");
  const command = profile?.exec?.command ?? Bun.which("claude") ?? "claude";
  const { args, settings } = launchFlags(profile?.launch);
  const argv = [command, ...entrySafe(args), "--settings", cophyladSettings(opts.dataDir, undefined, settings !== undefined ? { settings, cwd: homedir() } : undefined)];
  try {
    const path = await opts.tether.installProfile({ app: PROFILE_APP, name: PROFILE_NAME, argv });
    if (path) opts.log.info("terminal profile in place", { path });
  } catch (e) {
    opts.log.warn("terminal profile not written", { error: e instanceof Error ? e.message : String(e) });
  }
}
