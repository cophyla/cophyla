// The built-in tools: `fs.read`, `fs.grep`, `fs.glob`, `fs.outline` and `http.get`. Paths
// are absolute or relative to a workspace id; the read tools return numbered `n\tline` rows
// so a quote can cite a line, with long lines cut. `fs.outline` walks the markdown files of a
// directory, honouring `.gitignore`, and ranks them against a few query words. The platform
// offers the brain no shell and no file write: work that needs them goes to an agent.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { RpcError } from "@cophyla/protocol";
import { normalisePath } from "../workspaces/index.ts";
import type { Tool, ToolContext } from "./index.ts";

// --- paths ---------------------------------------------------------------------------------------

/** An absolute path, or one under the named workspace; on a confined node, inside the folders it shares. */
export function resolvePath(path: string, workspace: string | undefined, ctx: ToolContext): string {
  let out: string;
  if (workspace !== undefined) {
    const ws = ctx.workspaces.get(workspace);
    if (!ws) throw new RpcError("not_found", `no workspace ${workspace}`);
    out = normalisePath(isAbsolute(path) ? path : join(ws.path, path));
  } else {
    if (!isAbsolute(path)) throw new RpcError("invalid", `path must be absolute or name a workspace: ${path}`);
    out = normalisePath(path);
  }
  ctx.confine?.require(out, path);
  return out;
}

function resolveRoot(root: string | undefined, workspace: string | undefined, ctx: ToolContext): string {
  if (workspace !== undefined) return resolvePath(root ?? ".", workspace, ctx);
  if (root === undefined) throw new RpcError("invalid", "root or workspace is required");
  return resolvePath(root, undefined, ctx);
}

function mustBeFile(path: string): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new RpcError("not_found", `no file ${path}`);
  }
  if (!st.isFile()) throw new RpcError("invalid", `not a file: ${path}`);
}

function mustBeDir(path: string): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new RpcError("not_found", `no directory ${path}`);
  }
  if (!st.isDirectory()) throw new RpcError("invalid", `not a directory: ${path}`);
}

function readLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
  return lines;
}

function cut(line: string, max: number): string {
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function numbered(lines: { n: number; text: string }[], maxChars: number): string {
  return lines.map((l) => `${l.n}\t${cut(l.text, maxChars)}`).join("\n");
}

// --- ignore rules ------------------------------------------------------------------------------

const ALWAYS_IGNORED = [".git", "node_modules"];

export interface Ignore {
  /** `rel` is forward-slashed, relative to the root. */
  ignores(rel: string, isDir: boolean): boolean;
}

/** The root `.gitignore` as a small matcher: comments, negations dropped, anchored and unanchored patterns, directory-only patterns. */
export function gitignore(root: string): Ignore {
  const globs: { glob: Bun.Glob; dirOnly: boolean }[] = [];
  const file = join(root, ".gitignore");
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      const dirOnly = line.endsWith("/");
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
      if (line.startsWith("/")) line = line.slice(1);
      const patterns = anchored ? [line, `${line}/**`] : [`**/${line}`, `**/${line}/**`, line, `${line}/**`];
      for (const p of patterns) {
        try {
          globs.push({ glob: new Bun.Glob(p), dirOnly });
        } catch {
          // a pattern Bun.Glob cannot parse is skipped
        }
      }
    }
  }
  return {
    ignores(rel, isDir) {
      const parts = rel.split("/");
      if (parts.some((p) => ALWAYS_IGNORED.includes(p))) return true;
      for (const g of globs) {
        if (g.dirOnly && !isDir && !rel.includes("/")) continue;
        if (g.glob.match(rel)) return true;
      }
      return false;
    },
  };
}

function walk(root: string, pattern: string, ignore: Ignore, max: number, signal?: AbortSignal): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const glob = new Bun.Glob(pattern);
  for (const rel of glob.scanSync({ cwd: root, dot: false, onlyFiles: true, followSymlinks: false })) {
    if (signal?.aborted) throw new RpcError("cancelled", "cancelled");
    const fwd = rel.split(sep).join("/");
    if (ignore.ignores(fwd, false)) continue;
    const dirs = fwd.split("/").slice(0, -1);
    let skip = false;
    for (let i = 1; i <= dirs.length; i++) {
      if (ignore.ignores(dirs.slice(0, i).join("/"), true)) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    if (files.length >= max) {
      truncated = true;
      break;
    }
    files.push(fwd);
  }
  files.sort();
  return { files, truncated };
}

// --- fs.read ---------------------------------------------------------------------------------

