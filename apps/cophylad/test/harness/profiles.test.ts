// A second Claude installation: a session started with CLAUDE_CONFIG_DIR pointing at
// ~/.claude-accounts/extra is listed under that profile and a message reaches it under that
// profile's own token. Needs COPHYLA_HARNESS_TESTS=1, that directory, and a login in it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, SessionEvent } from "@cophyla/protocol";
import { withCophyladHooks } from "../../src/sessions/claude/hooks.ts";
import type { Daemon } from "../../src/daemon.ts";
import { samePath } from "../../src/sessions/paths.ts";
import { stopDaemon, tempHome, TestClient, tomlString, waitFor } from "../helpers.ts";
import { CLAUDE, HARNESS, scrubbedEnv, sleep, spawnTui } from "./pty.ts";
import type { Tui } from "./pty.ts";

const EXTRA = process.env["COPHYLA_EXTRA_CLAUDE_DIR"] ?? join(homedir(), ".claude-accounts", "extra");
const run = HARNESS && existsSync(CLAUDE) && existsSync(EXTRA);

describe.skipIf(!run)("harness: a second Claude profile", () => {
  let d: Daemon & { home: string };
  let c: TestClient;
  let tui: Tui;
  let cwd: string;
  let session: Session;

  beforeAll(async () => {
    const scratch = tempHome();
    cwd = join(scratch, "work");
    mkdirSync(cwd, { recursive: true });
    const home = tempHome(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 500\n\n[[profiles]]\nharness = "claude"\nname = "home"\nconfig_dir = ${tomlString(join(homedir(), ".claude"))}\n\n[[profiles]]\nharness = "claude"\nname = "extra"\nconfig_dir = ${tomlString(EXTRA)}\n`,
    );
    const { startDaemon } = await import("../../src/daemon.ts");
    const { silentLogger } = await import("../../src/log.ts");
    d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false }), { home });
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token, { name: "harness" });
    const extra = d.profiles.byHarness("claude").find((p) => p.name === "extra")!;
    const settingsPath = join(scratch, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(withCophyladHooks({}, { mode: "http", url: `http://127.0.0.1:${d.api.port}/hooks/claude`, token: d.hookToken, timeoutS: 7200, profileId: extra.id }), null, 2));
    tui = await spawnTui(CLAUDE, ["--name", `cophyla-extra-${Date.now().toString(36)}`, "--model", "haiku", "--permission-mode", "manual", "--settings", settingsPath], {
      cwd,
      env: scrubbedEnv({ CLAUDE_CONFIG_DIR: EXTRA }),
      rawLog: join(d.home, "claude-extra.raw"),
    });
    for (let i = 0; i < 3; i++) {
      const m = await tui.waitFor(/trust|Yes, proceed|Enter to confirm|›|❯|>\s*$/i, 90_000, tui.mark() - 4000);
      if (/trust|proceed|confirm/i.test(m[0]) && !/›|❯/.test(tui.text(300))) {
        tui.write("\r");
        await sleep(1500);
        continue;
      }
      break;
    }
  }, 180_000);

  afterAll(async () => {
    tui?.kill();
    c?.close();
    if (d) await stopDaemon(d);
  });

  test(
    "the session is listed under the extra profile and a message reaches it",
    async () => {
      const extra = d.profiles.byHarness("claude").find((p) => p.name === "extra")!;
      session = await waitFor(() => d.sessions.list().find((s) => samePath(s.cwd, cwd)), 90_000, 250);
      expect(session.profile).toBe(extra.id);
      await waitFor(() => d.sessions.get(session.id)?.status === "idle", 30_000, 250);
      const mark = tui.mark();
      const r = await c.request<{ status: string; ref: string }>("session.send", { id: session.id, text: "reply with the single word PONG" });
      expect(r.status).toBe("queued");
      const events = (): SessionEvent[] => d.store.sessionEvents.history(session.id, { limit: 1000 });
      await waitFor(() => events().find((e) => e.kind === "notification" && (e.payload as { ref?: string; state?: string }).ref === r.ref && (e.payload as { state?: string }).state === "delivered"), 60_000, 250);
      await tui.waitFor(/PONG/, 120_000, mark);
      await tui.submit("/exit");
      await waitFor(() => d.store.sessions.get(session.id)?.status === "ended", 60_000, 250);
    },
    300_000,
  );
});
