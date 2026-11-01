// Whether a Claude Code or Codex terminal shows a dialog or a view over its prompt (a slash
// command's `/model` picker or `/usage` panel, a permission or a question), read from the
// screen as tether gives it. Where the prompt or composer is up, nothing is over it; where
// it is not, the terminal is showing something the chat has to show in its place.
//
// For Claude the dialog is also read into what the chat draws natively: its title, its tabs,
// its numbered or pointed rows, its text and the keys its footer names. Anything that cannot
// be read with confidence is `other`, which the chat shows in its terminal instead, so the
// native drawing never guesses at a screen it does not know.

import { RpcError } from "@cophyla/protocol";
import type { DialogKey, DialogView } from "@cophyla/protocol";
import { promptInput, rowsOf } from "./claude/screen.ts";
import type { ScreenLike } from "./claude/screen.ts";
import { composerUp } from "./codex/screen.ts";

/** Whether the harness's prompt (Claude) or composer (Codex) is up on the screen. Other harnesses have none to read. */
export function promptUp(screen: ScreenLike, harness: string): boolean {
  if (harness === "claude") return promptInput(screen) !== undefined;
  if (harness === "codex") return composerUp(screen);
  return false;
}

/** A dialog or view holds the terminal: the harness has a prompt, and it is not on the screen. */
export function dialogOn(screen: ScreenLike, harness: string): boolean {
  if (harness !== "claude" && harness !== "codex") return false;
  return !promptUp(screen, harness);
}

/** What a press asks of a dialog: a row of a choice, a tab of a panel, or a key its footer names. */
export type DialogPress = { row: number } | { tab: number } | { key: DialogKey };

/** The most of each part the protocol takes, so a long screen is cut rather than refused. */
const LIMITS = { note: 20, tabs: 12, rows: 60, lines: 200, keys: 8, text: 400, label: 200 } as const;

const RULE = /▔{10,}/;
const BOX_EDGE = /^[╭╮╰╯─]+$/;
const NUMBERED = /^(❯\s*)?(\d+)\.\s+(.*\S)$/;
const POINTED = /^❯\s+(.*\S)$/;
const FOOTER = /\b(?:Enter|Esc) to\b/;
const KEY_NAMES: Record<string, DialogKey> = { Enter: "Enter", Esc: "Escape", s: "s" };

