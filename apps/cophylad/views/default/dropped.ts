// Where the files dropped on the view from the desktop are. A page learns only a dropped
// file's name, so where the host can say (`filePaths` in `host.ready`: the desktop app) the view
// asks. In WebView2 (Windows) it hands WebView2 the files themselves from this frame with
// `chrome.webview.postMessageWithAdditionalObjects({ cophyla: "cophyla.filePaths", id }, files)`;
// the shell answers this frame with a WebView2 message `{ cophyla: "cophyla.filePaths", id,
// paths }`, the paths in the files' order. It is the one thing the view asks past its host:
// WebView2 grants a dropped file to the process of the frame it was dropped on alone, and the
// host page, in a process of its own, could not hand it on. Elsewhere (WebKit: macOS, Linux)
// it asks its host by the files' names, `host.filePaths { names }`, and the shell answers
// `{ paths }` in the names' order from the drop it saw pass into the page, once, and only while
// the drop is fresh.

/** What the frame reaches of WebView2 where the desktop app runs it. */
export interface WebView2 {
  postMessageWithAdditionalObjects(message: unknown, additionalObjects: ArrayLike<unknown>): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

/** Asks the host where the files just dropped under these names are: `host.filePaths`, answered `{ paths }`. */
export type AskHost = (names: string[]) => Promise<unknown>;

/** The mark on the ask and on its answer. */
export const FILES_MESSAGE = "cophyla.filePaths";

/** How long the shell has to answer: it reads the paths at once, so a longer wait is none coming. */
export const FILES_TIMEOUT_MS = 5000;

/** The frame's WebView2, where it has one. */
export function webView2(win: unknown): WebView2 | undefined {
  const webview = (win as { chrome?: { webview?: Partial<WebView2> } } | null)?.chrome?.webview;
  return typeof webview?.postMessageWithAdditionalObjects === "function" && typeof webview.addEventListener === "function" ? (webview as WebView2) : undefined;
}

/** Asks where dropped files are, one drop at a time or several: of WebView2 where the frame has it, of the host elsewhere. */
export class DroppedPaths {
  private webview?: WebView2;
  private askHost: AskHost;
  private n = 0;
  private waiting = new Map<number, (paths: string[]) => void>();

  constructor(webview: WebView2 | undefined, askHost: AskHost) {
    this.askHost = askHost;
    if (!webview) return;
    this.webview = webview;
    webview.addEventListener("message", (ev) => this.answered(ev.data));
  }

  /** The files' paths in their order; one the app could not place fails the whole drop. */
  async paths(files: File[]): Promise<string[]> {
    const paths = this.webview ? await this.fromWebView2(this.webview, files) : await this.fromHost(files);
    if (paths.length !== files.length) throw new Error("the app could not say where every file is");
    return paths;
  }

  private async fromHost(files: File[]): Promise<string[]> {
    const answer = (await this.askHost(files.map((f) => f.name))) as { paths?: unknown } | null;
    const paths = answer?.paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw new Error("the app's answer is not paths");
    return paths;
  }

  private fromWebView2(webview: WebView2, files: File[]): Promise<string[]> {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("the app did not say where the files are"));
      }, FILES_TIMEOUT_MS);
      this.waiting.set(id, (paths) => {
        clearTimeout(timer);
        resolve(paths);
      });
      try {
        webview.postMessageWithAdditionalObjects({ cophyla: FILES_MESSAGE, id }, files);
      } catch (e) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private answered(data: unknown): void {
    const a = data as { cophyla?: unknown; id?: unknown; paths?: unknown } | null;
    if (!a || a.cophyla !== FILES_MESSAGE || typeof a.id !== "number" || !Array.isArray(a.paths)) return;
    const done = this.waiting.get(a.id);
    if (!done) return;
    this.waiting.delete(a.id);
    done(a.paths.filter((p): p is string => typeof p === "string"));
  }
}
