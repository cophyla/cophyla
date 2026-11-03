// A Codex thread's sub-agents, as the chat's agent panel and cards read them: the spawn call names
// each one's type and task, its start its own thread, and its own rollout, read while it works,
// says how far it has got; its turn's end, or the thread's word that it completed, ends it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexChildren, codexCallWords } from "../src/sessions/codex/children.ts";

let home: string;
let file: string;
const THREAD = "019a0c55-7d1e-7c41-9b5e-000000000042";
const t = (s: number) => new Date(Date.UTC(2026, 10, 3, 9, 0, s)).toISOString();
const line = (row: unknown) => JSON.stringify(row) + "\n";
const call = (s: number, name: string, args: unknown) => line({ timestamp: t(s), type: "response_item", payload: { type: "function_call", name, arguments: JSON.stringify(args), call_id: `c${s}` } });
const custom = (s: number, name: string, input: string) => line({ timestamp: t(s), type: "response_item", payload: { type: "custom_tool_call", name, input, call_id: `x${s}` } });
const event = (s: number, payload: Record<string, unknown>) => line({ timestamp: t(s), type: "event_msg", payload });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-children-"));
  const day = join(home, "sessions", "2026", "11", "03");
  mkdirSync(day, { recursive: true });
  file = join(day, `rollout-2026-11-03T09-00-00-${THREAD}.jsonl`);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("a Codex thread's sub-agents", () => {
  test("from its spawn to its end: its type and task, then each step its own rollout shows, its model and context, read every few seconds", () => {
    const kids = new CodexChildren();
    const start = Date.parse(t(0));
    kids.spawned("call_9", { task_name: "review_v3_abc", agent_type: "worker", message: "gAAAAB-sealed" }, start);
    expect(kids.list()).toEqual([{ call: "call_9", type: "worker", description: "review v3 abc", steps: 0, startedAt: start, lastAt: start }]);
    kids.started("call_9", "/root/review_v3_abc", THREAD, Date.parse(t(1)));
    expect(kids.working).toBe(true);
    // Its rollout is not written yet: nothing changes, and it is looked for again later.
    expect(kids.read(home, 10_000)).toBe(false);
    writeFileSync(
      file,
      line({ timestamp: t(1), type: "turn_context", payload: { model: "gpt-6.1-sol", cwd: "C:\\w" } }) +
        event(1, { type: "task_started", turn_id: "tu1", model_context_window: 200_000 }) +
        call(2, "exec_command", { cmd: "rg -n todo src" }) +
        event(3, { type: "token_count", info: { total_token_usage: { input_tokens: 9000, output_tokens: 300, total_tokens: 9300 }, last_token_usage: { total_tokens: 9300 }, model_context_window: 200_000 } }),
    );
    // Read too soon after the last look: left for the next.
    expect(kids.read(home, 11_000)).toBe(false);
    expect(kids.read(home, 13_000)).toBe(true);
    expect(kids.list()[0]).toMatchObject({ agent: THREAD, steps: 1, last: "Run rg -n todo src", model: "gpt-6.1-sol", tokens: 9300, window: 200_000, lastAt: Date.parse(t(2)) });
    // Code mode's script, by the tool it calls; then its turn ends, and so does it.
    appendFileSync(file, custom(4, "exec", 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: a.ts\\n");') + event(5, { type: "task_complete", turn_id: "tu1", last_agent_message: "Done." }));
    expect(kids.read(home, 16_000)).toBe(true);
    expect(kids.list()[0]).toMatchObject({ steps: 2, last: "Edit files", finished: true, lastAt: Date.parse(t(5)) });
    expect(kids.working).toBe(false);
    // Ended, it is not read again.
    appendFileSync(file, call(6, "exec_command", { cmd: "ls" }));
    expect(kids.read(home, 30_000)).toBe(false);
  });

  test("the thread's word that one completed ends it, by its thread or else its path; one started again works again", () => {
    const kids = new CodexChildren();
    kids.started("call_1", "/root/first_one", "th-a", 1000);
    kids.started("call_2", "/root/second", undefined, 1000);
    expect(kids.list().map((k) => [k.call, k.description, k.finished ?? false])).toEqual([["call_1", "first one", false], ["call_2", "second", false]]);
    kids.completed("/root/first_one", "th-a", 2000);
    kids.completed("/root/second", "th-b", 2500);
    expect(kids.list().map((k) => [k.call, k.finished ?? false, k.lastAt])).toEqual([["call_1", true, 2000], ["call_2", true, 2500]]);
    kids.started("call_1", "/root/first_one", "th-a", 3000);
    expect(kids.list()[0]!.finished).toBeUndefined();
  });

  test("a sub-agent whose rollout is never found is looked for a minute, then let be", () => {
    const kids = new CodexChildren();
    kids.started("call_1", "/root/gone", "th-none", 0);
    expect(kids.read(home, 5_000)).toBe(false);
    expect(kids.read(home, 70_000)).toBe(false);
    // Written late, past the minute it was looked for: not read.
    writeFileSync(join(home, "sessions", "2026", "11", "03", "rollout-x-th-none.jsonl"), call(1, "exec_command", { cmd: "ls" }));
    expect(kids.read(home, 80_000)).toBe(false);
  });

  test("a call in a few words: a command by its line, code mode by the tool its script calls", () => {
    expect(codexCallWords("exec_command", { cmd: "bun test\nmore" })).toBe("Run bun test");
    expect(codexCallWords("shell", { command: ["bash", "-lc", "ls -la"] })).toBe("Run bash -lc ls -la");
    expect(codexCallWords("exec", 'await tools.exec_command({ cmd: "git status" })')).toBe("Run git status");
    expect(codexCallWords("exec", "await tools.view_image({ path: 'a.png' })")).toBe("View an image");
    expect(codexCallWords("exec", "await tools.mcp__cophyla__send_message({})")).toBe("send_message");
    expect(codexCallWords("apply_patch", "*** Begin Patch")).toBe("Edit files");
    expect(codexCallWords("web_search", { query: "codex sub-agents" })).toBe("web_search codex sub-agents");
  });
});
