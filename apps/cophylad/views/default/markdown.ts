// What a model wrote, as markdown. marked's lexer (vendored, `vendor/marked.mjs`) reads the
// text into tokens, and the elements are built from them here with `createElement` and
// `textContent`, as everything else in the view is: nothing in the text is ever parsed as
// HTML, so raw HTML in it shows as the text it is. GitHub's flavour (tables, task lists,
// strikethrough, bare links), and a single newline is a line break, as a chat means it; in a
// file the viewer shows, as in a README on GitHub, it is not. A
// link is drawn as one with its address for a title, and goes nowhere: only a terminal's
// links open (`host.openLink`). An image is its alt text, its title and address in its tooltip:
// the frame has no network. A file's markdown may be given a hook that draws an image itself
// (the viewer's, which reads one in the file's folder whole and draws it as data); what the
// hook declines, an image on the web, stays its alt text. The top-level blocks are
// reconciled against the source each was read from, so a reply that streams rebuilds only
// its last block, and a text that did not change is not read again. A slot marker in the
// text (model.ts's `slot(i)`) becomes an empty `span.slot` where it stands, in a sentence or wherever
// else, for the caller to put a chip in: that is how a reference sits in the words around it.

import { Lexer } from "./vendor/marked.mjs";
import type { MarkedToken, Token, Tokens } from "./vendor/marked.mjs";
import { SLOT, SLOT_OPEN } from "./model.ts";

const OPTIONS = { gfm: true, breaks: true };
/** A file's markdown: lines wrapped by hand join into their paragraph. */
const FILE_OPTIONS = { gfm: true, breaks: false };

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** The text a container was last rendered from, and the source each top-level block was built from. */
const sources = new WeakMap<Node, string>();
/** The text a container shows as typed, when it has slots in it. */
const typed = new WeakMap<Node, string>();

/** Draws an image a file's markdown shows, from its address, its alt text and its title; undefined leaves it its alt text. */
export type ImageHook = (href: string, alt: string, title: string | null) => HTMLElement | undefined;

/** The hook of the file being rendered, while it renders: the rendering is synchronous, so none leaks to another. */
let imageHook: ImageHook | undefined;


