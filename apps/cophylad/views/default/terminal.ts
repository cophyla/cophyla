// A terminal's screen in the view: xterm.js, loaded the first time one is shown, drawing the
// repaint `terminal.open` answers with and then what the node streams (`terminal.output`). One
// terminal shows at a time, a session's own in its pane or a bare one in a pane of its own;
// switching away closes its view on the node.
//
// By default the view follows the terminal's own size, which the window the user types in
// sets: it draws at the terminal's columns and rows, with the font scaled so they fill as much
// of the pane as their shape allows (shrinking no further than a floor), and never resizes it.
// "Fit to this window" drives it instead: the terminal takes the pane's size, as a window
// would, until a window types or resizes again. − and + beside it scale the font a step from
// what it is drawn at, the percentage between them, and drive the terminal at that font: a
// bigger one gets fewer columns and rows, still filling the pane.
// Keys typed here go to the terminal when the node let this view open it to type; otherwise
// it is read only, and says so. A bare terminal's End asks in place before it ends anything:
// the frame's sandbox allows no dialogs, so `window.confirm` would answer no unseen.
//
// It behaves as VS Code's terminal does. Shift+Enter sends what Claude Code's VS Code binding
// sends, a new line in its prompt. Text selected here is copied as it is selected, Ctrl+C
// copies it rather than interrupting, and Ctrl+V pastes; a program that selects for itself
// (Claude, which takes the mouse) copies with OSC 52, which is honoured, and never read
// back. A link, a URL in the text or an OSC 8 one, opens in the browser at Ctrl+click (⌘ on
// a Mac), or a tap where there is no mouse: the host opens it (`host.openLink`), since the
// frame has no way out. A file or a folder dragged from the explorer onto the screen is typed
// in as its path, as a paste.

import type { Terminal as TerminalRow } from "@cophyla/protocol";
import { clipboardWrite, FONT_DRIVE, FONT_MIN, followFont, fontScale, pastRepaint, repeatsTracking, scaleFont, SHIFT_ENTER, stepScale } from "./model.ts";
import type { TerminalOutput } from "./model.ts";
import type { FitAddon } from "./vendor/addon-fit.mjs";
import type { Unicode11Addon } from "./vendor/addon-unicode11.mjs";
import type { WebLinksAddon } from "./vendor/addon-web-links.mjs";
import type { Terminal as XTerm } from "./vendor/xterm.mjs";
import { ViewRpcError } from "./rpc.ts";
import type { HostRpc } from "./rpc.ts";

interface Opened {
  seq: number;
  cols: number;
  rows: number;
  data: string;
}

interface Xterm {
  Terminal: typeof XTerm;
  FitAddon: typeof FitAddon;
  Unicode11Addon: typeof Unicode11Addon;
  WebLinksAddon: typeof WebLinksAddon;
}

const MONO = '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, "SF Mono", Menlo, monospace';
/** A driven terminal's size is sent once the pane stopped changing for this long. */
const RESIZE_MS = 120;
/** xterm's scrollbar, kept clear of the screen at its right (view.css pads it this wide). */
const SCROLLBAR = 14;
const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
/** What a link says while the mouse is on it. */
const FOLLOW = `Follow link (${MAC ? "⌘" : "Ctrl"}+click)`;

export interface ShowOptions {
  /** Size the terminal to the pane. */
  drive: boolean;
  /** A driven terminal's font, in percent of the default (`SCALES`). */
  scale: number;
  /** Ask to type into it. */
  input: boolean;
}

export class TerminalView {
  /** The pane's contents: a bar (what it is, − scale +, Fit, End and its question) above the screen. */
  readonly el: HTMLElement;
  private screen: HTMLElement;
  private rpc: HostRpc;
  private changed: () => void;
  private loading?: Promise<Xterm>;
  private term?: XTerm;
  private fit?: FitAddon;
  private id?: string;
  private opts?: ShowOptions;
  private generation = 0;
  /** The repaint's position, once the open answered; output before that is held. */
  private opened?: number;
  private held: TerminalOutput[] = [];
  private resizeTimer?: ReturnType<typeof setTimeout>;
  /** Fit, − and + may size the terminal: it is typed into from here and still running. */
  private drivable = false;
  /** A button went down on the screen, and whether the selection changed since: copied when it comes up. */
  private pressed = false;
  private reselected = false;
  /** Keys typed here reach the terminal. */
  typing = false;
  /** Why it shows nothing, or why it is read only. */
  note?: string;

