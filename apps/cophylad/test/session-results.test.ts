// A tool's result as text: each Claude Code rule on a payload shaped like the ones its
// PostToolUse hook carries (key sets from the real store, made-up content), the generic rule
// for MCP tools and the other harnesses, and redaction before anything is read.

import { describe, expect, test } from "bun:test";
import { summariseValue, TOOL_RESULT_CAP } from "../src/sessions/model.ts";
import { genericText, toolResultText } from "../src/sessions/results.ts";

const claude = (tool: string, response: unknown, error?: string) => toolResultText("claude", tool, response, error);

describe("Claude Code's tools", () => {
  test("Bash: stdout, then stderr without the cwd note, then what else happened", () => {
    expect(claude("Bash", { stdout: "hello", stderr: "", interrupted: false, isImage: false, noOutputExpected: false })).toBe("hello");
    expect(claude("Bash", { stdout: "built\n", stderr: "\nShell cwd was reset to C:\\D\\repo", interrupted: false, isImage: false, noOutputExpected: false })).toBe("built");
    expect(claude("Bash", { stdout: "", stderr: "warning: x\nShell cwd was reset to /home/me/repo", interrupted: false, isImage: false, noOutputExpected: false })).toBe("warning: x");
    expect(claude("Bash", { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: true })).toBe("(no output)");
    expect(claude("Bash", { stdout: "part", stderr: "", interrupted: true, isImage: false, noOutputExpected: false, timedOutAfterMs: 120000 })).toBe("part\n(interrupted)\n(timed out)");
    expect(claude("Bash", { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "b7x2", backgroundCwdHint: "Session cwd remains C:\\D\\repo" })).toBe("(in the background: b7x2)");
    expect(claude("Bash", { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, returnCodeInterpretation: "No matches found" })).toBe("(No matches found)");
    expect(claude("Bash", { stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, bashEditDiff: { files: [], moreFiles: 0, shared: true } })).toBe("ok");
    expect(claude("Bash", { stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, bashEditDiff: { files: [{ path: "a.ts" }, { path: "b.ts" }], moreFiles: 1, shared: false } })).toBe("ok\n(edited 3 files)");
    expect(claude("Bash", { stdout: "iVBORw0KGgoAAAANSUhEUg", stderr: "", interrupted: false, isImage: true, noOutputExpected: false })).toBe("[image]");
  });

  test("PowerShell takes Bash's rule", () => {
    expect(claude("PowerShell", { stdout: "Name  Length\r\na.txt 12\r\n", stderr: "", interrupted: false, isImage: false })).toBe("Name  Length\r\na.txt 12");
  });

  test("Edit: the file and the lines added and removed, never the file's content", () => {
    const edit = {
      filePath: "C:\\D\\repo\\b.txt",
      oldString: "one",
      newString: "two",
      originalFile: "one\n".repeat(5000),
      structuredPatch: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: ["-one", "+two", "+three", " four", "\\ No newline at end of file"] },
        { oldStart: 9, oldLines: 1, newStart: 10, newLines: 0, lines: ["-nine"] },
      ],
      userModified: false,
      replaceAll: false,
    };
    expect(claude("Edit", edit)).toBe("edited C:\\D\\repo\\b.txt: +2 −2");
    expect(claude("Edit", { ...edit, userModified: true, contentNotInModelContext: true })).toBe("edited C:\\D\\repo\\b.txt: +2 −2 (the user changed it first)");
  });

  test("Write: created with its lines, or updated with the lines added and removed", () => {
    expect(claude("Write", { type: "create", filePath: "/repo/b.txt", content: "one", structuredPatch: [], originalFile: null, userModified: false })).toBe("created /repo/b.txt, 1 line");
    expect(claude("Write", { type: "create", filePath: "/repo/c.txt", content: "a\nb\nc\n", structuredPatch: [], originalFile: null, userModified: false })).toBe("created /repo/c.txt, 3 lines");
    expect(claude("Write", { type: "update", filePath: "/repo/c.txt", content: "a\nx\n", structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, lines: [" a", "-b", "-c", "+x"] }], originalFile: "a\nb\nc\n", userModified: false, memdirStamped: true })).toBe("updated /repo/c.txt: +1 −2");
  });

  test("Read: the file and the lines read, never its content; images, PDFs, notebooks and an unchanged file say so", () => {
    expect(claude("Read", { type: "text", file: { filePath: "/repo/a.txt", content: "alpha\nbeta\n".repeat(100), numLines: 35, startLine: 270, totalLines: 706 } })).toBe("read /repo/a.txt, lines 270–304 of 706");
    expect(claude("Read", { type: "text", file: { filePath: "/repo/empty.txt", content: "", numLines: 0, startLine: 1, totalLines: 0 } })).toBe("read /repo/empty.txt, an empty file");
    expect(claude("Read", { type: "text", file: { filePath: "/repo/a.txt", content: "", numLines: 0, startLine: 900, totalLines: 706 } })).toBe("read /repo/a.txt, no lines from 900 of 706");
    const image = claude("Read", { type: "image", file: { base64: "iVBORw0KGgo".repeat(500), type: "image/png", originalSize: 10784, dimensions: { originalWidth: 346, originalHeight: 445, displayWidth: 346, displayHeight: 445 } } });
    expect(image).toBe("read an image (image/png, 346×445)");
    expect(claude("Read", { type: "pdf", file: { filePath: "/repo/spec.pdf", base64: "JVBERi0x", originalSize: 9 } })).toBe("read /repo/spec.pdf (a PDF)");
    expect(claude("Read", { type: "notebook", file: { filePath: "/repo/n.ipynb", cells: [{}, {}] } })).toBe("read /repo/n.ipynb, a notebook of 2 cells");
    expect(claude("Read", { type: "file_unchanged", file: { filePath: "/repo/a.txt" } })).toBe("read /repo/a.txt: unchanged since it was last read");
  });

  test("Grep: its content when it has some, else the files", () => {
    expect(claude("Grep", { mode: "content", numFiles: 0, filenames: [], content: "src/a.ts:3:needle", numLines: 1, totalLines: 1 })).toBe("src/a.ts:3:needle");
    expect(claude("Grep", { mode: "count", numFiles: 2, filenames: [], content: "a.ts:3\nb.ts:1", numMatches: 4 })).toBe("a.ts:3\nb.ts:1");
    expect(claude("Grep", { mode: "files_with_matches", filenames: ["src\\a.ts", "src\\b.ts"], numFiles: 2, totalFiles: 2 })).toBe("2 files\nsrc\\a.ts\nsrc\\b.ts");
    expect(claude("Grep", { mode: "content", numFiles: 0, filenames: [], content: "", numLines: 0, totalLines: 0 })).toBe("0 files");
  });

  test("Glob: the files, and whether the list was cut", () => {
    expect(claude("Glob", { filenames: ["a.txt"], durationMs: 85, numFiles: 1, truncated: false, totalMatches: 1, countIsComplete: true })).toBe("1 file\na.txt");
    expect(claude("Glob", { filenames: ["a.txt", "b.txt"], durationMs: 85, numFiles: 100, truncated: true, totalMatches: 480, countIsComplete: true })).toBe("100 files\na.txt\nb.txt\n(truncated)");
  });

  test("Agent: its status and what it was for, then what it said", () => {
    expect(claude("Agent", { isAsync: true, status: "async_launched", agentId: "a31", description: "Run the checks", resolvedModel: "m", prompt: "x".repeat(3000), outputFile: "C:\\tmp\\a31.output", canReadOutputFile: true })).toBe("async_launched: Run the checks");
    expect(claude("Agent", { status: "completed", description: "Find the caller", content: [{ type: "text", text: "It is called from main.ts." }], totalDurationMs: 9000 })).toBe("completed: Find the caller\nIt is called from main.ts.");
  });

  test("WebFetch: its result", () => {
    expect(claude("WebFetch", { bytes: 51200, code: 200, codeText: "OK", result: "The page says hello.", durationMs: 800, url: "https://example.com/" })).toBe("The page says hello.");
  });

  test("WebSearch: the results' titles and addresses", () => {
    const response = {
      query: "word mcp",
      results: [{ tool_use_id: "srvtoolu_1", content: [{ title: "Word server", url: "https://example.com/word" }, { title: "", url: "https://example.org/" }] }, "A summary of what was found."],
      durationSeconds: 7.4,
      searchCount: 1,
    };
    expect(claude("WebSearch", response)).toBe("Word server (https://example.com/word)\nhttps://example.org/");
  });

  test("AskUserQuestion: each question and its answer, with the user's notes", () => {
    const response = {
      questions: [{ question: "Which cache?", header: "Cache", options: [], multiSelect: false }],
      answers: { "Which cache?": "Redis", "Which tools?": "ESLint, Prettier" },
      annotations: { "Which cache?": { notes: "managed please" } },
    };
    expect(claude("AskUserQuestion", response)).toBe("Which cache? → Redis (managed please)\nWhich tools? → ESLint, Prettier");
  });

  test("ToolSearch: the tools it matched", () => {
    expect(claude("ToolSearch", { matches: ["ExitPlanMode", "WebFetch"], query: "select:ExitPlanMode,WebFetch", total_deferred_tools: 53 })).toBe("ExitPlanMode, WebFetch");
    expect(claude("ToolSearch", { matches: [], query: "unreal", total_deferred_tools: 88, failed_mcp_servers: [] })).toBe("no matches");
  });

  test("a failure's error is its text", () => {
    expect(claude("Bash", undefined, "Exit code 2\nls: cannot access 'nope': No such file or directory")).toBe("Exit code 2\nls: cannot access 'nope': No such file or directory");
  });

  test("a shape a rule does not know, like the transcript's plain text, takes the generic rule", () => {
    expect(claude("Edit", "The file /repo/b.txt has been updated successfully.")).toBe("The file /repo/b.txt has been updated successfully.");
    expect(claude("Read", [{ type: "text", text: "1\talpha" }])).toBe("1\talpha");
    expect(claude("TaskStop", { message: "Successfully stopped task: b7x2", task_id: "b7x2", task_type: "local_bash", command: "sleep 99" })).toBe("Successfully stopped task: b7x2");
    expect(claude("Monitor", { taskId: "b7x2", timeoutMs: 1800000, persistent: false })).toBe('{"taskId":"b7x2","timeoutMs":1800000,"persistent":false}');
  });

  test("a tool's name is looked up as a name only", () => {
    expect(claude("constructor", { stdout: "x" })).toBe("x");
  });
});

