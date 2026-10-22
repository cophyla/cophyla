// A prompt hook of an ordinary session hands the model what it has not read in its group chats,
// as added context, when there is something: Claude's and Codex's prompt hooks take it; nothing
// else changes about the prompt, and a session with nothing new gets an empty answer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeHookEvent, Session } from "@cophyla/protocol";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import { miniSessions, tempHome, tomlString } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

let mini: Mini;
let cwd: string;
let profile: string;
const notes = new Map<string, string>();
const asked: string[] = [];

beforeAll(async () => {
  const scratch = tempHome();
  const profileDir = join(scratch, "claude-profile");
  cwd = join(scratch, "work");
  mkdirSync(join(profileDir, "sessions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mini = await miniSessions(
    `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
    (host, log) => [new ClaudeAdapter({ host, log, isAlive: () => true, sharedSettings: join(profileDir, "none.json") })],
    {
      deps: {
        promptNote: async (s: Session) => {
          asked.push(s.id);
          const text = notes.get(s.id);
          notes.delete(s.id);
          return text;
        },
      },
    },
  );
  profile = mini.profiles.defaultFor("claude")!.id;
});

afterAll(() => mini.stop());

function hook(nativeId: string, extra: Record<string, unknown> = {}): ClaudeHookEvent {
  return { session_id: nativeId, transcript_path: join(cwd, `${nativeId}.jsonl`), cwd, hook_event_name: "UserPromptSubmit", permission_mode: "default", prompt: "run the tests", ...extra } as ClaudeHookEvent;
}

describe("a prompt hook", () => {
  test("hands over what the session has not read in its groups, once, and nothing when there is none", async () => {
    const rec = mini.sessions.ensure({ harness: "claude", nativeId: "p-1", profile, cwd, transport: "pipe", pid: 500, origin: "user" });
    notes.set(rec.session.id, "Unread in your group chats, which read_group shows when it suits your work: #team: 2 new posts.");
    const first = await mini.sessions.onHook("claude", hook("p-1"), { via: "http" });
    expect(first).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Unread in your group chats, which read_group shows when it suits your work: #team: 2 new posts." } });
    expect(await mini.sessions.onHook("claude", hook("p-1", { prompt: "and now the build" }), { via: "http" })).toEqual({});
    expect(asked.filter((id) => id === rec.session.id)).toHaveLength(2);
    // the prompt itself is recorded as ever
    expect(mini.sessions.get(rec.session.id)?.status).toBe("busy");
  });
});
