// The remote desktop in the app. The stream page lives on the node's controller origin,
// whose certificate is self-signed, so neither the app's web view nor the phone's browser
// will load it; the Kotlin plugin shows it in a full-screen dialog of its own instead,
// fetched through a forwarder on the phone's loopback that carries each connection on to
// the node: on the LAN over a socket pinned to the key learned at pairing, the video on the
// page's own WebSocket; off it (with Direct connections on) through pipes over the link to
// the host node, the video then over WebRTC. `planOpen` decides from what the view handed
// `host.open` and where the link runs; `Streams` keeps a stream's lifetime: the app's
// microphone off while it shows, and the node told when it closes; `PipeBridge` carries a
// link stream's connections, each a pipe (`remote.pipe.*`) between the plugin and the link.

import { PIN_MISMATCH, PIN_MISMATCH_MESSAGE } from "./native-io.ts";
import type { Credential } from "../pairing.ts";
import { openTarget } from "../remote.ts";
import type { TransportKind } from "../transport.ts";

export type OpenPlan =
  /** The page through the forwarder, over a socket pinned to the node the link is on. */
  | { kind: "lan"; host: string; port: number; pin: string; path: string; stream?: string }
  /** The page through pipes over the link to the host node, the video over WebRTC. */
  | { kind: "link"; node: string; path: string; stream?: string }
  /** A page elsewhere, for the phone's browser. */
  | { kind: "window"; url: string }
  /** A link for another app (an `art:` invite). */
  | { kind: "app"; url: string }
  | { kind: "refuse"; reason: string };

export interface PlanContext {
  /** Where the link runs now. */
  via: TransportKind | undefined;
  credential: Credential | undefined;
  /** The shell has the stream plugin. */
  canForward: boolean;
  origin: string;
}

export const AWAY_MESSAGE = "a desktop opens in the app on the node's Wi-Fi, or from anywhere once Direct connections is on in the account card";

/** A stream page's path and query: under `/remote/`, and nothing a request line or a URL could be broken with. */
const STREAM_PATH = /^\/remote\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;
const PATH_MAX = 2048;

/** What `host.open` does with what the view handed it: a stream in the dialog, a page or an app outside, or why not. */
export function planOpen(params: unknown, ctx: PlanContext): OpenPlan {
  const p = (params ?? {}) as { url?: unknown; path?: unknown; transport?: unknown; node?: unknown; stream?: unknown };
  const stream = typeof p.stream === "string" && p.stream.length > 0 && p.stream.length <= 64 ? { stream: p.stream } : {};
  const path = typeof p.path === "string" ? p.path : typeof p.url === "string" ? streamPathOf(p.url, ctx.origin) : undefined;
  if (path === undefined) {
    // this origin serves no stream page: only the node's does
    if (typeof p.url === "string" && ownStream(p.url, ctx.origin)) return { kind: "refuse", reason: "that stream page cannot be opened" };
    const target = openTarget(p.url, ctx.origin);
    // the app frames nothing itself: a stream goes through its forwarder, or not at all
    if (target.kind === "frame") return { kind: "refuse", reason: "that stream page cannot be opened" };
    return target;
  }
  if (path.length > PATH_MAX || !STREAM_PATH.test(path) || path.includes("..")) return { kind: "refuse", reason: "that stream page cannot be opened" };
  if (!ctx.canForward) return { kind: "refuse", reason: "this app cannot show the remote desktop" };
  if (p.transport === "webrtc") {
    if (typeof p.node !== "string") return { kind: "refuse", reason: "the stream did not say which node it is on" };
    return { kind: "link", node: p.node, path, ...stream };
  }
  if (ctx.via !== "lan") return { kind: "refuse", reason: AWAY_MESSAGE };
  const node = ctx.credential?.node;
  if (!node?.spki) return { kind: "refuse", reason: "this phone does not know the node's key: pair it again" };
  return { kind: "lan", host: node.host, port: node.port, pin: node.spki, path, ...stream };
}

/** An older node's answer: the stream page's URL on its controller origin, of which only the path is taken. */
/** Whether a URL names a stream page on this app's own origin, which serves none. */
function ownStream(raw: string, origin: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === origin && url.pathname.startsWith("/remote/");
  } catch {
    return false;
  }
}

function streamPathOf(raw: string, origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin === origin || !url.pathname.startsWith("/remote/")) return undefined;
  return url.pathname + url.search;
}

// --- the plugin -----------------------------------------------------------------------------------

export interface StreamClosed {
  stream: string;
  /** `closed` (the user), `pin_mismatch`, `background`, or what failed. */
  reason?: string;
}

