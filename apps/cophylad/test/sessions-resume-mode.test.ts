// The mode a closed session was last in, read back from what its harness saved, for a reopen to
// start it in again: the last line of a JSONL file that answers, read from its end however
// long its lines run; a Claude transcript's last permission mode, from a prompt row or a
// turn's `permission-mode` row, whichever came last; a Codex rollout's last turn context.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastPermissionMode } from "../src/sessions/claude/transcript.ts";
import { lastTurnContext } from "../src/sessions/codex/rollout.ts";
import { lastLineWhere } from "../src/sessions/tail.ts";
import { tempHome } from "./helpers.ts";

const dir = tempHome();
let n = 0;

function file(lines: unknown[], opts: { crlf?: boolean; trailing?: string } = {}): string {
  const path = join(dir, `f${n++}.jsonl`);
  const nl = opts.crlf ? "\r\n" : "\n";
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + nl).join("") + (opts.trailing ?? ""));
  return path;
}

describe("lastLineWhere", () => {
  test("finds the last line that answers, not an earlier one", () => {
    const path = file([{ k: 1 }, { k: 2, hit: true }, { k: 3, hit: true }, { k: 4 }]);
    expect(lastLineWhere(path, (t) => t.includes('"hit"'))).toBe(JSON.stringify({ k: 3, hit: true }));
  });

  test("reads lines longer than a chunk, the file's first line, and CRLF endings", () => {
    const long = "x".repeat(3 * 1024 * 1024);
    const path = file([{ first: true }, { big: long }, { big: long }], { crlf: true });
    expect(lastLineWhere(path, (t) => t.includes('"first"'))).toBe(JSON.stringify({ first: true }));
    expect(lastLineWhere(path, (t) => t.includes('"big"'))?.length).toBe(JSON.stringify({ big: long }).length);
  });

  test("a partial line being written is not taken whole, and none answering, a missing file or a window too small is undefined", () => {
    const path = file([{ k: 1, hit: true }], { trailing: '{"k":2,"hit":tr' });
    expect(lastLineWhere(path, (t) => t.includes('"hit"') && t.endsWith("}"))).toBe(JSON.stringify({ k: 1, hit: true }));
    expect(lastLineWhere(path, (t) => t.includes('"nothing"'))).toBeUndefined();
    expect(lastLineWhere(join(dir, "missing.jsonl"), () => true)).toBeUndefined();
    const far = file([{ hit: true }, { pad: "y".repeat(4096) }]);
    expect(lastLineWhere(far, (t) => t.includes('"hit"'), 1024)).toBeUndefined();
    expect(lastLineWhere(file([]), () => true)).toBeUndefined();
  });
});

describe("a Claude transcript's last permission mode", () => {
  const prompt = (mode: string, text = "go on") => ({ type: "user", message: { role: "user", content: text }, permissionMode: mode });
  const turn = (mode: string) => ({ type: "permission-mode", permissionMode: mode, sessionId: "s" });
  const reply = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: 'it said "permissionMode":"plan"' }] } };

  test("is the last row's that says one: a turn's row after a prompt's, a prompt's after a turn's", () => {
    expect(lastPermissionMode(file([prompt("default"), turn("bypassPermissions"), reply]))).toBe("bypassPermissions");
    expect(lastPermissionMode(file([turn("bypassPermissions"), prompt("acceptEdits"), reply]))).toBe("acceptEdits");
  });

  test("takes the CLI's spellings, and is undefined for a transcript that says none", () => {
    expect(lastPermissionMode(file([prompt("manual")]))).toBe("default");
    expect(lastPermissionMode(file([{ type: "user", message: { role: "user", content: "hi" } }, reply]))).toBeUndefined();
    expect(lastPermissionMode(file([{ type: "summary", permissionMode: "plan" }]))).toBeUndefined();
  });
});

describe("a Codex rollout's last turn context", () => {
  const context = (approval: string, sandbox: string) => ({ timestamp: "2026-10-29T18:00:00Z", type: "turn_context", payload: { cwd: "C:/work", approval_policy: approval, sandbox_policy: { type: sandbox }, model: "gpt-5" } });

  test("is the last turn's approval and sandbox", () => {
    const path = file([context("on-request", "workspace-write"), { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }, context("never", "danger-full-access"), { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }]);
    expect(lastTurnContext(path)).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });

  test("is undefined for a rollout with none", () => {
    expect(lastTurnContext(file([{ type: "session_meta", payload: { id: "t", cwd: "C:/work" } }]))).toBeUndefined();
  });
});
