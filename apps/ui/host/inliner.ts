// The fallback primitive for a platform where a custom-protocol frame does not load: one
// self-contained HTML document from a view's files, for `srcdoc` on a frame with
// `sandbox="allow-scripts allow-forms"`. Stylesheets and scripts named by the entry are
// inlined, images become data URLs. Its limits, recorded here and in the README: the
// document inherits the host's CSP, so the inlined scripts and styles need the host's
// per-launch nonce, and a module cannot import another file, because nothing serves it.
// The Windows probe passed, so the desktop app does not use it; it is kept and tested for
// milestone 5.

import type { ViewContent, ViewFile } from "@cophyla/protocol";

export interface InlineOptions {
  nonce?: string;
}

const ATTR = /\s(src|href)\s*=\s*"([^"]*)"/;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** A closing tag inside inline content would end the element early; split it. */
function escapeInline(text: string, tag: string): string {
  return text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
}

function resolve(from: string, ref: string): string {
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const parts = (base + ref).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function dataUrl(f: ViewFile): string {
  if (f.base64 !== undefined) return `data:${f.mime};base64,${f.base64}`;
  return `data:${f.mime};charset=utf-8,${encodeURIComponent(f.text ?? "")}`;
}

export function inlineView(content: ViewContent, entry: string, opts: InlineOptions = {}): string {
  const files = new Map(content.files.map((f) => [f.path, f]));
  const entryFile = files.get(entry);
  if (!entryFile || entryFile.text === undefined) throw new Error(`entry ${entry} is not a text file of view ${content.id}`);
  const nonce = opts.nonce ? ` nonce="${escapeAttr(opts.nonce)}"` : "";
  const lookup = (ref: string): ViewFile | undefined => {
    if (/^[a-z]+:/i.test(ref) || ref.startsWith("#")) return undefined;
    return files.get(resolve(entry, ref));
  };

  let html = entryFile.text;
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*"stylesheet"/i.test(tag)) return tag;
    const m = ATTR.exec(tag);
    const f = m && lookup(m[2]!);
    if (!f || f.text === undefined) return tag;
    return `<style${nonce}>${escapeInline(f.text, "style")}</style>`;
  });
  html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs: string) => {
    const m = ATTR.exec(attrs);
    const f = m && lookup(m[2]!);
    if (!f || f.text === undefined) return tag;
    const rest = attrs.replace(ATTR, "");
    return `<script${rest}${nonce}>${escapeInline(f.text, "script")}</script>`;
  });
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = ATTR.exec(tag);
    const f = m && lookup(m[2]!);
    if (!f) return tag;
    return tag.replace(ATTR, ` src="${escapeAttr(dataUrl(f))}"`);
  });
  return html;
}
