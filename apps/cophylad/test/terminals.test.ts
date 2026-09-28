// Opening a terminal for a session, on every platform, on any host: the spawn is injected,
// so no window is ever opened here. What each platform's terminal does with a real desktop
// is the Windows rehearsal's and the Mac and Linux visits' job.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log.ts";
import { claudeArgv, claudeEnv, newSessionId, sessionName } from "../src/sessions/claude/start.ts";
import { scrub } from "../src/sessions/env.ts";
import { itermWindowScript, OsTerminalOpener, cmdQuote, launchScript, pickOpener, shellQuote, windowsCommandLine } from "../src/sessions/terminals.ts";
import type { LaunchResult, TerminalOpener, TerminalRequest } from "../src/sessions/terminals.ts";

const log = createLogger("error");

type Spawned = { command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined>; verbatim?: boolean };

/** An opener over a recorded spawn, with a `which` that finds only what it is told to. */
function opener(platform: NodeJS.Platform, opts: { found?: string[]; env?: Record<string, string | undefined> } = {}): { opener: OsTerminalOpener; spawned: Spawned[]; dataDir: string } {
  const spawned: Spawned[] = [];
  const found = new Set(opts.found ?? []);
  const dataDir = mkdtempSync(join(tmpdir(), "cophyla-terminals-"));
  const o = new OsTerminalOpener({
    platform,
    dataDir,
    log,
    which: (c) => (found.has(c) ? `/usr/bin/${c}` : null),
    spawnDetached: (command, args, o2) => spawned.push({ command, args, ...o2 }),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  return { opener: o, spawned, dataDir };
}

const request = (over: Partial<TerminalRequest> = {}): TerminalRequest => ({
  argv: ["C:\\bin\\claude.exe", "--session-id", "0c7a6f4e-413f-42de-a87e-591866a7b50a"],
  cwd: "C:\\D\\app",
  env: { CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude" },
  title: "fix the build",
  ...over,
});

describe("a session's command line", () => {
  test("a name keeps only what a command line can carry, in one line", () => {
    expect(sessionName("  fix the  build & deploy %PATH%\n now  ")).toBe("fix the build  deploy PATH now");
    expect(sessionName(`say "hi"; rm -rf /`)).toBe("say hi rm -rf");
    expect(sessionName("x".repeat(200)).length).toBe(60);
    expect(sessionName("   ")).toBe("");
  });

  test("the session id is decided here, and no prompt is passed", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const argv = claudeArgv({ command: "claude", sessionId: id, name: "fix the build" });
    expect(argv).toEqual(["claude", "--session-id", id, "--name", "fix the build"]);
    expect(argv.join(" ")).not.toContain("--print");
  });

  test("a name that survives nothing is left off, and a launch's mode is passed", () => {
    const id = newSessionId();
    expect(claudeArgv({ command: "claude", sessionId: id, name: "%%%" })).toEqual(["claude", "--session-id", id]);
    expect(claudeArgv({ command: "claude", sessionId: id, launch: { mode: "plan", args: [] } })).toEqual(["claude", "--session-id", id, "--permission-mode", "plan"]);
    expect(claudeArgv({ command: "claude", sessionId: id, launch: { mode: "bypassPermissions", args: [] } })).toEqual(["claude", "--session-id", id, "--dangerously-skip-permissions"]);
  });

  test("a launch's flags follow the name; its --settings is left to cophylad's file, its --model to the brain's", () => {
    const id = newSessionId();
    const launch = { mode: "auto" as const, args: ["--settings", "/home/me/s.json", "--model", "opus", "--add-dir", "/a", "/b", "--effort", "high"] };
    expect(claudeArgv({ command: "claude", sessionId: id, name: "fix it", launch })).toEqual([
      "claude", "--session-id", id, "--name", "fix it", "--permission-mode", "auto", "--model", "opus", "--add-dir", "/a", "/b", "--effort", "high",
    ]);
    expect(claudeArgv({ command: "claude", sessionId: id, launch, model: "claude-sonnet-5" })).toEqual([
      "claude", "--session-id", id, "--permission-mode", "auto", "--add-dir", "/a", "/b", "--effort", "high", "--model", "claude-sonnet-5",
    ]);
  });

  test("a session is started under its profile's directory; Claude's own is named by leaving the variable unset", () => {
    const home = join(tmpdir(), "cophyla-home-x");
    expect(claudeEnv(join(home, "accounts", "work"), home)).toEqual({ set: { CLAUDE_CONFIG_DIR: join(home, "accounts", "work") }, unset: [] });
    expect(claudeEnv(join(home, ".claude"), home)).toEqual({ set: {}, unset: ["CLAUDE_CONFIG_DIR"] });
    expect(claudeEnv(join(home, ".", ".claude"), home)).toEqual({ set: {}, unset: ["CLAUDE_CONFIG_DIR"] });
  });

  test("the harness's own markers never reach a session cophylad starts", () => {
    const out = scrub({ PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDECODE: "1", CLAUDE_PID: "42", CLAUDE_EFFORT: "high", CLAUDE_CONFIG_DIR: "/keep/me" });
    expect(out).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/keep/me" });
    // Muse's plugin and session markers, and the ones it sets Claude-style for a plugin's hooks.
    const muse = scrub({ PATH: "/bin", MUSE_PLUGIN_ID: "cophylad", MUSE_PLUGIN_ROOT: "/p", CLAUDE_PLUGIN_ROOT: "/p", MUSE_AGENTS_ROLE: "child", MUSE_CURRENT_SESSION_LOG: "/l", MUSE_NO_AUTO_UPDATE: "1", XDG_DATA_HOME: "/d" });
    expect(muse).toEqual({ PATH: "/bin", MUSE_NO_AUTO_UPDATE: "1", XDG_DATA_HOME: "/d" });
  });
});

describe("quoting", () => {
  test("cmd cannot be made to read a word as syntax", () => {
    expect(cmdQuote("C:\\D\\a b")).toBe(`"C:\\D\\a b"`);
    expect(cmdQuote("a&b|c")).toBe(`"a&b|c"`);
    expect(cmdQuote("%PATH%")).toBe(`"%%PATH%%"`);
  });

  test("a POSIX shell takes a word whole, quote and all", () => {
    expect(shellQuote("/home/me/a b")).toBe("'/home/me/a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("a;rm -rf /")).toBe("'a;rm -rf /'");
  });

  test("the Windows command line names the title, then the directory, then the session", () => {
    expect(windowsCommandLine(request())).toBe(`/c start "fix the build" /D "C:\\D\\app" "C:\\bin\\claude.exe" "--session-id" "0c7a6f4e-413f-42de-a87e-591866a7b50a"`);
  });

  test("a launch script carries the environment, the directory and the session", () => {
    const script = launchScript(request({ cwd: "/home/me/my app", argv: ["/usr/bin/claude", "--session-id", "abc"] }));
    expect(script.split("\n")).toEqual(["#!/bin/sh", `export CLAUDE_CONFIG_DIR='C:\\Users\\me\\.claude'`, "cd '/home/me/my app' || exit 1", "exec '/usr/bin/claude' '--session-id' 'abc'", ""]);
  });
});

describe("opening one", () => {
  test("Windows hands cmd a command line of its own making", async () => {
    const { opener: o, spawned } = opener("win32", { env: { PATH: "C:\\bin" } });
    expect(await o.available()).toBe(true);
    await o.open(request());
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toBe("cmd.exe");
    expect(spawned[0]!.args).toEqual([windowsCommandLine(request())]);
    // Left to the C runtime's quoting, `cmd` would read the result as syntax of its own.
    expect(spawned[0]!.verbatim).toBe(true);
    expect(spawned[0]!.cwd).toBe("C:\\D\\app");
    expect(spawned[0]!.env).toMatchObject({ PATH: "C:\\bin", CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude" });
  });

  test("a variable the session must not inherit is taken out: of cmd's environment, and by the script", async () => {
    const { opener: o, spawned } = opener("win32", { env: { PATH: "C:/bin", Claude_Config_Dir: "C:/elsewhere" } });
    await o.open(request({ env: {}, unset: ["CLAUDE_CONFIG_DIR"] }));
    expect(spawned[0]!.env).toEqual({ PATH: "C:/bin" });
    const script = launchScript(request({ cwd: "/home/me/app", argv: ["/usr/bin/claude"], env: {}, unset: ["CLAUDE_CONFIG_DIR"] }));
    expect(script.split("\n").slice(0, 2)).toEqual(["#!/bin/sh", "unset CLAUDE_CONFIG_DIR"]);
  });

  /** A macOS opener whose launcher answers `result`, with the given apps installed. */
  function mac(opts: { apps?: string[]; result?: LaunchResult; terminal?: string; console?: boolean } = {}) {
    const launched: { command: string; args: string[] }[] = [];
    const dataDir = mkdtempSync(join(tmpdir(), "cophyla-terminals-"));
    const o = new OsTerminalOpener({
      platform: "darwin",
      dataDir,
      log,
      env: { HOME: "/Users/me" },
      which: (c) => (c === "open" ? "/usr/bin/open" : null),
      exists: (p) => (opts.apps ?? []).includes(p),
      ownsConsole: () => opts.console ?? true,
      launch: async (command, args) => {
        launched.push({ command, args });
        return opts.result ?? { code: 0, err: "" };
      },
      ...(opts.terminal ? { terminal: opts.terminal } : {}),
    });
    return { o, launched, dataDir };
  }

  test("macOS opens a script Terminal knows how to run", async () => {
    const { o, launched, dataDir } = mac();
    expect(await o.available()).toBe(true);
    await o.open(request({ cwd: "/Users/me/app" }));
    expect(launched[0]!.command).toBe("open");
    const [dashA, terminal, script] = launched[0]!.args;
    expect([dashA, terminal]).toEqual(["-a", "Terminal"]);
    expect(script!.startsWith(join(dataDir, "launch"))).toBe(true);
    expect(script!.endsWith(".command")).toBe(true);
    expect(readFileSync(script!, "utf8")).toContain("cd '/Users/me/app' || exit 1");
  });

  test("macOS takes iTerm2 when it is installed, in either Applications folder, unless Terminal is named", async () => {
    for (const app of ["/Applications/iTerm.app", "/Users/me/Applications/iTerm.app"]) {
      const { o, launched } = mac({ apps: [app] });
      await o.open(request({ cwd: "/Users/me/app" }));
      expect(launched[0]!.command).toBe("osascript");
      expect(launched[0]!.args[1]).toMatch(/^tell application "iTerm2" to create window with default profile command "\/bin\/sh '.*\.sh'"$/);
    }
    const named = mac({ apps: ["/Applications/iTerm.app"], terminal: "terminal" });
    await named.o.open(request({ cwd: "/Users/me/app" }));
    expect(named.launched[0]!.command).toBe("open");
    expect(itermWindowScript("/a b/c\"d.sh")).toBe(`tell application "iTerm2" to create window with default profile command "/bin/sh '/a b/c\\"d.sh'"`);
  });

  test("macOS reports a launcher's refusal, leaves one on the Automation prompt to finish, and opens nothing off the console", async () => {
    const refused = mac({ result: { code: 1, err: "Unable to find application named 'Terminal'" } });
    await expect(refused.o.open(request({ cwd: "/Users/me/app" }))).rejects.toThrow("Unable to find application");
    const waiting = mac({ apps: ["/Applications/iTerm.app"], result: { code: null, err: "", running: true } });
    await waiting.o.open(request({ cwd: "/Users/me/app" }));
    expect(waiting.launched).toHaveLength(1);
    expect(await mac({ console: false }).o.available()).toBe(false);
  });

  test("Linux takes the first terminal it finds, and TERMINAL before any of them", async () => {
    const display = { DISPLAY: ":0" };
    const gnome = opener("linux", { found: ["gnome-terminal", "xterm"], env: display });
    await gnome.opener.open(request({ cwd: "/home/me/app" }));
    expect(gnome.spawned[0]!.command).toBe("gnome-terminal");
    expect(gnome.spawned[0]!.args.slice(0, 2)).toEqual(["--", "/bin/sh"]);

    const named = opener("linux", { found: ["gnome-terminal", "wezterm"], env: { ...display, TERMINAL: "wezterm" } });
    await named.opener.open(request({ cwd: "/home/me/app" }));
    expect(named.spawned[0]!.command).toBe("wezterm");
  });

  test("a Linux box with no display and a box with no terminal both open nothing", async () => {
    expect(await opener("linux", { found: ["xterm"] }).opener.available()).toBe(false);
    expect(await opener("linux", { found: [], env: { DISPLAY: ":0" } }).opener.available()).toBe(false);
    await expect(opener("linux", { found: [], env: { DISPLAY: ":0" } }).opener.open(request())).rejects.toThrow("no terminal program found");
  });

  test("the first opener that can open one is the one asked", async () => {
    const opened: string[] = [];
    const make = (kind: "vscode" | "os", can: boolean): TerminalOpener => ({
      kind,
      available: async () => can,
      open: async () => void opened.push(kind),
    });
    expect((await pickOpener([make("vscode", false), make("os", true)]))?.kind).toBe("os");
    expect((await pickOpener([make("vscode", true), make("os", true)]))?.kind).toBe("vscode");
    expect(await pickOpener([make("vscode", false), make("os", false)])).toBeUndefined();
    expect(await pickOpener([])).toBeUndefined();
  });

  test("an opener that cannot say whether it is there is one that is not", async () => {
    const throws: TerminalOpener = {
      kind: "vscode",
      available: async () => {
        throw new Error("no editor");
      },
      open: async () => {},
    };
    expect(await pickOpener([throws])).toBeUndefined();
  });
});
