// Milestone 1 against a real Claude Code terminal: the daemon runs in a temp home with hooks
// not installed; the session loads cophylad's http hooks from a temp settings file passed with
// --settings, so nothing under ~/.claude is written. Needs COPHYLA_HARNESS_TESTS=1 and a login.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ask, Session, SessionEvent } from "@cophyla/protocol";
import { withCophyladHooks } from "../../src/sessions/claude/hooks.ts";
import type { Daemon } from "../../src/daemon.ts";
import { samePath } from "../../src/sessions/paths.ts";
import { isMethod, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "../helpers.ts";
import { CLAUDE, HARNESS, scrubbedEnv, sleep, spawnTui } from "./pty.ts";
import type { Tui } from "./pty.ts";

const run = HARNESS && existsSync(CLAUDE);
const NAME = `cophyla-test-${Date.now().toString(36)}`;

describe.skipIf(!run)("harness: claude", () => {
  let d: Daemon & { home: string };
  let c: TestClient;
  let tui: Tui;
  let cwd: string;
  let settingsPath: string;
  let session: Session;
  const history = (): SessionEvent[] => d.store.sessionEvents.history(session.id, { limit: 1000 });

  const startClaude = async (extra: string[] = []) => {
    const t = await spawnTui(CLAUDE, ["--name", NAME, "--model", "haiku", "--permission-mode", "manual", "--settings", settingsPath, ...extra], { cwd, env: scrubbedEnv(), rawLog: join(d.home, "claude.raw") });
    // A fresh directory asks for trust first; the prompt box means the session is up.
    for (let i = 0; i < 3; i++) {
      const m = await t.waitFor(/trust|Yes, proceed|Enter to confirm|›|❯|>\s*$/i, 90_000, t.mark() - 4000);
      if (/trust|proceed|confirm/i.test(m[0]) && !/›|❯/.test(t.text(300))) {
        t.write("\r");
        await sleep(1500);
        continue;
      }
      break;
    }
    return t;
  };

  beforeAll(async () => {
    const scratch = tempHome();
    cwd = join(scratch, "work");
    mkdirSync(cwd, { recursive: true });
    const home = tempHome(`[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 500\n\n[[profiles]]\nharness = "claude"\nname = "home"\nconfig_dir = ${tomlString(join(homedir(), ".claude"))}\n`);
    const { startDaemon } = await import("../../src/daemon.ts");
    const { silentLogger } = await import("../../src/log.ts");
    d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false }), { home });
    settingsPath = join(scratch, "settings.json");
    const profile = d.profiles.byHarness("claude")[0]!;
    writeFileSync(settingsPath, JSON.stringify(withCophyladHooks({}, { mode: "http", url: `http://127.0.0.1:${d.api.port}/hooks/claude`, token: d.hookToken, timeoutS: 7200, profileId: profile.id }), null, 2));
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token, { name: "harness" });
    tui = await startClaude();
  }, 180_000);

  afterAll(async () => {
    tui?.kill();
    c?.close();
    if (d) await stopDaemon(d);
  });

  test(
    "the session is listed idle under the ~/.claude profile",
    async () => {
      const found = await waitFor(() => d.sessions.list().find((s) => samePath(s.cwd, cwd)), 60_000, 250);
      session = found;
      expect(session.harness).toBe("claude");
      expect(session.profile).toBe(d.profiles.byHarness("claude")[0]!.id);
      expect(session.native.pid).toBeGreaterThan(0);
      await waitFor(() => d.sessions.get(session.id)?.status === "idle", 30_000, 250);
      const { sessions } = await c.request<{ sessions: Session[] }>("session.list", {});
      expect(sessions.map((s) => s.id)).toContain(session.id);
    },
    90_000,
  );

  test(
    "a message is delivered, its Write prompt is answered from the client, and the file appears",
    async () => {
      const mark = tui.mark();
      const r = await c.request<{ status: string; ref: string }>("session.send", { id: session.id, text: "Use the Write tool to create x.txt containing hello, then reply DONE" });
      expect(r.status).toBe("queued");
      await waitFor(() => history().find((e) => e.kind === "notification" && (e.payload as { ref?: string; state?: string }).ref === r.ref && (e.payload as { state?: string }).state === "delivered"), 60_000, 250);
      const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && ((p as Ask).source as { session?: string }).session === session.id), 120_000);
      const ask = opened.params as Ask;
      expect(ask.title.startsWith("Write in ")).toBe(true);
      await waitFor(() => d.sessions.get(session.id)?.status === "needs_permission", 5_000, 100);
      // The terminal shows its own dialog beside the held hook.
      await tui.waitFor(/Do you want|Yes/i, 30_000, mark);
      await c.request("ask.answer", { id: ask.id, option: "allow" });
      await tui.waitFor(/DONE/, 120_000, mark);
      await waitFor(() => existsSync(join(cwd, "x.txt")), 10_000, 250);
      expect(readFileSync(join(cwd, "x.txt"), "utf8")).toContain("hello");
      await waitFor(() => d.sessions.get(session.id)?.status === "idle", 60_000, 250);
      const phases = history().filter((e) => e.kind === "ask" && (e.payload as { ask: string }).ask === ask.id).map((e) => (e.payload as { phase: string }).phase);
      expect(phases).toEqual(["opened", "answered"]);
    },
    300_000,
  );

  test(
    "a prompt answered in the terminal closes the ask on the next event",
    async () => {
      const mark = tui.mark();
      const r = await c.request<{ status: string; ref: string }>("session.send", { id: session.id, text: "Use the Write tool to create y.txt containing hello, then reply DONE2" });
      const opened = await c.next(isMethod("ask.state", (p) => (p as Ask).status === "open" && ((p as Ask).source as { session?: string }).session === session.id && (p as Ask).detail!.includes("y.txt")), 120_000);
      const ask = opened.params as Ask;
      await tui.waitFor(/Do you want|Yes/i, 30_000, mark);
      tui.write("\r");
      const closed = await c.next(isMethod("ask.state", (p) => (p as Ask).id === ask.id && (p as Ask).status !== "open"), 120_000);
      expect((closed.params as Ask).status).toBe("cancelled");
      await tui.waitFor(/DONE2/, 120_000, mark);
      const close = history().find((e) => e.kind === "ask" && (e.payload as { ask: string; phase: string }).ask === ask.id && (e.payload as { phase: string }).phase === "closed");
      expect(["terminal", "stopped"]).toContain((close!.payload as { reason: string }).reason);
      void r;
      await waitFor(() => d.sessions.get(session.id)?.status === "idle", 60_000, 250);
    },
    300_000,
  );

  test(
    "exit ends the session; resume keeps its id under a new pid",
    async () => {
      const oldPid = d.sessions.get(session.id)!.native.pid!;
      const nativeId = session.native.id;
      await tui.submit("/exit");
      await waitFor(() => tui.exited !== null, 60_000, 250);
      await waitFor(() => d.store.sessions.get(session.id)?.status === "ended", 30_000, 250);
      tui = await startClaude(["--resume", nativeId]);
      await waitFor(() => d.sessions.list().some((s) => s.id === session.id && s.status !== "ended"), 90_000, 250);
      const again = d.sessions.get(session.id)!;
      expect(again.native.id).toBe(nativeId);
      expect(again.native.pid).not.toBe(oldPid);
      expect(again.endedAt).toBeUndefined();
      await tui.submit("/exit");
      await waitFor(() => d.store.sessions.get(session.id)?.status === "ended", 60_000, 250);
    },
    300_000,
  );
});
