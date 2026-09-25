// A Claude profile's launch: which of the user's own flags a mirror keeps, how a launch is
// split into its mode and the rest, and cophylad's settings file with the launch's own folded in.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { flagGroups, launchFlags, launchProblem, mirrorArgs, splitMode } from "../src/sessions/claude/launch-args.ts";
import { cophyladSettings } from "../src/sessions/claude/start.ts";

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
});
