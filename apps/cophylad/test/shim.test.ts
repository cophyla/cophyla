// The hook command per shell: the `sh` form is quoted and forward-slashed with no call
// operator, whatever platform the paths came from; the PowerShell form is `& ` before it,
// in a `try` that exits 0 when the runtime cannot start, which on Windows is run through
// PowerShell as Codex runs it. Claude gets the sh form; Codex's file carries both.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCophyladCodexHooks } from "../src/sessions/codex/hooks.ts";
import { withCophyladHooks } from "../src/sessions/claude/hooks.ts";
import { shellPath, shimCommand } from "../src/sessions/shim.ts";
import { tempHome } from "./helpers.ts";

const WIN_SHIM = "C:\\Users\\me\\AppData\\Local\\cophyla\\data\\cophylad-hook-shim.mjs";
const WIN_RUNTIME = "C:\\Users\\me\\AppData\\Local\\Cophyla\\versions\\0.1.0\\bun.exe";
const POSIX_SHIM = "/home/me/.local/share/cophyla/data/cophylad-hook-shim.mjs";
const POSIX_RUNTIME = "/home/me/.local/share/cophyla/versions/0.1.0/bun";

describe("shim command", () => {
  test("the sh form is quoted, forward-slashed and never prefixed, for Windows- and POSIX-shaped paths", () => {
    expect(shimCommand(WIN_SHIM, "claude", "prof_x", { runtime: WIN_RUNTIME })).toBe(
      '"C:/Users/me/AppData/Local/Cophyla/versions/0.1.0/bun.exe" "C:/Users/me/AppData/Local/cophyla/data/cophylad-hook-shim.mjs" claude prof_x',
    );
    expect(shimCommand(WIN_SHIM, "codex", "prof_x", { runtime: WIN_RUNTIME, shell: "sh" })).toBe(
      '"C:/Users/me/AppData/Local/Cophyla/versions/0.1.0/bun.exe" "C:/Users/me/AppData/Local/cophyla/data/cophylad-hook-shim.mjs" codex prof_x',
    );
    expect(shimCommand(POSIX_SHIM, "codex", "prof_x", { runtime: POSIX_RUNTIME, shell: "sh" })).toBe(
      '"/home/me/.local/share/cophyla/versions/0.1.0/bun" "/home/me/.local/share/cophyla/data/cophylad-hook-shim.mjs" codex prof_x',
    );
    expect(shimCommand(POSIX_SHIM, "claude", "prof_x", { runtime: POSIX_RUNTIME })).not.toContain("&");
  });

  test("the PowerShell form is the call operator before the sh form, whatever the harness, exiting 0 when the runtime cannot start", () => {
    const ps = (sh: string) => `try { & ${sh}; exit $LASTEXITCODE } catch { exit 0 }`;
    for (const harness of ["claude", "codex"] as const) {
      const sh = shimCommand(WIN_SHIM, harness, "prof_x", { runtime: WIN_RUNTIME, shell: "sh" });
      expect(shimCommand(WIN_SHIM, harness, "prof_x", { runtime: WIN_RUNTIME, shell: "powershell" })).toBe(ps(sh));
    }
    expect(shimCommand(POSIX_SHIM, "codex", "prof_x", { runtime: POSIX_RUNTIME, shell: "powershell" })).toBe(ps(shimCommand(POSIX_SHIM, "codex", "prof_x", { runtime: POSIX_RUNTIME })));
  });

  test.skipIf(process.platform !== "win32")("run as Codex runs it, the PowerShell form passes the shim's answer and the runtime's exit code through, and exits 0 when the runtime cannot be started", async () => {
    const dir = tempHome();
    const shim = join(dir, "shim.mjs");
    writeFileSync(shim, 'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("{\\"ok\\":1}"); process.exitCode = process.argv[2] === "codex" ? 0 : 3; });');
    const run = async (command: string) => {
      const p = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
      p.stdin!.end("{}");
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return { out, code };
    };
    expect(await run(shimCommand(shim, "codex", "prof_x", { runtime: process.execPath, shell: "powershell" }))).toEqual({ out: '{"ok":1}', code: 0 });
    expect((await run(shimCommand(shim, "claude", "prof_x", { runtime: process.execPath, shell: "powershell" }))).code).toBe(3);
    expect(await run(shimCommand(shim, "codex", "prof_x", { runtime: join(dir, "no-such-runtime.exe"), shell: "powershell" }))).toEqual({ out: "", code: 0 });
  });

  test("the runtime defaults to the daemon's own", () => {
    expect(shimCommand(POSIX_SHIM, "claude", "prof_x")).toStartWith(shellPath(process.execPath));
  });

  test("Claude's file gets the sh form; Codex's file carries both", () => {
    const sh = shimCommand(POSIX_SHIM, "claude", "prof_x", { runtime: POSIX_RUNTIME });
    const claude = withCophyladHooks({}, { url: "http://127.0.0.1:1/hooks/", token: "t", timeoutS: 5, profileId: "prof_x", mode: "command", command: sh }) as {
      hooks: Record<string, { hooks: { type: string; command?: string }[] }[]>;
    };
    const claudeHooks = Object.values(claude.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    expect(claudeHooks.length).toBeGreaterThan(0);
    for (const h of claudeHooks) {
      expect(h.type).toBe("command");
      expect(h.command).toBe(sh);
    }

    const codexSh = shimCommand(POSIX_SHIM, "codex", "prof_x", { runtime: POSIX_RUNTIME, shell: "sh" });
    const codexPs = shimCommand(POSIX_SHIM, "codex", "prof_x", { runtime: POSIX_RUNTIME, shell: "powershell" });
    const codex = withCophyladCodexHooks({}, { command: codexSh, commandWindows: codexPs, timeoutS: 5 }) as {
      hooks: Record<string, { hooks: { command: string; commandWindows: string }[] }[]>;
    };
    const codexHooks = Object.values(codex.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    expect(codexHooks).toHaveLength(6);
    for (const h of codexHooks) {
      expect(h.command).toBe(codexSh);
      expect(h.commandWindows).toBe(codexPs);
      expect(h.commandWindows).toBe(`try { & ${h.command}; exit $LASTEXITCODE } catch { exit 0 }`);
    }
  });
});
