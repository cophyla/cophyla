// What the chat's own session is told beside a prompt reaches it through its harness, and a
// harness caps what one hook or one entry may carry: Claude Code keeps about 10,000 characters
// of a hook's additional context inline and files the rest away behind a preview; Codex cuts
// an entry of a turn's additional context to about a thousand tokens. Both caps are per hook
// and per entry, so the text is cut on line boundaries into parts that each fit, and every
// part travels on its own. A part of several says which it is, since nothing promises the
// harness joins them in order.

/** One hook's worth for Claude Code, under its cap of about 10,000 characters. */
export const CLAUDE_PART_CHARS = 9000;
/** One entry's worth for Codex, under its cap of about 1,000 tokens. */
export const CODEX_PART_CHARS = 3400;
/** The most parts a telling is cut into: the hooks installed for a prompt, and for a session's start. */
export const MAX_PARTS = 4;

/**
 * `text` as at most `max` parts of at most `size` characters, cut between lines; a line longer
 * than a part is cut where it must be. What does not fit the last part is left out, and the
 * part says so.
 */
/** The least a part holds, whatever size is asked for. */
const MIN_PART_CHARS = 200;

export function parts(text: string, size: number, max: number = MAX_PARTS): string[] {
  if (text.length <= size) return text === "" ? [] : [text];
  // Room for the line that names the part; never so little that the cutting would not end.
  const room = Math.max(size, MIN_PART_CHARS) - 40;
  const out: string[] = [];
  let current = "";
  const push = () => {
    if (current !== "") out.push(current);
    current = "";
  };
  for (let line of text.split("\n")) {
    if (current !== "" && current.length + 1 + line.length > room) push();
    while (line.length > room) {
      out.push(line.slice(0, room));
      line = line.slice(room);
    }
    current = current === "" ? line : `${current}\n${line}`;
  }
  push();
  const kept = out.slice(0, max);
  if (out.length > max) kept[max - 1] = `${kept[max - 1]!.slice(0, room - 60)}\n[cut here: the rest did not fit]`;
  return kept.map((p, i) => `[cophyla context, part ${i + 1} of ${kept.length}]\n${p}`);
}
