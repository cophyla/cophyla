// The host page's way to the shell: Tauri's commands and events, with the link to cophylad on a
// socket of its own beside them. Every Tauri event is a script the shell evaluates on the app's
// UI thread, and every command arrives and is answered there; so the link's frames and state,
// and what the page sends, go over a WebSocket to the shell's loopback server instead
// (src-tauri/src/page.rs), which never touches that thread. This is a `TauriIo` like the one it
// wraps, so the Connection and everything else in the page use it unchanged: `cophylad_attach`
// asks for the socket and opens it, `cophylad_send` (a batch, as the Connection coalesces it) and
// `app_log` go over it while it is open, the frames, the link's state and the shell's events
// that come over it reach the listeners as the events would. Without the socket everything goes
// as Tauri's events and commands: frames as one `cophylad:frames` event a batch. A socket that
// closes after it opened is asked for again a second later (the shell reconnects to cophylad
// when it opens, for a fresh snapshot); one that never opens leaves the page on the events, and
// the shell reconnects for it at once.

import { EVENT_FRAME, EVENT_STATE } from "@cophyla/viewhost";
import type { LinkSnapshot, TauriIo } from "@cophyla/viewhost";

/** The frames of one read of the shell's, while the page has no socket: an array, in order. */
export const EVENT_FRAMES = "cophylad:frames";
/** How long after an open socket closes the page asks for another. */
export const RETRY_MS = 1000;

/** What of a WebSocket the link uses: the browser's, or a test's. Its handlers' events are never read but a message's `data`. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: never) => void) | null;
  onmessage: ((ev: never) => void) | null;
  onclose: ((ev: never) => void) | null;
  onerror: ((ev: never) => void) | null;
}

export interface PageLinkDeps {
  io: TauriIo;
  /** Opens a socket; none, and the page never asks for one. */
  socket?: (url: string) => SocketLike;
  log?: (message: string) => void;
  retryMs?: number;
}

const OPEN = 1;
type Handler = (payload: unknown) => void;

export class PageLink implements TauriIo {
  private deps: PageLinkDeps;
  private frames = new Set<(text: string) => void>();
  private states = new Set<(snapshot: LinkSnapshot) => void>();
  private events = new Map<string, Set<Handler>>();
  private ws: SocketLike | undefined;
  /** What the page last attached with, for the attach a socket's close asks for again. */
  private attachArgs: Record<string, unknown> = {};
  /** A socket did not open: events and commands from now on. */
  private noSocket = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: PageLinkDeps) {
    this.deps = deps;
  }

  /** Whether the socket is open now. */
  get socketOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (event === EVENT_FRAME) {
      const h = handler as (text: string) => void;
      this.frames.add(h);
      // what the shell sent as events before this socket opened is not this connection's
      const off = await this.deps.io.listen<string[]>(EVENT_FRAMES, (batch) => {
        if (this.socketOpen) return;
        for (const text of batch) h(text);
      });
      return () => {
        this.frames.delete(h);
        off();
      };
    }
    if (event === EVENT_STATE) {
      const h = handler as (snapshot: LinkSnapshot) => void;
      this.states.add(h);
      const off = await this.deps.io.listen<LinkSnapshot>(EVENT_STATE, (s) => {
        if (!this.socketOpen) h(s);
      });
      return () => {
        this.states.delete(h);
        off();
      };
    }
    const h = handler as Handler;
    const set = this.events.get(event) ?? new Set<Handler>();
    set.add(h);
    this.events.set(event, set);
    const off = await this.deps.io.listen<T>(event, handler);
    return () => {
      set.delete(h);
      off();
    };
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (cmd === "cophylad_attach") {
      this.attachArgs = { ...(args ?? {}) };
      return (await this.attach()) as T;
    }
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) {
      if (cmd === "cophylad_send") {
        const batch = args?.["frames"] as object[] | undefined;
        const frames = batch ?? (args?.["frame"] !== undefined ? [args["frame"] as object] : []);
        for (const f of frames) ws.send(JSON.stringify(f));
        return (batch ? frames.map(() => null) : []) as T;
      }
      if (cmd === "app_log") {
        ws.send(JSON.stringify(["log", args?.["lines"] ?? []]));
        return undefined as T;
      }
    }
    return this.deps.io.invoke<T>(cmd, args);
  }

  /** Attaches, asking for the socket unless the page has none; opens the one the shell gives. */
  private async attach(): Promise<LinkSnapshot> {
    const asks = this.deps.socket !== undefined && !this.noSocket;
    const answer = await this.deps.io.invoke<LinkSnapshot & { socket?: string }>("cophylad_attach", { ...this.attachArgs, ...(asks ? { socket: true } : {}) });
    const { socket, ...snapshot } = answer;
    if (asks && typeof socket === "string") this.connect(socket);
    return snapshot;
  }

  private connect(url: string): void {
    const old = this.ws;
    if (old) {
      this.ws = undefined;
      old.onclose = null;
      old.close();
    }
    let ws: SocketLike;
    try {
      ws = this.deps.socket!(url);
    } catch (e) {
      this.unopened(`page socket: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (ev: { data: unknown }) => {
      if (this.ws === ws) this.message(String(ev.data));
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (opened) {
        this.log("page socket closed: the link goes as events until another opens");
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.reattach(), this.deps.retryMs ?? RETRY_MS);
      } else this.unopened("page socket did not open: the link goes as events");
    };
  }

  /** The socket did not open: the page stays on the events, and attaches again for a snapshot. */
  private unopened(why: string): void {
    this.log(why);
    this.noSocket = true;
    this.reattach();
  }

  /** Attaches again, outside the Connection's own attach: the state it answers goes to the listeners. */
  private reattach(): void {
    this.attach().then(
      (snapshot) => {
        for (const h of this.states) h(snapshot);
      },
      (e: unknown) => this.log(`attach: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /** One message on the socket: a frame of cophylad's as it sent it, or the shell's own, an array. */
  private message(text: string): void {
    if (text.charCodeAt(0) !== 0x5b) {
      for (const h of this.frames) h(text);
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    if (msg[0] === "state") {
      for (const h of this.states) h(msg[1] as LinkSnapshot);
    } else if (msg[0] === "event" && typeof msg[1] === "string") {
      for (const h of this.events.get(msg[1]) ?? []) h(msg[2]);
    }
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}
