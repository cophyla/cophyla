// What the chat's own session is started with on Claude Code: a command line that makes the
// CLI the chat and nothing of the user's own setup (its model and effort, the read and web
// tools alone, one MCP server and no other, no user settings, nothing asked), and the three
// files under `<data>/assistant/` it names: the brain's rules, the `cophyla` MCP server with
// the port and the token of this spawn, and the settings. In the settings a session's start is
// always a command hook, with one more per further part of what it is told; a prompt keeps
// cophylad's own hook and gets the further parts as http hooks, or command ones where the
// profile forbids http; and the tools the session keeps run unasked beside Cophyla's.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, claudeEnvExtra, claudeFiles, claudeSettings, MCP_SERVER, PART_HOOK, writeClaudeSetup } from "../src/assistant/claude.ts";
import { MAX_PARTS } from "../src/assistant/context.ts";
import { AssistantConfig } from "../src/config/schema.ts";
import { CLAUDE_HOOK_EVENTS } from "../src/sessions/claude/hooks.ts";
import { HOOK_JSON_FILENAME, shellPath, shimCommand, SHIM_FILENAME } from "../src/sessions/shim.ts";

const PROFILE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
const SHIM = "/home/me/.local/share/cophyla/data/cophylad-hook-shim.mjs";
const config = AssistantConfig.parse({});

interface Handler {
  type: string;
  command?: string;
  url?: string;
  timeout?: number;
  headers?: Record<string, string>;
}
type Hooks = Record<string, { matcher: string; hooks: Handler[] }[]>;

