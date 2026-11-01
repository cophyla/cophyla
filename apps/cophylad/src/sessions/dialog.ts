// Whether a Claude Code or Codex terminal shows a dialog or a view over its prompt (a slash
// command's `/model` picker or `/usage` panel, a permission or a question), read from the
// screen as tether gives it. Where the prompt or composer is up, nothing is over it; where
// it is not, the terminal is showing something the chat has to show in its place.

import { promptInput } from "./claude/screen.ts";
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
