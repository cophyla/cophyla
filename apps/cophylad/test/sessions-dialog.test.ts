// Whether a session's terminal shows a dialog or view in place of its prompt, read from real
// screens: Claude's prompt and dialogs from the fixtures, Codex's composer and its question
// dialog from the fake Codex TUI's dialog.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dialogOn } from "../src/sessions/dialog.ts";
import type { ScreenLike } from "../src/sessions/claude/screen.ts";
import { FakeCodexDialog } from "./fakes/codex-dialog.ts";

const screens = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "claude-screens.json"), "utf8")) as Record<string, ScreenLike>;

/** Codex's composer as its TUI draws it at rest: the footer offers the shortcuts. */
const CODEX_COMPOSER: ScreenLike = {
  lines: ["  >_ OpenAI Codex (v0.159.3)", "", "› Ask Codex to do anything", "  GPT-6.1-Sol default · C:\\work", "  ← for agents · ? for shortcuts"],
};

/** A numbered picker over the prompt, as Claude's `/model` draws it: no prompt on the screen. */
const MODEL_PICKER: ScreenLike = {
  lines: ["Select model", "Switch between Claude models. Applies to this session.", "", " ❯ 1. Default (recommended)", "   2. Sonnet", "   3. Haiku", "", " Enter to confirm · Esc to exit"],
};

describe("a dialog over a Claude session's prompt", () => {
  test("a prompt up, empty or half typed, is not a dialog", () => {
    expect(dialogOn(screens["empty"]!, "claude")).toBe(false);
    expect(dialogOn(screens["halfTyped"]!, "claude")).toBe(false);
    expect(dialogOn(screens["emptyAscii"]!, "claude")).toBe(false);
  });

  test("a numbered dialog with no prompt is a dialog", () => {
    expect(dialogOn(screens["plan"]!, "claude")).toBe(true);
    expect(dialogOn(screens["planAscii"]!, "claude")).toBe(true);
    expect(dialogOn(MODEL_PICKER, "claude")).toBe(true);
  });

  test("the folder trust dialog is a dialog too: the readiness rule keeps it off the chat's view", () => {
    expect(dialogOn(screens["trust"]!, "claude")).toBe(true);
  });
});

describe("a dialog over a Codex session's composer", () => {
  test("a composer up is not a dialog", () => {
    expect(dialogOn(CODEX_COMPOSER, "codex")).toBe(false);
  });

  test("the question dialog with no composer is a dialog", () => {
    const dialog = new FakeCodexDialog([{ id: "pick", question: "Which database?", header: "Database", options: [{ label: "Postgres", description: "Relational." }, { label: "SQLite" }] }]);
    const lines = dialog.screen().lines;
    expect(lines.join("\n")).not.toContain("? for shortcuts");
    expect(dialogOn({ lines }, "codex")).toBe(true);
  });
});

describe("harnesses with no prompt of these kinds", () => {
  test("another harness's screen is never a dialog here", () => {
    expect(dialogOn(MODEL_PICKER, "muse")).toBe(false);
    expect(dialogOn(screens["plan"]!, "acp")).toBe(false);
    expect(dialogOn(CODEX_COMPOSER, "gemini")).toBe(false);
  });
});
