// The `tether` command an installed platform keeps on the user's PATH: one copy in a folder
// that never moves, replaced beside a host still running the old one; that folder on the
// user's PATH on Windows, written as the value's own kind; a link elsewhere, in the bin folder
// the user's shells look in, never over another tether; the attach command a user is given
// names `tether` only when their shells' PATH finds it.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "../src/log.ts";
import { runCommand, type Exec } from "../src/sessions/focus.ts";
import { ADD_TO_USER_PATH, addToUserPath, commandDir, linkCommand, linkDirFor, pathHas, placeCommand, putCommandOnPath } from "../src/sessions/tether/command.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { TETHER_NAME } from "../src/sessions/tether/locate.ts";
import { tempHome } from "./helpers.ts";

const WIN = process.platform === "win32";

function source(home: string, content: string | Buffer): string {
  const src = join(home, "staged", TETHER_NAME);
  mkdirSync(join(home, "staged"), { recursive: true });
  writeFileSync(src, content);
  return src;
}

describe("the command's file", () => {
  test("a copy of the staged binary, made when it differs and left when it does not", () => {
    const home = tempHome();
    const dir = commandDir(join(home, "root"));
    expect(placeCommand(source(home, "one"), dir)).toBe(true);
    expect(readFileSync(join(dir, TETHER_NAME), "utf8")).toBe("one");
    expect(placeCommand(source(home, "one"), dir)).toBe(false);
    expect(placeCommand(source(home, "two"), dir)).toBe(true);
    expect(readFileSync(join(dir, TETHER_NAME), "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual([TETHER_NAME]);
  });

  test.skipIf(!WIN)("a copy a host still runs is moved aside, and goes once it has stopped", async () => {
    const home = tempHome();
    const dir = commandDir(join(home, "root"));
    // A stand-in for a host: a program that runs a while from the command's file.
    placeCommand(source(home, readFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "PING.EXE"))), dir);
    const running = Bun.spawn([join(dir, TETHER_NAME), "-n", "30", "127.0.0.1"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    try {
      await Bun.sleep(300);
      expect(placeCommand(source(home, "new"), dir)).toBe(true);
      expect(readFileSync(join(dir, TETHER_NAME), "utf8")).toBe("new");
      const aside = readdirSync(dir).filter((n) => n.startsWith("tether.old-"));
      expect(aside).toHaveLength(1);
      // Still running: the next start leaves it.
      expect(placeCommand(source(home, "new"), dir)).toBe(false);
      expect(existsSync(join(dir, aside[0]!))).toBe(true);
    } finally {
      running.kill();
      await running.exited;
    }
    await Bun.sleep(200);
    placeCommand(source(home, "new"), dir);
    expect(readdirSync(dir)).toEqual([TETHER_NAME]);
  });
});

describe("the PATH", () => {
  test.skipIf(WIN)("the attach command names tether when the user's shells find it, else the node's own copy", () => {
    const home = tempHome();
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tether"), "#!/bin/sh\n");
    chmodSync(join(bin, "tether"), 0o755);
    const config = { idle_exit_s: 600, window: "auto" as const, window_on_start: false, profiles: false, on_path: true, dir: join(home, "state") };
    const make = (userPath: string) => new Tether({ config, env: {}, dataDir: join(home, "data"), nodeId: "node_test", log: silentLogger, exe: "/opt/cophyla/tether", userPath });
    expect(make(bin).attachCommand({ host: "h", id: "t1" })).toBe(`tether --dir ${join(home, "state")} attach t1`);
    expect(make("/usr/bin").attachCommand({ host: "h", id: "t1" })).toStartWith("/opt/cophyla/tether --dir");
  });

  test("a terminal profile is written where the terminal takes one: Windows Terminal, iTerm2 on a Mac that has it", async () => {
    const home = tempHome();
    const ran: string[][] = [];
    const config = { idle_exit_s: 600, window: "auto" as const, window_on_start: false, profiles: true, on_path: false, dir: join(home, "state") };
    const tether = new Tether({
      config,
      env: {},
      dataDir: join(home, "data"),
      nodeId: "node_test",
      log: silentLogger,
      exe: "/opt/cophyla/tether",
      run: async (_exe, args) => {
        ran.push(args);
        return { code: 0, out: "wrote /Users/me/Library/Application Support/iTerm2/DynamicProfiles/Cophyla-claude-cophyla.json\n", err: "" };
      },
    });
    const req = { app: "Cophyla", name: "Claude (Cophyla)", argv: ["claude"] };
    expect(await tether.installProfile({ ...req, platform: "darwin", iterm: () => true })).toBe("/Users/me/Library/Application Support/iTerm2/DynamicProfiles/Cophyla-claude-cophyla.json");
    expect(ran[0]!.slice(2, 5)).toEqual(["profiles", "install", "--iterm2"]);
    expect(await tether.installProfile({ ...req, platform: "darwin", iterm: () => false })).toBeUndefined();
    await tether.installProfile({ ...req, platform: "win32" });
    expect(ran.map((a) => a[4])).toEqual(["--iterm2", "--wt"]);
    expect(await tether.installProfile({ ...req, platform: "linux" })).toBeUndefined();
    expect(ran).toHaveLength(2);
  });

  test("the link goes where the user's shells look: their own bin folder on it, else a /usr/local/bin they may write, else ~/.local/bin", () => {
    const home = "/Users/me";
    const never = () => false;
    expect(linkDirFor("/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin", home, never)).toBe("/Users/me/.local/bin");
    expect(linkDirFor("/Users/me/bin:/usr/bin", home, never)).toBe("/Users/me/bin");
    expect(linkDirFor("/usr/local/bin:/usr/bin:/bin", home, (d) => d === "/usr/local/bin")).toBe("/usr/local/bin");
    // macOS's stock PATH on Apple Silicon: nothing of the user's, /usr/local/bin root's
    expect(linkDirFor("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", home, never)).toBe("/Users/me/.local/bin");
  });

  test("an entry matches whatever its case or trailing separator on Windows, exactly elsewhere", () => {
    expect(pathHas("C:\\a;c:\\users\\me\\appdata\\local\\cophyla\\bin\\;D:\\b", "C:\\Users\\Me\\AppData\\Local\\Cophyla\\bin", "win32")).toBe(true);
    expect(pathHas("C:\\a;;C:\\Cophyla\\binx", "C:\\Cophyla\\bin", "win32")).toBe(false);
    expect(pathHas("", "C:\\Cophyla\\bin", "win32")).toBe(false);
    expect(pathHas("/usr/bin:/home/me/.local/bin/", "/home/me/.local/bin", "linux")).toBe(true);
    expect(pathHas("/usr/bin:/home/Me/.local/bin", "/home/me/.local/bin", "linux")).toBe(false);
  });

  test("Windows: nothing runs when the daemon's own environment has the folder; else the script, the folder quoted", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, out: "added\r\n", err: "" };
    };
    expect(await addToUserPath("C:\\O\\bin", { Path: "C:\\x;C:\\O\\bin" }, exec)).toBe("present");
    expect(calls).toHaveLength(0);
    expect(await addToUserPath("C:\\Users\\O'Neil\\Cophyla\\bin", { Path: "C:\\x" }, exec)).toBe("added");
    expect(calls[0]![0]).toBe("powershell.exe");
    expect(calls[0]!.at(-1)!.endsWith(" 'C:\\Users\\O''Neil\\Cophyla\\bin'")).toBe(true);
    const failing: Exec = async () => ({ code: 1, out: "", err: "denied" });
    expect(await addToUserPath("C:\\O\\bin", {}, failing)).toBe("failed");
  });

  // The script itself, against a key of the test's own under HKCU: never the user's PATH.
  test.skipIf(!WIN)("Windows: the script appends once, keeps the value's kind and its unexpanded entries", async () => {
    const key = `Software\\CophylaPathTest-${process.pid}`;
    const ps = (script: string) => runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs: 30_000 });
    const add = async (dir: string) => (await ps(`& {${ADD_TO_USER_PATH}} '${dir}' '${key}'`)).out.trim();
    const read = async () => (await ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); '{0}|{1}' -f $k.GetValueKind('Path'), $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')`)).out.trim();
    const set = (value: string, kind: string) => ps(`[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}').SetValue('Path', '${value}', '${kind}')`);
    const bin = join(tempHome(), "Cophyla", "bin");
    try {
      await set("%USERPROFILE%\\tools;C:\\A;", "ExpandString");
      expect(await add(bin)).toBe("added");
      expect(await read()).toBe(`ExpandString|%USERPROFILE%\\tools;C:\\A;${bin}`);
      expect(await add(bin + "\\")).toBe("present");
      expect(await add(bin.toUpperCase())).toBe("present");
      await set("C:\\A", "String");
      expect(await add(bin)).toBe("added");
      expect(await read()).toBe(`String|C:\\A;${bin}`);
      await ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}')`);
      expect(await add(bin)).toBe("added");
      expect(await read()).toBe(`ExpandString|${bin}`);
    } finally {
      await ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}', $false)`);
    }
  }, 60_000);

  test.skipIf(WIN)("elsewhere: a link to the command, never over another tether, and a dangling one replaced", () => {
    const home = tempHome();
    const links = join(home, "local-bin");
    const target = join(home, "root", "bin", "tether");
    mkdirSync(join(home, "root", "bin"), { recursive: true });
    writeFileSync(target, "t");
    expect(linkCommand(target, links)).toBe("linked");
    expect(readlinkSync(join(links, "tether"))).toBe(target);
    expect(linkCommand(target, links)).toBe("present");

    const other = join(home, "other-tether");
    writeFileSync(other, "mine");
    const mine = join(home, "mine-bin");
    mkdirSync(mine);
    symlinkSync(other, join(mine, "tether"));
    expect(linkCommand(target, mine)).toBe("taken");
    const plain = join(home, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "tether"), "a binary of the user's");
    expect(linkCommand(target, plain)).toBe("taken");

    const gone = join(home, "gone-bin");
    mkdirSync(gone);
    symlinkSync(join(home, "old-root", "bin", "tether"), join(gone, "tether"));
    expect(linkCommand(target, gone)).toBe("linked");
    expect(readlinkSync(join(gone, "tether"))).toBe(target);
  });

  test("placed and put on the PATH in one call, which never throws", async () => {
    const home = tempHome();
    const root = join(home, "root");
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, out: "added", err: "" };
    };
    await putCommandOnPath({ exe: source(home, "one"), root, env: { Path: "", PATH: "" }, log: silentLogger, exec, linkDir: join(home, "local-bin") });
    expect(readFileSync(join(commandDir(root), TETHER_NAME), "utf8")).toBe("one");
    if (WIN) expect(calls).toHaveLength(1);
    else expect(readlinkSync(join(home, "local-bin", "tether"))).toBe(join(commandDir(root), TETHER_NAME));
    await putCommandOnPath({ exe: join(home, "missing"), root, env: {}, log: silentLogger, exec, linkDir: join(home, "local-bin") });
  });
});
