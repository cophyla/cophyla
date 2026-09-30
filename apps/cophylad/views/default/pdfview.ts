// A PDF in the file viewer, drawn by pdf.js (vendored, Apache-2.0), loaded the first time a PDF
// is shown, the way terminal.ts loads xterm. The frame's opaque origin can start no worker, so
// pdf.js's worker module runs on the page's own thread, handed to it as `globalThis.pdfjsWorker`
// (its "fake worker"). Nothing is fetched: the bytes come from the node, pdf.js may not `eval`,
// and there is no URL for character maps or the standard fonts, which `connect-src 'none'`
// would refuse anyway, so a font the PDF does not embed is the system's.
//
// Its pages go down the middle, each a canvas drawn only as it comes near the screen and let go
// once it is far, at the width of the viewer (fit) or at its own size (100%), a click switching
// between the two; over each canvas its text, laid out invisible where it is drawn, to select
// and copy. What it cannot draw: JPEG 2000 images, whose decoder pdf.js fetches as WebAssembly,
// and CJK text in a font the PDF does not embed, for want of the character maps.

import type { PageViewport, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer as PdfTextLayer } from "./vendor/pdfjs/pdf.min.mjs";

type PdfJs = typeof import("./vendor/pdfjs/pdf.min.mjs");

/** CSS pixels per PDF point at 100%, as a browser's own PDF viewer has it. */
const CSS_PER_POINT = 96 / 72;
/** How far past the screen a page is drawn before it shows, and let go once it is further. */
const NEAR = "150% 0px";
/** The most pixels one page's canvas holds: past it, it is drawn less sharp rather than run the frame out of memory. */
const CANVAS_MAX = 16 * 1024 * 1024;
/** Room around the pages, in CSS pixels (view.css has the same). */
const PAD = 16;
/** The viewer's width settles this long before the pages are laid out at it again. */
const RESIZE_MS = 150;

let loading: Promise<PdfJs> | undefined;

