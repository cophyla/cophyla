// A held permission as an ask, with no host: the plan an `ExitPlanMode` carries, what a
// Claude session was started with and so which "Yes, and …" row its plan offers, the ask a
// tool call opens either way and its input in words, the decision an answer releases, and
// the first message of a session a plan goes on in.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskAnswer } from "@cophyla/protocol";
import { launchFlags, launchOf, permissionModeOf, permissionSettings, readLaunch } from "../src/sessions/claude/launch.ts";
import { freshPlanPrompt, goOnLabel, goOnMode, goOnOption, handedOffDecision, inputText, permissionAsk, permissionDecision, permissionDetail, planCallInput, planOf, planOptions } from "../src/sessions/permissions.ts";
import { tempHome } from "./helpers.ts";

const by = { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" } as const;
const answer = (a: Partial<AskAnswer> & { option: string }): AskAnswer => ({ by, at: 1, ...a });
const PLAN = "## Plan\n\n1. Read the file\n2. Write the file";

describe("permissions: the plan in an ExitPlanMode", () => {
  test("the plan is read from the input, trimmed", () => {
    expect(planOf("ExitPlanMode", { plan: `\n${PLAN}\n` })).toBe(PLAN);
  });

  test("another tool, another shape, or an empty plan has none", () => {
    expect(planOf("Write", { plan: PLAN })).toBeUndefined();
    expect(planOf(undefined, { plan: PLAN })).toBeUndefined();
    expect(planOf("ExitPlanMode", { plan: "  " })).toBeUndefined();
    expect(planOf("ExitPlanMode", { plan: 12 })).toBeUndefined();
    expect(planOf("ExitPlanMode", "the plan")).toBeUndefined();
    expect(planOf("ExitPlanMode", undefined)).toBeUndefined();
  });
});

describe("permissions: what a Claude session was started with", () => {
  test("modes are read in any spelling the CLI takes", () => {
    expect(permissionModeOf("bypassPermissions")).toBe("bypassPermissions");
    expect(permissionModeOf("BYPASS")).toBe("bypassPermissions");
    expect(permissionModeOf("manual")).toBe("default");
    expect(permissionModeOf(" acceptEdits ")).toBe("acceptEdits");
    expect(permissionModeOf("sideways")).toBeUndefined();
    expect(permissionModeOf(3)).toBeUndefined();
  });

  test("the flags that bear on permissions, spaced or joined with =", () => {
    expect(launchFlags(["claude.exe", "--settings", "C:\\s.json", "--dangerously-skip-permissions"])).toEqual({ mode: "bypassPermissions", allowBypass: false, settings: "C:\\s.json" });
    expect(launchFlags(["claude", "--permission-mode=auto", "--allow-dangerously-skip-permissions"])).toEqual({ mode: "auto", allowBypass: true });
    expect(launchFlags(["claude", "--permission-mode", "acceptEdits", "fix it"])).toEqual({ mode: "acceptEdits", allowBypass: false });
    // The program itself and a prompt are not flags; skipping wins over a named mode.
    expect(launchFlags(["--dangerously-skip-permissions"])).toEqual({ allowBypass: false });
    expect(launchFlags(["claude", "--permission-mode", "plan", "--dangerously-skip-permissions"]).mode).toBe("bypassPermissions");
  });

  test("settings stack lowest first; any of them may disable bypassing", () => {
    expect(permissionSettings([{ permissions: { defaultMode: "auto" } }, { permissions: { defaultMode: "bypassPermissions" } }, undefined, "junk"])).toEqual({ defaultMode: "bypassPermissions", bypassDisabled: false, clearRow: false });
    expect(permissionSettings([{ permissions: { disableBypassPermissionsMode: "disable" } }, { permissions: { defaultMode: "manual" } }])).toEqual({ defaultMode: "default", bypassDisabled: true, clearRow: false });
    expect(permissionSettings([])).toEqual({ bypassDisabled: false, clearRow: false });
  });

  test("the clear-context row shows when the last settings file to say so turns it on", () => {
    expect(permissionSettings([{ showClearContextOnPlanAccept: true }]).clearRow).toBe(true);
    expect(permissionSettings([{ showClearContextOnPlanAccept: true }, { showClearContextOnPlanAccept: false }]).clearRow).toBe(false);
    expect(permissionSettings([{ showClearContextOnPlanAccept: false }, {}, { showClearContextOnPlanAccept: true }]).clearRow).toBe(true);
    const home = tempHome();
    writeFileSync(join(home, "cophylad-settings.json"), JSON.stringify({ showClearContextOnPlanAccept: true }));
    expect(readLaunch({ argv: ["claude", "--settings", join(home, "cophylad-settings.json")], cwd: home }).clearRow).toBe(true);
    expect(readLaunch({ argv: ["claude"], cwd: home }).clearRow).toBe(false);
  });

  test("bypass is open to a session started in it or allowed it, unless a setting disables it", () => {
    expect(launchOf({ mode: "bypassPermissions", allowBypass: false }, { bypassDisabled: false, clearRow: false })).toEqual({ mode: "bypassPermissions", bypass: true, clearRow: false });
    expect(launchOf({ allowBypass: true }, { defaultMode: "auto", bypassDisabled: false, clearRow: false })).toEqual({ mode: "auto", bypass: true, clearRow: false });
    expect(launchOf(undefined, { defaultMode: "bypassPermissions", bypassDisabled: false, clearRow: false })).toEqual({ mode: "bypassPermissions", bypass: true, clearRow: false });
    expect(launchOf({ mode: "bypassPermissions", allowBypass: true }, { bypassDisabled: true, clearRow: false }).bypass).toBe(false);
    expect(launchOf({ mode: "acceptEdits", allowBypass: false }, { defaultMode: "bypassPermissions", bypassDisabled: false, clearRow: false })).toEqual({ mode: "acceptEdits", bypass: false, clearRow: false });
  });

  test("the files: the profile's, the project's, its local one, then --settings as a file or as JSON", () => {
    const home = tempHome();
    const configDir = join(home, "claude");
    const cwd = join(home, "repo");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ permissions: { defaultMode: "auto" } }));
    expect(readLaunch({ configDir, cwd })).toEqual({ mode: "auto", bypass: false, clearRow: false });
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
    expect(readLaunch({ configDir, cwd })).toEqual({ mode: "acceptEdits", bypass: false, clearRow: false });
    writeFileSync(join(home, "shared.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
    expect(readLaunch({ argv: ["claude", "--settings", join(home, "shared.json")], configDir, cwd })).toEqual({ mode: "bypassPermissions", bypass: true, clearRow: false });
    expect(readLaunch({ argv: ["claude", "--settings", '{"permissions":{"disableBypassPermissionsMode":"disable"}}', "--dangerously-skip-permissions"], configDir, cwd })).toEqual({ mode: "bypassPermissions", bypass: false, clearRow: false });
    // A broken file or a missing one reads as nothing.
    writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json");
    expect(readLaunch({ argv: ["claude", "--settings", join(home, "missing.json")], cwd })).toEqual({ mode: "acceptEdits", bypass: false, clearRow: false });
  });

  test("the row a plan goes on in: bypass when open, then auto mode, then accepting edits", () => {
    expect(goOnMode({ bypass: true, mode: "auto", clearRow: false })).toBe("bypassPermissions");
    expect(goOnMode({ bypass: false, clearRow: false }, new Set(["plan", "bypassPermissions"]))).toBe("bypassPermissions");
    expect(goOnMode({ bypass: false, mode: "auto", clearRow: false })).toBe("auto");
    expect(goOnMode(undefined, new Set(["auto", "plan"]))).toBe("auto");
    expect(goOnMode({ bypass: false, mode: "default", clearRow: false }, new Set(["plan"]))).toBe("acceptEdits");
    expect(goOnMode(undefined)).toBe("acceptEdits");
  });
});