/** A string as text, with each slot marker in it an empty `span.slot` for the caller to fill. */
function withSlots(parent: HTMLElement, text: string): void {
  let at = 0;
  for (const m of text.matchAll(SLOT)) {
    if (m.index > at) parent.append(text.slice(at, m.index));
    const span = el("span", "slot");
    span.dataset["slot"] = m[1]!;
    parent.append(span);
    at = m.index + m[0].length;
  }
  if (at < text.length) parent.append(text.slice(at));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function checkbox(checked: boolean): HTMLInputElement {
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = true;
  return box;
}

function inline(parent: HTMLElement, tokens: Token[]): HTMLElement {
  for (const token of tokens) {
    const t = token as MarkedToken;
    switch (t.type) {
      case "text":
        if (t.tokens) inline(parent, t.tokens);
        else withSlots(parent, t.text);
        break;
      case "escape":
      case "html":
        withSlots(parent, t.text);
        break;
      case "strong":
      case "em":
      case "del":
        parent.append(inline(el(t.type), t.tokens));
        break;
      case "codespan": {
        const code = el("code");
        withSlots(code, t.text);
        parent.append(code);
        break;
      }
      case "br":
        parent.append(el("br"));
        break;
      case "link": {
        const a = inline(el("a", "md-link"), t.tokens);
        a.title = t.href;
        parent.append(a);
        break;
      }
      case "image": {
        const drawn = imageHook?.(t.href, t.text, t.title ?? null);
        if (drawn) {
          parent.append(drawn);
          break;
        }
        const image = el("span", "md-image", t.text || t.href);
        image.title = t.title ? `${t.title}\n${t.href}` : t.href;
        parent.append(image);
        break;
      }
      case "checkbox":
        parent.append(checkbox(t.checked));
        break;
      default:
        withSlots(parent, t.raw);
    }
  }
  return parent;
}

/** Block tokens into `parent`; a tight list item's text, and its task box, sit in the item itself. */
function blocks(parent: HTMLElement, tokens: Token[]): HTMLElement {
  for (const token of tokens) {
    const t = token as MarkedToken;
    if (t.type === "space" || t.type === "def") continue;
    if (t.type === "text" || t.type === "checkbox") inline(parent, [t]);
    else parent.append(block(t));
  }
  return parent;
}

function row(cells: Tokens.TableCell[], tag: "th" | "td"): HTMLTableRowElement {
  const tr = el("tr");
  for (const c of cells) {
    const cell = inline(el(tag), c.tokens);
    if (c.align) cell.dataset["align"] = c.align;
    tr.append(cell);
  }
  return tr;
}

function block(token: Token): HTMLElement {
  const t = token as MarkedToken;
  switch (t.type) {
    case "paragraph":
    case "text":
      return inline(el("p"), t.tokens ?? [t]);
    case "heading":
      return inline(el(HEADINGS[Math.min(Math.max(t.depth, 1), 6) - 1] ?? "h6"), t.tokens);
    case "code": {
      const pre = el("pre");
      const lang = t.lang?.split(/\s/)[0];
      if (lang) pre.dataset["lang"] = lang;
      const code = el("code");
      withSlots(code, t.text);
      pre.append(code);
      return pre;
    }
    case "blockquote":
      return blocks(el("blockquote"), t.tokens);
    case "list": {
      const list = t.ordered ? el("ol") : el("ul");
      if (list instanceof HTMLOListElement && typeof t.start === "number" && t.start !== 1) list.start = t.start;
      for (const item of t.items) {
        const li = blocks(el("li"), item.tokens);
        if (item.task) li.className = "md-task";
        list.append(li);
      }
      return list;
    }
    case "table": {
      const table = el("table");
      const head = el("thead");
      head.append(row(t.header, "th"));
      table.append(head);
      if (t.rows.length > 0) {
        const body = el("tbody");
        for (const r of t.rows) body.append(row(r, "td"));
        table.append(body);
      }
      // A wide table scrolls inside its own box rather than widening the message.
      const wrap = el("div", "md-table");
      wrap.append(table);
      return wrap;
    }
    case "hr":
      return el("hr");
    case "html": {
      const p = el("p", "md-html");
      withSlots(p, t.text.trimEnd());
      return p;
    }
    default: {
      const p = el("p");
      withSlots(p, t.raw);
      return p;
    }
  }
}

/** Keeps `container`'s children in step with the text's top-level blocks, rebuilding only a block whose source changed. */
function renderMarkdown(container: HTMLElement, text: string, options: typeof OPTIONS): void {
  // It held plain text until now, or nothing.
  if (!sources.has(container)) container.replaceChildren();
  sources.set(container, text);
  const tokens = Lexer.lex(text, options).filter((t) => t.type !== "space" && t.type !== "def");
  const children = Array.from(container.children);
  tokens.forEach((token, i) => {
    const node = children[i];
    if (node && sources.get(node) === token.raw) return;
    const fresh = block(token);
    sources.set(fresh, token.raw);
    if (node) node.replaceWith(fresh);
    else container.append(fresh);
  });
  for (const stale of children.slice(tokens.length)) stale.remove();
}

/**
 * Sets a container's text: as markdown (class `md`) when a model wrote it, else as it was
 * typed, for `white-space: pre-wrap` to show. Text that marked cannot read is shown as typed.
 * A `file`'s markdown keeps a single newline inside its paragraph, and its images are drawn by
 * `image` when it is given one.
 */
export function renderText(container: HTMLElement, text: string, markdown: boolean, opts: { file?: boolean; image?: ImageHook } = {}): void {
  if (markdown && sources.get(container) === text) return;
  if (markdown) {
    imageHook = opts.file ? opts.image : undefined;
    try {
      renderMarkdown(container, text, opts.file ? FILE_OPTIONS : OPTIONS);
      container.classList.add("md");
      return;
    } catch {
      // Falls through to the text as typed.
    } finally {
      imageHook = undefined;
    }
  }
  container.classList.remove("md");
  const was = sources.delete(container);
  if (!text.includes(SLOT_OPEN)) {
    typed.delete(container);
    if (was || container.textContent !== text) container.textContent = text;
    return;
  }
  if (!was && typed.get(container) === text) return;
  typed.set(container, text);
  container.replaceChildren();
  withSlots(container, text);
}