/** pdf.js, with its worker module on this thread, once. */
function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const worker = await import("./vendor/pdfjs/pdf.worker.min.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import("./vendor/pdfjs/pdf.min.mjs");
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

/** Why a PDF could not be opened, in the viewer's words. */
export class PdfError extends Error {}

interface Page {
  n: number;
  el: HTMLElement;
  /** Its size at scale 1, in points: the first page's until its own is known. */
  width: number;
  height: number;
  sized: boolean;
  near: boolean;
  task?: RenderTask;
  text?: PdfTextLayer;
  /** The scale it is drawn at, once it is. */
  drawn?: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/** A PDF's pages, drawn as they come near the screen of the element that scrolls them. */
export class PdfView {
  readonly el: HTMLElement;
  readonly pages: number;
  private pdfjs: PdfJs;
  private doc: PDFDocumentProxy;
  private list: Page[] = [];
  private scroller?: HTMLElement;
  private near?: IntersectionObserver;
  private resized?: ResizeObserver;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private width = 0;
  private destroyed = false;

  private constructor(pdfjs: PdfJs, doc: PDFDocumentProxy, first: PageViewport) {
    this.pdfjs = pdfjs;
    this.doc = doc;
    this.pages = doc.numPages;
    this.el = el("div", "viewer-pdf");
    this.el.dataset["fit"] = "1";
    this.el.title = "Click for its own size, and again to fit";
    for (let n = 1; n <= doc.numPages; n++) {
      const page = el("div", "pdf-page");
      page.dataset["page"] = String(n);
      page.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
      this.el.append(page);
      this.list.push({ n, el: page, width: first.width, height: first.height, sized: n === 1, near: false });
    }
  }

  /** Opens a PDF's bytes, which pdf.js takes over; throws PdfError saying why it cannot. */
  static async open(bytes: Uint8Array): Promise<PdfView> {
    let pdfjs: PdfJs;
    try {
      pdfjs = await loadPdfJs();
    } catch (e) {
      throw new PdfError(`The PDF reader could not load: ${e instanceof Error ? e.message : String(e)}`);
    }
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, useWasm: false, verbosity: pdfjs.VerbosityLevel.ERRORS });
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      if (name === "PasswordException") throw new PdfError("This PDF is locked with a password, so there is nothing to show.");
      throw new PdfError(`This PDF cannot be drawn: ${e instanceof Error ? e.message : String(e)}`);
    }
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    return new PdfView(pdfjs, doc, first);
  }

  /** Puts the pages in the element that scrolls them, laid out at its width; the ones near its screen are drawn. */
  attach(scroller: HTMLElement): void {
    this.scroller = scroller;
    this.width = scroller.clientWidth;
    this.layout();
    this.near = new IntersectionObserver((entries) => this.onNear(entries), { root: scroller, rootMargin: NEAR });
    for (const p of this.list) this.near.observe(p.el);
    this.resized = new ResizeObserver(() => {
      if (this.el.dataset["fit"] !== "1" || !this.scroller || this.scroller.clientWidth === this.width) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.rescale(), RESIZE_MS);
    });
    this.resized.observe(scroller);
    void this.sizeAll();
  }

  /** Fit to the viewer's width, or at its own size: the page at the top stays at the top. */
  toggleFit(): void {
    this.el.dataset["fit"] = this.el.dataset["fit"] === "1" ? "0" : "1";
    this.rescale();
  }

  /** Lets every page and the document go. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.resizeTimer);
    this.near?.disconnect();
    this.resized?.disconnect();
    for (const p of this.list) this.release(p);
    void this.doc.destroy();
  }

  /** CSS pixels per point: the viewer's width across the widest page's, or 100%. */
  private scale(): number {
    if (this.el.dataset["fit"] !== "1") return CSS_PER_POINT;
    const widest = Math.max(...this.list.map((p) => p.width));
    return Math.max(0.1, (this.width - 2 * PAD) / widest);
  }

  /** Each page's box at the scale, drawn or not. */
  private layout(): void {
    const scale = this.scale();
    for (const p of this.list) {
      p.el.style.width = `${Math.floor(p.width * scale)}px`;
      p.el.style.height = `${Math.floor(p.height * scale)}px`;
      p.el.style.setProperty("--total-scale-factor", String(scale));
    }
  }

  /** Laid out again at a new width or scale, keeping the place: the pages near the screen are drawn again at it. */
  private rescale(): void {
    const scroller = this.scroller;
    if (!scroller || this.destroyed) return;
    const share = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    this.width = scroller.clientWidth;
    this.layout();
    scroller.scrollTop = share * scroller.scrollHeight;
    for (const p of this.list) if (p.near) void this.draw(p);
  }

  /** Every page's own size, a page at a time, after the first shows: a PDF of pages of mixed sizes lays out as it is. */
  private async sizeAll(): Promise<void> {
    let changed = false;
    for (const p of this.list) {
      if (this.destroyed) return;
      if (p.sized) continue;
      const vp = (await this.doc.getPage(p.n)).getViewport({ scale: 1 });
      p.sized = true;
      if (vp.width !== p.width || vp.height !== p.height) {
        p.width = vp.width;
        p.height = vp.height;
        changed = true;
      }
    }
    if (changed && !this.destroyed) this.rescale();
  }

  private onNear(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const p = this.list[Number((e.target as HTMLElement).dataset["page"]) - 1];
      if (!p) continue;
      p.near = e.isIntersecting;
      if (p.near) void this.draw(p);
      else this.release(p);
    }
  }

  /** A page drawn at the scale, sharp at the screen's pixel density, its text over it; a drawing under way at another scale is dropped. */
  private async draw(p: Page): Promise<void> {
    const scale = this.scale();
    if (p.drawn === scale || this.destroyed) return;
    this.release(p);
    p.drawn = scale;
    let page: PDFPageProxy;
    try {
      page = await this.doc.getPage(p.n);
    } catch {
      return;
    }
    if (p.drawn !== scale || !p.near || this.destroyed) return;
    const viewport = page.getViewport({ scale });
    let ratio = window.devicePixelRatio || 1;
    if (viewport.width * viewport.height * ratio * ratio > CANVAS_MAX) ratio = Math.sqrt(CANVAS_MAX / (viewport.width * viewport.height));
    const canvas = el("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    const text = el("div", "textLayer");
    p.el.replaceChildren(canvas, text);
    const task = page.render({ canvasContext: context, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
    p.task = task;
    const layer = new this.pdfjs.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: text, viewport });
    p.text = layer;
    try {
      await Promise.all([task.promise, layer.render()]);
    } catch {
      // Dropped for another scale, or let go: nothing to say.
    }
    if (p.task === task) p.task = undefined;
  }

  /** A page's canvas and text let go, its box kept. */
  private release(p: Page): void {
    p.task?.cancel();
    p.task = undefined;
    p.text?.cancel();
    p.text = undefined;
    p.drawn = undefined;
    // A canvas sized to nothing gives its memory back at once.
    const canvas = p.el.querySelector("canvas");
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    p.el.replaceChildren();
  }
}
