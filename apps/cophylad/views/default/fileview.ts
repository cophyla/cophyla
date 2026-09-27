// A file of the folder an agent works in, or of the folder a bare terminal started in, shown in
// the view: read from its node (`session.file`, `terminal.file`) and laid over the pane or
// docked beside it, as the user picks, on a window wide enough for that choice; a narrow one
// always lays it over. Docked, a divider on its left edge sets its share of the width. The view
// opens it from the explorer, from a file's chip in the chat and from a path Ctrl+clicked in a
// terminal, and keeps one open per tab.
//
// Code is coloured by speed-highlight's tokenizer (vendored, CC0): each language's grammar is
// loaded the first time a file needs it, and the tokens become elements with `textContent`, as
// everything else in the view does: nothing in a file is ever parsed as HTML. A file past
// COLOUR_MAX shows uncoloured, since an element per token is what costs. Lines are numbered in
// a gutter that stays put as they scroll sideways, and they scroll or wrap as the user picks;
// they are laid out a chunk at a time, only near the screen (`content-visibility`), so a long
// file opens about as fast as a short one. A copy takes the file's own text between the ends of
// what is selected, not what the page draws of it. Markdown shows drawn, as a README is on
// GitHub (markdown.ts, its fenced code coloured too), or as written, and an SVG drawn or as
// written the same way. An image comes whole (`image` in the ask) and is drawn fitted to the
// viewer, a click showing it at its own size. A file that is not text, or longer than its node
// sends, says so over what shows. Ctrl+F searches what shows: every match marked (the CSS
// Custom Highlight API, so nothing in the page changes), Enter and Shift+Enter going from one to
// the next, any case unless Aa is on. The view reads the file again as the agent works and when
// the window comes back, and the viewer keeps its place and its search.

import type { FileText } from "@cophyla/protocol";
import { renderText } from "./markdown.ts";
import { fileErrorWords, fileLanguage, fileLines, findInLines, findPattern, findWords, FIND_MAX, grammarName, imageKind, joinPath, linesBetween, viewerMeta, viewerNote } from "./model.ts";
import type { ViewerDock, ViewerSource } from "./model.ts";
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

/** The file to show: what it is read through, its path under that one's folder, and the folder, for its full path. */
export interface ViewerTarget {
  from: ViewerSource;
  rel: string;
  root: string;
  /** A line to show, and each opening's own number: one opened again goes back to its line, read afresh. */
  line?: number;
  opened: number;
}

export interface ViewerOptions {
  dock: ViewerDock;
  /** Its share of the width beside the pane, in percent, while docked there. */
  width: number;
  /** Long lines wrap rather than scroll sideways. */
  wrap: boolean;
  /** Markdown and SVG show as written rather than drawn. */
  source: boolean;
  /** The window is wide enough for the viewer to sit beside the pane: its dock may be switched. */
  dockable: boolean;
  connected: boolean;
}

