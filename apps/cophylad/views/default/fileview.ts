// A file of the folder an agent works in, shown in the view: read from the agent's node
// (`session.file`) and laid over the agent's pane or docked beside it, as the user picks, on a
// window wide enough for that choice; a narrow one always lays it over. The view opens it from
// the explorer, from a file's chip in the chat and from a path Ctrl+clicked in a terminal, and
// keeps one open per agent's tab.
//
// Code is coloured by speed-highlight's tokenizer (vendored, CC0): each language's grammar is
// loaded the first time a file needs it, and the tokens become elements with `textContent`, as
// everything else in the view does: nothing in a file is ever parsed as HTML. A file past
// COLOUR_MAX shows uncoloured, since an element per token is what costs. Lines are numbered in
// a gutter that stays put as they scroll sideways, and they scroll or wrap as the user picks;
// they are laid out a chunk at a time, only near the screen (`content-visibility`), so a long
// file opens about as fast as a short one. A copy takes the file's own text between the ends of
// what is selected, not what the page draws of it. Markdown shows drawn, as a README is on
// GitHub (markdown.ts, its fenced code coloured too), or as written. A file that is not text,
// or longer than its node sends, says so over what shows. The view reads it again as the agent
// works and when the window comes back, and the viewer keeps its place.

import type { FileText } from "@cophyla/protocol";
import { renderText } from "./markdown.ts";
import { fileErrorWords, fileLanguage, fileLines, grammarName, joinPath, linesBetween, viewerMeta, viewerNote } from "./model.ts";
import type { ViewerDock } from "./model.ts";
import { ViewRpcError } from "./rpc.ts";
import type { HostRpc } from "./rpc.ts";
import type { ShjLanguageData, ShjToken, tokenizer as Tokenizer } from "./vendor/shj-tokenize.mjs";

/** Characters past which a file shows uncoloured: tokenizing is quick, an element per token for megabytes is not. */
export const COLOUR_MAX = 256 * 1024;
/** Lines laid out together, and only once they come near the screen. */
const CHUNK_LINES = 200;
/**
 * Characters past which a line is too long for chunks laid out lazily, while lines do not wrap:
 * Chromium stops painting a `content-visibility` chunk scrolled a few thousand pixels sideways,
 * so a file with a line that long lays every chunk out.
 */
const LAZY_LINE_MAX = 400;
/** How long the line a chip or a link opened at stays marked. */
const FLASH_MS = 1600;

/** The file to show: the agent it belongs to, its path under the agent's folder, and the folder, for its full path. */
export interface ViewerTarget {
  session: string;
  rel: string;
  root: string;
  /** A line to show, and each opening's own number: one opened again goes back to its line, read afresh. */
  line?: number;
  opened: number;
}

export interface ViewerOptions {
  dock: ViewerDock;
  /** Long lines wrap rather than scroll sideways. */
  wrap: boolean;
  /** Markdown shows as written rather than drawn. */
  source: boolean;
  /** The window is wide enough for the viewer to sit beside the pane: its dock may be switched. */
  dockable: boolean;
  connected: boolean;
}

// --- colouring ---------------------------------------------------------------------------------

let tokenizing: Promise<typeof Tokenizer | undefined> | undefined;
const grammars = new Map<string, Promise<ShjLanguageData | undefined>>();
const loaded = new Map<string, ShjLanguageData | undefined>();

function loadTokenizer(): Promise<typeof Tokenizer | undefined> {
  tokenizing ??= import("./vendor/shj-tokenize.mjs").then(
    (m) => m.tokenizer,
    () => undefined,
  );
  return tokenizing;
}

/** A grammar by name, once: `grammarName` has made sure it is one vendored, so nothing else is ever imported. */
function loadGrammar(name: string): Promise<ShjLanguageData | undefined> {
  let g = grammars.get(name);
  if (!g) {
    g = import(`./vendor/shj/${name}.js`).then(
      (m: { default: ShjLanguageData }) => m.default,
      () => undefined,
    );
    g.then((data) => loaded.set(name, data));
    grammars.set(name, g);
  }
  return g;
}