describe("permissions: the ask", () => {
  test("a plan is the ask: its own title, the plan itself, and what leaving plan mode means", () => {
    const shape = permissionAsk("ExitPlanMode", { plan: PLAN }, "orchestrator", 2000);
    expect(shape.plan).toBe(true);
    expect(shape.title).toBe("Ready to code in orchestrator?");
    expect(shape.detail).toBe(PLAN);
    expect(shape.options.map((o) => o.id)).toEqual(["accept_edits", "allow", "deny"]);
    expect(shape.options.every((o) => o.description !== undefined)).toBe(true);
  });

  test("a plan's rows are the terminal's: clear context when a fresh session can start, the go-on row, manual, keep planning", () => {
    expect(planOptions({ goOn: "bypassPermissions", clear: true, used: 42 }).map((o) => [o.id, o.label])).toEqual([
      ["clear", "Yes, clear context (42% used) and bypass permissions"],
      ["bypass", "Yes, and bypass permissions"],
      ["allow", "Yes, manually approve edits"],
      ["deny", "No, keep planning"],
    ]);
    expect(planOptions({ goOn: "auto", clear: true }).map((o) => o.label).slice(0, 2)).toEqual(["Yes, clear context and use auto mode", "Yes, and use auto mode"]);
    expect(planOptions({ goOn: "acceptEdits", clear: false }).map((o) => o.id)).toEqual(["accept_edits", "allow", "deny"]);
    expect(permissionAsk("ExitPlanMode", { plan: PLAN }, "repo", 2000, { goOn: "auto", clear: true }).options.map((o) => o.id)).toEqual(["clear", "auto", "allow", "deny"]);
    // Pressed in the session's own terminal, or built in a fresh session: the row says which.
    expect(planOptions({ goOn: "acceptEdits", clear: true, inPlace: true })[0]!.description).toBe("Build it in this terminal, starting from the plan alone");
    expect(planOptions({ goOn: "acceptEdits", clear: true })[0]!.description).toBe("Build it in a new session that starts from the plan alone");
    expect(goOnLabel("acceptEdits")).toBe("Yes, auto-accept edits");
    expect(goOnOption("bypassPermissions")).toBe("bypass");
    expect(goOnOption("auto")).toBe("auto");
    expect(goOnOption("acceptEdits")).toBe("accept_edits");
  });

  test("any other tool is its name and its input in words, redacted and capped", () => {
    const shape = permissionAsk("Write", { file_path: "x.txt", content: "hello\nworld", token: "hunter2" }, "repo", 2000);
    expect(shape.plan).toBe(false);
    expect(shape.title).toBe("Write in repo");
    expect(shape.detail).toBe("x.txt\n\nhello\nworld\n\ntoken: [redacted]");
    expect(shape.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    expect(permissionAsk(undefined, {}, "repo", 2000).title).toBe("tool in repo");
    expect(permissionAsk("mcp__claude_ai_Docs__batch", {}, "repo", 2000).title).toBe("claude_ai_Docs - batch (MCP) in repo");
    expect(permissionDetail("Write", { content: "x".repeat(3000) }, 200)).toHaveLength(200);
  });

  test("a long plan gets the room prose needs, and is capped in the end", () => {
    const long = "step. ".repeat(3000);
    expect(permissionDetail("ExitPlanMode", { plan: long }, 200)).toHaveLength(8000);
  });
});

describe("permissions: a tool's input in words", () => {
  test("a command leads, its reason below, other fields as name: value", () => {
    expect(inputText({ command: "git status", description: "Show working tree status", timeout: 5000, run_in_background: false })).toBe("git status\n\nShow working tree status\n\ntimeout: 5000\nrun_in_background: false");
    expect(inputText({ command: ["bash", "-lc", "ls -la"] })).toBe("bash -lc ls -la");
  });

  test("an edit is its file and the lines it takes out and puts in, the unchanged ends kept as context", () => {
    const edit = { file_path: "src/a.ts", old_string: "one\ntwo\nthree", new_string: "one\n2\nthree", replace_all: true };
    expect(inputText(edit)).toBe("src/a.ts\n\n  one\n- two\n+ 2\n  three\n\nreplace_all: true");
    expect(inputText({ file_path: "a", old_string: "", new_string: "new" })).toBe("a\n\n+ new");
    const multi = { file_path: "a", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p\nq", new_string: "p" }] };
    expect(inputText(multi)).toBe("a\n\n- x\n+ y\n\n  p\n- q");
  });

  test("a search, a fetch and an agent read as what they look for and what they are asked", () => {
    expect(inputText({ pattern: "TODO", path: "src", glob: "*.ts", "-i": true })).toBe("TODO\nsrc\n\nglob: *.ts\n-i: true");
    expect(inputText({ url: "https://example.com", prompt: "Summarise it" })).toBe("https://example.com\n\nSummarise it");
    expect(inputText({ description: "Find callers", prompt: "Look for\nevery caller", subagent_type: "Explore" })).toBe("Find callers\n\nLook for\nevery caller\n\nsubagent_type: Explore");
  });

  test("a tool cophylad has never met: nested fields indented, lists joined, no braces", () => {
    const text = inputText({ element: "Submit", ref: "e12", options: { deep: { on: true } }, tags: ["a", "b"], none: [], note: "two\nlines", rows: [{ id: 1 }] });
    expect(text).toBe("element: Submit\nref: e12\noptions:\n  deep:\n    on: true\ntags: a, b\nnone: none\nnote:\n  two\n  lines\nrows:\n  1:\n    id: 1");
    expect(text).not.toMatch(/[{}"]/);
    expect(inputText({})).toBe("");
    expect(inputText(undefined)).toBe("");
    expect(inputText("raw")).toBe("raw");
  });
});

describe("permissions: the decision", () => {
  test("a tool's allow and deny are unchanged, and no mode moves", () => {
    expect(permissionDecision(answer({ option: "allow" }))).toEqual({ behavior: "allow" });
    expect(permissionDecision(answer({ option: "deny" }))).toEqual({ behavior: "deny", message: "Denied through cophylad" });
    expect(permissionDecision(answer({ option: "deny", text: "not that file" }))).toEqual({ behavior: "deny", message: "not that file" });
  });

  // The call as the CLI shows it to the hook: the plan and its file read in from disk.
  const CALL = { plan: PLAN, planFilePath: "C:\\Users\\me\\.claude\\plans\\steady-aho.md" };
  const held = { input: CALL };

  test("a plan's allow sets the mode the session goes on in, and hands back the model's own call", () => {
    expect(permissionDecision(answer({ option: "allow" }), held)).toEqual({
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
    });
    expect(permissionDecision(answer({ option: "accept_edits" }), held)).toEqual({
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect(permissionDecision(answer({ option: "bypass" }), held)).toEqual({
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    });
    expect(permissionDecision(answer({ option: "auto" }), held)).toEqual({
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }],
    });
    // A plan's rows mean nothing on a tool's ask.
    expect(permissionDecision(answer({ option: "bypass" }))).toEqual({ behavior: "deny", message: "Denied through cophylad" });
  });

  test("the call handed back: what the CLI read in from disk goes, the model's own fields stay", () => {
    expect(planCallInput(CALL)).toEqual({});
    expect(planCallInput({ ...CALL, allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] })).toEqual({ allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] });
    // With no plan file the plan is the model's own argument.
    expect(planCallInput({ plan: PLAN })).toEqual({ plan: PLAN });
    expect(planCallInput(undefined)).toEqual({});
  });

  test("a plan handed to a fresh session ends the old turn; the fresh one starts from the plan", () => {
    expect(handedOffDecision()).toMatchObject({ behavior: "deny", interrupt: true });
    expect(freshPlanPrompt(PLAN)).toBe(`Implement this plan:\n\n${PLAN}`);
    const full = freshPlanPrompt(PLAN, "C:\\t.jsonl", "keep it small");
    expect(full.startsWith(`Implement this plan:\n\n${PLAN}\n\nIf you need specific details`)).toBe(true);
    expect(full).toContain("read the full transcript at: C:\\t.jsonl");
    expect(full.endsWith("\n\nUser feedback on this plan: keep it small")).toBe(true);
  });

  test("keeping planning denies, and a note is the message; text alone is a note", () => {
    expect(permissionDecision(answer({ option: "deny" }), held)).toEqual({ behavior: "deny", message: "Keep planning" });
    expect(permissionDecision(answer({ option: "deny", text: "use the other library" }), held)).toEqual({ behavior: "deny", message: "use the other library" });
    expect(permissionDecision(answer({ option: "text", text: "split it in two" }), held)).toEqual({ behavior: "deny", message: "split it in two" });
    expect(permissionDecision(undefined, held)).toEqual({ behavior: "deny", message: "Keep planning" });
  });
});