/** The CSS Custom Highlight API, where the engine has it: search marks without touching the page. */
const highlights: HighlightRegistry | undefined = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : undefined;

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
  /** An image's size in pixels, once drawn. */
  private pixels?: { width: number; height: number };
  /** The search bar, its field and its count; the matches of what shows, and the one gone to. */
  private findBar: HTMLElement;
  private findInput: HTMLInputElement;
  private findCount: HTMLElement;
  private findCase: HTMLButtonElement;
  private matches: Range[] = [];
  private current = -1;
  private findTimer?: ReturnType<typeof setTimeout>;

  /** `folder` is told when a path it was asked to show turns out to be a folder. */
  constructor(rpc: HostRpc, folder: (target: ViewerTarget) => void) {
    this.rpc = rpc;
    this.folder = folder;
    this.el = el("aside", "viewer");
    this.el.hidden = true;
    // The divider on the viewer's left edge, while it sits beside the pane: view.ts drags it.
    const split = el("div", "viewer-split");
    split.setAttribute("role", "separator");
    split.setAttribute("aria-orientation", "vertical");
    split.setAttribute("aria-label", "The file's width beside the pane");
    split.setAttribute("aria-valuemin", "0");
    split.setAttribute("aria-valuemax", "100");
    split.title = "Drag to widen the file or the pane; double-click for the usual width";
    split.tabIndex = 0;
    const head = el("header", "viewer-head");
    const title = el("span", "viewer-title");
    title.append(el("span", "viewer-name"), el("span", "viewer-dir"));
    const modes = el("span", "viewer-modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Show the file");
    for (const [mode, label, words] of [
      ["preview", "Preview", "Show the file drawn"],
      ["source", "Source", "Show the file as written"],
    ] as const) {
      const b = button("viewer-mode", label, words);
      b.dataset["mode"] = mode;
      modes.append(b);
    }
    const find = el("button", "viewer-find-open viewer-tool");
    find.type = "button";
    find.title = "Find in the file (Ctrl+F)";
    find.setAttribute("aria-label", "Find in the file");
    find.addEventListener("click", () => this.openFind());
    const tools = el("span", "viewer-tools");
    tools.append(
      modes,
      button("viewer-wrap", "Wrap", "Wrap long lines"),
      find,
      button("viewer-refresh viewer-tool", "", "Read the file again"),
      button("viewer-dock viewer-tool", "", "Dock beside the pane"),
      button("viewer-close viewer-tool", "", "Close the file (Esc)"),
    );
    head.append(el("span", "viewer-mark"), title, el("span", "viewer-meta"), tools);
    // The search: its field, which match of how many, Aa, the one before and after, and Close.
    this.findBar = el("div", "viewer-find");
    this.findBar.hidden = true;
    this.findBar.setAttribute("role", "search");
    this.findInput = el("input", "viewer-find-text");
    this.findInput.type = "text";
    this.findInput.placeholder = "Find";
    this.findInput.setAttribute("aria-label", "Find in the file");
    this.findInput.autocomplete = "off";
    this.findInput.spellcheck = false;
    this.findCount = el("span", "viewer-find-count");
    this.findCount.setAttribute("aria-live", "polite");
    this.findCase = this.findTool("viewer-find-case", "Aa", "Match case", () => {
      this.findCase.setAttribute("aria-pressed", this.findCase.getAttribute("aria-pressed") === "true" ? "false" : "true");
      this.runFind(true);
    });
    this.findCase.setAttribute("aria-pressed", "false");
    this.findBar.append(
      this.findInput,
      this.findCount,
      this.findCase,
      this.findTool("viewer-find-prev", "↑", "The match before (Shift+Enter)", () => this.step(-1)),
      this.findTool("viewer-find-next", "↓", "The match after (Enter)", () => this.step(1)),
      this.findTool("viewer-find-close", "✕", "Close the search (Esc)", () => this.closeFind()),
    );
    this.findInput.addEventListener("input", () => {
      clearTimeout(this.findTimer);
      this.findTimer = setTimeout(
        () => {
          this.findTimer = undefined;
          this.runFind(true);
        },
        this.lines.length > 20_000 ? 250 : 80,
      );
    });
    this.findInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        // Typed a moment ago: the search runs now, and shows its first match from here.
        if (this.findTimer !== undefined) {
          clearTimeout(this.findTimer);
          this.findTimer = undefined;
          this.runFind(true);
        } else {
          this.step(ev.shiftKey ? -1 : 1);
        }
      } else if (ev.key === "Escape") {
        // The search closes, not the file: the view's own Escape never hears it.
        ev.preventDefault();
        ev.stopPropagation();
        this.closeFind();
      }
    });
    this.note = el("p", "viewer-note");
    this.note.setAttribute("role", "status");
    this.body = el("div", "viewer-body");
    this.body.tabIndex = 0;
    this.el.append(split, head, this.findBar, this.note, this.body);
    this.body.addEventListener("copy", (ev) => this.copy(ev));
    this.body.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        const content = this.body.firstElementChild;
        if (content) getSelection()?.selectAllChildren(content);
      }
    });
    this.el.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === "f") {
        ev.preventDefault();
        this.openFind();
      } else if (ev.key === "F3" || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "g")) {
        if (this.findBar.hidden) return;
        ev.preventDefault();
        this.step(ev.shiftKey ? -1 : 1);
      }
    });
    // An image fits the viewer; a click shows it at its own size, and back.
    this.body.addEventListener("click", (ev) => {
      const box = (ev.target as Element | null)?.closest<HTMLElement>(".viewer-image");
      if (box) box.dataset["fit"] = box.dataset["fit"] === "1" ? "0" : "1";
    });
  }

  private findTool(className: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
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
    this.setWidth(opts.width);
    const was = this.target;
    this.target = target;
    this.opts = opts;
    const key = keyOf(target);
    if (!was || keyOf(was) !== key) {
      this.file = undefined;
      this.lines = [];
      this.error = undefined;
      this.drawn = undefined;
      this.pixels = undefined;
      this.clearMatches();
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

  /** Its share of the width beside the pane, in percent: its divider moves it without a draw. */
  setWidth(width: number): void {
    const value = `${width}%`;
    if (this.el.style.getPropertyValue("--viewer-width") === value) return;
    this.el.style.setProperty("--viewer-width", value);
    this.el.querySelector(".viewer-split")!.setAttribute("aria-valuenow", String(Math.round(width)));
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
    this.pixels = undefined;
    this.closeFind(false);
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
      // An image comes whole, to be drawn; an SVG comes as the text it is either way.
      const ask = { path: target.rel, ...(imageKind(target.rel) !== undefined ? { image: true } : {}) };
      const from = target.from;
      const file = "session" in from ? await this.rpc.request<FileText>("session.file", { id: from.session, ...ask }) : await this.rpc.request<FileText>("terminal.file", { terminal: from.terminal, ...ask });
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
        this.clearMatches();
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
    setText(this.el.querySelector(".viewer-meta")!, this.file ? viewerMeta(this.file, this.file.text !== undefined ? this.lines.length : undefined, this.pixels) : "");
    const drawable = previewable(target.rel) && this.file?.text !== undefined;
    const source = this.source();
    const modes = this.el.querySelector<HTMLElement>(".viewer-modes")!;
    modes.hidden = !drawable;
    for (const b of Array.from(modes.querySelectorAll<HTMLButtonElement>("button"))) b.setAttribute("aria-pressed", (b.dataset["mode"] === "source") === source ? "true" : "false");
    const wrap = this.el.querySelector<HTMLButtonElement>(".viewer-wrap")!;
    wrap.setAttribute("aria-pressed", opts.wrap ? "true" : "false");
    // Wrapping and searching are the text's: a drawing has none, an image has none.
    wrap.hidden = this.file?.text === undefined || (drawable && !source);
    const searchable = this.file?.text !== undefined && !(drawable && !source && fileLanguage(target.rel) !== "md");
    this.el.querySelector<HTMLButtonElement>(".viewer-find-open")!.hidden = !searchable;
    if (this.file !== undefined && !searchable && !this.findBar.hidden) this.closeFind(false);
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

  /** Markdown or an SVG shows as written: the user picked it, or it opened at a line. */
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
    const want: Drawn = { key: keyOf(target), version: `${file.modified}:${file.size}:${file.text?.length ?? file.base64?.length ?? -1}`, preview: previewable(target.rel) && !this.source() };
    if (same(this.drawn, want)) return this.goToLine();
    if (same(this.painting, want)) return;
    this.painting = want;
    const paint = ++this.paints;
    if (file.text === undefined) {
      this.painting = undefined;
      this.drawn = want;
      this.clearMatches();
      this.body.replaceChildren(...(file.base64 !== undefined && file.mime !== undefined ? [this.image(`data:${file.mime};base64,${file.base64}`, target.rel)] : []));
      return;
    }
    const text = file.text.replace(/\r\n?/g, "\n");
    let content: HTMLElement;
    if (want.preview && language !== "md") {
      // An SVG drawn as an image: in an `img`, where nothing in it runs and it reaches nothing.
      content = this.image(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`, target.rel);
    } else if (want.preview) {
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
    // A search open over what was drawn before looks again, at about the same match.
    if (this.findBar.hidden) this.clearMatches();
    else this.runFind(false);
  }

  /** An image, fitted to the viewer until clicked, on a checkerboard its transparent parts show; its size in pixels goes in the head once it is drawn. */
  private image(src: string, rel: string): HTMLElement {
    const box = el("div", "viewer-image");
    box.dataset["fit"] = "1";
    box.title = "Click for its own size, and again to fit";
    const img = el("img");
    img.alt = rel.slice(rel.lastIndexOf("/") + 1);
    img.decoding = "async";
    img.addEventListener("load", () => {
      this.pixels = { width: img.naturalWidth, height: img.naturalHeight };
      this.update();
    });
    img.addEventListener("error", () => {
      this.error = "This image cannot be drawn: it may be damaged, or of a kind this app does not read.";
      this.update();
    });
    img.src = src;
    box.append(img);
    return box;
  }

  // --- search ------------------------------------------------------------------------------------

  /** Opens the search, or goes back to its field, with what it holds selected so typing replaces it. */
  openFind(): void {
    if (this.el.querySelector<HTMLElement>(".viewer-find-open")!.hidden) return;
    const was = this.findBar.hidden;
    this.findBar.hidden = false;
    this.findInput.focus();
    this.findInput.select();
    if (was && this.findInput.value !== "") this.runFind(true);
  }

  /** Closes the search, its marks going; the focus goes back to the file when it was in the search. */
  closeFind(refocus = true): void {
    if (this.findBar.hidden) return;
    const inside = this.findBar.contains(document.activeElement);
    this.findBar.hidden = true;
    clearTimeout(this.findTimer);
    this.findTimer = undefined;
    this.clearMatches();
    setText(this.findCount, "");
    if (refocus && inside) this.focus();
  }

  private clearMatches(): void {
    this.matches = [];
    this.current = -1;
    highlights?.delete("fv-match");
    highlights?.delete("fv-current");
  }

  /**
   * Finds what the field holds in what shows: in code by the file's own lines, each match
   * mapped to where its characters are drawn; in drawn markdown within each run of text. From
   * the view (`fromView`) the match gone to is the first at or under the top of what shows;
   * otherwise it stays about where it was.
   */
  private runFind(fromView: boolean): void {
    const query = this.findInput.value;
    const was = this.current;
    this.clearMatches();
    const content = this.body.firstElementChild;
    if (query === "" || !content) {
      setText(this.findCount, findWords(query, 0, 0));
      return;
    }
    const matchCase = this.findCase.getAttribute("aria-pressed") === "true";
    if (content.classList.contains("viewer-code")) {
      const texts = content.querySelectorAll<HTMLElement>(".fv-text");
      for (const m of findInLines(this.lines, query, matchCase)) {
        const r = texts[m.line] ? rangeIn(texts[m.line]!, m.start, m.end) : undefined;
        if (r) this.matches.push(r);
      }
    } else {
      const re = findPattern(query, matchCase);
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode() as Text | null; n && this.matches.length < FIND_MAX; n = walker.nextNode() as Text | null) {
        re.lastIndex = 0;
        for (let m = re.exec(n.data); m && this.matches.length < FIND_MAX; m = re.exec(n.data)) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          this.matches.push(r);
        }
      }
    }
    if (this.matches.length === 0) {
      setText(this.findCount, findWords(query, 0, 0));
      return;
    }
    highlights?.set("fv-match", new Highlight(...this.matches));
    this.current = fromView ? this.firstInView() : Math.min(Math.max(was, 0), this.matches.length - 1);
    this.showMatch();
  }

  /** The first match at or under the top of what shows, or the first of all when none is. */
  private firstInView(): number {
    const top = this.body.getBoundingClientRect().top;
    const i = this.matches.findIndex((r) => lineOf(r).getBoundingClientRect().bottom > top);
    return i === -1 ? 0 : i;
  }

  /** The next match, or the one before, round from the last to the first. */
  private step(by: 1 | -1): void {
    if (this.matches.length === 0) {
      if (this.findInput.value !== "") this.runFind(true);
      return;
    }
    this.current = (this.current + by + this.matches.length) % this.matches.length;
    this.showMatch();
  }

  /** The match gone to: marked apart from the rest, and brought into view mid-height, and sideways when it is off the side. */
  private showMatch(): void {
    const r = this.matches[this.current];
    if (!r) return;
    setText(this.findCount, findWords(this.findInput.value, this.matches.length, this.current));
    if (highlights) highlights.set("fv-current", new Highlight(r));
    const box = this.body.getBoundingClientRect();
    const line = lineOf(r).getBoundingClientRect();
    if (line.top < box.top + 24 || line.bottom > box.bottom - 24) this.body.scrollTop += line.top - box.top - (box.height - line.height) / 2;
    const at = r.getBoundingClientRect();
    const gutter = this.body.querySelector(".fv-line")?.getBoundingClientRect().left ?? box.left;
    if (at.left < gutter + 48 || at.right > box.right - 24) this.body.scrollLeft += at.left - box.left - box.width / 3;
    // Where the engine has no highlights, the match is shown as a selection instead.
    if (!highlights && !this.findBar.contains(document.activeElement)) {
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
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
  return `${"session" in t.from ? t.from.session : `terminal:${t.from.terminal}`}\n${t.rel}`;
}

/** Markdown and SVG can be drawn, or shown as written. */
function previewable(rel: string): boolean {
  return fileLanguage(rel) === "md" || imageKind(rel) === "SVG";
}

/** A range over characters `start` to `end` of an element's text, however its text is split into nodes. */
function rangeIn(el: Element, start: number, end: number): Range | undefined {
  const r = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  let started = false;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (!started && start < at + len) {
      r.setStart(n, start - at);
      started = true;
    }
    if (started && end <= at + len) {
      r.setEnd(n, end - at);
      return r;
    }
    at += len;
  }
  return undefined;
}

/** The element a range's line is drawn in: a file's line, or the run of drawn markdown it is in. */
function lineOf(r: Range): Element {
  const node = r.startContainer;
  const owner = node instanceof Element ? node : node.parentElement!;
  return owner.closest(".fv-line") ?? owner;
}
