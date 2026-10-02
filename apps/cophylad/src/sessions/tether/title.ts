// A terminal's title as the views are told it: the spinner or mark an agent CLI draws before its
// words taken off (Codex's braille dots, ten frames a second; Claude Code's ◐ ◓ ◑ ◒ at work and
// ✳ at rest). A title that only spun is the same row, and no client hears it again.

import type { Terminal } from "@cophyla/protocol";

/**
 * What spinners are drawn with, before the words and the spaces after them: a middle dot or a
 * bullet, arrows, mathematical and technical signs, box and block pieces, geometric shapes,
 * dingbats and braille. Letters, digits and ASCII (a path's `~/`, a `[1]`) stay.
 */
const SPINNER = /^\s*[·•←-⑟─-⣿]+\s*/u;

/** A title with any spinner before its words off; one that was only a spinner is empty. */
export function plainTitle(title: string): string {
  return title.replace(SPINNER, "");
}

/** A terminal's row with its title plain, and without one when nothing is left of it. */
export function plainRow(row: Terminal): Terminal {
  if (row.title === undefined) return row;
  const title = plainTitle(row.title);
  if (title === row.title) return row;
  const { title: _title, ...rest } = row;
  return title ? { ...rest, title } : rest;
}
