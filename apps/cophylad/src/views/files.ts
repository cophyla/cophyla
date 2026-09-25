// The pure part of serving a view directory: which files are served, as what type, under
// which version. `.ts` files are type-stripped and served under their own path as
// JavaScript, so `import "./model.ts"` in a view works with no rewriting.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import type { ViewFile } from "@cophyla/protocol";

export const MIME: Record<string, string> = {
  ".ts": "text/javascript",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

export const DEFAULT_MIME = "application/octet-stream";

/** Bytes per file; a bigger one is left out of the view. */
export const FILE_CAP = 4 * 1024 * 1024;

export const MANIFEST_FILE = "view.json";

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? DEFAULT_MIME;
}

export function isText(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "image/svg+xml";
}

export interface WalkedFile {
  /** Forward-slash path relative to the view directory. */
  path: string;
  bytes: Buffer;
}

export type SkipReason = "dotfile" | "node_modules" | "manifest" | "symlink_escape" | "too_large";

export interface WalkOptions {
  onSkip?: (path: string, reason: SkipReason) => void;
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Every regular file under `dir`, recursively, sorted by path. Dotfiles, `node_modules` and
 * the manifest are left out; a symlink is followed only while its target stays inside the
 * directory; a file over the cap is left out.
 */
export function walk(dir: string, opts: WalkOptions = {}): WalkedFile[] {
  const root = realpathSync(dir);
  const out: WalkedFile[] = [];
  const visit = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const name = entry.name;
      const relPath = rel ? `${rel}/${name}` : name;
      const absPath = join(abs, name);
      if (name.startsWith(".")) {
        opts.onSkip?.(relPath, "dotfile");
        continue;
      }
      if (name === "node_modules") {
        opts.onSkip?.(relPath, "node_modules");
        continue;
      }
      if (!rel && name === MANIFEST_FILE) {
        opts.onSkip?.(relPath, "manifest");
        continue;
      }
      let target = absPath;
      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(absPath);
        } catch {
          continue;
        }
        const inside = relative(root, real);
        if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
          opts.onSkip?.(relPath, "symlink_escape");
          continue;
        }
        target = real;
      }
      const stat = entry.isSymbolicLink() ? statSync(target) : lstatSync(absPath);
      if (stat.isDirectory()) {
        visit(target, relPath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > FILE_CAP) {
        opts.onSkip?.(relPath, "too_large");
        continue;
      }
      out.push({ path: relPath, bytes: readFileSync(target) });
    }
  };
  visit(root, "");
  out.sort(byPath);
  return out;
}

/** sha256 over the sorted `path\0bytes\0` sequence, first 16 hex digits. */
export function versionOf(files: WalkedFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort(byPath)) {
    h.update(f.path, "utf8");
    h.update(Buffer.from([0]));
    h.update(f.bytes);
    h.update(Buffer.from([0]));
  }
  return h.digest("hex").slice(0, 16);
}

export type Transpile = (source: string, path: string) => string;

/** The wire form of one file: text for text types (TypeScript stripped to JavaScript), base64 otherwise. */
export function toViewFile(path: string, bytes: Buffer, transpile: Transpile): ViewFile {
  const mime = mimeOf(path);
  if (!isText(mime)) return { path, mime, base64: bytes.toString("base64") };
  const source = bytes.toString("utf8");
  return { path, mime, text: extname(path).toLowerCase() === ".ts" ? transpile(source, path) : source };
}
