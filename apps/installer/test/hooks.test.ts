// The uninstaller's edit of the user's PATH, run as NSIS would run it (its `$$` unescaped, the
// command line passed verbatim) against a key of the test's own under HKCU, never the user's:
// the tether command's folder goes, however it was written, and every other entry stays as it was.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WIN = process.platform === "win32";

/** The PowerShell command line of the hook's `nsExec::Exec`, as the uninstaller passes it. */
function uninstallCommand(): string {
  const hooks = readFileSync(join(import.meta.dir, "..", "hooks.nsh"), "utf8");
  const line = hooks.split(/\r?\n/).find((l) => l.trim().startsWith("nsExec::Exec `powershell.exe"));
  if (!line) throw new Error("no nsExec::Exec powershell line in hooks.nsh");
  return line.trim().slice("nsExec::Exec `".length, -1).replace(/\$\$/g, "$");
}

function run(commandLine: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const [file, ...rest] = commandLine.split(" ");
  return new Promise((resolve) => {
    const child = spawn(file!, [rest.join(" ")], { env: { ...process.env, ...env }, windowsVerbatimArguments: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("uninstall", () => {
  test.skipIf(!WIN)("the tether command's folder leaves the user's PATH alone, the rest and its kind stay", async () => {
    const key = `Software\\CophylaUninstallTest-${process.pid}`;
    const command = uninstallCommand().replace("OpenSubKey('Environment', $true)", `OpenSubKey('${key}', $true)`);
    expect(command).toContain(key);
    const ps = (script: string) => run(`powershell.exe -NoProfile -NonInteractive -Command "${script}"`, {});
    const set = (value: string, kind: string) => ps(`[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}').SetValue('Path', '${value}', '${kind}')`);
    const read = async () => (await ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); '{0}|{1}' -f $k.GetValueKind('Path'), $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')`)).out.trim();
    const bin = "C:\\Users\\Someone\\AppData\\Local\\Cophyla\\bin";
    try {
      await set(`%USERPROFILE%\\tools;C:\\A;${bin};C:\\B;`, "ExpandString");
      expect((await run(command, { COPHYLA_BIN: bin })).code).toBe(0);
      expect(await read()).toBe("ExpandString|%USERPROFILE%\\tools;C:\\A;C:\\B;");

      await set(`C:\\A;${bin.toUpperCase()}\\`, "String");
      await run(command, { COPHYLA_BIN: bin });
      expect(await read()).toBe("String|C:\\A");

      await set("C:\\A;C:\\Users\\Someone\\AppData\\Local\\Cophyla\\binx", "ExpandString");
      await run(command, { COPHYLA_BIN: bin });
      expect(await read()).toBe("ExpandString|C:\\A;C:\\Users\\Someone\\AppData\\Local\\Cophyla\\binx");
    } finally {
      await ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}', $false)`);
    }
  }, 60_000);
});
