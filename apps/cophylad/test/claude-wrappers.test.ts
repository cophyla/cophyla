// Claude accounts started by wrapper scripts: a `claude-<name>` script in a folder on PATH (or
// WinGet's Links folder, or ~/.local/bin) that sets CLAUDE_CONFIG_DIR, in cmd's, PowerShell's or
// a POSIX shell's way, names an account whose directory is there; the variables in it expand as
// the shell would; claude itself, other names, big files and directories that are not there name
// none; a folder is read again once its time moved, and a script once its own did.

import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeWrappers, expandWrapperPath, wrapperConfigDir, wrapperName } from "../src/sessions/claude/wrappers.ts";
import { tempHome } from "./helpers.ts";

describe("what a wrapper sets", () => {
  test("cmd's set, quoted or not; PowerShell's $env:; a POSIX shell's export or prefix; nothing else", () => {
    expect(wrapperConfigDir('@echo off\r\nsetlocal\r\nset "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-ferit"\r\nclaude.exe %*\r\n')).toBe("%USERPROFILE%\\.claude-ferit");
    expect(wrapperConfigDir("set CLAUDE_CONFIG_DIR=C:\\Users\\me\\.claude-accounts\\gmail\r\nclaude %*")).toBe("C:\\Users\\me\\.claude-accounts\\gmail");
    expect(wrapperConfigDir("set CLAUDE_CONFIG_DIR=C:\\a&& claude %*")).toBe("C:\\a");
    expect(wrapperConfigDir("$env:CLAUDE_CONFIG_DIR = '$env:USERPROFILE\\.claude-work'\nclaude @args")).toBe("$env:USERPROFILE\\.claude-work");
    expect(wrapperConfigDir('#!/bin/sh\nexport CLAUDE_CONFIG_DIR="$HOME/.claude-work"\nexec claude "$@"\n')).toBe("$HOME/.claude-work");
    expect(wrapperConfigDir("#!/bin/sh\nCLAUDE_CONFIG_DIR=~/.claude-side exec claude \"$@\"\n")).toBe("~/.claude-side");
    expect(wrapperConfigDir("@echo off\r\nclaude.exe --model opus %*\r\n")).toBeUndefined();
  });

  test("its variables expand as the shell would; an unknown one, or a path that is not absolute, names nothing", () => {
    const home = "C:\\Users\\me";
    const env = { USERPROFILE: home, LocalAppData: "C:\\Users\\me\\AppData\\Local" };
    expect(expandWrapperPath("%USERPROFILE%\\.claude-ferit", env, home, "win32")).toBe("C:\\Users\\me\\.claude-ferit");
    expect(expandWrapperPath("%localappdata%\\claude-x", env, home, "win32")).toBe("C:\\Users\\me\\AppData\\Local\\claude-x");
    expect(expandWrapperPath("$env:USERPROFILE\\.claude-work", env, home, "win32")).toBe("C:\\Users\\me\\.claude-work");
    expect(expandWrapperPath("%NOT_SET%\\.claude-x", env, home, "win32")).toBeUndefined();
    expect(expandWrapperPath(".claude-x", env, home, "win32")).toBeUndefined();
    // HOME falls back on the home folder where it is not set
    if (process.platform !== "win32") {
      expect(expandWrapperPath("$HOME/.claude-work", {}, "/home/me", "linux")).toBe("/home/me/.claude-work");
      expect(expandWrapperPath("${HOME}/.claude-work", { HOME: "/u/me" }, "/home/me", "linux")).toBe("/u/me/.claude-work");
      expect(expandWrapperPath("~/.claude-side", {}, "/home/me", "linux")).toBe("/home/me/.claude-side");
    }
  });

  test("the profile is named after the script, past claude-", () => {
    expect(wrapperName("C:\\bin\\claude-ferit.cmd", "C:\\x\\.claude-ferit")).toBe("ferit");
    expect(wrapperName("/usr/local/bin/claude_work", "/x/y")).toBe("work");
    expect(wrapperName("/bin/claude-gmail.ps1", "/x/gmail")).toBe("gmail");
  });
});

describe("the wrappers found", () => {
  function setup() {
    const home = tempHome();
    const bin = join(home, "bin");
    const links = join(home, "AppData", "Local", "Microsoft", "WinGet", "Links");
    mkdirSync(bin, { recursive: true });
    mkdirSync(links, { recursive: true });
    const ferit = join(home, ".claude-ferit");
    const work = join(home, ".claude-work");
    mkdirSync(ferit, { recursive: true });
    mkdirSync(work, { recursive: true });
    const env = { PATH: [bin, join(home, "nowhere")].join(process.platform === "win32" ? ";" : ":"), USERPROFILE: home, HOME: home, LOCALAPPDATA: join(home, "AppData", "Local") };
    return { home, bin, links, ferit, work, env, wrappers: new ClaudeWrappers({ env, home, platform: process.platform }) };
  }

  // cmd scripts with %USERPROFILE% and WinGet's folder: what Windows alone reads
  test.skipIf(process.platform !== "win32")("a claude-<name> script on PATH or in WinGet's Links folder names the account it sets; others name none", () => {
    const t = setup();
    writeFileSync(join(t.links, "claude-ferit.cmd"), '@echo off\r\nsetlocal\r\nset "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-ferit"\r\nclaude.exe %*\r\n');
    writeFileSync(join(t.bin, "claude-work.ps1"), "$env:CLAUDE_CONFIG_DIR = '" + t.work + "'\nclaude @args\n");
    // claude itself, another name, a directory that is not there, a script that sets nothing, one too big to be a wrapper
    writeFileSync(join(t.bin, "claude.cmd"), `set "CLAUDE_CONFIG_DIR=${t.work}"\r\n`);
    writeFileSync(join(t.bin, "work-claude.cmd"), `set "CLAUDE_CONFIG_DIR=${t.work}"\r\n`);
    writeFileSync(join(t.bin, "claude-gone.cmd"), `set "CLAUDE_CONFIG_DIR=${join(t.home, ".claude-gone")}"\r\n`);
    writeFileSync(join(t.bin, "claude-plain.cmd"), "claude.exe --model opus %*\r\n");
    writeFileSync(join(t.bin, "claude-big.cmd"), `set "CLAUDE_CONFIG_DIR=${t.work}"\r\n` + "rem padding\r\n".repeat(2000));
    const found = t.wrappers.list();
    expect(found.map((w) => [w.name, w.dir.toLowerCase()]).sort()).toEqual([
      ["ferit", t.ferit.toLowerCase()],
      ["work", t.work.toLowerCase()],
    ]);
  });

  test("a script added later is found once its folder's time moved; a changed script is read again", () => {
    const t = setup();
    expect(t.wrappers.list()).toEqual([]);
    const script = join(t.bin, "claude-ferit.cmd");
    writeFileSync(script, `set "CLAUDE_CONFIG_DIR=${t.ferit}"\r\n`);
    // the folder's time moves with the new entry; set it past the last read, as a coarse clock might not
    const later = new Date(Date.now() + 5000);
    utimesSync(t.bin, later, later);
    expect(t.wrappers.list().map((w) => w.dir.toLowerCase())).toEqual([t.ferit.toLowerCase()]);
    writeFileSync(script, `set "CLAUDE_CONFIG_DIR=${t.work}"\r\n`);
    const again = new Date(Date.now() + 10000);
    utimesSync(script, again, again);
    expect(t.wrappers.list().map((w) => w.dir.toLowerCase())).toEqual([t.work.toLowerCase()]);
  });
});
