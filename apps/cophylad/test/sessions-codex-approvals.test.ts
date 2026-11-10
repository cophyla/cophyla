// A Codex approval request, through its PermissionRequest hook. Codex runs the hook before its
// own reviewer and before what the user allowed for the session, and shows nothing while the
// hook is held. So one whose turn Codex's reviewer judges (`approvals_reviewer = "auto_review"`,
// once `guardian_subagent`) is the reviewer's: answered with no decision at once, no ask. A
// sub-agent's goes by its own rollout's turn, and the last turn of a thread is the one that
// counts. One the user reviews is held as an ask that also offers "Allow for this session": a
// command allowed so is allowed unasked again in that session and folder, whatever reason the
// model gives for it, until the session ends; a plain Allow is for that once.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ask, CodexHookEvent } from "@cophyla/protocol";
import { CodexAdapter } from "../src/sessions/codex/adapter.ts";
import { FAKE_CODEX, miniSessions, removeHome, sleep, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const USER = { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" } as const;
const THREAD = "01a0c000-1111-7222-8333-444455556666";
const CHILD = "01a0c000-2222-7333-8444-555566667777";
const ALLOWED = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };

describe("a codex approval request", () => {
  let scratch: string;
  let cwd: string;
  let rollout: string;
  let childRollout: string;
  let mini: Mini;

  const turnContext = (reviewer?: string) =>
    JSON.stringify({ timestamp: new Date().toISOString(), type: "turn_context", payload: { cwd, approval_policy: "on-request", ...(reviewer ? { approvals_reviewer: reviewer } : {}), sandbox_policy: { type: "workspace-write" }, model: "gpt-5.6-luna" } }) + "\n";
  const request = (command: string, opts: { thread?: string; path?: string; at?: string; why?: string } = {}): CodexHookEvent => ({
    hook_event_name: "PermissionRequest",
    session_id: opts.thread ?? THREAD,
    turn_id: "turn-1",
    cwd: opts.at ?? cwd,
    model: "gpt-5.6-luna",
    permission_mode: "default",
    transcript_path: opts.path ?? rollout,
    tool_name: "Bash",
    tool_input: { command, description: opts.why ?? "Needs to run outside the sandbox" },
  });
  const hook = (event: CodexHookEvent) => mini.sessions.onHook("codex", event, { via: "command", profile: mini.profiles.byHarness("codex")[0]!.id });
  const openAsks = (): Ask[] => mini.asks.listOpen().filter((a) => a.source.kind === "harness");
  /** What the hook answered within a moment, or "held". */
  const soon = (p: Promise<unknown>) => Promise.race([p, sleep(150).then(() => "held")]);
  /** The next ask a held request opens, answered with `option`; the hook's answer. */
  const answered = async (p: Promise<unknown>, option: string) => {
    const opened = await waitFor(() => openAsks()[0]);
    mini.asks.answer(opened.id, { option }, USER);
    return { ask: opened, answer: await p };
  };

  beforeAll(async () => {
    scratch = tempHome();
    const home = join(scratch, "codex-home");
    cwd = join(scratch, "work");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(scratch, "other"), { recursive: true });
    const dir = join(home, "sessions", "2026", "11", "10");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    rollout = join(dir, `rollout-2026-11-10T09-00-00-${THREAD}.jsonl`);
    childRollout = join(dir, `rollout-2026-11-10T09-05-00-${CHILD}.jsonl`);
    const meta = (id: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id, session_id: id, timestamp: new Date().toISOString(), cwd, originator: "codex-tui", cli_version: "0.167.0" } }) + "\n";
    writeFileSync(rollout, meta(THREAD) + turnContext("auto_review"));
    writeFileSync(childRollout, meta(CHILD) + turnContext("auto_review"));
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = true\npoll_ms = 100000\ncodex_list_ms = 1\n\n[[profiles]]\nharness = "codex"\nname = "fake"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`,
      (host, log) => [new CodexAdapter({ host, log, version: "0.1.0" })],
    );
  });
  afterAll(async () => {
    await mini.stop();
    removeHome(scratch);
  });

  test("one whose turn Codex's own reviewer judges is answered with no decision at once, and no ask opens", async () => {
    expect(await soon(hook(request("cargo build")))).toEqual({});
    expect(openAsks()).toEqual([]);
    const rec = mini.sessions.find("codex", THREAD)!;
    expect(rec.session.status).not.toBe("needs_permission");
    // the reviewer's name of old
    appendFileSync(rollout, turnContext("guardian_subagent"));
    expect(await soon(hook(request("cargo test")))).toEqual({});
    expect(openAsks()).toEqual([]);
  });

  test("the thread's last turn counts, and a sub-agent's request goes by its own turn", async () => {
    appendFileSync(rollout, turnContext("user"));
    const parent = hook(request("cargo fmt"));
    expect(await soon(parent)).toBe("held");
    expect(mini.sessions.find("codex", THREAD)!.session.status).toBe("needs_permission");
    expect((await answered(parent, "deny")).answer).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    // the sub-agent's hook comes under its parent's id, with its own rollout
    expect(await soon(hook(request("cargo fmt", { path: childRollout })))).toEqual({});
    expect(openAsks()).toEqual([]);
    // a turn that names no reviewer is the user's
    appendFileSync(childRollout, turnContext());
    const child = hook(request("cargo fmt", { path: childRollout }));
    expect(await soon(child)).toBe("held");
    await answered(child, "deny");
  });

  test("one the user reviews offers Allow for this session; the same command in that folder is then allowed unasked, whatever reason is given", async () => {
    const first = await answered(hook(request("cargo build --release")), "allow_session");
    expect(first.ask.options.map((o) => o.id)).toEqual(["allow", "allow_session", "deny"]);
    expect(first.ask.options[1]!.label).toBe("Allow for this session");
    expect(first.answer).toEqual(ALLOWED);
    expect(await soon(hook(request("cargo build --release", { why: "Rebuild after the fix" })))).toEqual(ALLOWED);
    expect(openAsks()).toEqual([]);
    expect(mini.sessions.find("codex", THREAD)!.session.status).not.toBe("needs_permission");
    // the same command in another folder is asked again
    const elsewhere = hook(request("cargo build --release", { at: join(scratch, "other") }));
    expect(await soon(elsewhere)).toBe("held");
    await answered(elsewhere, "deny");
  });

  test("a plain Allow is for that once, and another command is asked for", async () => {
    const once = await answered(hook(request("cargo clean")), "allow");
    expect(once.answer).toEqual(ALLOWED);
    const again = hook(request("cargo clean"));
    expect(await soon(again)).toBe("held");
    const second = await answered(again, "deny");
    expect(second.ask.id).not.toBe(once.ask.id);
  });

  test("a command allowed for the session already does not close another request's open ask", async () => {
    const open = hook(request("cargo doc"));
    const shown = await waitFor(() => openAsks()[0]);
    expect(await soon(hook(request("cargo build --release")))).toEqual(ALLOWED);
    expect(mini.asks.getAny(shown.id)?.status).toBe("open");
    mini.asks.answer(shown.id, { option: "allow" }, USER);
    expect(await open).toEqual(ALLOWED);
  });

  test("what was allowed for the session ends with it", async () => {
    await hook({ hook_event_name: "SessionEnd", session_id: THREAD, cwd, reason: "exit" });
    const after = hook(request("cargo build --release"));
    expect(await soon(after)).toBe("held");
    await answered(after, "deny");
  });
});
