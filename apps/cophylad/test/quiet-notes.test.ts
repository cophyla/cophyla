// A quiet notice (a group chat's tag) for a session at work starts no turn: it waits for the
// session's next hook, which hands it over beside a tool's answer, keeps the turn going at its
// end, or goes beside its next prompt. A session at rest, one whose hooks were never heard, and
// one that comes to rest with a notice still waiting get it as a message.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import type { ClaudeHookEvent, CodexHookEvent, SessionEvent } from "@cophyla/protocol";
import type { EnvelopeInfo } from "../src/agentmsg/envelope.ts";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import { normaliseHook } from "../src/sessions/model.ts";
import type { SendOutcome, SessionRecord } from "../src/sessions/model.ts";
import { miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

/** Claude over its pipe, the messages it was given kept rather than sent. */
class RecordingClaude extends ClaudeAdapter {
  sent: { session: string; text: string }[] = [];
  override async send(rec: SessionRecord, text: string, _ref: string): Promise<SendOutcome> {
    this.sent.push({ session: rec.session.id, text });
    return { status: "queued" };
  }
}

let mini: Mini;
let claude: RecordingClaude;
let cwd: string;
let profile: string;
const unread = new Map<string, string>();

beforeAll(async () => {
  const scratch = tempHome();
  const profileDir = join(scratch, "claude-profile");
  cwd = join(scratch, "work");
  mkdirSync(join(profileDir, "sessions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
    (host, log) => [(claude = new RecordingClaude({ host, log, isAlive: () => true, sharedSettings: join(profileDir, "none.json") }))],
    {
      deps: {
        promptNote: async (s) => {
          const text = unread.get(s.id);
          unread.delete(s.id);
          return text;
        },
      },
    },
  );
  profile = mini.profiles.defaultFor("claude")!.id;
});

afterAll(() => mini.stop());

let pid = 700;
function session(nativeId: string) {
  return mini.sessions.ensure({ harness: "claude", nativeId, profile, cwd, transport: "pipe", pid: pid++, origin: "user" });
}

function hook(nativeId: string, name: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const e = { session_id: nativeId, transcript_path: join(cwd, `${nativeId}.jsonl`), cwd, hook_event_name: name, permission_mode: "default", ...extra } as ClaudeHookEvent;
  return mini.sessions.onHook("claude", e, { via: "http" });
}

const prompt = (nativeId: string) => hook(nativeId, "UserPromptSubmit", { prompt: "run the tests" });
let tool = 0;
const toolDone = (nativeId: string, extra: Record<string, unknown> = {}) => hook(nativeId, "PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" }, tool_use_id: `toolu_${++tool}`, ...extra });

function notice(group = "release"): EnvelopeInfo {
  return { messageId: newId("agentMessage"), group: { id: newId("group"), name: group } };
}

const TEXT = "@bob tagged you in #release (1 unread, 1 tagging you). read_group shows it when it suits your work; answer with post_group.";

function quiet(id: string, info = notice(), text = TEXT) {
  return mini.sessions.send(id, text, { from: "agent", agent: info, quiet: true });
}

const sentTo = (id: string) => claude.sent.filter((m) => m.session === id);
const turns = (id: string) => mini.store.sessionEvents.history(id, { limit: 100 }).filter((e: SessionEvent) => e.kind === "user_turn");

