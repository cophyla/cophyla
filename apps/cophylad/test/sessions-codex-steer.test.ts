// A message steered into a running Codex turn through the managed daemon's control socket, over
// the fake proxy (fakes/codex-proxy.ts): it goes in under the turn the rollout named, or under
// the one the daemon names back when that turn has moved on; a long message crosses intact in
// the frame lengths a WebSocket has; and no daemon, a thread the daemon has not loaded, or one
// with no turn running is a steer not made, with the reason, so the message is queued instead.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { steerTurn } from "../src/sessions/codex/control.ts";
import type { SteerOptions } from "../src/sessions/codex/control.ts";
import { FAKE_CODEX, removeHome, tempHome } from "./helpers.ts";

const THREAD = "01a15961-4d2c-7883-8567-12aad88eba14";
const TURN = "01a15961-4fee-7413-bba2-6ac156a647e1";

describe("steering a running Codex turn", () => {
  let scratch: string;
  let home: string;
  let opts: SteerOptions;
  const daemon = (threads: Record<string, string | null> | undefined) => {
    const path = join(home, "daemon.json");
    if (threads) writeFileSync(path, JSON.stringify(threads));
    else if (existsSync(path)) rmSync(path);
  };
  const steered = () => {
    const path = join(home, "steer.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { threadId: string; expectedTurnId: string; clientUserMessageId: string; input: { type: string; text: string }[] }[]) : [];
  };

  beforeAll(() => {
    scratch = tempHome();
    home = join(scratch, "codex-home");
    mkdirSync(home, { recursive: true });
    opts = { command: process.execPath, args: [FAKE_CODEX], env: { ...process.env, CODEX_HOME: home }, version: "0.1.0" };
  });
  afterAll(() => removeHome(scratch));

  test("with no daemon listening, nothing is steered and the proxy's error is the reason", async () => {
    daemon(undefined);
    const r = await steerTurn(opts, THREAD, TURN, "hello", "cophylad-1");
    expect(r.steered).toBe(false);
    expect(!r.steered && r.reason).toContain("failed to connect");
  });

  test("a thread the daemon runs takes the message into its turn, under cophylad's ref", async () => {
    daemon({ [THREAD]: TURN });
    const r = await steerTurn(opts, THREAD, TURN, "look at the failing test too", "cophylad-2");
    expect(r).toEqual({ steered: true, turnId: TURN });
    expect(steered().at(-1)).toEqual({ threadId: THREAD, expectedTurnId: TURN, clientUserMessageId: "cophylad-2", input: [{ type: "text", text: "look at the failing test too" }] });
  });

  test("a turn that moved on since the rollout named it is steered under the one the daemon names", async () => {
    const next = "01a15962-0000-7000-8000-000000000000";
    daemon({ [THREAD]: next });
    const before = steered().length;
    const r = await steerTurn(opts, THREAD, TURN, "and the next one", "cophylad-3");
    expect(r).toEqual({ steered: true, turnId: next });
    expect(steered()).toHaveLength(before + 1);
    expect(steered().at(-1)!.expectedTurnId).toBe(next);
  });

  test("a long message crosses whole, in both extended frame lengths", async () => {
    daemon({ [THREAD]: TURN });
    for (const size of [300, 70000]) {
      const text = "é".repeat(size);
      const r = await steerTurn(opts, THREAD, TURN, text, `cophylad-long-${size}`);
      expect(r.steered).toBe(true);
      expect(steered().at(-1)!.input[0]!.text).toBe(text);
    }
  });

  test("a thread with no turn running, or one the daemon has not loaded, is not steered", async () => {
    daemon({ [THREAD]: null });
    const idle = await steerTurn(opts, THREAD, TURN, "hello", "cophylad-4");
    expect(idle).toEqual({ steered: false, reason: "no active turn to steer" });
    daemon({});
    const elsewhere = await steerTurn(opts, THREAD, TURN, "hello", "cophylad-5");
    expect(elsewhere).toEqual({ steered: false, reason: `thread not found: ${THREAD}` });
  });
});
