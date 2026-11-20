// A message written for the eye, said for the ear: what an agent wrote in markdown, read out
// when the user asks to hear it. Its marks are dropped (headings, emphasis, bullets, quotes); a
// code block is named and not read, since code read aloud is noise; a table is read a row at a
// time; a link by its words and a bare one by its site; a path by its file's name. Each line
// ends as a sentence, so the engine pauses between them. Past `EAR_MAX` it stops at a sentence
// and says the rest is on screen.

/** The most of a message read out, in characters: about half an hour. */
export const EAR_MAX = 30_000;
/** What is said where a code block was. */
export const CODE_WORDS = "A code block.";
/** What is said where the reading stops short. */
export const CUT_WORDS = "That is as much as I read out; the rest is on screen.";

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** A path with a folder in it: a drive's or the root's, or relative ending in a file with an extension. */
const ABSOLUTE_PATH = /(?<![\w.~\\/-])(?:[A-Za-z]:[\\/]|\\\\|\/(?=[\w.~-]+[\\/]))(?:[^\s\\/:*?"<>|`]+[\\/])+([^\s\\/:*?"<>|`]*)/g;
const RELATIVE_PATH = /(?<![\w/\\.])(?:[\w.~-]+[\\/])+([\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9]{1,8})(?![\w/\\])/g;
const URL = /\bhttps?:\/\/([^\s/)>\]]+)[^\s)>\]]*/g;

/** A message's markdown as it is said. */
export function forTheEar(text: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const opens = FENCE.exec(raw);
    if (fence !== undefined) {
      // inside a code block: nothing is read until it closes
      if (opens && opens[1]!.startsWith(fence[0]!) && opens[1]!.length >= fence.length && raw.trim() === opens[1]) fence = undefined;
      continue;
    }
    if (opens) {
      fence = opens[1]!;
      lines.push(CODE_WORDS);
      continue;
    }
    if (TABLE_RULE.test(raw) && raw.includes("-")) continue;
    if (TABLE_ROW.test(raw)) {
      const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c)).filter((c) => c !== "");
      if (cells.length > 0) lines.push(sentence(cells.join(", ")));
      continue;
    }
    const line = inline(
      raw
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, ""),
    );
    if (line !== "") lines.push(sentence(line));
  }
  return cut(lines.join(" ").replace(/\s{2,}/g, " ").trim());
}

/** A line's own marks: links, code spans, emphasis, tags, paths, said as words. */
function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(URL, (_m, host: string) => host.replace(/^www\./, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(ABSOLUTE_PATH, (_m, file: string) => file)
    .replace(RELATIVE_PATH, (_m, file: string) => file)
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A line ended as a sentence, so the engine pauses after it. */
function sentence(line: string): string {
  return /[.!?:;…]["')\]]?$/.test(line) ? line : `${line}.`;
}

/** What is past `EAR_MAX` goes, at the end of a sentence, and the listener is told. */
function cut(text: string): string {
  if (text.length <= EAR_MAX) return text;
  const head = text.slice(0, EAR_MAX);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return `${end > EAR_MAX / 2 ? head.slice(0, end + 1) : head} ${CUT_WORDS}`;
}
