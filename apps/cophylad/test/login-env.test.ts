// A Mac daemon started from the Finder or at login takes the user's login-shell PATH, keeps its
// own after it, adds the install folders that exist, and gets a UTF-8 locale; one started from a
// terminal, and every other platform, is left alone; a shell that fails or hangs falls back to
// path_helper, and a hanging one is killed by the timeout.

import { describe, expect, test } from "bun:test";
import { execSettled, installFolders, localeOf, loginEnv, mergePaths, parseMarkedEnv, parsePathHelper } from "../src/login-env.ts";
import type { ExecResult } from "../src/sessions/focus.ts";

const MARK = "__COPHYLA_LOGIN_ENV__";
const BARE = "/usr/bin:/bin:/usr/sbin:/sbin";

function deps(answers: Record<string, ExecResult>, present: string[] = [], files: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      exec: async (file: string, args: string[]) => {
        calls.push([file, ...args].join(" "));
        return answers[file] ?? { code: 1, out: "", err: "" };
      },
      exists: (p: string) => present.includes(p),
      read: (p: string) => files[p],
      home: "/Users/u",
    },
  };
}

const shellSays = (vars: string): ExecResult => ({ code: 0, out: `Last login: today\nhello from .zshrc\n${MARK}\n${vars}\n${MARK}\n`, err: "" });

describe("login env", () => {
  test("a terminal's daemon, and every platform but macOS, is left alone", async () => {
    const { deps: d, calls } = deps({});
    expect(await loginEnv({ PATH: BARE, TERM: "xterm-256color" }, "darwin", d)).toBeUndefined();
    expect(await loginEnv({ PATH: BARE }, "linux", d)).toBeUndefined();
    expect(await loginEnv({ PATH: BARE }, "win32", d)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("the login shell's PATH first, the daemon's own after, then the install folders that exist", async () => {
    const { deps: d, calls } = deps(
      { "/bin/zsh": shellSays("HOME=/Users/u\nPATH=/opt/homebrew/bin:/usr/bin:/bin\nLANG=tr_TR.UTF-8") },
      ["/Users/u/.local/bin", "/opt/homebrew/bin", "/Users/u/.nvm/versions/node/v22.19.0/bin"],
      { "/Users/u/.nvm/alias/default": "22.19.0\n" },
    );
    const r = await loginEnv({ PATH: BARE, SHELL: "/bin/zsh" }, "darwin", d);
    expect(r?.vars.PATH).toBe(["/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/Users/u/.local/bin", "/Users/u/.nvm/versions/node/v22.19.0/bin"].join(":"));
    expect(r?.vars.LANG).toBe("tr_TR.UTF-8");
    expect(r?.note).toEqual({ source: "shell", added: ["/opt/homebrew/bin", "/Users/u/.local/bin", "/Users/u/.nvm/versions/node/v22.19.0/bin"], lang: "tr_TR.UTF-8", shellPath: "/opt/homebrew/bin:/usr/bin:/bin" });
    expect(calls[0]).toStartWith("/bin/zsh -ilc ");
    expect(calls).toHaveLength(1);
  });

  test("a shell that fails leaves path_helper's PATH; the locale comes from AppleLocale", async () => {
    const { deps: d } = deps(
      {
        "/bin/zsh": { code: null, out: "", err: "" },
        "/usr/libexec/path_helper": { code: 0, out: 'PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH;\n', err: "" },
        "/usr/bin/defaults": { code: 0, out: "en_GB@rg=trzzzz\n", err: "" },
      },
      ["/usr/share/locale/en_GB.UTF-8"],
    );
    const r = await loginEnv({ PATH: BARE }, "darwin", d);
    expect(r?.note.source).toBe("path_helper");
    expect(r?.note.shellPath).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(r?.vars.PATH).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(r?.vars.LANG).toBe("en_GB.UTF-8");
  });

  test("a locale already set is kept; a relative or odd SHELL is not run", async () => {
    const { deps: d, calls } = deps({ "/bin/zsh": shellSays("PATH=/usr/bin") });
    const r = await loginEnv({ PATH: BARE, SHELL: "zsh", LANG: "de_DE.UTF-8" }, "darwin", d);
    expect(r?.vars.LANG).toBeUndefined();
    expect(r?.note.lang).toBeUndefined();
    expect(calls[0]).toStartWith("/bin/zsh ");
  });

  test("the pieces: marked env, path_helper, merge, install folders, locale", () => {
    expect(parseMarkedEnv(`noise ${MARK}\nA=1\nPATH=/x:/y\nnot a var\nB=a=b\n${MARK}\ntrailing`)).toEqual(
      new Map([
        ["A", "1"],
        ["PATH", "/x:/y"],
        ["B", "a=b"],
      ]),
    );
    expect(parseMarkedEnv("no marks")).toBeUndefined();
    expect(parsePathHelper('PATH="/a:/b"; export PATH;')).toBe("/a:/b");
    expect(mergePaths(["/a/", "", "rel", "/b"], ["/a", "/c"])).toEqual(["/a", "/b", "/c"]);
    expect(installFolders("/h", () => "lts/*")).not.toContain("/h/.nvm/versions/node/lts/*/bin");
    expect(installFolders("/h", () => "v20.1.0")).toContain("/h/.nvm/versions/node/v20.1.0/bin");
    expect(localeOf("fr_FR", () => false)).toBe("en_US.UTF-8");
    expect(localeOf(undefined, () => true)).toBe("en_US.UTF-8");
  });

  test.skipIf(process.platform === "win32")("a command that ignores SIGTERM and outlives the timeout is killed and settles", async () => {
    const started = Date.now();
    const r = await execSettled("/bin/sh", ["-c", "trap '' TERM; echo early; sleep 30"], { timeoutMs: 300 });
    expect(r.code).toBeNull();
    expect(r.out).toBe("early\n");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test.skipIf(process.platform === "win32")("a job left in the background holding the output open does not hold the answer", async () => {
    const started = Date.now();
    const r = await execSettled("/bin/sh", ["-c", "sleep 30 & echo done"], { timeoutMs: 10000 });
    expect(r.code).toBe(0);
    expect(r.out).toBe("done\n");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
