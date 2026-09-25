// Milestone 1 against a real Codex terminal: a temp CODEX_HOME seeded with a copy of the
// real auth.json and a config that trusts the temp cwd, declared as a Codex profile with
// install_hooks on, so cophylad's hooks and the trust grant land only there. Needs
// COPHYLA_HARNESS_TESTS=1 and a Codex login. The temp home is deleted afterwards.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ask, Session, SessionEvent } from "@cophyla/protocol";
import type { Daemon } from "../../src/daemon.ts";
import { samePath } from "../../src/sessions/paths.ts";
import { isMethod, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "../helpers.ts";
import { CODEX, HARNESS, scrubbedEnv, spawnTui } from "./pty.ts";
import type { Tui } from "./pty.ts";

const AUTH = join(homedir(), ".codex", "auth.json");
const run = HARNESS && existsSync(CODEX) && existsSync(AUTH);
const MODEL = process.env["COPHYLA_CODEX_MODEL"] ?? "gpt-5.6-luna";

describe.skipIf(!run)("harness: codex", () => {
  let d: Daemon & { home: string };
  let c: TestClient;
  let tui: Tui;
  let home: string;
  let cwd: string;
  let scratch: string;
  let session: Session;
  const history = (): SessionEvent[] => d.store.sessionEvents.history(session.id, { limit: 1000 });

  beforeAll(async () => {
    scratch = tempHome();
    home = join(scratch, "codex-home");
    cwd = join(scratch, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    copyFileSync(AUTH, join(home, "auth.json"));
    writeFileSync(join(home, "config.toml"), `model = "${MODEL}"\nmodel_reasoning_effort = "low"\n\n[projects.'${process.platform === "win32" ? cwd.toLowerCase() : cwd}']\ntrust_level = "trusted"\n`);
    const daemonHome = tempHome(`[sessions]\ndiscover = false\ninstall_hooks = true\npoll_ms = 500\ncodex_list_ms = 2000\n\n[[profiles]]\nharness = "codex"\nname = "lab"\nconfig_dir = ${tomlString(home)}\n`);
    const { startDaemon } = await import("../../src/daemon.ts");
    const { silentLogger } = await import("../../src/log.ts");
    d = Object.assign(await startDaemon({ home: daemonHome, port: 0, log: silentLogger, brain: false }), { home: daemonHome });
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token, { name: "harness" });
    tui = await spawnTui(CODEX, ["--no-alt-screen", "-m", MODEL, "-c", 'model_reasoning_effort="low"', "-s", "read-only", "-c", "check_for_update_on_startup=false"], {
      cwd,
      env: scrubbedEnv({ CODEX_HOME: home }),
      rawLog: join(d.home, "codex.raw"),
    });
    await tui.waitFor(/›|❯|Ask Codex|Send a message|\?/i, 90_000);
  }, 180_000);

  afterAll(async () => {
    tui?.kill();
    c?.close();
    if (d) await stopDaemon(d);
    rmSync(scratch, { recursive: true, force: true });
  });

  test("cophylad's hooks are installed and trusted in the temp home only", () => {
    const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(hooks.hooks)).toHaveLength(6);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("trusted_hash");
    expect(existsSync(join(homedir(), ".codex", "hooks.json"))).toBe(false);
  });

  test(
    "the session is listed after its SessionStart hook",
    async () => {
      session = await waitFor(() => d.sessions.list().find((s) => s.harness === "codex" && samePath(s.cwd, cwd)), 90_000, 250);
      expect(session.profile).toBe(d.profiles.byHarness("codex")[0]!.id);
      expect(session.native.transport).toBe("app-server");
      const { sessions } = await c.request<{ sessions: Session[] }>("session.list", {});
      expect(sessions.map((s) => s.id)).toContain(session.id);
    },
    120_000,
  );

  test(
    "a sent message reaches the screen and its client_id receipt lands",
    async () => {
      const mark = tui.mark();
      const r = await c.request<{ status: string; ref: string }>("session.send", { id: session.id, text: "reply with the single word PONG" });
      expect(r.status).toBe("queued");
      await tui.waitFor(/relaying the user/, 15_000, mark);
      await waitFor(() => history().find((e) => e.kind === "notification" && (e.payload as { ref?: string; state?: string }).ref === r.ref && (e.payload as { state?: string }).state === "delivered"), 60_000, 250);
      await tui.waitFor(/PONG/, 120_000, mark);
      await waitFor(() => d.sessions.get(session.id)?.status === "idle", 60_000, 250);
    },
    240_000,
  );

  test(
    "a permission prompt is answered from the client",
    async () => {
      const mark = tui.mark();
      await c.request("session.send", { id: session.id, text: "Create a file named z.txt containing hello in the current directory, using a shell command. Then reply DONEZ." });
      const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && ((p as Ask).source as { session?: string }).session === session.id), 180_000);
      const ask = opened.params as Ask;
      expect(ask.type).toBe("permission");
      await c.request("ask.answer", { id: ask.id, option: "allow" });
      await tui.waitFor(/DONEZ/, 180_000, mark);
      await waitFor(() => existsSync(join(cwd, "z.txt")), 15_000, 250);
      const phases = history().filter((e) => e.kind === "ask" && (e.payload as { ask: string }).ask === ask.id).map((e) => (e.payload as { phase: string }).phase);
      expect(phases[0]).toBe("opened");
      expect(phases).toContain("answered");
    },
    400_000,
  );
});
