// The Codex trust step against the real binary in a throwaway CODEX_HOME: cophylad's hooks are
// installed, `hooks/list` reports them from that file, the grant through `config/batchWrite`
// re-lists them as trusted, and a second grant is a no-op. Needs only the binary, no login;
// skipped where it is absent. Nothing under the real `~/.codex` is touched. What a real
// session posts through the trusted hooks is covered by the harness test, which needs a
// login and spends a model turn.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "../src/log.ts";
import { CodexAppServer } from "../src/sessions/codex/appserver.ts";
import { installCodexHooks, trustCodexHooks } from "../src/sessions/codex/hooks.ts";
import type { HooksListResponse } from "../src/sessions/codex/hooks.ts";
import { samePath } from "../src/sessions/paths.ts";
import { shimCommand } from "../src/sessions/shim.ts";
import { CODEX } from "./harness/pty.ts";
import { tempHome } from "./helpers.ts";

const present = existsSync(CODEX);

describe.skipIf(!present)("codex hooks trust against the real binary", () => {
  test(
    "install, list from our file, grant, re-list trusted",
    async () => {
      const root = tempHome();
      const home = join(root, "codex-home");
      mkdirSync(home, { recursive: true });
      const hooksPath = join(home, "hooks.json");
      const shimPath = join(root, "cophylad-hook-shim.mjs");
      const command = shimCommand(shimPath, "codex", "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", { shell: "sh" });
      const commandWindows = shimCommand(shimPath, "codex", "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", { shell: "powershell" });
      installCodexHooks(hooksPath, { command, commandWindows, timeoutS: 7200 });

      const server = new CodexAppServer({ command: CODEX, args: [], env: { ...process.env, CODEX_HOME: home }, log: silentLogger, version: "0.1.0" });
      try {
        const init = await server.start();
        expect(samePath(init.codexHome, home)).toBe(true);

        const before = await server.call<HooksListResponse>("hooks/list", { cwds: [home] });
        const entries = (before.data ?? []).flatMap((g) => g.hooks ?? []);
        expect(entries).toHaveLength(6);
        expect(entries.every((e) => samePath(e.sourcePath, hooksPath))).toBe(true);
        // the binary reports the form it runs: PowerShell's on Windows, sh's elsewhere
        expect(entries.every((e) => e.command === (process.platform === "win32" ? commandWindows : command))).toBe(true);
        expect(entries.every((e) => e.source === "user")).toBe(true);
        expect(entries.every((e) => e.trustStatus === "untrusted")).toBe(true);
        expect(entries.every((e) => e.currentHash.startsWith("sha256:"))).toBe(true);
        expect(entries.map((e) => e.eventName).sort()).toEqual(["permissionRequest", "postToolUse", "sessionEnd", "sessionStart", "stop", "userPromptSubmit"]);
        expect(entries.find((e) => e.eventName === "sessionEnd")?.timeoutSec).toBe(3);

        const r = await trustCodexHooks(server, { hooksPath, codexHome: home, log: silentLogger });
        expect(r.refused).toBeUndefined();
        expect(r.trusted).toBe(6);
        expect(r.untrusted).toBe(0);
        const toml = readFileSync(join(home, "config.toml"), "utf8");
        expect(toml).toContain("trusted_hash");
        expect(toml).toContain(hooksPath.replace(/\\/g, "\\"));

        const again = await trustCodexHooks(server, { hooksPath, codexHome: home, log: silentLogger });
        expect(again.trusted).toBe(6);
      } finally {
        await server.stop();
      }
    },
    30000,
  );
});