const ReadArgs = z.object({
  path: z.string().min(1).describe("absolute, or relative to `workspace`"),
  workspace: z.string().optional().describe("a workspace id the path is under"),
  offset: z.number().int().positive().optional().describe("first line to return, 1-based; 1 when absent"),
  lines: z.number().int().positive().optional().describe("how many lines; the configured cap when absent"),
});

export const fsRead: Tool<z.infer<typeof ReadArgs>> = {
  name: "fs.read",
  description: "Read a text file whole or from an offset for a number of lines. Returns `n\\tline` rows, long lines cut.",
  schema: ReadArgs,
  risk: "read",
  run(args, ctx) {
    const path = resolvePath(args.path, args.workspace, ctx);
    mustBeFile(path);
    const all = readLines(path);
    const from = Math.max(1, args.offset ?? 1);
    const cap = ctx.config.read_max_lines;
    const count = Math.min(args.lines ?? cap, cap);
    const slice = all.slice(from - 1, from - 1 + count);
    const to = slice.length === 0 ? from - 1 : from + slice.length - 1;
    const truncated = to < all.length || (args.lines !== undefined && args.lines > cap);
    return {
      path,
      from,
      to,
      total: all.length,
      ...(truncated ? { truncated: true } : {}),
      text: numbered(
        slice.map((text, i) => ({ n: from + i, text })),
        ctx.config.line_max_chars,
      ),
    };
  },
};

// --- fs.grep ---------------------------------------------------------------------------------

const GrepArgs = z.object({
  path: z.string().min(1).describe("the file to search; absolute, or relative to `workspace`"),
  workspace: z.string().optional(),
  pattern: z.string().min(1).describe("a regular expression"),
  ignoreCase: z.boolean().optional(),
  max: z.number().int().positive().optional().describe("matches to return at most"),
});

