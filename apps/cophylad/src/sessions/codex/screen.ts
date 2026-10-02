// What a Codex TUI's screen says: whether its composer is up (the footer under it offers the
// shortcuts, which none of its first screens does: they end in `enter continue` or `enter
// select`), and what it waits on when it is not. Read off Codex 0.159 on Windows.

import { rowsOf } from "../claude/screen.ts";
import type { ScreenLike } from "../claude/screen.ts";

/** The composer is up: the footer under it says `? for shortcuts`. */
export function composerUp(s: ScreenLike): boolean {
  return /\?\s*for shortcuts/.test(rowsOf(s).join("\n"));
}

/** What a Codex TUI that is not at its composer waits on, in words; undefined when it is not one of its first screens. */
export function waitingOn(s: ScreenLike): string | undefined {
  const text = rowsOf(s).join("\n");
  if (/Trust this folder\?/i.test(text)) return "the question whether to trust the folder";
  if (/Set up the Codex agent sandbox/i.test(text)) return "the question how to set up its sandbox";
  if (/Sign in with ChatGPT|Provide your own API key/i.test(text)) return "a sign-in";
  return undefined;
}