  constructor(rpc: HostRpc, changed: () => void) {
    this.rpc = rpc;
    this.changed = changed;
    this.el = document.createElement("div");
    this.el.className = "term-view";
    const bar = document.createElement("div");
    bar.className = "term-bar";
    const status = document.createElement("span");
    status.className = "term-status";
    const note = document.createElement("span");
    note.className = "term-note";
    const scale = document.createElement("span");
    scale.className = "term-scale";
    scale.setAttribute("role", "group");
    scale.setAttribute("aria-label", "Scale");
    const smaller = button("term-smaller", "−");
    smaller.title = "Smaller: fit the terminal to this window at a smaller font";
    const value = document.createElement("span");
    value.className = "term-scale-value";
    const larger = button("term-larger", "+");
    larger.title = "Larger: fit the terminal to this window at a larger font";
    scale.append(smaller, value, larger);
    const fit = button("term-fit", "Fit to this window");
    fit.title = "Size the terminal to this pane, as a window would; a window you type in takes it back";
    const end = button("term-end", "End");
    end.title = "End the program running in this terminal";
    const ask = document.createElement("span");
    ask.className = "term-end-ask";
    bar.append(status, note, scale, fit, end, ask, button("term-end-confirm", "End"), button("term-end-cancel", "Cancel"));
    this.screen = document.createElement("div");
    this.screen.className = "term-screen";
    this.el.append(bar, this.screen);
    new ResizeObserver(() => this.layout()).observe(this.screen);
    // Captured, since xterm stops the mouse events it reports to a program.
    this.screen.addEventListener(
      "mousedown",
      () => {
        this.pressed = true;
        this.reselected = false;
      },
      true,
    );
    window.addEventListener("mouseup", () => this.selected(), true);
  }

  /** The terminal shown, if one is. */
  get shown(): string | undefined {
    return this.id;
  }

  /** The scale the terminal is drawn at, followed or driven, in percent of the default font. */
  get scale(): number | undefined {
    const font = this.term?.options.fontSize;
    return font !== undefined ? fontScale(font) : undefined;
  }

  /** Shows a terminal in `parent`, opening it on the node; the one shown before is closed. */
  show(id: string, parent: HTMLElement, opts: ShowOptions): void {
    if (this.el.parentElement !== parent) parent.append(this.el);
    if (this.id === id && this.opts?.drive === opts.drive && this.opts.input === opts.input) {
      if (this.opts.scale !== opts.scale) this.rescale(opts.scale);
      return;
    }
    this.close();
    const generation = ++this.generation;
    this.id = id;
    this.opts = opts;
    void this.open(id, opts, generation);
  }

  /** Closes the terminal shown and takes the pane away. */
  hide(): void {
    this.close();
    this.el.remove();
  }

