// Loading a module from the editable layer so that a rewrite is seen: an ES import is cached
// by specifier for the life of the process, so each load appends a query string with a
// fresh generation number and the file is evaluated again. The specifier is the absolute
// path, not a `file:` URL: Bun keys its cache on the path with its query, while a URL's
// query is dropped and the first evaluation is returned for ever. A helper the module
// imports by a relative path (`./_lib.ts`) is cached under its own specifier and stays as
// first loaded until the daemon restarts; the README says so. An import that fails is turned
// into a message that names the file, so the problem can be shown beside the file that has it.

import { basename, extname } from "node:path";

/** One counter for the process: the cache is process-wide, so two loaders must never share a generation. */
let generation = 0;

export class ModuleLoader {
  /** The module's namespace after a fresh evaluation of the file. */
  async load(file: string): Promise<Record<string, unknown>> {
    const specifier = file + "?v=" + ++generation;
    return (await import(specifier)) as Record<string, unknown>;
  }
}

/** `my.tool` for `.../my.tool.ts`: the file name without its extension. */
export function stemOf(file: string): string {
  const name = basename(file);
  return name.slice(0, name.length - extname(name).length);
}

/** What went wrong with an import, as one line that starts with the file's name. */
export function describeImportError(file: string, e: unknown): string {
  const name = basename(file);
  if (e instanceof Error) {
    const first = e.message.split("\n").find((l) => l.trim() !== "") ?? e.name;
    return `${name}: ${first.trim()}`;
  }
  return `${name}: ${String(e)}`;
}
