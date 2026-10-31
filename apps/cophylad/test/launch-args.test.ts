// A Claude profile's launch: which of the user's own flags a mirror keeps, how a launch is
// split into its mode and the rest, and cophylad's settings file with the launch's own folded in.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { flagGroups, launchFlags, launchProblem, mirrorArgs, splitMode, withoutUserScope } from "../src/sessions/claude/launch-args.ts";
import { claudeArgv, cophyladSettings, userMcpConfig } from "../src/sessions/claude/start.ts";

describe("mirroring the user's launch", () => {
  test("keeps the flags that shape a session, never the ones that say which conversation or what it is asked", () => {
    const argv = [
      "claude",
      "--resume", "4f1c",
      "--settings", "/home/me/.claude/settings.json",
      "--permission-mode", "auto",
      "--model", "opus",
      "--effort=high",
      "--add-dir", "/a", "/b",
      "--name", "x",
      "-p", "do it",
      "--mcp-config", "/m.json",
      "--strict-mcp-config",
      "--verbose",
      "--append-system-prompt", "be brief",
      "--agent", "reviewer",
      "--setting-sources", "user,project",
      "--plugin-dir", "/plugins",
      "--allow-dangerously-skip-permissions",
    ];
    expect(mirrorArgs(argv, "/work")).toEqual({
      mode: "auto",
      args: [
        "--settings", resolve("/work", "/home/me/.claude/settings.json"),
        "--model", "opus",
        "--effort", "high",
        "--add-dir", resolve("/work", "/a"), resolve("/work", "/b"),
        "--mcp-config", resolve("/work", "/m.json"),
        "--strict-mcp-config",
        "--append-system-prompt", "be brief",
        "--agent", "reviewer",
        "--setting-sources", "user,project",
        "--plugin-dir", resolve("/work", "/plugins"),
        "--allow-dangerously-skip-permissions",
      ],
    });
  });

  test("a relative path is the session's directory's; inline JSON stays as it is; bypass wins over a named mode", () => {
    expect(mirrorArgs(["claude", "--settings", "s.json", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "plan", "--dangerously-skip-permissions"], "/work")).toEqual({
      mode: "bypassPermissions",
      args: ["--settings", resolve("/work", "s.json"), "--mcp-config", '{"mcpServers":{}}'],
    });
  });

  test("a command line cophylad built, its Windows Terminal entry's, is not mirrored: the user's launch is folded away in it", () => {
    const data = resolve("/data/claude");
    expect(mirrorArgs(["claude", "--effort", "low", "--settings", join(data, "cophylad-settings.json")], "/work", data)).toBeUndefined();
    expect(mirrorArgs(["claude", "--effort", "low", "--settings", "/elsewhere/s.json"], "/work", data)).toEqual({ args: ["--effort", "low", "--settings", resolve("/elsewhere/s.json")] });
  });
});

describe("a launch on the command line", () => {
  test("flags group with their values; an unknown flag takes the words up to the next", () => {
    expect(flagGroups(["--add-dir", "a", "b", "--verbose", "--foo", "x", "--model=opus", "--append-system-prompt", "-x"])).toEqual([
      ["--add-dir", "a", "b"],
      ["--verbose"],
      ["--foo", "x"],
      ["--model=opus"],
      ["--append-system-prompt", "-x"],
    ]);
  });

  test("the mode comes apart from the rest, and goes back as the flag the CLI reads", () => {
    expect(splitMode(["--permission-mode=acceptEdits", "--effort", "low"])).toEqual({ mode: "acceptEdits", args: ["--effort", "low"] });
    expect(splitMode(["--permission-mode", "nonsense"])).toEqual({ args: [] });
    expect(launchFlags({ mode: "bypassPermissions", args: ["--settings=/s.json", "--model", "opus"] })).toEqual({ args: ["--dangerously-skip-permissions", "--model", "opus"], settings: "/s.json" });
    expect(launchFlags({ args: ["--model", "opus", "--effort", "high"] }, { model: "sonnet" })).toEqual({ args: ["--effort", "high"] });
    expect(launchFlags(undefined)).toEqual({ args: [] });
  });

  test("a launch the user types is refused when it would not be the session cophylad starts", () => {
    expect(launchProblem(["--effort", "high", "--add-dir", "a", "b"])).toBeUndefined();
    expect(launchProblem(["--continue"])).toBe("--continue is cophylad's to set");
    expect(launchProblem(["-p", "hi"])).toBe("-p is cophylad's to set");
    expect(launchProblem(["fix", "--effort", "high"])).toBe('"fix" is not a flag');
  });
});