  /**
   * The bar: what the terminal is, and whether it may be ended from here (a bare one): End,
   * then once pressed the question with End and Cancel, then Ending… until it exited.
   */
  update(row: TerminalRow | undefined, bare: boolean, fit: boolean, ending?: "asking" | "ending"): void {
    const status = this.el.querySelector<HTMLElement>(".term-status")!;
    const size = row ? `${row.cols}×${row.rows}` : "";
    status.textContent = row ? (row.status === "exited" ? `exited${row.exitCode !== undefined ? ` ${row.exitCode}` : ""} · ${size}` : `${row.title || row.name || row.argv0} · ${size}`) : "";
    const note = this.el.querySelector<HTMLElement>(".term-note")!;
    note.textContent = this.note ?? "";
    note.hidden = this.note === undefined;
    const fitButton = this.el.querySelector<HTMLButtonElement>(".term-fit")!;
    fitButton.setAttribute("aria-pressed", fit ? "true" : "false");
    this.drivable = this.typing && row?.status !== "exited";
    fitButton.disabled = !this.drivable;
    this.showScale();
    const endable = bare && row !== undefined && row.status !== "exited";
    const phase = endable ? ending : undefined;
    for (const b of Array.from(this.el.querySelectorAll<HTMLButtonElement>(".term-end, .term-end-confirm, .term-end-cancel"))) b.dataset["terminal"] = row?.id ?? "";
    this.el.querySelector<HTMLElement>(".term-end")!.hidden = !endable || phase !== undefined;
    const ask = this.el.querySelector<HTMLElement>(".term-end-ask")!;
    ask.hidden = phase !== "asking";
    ask.textContent = row ? `End ${row.argv0} in this terminal?` : "";
    const confirm = this.el.querySelector<HTMLButtonElement>(".term-end-confirm")!;
    confirm.hidden = phase === undefined;
    confirm.textContent = phase === "ending" ? "Ending…" : "End";
    confirm.disabled = phase === "ending";
    this.el.querySelector<HTMLElement>(".term-end-cancel")!.hidden = phase !== "asking";
  }

  /** Output of the terminal shown; anything else is dropped. */
  output(o: TerminalOutput): void {
    if (o.terminal !== this.id || !this.term) return;
    if (this.opened === undefined) this.held.push(o);
    else this.apply(o);
  }

  /** A terminal's row: a followed one takes its new size. */
  state(row: TerminalRow): void {
    if (row.id !== this.id || !this.term || this.opened === undefined || this.opts?.drive) return;
    if (row.cols !== this.term.cols || row.rows !== this.term.rows) this.sizeTo(row.cols, row.rows);
  }

  focus(): void {
    this.term?.focus();
  }

  /** Whether text dropped on the screen would be typed in: a terminal shows, and this view types into it. */
  get droppable(): boolean {
    return this.term !== undefined && this.typing;
  }

  /** Text dropped on the screen, typed in as a paste is (bracketed, when the program asked for that); nothing when it is not typed into from here. */
  paste(text: string): void {
    if (!this.term || !this.typing) return;
    this.term.paste(text);
    this.term.focus();
  }

