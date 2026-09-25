// Reading the Muse TUI's screen, as tether gives it. Measured on Muse 1.4.0 in milestone 18's
// probes, and used as a check rather than a source, as Claude's is: hooks say whether a
// session is busy or asking; the screen says whether the prompt holds text the user has half
// typed, and what a session that has not registered is waiting on.
//
// The prompt is the row that starts with `❯` directly under a rule, which carries a title
// (`── Voice input (Alt+V to start) ───…`); what is typed runs down to the next plain rule, a
// continuation indented. A past turn echoed above starts with `❯` too, but never under a rule.
// An empty prompt shows a tip (`Type @ to search …`), drawn in no style tether reports, so an
// empty prompt is told by the cursor: at the start of a one-row prompt, what follows it is a
// tip. Without a cursor, the tips seen are known by their words.

import type { Run, Screen } from "@tether-pty/client";
import type { ScreenLike } from "../claude/screen.ts";
import { rowsOf } from "../claude/screen.ts";

/** A screen as tether gives it, with the cursor when it says where it is. */
export type MuseScreen = ScreenLike & { cursor?: Pick<Screen["cursor"], "row" | "col"> };

/** A rule: dashes from the left edge, with or without a title set in them. */
const RULE = /^\s*──/;
/** The rule that closes the prompt: dashes alone. */
const PLAIN_RULE = /^\s*─{8,}\s*$/;
const PROMPT = /^❯[  ]?/;

/** Tips an empty prompt shows, for a screen that says nothing of its cursor. */
const HINT = /^(Start a message with ! to run a shell command yourself|Type @ to search and insert workspace file paths|Press \? on an empty composer to see keyboard shortcuts|Press Alt\+V to dictate instead of typing|Paste an image with Ctrl\+V.*)$/;
/** Where the cursor stands in an empty prompt: just past `❯ `. */
const START_COL = 2;

function undimmed(runs: Run[]): string {
  return runs
    .filter((r) => !r.dim)
    .map((r) => r.t)
    .join("");
}

/**
 * What the prompt holds, typed and not yet sent: `""` when it is empty (or shows only its
 * hint), `undefined` when no prompt is on the screen (a dialog has it, or Muse is starting).
 */
export function promptInput(s: MuseScreen): string | undefined {
  const rows = rowsOf(s);
  for (let i = rows.length - 1; i > 0; i--) {
    if (!PROMPT.test(rows[i]!) || !RULE.test(rows[i - 1] ?? "")) continue;
    // The cursor at the start of a one-row prompt: whatever is drawn after it is a tip.
    const oneRow = i + 1 >= rows.length || PLAIN_RULE.test(rows[i + 1]!);
    if (s.cursor && s.cursor.row === i && s.cursor.col <= START_COL && oneRow) return "";
    const parts: string[] = [];
    for (let j = i; j < rows.length && !(j > i && PLAIN_RULE.test(rows[j]!)); j++) {
      const text = s.cells ? undimmed(s.cells[j]!) : rows[j]!;
      parts.push(j === i ? text.replace(PROMPT, "") : text);
    }
    const typed = parts
      .map((p) => p.replace(/ /g, " ").trim())
      .filter(Boolean)
      .join("\n");
    // With the cursor elsewhere, or not known, a tip is known by its words.
    return s.cursor?.row !== i && HINT.test(typed) ? "" : typed;
  }
  return undefined;
}

/**
 * What a Muse session that has not registered is waiting on, in words for the one who
 * started it; `undefined` when the screen shows nothing recognisable.
 */
export function waitingOn(s: ScreenLike): string | undefined {
  const text = rowsOf(s).join("\n");
  if (/Do you trust this workspace\?/.test(text)) return "the workspace trust dialog";
  if (/Log in with browser|Set an API key|Open this page to sign in/i.test(text)) return "signing in";
  if (/Downloading muse |\d+% Complete \(/.test(text)) return "a Muse download";
  const died = /^muse: (.+)$/m.exec(text);
  if (died) return `an error: ${died[1]!.trim()}`;
  if (/Use Up\/Down|Enter to choose|↓↑ to select/.test(text)) return "a question in its window";
  return undefined;
}
