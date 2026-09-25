import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearContextRow, dialogRows, promptInput, tail, waitingOn } from "../src/sessions/claude/screen.ts";
import type { ScreenLike } from "../src/sessions/claude/screen.ts";

const screens = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "claude-screens.json"), "utf8")) as Record<string, ScreenLike>;

describe("claude screen", () => {
  test("an empty prompt is empty even while its suggestion shows", () => {
    expect(promptInput(screens["empty"]!)).toBe("");
  });

  test("a half-typed prompt holds its text, and a past turn echoed above it is not the prompt", () => {
    expect(promptInput(screens["halfTyped"]!)).toBe("/clear");
  });

  test("no prompt while a dialog holds the screen", () => {
    expect(promptInput(screens["plan"]!)).toBeUndefined();
    expect(promptInput(screens["trust"]!)).toBeUndefined();
  });

  test("the plan dialog's rows, and the clear-context row by its label", () => {
    const rows = dialogRows(screens["plan"]!);
    expect(rows.map((r) => r.digit)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toEqual({ digit: 1, label: "Yes, clear context (6% used) and auto-accept edits", selected: true });
    expect(rows[3]!.label).toBe("Tell Claude what to change");
    expect(clearContextRow(screens["plan"]!)?.digit).toBe(1);
    expect(clearContextRow(screens["empty"]!)).toBeUndefined();
  });

  test("the clear-context row is found wherever the CLI puts it", () => {
    const moved: ScreenLike = { lines: ["   ❯ 1. Yes, auto-accept edits", "     2. Yes, clear context (40% used) and bypass permissions", "     3. No"] };
    expect(clearContextRow(moved)).toEqual({ digit: 2, label: "Yes, clear context (40% used) and bypass permissions", selected: false });
  });

  test("a numbered list in the transcript is not a dialog", () => {
    expect(dialogRows({ lines: ["● Steps:", "  2. build", "  3. test", "❯ "] })).toEqual([]);
  });

  test("says what an unregistered session waits on", () => {
    expect(waitingOn(screens["trust"]!)).toBe("the folder trust dialog");
    expect(waitingOn(screens["empty"]!)).toBeUndefined();
    expect(waitingOn({ lines: ["Select login method:", "❯ 1. Claude account"] })).toBe("signing in");
    expect(tail(screens["trust"]!, 2)).toBe("   Yes, I trust this folder\n Enter to confirm · Esc to cancel");
  });

  test("text screens work where cells are not given", () => {
    expect(promptInput({ lines: ["hi", "────────────────", "❯ fix the tests", "  and the docs", "────────────────", "  ⏵⏵ accept edits on"] })).toBe("fix the tests\nand the docs");
  });
});