describe("the generic rule", () => {
  test("an MCP tool's content blocks: the text, images as [image]", () => {
    expect(toolResultText("claude", "mcp__browser__take_screenshot", [{ type: "text", text: "Took the screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo".repeat(500) } }])).toBe("Took the screenshot\n[image]");
    expect(toolResultText("claude", "mcp__db__search", "[1, 2, 3]")).toBe("[1,2,3]");
    expect(toolResultText("claude", "mcp__db__read", "plain text")).toBe("plain text");
  });

  test("Muse: a hook's JSON string is read as its value", () => {
    expect(toolResultText("muse", "powershell", '{\n  "exit_code": 0,\n  "output": "ok\\r\\n"\n}')).toBe("ok\r\n");
    expect(toolResultText("muse", "powershell", '{"exit_code":1,"output":"boom\\n"}')).toBe("boom\n(exit code 1)");
    expect(toolResultText("muse", "powershell", '{"exit_code":0}')).toBe('{"exit_code":0}');
    expect(toolResultText("muse", "powershell", "hi\r\n")).toBe("hi\r\n");
  });

  test("Codex: exec blocks, an MCP tool's content, a message", () => {
    const exec = [
      { type: "input_text", text: "Script completed\nWall time 7.9 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ chunk_id: "5aee2b", wall_time_seconds: 7.39, exit_code: 0, original_token_count: 12, output: "rendered 1 frame" }) },
      { type: "input_image", image_url: "data:image/png;base64," + "iVBORw0KGgo".repeat(500) },
    ];
    expect(toolResultText("codex", "exec", exec)).toBe("Script completed\nWall time 7.9 seconds\nOutput:\n\nrendered 1 frame\n[image]");
    expect(toolResultText("codex", "mcp__browser__js", { content: [{ type: "text", text: "clicked" }], isError: false, _meta: { url: "http://localhost:5173/" } })).toBe("clicked");
    expect(toolResultText("codex", "wait_agent", { message: "Wait timed out.", timed_out: true })).toBe("Wait timed out.");
    expect(toolResultText("codex", "shell", { output: "ok", metadata: { exit_code: 0, duration_seconds: 0.1 } })).toBe("ok");
    expect(toolResultText("codex", "Bash", "ok")).toBe("ok");
    expect(toolResultText("codex", "list_agents", { agents: [{ agent_name: "/root", agent_status: "running" }] })).toBe('{"agents":[{"agent_name":"/root","agent_status":"running"}]}');
  });

  test("ACP: a content block wrapping text", () => {
    expect(toolResultText("claude", "Bash", [{ type: "content", content: { type: "text", text: "you chose allow-once" } }])).toBe("you chose allow-once");
  });

  test("nothing at all", () => {
    expect(genericText(undefined)).toBe("(no output)");
    expect(genericText(null)).toBe("(no output)");
  });
});

