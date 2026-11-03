// Words dictated with the talk button, typed where the user is writing: the field of the
// button pressed, or, from a phone's bar, the field of the page that shows (`view.ts` picks it).
// Held, the button listens until it is let go; tapped, it listens on, and Cancel, Stop and Stop
// and send take its place and the send button's until one is pressed. The words heard so far
// show at the caret as they grow and give way to the whole once it comes; a press taken back
// (Cancel, Escape), or one nothing was heard in, leaves the field as it was. Nothing is sent
// unless the user asks with Stop and send (or Enter while it listens): otherwise they send it,
// as anything typed. DOM-free, so the splicing and the tap are tested alone.

/** Where in a field the words go: the text around the caret, and the spaces that keep them words of their own. */
export interface Splice {
  before: string;
  after: string;
  lead: string;
  trail: string;
}

/** The place a dictation types into `value`: over the selection, or at the end when the field had no caret. */
export function spliceAt(value: string, start: number, end: number): Splice {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  return {
    before,
    after,
    lead: before !== "" && !/\s$/.test(before) ? " " : "",
    trail: after !== "" && !/^\s/.test(after) ? " " : "",
  };
}

/** The field with `words` in their place, and where the caret goes: after them. No words, the field as it was. */
export function spliced(s: Splice, words: string): { value: string; caret: number } {
  const said = words.trim();
  if (said === "") return { value: s.before + s.after, caret: s.before.length };
  const head = s.before + s.lead + said;
  return { value: head + s.trail + s.after, caret: head.length };
}

/** The words heard so far, from the last ones and a `voice.partial`: `from` of them kept, `text` after. */
export function grown(words: string, p: { text: string; from?: number }): string {
  return words.slice(0, p.from ?? 0) + p.text;
}

/** A press of the talk button let go sooner than this is a tap: it listens on, to be stopped, sent or cancelled. */
export const TAP_MS = 300;

/** Whether a press let go `ms` after it began was a tap, which leaves the recording on, rather than a hold, which its release ends. */
export function tapped(ms: number): boolean {
  return ms >= 0 && ms < TAP_MS;
}

/** Words for a terminal: one line, so a program that takes no bracketed paste is never sent an Enter. */
export function terminalWords(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
