// `~/.cophyla/prompts`: reusable prompts as markdown files with frontmatter
// `{description, tags, variables}`, served through `prompt.*`.

import type { Prompt } from "@cophyla/protocol";
import type { z } from "zod";
import type { PromptMeta, PromptWrite } from "@cophyla/protocol";
import { MarkdownDir } from "./files.ts";
import type { Entry } from "./files.ts";
import { asList, asString } from "./markdown.ts";

export type PromptMetaT = z.infer<typeof PromptMeta>;
export type PromptWriteT = z.infer<typeof PromptWrite>;

/** `{{name}}` placeholders in a body, in order of first appearance. */
export function placeholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

function toPrompt(e: Entry): Prompt {
  const p: Prompt = { name: e.name, tags: asList(e.frontmatter["tags"]), body: e.body, updatedAt: e.updatedAt };
  const description = asString(e.frontmatter["description"]);
  if (description !== undefined) p.description = description;
  const variables = e.frontmatter["variables"] !== undefined ? asList(e.frontmatter["variables"]) : placeholders(e.body);
  if (variables.length > 0) p.variables = variables;
  return p;
}

function meta(p: Prompt): PromptMetaT {
  const { body: _body, ...rest } = p;
  void _body;
  return rest;
}

export class Prompts {
  private files: MarkdownDir;

  constructor(dir: string) {
    this.files = new MarkdownDir(dir);
  }

  list(): PromptMetaT[] {
    return this.files.list().map((e) => meta(toPrompt(e)));
  }

  search(query: string): PromptMetaT[] {
    return this.files.search(query).map((e) => meta(toPrompt(e)));
  }

  read(name: string): Prompt {
    return toPrompt(this.files.must(name));
  }

  write(input: PromptWriteT): Prompt {
    const frontmatter: Record<string, string | string[]> = {};
    if (input.description !== undefined) frontmatter["description"] = input.description;
    frontmatter["tags"] = input.tags ?? [];
    const variables = input.variables ?? placeholders(input.body);
    if (variables.length > 0) frontmatter["variables"] = variables;
    return toPrompt(this.files.write(input.name, frontmatter, input.body));
  }

  delete(name: string): boolean {
    return this.files.delete(name);
  }
}