function other(): DialogView {
  return { kind: "other", note: [], tabs: [], rows: [], lines: [], keys: [] };
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** A row's words without the box it may sit in (a search field): `│ ⌕ Search… │` is `⌕ Search…`. */
function unbox(text: string): string {
  return text.replace(/^│\s?/, "").replace(/\s?│$/, "").trimEnd();
}

/** The footer's keys: each `·`-separated part that reads `Enter to …`, `Esc to …` or `s to …`. */
function keysOf(parts: string[]): DialogView["keys"] {
  const out: DialogView["keys"] = [];
  for (const part of parts) {
    const m = /^(Enter|Esc|s) to (.+)$/.exec(part.trim());
    if (m) out.push({ key: KEY_NAMES[m[1]!]!, label: clip(m[2]!.trim(), LIMITS.text) });
  }
  return out.slice(0, LIMITS.keys);
}

/** The label of the tab a styled row shows selected: the run with a background colour, when the screen carries styles. */
function selectedTab(screen: ScreenLike, at: number): string | undefined {
  const runs = screen.cells?.[at];
  if (!runs) return undefined;
  const label = runs
    .filter((r) => r.bg !== undefined && r.t.trim() !== "")
    .map((r) => r.t)
    .join("")
    .trim();
  return label || undefined;
}

/**
 * What a Claude dialog on the screen holds, as the chat draws it: `undefined` when the prompt is
 * up (no dialog), `other` when the screen is a dialog this reading does not know.
 *
 * The dialog sits under a top rule of `▔`, and its footer is the last row with text. Between them:
 * an optional title (one short line), an optional row of tabs (2+ parts split on 2+ spaces, the one
 * in use marked by its background in the styled cells), then either numbered or pointed rows
 * (`selected` on the pointer, `current` on the `✔`), or text (a panel). Keys come from the footer's
 * `Enter to …`, `Esc to …`, `s to …` parts.
 */
export function dialogView(screen: ScreenLike, harness: string): DialogView | undefined {
  if (!dialogOn(screen, harness)) return undefined;
  if (harness !== "claude") return other();
  const rows = rowsOf(screen).map((r) => r.replace(/ /g, " "));
  let top = -1;
  for (let i = rows.length - 1; i >= 0 && top < 0; i--) if (RULE.test(rows[i]!)) top = i;
  if (top < 0) return other();
  let end = rows.length - 1;
  while (end > top && rows[end]!.trim() === "") end--;
  // Each body row keeps its screen index: a tab row's styles are read by it.
  const body: { at: number; text: string }[] = [];
  for (let i = top + 1; i <= end; i++) {
    const t = rows[i]!.trim();
    if (t === "" || BOX_EDGE.test(t)) continue;
    body.push({ at: i, text: unbox(t) });
  }
  if (body.length === 0) return other();

  const keys = keysOf(body.filter((b) => FOOTER.test(b.text)).flatMap((b) => b.text.split("·")));
  const content = body.filter((b) => !FOOTER.test(b.text));
  const isRow = (text: string) => NUMBERED.test(text) || POINTED.test(text);
  const hasRows = content.some((b) => isRow(b.text));

  let i = 0;
  let title: string | undefined;
  const first = content[0];
  if (first && content.length > 1 && !isRow(first.text) && first.text.split(/\s{2,}/).length === 1 && first.text.length <= 60) {
    title = first.text;
    i = 1;
  }

  const tabs: DialogView["tabs"] = [];
  const tabRow = content[i];
  if (tabRow && !isRow(tabRow.text) && tabRow.text.split(/\s{2,}/).length >= 2) {
    const shown = selectedTab(screen, tabRow.at);
    for (const label of tabRow.text.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)) {
      tabs.push({ label: clip(label, LIMITS.label), selected: shown !== undefined && label === shown });
    }
    i++;
  }

  const note: string[] = [];
  const lines: string[] = [];
  const out: DialogView["rows"] = [];
  let seenRow = false;
  for (; i < content.length; i++) {
    const text = content[i]!.text;
    const n = NUMBERED.exec(text);
    const p = n ? null : POINTED.exec(text);
    if (n || p) {
      seenRow = true;
      const parts = (n ? n[3]! : p![1]!).split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
      const current = (parts[0] ?? "").includes("✔");
      const label = (parts[0] ?? "").replace(/\s*✔\s*/g, " ").trim();
      const detail = parts.slice(1).join("  ");
      out.push({
        label: clip(label, LIMITS.label),
        ...(detail ? { detail: clip(detail, LIMITS.text) } : {}),
        selected: n ? n[1] !== undefined : true,
        current,
      });
    } else if (!hasRows) {
      lines.push(clip(text, LIMITS.text));
    } else if (!seenRow) {
      note.push(clip(text, LIMITS.text));
    }
    // Text after the rows (a choice's hint about its effort, say) is not drawn.
  }

  const kind: DialogView["kind"] = out.length > 0 ? "choice" : title !== undefined || tabs.length > 0 || lines.length > 0 || note.length > 0 ? "panel" : "other";
  if (kind === "other") return other();
  return {
    kind,
    ...(title !== undefined ? { title: clip(title, LIMITS.label) } : {}),
    note: note.slice(0, LIMITS.note),
    tabs: tabs.slice(0, LIMITS.tabs),
    rows: out.slice(0, LIMITS.rows),
    lines: lines.slice(0, LIMITS.lines),
    keys,
  };
}

/**
 * The keys that make a press on a dialog as its terminal takes them: the pointer moved to a row by
 * Up or Down and then Enter, a tab moved to by Left or Right, or the footer's key. A press the dialog
 * does not offer is a conflict, sent nothing.
 */
export function pressKeys(dialog: DialogView, press: DialogPress): string[] {
  if ("row" in press) {
    if (!dialog.rows[press.row]) throw new RpcError("conflict", "the dialog has no such row");
    const at = Math.max(0, dialog.rows.findIndex((r) => r.selected));
    const d = press.row - at;
    return [...Array(Math.abs(d)).fill(d > 0 ? "Down" : "Up"), "Enter"];
  }
  if ("tab" in press) {
    if (!dialog.tabs[press.tab]) throw new RpcError("conflict", "the dialog has no such tab");
    const at = dialog.tabs.findIndex((t) => t.selected);
    if (at < 0) throw new RpcError("conflict", "the tab in use is not known from the screen");
    const d = press.tab - at;
    return Array(Math.abs(d)).fill(d > 0 ? "Right" : "Left");
  }
  if (!dialog.keys.some((k) => k.key === press.key)) throw new RpcError("conflict", "the dialog does not offer that key");
  return [press.key];
}