const scratch: string[] = [];
function tempData(): string {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-assistant-claude-"));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The value that follows a flag on a command line. */
function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

describe("the command line", () => {
  const files = claudeFiles(join("data", "home"));

  test("the files are under <data>/assistant, and the folder it runs in is cophylad's own", () => {
    const dir = join("data", "home", "assistant");
    expect(files).toEqual({ dir, cwd: join(dir, "work"), system: join(dir, "system.md"), mcp: join(dir, "mcp.json"), settings: join(dir, "settings.json") });
  });

  test("it is the chat on the configured model and effort, compacting at the configured size", () => {
    const args = claudeArgs(config, files);
    expect(flag(args, "--name")).toBe("Cophyla");
    expect(flag(args, "--model")).toBe("sonnet");
    expect(flag(args, "--effort")).toBe("low");
    expect(flag(args, "--autocompact")).toBe("300k");
    const other = claudeArgs({ ...config, claude_model: "opus[1m]", claude_effort: "high", autocompact_tokens: 180_000 }, files);
    expect(flag(other, "--model")).toBe("opus[1m]");
    expect(flag(other, "--effort")).toBe("high");
    expect(flag(other, "--autocompact")).toBe("180k");
  });

  test("it keeps the read and web tools alone, one MCP server and no other, and none of the user's own settings", () => {
    const args = claudeArgs(config, files);
    expect(flag(args, "--tools")).toBe("Read,Grep,Glob,WebSearch,WebFetch");
    expect(args).toContain("--strict-mcp-config");
    expect(flag(args, "--mcp-config")).toBe(files.mcp);
    expect(flag(args, "--setting-sources")).toBe("project,local");
    expect(flag(args, "--settings")).toBe(files.settings);
    expect(flag(claudeArgs({ ...config, tools: ["Read"] }, files), "--tools")).toBe("Read");
  });

  test("it asks nothing, and reads the brain's rules afresh at every start", () => {
    const args = claudeArgs(config, files);
    expect(flag(args, "--permission-mode")).toBe("dontAsk");
    expect(flag(args, "--append-system-prompt-file")).toBe(files.system);
    expect(flag(args, "--system-prompt-snapshot")).toBe("off");
    // nothing that would skip the permission system, or name a session: the sessions module does that
    expect(args.some((a) => /skip-permissions|bypass/i.test(a))).toBe(false);
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  test("a tool call may take as long as cophylad lets one run", () => {
    expect(claudeEnvExtra()).toEqual({ MCP_TOOL_TIMEOUT: "300000" });
  });
});

describe("the settings", () => {
  const base = { port: 4817, hookToken: "hook-secret", profileId: PROFILE, tools: config.tools, shimPath: SHIM };
  const further = Array.from({ length: MAX_PARTS - 1 }, (_, i) => i + 1);

  test("a session's start is a command hook, never http, with one more for each further part", () => {
    for (const hooksMode of ["http", "command"] as const) {
      const hooks = claudeSettings({ ...base, hooksMode })["hooks"] as Hooks;
      expect(hooks["SessionStart"]).toHaveLength(1);
      const start = hooks["SessionStart"]![0]!;
      expect(start.matcher).toBe("");
      expect(start.hooks.map((h) => h.type)).toEqual(Array(MAX_PARTS).fill("command"));
      expect(start.hooks.map((h) => h.command)).toEqual([shimCommand(SHIM, "claude", PROFILE), ...further.map((n) => `${shellPath(process.execPath)} ${shellPath(SHIM)} ${PART_HOOK}${n} ${PROFILE}`)]);
      expect(start.hooks.every((h) => h.url === undefined)).toBe(true);
    }
  });

  test("a prompt keeps cophylad's own hook and gets each further part from /hooks/assistant-part-N, behind the hook token", () => {
    const hooks = claudeSettings({ ...base, hooksMode: "http" })["hooks"] as Hooks;
    expect(hooks["UserPromptSubmit"]).toHaveLength(1);
    const [own, ...rest] = hooks["UserPromptSubmit"]![0]!.hooks;
    const headers = { Authorization: "Bearer hook-secret", "x-cophylad": "1", "x-cophyla-profile": PROFILE };
    expect(own).toEqual({ type: "http", url: "http://127.0.0.1:4817/hooks/claude", timeout: 15, headers });
    expect(rest).toEqual(further.map((n) => ({ type: "http", url: `http://127.0.0.1:4817/hooks/assistant-part-${n}`, timeout: 15, headers })));
  });

  test("where the profile forbids http hooks, a prompt's hooks are all the command shim", () => {
    const hooks = claudeSettings({ ...base, hooksMode: "command" })["hooks"] as Hooks;
    const all = hooks["UserPromptSubmit"]![0]!.hooks;
    expect(all.map((h) => h.type)).toEqual(Array(MAX_PARTS).fill("command"));
    expect(all.map((h) => h.command)).toEqual([shimCommand(SHIM, "claude", PROFILE), ...further.map((n) => `${shellPath(process.execPath)} ${shellPath(SHIM)} ${PART_HOOK}${n} ${PROFILE}`)]);
    expect(JSON.stringify(hooks)).not.toContain("http://");
  });

  test("every other event has cophylad's one hook, as any session's settings do", () => {
    for (const hooksMode of ["http", "command"] as const) {
      const hooks = claudeSettings({ ...base, hooksMode })["hooks"] as Hooks;
      expect(Object.keys(hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
      for (const event of CLAUDE_HOOK_EVENTS) {
        if (event === "SessionStart" || event === "UserPromptSubmit") continue;
        expect(hooks[event]).toHaveLength(1);
        expect(hooks[event]![0]!.hooks).toHaveLength(1);
        const h = hooks[event]![0]!.hooks[0]!;
        if (hooksMode === "http") expect(h.url).toBe("http://127.0.0.1:4817/hooks/claude");
        else expect(h.command).toBe(shimCommand(SHIM, "claude", PROFILE));
      }
    }
  });

  test("Cophyla's tools and the harness's own it keeps run unasked, and nothing else is allowed", () => {
    expect(claudeSettings({ ...base, hooksMode: "http" })["permissions"]).toEqual({ allow: [`mcp__${MCP_SERVER}`, "Read", "Grep", "Glob", "WebSearch", "WebFetch"] });
    expect(claudeSettings({ ...base, hooksMode: "http", tools: [] })["permissions"]).toEqual({ allow: ["mcp__cophyla"] });
  });
});

describe("the files written", () => {
  test("the rules, the MCP server with this spawn's port and token, and the settings, in a folder made for it", () => {
    const dataDir = tempData();
    const f = writeClaudeSetup({ dataDir, system: "You are Cophyla.", port: 4817, hookToken: "hook-secret", mcpToken: "spawn-token", profileId: PROFILE, hooksMode: "http", tools: config.tools });
    expect(f).toEqual(claudeFiles(dataDir));
    expect(statSync(f.cwd).isDirectory()).toBe(true);
    expect(readFileSync(f.system, "utf8")).toBe("You are Cophyla.\n");
    const mcp = JSON.parse(readFileSync(f.mcp, "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(["cophyla"]);
    const server = mcp.mcpServers["cophyla"]!;
    // the daemon's own runtime runs the server, which is a file of cophylad's
    expect(server.command).toBe(process.execPath);
    expect(server.args).toHaveLength(1);
    expect(server.args[0]!.replace(/\\/g, "/")).toEndWith("src/assistant/mcp-main.ts");
    expect(existsSync(server.args[0]!)).toBe(true);
    expect(server.env).toEqual({ COPHYLA_MCP_PORT: "4817", COPHYLA_MCP_TOKEN: "spawn-token" });
    // the settings are what `claudeSettings` says, for the shim written beside them
    const shimPath = join(dataDir, SHIM_FILENAME);
    expect(existsSync(shimPath)).toBe(true);
    expect(JSON.parse(readFileSync(f.settings, "utf8"))).toEqual(claudeSettings({ port: 4817, hookToken: "hook-secret", profileId: PROFILE, hooksMode: "http", tools: config.tools, shimPath }));
    // and the shim finds the daemon
    expect(JSON.parse(readFileSync(join(dataDir, HOOK_JSON_FILENAME), "utf8"))).toEqual({ port: 4817, token: "hook-secret" });
  });

  test("a second spawn writes its own token and rules over the first's; a test may name another server entry", () => {
    const dataDir = tempData();
    writeClaudeSetup({ dataDir, system: "one\n", port: 4817, hookToken: "h", mcpToken: "first", profileId: PROFILE, hooksMode: "http", tools: ["Read"] });
    const f = writeClaudeSetup({ dataDir, system: "two\n", port: 5001, hookToken: "h", mcpToken: "second", profileId: PROFILE, hooksMode: "command", tools: ["Read"], entry: "/elsewhere/mcp.ts" });
    // rules that end a line already get no second end
    expect(readFileSync(f.system, "utf8")).toBe("two\n");
    const text = readFileSync(f.mcp, "utf8");
    expect(text).not.toContain("first");
    const server = (JSON.parse(text) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> }).mcpServers["cophyla"]!;
    expect(server.env).toEqual({ COPHYLA_MCP_PORT: "5001", COPHYLA_MCP_TOKEN: "second" });
    expect(server.args).toEqual(["/elsewhere/mcp.ts"]);
    const settings = JSON.parse(readFileSync(f.settings, "utf8")) as { hooks: Hooks; permissions: unknown };
    expect(settings.hooks["UserPromptSubmit"]![0]!.hooks.every((h) => h.type === "command")).toBe(true);
    expect(settings.permissions).toEqual({ allow: ["mcp__cophyla", "Read"] });
  });
});