type Listener = Promise<{ remove(): Promise<void> }>;

/** What the Kotlin plugin exposes. One stream shows at a time; `open` resolves once the dialog is up. */
export interface CophylaStreamPlugin {
  open(options: { stream: string; path: string } & ({ host: string; port: number; pin: string } | { link: true })): Promise<void>;
  close(options: { stream: string }): Promise<void>;
  addListener(event: "closed", fn: (e: StreamClosed) => void): Listener;
  /** A connection of a link stream wants a pipe. */
  addListener(event: "pipe", fn: (e: { stream: string; conn: string }) => void): Listener;
  /** Bytes the page sent on a connection, within its window. */
  addListener(event: "pipeData", fn: (e: { conn: string; data: string }) => void): Listener;
  /** Bytes the page took from a connection. */
  addListener(event: "written", fn: (e: { conn: string; bytes: number }) => void): Listener;
  /** A connection closed on the phone. */
  addListener(event: "pipeEnd", fn: (e: { conn: string; reason?: string }) => void): Listener;
  /** The pipe is open with this window; `open` is false when the connection went meanwhile. */
  pipeOpened(options: { conn: string; window: number }): Promise<{ open: boolean }>;
  pipeFailed(options: { conn: string }): Promise<void>;
  pipeWrite(options: { conn: string; data: string }): Promise<void>;
  pipeAck(options: { conn: string; bytes: number }): Promise<void>;
  pipeClose(options: { conn: string }): Promise<void>;
}

/** What the pipes need of the link (the core's own pipe calls): an open, a signal, and the node's pipe frames. */
export interface PipeLink {
  open(node: string): Promise<{ pipe: string; window: number }>;
  signal(method: "remote.pipe.data" | "remote.pipe.ack" | "remote.pipe.close", params: unknown): void;
  onPipe(fn: (method: string, params: unknown) => void): () => void;
}

/**
 * A link stream's connections, each a pipe to the node whose desktop it shows: opened on the
 * plugin's `pipe`, the page's bytes signalled up as they come (the plugin keeps to the
 * window), the node's written to the page and acknowledged once the page took them, an end
 * on either side closing the other.
 */
export class PipeBridge {
  private plugin: CophylaStreamPlugin;
  private link: PipeLink;
  private log?: (message: string) => void;
  private node?: string;
  /** Pipes by connection, and back. */
  private pipes = new Map<string, string>();
  private conns = new Map<string, string>();
  private listening?: Promise<unknown>;

  constructor(deps: { plugin: CophylaStreamPlugin; link: PipeLink; log?: (message: string) => void }) {
    this.plugin = deps.plugin;
    this.link = deps.link;
    if (deps.log) this.log = deps.log;
    this.link.onPipe((method, params) => this.fromNode(method, params));
  }

  /** Pipes open now. */
  get count(): number {
    return this.pipes.size;
  }

  /** A link stream to `node` shows: its connections get pipes there. */
  async start(node: string): Promise<void> {
    this.stop();
    this.node = node;
    this.listening ??= Promise.all([
      this.plugin.addListener("pipe", (e) => void this.connection(e.conn)),
      this.plugin.addListener("pipeData", (e) => this.toNode(e.conn, "remote.pipe.data", { data: e.data })),
      this.plugin.addListener("written", (e) => this.toNode(e.conn, "remote.pipe.ack", { bytes: e.bytes })),
      this.plugin.addListener("pipeEnd", (e) => {
        const pipe = this.drop(e.conn);
        if (pipe) this.link.signal("remote.pipe.close", { pipe, reason: e.reason ?? "the page closed it" });
      }),
    ]);
    await this.listening;
  }

  /** The stream closed: every pipe it had closes on the node too. */
  stop(): void {
    for (const pipe of this.pipes.values()) this.link.signal("remote.pipe.close", { pipe, reason: "the stream closed" });
    this.pipes.clear();
    this.conns.clear();
    this.node = undefined;
  }

  private async connection(conn: string): Promise<void> {
    const node = this.node;
    if (node === undefined) {
      void this.plugin.pipeFailed({ conn }).catch(() => undefined);
      return;
    }
    let opened: { pipe: string; window: number };
    try {
      opened = await this.link.open(node);
    } catch (e) {
      this.log?.(`no pipe for the stream: ${e instanceof Error ? e.message : String(e)}`);
      void this.plugin.pipeFailed({ conn }).catch(() => undefined);
      return;
    }
    // the stream closed, or another opened, meanwhile
    if (this.node !== node) {
      this.link.signal("remote.pipe.close", { pipe: opened.pipe, reason: "the stream closed" });
      void this.plugin.pipeFailed({ conn }).catch(() => undefined);
      return;
    }
    this.pipes.set(conn, opened.pipe);
    this.conns.set(opened.pipe, conn);
    const r = await this.plugin.pipeOpened({ conn, window: opened.window }).catch(() => ({ open: false }));
    if (!r.open && this.drop(conn)) this.link.signal("remote.pipe.close", { pipe: opened.pipe, reason: "the page closed it" });
  }