describe("a quiet notice", () => {
  test("for a session at work waits for its next tool's answer, goes beside it once, and is recorded as handed over", async () => {
    const rec = session("q-tool");
    await prompt("q-tool");
    const info = notice();
    const r = await quiet(rec.session.id, info);
    expect(r).toEqual({ status: "queued", ref: `note-${info.messageId}` });
    expect(sentTo(rec.session.id)).toHaveLength(0);

    const out = (await toolDone("q-tool")) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain(`<cophyla-message from="cophyla" group="release" id="${info.messageId}">`);
    expect(out.hookSpecificOutput.additionalContext).toContain(TEXT);
    expect(await toolDone("q-tool")).toEqual({});
    const told = turns(rec.session.id).find((e) => (e.payload as { messageId?: string }).messageId === info.messageId);
    expect(told?.payload).toMatchObject({ source: "agent", group: { name: "release" }, hook: true });
    expect(sentTo(rec.session.id)).toHaveLength(0);
  });

  test("keeps a turn going at its end, which ends at the next stop", async () => {
    const rec = session("q-stop");
    await prompt("q-stop");
    await quiet(rec.session.id);
    const out = (await hook("q-stop", "Stop", { stop_hook_active: false, last_assistant_message: "done" })) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain(TEXT);
    expect(mini.sessions.get(rec.session.id)?.status).toBe("busy");
    expect(await hook("q-stop", "Stop", { stop_hook_active: true, last_assistant_message: "read it" })).toEqual({});
    await waitFor(() => mini.sessions.get(rec.session.id)?.status === "idle");
    expect(sentTo(rec.session.id)).toHaveLength(0);
  });

  test("goes beside the next prompt, with what is unread in the session's groups", async () => {
    const rec = session("q-prompt");
    await prompt("q-prompt");
    await quiet(rec.session.id);
    unread.set(rec.session.id, "Unread in your group chats, which read_group shows when it suits your work: #team: 2 new posts.");
    const out = (await prompt("q-prompt")) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toMatch(/^<cophyla-message from="cophyla" group="release"[^]*<\/cophyla-message>\n\nUnread in your group chats/);
  });

  test("is a message for a session at rest, and for one whose hooks were never heard", async () => {
    const idle = session("q-idle");
    await prompt("q-idle");
    mini.sessions.setStatus(idle, "idle");
    await quiet(idle.session.id);
    expect(sentTo(idle.session.id)).toHaveLength(1);
    expect(sentTo(idle.session.id)[0]!.text).toContain(TEXT);

    const unheard = session("q-unheard");
    mini.sessions.setStatus(unheard, "busy");
    await quiet(unheard.session.id);
    expect(sentTo(unheard.session.id)).toHaveLength(1);
  });

  test("still waiting when the session comes to rest goes as a message", async () => {
    const rec = session("q-rest");
    await prompt("q-rest");
    await quiet(rec.session.id);
    expect(sentTo(rec.session.id)).toHaveLength(0);
    mini.sessions.setStatus(rec, "idle");
    await waitFor(() => sentTo(rec.session.id).length === 1);
    expect(sentTo(rec.session.id)[0]!.text).toContain(TEXT);
    // nothing waits after: a hook hands nothing over
    expect(await toolDone("q-rest")).toEqual({});
  });

  test("never goes beside a sub-agent's tool, and one about a group just read is dropped", async () => {
    const rec = session("q-sub");
    await prompt("q-sub");
    await quiet(rec.session.id);
    expect(await toolDone("q-sub", { agent_id: "agent_1" })).toEqual({});
    // still waiting for the session's own: a read of that group makes it stale
    expect(await toolDone("q-sub", { tool_name: "mcp__cophyla-agents__read_group", tool_input: { group: "#Release" } })).toEqual({});
    expect(await hook("q-sub", "Stop", { stop_hook_active: false })).toEqual({});
    // a read of another group leaves it be (at work again: at rest it would be a message)
    await prompt("q-sub");
    await quiet(rec.session.id);
    const other = (await toolDone("q-sub", { tool_name: "mcp__cophyla-agents__read_group", tool_input: { group: "team" } })) as { hookSpecificOutput?: { additionalContext: string } };
    expect(other.hookSpecificOutput?.additionalContext).toContain(TEXT);
  });
});

describe("a Codex sub-agent's hook", () => {
  test("is marked: it comes under the parent thread's id with the sub-agent's own rollout", () => {
    const parent = "01a163aa-a3bb-7f42-9cd9-a1f45ec8082d";
    const base = { session_id: parent, cwd: "C:/w", hook_event_name: "PostToolUse", tool_name: "exec_command", tool_input: {}, turn_id: "t1" };
    const own = normaliseHook("codex", { ...base, transcript_path: `C:/h/sessions/rollout-2026-10-22T12-00-00-${parent}.jsonl` } as unknown as CodexHookEvent);
    expect(own.subAgent).toBeUndefined();
    const sub = normaliseHook("codex", { ...base, transcript_path: "C:/h/sessions/rollout-2026-10-22T12-00-01-01a163ab-0000-7000-8000-000000000001.jsonl" } as unknown as CodexHookEvent);
    expect(sub.subAgent).toBe(true);
    expect(sub.transcriptPath).toBeUndefined();
  });
});
