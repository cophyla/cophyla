// What the chat's own session is started with on Claude Code: the real CLI, signed in as the
// user is, with a command line that makes it the chat and nothing of the user's own setup.
// `--setting-sources project,local` leaves out the user's settings, memory file, skills and
// plugins (the folder it runs in is cophylad's own, so there is no project's either), and
// `--strict-mcp-config` every MCP server but the one named here; `--tools` keeps the
// harness's read and web tools and no other; `--permission-mode dontAsk` with allow rules
// runs those and Cophyla's with no prompt, and refuses anything else unasked.
//
// Three files under `<data>/assistant/` say the rest: `system.md`, the brain's rules,
// appended to the harness's own prompt; `mcp.json`, the `cophyla` server (the daemon's
// runtime running `mcp-main.ts`, with the port and the token of this spawn); and
// `settings.json`, the hooks and the allow rules. The hooks are cophylad's own, as it installs
// them for any session, with two differences. A session's start cannot be an http hook, so
// it goes through the command shim. And what one hook may hand the model is capped, so the
// start and the prompt each have several: the first is the hook itself, the rest
// (`/hooks/assistant-part-N`) only carry the further parts of what it is told.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantConfig } from "../config/schema.ts";
import { withCophyladHooks } from "../sessions/claude/hooks.ts";
import { shimCommand, writeHookJson, writeShim } from "../sessions/shim.ts";
import { MAX_PARTS } from "./context.ts";

/** The MCP server's name: its tools are `mcp__cophyla__<tool>` to the model. */
export const MCP_SERVER = "cophyla";
/** The name the session shows in its prompt box and its terminal's title. */
export const SESSION_NAME = "Cophyla";
/** The longest a tool call of the session's may take, over the harness's own shorter default. */
const MCP_TOOL_TIMEOUT_MS = 300_000;
/** A hook's answer is waited for this long: the brain is asked with a shorter one. */
const HOOK_TIMEOUT_S = 15;
/** What a hook that only carries a further part is posted under, before the part's number: `/hooks/assistant-part-1`. No character a shell would read. */
export const PART_HOOK = "assistant-part-";

export interface ClaudeFiles {
  dir: string;
  /** The folder the session runs in: cophylad's own, so a clear resolves to this session alone. */
  cwd: string;
  system: string;
  mcp: string;
  settings: string;
}

export function claudeFiles(dataDir: string): ClaudeFiles {
  const dir = join(dataDir, "assistant");
  return { dir, cwd: join(dir, "work"), system: join(dir, "system.md"), mcp: join(dir, "mcp.json"), settings: join(dir, "settings.json") };
}

export interface ClaudeSetup {
  dataDir: string;
  /** The brain's rules for the session. */
  system: string;
  /** The api's loopback port, which the hooks and the MCP server call. */
  port: number;
  hookToken: string;
  /** This spawn's token for the `/mcp` endpoints. */
  mcpToken: string;
  profileId: string;
  /** How the profile's hooks reach cophylad: http, or the command shim where http is forbidden. */
  hooksMode: "http" | "command";
  /** The harness's own tools the session keeps. */
  tools: readonly string[];
  /** The MCP server's entry point; `mcp-main.ts` beside this file unless a test names another. */
  entry?: string;
}

/** The session's settings: cophylad's hooks, the start and the prompt in parts, and the tools it may use unasked. */
export function claudeSettings(s: Pick<ClaudeSetup, "port" | "hookToken" | "profileId" | "hooksMode" | "tools"> & { shimPath: string }): Record<string, unknown> {
  const url = `http://127.0.0.1:${s.port}/hooks/claude`;
  const command = (harness: string) => ({ type: "command", command: shimCommand(s.shimPath, harness as never, s.profileId), timeout: HOOK_TIMEOUT_S });
  const http = (path: string) => ({ type: "http", url: `http://127.0.0.1:${s.port}${path}`, timeout: HOOK_TIMEOUT_S, headers: { Authorization: `Bearer ${s.hookToken}`, "x-cophylad": "1", "x-cophyla-profile": s.profileId } });
  const settings = withCophyladHooks({}, { mode: s.hooksMode, url, token: s.hookToken, timeoutS: HOOK_TIMEOUT_S, profileId: s.profileId, command: shimCommand(s.shimPath, "claude", s.profileId) });
  const hooks = settings["hooks"] as Record<string, { matcher: string; hooks: unknown[] }[]>;
  const further = Array.from({ length: MAX_PARTS - 1 }, (_, i) => i + 1);
  // A session's start is never an http hook: the shim carries it, and each further part of what it is told.
  hooks["SessionStart"] = [{ matcher: "", hooks: [command("claude"), ...further.map((n) => command(`${PART_HOOK}${n}`))] }];
  hooks["UserPromptSubmit"] = [{ matcher: "", hooks: [...hooks["UserPromptSubmit"]![0]!.hooks, ...further.map((n) => (s.hooksMode === "command" ? command(`${PART_HOOK}${n}`) : http(`/hooks/${PART_HOOK}${n}`)))] }];
  return { ...settings, permissions: { allow: [`mcp__${MCP_SERVER}`, ...s.tools] } };
}

/** Writes what the session is started with; the paths it wrote. */
export function writeClaudeSetup(s: ClaudeSetup): ClaudeFiles {
  const f = claudeFiles(s.dataDir);
  mkdirSync(f.cwd, { recursive: true });
  // The shim and where it finds the daemon are the daemon's own, written at its start: written again here for a test that has neither.
  const shimPath = writeShim(s.dataDir);
  writeHookJson(s.dataDir, { port: s.port, token: s.hookToken });
  writeFileSync(f.system, s.system.endsWith("\n") ? s.system : `${s.system}\n`, "utf8");
  const entry = s.entry ?? join(import.meta.dir, "mcp-main.ts");
  const mcp = { mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [entry], env: { COPHYLA_MCP_PORT: String(s.port), COPHYLA_MCP_TOKEN: s.mcpToken } } } };
  writeFileSync(f.mcp, JSON.stringify(mcp, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  // A file kept from an earlier spawn keeps its mode: the token in it is this spawn's now.
  try {
    chmodSync(f.mcp, 0o600);
  } catch {
    // a filesystem with no modes
  }
  writeFileSync(f.settings, JSON.stringify(claudeSettings({ ...s, shimPath }), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return f;
}

/** The command line after the program and the session's id: who it is, what it may use, and where its files are. */
export function claudeArgs(config: Pick<AssistantConfig, "claude_model" | "claude_effort" | "autocompact_tokens" | "tools">, f: ClaudeFiles): string[] {
  return [
    "--name",
    SESSION_NAME,
    "--model",
    config.claude_model,
    "--effort",
    config.claude_effort,
    "--autocompact",
    `${Math.round(config.autocompact_tokens / 1000)}k`,
    "--tools",
    config.tools.join(","),
    "--strict-mcp-config",
    "--mcp-config",
    f.mcp,
    "--append-system-prompt-file",
    f.system,
    "--setting-sources",
    "project,local",
    "--settings",
    f.settings,
    "--permission-mode",
    "dontAsk",
    // The rules are read afresh at every start: a brain updated since brings its own.
    "--system-prompt-snapshot",
    "off",
  ];
}

/** What the session's environment adds to the profile's. */
export function claudeEnvExtra(): Record<string, string> {
  return { MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) };
}
