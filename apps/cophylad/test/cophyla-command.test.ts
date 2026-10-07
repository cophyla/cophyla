// The `cophyla` command's launcher an installed platform keeps in `<root>/bin/` beside tether:
// a batch file on Windows, a shell script elsewhere, holding the root and the default Cophyla
// home it was placed from, reading `<root>/current` each time it runs and running that
// version's runtime on that version's `cophyla.ts` with every argument as given. It is placed
// when it differs and left when it does not, and linked from ~/.local/bin elsewhere.

import { describe, expect, test } from "bun:test";
import { copyFileSync, linkSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandDir, cophylaLauncher, linkCommand, placeCophyla } from "../src/sessions/tether/command.ts";
import { tempHome } from "./helpers.ts";

const WIN = process.platform === "win32";

describe("the launcher", () => {
  test("holds the root and the default home, and runs the current version's runtime on its cophyla.ts", () => {
    const win = cophylaLauncher("C:\\Users\\me\\AppData\\Local\\Cophyla", "C:\\Users\\me\\.cophyla", "windows");
    expect(win.name).toBe("cophyla.cmd");
    expect(win.text).toContain('set "COPHYLA_ROOT=C:\\Users\\me\\AppData\\Local\\Cophyla"');
    expect(win.text).toContain('if not defined COPHYLA_HOME set "COPHYLA_HOME=C:\\Users\\me\\.cophyla"');
    expect(win.text).toContain('set /p V=<"%COPHYLA_ROOT%\\current"');
    expect(win.text).toContain('"%COPHYLA_ROOT%\\versions\\%V%\\bun.exe" "%COPHYLA_ROOT%\\versions\\%V%\\cophylad\\apps\\cophylad\\src\\cophyla.ts" %*');
    expect(win.text.split("\r\n")[0]).toBe("@echo off");
    // a percent in a path is doubled, so the batch file does not expand it
    expect(cophylaLauncher("C:\\100%\\Cophyla", "C:\\h", "windows").text).toContain('set "COPHYLA_ROOT=C:\\100%%\\Cophyla"');
    const sh = cophylaLauncher("/home/me/.local/share/Cophyla", "/home/me/.cophyla", "posix");
    expect(sh.name).toBe("cophyla");
    expect(sh.text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh.text).toContain("root='/home/me/.local/share/Cophyla'");
    expect(sh.text).toContain(': "${COPHYLA_HOME:=/home/me/.cophyla}"');
    expect(sh.text).toContain('exec "$root/versions/$v/bun" "$root/versions/$v/cophylad/apps/cophylad/src/cophyla.ts" "$@"');
    // a quote in the root, and what a double-quoted home would expand, are escaped
    expect(cophylaLauncher("/home/o'neil/C", "/h/$x", "posix").text).toContain("root='/home/o'\\''neil/C'");
    expect(cophylaLauncher("/r", '/h/$x"`', "posix").text).toContain(': "${COPHYLA_HOME:=/h/\\$x\\"\\`}"');
  });

  test("placed when it differs, left when it does not", () => {
    const home = tempHome();
    const root = join(home, "root");
    expect(placeCophyla(root, join(home, ".cophyla"))).toBe(true);
    const name = WIN ? "cophyla.cmd" : "cophyla";
    const text = readFileSync(join(commandDir(root), name), "utf8");
    expect(text).toContain(join(home, ".cophyla"));
    expect(placeCophyla(root, join(home, ".cophyla"))).toBe(false);
    expect(placeCophyla(root, join(home, "another"))).toBe(true);
  });

  test("runs: the version current names, its runtime, every argument as given, the home it was placed with unless one is set", async () => {
    const home = tempHome();
    const root = join(home, "Cophyla root");
    const version = "9.9.9";
    const vdir = join(root, "versions", version);
    const src = join(vdir, "cophylad", "apps", "cophylad", "src");
    mkdirSync(src, { recursive: true });
    // the version's runtime: this one, linked rather than copied, unless the temp folder is on another drive
    const runtime = join(vdir, WIN ? "bun.exe" : "bun");
    try {
      linkSync(process.execPath, runtime);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      copyFileSync(process.execPath, runtime);
    }
    writeFileSync(join(src, "cophyla.ts"), "console.log(JSON.stringify({ argv: Bun.argv.slice(2), home: process.env.COPHYLA_HOME }));\n");
    writeFileSync(join(root, "current"), `${version}\n`);
    placeCophyla(root, join(home, ".cophyla"));
    const launcher = join(commandDir(root), WIN ? "cophyla.cmd" : "cophyla");
    const run = async (env: Record<string, string>) => {
      // as a shell runs it: cmd's own quoting for a path with a space in it, which a user's name may have
      const argv = WIN ? ["cmd.exe", "/d", "/s", "/c", `""${launcher}" node list "two words""`] : ["sh", launcher, "node", "list", "two words"];
      const { COPHYLA_HOME: _drop, ...base } = process.env;
      const p = Bun.spawn(argv, { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true, ...(WIN ? { windowsVerbatimArguments: true } : {}) });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return JSON.parse(out.trim().split(/\r?\n/).pop()!) as { argv: string[]; home: string };
    };
    expect(await run({})).toEqual({ argv: ["node", "list", "two words"], home: join(home, ".cophyla") });
    expect((await run({ COPHYLA_HOME: join(home, "elsewhere") })).home).toBe(join(home, "elsewhere"));
  }, 30_000);

  test.skipIf(WIN)("elsewhere: linked from the user's bin folder, never over another cophyla", () => {
    const home = tempHome();
    const links = join(home, "local-bin");
    const target = join(home, "root", "bin", "cophyla");
    mkdirSync(join(home, "root", "bin"), { recursive: true });
    writeFileSync(target, "#!/bin/sh\n");
    expect(linkCommand(target, links, "cophyla")).toBe("linked");
    expect(readlinkSync(join(links, "cophyla"))).toBe(target);
    expect(linkCommand(target, links, "cophyla")).toBe("present");
    const plain = join(home, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "cophyla"), "the user's own");
    expect(linkCommand(target, plain, "cophyla")).toBe("taken");
  });
});