/**
 * Each token of `src` in `language`, in order, to `onToken`: a grammar another reaches into (a
 * comment's TODO, a fence's language) is loaded as the tokenizer asks for it, and a region in
 * one there is none for comes as plain text. False when the tokenizer itself could not load.
 */
async function tokenize(src: string, language: string, onToken: (text: string, type?: ShjToken) => void): Promise<boolean> {
  const tokenizer = await loadTokenizer();
  if (!tokenizer) return false;
  const it = tokenizer(src, language, onToken);
  for (let r = it.next(); !r.done; ) {
    // A fence's info string may say more than the language: its first word names it.
    const name = grammarName(r.value.split(/[\s{,]/)[0] ?? "");
    r = it.next(name === undefined ? undefined : loaded.has(name) ? loaded.get(name) : await loadGrammar(name));
  }
  return true;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function button(className: string, text: string, title: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.dataset["action"] = className.split(" ")[0]!;
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}

/** A file's lines as elements: numbered, each one's text in a span of its own, a chunk of them at a time. */
class LineBuilder {
  readonly code: HTMLElement;
  private chunk!: HTMLElement;
  private text!: HTMLElement;
  private n = 0;

  constructor(code: HTMLElement) {
    this.code = code;
    this.next();
  }

  /** Text on the line under way and the ones after it, a new line at each line ending; a token's in a span of its type's colour. */
  put(text: string, type?: string): void {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) this.next();
      const part = parts[i]!;
      if (part === "") continue;
      this.text.append(type ? el("span", `tk-${type}`, part) : part);
    }
  }

  /** The lines built, cut back to the file's own: its last line ending starts none. */
  finish(count: number): void {
    while (this.n > count) {
      this.chunk.lastElementChild?.remove();
      this.n--;
      if (this.chunk.childElementCount === 0 && this.n > 0) {
        this.chunk.remove();
        this.chunk = this.code.lastElementChild as HTMLElement;
      }
    }
    this.chunk.style.setProperty("--n", String(this.chunk.childElementCount));
    this.code.style.setProperty("--digits", String(Math.max(2, String(count).length)));
  }

  private next(): void {
    if (this.n % CHUNK_LINES === 0) {
      this.chunk = el("div", "fv-chunk");
      this.chunk.style.setProperty("--n", String(CHUNK_LINES));
      this.code.append(this.chunk);
    }
    this.n++;
    const line = el("div", "fv-line");
    line.dataset["n"] = String(this.n);
    this.text = el("span", "fv-text");
    line.append(this.text);
    this.chunk.append(line);
  }
}

// --- the viewer --------------------------------------------------------------------------------

export class FileViewer {
  /** The viewer: its head (the file, what it is, Preview | Source, Wrap, Refresh, the dock, Close), a note, and the file. */
  readonly el: HTMLElement;
  private note: HTMLElement;
  private body: HTMLElement;
  private rpc: HostRpc;
  private folder: (target: ViewerTarget) => void;
  private target?: ViewerTarget;
  private opts?: ViewerOptions;
  private file?: FileText;
  private lines: string[] = [];
  private error?: string;
  private loading = false;
  private generation = 0;
  /** What the body shows, and what it is being drawn as: the file, its version, and whether as drawn markdown. */
  private drawn?: Drawn;
  private painting?: Drawn;
  private paints = 0;
  /** Markdown opened at a line shows as written, until the user picks. */
  private sourceFor?: string;
  /** The line to go to once the file shows. */
  private pendingLine?: number;