  private toNode(conn: string, method: "remote.pipe.data" | "remote.pipe.ack", extra: { data: string } | { bytes: number }): void {
    const pipe = this.pipes.get(conn);
    if (pipe !== undefined) this.link.signal(method, { pipe, ...extra });
  }

  private fromNode(method: string, params: unknown): void {
    if (method !== "remote.pipe.data" && method !== "remote.pipe.ack" && method !== "remote.pipe.close") return;
    const p = (params ?? {}) as { pipe?: unknown; data?: unknown; bytes?: unknown };
    const conn = typeof p.pipe === "string" ? this.conns.get(p.pipe) : undefined;
    if (conn === undefined) return;
    if (method === "remote.pipe.data" && typeof p.data === "string") void this.plugin.pipeWrite({ conn, data: p.data }).catch(() => undefined);
    else if (method === "remote.pipe.ack" && typeof p.bytes === "number") void this.plugin.pipeAck({ conn, bytes: p.bytes }).catch(() => undefined);
    else if (method === "remote.pipe.close") {
      this.drop(conn);
      void this.plugin.pipeClose({ conn }).catch(() => undefined);
    }
  }

  /** Forgets a connection's pipe; the pipe, when there was one. */
  private drop(conn: string): string | undefined {
    const pipe = this.pipes.get(conn);
    if (pipe === undefined) return undefined;
    this.pipes.delete(conn);
    this.conns.delete(pipe);
    return pipe;
  }
}

export interface StreamsDeps {
  plugin: CophylaStreamPlugin;
  /** A request over the link, for `remote.close`. */
  request: (method: string, params: unknown) => Promise<unknown>;
  /** A stream shows, or no longer does: the microphone and the wake word stand down meanwhile. */
  watching: (on: boolean) => void;
  /** The pipes of a link stream. */
  pipes?: PipeBridge;
  log?: (message: string) => void;
}

let seq = 0;

/** The stream on the screen, if any: opened from a plan, closed by the user, the app, or its failure. */
export class Streams {
  private deps: StreamsDeps;
  private current?: { id: string; node?: string };
  private listening?: Promise<unknown>;

  constructor(deps: StreamsDeps) {
    this.deps = deps;
  }

  get open(): boolean {
    return this.current !== undefined;
  }

  /** Shows a stream, on the LAN or over the link; a stream already up is closed first. */
  async show(plan: Extract<OpenPlan, { kind: "lan" | "link" }>): Promise<void> {
    this.listening ??= this.deps.plugin.addListener("closed", (e) => this.closed(e));
    await this.listening;
    if (this.current) await this.close();
    const id = plan.stream ?? `local_${++seq}`;
    const entry = { id, ...(plan.stream ? { node: plan.stream } : {}) };
    this.current = entry;
    this.deps.watching(true);
    try {
      if (plan.kind === "link") {
        if (!this.deps.pipes) throw new Error("this app cannot carry a stream over the link");
        await this.deps.pipes.start(plan.node);
        await this.deps.plugin.open({ stream: id, path: plan.path, link: true });
      } else {
        await this.deps.plugin.open({ stream: id, host: plan.host, port: plan.port, pin: plan.pin, path: plan.path });
      }
    } catch (e) {
      if (this.current === entry) this.ended(entry);
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(message.includes(PIN_MISMATCH) ? PIN_MISMATCH_MESSAGE : message);
    }
  }

  /** Closes the stream on the screen: the user left the app, or another one opens. */
  async close(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    await this.deps.plugin.close({ stream: entry.id }).catch(() => undefined);
    // the plugin says `closed` too; whichever comes first ends it
    if (this.current === entry) this.ended(entry);
  }

  private closed(e: StreamClosed): void {
    const entry = this.current;
    if (!entry || e.stream !== entry.id) return;
    if (e.reason && e.reason !== "closed") this.deps.log?.(`the remote desktop closed: ${e.reason}`);
    this.ended(entry);
  }

  private ended(entry: { id: string; node?: string }): void {
    this.current = undefined;
    this.deps.pipes?.stop();
    this.deps.watching(false);
    // a node from before `remote.close` ends the session when this phone goes
    if (entry.node) void this.deps.request("remote.close", { stream: entry.node }).catch(() => undefined);
  }
}