describe("cophylad's settings file", () => {
  test("one file per profile holds the launch's own settings and the clear-context row, rewritten only when it changes", () => {
    const data = mkdtempSync(join(tmpdir(), "cophyla-settings-"));
    const cwd = mkdtempSync(join(tmpdir(), "cophyla-cwd-"));
    writeFileSync(join(cwd, "mine.json"), JSON.stringify({ permissions: { defaultMode: "auto" }, showClearContextOnPlanAccept: false, theme: "dark" }));
    const path = cophyladSettings(data, "prof_1", { settings: "mine.json", cwd });
    expect(path).toBe(join(data, "claude", "settings-prof_1.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ permissions: { defaultMode: "auto" }, showClearContextOnPlanAccept: true, theme: "dark" });
    expect(JSON.parse(readFileSync(cophyladSettings(data, "prof_2", { settings: '{"model":"opus"}', cwd }), "utf8"))).toEqual({ model: "opus", showClearContextOnPlanAccept: true });
    // Unreadable: the row alone.
    expect(JSON.parse(readFileSync(cophyladSettings(data, "prof_3", { settings: "missing.json", cwd }), "utf8"))).toEqual({ showClearContextOnPlanAccept: true });
    expect(cophyladSettings(data)).toBe(join(data, "claude", "cophylad-settings.json"));
  });

  test("with no status line: the profile's settings.json under the launch's, merged as Claude merges, less the status lines", () => {
    const data = mkdtempSync(join(tmpdir(), "cophyla-settings-"));
    const cwd = mkdtempSync(join(tmpdir(), "cophyla-cwd-"));
    const hook = { matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:4826/hooks/claude" }] };
    writeFileSync(
      join(cwd, "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "node statusline.js", refreshInterval: 60 },
        subagentStatusLine: { type: "command", command: "node sub.js" },
        hooks: { Stop: [hook] },
        permissions: { allow: ["mcp__cophyla-agents__send_message"] },
        crossSessionInbound: "accept",
        model: "opus",
      }),
    );
    writeFileSync(join(cwd, "launch.json"), JSON.stringify({ hooks: { Stop: [hook], PostToolUse: [hook] }, permissions: { allow: ["Bash(git:*)", "mcp__cophyla-agents__send_message"] }, model: "sonnet" }));
    const path = cophyladSettings(data, "prof_1", { settings: "launch.json", cwd }, join(cwd, "settings.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: { Stop: [hook], PostToolUse: [hook] },
      permissions: { allow: ["mcp__cophyla-agents__send_message", "Bash(git:*)"] },
      crossSessionInbound: "accept",
      model: "sonnet",
      showClearContextOnPlanAccept: true,
    });
    // No launch file, an unreadable settings.json: the row alone.
    expect(JSON.parse(readFileSync(cophyladSettings(data, "prof_2", undefined, join(cwd, "missing.json")), "utf8"))).toEqual({ showClearContextOnPlanAccept: true });
  });

  test("the user-scope MCP servers go to a file of the profile's own, or nowhere when there are none", () => {
    const data = mkdtempSync(join(tmpdir(), "cophyla-settings-"));
    const home = mkdtempSync(join(tmpdir(), "cophyla-home-"));
    const server = { type: "stdio", command: "C:/cophyla/cophylad.exe", args: ["agent-mcp"], env: {} };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { "cophyla-agents": server }, projects: { "C:/w": { mcpServers: { unreal: server } } } }));
    const path = userMcpConfig(data, "prof_1", join(home, ".claude.json"));
    expect(path).toBe(join(data, "claude", "mcp-prof_1.json"));
    expect(JSON.parse(readFileSync(path!, "utf8"))).toEqual({ mcpServers: { "cophyla-agents": server } });
    writeFileSync(join(home, "none.json"), JSON.stringify({ mcpServers: {} }));
    expect(userMcpConfig(data, "prof_2", join(home, "none.json"))).toBeUndefined();
    expect(userMcpConfig(data, "prof_3", join(home, "missing.json"))).toBeUndefined();
  });
});

describe("leaving the user scope out", () => {
  test("drops user from the launch's own setting sources, or names every other source", () => {
    expect(withoutUserScope(["--dangerously-skip-permissions"])).toEqual(["--dangerously-skip-permissions", "--setting-sources", "project,local"]);
    expect(withoutUserScope(["--setting-sources", "user,project", "--effort", "high"])).toEqual(["--effort", "high", "--setting-sources", "project"]);
    expect(withoutUserScope(["--setting-sources=user"])).toEqual(["--setting-sources", ""]);
  });

  test("a session's command line carries it after the launch, before the model", () => {
    const argv = claudeArgv({ command: "claude", sessionId: "s1", resume: true, launch: { mode: "bypassPermissions", args: ["--effort", "high", "--settings", "x.json"] }, model: "opus", noUserScope: true });
    expect(argv).toEqual(["claude", "--resume", "s1", "--dangerously-skip-permissions", "--effort", "high", "--setting-sources", "project,local", "--model", "opus"]);
    expect(claudeArgv({ command: "claude", sessionId: "s1", resume: true })).toEqual(["claude", "--resume", "s1"]);
  });
});
