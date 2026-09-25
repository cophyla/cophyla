// A memory file's body split into heading sections, each with its 1-based body line range:
// the same numbering `bodyLines()` gives a `memory.read` quote, so a recall hit and a quote
// of the same lines agree. A section runs from a heading line to the line before the next
// heading; text before the first heading is a section of its own. A section over
// `MAX_SECTION_CHARS` is split at blank lines so no chunk is unwieldy.

export interface Section {
  /** 1-based body lines, inclusive. */
  from: number;
  to: number;
  text: string;
}

export const MAX_SECTION_CHARS = 2048;

const HEADING = /^#{1,6}\s/;

/** Trims blank edge lines off a run, keeping the line numbers honest; `undefined` when nothing is left. */
function trimmed(lines: string[], start: number, end: number): Section | undefined {
  let a = start;
  let b = end;
  while (a <= b && lines[a - 1]!.trim() === "") a++;
  while (b >= a && lines[b - 1]!.trim() === "") b--;
  if (a > b) return undefined;
  return { from: a, to: b, text: lines.slice(a - 1, b).join("\n") };
}

/** Splits one run at blank lines into pieces under the cap; a piece with no blank line inside stays whole. */
function pieces(lines: string[], start: number, end: number): Section[] {
  const whole = trimmed(lines, start, end);
  if (!whole) return [];
  if (whole.text.length <= MAX_SECTION_CHARS) return [whole];
  const out: Section[] = [];
  let pieceStart = whole.from;
  let size = 0;
  let lastBlank = 0;
  for (let i = whole.from; i <= whole.to; i++) {
    const line = lines[i - 1]!;
    if (line.trim() === "") lastBlank = i;
    size += line.length + 1;
    if (size > MAX_SECTION_CHARS && lastBlank > pieceStart) {
      // Cut at the last blank line seen: the piece before it is under the cap or has no blank line to cut at.
      const p = trimmed(lines, pieceStart, lastBlank - 1);
      if (p) out.push(p);
      pieceStart = lastBlank + 1;
      size = 0;
      for (let j = pieceStart; j <= i; j++) size += lines[j - 1]!.length + 1;
      lastBlank = 0;
    }
  }
  const last = trimmed(lines, pieceStart, whole.to);
  if (last) out.push(last);
  return out;
}

export function splitSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (HEADING.test(lines[i]!)) starts.push(i + 1);
  const out: Section[] = [];
  let cursor = 1;
  for (const s of starts) {
    if (s > cursor) out.push(...pieces(lines, cursor, s - 1));
    cursor = s;
  }
  out.push(...pieces(lines, cursor, lines.length));
  return out;
}
