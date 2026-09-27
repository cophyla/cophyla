// The quote projection: each quotable action's result becomes numbered entries whose numbers
// are the ones the model saw, and a selection narrows the source to the lines it took.

import { describe, expect, test } from "bun:test";
import type { Hit, Message, SessionEvent } from "../src/entities.ts";
import { bodyLines, messageText, numberedLines, quotable, selectLines, sessionEventText } from "../src/quotes.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const THREAD = "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3";

describe("quotable", () => {
  test("fs.read: the n\\t prefix is parsed off and the file is the source", () => {
    const q = quotable("tool.run", { name: "fs.read", args: { path: "a.md" } }, { result: { path: "C:\\a.md", from: 10, to: 12, total: 40, text: "10\t# Title\n11\t\n12\tbody line" } }, NODE);
    expect(q).toBeDefined();
    expect(q!.lines).toEqual([
      { n: 10, text: "# Title" },
      { n: 11, text: "" },
      { n: 12, text: "body line" },
    ]);
    expect(q!.source).toEqual({ kind: "file", node: NODE, path: "C:\\a.md" });
    const sel = selectLines(q!, [11, 12]);
    expect(sel).toEqual({ text: "\nbody line", source: { kind: "file", node: NODE, path: "C:\\a.md", lines: [11, 12] } });
  });

  test("fs.grep uses the same rows; other tools and a missing text are not quotable", () => {
    const q = quotable("tool.run", { name: "fs.grep", args: { path: "a.md", pattern: "x" } }, { result: { path: "C:\\a.md", text: "3\tx marks\n9\tthe x" } }, NODE);
    expect(q!.lines.map((l) => l.n)).toEqual([3, 9]);
    expect(quotable("tool.run", { name: "fs.glob", args: {} }, { result: { files: [] } }, NODE)).toBeUndefined();
    expect(quotable("tool.run", { name: "fs.read", args: {} }, { result: "not an object" }, NODE)).toBeUndefined();
    expect(quotable("node.list", {}, { nodes: [] }, NODE)).toBeUndefined();
  });

  test("session.history: one entry per event, n is the seq, source is the session with the seq range", () => {
    const events: SessionEvent[] = [
      { session: SESSION, seq: 4, at: 1, kind: "user_turn", payload: { text: "fix the bug" } },
      { session: SESSION, seq: 5, at: 2, kind: "tool_call", payload: { tool: "Read", args: { file_path: "x.ts" } } },
      { session: SESSION, seq: 6, at: 3, kind: "tool_result", payload: { tool: "Read", result: "ok", isError: true } },
      { session: SESSION, seq: 7, at: 4, kind: "assistant_text", payload: { text: "Done.\nTwo lines." } },
      { session: SESSION, seq: 8, at: 5, kind: "status", payload: { status: "idle" } },
      { session: SESSION, seq: 9, at: 6, kind: "ask", payload: { ask: "ask_1", phase: "opened", tool: "Bash" } },
      { session: SESSION, seq: 10, at: 7, kind: "notification", payload: { type: "message", text: "hi" } },
      { session: SESSION, seq: 11, at: 8, kind: "ended", payload: { reason: "exit" } },
    ];
    const q = quotable("session.history", { id: SESSION, limit: 20 }, { events }, NODE)!;
    expect(q.lines.map((l) => l.n)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(q.lines.map((l) => l.text)).toEqual([
      "fix the bug",
      '→ Read {"file_path":"x.ts"}',
      "← Read (error): ok",
      "Done.\nTwo lines.",
      "[idle]",
      "? ask opened: Bash",
      "· message: hi",
      "· ended (exit)",
    ]);
    expect(q.source).toEqual({ kind: "session", session: SESSION });
    expect(selectLines(q, [7, 7])).toEqual({ text: "Done.\nTwo lines.", source: { kind: "session", session: SESSION, seq: [7, 7] } });
    // A range wider than what exists narrows to what was picked; a reversed range is the same range.
    expect(selectLines(q, [11, 9])!.source).toEqual({ kind: "session", session: SESSION, seq: [9, 11] });
    expect(selectLines(q, [0, 20])!.source).toEqual({ kind: "session", session: SESSION, seq: [4, 11] });
    expect(selectLines(q, [20, 30])).toBeUndefined();
    expect(selectLines(q, undefined)!.source).toEqual({ kind: "session", session: SESSION, seq: [4, 11] });
  });

  test("thread.history: n is the index, the source names the first selected message", () => {
    const messages: Message[] = [
      { id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB5", thread: THREAD, at: 1, role: "user", source: "ui", content: [{ type: "text", text: "what happened" }] },
      {
        id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4",
        thread: THREAD,
        at: 2,
        role: "orchestrator",
        source: "brain",
        content: [
          { type: "text", text: "It said:" },
          { type: "quote", text: "a\nb", source: { kind: "session", session: SESSION } },
          { type: "ref", session: SESSION },
        ],
      },
    ];
    const q = quotable("thread.history", { id: THREAD }, { messages }, NODE)!;
    expect(q.lines).toEqual([
      { n: 0, text: "what happened", message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB5" },
      { n: 1, text: `It said:\n> a\n> b\n[ref ${SESSION}]`, message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4" },
    ]);
    expect(selectLines(q, [1, 1])).toEqual({ text: `It said:\n> a\n> b\n[ref ${SESSION}]`, source: { kind: "thread", thread: THREAD, message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4" } });
  });

  test("memory.read numbers body lines from 1 with a memory source; prompt.read has no source", () => {
    const m = quotable("memory.read", { name: "user" }, { memory: { name: "user", tags: [], body: "line one\nline two\nline three", updatedAt: 1 } }, NODE)!;
    expect(m.lines).toEqual(bodyLines("line one\nline two\nline three"));
    expect(selectLines(m, [2, 3])).toEqual({ text: "line two\nline three", source: { kind: "memory", name: "user", lines: [2, 3] } });
    const p = quotable("prompt.read", { name: "review" }, { prompt: { name: "review", tags: [], body: "Review {{diff}}", updatedAt: 1 } }, NODE)!;
    expect(p.source).toBeUndefined();
    expect(selectLines(p, [1, 1])).toEqual({ text: "Review {{diff}}" });
  });

  test("recall: one line per hit numbered from 1, the source is the single picked hit's own", () => {
    const hits: Hit[] = [
      { corpus: "session", source: { kind: "session", session: SESSION, seq: [12, 12] }, at: 3, snippet: "Do you want to create x.txt?", tags: [], score: 0.9 },
      { corpus: "thread", source: { kind: "thread", thread: THREAD, message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4" }, at: 2, snippet: "the deploy step", tags: ["deploy"], score: 0.5 },
      { corpus: "memory", source: { kind: "memory", name: "deploy", lines: [3, 5] }, at: 1, snippet: "## Decision\nafter tests", tags: [], score: 0.4 },
    ];
    const q = quotable("recall", { query: "deploy" }, { hits }, NODE)!;
    expect(q.source).toBeUndefined();
    expect(q.lines.map((l) => l.n)).toEqual([1, 2, 3]);
    expect(q.lines[0]).toEqual({ n: 1, text: "Do you want to create x.txt?", source: { kind: "session", session: SESSION, seq: [12, 12] } });
    expect(selectLines(q, [1, 1])).toEqual({ text: "Do you want to create x.txt?", source: { kind: "session", session: SESSION, seq: [12, 12] } });
    expect(selectLines(q, [3, 3])).toEqual({ text: "## Decision\nafter tests", source: { kind: "memory", name: "deploy", lines: [3, 5] } });
    // Two hits picked at once: text only, never a source fused from two ranges.
    expect(selectLines(q, [1, 2])).toEqual({ text: "Do you want to create x.txt?\nthe deploy step" });
    expect(selectLines(q, undefined)!.source).toBeUndefined();
    expect(selectLines(q, [4, 9])).toBeUndefined();
    expect(quotable("recall", { query: "x" }, { hits: [] }, NODE)).toEqual({ lines: [] });
    expect(quotable("recall", { query: "x" }, { nope: 1 }, NODE)).toBeUndefined();
  });

  test("helpers", () => {
    expect(numberedLines("1\ta\nno number\n2\tb\tc")).toEqual([
      { n: 1, text: "a" },
      { n: 2, text: "b\tc" },
    ]);
    expect(sessionEventText({ session: SESSION, seq: 0, at: 0, kind: "notification", payload: { type: "permission_prompt", message: "Allow?" } })).toBe("· permission_prompt: Allow?");
    const ask = (payload: Record<string, unknown>) => sessionEventText({ session: SESSION, seq: 0, at: 0, kind: "ask", payload });
    expect(ask({ ask: "ask_1", phase: "opened", tool: "AskUserQuestion", question: 2, of: 4, title: "Who should approve?", detail: "Approver · 2 of 4", options: ["A second manager", "Anyone"] })).toBe(
      "? ask opened: AskUserQuestion — Who should approve?\nApprover · 2 of 4\noptions: A second manager | Anyone",
    );
    expect(ask({ ask: "ask_1", phase: "opened", kind: "input", title: "Faircase is asking for input" })).toBe("? ask opened — Faircase is asking for input");
    expect(ask({ ask: "ask_1", phase: "answered", answer: { option: "Anyone", by: { kind: "user" }, at: 1 } })).toBe("? ask answered: Anyone");
    expect(ask({ ask: "ask_1", phase: "answered", answer: { option: "a", options: ["a", "b"], text: "and c", by: { kind: "user" }, at: 1 } })).toBe('? ask answered: a, b — "and c"');
    expect(ask({ ask: "ask_1", phase: "answered", answer: { option: "text", text: "use the staging box", by: { kind: "user" }, at: 1 } })).toBe('? ask answered: "use the staging box"');
    expect(ask({ ask: "ask_1", phase: "closed", reason: "stopped" })).toBe("? ask closed (stopped)");
    expect(messageText({ id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4", thread: THREAD, at: 0, role: "user", source: "voice", content: [{ type: "audio" }, { type: "text", text: "hi" }] })).toBe("[audio]\nhi");
  });
});
