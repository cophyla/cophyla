// What a Claude dialog on the screen reads as, for the chat to draw natively, against the real
// screens Claude Code 2.1.316 drew (test/fixtures/claude-views: the text and the styled cells of
// each), and the keys a press on it sends. A screen the reading does not know is `other`, which
// the chat shows in its terminal.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dialogView, pressKeys } from "../src/sessions/dialog.ts";

const DIR = join(import.meta.dir, "fixtures", "claude-views");

function load(name: string): { lines: string[]; cells: unknown[][] } {
  return {
    lines: readFileSync(join(DIR, `${name}.txt`), "utf8").split("\n"),
    cells: JSON.parse(readFileSync(join(DIR, `${name}.cells.json`), "utf8")),
  };
}

// The types of the screen the node reads: tether's text and cells.
type Screen = Parameters<typeof dialogView>[0];
const screen = (name: string): Screen => load(name) as unknown as Screen;

describe("a Claude dialog read for the chat", () => {
  test("the model picker is a choice: its title, its rows, the pointer and the one in use", () => {
    const v = dialogView(screen("model"), "claude");
    expect(v?.kind).toBe("choice");
    expect(v?.title).toBe("Select model");
    expect(v?.note[0]).toMatch(/^Switch between Claude models/);
    expect(v?.rows.map((r) => r.label)).toEqual(["Default (recommended)", "Opus", "Fable", "Sonnet", "Haiku"]);
    expect(v?.rows[0]).toMatchObject({ selected: true, current: true, detail: expect.stringContaining("Use the default model") });
    expect(v?.rows[1]).toMatchObject({ selected: false, current: false });
  });

  test("the pointer follows the row the terminal has under it", () => {
    const v = dialogView(screen("model-down"), "claude");
    expect(v?.rows.findIndex((r) => r.selected)).toBe(1);
    expect(v?.rows[0]?.current).toBe(true);
  });

  test("the footer's keys are the ones the picker takes, each with what it does", () => {
    const v = dialogView(screen("model"), "claude");
    expect(v?.keys).toEqual([
      { key: "Enter", label: "set as default" },
      { key: "s", label: "use this session only" },
      { key: "Escape", label: "cancel" },
    ]);
  });

  test("/usage is a panel with its tabs: the one in use is the one the styled cells mark", () => {
    const v = dialogView(screen("usage"), "claude");
    expect(v?.kind).toBe("panel");
    expect(v?.tabs.map((t) => t.label)).toEqual(["Settings", "Status", "Config", "Usage", "Stats"]);
    expect(v?.tabs.find((t) => t.selected)?.label).toBe("Usage");
    expect(v?.lines[0]).toBe("Session");
    expect(v?.lines).toContain("Total cost:            $0.0000");
    expect(v?.keys).toEqual([{ key: "Escape", label: "cancel" }]);
  });

  test("/help is a panel whose tabs say which one is open", () => {
    const v = dialogView(screen("help"), "claude");
    expect(v?.kind).toBe("panel");
    expect(v?.tabs.map((t) => t.label)).toEqual(["Help", "General", "Commands", "Custom commands"]);
    expect(v?.tabs.find((t) => t.selected)?.label).toBe("General");
  });

  test("/resume is a panel under its title", () => {
    const v = dialogView(screen("resume"), "claude");
    expect(v?.kind).toBe("panel");
    expect(v?.title).toBe("Resume session");
    expect(v?.lines).toContain("No conversations found in this project.");
  });

  test("a screen with the prompt up is no dialog", () => {
    expect(dialogView(screen("00-prompt"), "claude")).toBeUndefined();
  });

  test("without styles no tab is marked, rather than guessed", () => {
    const v = dialogView({ lines: load("usage").lines } as unknown as Screen, "claude");
    expect(v?.tabs.length).toBe(5);
    expect(v?.tabs.some((t) => t.selected)).toBe(false);
  });

  test("Codex's dialogs stay in its terminal: they read as other", () => {
    expect(dialogView({ lines: ["Trust this folder?", "", "  1. Yes"] } as unknown as Screen, "codex")?.kind).toBe("other");
  });

  test("a dialog with no rule over it is other, so the chat shows the terminal", () => {
    expect(dialogView({ lines: ["Something unknown", "", "  Esc to cancel"] } as unknown as Screen, "claude")?.kind).toBe("other");
  });
});

describe("the keys a press sends", () => {
  test("a row is reached by moving the pointer, then Enter", () => {
    const model = dialogView(screen("model"), "claude")!;
    expect(pressKeys(model, { row: 0 })).toEqual(["Enter"]);
    expect(pressKeys(model, { row: 2 })).toEqual(["Down", "Down", "Enter"]);
    const down = dialogView(screen("model-down"), "claude")!;
    expect(pressKeys(down, { row: 0 })).toEqual(["Up", "Enter"]);
  });

  test("a tab is reached by Left or Right from the one in use", () => {
    const help = dialogView(screen("help"), "claude")!;
    expect(pressKeys(help, { tab: 1 })).toEqual([]);
    expect(pressKeys(help, { tab: 0 })).toEqual(["Left"]);
    expect(pressKeys(help, { tab: 3 })).toEqual(["Right", "Right"]);
  });

  test("a footer key is pressed as it is", () => {
    const model = dialogView(screen("model"), "claude")!;
    expect(pressKeys(model, { key: "s" })).toEqual(["s"]);
    expect(pressKeys(model, { key: "Escape" })).toEqual(["Escape"]);
  });

  test("a press the dialog does not offer is refused, with nothing sent", () => {
    const model = dialogView(screen("model"), "claude")!;
    const code = (press: () => unknown) => {
      try {
        press();
        return "sent";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(code(() => pressKeys(model, { row: 9 }))).toBe("conflict");
    const usage = dialogView(screen("usage"), "claude")!;
    expect(() => pressKeys(usage, { key: "Enter" })).toThrow();
    expect(() => pressKeys(dialogView(screen("help"), "claude")!, { tab: 9 })).toThrow();
  });
});