describe("redaction", () => {
  test("a credential-shaped key is redacted before the value is read, and so is a JSON string's", () => {
    expect(toolResultText("claude", "mcp__svc__login", { user: "me", token: "sk-secret" })).toBe('{"user":"me","token":"[redacted]"}');
    expect(toolResultText("muse", "fetch", '{"apiKey":"sk-secret","status":"ok"}')).toBe('{"apiKey":"[redacted]","status":"ok"}');
    expect(toolResultText("codex", "exec", [{ type: "input_text", text: '{"password":"hunter2","code":1}' }])).toBe('{"password":"[redacted]","code":1}');
  });

  test("a URL's secret query values are redacted, and a long text is cut at the cap", () => {
    const text = toolResultText("claude", "WebFetch", { result: "https://example.com/join?pin=1234&x=1", code: 200 });
    expect(summariseValue(text, TOOL_RESULT_CAP)).toEqual({ value: "https://example.com/join?pin=[redacted]&x=1" });
    const long = summariseValue(toolResultText("claude", "Bash", { stdout: "y\n".repeat(5000), stderr: "", interrupted: false, isImage: false }), TOOL_RESULT_CAP);
    expect(long.truncated).toBe(true);
    expect((long.value as string).length).toBe(TOOL_RESULT_CAP);
    expect((long.value as string).endsWith("…")).toBe(true);
  });
});
