// One directory of markdown files with frontmatter, named by file stem: the shape shared by
// prompts and memory. List gives the metadata, search ranks by substring (name, then
// description, then body), read returns the body, write and delete change the file. The
// watcher and the `*.changed` notices arrive with milestone 7.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import { parseMarkdown, serialiseMarkdown } from "./markdown.ts";
import type { Frontmatter } from "./markdown.ts";

export const NAME = /^[a-z0-9][a-z0-9._-]*$/;

export interface Entry {
  name: string;
  frontmatter: Frontmatter;
  body: string;
  updatedAt: number;
}

export class MarkdownDir {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static checkName(name: string): string {
    if (!NAME.test(name) || name.length > 120) throw new RpcError("invalid", `bad name: ${name}`);
    return name;
  }

  private pathOf(name: string): string {
    return join(this.dir, `${MarkdownDir.checkName(name)}.md`);
  }

  names(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((n) => NAME.test(n))
      .sort();
  }

  read(name: string): Entry | undefined {
    const path = this.pathOf(name);
    let text: string;
    let updatedAt: number;
    try {
      text = readFileSync(path, "utf8");
      updatedAt = Math.round(statSync(path).mtimeMs);
    } catch {
      return undefined;
    }
    const { frontmatter, body } = parseMarkdown(text);
    return { name, frontmatter, body, updatedAt };
  }

  must(name: string): Entry {
    const e = this.read(name);
    if (!e) throw new RpcError("not_found", `no ${name}`);
    return e;
  }

  list(): Entry[] {
    const out: Entry[] = [];
    for (const n of this.names()) {
      const e = this.read(n);
      if (e) out.push(e);
    }
    return out;
  }

  /** Substring search, ranked: a hit in the name outranks one in the description outranks one in the body. */
  search(query: string): Entry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    const words = q.split(/\s+/).filter(Boolean);
    const scored: { e: Entry; score: number }[] = [];
    for (const e of this.list()) {
      const name = e.name.toLowerCase();
      const description = String(e.frontmatter["description"] ?? "").toLowerCase();
      const body = e.body.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 3;
        if (description.includes(w)) score += 2;
        if (body.includes(w)) score += 1;
      }
      if (score > 0) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
    return scored.map((s) => s.e);
  }

  write(name: string, frontmatter: Frontmatter, body: string): Entry {
    const path = this.pathOf(name);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path, serialiseMarkdown(frontmatter, body), "utf8");
    return this.must(name);
  }

  delete(name: string): boolean {
    const path = this.pathOf(name);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }
}