  private async open(id: string, opts: ShowOptions, generation: number): Promise<void> {
    let x: Xterm;
    try {
      x = await this.load();
    } catch (e) {
      return this.fail(generation, `the terminal could not load: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (generation !== this.generation) return;
    const term = new x.Terminal({
      fontFamily: MONO,
      fontSize: opts.drive ? scaleFont(opts.scale) : FONT_DRIVE,
      scrollback: 3000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: "#0c0c0c", foreground: "#cccccc", cursor: "#cccccc", selectionBackground: "#3a3d41" },
      linkHandler: { activate: (ev, url) => this.openLink(ev, url), hover: () => this.hoverLink(true), leave: () => this.hoverLink(false) },
    });
    term.loadAddon(new x.Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new x.WebLinksAddon((ev, url) => this.openLink(ev, url), { hover: () => this.hoverLink(true), leave: () => this.hoverLink(false) }));
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => repeatsTracking(params, term.modes.mouseTrackingMode));
    term.parser.registerOscHandler(52, (data) => {
      const text = clipboardWrite(data);
      if (text !== undefined) copy(text);
      return true;
    });
    term.attachCustomKeyEventHandler((ev) => keyed(term, ev));
    term.onSelectionChange(() => (this.reselected = true));
    const fit = new x.FitAddon();
    term.loadAddon(fit);
    term.open(this.screen);
    this.term = term;
    this.fit = fit;
    term.onData((data) => {
      if (this.typing && this.id === id) this.rpc.signal("terminal.input", { terminal: id, data });
    });
    let drive: { cols: number; rows: number } | undefined;
    if (opts.drive) {
      fit.fit();
      drive = fit.proposeDimensions();
    }
    let r: Opened;
    try {
      r = await this.rpc.request<Opened>("terminal.open", { terminal: id, ...(opts.input ? { input: true } : {}), ...(drive ? { drive } : {}) });
      this.typing = opts.input;
      this.note = undefined;
    } catch (e) {
      if (generation !== this.generation) return;
      if (!(opts.input && e instanceof ViewRpcError && e.code === "denied")) return this.fail(generation, message(e));
      // Not allowed to type: it is watched instead.
      try {
        r = await this.rpc.request<Opened>("terminal.open", { terminal: id });
      } catch (e2) {
        return this.fail(generation, message(e2));
      }
      this.typing = false;
      this.note = "Read only: this view may not type into terminals";
    }
    if (generation !== this.generation) return;
    this.sizeTo(r.cols, r.rows);
    term.write(r.data);
    this.opened = r.seq;
    for (const o of pastRepaint(r.seq, this.held)) this.apply(o);
    this.held = [];
    if (this.typing) term.focus();
    this.changed();
  }

  private apply(o: TerminalOutput): void {
    const term = this.term!;
    if (o.cols !== undefined && o.rows !== undefined && (o.cols !== term.cols || o.rows !== term.rows)) this.sizeTo(o.cols, o.rows);
    if (o.reset) term.reset();
    term.write(o.data);
  }

  /** Draws at the terminal's size; followed, the font scales it to the pane. */
  private sizeTo(cols: number, rows: number): void {
    const term = this.term!;
    term.resize(cols, rows);
    if (!this.opts?.drive) this.fitFont();
    this.showScale();
  }

  /** Scales a followed terminal's font to fill the pane with its columns and rows. */
  private fitFont(): void {
    const term = this.term;
    const drawn = term?.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!term || !drawn) return;
    const pad = getComputedStyle(this.screen);
    const room = {
      width: this.screen.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) - SCROLLBAR,
      height: this.screen.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom),
    };
    if (room.width <= 0 || room.height <= 0) return; // hidden: refit once it shows
    // Cells round to whole pixels, so a size scaled from another is a guess: guessed again
    // from what it drew, then stepped down while it still does not fit.
    let font = term.options.fontSize ?? FONT_DRIVE;
    for (let i = 0; i < 2; i++) {
      const next = followFont(room, { width: drawn.offsetWidth, height: drawn.offsetHeight }, font);
      if (next === font) break;
      term.options.fontSize = font = next;
    }
    while (font > FONT_MIN && (drawn.offsetWidth > room.width || drawn.offsetHeight > room.height)) term.options.fontSize = font -= 0.5;
    this.showScale();
  }

  /** A driven terminal's new scale: it redraws at that font and takes the pane's size at it. */
  private rescale(scale: number): void {
    const opts = this.opts!;
    opts.scale = scale; // an open still loading draws at it
    const term = this.term;
    if (!opts.drive || !term || !this.fit || this.opened === undefined || !this.id) return;
    term.options.fontSize = scaleFont(scale);
    this.fit.fit();
    this.rpc.signal("terminal.resize", { terminal: this.id, cols: term.cols, rows: term.rows });
    this.showScale();
  }

  /** The scale between − and +, each disabled with no step left its way. */
  private showScale(): void {
    const scale = this.scale;
    this.el.querySelector<HTMLElement>(".term-scale-value")!.textContent = scale !== undefined ? `${scale}%` : "";
    this.el.querySelector<HTMLButtonElement>(".term-smaller")!.disabled = !this.drivable || scale === undefined || stepScale(scale, -1) === undefined;
    this.el.querySelector<HTMLButtonElement>(".term-larger")!.disabled = !this.drivable || scale === undefined || stepScale(scale, 1) === undefined;
  }

  /** The pane changed size: a followed terminal refits its font, a driven one sends its new size. */
  private layout(): void {
    if (!this.term || this.opened === undefined || !this.id) return;
    if (!this.opts?.drive) return this.fitFont();
    clearTimeout(this.resizeTimer);
    const id = this.id;
    this.resizeTimer = setTimeout(() => {
      if (!this.fit || !this.term || this.id !== id) return;
      this.fit.fit();
      this.rpc.signal("terminal.resize", { terminal: id, cols: this.term.cols, rows: this.term.rows });
    }, RESIZE_MS);
  }

  /**
   * A button came up: what it selected on the screen is copied, and nothing when it selected
   * nothing new. Looked at once the release is handled, since xterm settles its selection then.
   */
  private selected(): void {
    if (!this.pressed) return;
    this.pressed = false;
    setTimeout(() => {
      if (this.reselected && this.term?.hasSelection()) copy(this.term.getSelection());
    });
  }

  /** A link was clicked: the host opens it, with Ctrl or ⌘ held, or at a tap where there is no mouse. */
  private openLink(ev: MouseEvent, url: string): void {
    if (!ev.ctrlKey && !ev.metaKey && !touch()) return;
    this.rpc.request("host.openLink", { url }).catch((e: unknown) => console.warn(`the link did not open: ${message(e)}`));
  }

  /** The mouse went onto a link or off it: while on, the terminal says how to follow it. */
  private hoverLink(on: boolean): void {
    const el = this.term?.element;
    if (!el || touch()) return;
    if (on) el.title = FOLLOW;
    else el.removeAttribute("title");
  }

  private close(): void {
    this.generation++;
    clearTimeout(this.resizeTimer);
    if (this.id !== undefined) {
      const id = this.id;
      void this.rpc.request("terminal.close", { terminal: id }).catch(() => undefined);
    }
    this.term?.dispose();
    this.term = undefined;
    this.fit = undefined;
    this.id = undefined;
    this.opts = undefined;
    this.opened = undefined;
    this.held = [];
    this.typing = false;
    this.note = undefined;
  }

  private fail(generation: number, note: string): void {
    if (generation !== this.generation) return;
    this.note = note;
    this.changed();
  }

  private load(): Promise<Xterm> {
    this.loading ??= Promise.all([import("./vendor/xterm.mjs"), import("./vendor/addon-fit.mjs"), import("./vendor/addon-unicode11.mjs"), import("./vendor/addon-web-links.mjs")]).then(([a, b, c, d]) => ({
      Terminal: a.Terminal,
      FitAddon: b.FitAddon,
      Unicode11Addon: c.Unicode11Addon,
      WebLinksAddon: d.WebLinksAddon,
    }));
    this.loading.catch(() => (this.loading = undefined));
    return this.loading;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** No mouse to hover or hold Ctrl with: a phone's touch screen. */
function touch(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}

/**
 * The keys the view answers itself, as VS Code does; false keeps them from xterm. Shift+Enter
 * sends `SHIFT_ENTER` rather than Enter. Off a Mac, where ⌘ copies and pastes already, Ctrl+V
 * pastes (the browser's own paste, which xterm sends on, bracketed if the program asked), and
 * Ctrl+C copies what is selected here, if anything is, rather than interrupting; with Shift
 * too, as other terminals have them, they always paste and copy.
 */
function keyed(term: XTerm, ev: KeyboardEvent): boolean {
  if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    if (ev.type === "keydown") term.input(SHIFT_ENTER);
    ev.preventDefault();
    return false;
  }
  if (MAC || ev.type !== "keydown" || !ev.ctrlKey || ev.altKey || ev.metaKey) return true;
  const key = ev.key.toLowerCase();
  if (key === "v") return false;
  if (key === "c" && (ev.shiftKey || term.hasSelection())) {
    if (term.hasSelection()) copy(term.getSelection());
    term.clearSelection();
    ev.preventDefault();
    return false;
  }
  return true;
}

/**
 * Puts text on the clipboard. The frame may not use the Clipboard API, which its host never
 * allows it, so it answers a copy of its own instead: the browser allows that while the user's
 * last click or key is fresh. The API is tried where that fails, for a host that allows it.
 */
function copy(text: string): void {
  let done = false;
  const answer = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    e.stopImmediatePropagation();
    done = true;
  };
  document.addEventListener("copy", answer, true);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", answer, true);
  }
  if (!done) navigator.clipboard?.writeText(text).catch(() => undefined);
}

function button(className: string, text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.dataset["action"] = className;
  b.textContent = text;
  return b;
}
