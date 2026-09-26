// How a reply is cut for an engine that makes each piece whole before any of it can play.
// Nothing is heard until the first piece is done, so it is short: the first sentence on its
// own, or the first clause of a long one. Every later piece is made while the ones before it play, so it
// may only be as long as the speech already queued can cover, and grows with it; a long
// sentence that follows a short one would otherwise leave a silence in the middle of the
// reply. Cuts fall at the ends of sentences and lines first, at clause marks when a
// sentence is too long, and between words only for a clause that is itself too long.
// Lengths are counted in characters, which is what the time to speak a piece goes with.

/** The first piece: about a line of speech, so the first words leave at once. */
export const FIRST_PIECE = 90;
/** A later piece may be this many times the characters already queued. */
export const GROWTH = 2.5;
/** No piece is longer than this, however much is queued. */
export const MAX_PIECE = 250;
/** A clause shorter than this is kept with the next one rather than said on its own. */
const MIN_PIECE = 24;

/** A sentence's end: the mark, any closing quote or bracket, then a space before what starts the next. */
const SENTENCE_END = /(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[\p{Lu}\p{N}])/u;
/** A clause's end within a sentence. */
const CLAUSE_END = /(?<=[,;:—–])\s+/;

/** A line that ends without a mark: a list item, a heading. */
const UNFINISHED = /[^.!?…,;:"'”’)\]]$/;

/** Clauses in order, each marked when it ends a sentence or a line. A line is a sentence, so one left open is closed. */
function units(text: string): { text: string; ends: boolean }[] {
  const out: { text: string; ends: boolean }[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    for (const sentence of (UNFINISHED.test(line) ? `${line}.` : line).split(SENTENCE_END)) {
      const clauses = sentence
        .split(CLAUSE_END)
        .map((c) => c.trim())
        .filter(Boolean);
      clauses.forEach((c, i) => out.push({ text: c, ends: i === clauses.length - 1 }));
    }
  }
  return out;
}

/** A clause longer than `max`, cut between words. */
function byWords(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > max) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

/** The pieces `text` is spoken in, in order; their words are the text's words, with a line left open closed by a full stop. */
export function speechPieces(text: string): string[] {
  const pieces: string[] = [];
  let queued = 0;
  let cur = "";
  let curEnds = false;
  const limit = () => (pieces.length === 0 ? FIRST_PIECE : Math.min(MAX_PIECE, Math.max(FIRST_PIECE, queued * GROWTH)));
  const push = () => {
    for (const p of byWords(cur, MAX_PIECE)) {
      pieces.push(p);
      queued += p.length;
    }
    cur = "";
    curEnds = false;
  };
  for (const u of units(text)) {
    // What is held goes out before a clause that would take it past the limit, unless it is
    // a fragment too short to be said alone.
    if (cur && cur.length + 1 + u.text.length > limit() && (curEnds || cur.length >= MIN_PIECE)) push();
    cur = cur ? `${cur} ${u.text}` : u.text;
    curEnds = u.ends;
    // The first sentence goes alone, however short the next: nothing plays until it is made.
    if (pieces.length === 0 && curEnds && cur.length >= MIN_PIECE) push();
  }
  if (cur) push();
  return pieces;
}
