// The command-hook shim: one JavaScript file under the daemon's data directory, run by the
// daemon's own runtime, that forwards a hook event from stdin to `/hooks/<harness>` and
// prints the answer. Codex has no http hook type, a managed Claude install can forbid one,
// and Muse runs hooks only from a plugin, so this is the fallback. It reads `{port, token}`
// from `hook.json` beside it, or from the path its fifth argument names (a Muse plugin runs
// its own copy of the shim, from the plugin cache), and when the daemon is unreachable it
// exits 0 printing nothing for Claude and `{}` for the others, so a stopped daemon never
// breaks a session.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttachedHarness } from "./model.ts";

export const SHIM_FILENAME = "cophylad-hook-shim.mjs";
export const HOOK_JSON_FILENAME = "hook.json";

export const SHIM_SOURCE = `// cophylad hook shim: forwards a harness hook event from stdin to the local cophylad and prints
// the answer. Written by cophylad; edits are overwritten at the next start. Exits 0 with no
// opinion when cophylad is not running, so a stopped daemon never breaks a session.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [harness = "claude", profile = "", hookJson] = process.argv.slice(2);
const silence = harness === "claude" ? "" : "{}";
const done = (out) => {
  process.stdout.write(out, () => process.exit(0));
};

let cfg;
try {
  cfg = JSON.parse(readFileSync(hookJson || join(dirname(fileURLToPath(import.meta.url)), "hook.json"), "utf8"));
} catch {
  done(silence);
}

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (body += d));
process.stdin.on("error", () => done(silence));
process.stdin.on("end", () => {
  if (!cfg) return;
  const req = request(
    {
      host: "127.0.0.1",
      port: Number(cfg.port),
      path: "/hooks/" + harness,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + cfg.token,
        "x-cophyla-pid": String(process.pid),
        "x-cophyla-ppid": String(process.ppid),
        "x-cophyla-profile": profile,
      },
    },
    (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (out += d));
      res.on("end", () => done(res.statusCode === 200 && out ? out : silence));
      res.on("error", () => done(silence));
    },
  );
  req.on("error", () => done(silence));
  req.end(body);
});
`;

/** Writes the shim and returns its path. */
export function writeShim(dataDir: string): string {
  const path = join(dataDir, SHIM_FILENAME);
  writeFileSync(path, SHIM_SOURCE, "utf8");
  return path;
}

/** Writes what the shim needs to reach the daemon. */
export function writeHookJson(dataDir: string, cfg: { port: number; token: string }): string {
  const path = join(dataDir, HOOK_JSON_FILENAME);
  writeFileSync(path, JSON.stringify(cfg) + "\n", { encoding: "utf8", mode: 0o600 });
  return path;
}

/** Forward slashes and quotes: one executable and its arguments, whatever shell reads it. */
export function shellPath(p: string): string {
  return `"${p.replace(/\\/g, "/")}"`;
}

/**
 * The shell a hook command is written for. `sh` is every POSIX shell and Git Bash, where a
 * quoted path is a command; `powershell` is what Codex runs `commandWindows` through, where
 * a quoted path is a string unless the call operator `&` precedes it.
 */
export type HookShell = "sh" | "powershell";

/**
 * The hook command: the daemon's runtime running the shim for one harness and profile,
 * quoted and forward-slashed for the shell it is written for. Keyed on the shell alone,
 * never on the platform or the harness: Claude Code reads the `sh` form everywhere (Git
 * Bash on Windows), Codex reads `command` with `sh` and `commandWindows` with PowerShell.
 */
export function shimCommand(shimPath: string, harness: AttachedHarness, profileId: string, opts: { runtime?: string; shell?: HookShell } = {}): string {
  const call = `${shellPath(opts.runtime ?? process.execPath)} ${shellPath(shimPath)} ${harness} ${profileId}`;
  return opts.shell === "powershell" ? `& ${call}` : call;
}

/**
 * The hook as an argument vector, which no shell reads: what a Muse plugin's hook runs. The
 * shim is named as the plugin names it (relative to the plugin's own root), and `hookJson`,
 * when given, is where the shim finds the daemon, since that copy has no `hook.json` beside it.
 */
export function shimArgv(runtime: string, shimPath: string, harness: AttachedHarness, profileId: string, hookJson?: string): string[] {
  return [runtime, shimPath, harness, profileId, ...(hookJson !== undefined ? [hookJson] : [])];
}