  /** `folder` is told when a path it was asked to show turns out to be a folder. */
  constructor(rpc: HostRpc, folder: (target: ViewerTarget) => void) {
    this.rpc = rpc;
    this.folder = folder;
    this.el = el("aside", "viewer");
    this.el.hidden = true;
    const head = el("header", "viewer-head");
    const title = el("span", "viewer-title");
    title.append(el("span", "viewer-name"), el("span", "viewer-dir"));
    const modes = el("span", "viewer-modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Show the markdown");
    for (const [mode, label, words] of [
      ["preview", "Preview", "Show the markdown drawn"],
      ["source", "Source", "Show the markdown as written"],
    ] as const) {
      const b = button("viewer-mode", label, words);
      b.dataset["mode"] = mode;
      modes.append(b);
    }
    const tools = el("span", "viewer-tools");
    tools.append(
      modes,
      button("viewer-wrap", "Wrap", "Wrap long lines"),
      button("viewer-refresh viewer-tool", "", "Read the file again"),
      button("viewer-dock viewer-tool", "", "Dock beside the pane"),
      button("viewer-close viewer-tool", "", "Close the file (Esc)"),
    );
    head.append(el("span", "viewer-mark"), title, el("span", "viewer-meta"), tools);
    this.note = el("p", "viewer-note");
    this.note.setAttribute("role", "status");
    this.body = el("div", "viewer-body");
    this.body.tabIndex = 0;
    this.el.append(head, this.note, this.body);
    this.body.addEventListener("copy", (ev) => this.copy(ev));
    this.body.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        const content = this.body.firstElementChild;
        if (content) getSelection()?.selectAllChildren(content);
      }
    });
  }

  /** The file shown, if one is. */
  get shown(): ViewerTarget | undefined {
    return this.el.hidden ? undefined : this.target;
  }

  /** Shows `target` in `parent`, reading it when it is another file or opened again; the options only redraw what they change. */
  show(target: ViewerTarget, parent: HTMLElement, opts: ViewerOptions): void {
    if (this.el.parentElement !== parent) {
      const top = this.body.scrollTop;
      const left = this.body.scrollLeft;
      parent.append(this.el);
      this.body.scrollTop = top;
      this.body.scrollLeft = left;
    }
    this.el.hidden = false;
    const was = this.target;
    this.target = target;
    this.opts = opts;
    const key = keyOf(target);
    if (!was || keyOf(was) !== key) {
      this.file = undefined;
      this.lines = [];
      this.error = undefined;
      this.drawn = undefined;
      this.body.replaceChildren();
      this.body.scrollTop = 0;
      this.sourceFor = target.line !== undefined ? key : undefined;
      this.pendingLine = target.line;
      void this.load(false);
    } else if (was.opened !== target.opened) {
      if (target.line !== undefined) {
        this.sourceFor = key;
        this.pendingLine = target.line;
      }
      void this.load(true);
    }
    this.update();
    void this.paint();
  }

  /** Puts the viewer away; what it read is let go. */
  hide(): void {
    if (this.el.hidden && !this.target) return;
    this.generation++;
    this.paints++;
    this.painting = undefined;
    this.target = undefined;
    this.file = undefined;
    this.lines = [];
    this.drawn = undefined;
    this.body.replaceChildren();
    this.el.hidden = true;
    this.el.remove();
  }

  /** Reads the file shown again: what changed is drawn where the user was; the same file is left as it is. */
  reload(): void {
    if (this.target && !this.el.hidden) void this.load(true);
  }

  /** Markdown shows as the user picked again, drawn or written, whatever line it opened at. */
  pick(): void {
    this.sourceFor = undefined;
  }

  focus(): void {
    this.body.focus({ preventScroll: true });
  }

  /** Whether the focus is in the viewer. */
  get focused(): boolean {
    return this.el.contains(document.activeElement);
  }

  private async load(again: boolean): Promise<void> {
    const target = this.target;
    if (!target) return;
    const generation = ++this.generation;
    this.loading = true;
    if (!again) this.update();
    try {
      const file = await this.rpc.request<FileText>("session.file", { id: target.session, path: target.rel });
      if (generation !== this.generation) return;
      this.error = undefined;
      this.file = file;
      this.lines = file.text !== undefined ? fileLines(file.text) : [];
    } catch (e) {
      if (generation !== this.generation) return;
      const code = e instanceof ViewRpcError ? e.code : undefined;
      const message = e instanceof Error ? e.message : String(e);
      if (code === "invalid" && / a folder$/.test(message)) {
        this.loading = false;
        this.folder(target);
        return;
      }
      // Read again, a file that went away says so; one read before stays as it was otherwise.
      if (!again || code === "not_found") {
        this.file = undefined;
        this.lines = [];
        this.drawn = undefined;
        this.body.replaceChildren();
      }
      this.error = fileErrorWords(code, message);
    }
    this.loading = false;
    this.update();
    await this.paint();
  }

  /** The head and the note, from what is known: cheap, so every draw calls it. */
  private update(): void {
    const target = this.target;
    const opts = this.opts;
    if (!target || !opts) return;
    const slash = target.rel.lastIndexOf("/");
    const name = target.rel.slice(slash + 1);
    this.el.dataset["dock"] = opts.dock;
    this.el.setAttribute("aria-label", `File ${name}`);
    setText(this.el.querySelector(".viewer-name")!, name);
    setText(this.el.querySelector(".viewer-dir")!, slash > 0 ? target.rel.slice(0, slash) : "");
    this.el.querySelector<HTMLElement>(".viewer-title")!.title = joinPath(target.root, target.rel);
    setText(this.el.querySelector(".viewer-meta")!, this.file ? viewerMeta(this.file, this.file.text !== undefined ? this.lines.length : undefined) : "");
    const markdown = fileLanguage(target.rel) === "md" && this.file?.text !== undefined;
    const source = this.source();
    const modes = this.el.querySelector<HTMLElement>(".viewer-modes")!;
    modes.hidden = !markdown;
    for (const b of Array.from(modes.querySelectorAll<HTMLButtonElement>("button"))) b.setAttribute("aria-pressed", (b.dataset["mode"] === "source") === source ? "true" : "false");
    const wrap = this.el.querySelector<HTMLButtonElement>(".viewer-wrap")!;
    wrap.setAttribute("aria-pressed", opts.wrap ? "true" : "false");
    wrap.hidden = markdown && !source;
    this.el.querySelector<HTMLButtonElement>(".viewer-refresh")!.disabled = !opts.connected || this.loading;
    const dock = this.el.querySelector<HTMLButtonElement>(".viewer-dock")!;
    dock.hidden = !opts.dockable;
    dock.dataset["dock"] = opts.dock;
    const dockWords = opts.dock === "over" ? "Dock beside the pane" : "Lay over the pane";
    if (dock.title !== dockWords) {
      dock.title = dockWords;
      dock.setAttribute("aria-label", dockWords);
    }
    const code = this.body.querySelector<HTMLElement>(".viewer-code");
    if (code && code.dataset["wrap"] !== (opts.wrap ? "1" : "0")) code.dataset["wrap"] = opts.wrap ? "1" : "0";
    const words = this.error ?? (this.file ? viewerNote(this.file) : this.loading ? "Loading…" : "");
    setText(this.note, words);
    this.note.hidden = words === "";
    this.note.dataset["error"] = this.error !== undefined ? "1" : "0";
  }

  /** Markdown shows as written: the user picked it, or it opened at a line. */
  private source(): boolean {
    const target = this.target;
    return (this.opts?.source ?? false) || (target !== undefined && this.sourceFor === keyOf(target));
  }

  /** The body, from the file read: drawn again only when the file, or how it shows, changed. */
  private async paint(): Promise<void> {
    const target = this.target;
    const file = this.file;
    if (!target || !file) return;
    const language = fileLanguage(target.rel);
    const want: Drawn = { key: keyOf(target), version: `${file.modified}:${file.size}:${file.text?.length ?? -1}`, preview: language === "md" && !this.source() };
    if (same(this.drawn, want)) return this.goToLine();
    if (same(this.painting, want)) return;
    this.painting = want;
    const paint = ++this.paints;
    if (file.text === undefined) {
      this.painting = undefined;
      this.drawn = want;
      this.body.replaceChildren();
      return;
    }
    const text = file.text.replace(/\r\n?/g, "\n");
    let content: HTMLElement;
    if (want.preview) {
      content = el("div", "viewer-md");
      renderText(content, text, true, { file: true });
      for (const code of Array.from(content.querySelectorAll<HTMLElement>("pre[data-lang] > code"))) {
        const lang = grammarName(code.parentElement!.dataset["lang"] ?? "");
        const src = code.textContent ?? "";
        if (lang === undefined || src.length > COLOUR_MAX) continue;
        const coloured = document.createDocumentFragment();
        if (await tokenize(src, lang, (t, type) => coloured.append(type ? el("span", `tk-${type}`, t) : t))) code.replaceChildren(coloured);
      }
    } else {
      content = el("div", "viewer-code");
      content.dataset["wrap"] = this.opts?.wrap ? "1" : "0";
      content.dataset["long"] = this.lines.some((l) => l.length > LAZY_LINE_MAX) ? "1" : "0";
      const lines = new LineBuilder(content);
      const coloured = language !== undefined && language !== "todo" && text.length <= COLOUR_MAX && (await tokenize(text, language, (t, type) => lines.put(t, type)));
      if (!coloured) lines.put(text);
      lines.finish(this.lines.length);
    }
    // A newer paint, another file or none since: this one is dropped.
    if (paint !== this.paints || !this.target || keyOf(this.target) !== want.key) return;
    this.painting = undefined;
    this.drawn = want;
    // Drawn again in place: the user's place is kept, a changed file's lines shifting under it as they would in an editor.
    const top = this.body.scrollTop;
    const left = this.body.scrollLeft;
    this.body.replaceChildren(content);
    this.body.scrollTop = top;
    this.body.scrollLeft = left;
    this.goToLine();
  }

  /** The line a chip or a link opened the file at, once it shows: scrolled to the middle and marked a moment. */
  private goToLine(): void {
    const n = this.pendingLine;
    if (n === undefined) return;
    const line = this.body.querySelector<HTMLElement>(`.fv-line[data-n="${Math.max(1, Math.min(n, this.lines.length))}"]`);
    if (!line) return;
    this.pendingLine = undefined;
    const box = this.body.getBoundingClientRect();
    const at = line.getBoundingClientRect();
    this.body.scrollTop += at.top - box.top - (box.height - at.height) / 2;
    line.dataset["flash"] = "1";
    setTimeout(() => delete line.dataset["flash"], FLASH_MS);
  }

  /** A copy of lines selected takes the file's own text between the selection's ends, blank lines, tabs and all. */
  private copy(ev: ClipboardEvent): void {
    const code = this.body.querySelector<HTMLElement>(".viewer-code");
    const sel = getSelection();
    if (!code || !sel || sel.rangeCount === 0 || sel.isCollapsed || !ev.clipboardData) return;
    const range = sel.getRangeAt(0);
    if (!range.intersectsNode(code)) return;
    const text = linesBetween(this.lines, this.point(code, range.startContainer, range.startOffset), this.point(code, range.endContainer, range.endOffset));
    ev.clipboardData.setData("text/plain", text);
    ev.preventDefault();
  }

  /** Where a selection's end falls in the file: a line's index and a column in its text. */
  private point(code: HTMLElement, node: Node, offset: number): [number, number] {
    const last = Math.max(0, this.lines.length - 1);
    const end: [number, number] = [last, this.lines[last]?.length ?? 0];
    if (!code.contains(node)) return code.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? [0, 0] : end;
    const owner = node instanceof Element ? node : node.parentElement;
    const line = owner?.closest<HTMLElement>(".fv-line");
    if (line && code.contains(line)) {
      const index = Number(line.dataset["n"]) - 1;
      const text = line.querySelector(".fv-text");
      if (!text || !text.contains(node)) return node === line && offset === 0 ? [index, 0] : [index, this.lines[index]?.length ?? 0];
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(node, offset);
      return [index, r.toString().length];
    }
    // Between lines or chunks: the next line's start, or past the last one.
    const after = node.childNodes[offset];
    const next = after instanceof Element ? (after.matches(".fv-line") ? after : after.querySelector(".fv-line")) : null;
    if (next instanceof HTMLElement) return [Number(next.dataset["n"]) - 1, 0];
    const lines = node instanceof Element ? node.querySelectorAll<HTMLElement>(".fv-line") : undefined;
    const before = lines?.[lines.length - 1];
    if (before) {
      const index = Number(before.dataset["n"]) - 1;
      return [index, this.lines[index]?.length ?? 0];
    }
    return end;
  }
}

interface Drawn {
  key: string;
  version: string;
  preview: boolean;
}

function same(a: Drawn | undefined, b: Drawn): boolean {
  return a !== undefined && a.key === b.key && a.version === b.version && a.preview === b.preview;
}

function keyOf(t: ViewerTarget): string {
  return `${t.session}\n${t.rel}`;
}
