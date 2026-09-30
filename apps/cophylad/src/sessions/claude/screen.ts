// Reading Claude Code's screen, as tether gives it (rows of styled runs). Everything here is
// Claude's own layout, measured on 2.1.280 in spike 15 and again on 2.1.283, and is used as a
// check rather than a source: hooks say whether a session is idle, asking or busy, and the
// screen only says what a hook cannot — whether the prompt holds text the user has half typed,
// which row of a dialog is which, and what a session that has not registered is waiting on.
//
// Claude draws its pointer as `❯` only where its environment names a terminal it trusts with
// Unicode; on Windows that is WT_SESSION, TERM_PROGRAM=vscode or a TERM such as
// xterm-256color, and a terminal started from anywhere else (a console, a service, a daemon
// launched without them) gets the ASCII `>`. Either is the pointer here.
//
// The prompt is the row that starts with the pointer directly under a rule of `─`; a past
// turn echoed in the transcript starts with it too, but never under a rule. An empty prompt
// shows a suggestion in dim text, which is not the user's. A dialog's rows are numbered, the
// selected one marked with the pointer. Under the prompt's closing rule, the footer names the
// permission mode, typing or not, busy or not; a dialog or the slash menu takes its place.

import type { Run, Screen } from "@tether-pty/client";
import type { PermissionMode } from "./launch.ts";

export type ScreenLike = Pick<Screen, "lines" | "cells">;

/** The screen's rows as text. */
export function rowsOf(s: ScreenLike): string[] {
  if (s.cells) return s.cells.map((runs) => runs.map((r) => r.t).join(""));
  return s.lines ?? [];
}

const RULE = /^\s*─{8,}/;
const PROMPT = /^[❯>][  ]?/;

function isRule(row: string | undefined): boolean {
  return row !== undefined && RULE.test(row);
}

/** A row's text without what is drawn dim: a placeholder, a hint. */
function undimmed(runs: Run[]): string {
  return runs
    .filter((r) => !r.dim)
    .map((r) => r.t)
    .join("");
}

/**
 * What the prompt holds, typed and not yet sent: `""` when it is empty (or shows only its
 * suggestion), `undefined` when no prompt is on the screen (a dialog has it, or the session
 * is still starting).
 */
export function promptInput(s: ScreenLike): string | undefined {
  const rows = rowsOf(s);
  for (let i = rows.length - 1; i > 0; i--) {
    if (!PROMPT.test(rows[i]!) || !isRule(rows[i - 1])) continue;
    const parts: string[] = [];
    for (let j = i; j < rows.length && !(j > i && isRule(rows[j])); j++) {
      const text = s.cells ? undimmed(s.cells[j]!) : rows[j]!;
      parts.push(j === i ? text.replace(PROMPT, "") : text);
    }
    return parts
      .map((p) => p.replace(/ /g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

/** The footer's words for each permission mode, as 2.1.285 draws them. */
const FOOTER_MODES: readonly [RegExp, PermissionMode][] = [
  [/\bmanual mode on\b/, "default"],
  [/\baccept edits on\b/, "acceptEdits"],
  [/\bplan mode on\b/, "plan"],
  [/\bauto mode on\b/, "auto"],
  [/\bbypass permissions on\b/, "bypassPermissions"],
];

/** The rows under the prompt's closing rule; none when no prompt is on the screen. */
function footerRows(s: ScreenLike): string[] {
  const rows = rowsOf(s);
  let i = rows.length - 1;
  while (i > 0 && !(PROMPT.test(rows[i]!) && isRule(rows[i - 1]))) i--;
  if (i <= 0) return [];
  let close = i + 1;
  while (close < rows.length && !isRule(rows[close])) close++;
  return rows.slice(close + 1).map((r) => r.replace(/ /g, " "));
}

/**
 * The permission mode the footer names, which Shift+Tab moves on; `undefined` when no prompt
 * is on the screen (a dialog or a menu has it) or the footer names no mode known here.
 */
export function footerMode(s: ScreenLike): PermissionMode | undefined {
  for (const row of footerRows(s)) for (const [words, mode] of FOOTER_MODES) if (words.test(row)) return mode;
  return undefined;
}

/** The footer says the session's model has no auto mode. */
export function autoUnavailable(s: ScreenLike): boolean {
  return footerRows(s).some((row) => /\bauto mode unavailable\b/.test(row));
}

export interface DialogRow {
  digit: number;
  label: string;
  selected: boolean;
}

const ROW = /^\s*([❯>])?\s*(\d)\.\s+(.*\S)\s*$/;

/** A numbered dialog's rows, in order; empty when none is on the screen. */
export function dialogRows(s: ScreenLike): DialogRow[] {
  const out: DialogRow[] = [];
  for (const row of rowsOf(s)) {
    const m = ROW.exec(row.replace(/ /g, " "));
    if (!m) continue;
    out.push({ digit: Number(m[2]), label: m[3]!, selected: m[1] !== undefined });
  }
  // Only a run numbered from 1 is a dialog; a numbered list in the transcript above is not.
  const start = out.findIndex((r, i) => r.digit === 1 && out.slice(i).every((x, k) => x.digit === k + 1));
  return start < 0 ? [] : out.slice(start);
}

/** The plan dialog's "Yes, clear context …" row. */
export function clearContextRow(s: ScreenLike): DialogRow | undefined {
  return dialogRows(s).find((r) => /^Yes, clear context\b/.test(r.label));
}

/**
 * What a session that has not registered is waiting on, in words for the one who started
 * it; `undefined` when the screen shows nothing recognisable.
 */
export function waitingOn(s: ScreenLike): string | undefined {
  const text = rowsOf(s).join("\n");
  if (/Yes, I trust this folder|Do you trust the files in this folder/.test(text)) return "the folder trust dialog";
  if (/Select login method|Log in with|Paste code here|Browser didn't open/i.test(text)) return "signing in";
  if (/Do you want to use this API key/i.test(text)) return "whether to use an API key";
  if (/Choose the text style|Select a theme/i.test(text)) return "the first-run setup";
  if (/Enter to confirm/.test(text)) return "a question in its window";
  return undefined;
}

/** The last few rows with text, for a message about a screen nothing here recognises. */
export function tail(s: ScreenLike, n = 6): string {
  return rowsOf(s)
    .map((r) => r.replace(/ /g, " ").trimEnd())
    .filter((r) => r.trim())
    .slice(-n)
    .join("\n");
}
