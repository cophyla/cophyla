// `~/.cophyla/memory`: what the brain keeps about the user and the work, as markdown files with
// frontmatter `{description, kind, tags}`, served through `memory.*`. The user can read and
// edit them by hand. Every write and delete through here is reported to `onChange`, which
// the daemon points at the recall index; a hand edit is picked up at the next start (and by
// the milestone-7 watcher, which will call the same hook).

import type { Memory } from "@cophyla/protocol";
import type { z } from "zod";
import type { MemoryMeta, MemoryWrite } from "@cophyla/protocol";
import { MarkdownDir } from "./files.ts";
import type { Entry } from "./files.ts";
import { asList, asString } from "./markdown.ts";

export type MemoryMetaT = z.infer<typeof MemoryMeta>;
export type MemoryWriteT = z.infer<typeof MemoryWrite>;

const KINDS = new Set(["user", "preference", "decision", "summary", "entity"]);

function toMemory(e: Entry): Memory {
  const m: Memory = { name: e.name, tags: asList(e.frontmatter["tags"]), body: e.body, updatedAt: e.updatedAt };
  const description = asString(e.frontmatter["description"]);
  if (description !== undefined) m.description = description;
  const kind = asString(e.frontmatter["kind"]);
  if (kind !== undefined && KINDS.has(kind)) m.kind = kind as Memory["kind"];
  return m;
}

function meta(m: Memory): MemoryMetaT {
  const { body: _body, ...rest } = m;
  void _body;
  return rest;
}

export class MemoryFiles {
  private files: MarkdownDir;
  /** Hears every write (`memory` given) and delete (absent) made through this module. */
  onChange?: (name: string, memory: Memory | undefined) => void;

  constructor(dir: string) {
    this.files = new MarkdownDir(dir);
  }

  list(): MemoryMetaT[] {
    return this.files.list().map((e) => meta(toMemory(e)));
  }

  /** Every file whole, for the index's reconcile at start. */
  all(): Memory[] {
    return this.files.list().map(toMemory);
  }

  search(query: string): MemoryMetaT[] {
    return this.files.search(query).map((e) => meta(toMemory(e)));
  }

  read(name: string): Memory {
    return toMemory(this.files.must(name));
  }

  write(input: MemoryWriteT): Memory {
    const frontmatter: Record<string, string | string[]> = {};
    if (input.description !== undefined) frontmatter["description"] = input.description;
    if (input.kind !== undefined) frontmatter["kind"] = input.kind;
    frontmatter["tags"] = input.tags ?? [];
    const m = toMemory(this.files.write(input.name, frontmatter, input.body));
    this.onChange?.(m.name, m);
    return m;
  }

  delete(name: string): boolean {
    if (!this.files.delete(name)) return false;
    this.onChange?.(name, undefined);
    return true;
  }
}
