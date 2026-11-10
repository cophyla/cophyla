// A full path with a space in a name, as the words around it spell it. `pathsIn` stops at the
// space (`C:\Program`) and keeps the words after it (` Files\nodejs\node.exe and ran it`); which
// of those go on with the path is the path's computer's to say, so its names are read a folder
// at a time: from the folder the first name with a space is in, the longest name there that the
// words begin with, ending where a name may end, then on through the separator after a folder,
// until the words name nothing more, the path then ending at the folder. Past a folder that
// cannot be read (an older computer's, one refused), what the words spell with no space
// (`report.pdf`) is taken as written, as it would be with no space before it. The words
// may run on into a sentence (`C:\D\Faircase and its tests in tests.py`): only names that are
// there count, so the path stays `C:\D\Faircase`. Pure but for the listing it is handed.

/** A folder's names: its folders and its files. */
export interface Names {
  folders: readonly string[];
  files: readonly string[];
}

/** The names in a folder, by its path as the words spell it; none when it cannot be read. */
export type Lister = (dir: string) => Promise<Names | undefined>;

/** How far the path goes, from its start, and whether it names a folder. */
export interface Spelled {
  length: number;
  folder: boolean;
}

/** Folders read at most for one path. */
const DEPTH = 16;
const SEP = /[\\/]/;
/** What the words may take past the last folder read, as the strict path would: names with no space, and the separators between them. */
const AS_WRITTEN = /^(?:[\w.@+-]+[\\/])*(?:[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,11}|[\w@+-](?:[\w.@+-]*[\w@+-])?)?/;

/** Whether a name may end at `i` of the words: at their end, a space, a separator, what ends a sentence's clause, or a stop that ends it. */
export function nameEnds(words: string, i: number): boolean {
  const next = words[i];
  if (next === undefined) return true;
  if (/[\s\\/,;:!?)\]}'"`>]/.test(next)) return true;
  return next === "." && (i + 1 >= words.length || /\s/.test(words[i + 1]!));
}

/**
 * How far a full path with spaces goes: `strict` is the path as far as the first space, `more`
 * the words after it; `fold` compares names as the computer's filesystem does, without case.
 * Undefined when it goes no further than `strict`, or nothing could be read.
 */
export async function spelledPath(strict: string, more: string, list: Lister, fold: boolean): Promise<Spelled | undefined> {
  const cut = Math.max(strict.lastIndexOf("/"), strict.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  const words = strict + more;
  const same = (a: string, b: string) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  let at = cut + 1;
  // The first name read holds the strict path's last name at least.
  let least = strict.length - at;
  let folder = false;
  let found = false;
  for (let level = 0; level < DEPTH; level++) {
    const names = await list(words.slice(0, at));
    let best: { name: string; dir: boolean } | undefined;
    for (const [all, dir] of [
      [names?.folders ?? [], true],
      [names?.files ?? [], false],
    ] as const) {
      for (const name of all) {
        if (name.length < Math.max(least, 1) || (best && name.length <= best.name.length)) continue;
        if (!same(words.slice(at, at + name.length), name) || !nameEnds(words, at + name.length)) continue;
        best = { name, dir };
      }
    }
    if (!best) {
      // Past the first folder, one that could not be read takes what follows with no space as written.
      if (level > 0 && names === undefined) {
        const written = AS_WRITTEN.exec(words.slice(at))?.[0] ?? "";
        if (written !== "") {
          at += written.length;
          folder = SEP.test(written[written.length - 1]!);
        }
      }
      break;
    }
    found = true;
    at += best.name.length;
    folder = best.dir;
    least = 0;
    // A folder goes on through the separator after it; one the words end at is the folder itself.
    if (!best.dir || !SEP.test(words[at] ?? "")) break;
    at += 1;
    if (at >= words.length || /\s/.test(words[at]!)) break;
  }
  return found && at > strict.length ? { length: at, folder } : undefined;
}