export const fsGrep: Tool<z.infer<typeof GrepArgs>> = {
  name: "fs.grep",
  description: "Find the lines of one file that match a regular expression. Returns `n\\tline` rows.",
  schema: GrepArgs,
  risk: "read",
  run(args, ctx) {
    const path = resolvePath(args.path, args.workspace, ctx);
    mustBeFile(path);
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
    } catch (e) {
      throw new RpcError("invalid", `bad pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
    const cap = Math.min(args.max ?? ctx.config.grep_max, ctx.config.grep_max);
    const hits: { n: number; text: string }[] = [];
    let total = 0;
    const all = readLines(path);
    for (let i = 0; i < all.length; i++) {
      if (re.test(all[i]!)) {
        total++;
        if (hits.length < cap) hits.push({ n: i + 1, text: all[i]! });
      }
    }
    return { path, matches: total, ...(total > hits.length ? { truncated: true } : {}), text: numbered(hits, ctx.config.line_max_chars) };
  },
};

// --- fs.glob ---------------------------------------------------------------------------------

const GlobArgs = z.object({
  root: z.string().optional().describe("the directory to search; absolute, or relative to `workspace`"),
  workspace: z.string().optional(),
  pattern: z.string().min(1).describe("a glob such as **/*.md"),
  max: z.number().int().positive().optional(),
});

export const fsGlob: Tool<z.infer<typeof GlobArgs>> = {
  name: "fs.glob",
  description: "List the files under a directory that match a glob, skipping .git, node_modules and the root .gitignore's entries. Paths are relative to the root.",
  schema: GlobArgs,
  risk: "read",
  run(args, ctx) {
    const root = resolveRoot(args.root, args.workspace, ctx);
    mustBeDir(root);
    const cap = Math.min(args.max ?? ctx.config.glob_max, ctx.config.glob_max);
    const { files, truncated } = walk(root, args.pattern, gitignore(root), cap, ctx.signal);
    return { root, files, ...(truncated ? { truncated: true } : {}) };
  },
};

// --- fs.outline -------------------------------------------------------------------------------

const OutlineArgs = z.object({
  root: z.string().optional().describe("the directory whose markdown files to outline; absolute, or relative to `workspace`"),
  workspace: z.string().optional(),
  query: z.string().optional().describe("a few words to rank the files by; every file when absent"),
  maxFiles: z.number().int().positive().optional(),
});

export interface OutlineHeading {
  level: number;
  text: string;
  line: number;
}

export interface OutlineFile {
  path: string;
  title: string;
  headings: OutlineHeading[];
  score: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FRONTMATTER_TITLE = /^title:\s*["']?(.+?)["']?\s*$/m;

/** The title from the first heading, else the frontmatter, else the filename; every heading with its level and line. */
export function outlineMarkdown(text: string, path: string): { title: string; headings: OutlineHeading[] } {
  const lines = text.split(/\r?\n/);
  const headings: OutlineHeading[] = [];
  let inFence = false;
  let frontmatter: string | undefined;
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      frontmatter = lines.slice(1, end).join("\n");
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING.exec(line);
    if (m) headings.push({ level: m[1]!.length, text: m[2]!, line: i + 1 });
  }
  const fromFrontmatter = frontmatter ? FRONTMATTER_TITLE.exec(frontmatter)?.[1] : undefined;
  const title = headings[0]?.text ?? fromFrontmatter ?? basename(path).replace(/\.md$/i, "");
  return { title, headings };
}

function words(q: string | undefined): string[] {
  return (q ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1);
}

export const fsOutline: Tool<z.infer<typeof OutlineArgs>> = {
  name: "fs.outline",
  description:
    "Outline the markdown files under a directory: each file's title and headings with their line numbers, ranked against a few query words by path, title and headings. Honours .gitignore; capped by file count.",
  schema: OutlineArgs,
  risk: "read",
  run(args, ctx) {
    const root = resolveRoot(args.root, args.workspace, ctx);
    mustBeDir(root);
    const cap = Math.min(args.maxFiles ?? ctx.config.outline_max_files, ctx.config.outline_max_files);
    const { files, truncated } = walk(root, "**/*.{md,markdown}", gitignore(root), cap, ctx.signal);
    const q = words(args.query);
    const out: OutlineFile[] = [];
    for (const rel of files) {
      if (ctx.signal?.aborted) throw new RpcError("cancelled", "cancelled");
      // a link inside the folder may lead out of it
      if (ctx.confine && !ctx.confine.contains(join(root, rel), true)) continue;
      let text: string;
      try {
        text = readFileSync(join(root, rel), "utf8");
      } catch {
        continue;
      }
      const { title, headings } = outlineMarkdown(text, rel);
      let score = 0;
      if (q.length > 0) {
        const path = rel.toLowerCase();
        const t = title.toLowerCase();
        const hs = headings.map((h) => h.text.toLowerCase());
        for (const w of q) {
          if (t.includes(w)) score += 3;
          if (hs.some((h) => h.includes(w))) score += 2;
          if (path.includes(w)) score += 1;
        }
        if (score === 0) continue;
      }
      out.push({ path: rel, title, headings, score });
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { root, files: out, ...(truncated ? { truncated: true } : {}) };
  },
};

// --- http.get ---------------------------------------------------------------------------------

const HttpArgs = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  maxBytes: z.number().int().positive().optional(),
});

const MAX_REDIRECTS = 3;

export const httpGet: Tool<z.infer<typeof HttpArgs>> = {
  name: "http.get",
  description: "Fetch a URL over http(s) with GET, following up to three redirects, and return the body as text up to a byte cap.",
  schema: HttpArgs,
  risk: "network",
  async run(args, ctx) {
    const cap = Math.min(args.maxBytes ?? ctx.config.http_max_bytes, ctx.config.http_max_bytes);
    let url = args.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.config.http_timeout_ms);
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (let hop = 0; ; hop++) {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new RpcError("invalid", `only http(s) urls: ${url}`);
        let res: Response;
        try {
          res = await fetch(url, { method: "GET", headers: args.headers ?? {}, redirect: "manual", signal: controller.signal });
        } catch (e) {
          if (ctx.signal?.aborted) throw new RpcError("cancelled", "cancelled");
          if (controller.signal.aborted) throw new RpcError("timeout", `no answer within ${ctx.config.http_timeout_ms} ms`);
          throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          if (hop >= MAX_REDIRECTS) throw new RpcError("unavailable", "too many redirects");
          url = new URL(res.headers.get("location")!, url).toString();
          continue;
        }
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        let truncated = false;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (bytes + value.length > cap) {
              chunks.push(value.subarray(0, cap - bytes));
              bytes = cap;
              truncated = true;
              await reader.cancel();
              break;
            }
            chunks.push(value);
            bytes += value.length;
          }
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return {
          url,
          status: res.status,
          contentType: res.headers.get("content-type") ?? undefined,
          bytes,
          ...(truncated ? { truncated: true } : {}),
          text,
        };
      }
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
};

export function builtinTools(): Tool[] {
  return [fsRead as Tool, fsGrep as Tool, fsGlob as Tool, fsOutline as Tool, httpGet as Tool];
}

