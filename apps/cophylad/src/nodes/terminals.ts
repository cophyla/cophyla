// Terminals across the links. A node's terminals are its own, tether runs them there, and a
// client of the primary sees every node's: each node sends its rows up (`terminal.state`, its
// list with the join), and the primary forwards what a client asks of one (open it, close it,
// read a file under its folder, start a shell there, list a folder for the picker) to the node
// it is on. A terminal a client of the primary opened on a node is viewed there as
// `link:<client>`: its output goes up the link as `terminal.output` frames that name the
// client, and the primary hands each to that client alone; the keys it types and the size it
// drives go down as `terminal.input` and `terminal.resize`. A client that falls behind is sent
// nothing until it drained, then a fresh repaint, which the primary asks of the node by opening
// the terminal for it again. A client that goes takes its views with it (`terminal.drop`), and
// so does the link: the primary forgets the node's views, the node drops every `link:` viewer.
// A node that shares some folders alone (confine.ts) sends no terminal up and serves none: a
// shell reaches past any folder.

import { RpcError } from "@cophyla/protocol";
import type { Ask, ClientNotificationParams, ClientParams, ClientResult, FolderPick, TerminalSize } from "@cophyla/protocol";
import type { ClientRegistry } from "../api/clients.ts";
import type { Logger } from "../log.ts";
import type { SessionFiles } from "../sessions/files.ts";
import type { TerminalRows, TerminalStreams } from "../sessions/tether/streams.ts";
import { BEHIND_AT, CAUGHT_UP_AT } from "../sessions/tether/streams.ts";

/** The viewer id a client of the primary has on a node: `link:<client>`. */
export const LINK_VIEWER = "link:";

export function linkViewer(client: string): string {
  return `${LINK_VIEWER}${client}`;
}

/** A node's terminals as its link serves them: the rows, the screens, the files under a terminal's folder, the picker's folders. */
export interface NodeTerminals {
  rows: Pick<TerminalRows, "list" | "spawn">;
  streams: Pick<TerminalStreams, "open" | "close" | "input" | "resize" | "dropClient" | "dropViewers">;
  files?: Pick<SessionFiles, "readUnder">;
  folders: (path: string | undefined) => Promise<FolderPick>;
}

type Output = ClientNotificationParams<"terminal.output">;
const DRAIN_POLL_MS = 100;

/** One terminal a client of the primary has open on a node. */
interface View {
  node: string;
  input: boolean;
  /** The size it drives the terminal at, the last it said: what a repaint opens it with again. */
  drive?: TerminalSize;
  /** Nothing is sent while the client drains; then it is opened again, for a repaint. */
  behind?: ReturnType<typeof setInterval>;
  /** Opened again for a repaint: what the node sends before the answer is the old view's. */
  reopening?: boolean;
}

export interface TerminalViewsDeps {
  clients: Pick<ClientRegistry, "get" | "send">;
  forward: (node: string, method: string, params: unknown, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void }) => Promise<unknown>;
  notify: (node: string, method: string, params: unknown) => boolean;
  log: Logger;
}

/** The primary's side: which terminal of which node each client has open. */
export class TerminalViews {
  private deps: TerminalViewsDeps;
  /** client → terminal → its view. */
  private views = new Map<string, Map<string, View>>();

  constructor(deps: TerminalViewsDeps) {
    this.deps = deps;
  }

  /**
   * Opens a node's terminal for a client. The view is kept before the request goes, since the
   * output that follows the answer may come right behind it, and dropped when the open fails.
   */
  async open(client: string, node: string, p: ClientParams<"terminal.open">, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void } = {}): Promise<ClientResult<"terminal.open">> {
    const view: View = { node, input: p.input === true || p.drive !== undefined, ...(p.drive ? { drive: p.drive } : {}) };
    this.forget(client, p.terminal);
    this.put(client, p.terminal, view);
    try {
      return (await this.deps.forward(node, "terminal.open", { ...p, client }, opts)) as ClientResult<"terminal.open">;
    } catch (e) {
      if (this.views.get(client)?.get(p.terminal) === view) this.forget(client, p.terminal);
      throw e;
    }
  }

  /** Stops a client's view of a node's terminal, and ends its program with `end`. */
  async close(client: string, node: string, p: ClientParams<"terminal.close">, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void } = {}): Promise<ClientResult<"terminal.close">> {
    this.forget(client, p.terminal);
    return (await this.deps.forward(node, "terminal.close", { ...p, client }, opts)) as ClientResult<"terminal.close">;
  }

  /** Keys from a client, for a terminal of another node it opened to type into: true when they went there. */
  input(client: string, terminal: string, data: string): boolean {
    const v = this.views.get(client)?.get(terminal);
    if (!v) return false;
    if (v.input) this.deps.notify(v.node, "terminal.input", { client, terminal, data });
    return true;
  }

  /** The size of a client driving a terminal of another node: true when it went there. */
  resize(client: string, terminal: string, size: TerminalSize): boolean {
    const v = this.views.get(client)?.get(terminal);
    if (!v) return false;
    if (v.drive) {
      v.drive = size;
      this.deps.notify(v.node, "terminal.resize", { client, terminal, cols: size.cols, rows: size.rows });
    }
    return true;
  }

  /** Output a node sent for one of the primary's clients: to that client alone, when it has that terminal open there. */
  output(node: string, frame: Output & { client: string }): void {
    const { client, ...out } = frame;
    const v = this.views.get(client)?.get(out.terminal);
    if (!v || v.node !== node) return;
    if (v.behind || v.reopening) return;
    if ((this.deps.clients.get(client)?.socket.buffered?.() ?? 0) > BEHIND_AT) return this.fallBehind(client, out.terminal, v);
    if (!this.deps.clients.send(client, "terminal.output", out)) this.drop(client);
  }

  /** A client went: every terminal of another node it had open goes, and each node hears it once. */
  drop(client: string): void {
    const m = this.views.get(client);
    if (!m) return;
    this.views.delete(client);
    const nodes = new Set<string>();
    for (const v of m.values()) {
      clearInterval(v.behind);
      nodes.add(v.node);
    }
    for (const node of nodes) this.deps.notify(node, "terminal.drop", { client });
  }

  /** A node's link went: the views of its terminals go, unsaid. */
  nodeGone(node: string): void {
    for (const [client, m] of [...this.views]) {
      for (const [terminal, v] of [...m]) {
        if (v.node !== node) continue;
        clearInterval(v.behind);
        m.delete(terminal);
      }
      if (m.size === 0) this.views.delete(client);
    }
  }

  private put(client: string, terminal: string, v: View): void {
    let m = this.views.get(client);
    if (!m) this.views.set(client, (m = new Map()));
    m.set(terminal, v);
  }

  private forget(client: string, terminal: string): void {
    const m = this.views.get(client);
    const v = m?.get(terminal);
    if (!m || !v) return;
    clearInterval(v.behind);
    m.delete(terminal);
    if (m.size === 0) this.views.delete(client);
  }

  /** The client's socket holds too much: nothing more until it drained, then a repaint in place of what it missed. */
  private fallBehind(client: string, terminal: string, v: View): void {
    this.deps.log.info("terminal viewer of another node fell behind; it gets a repaint once it drained", { client, terminal, node: v.node });
    v.behind = setInterval(() => {
      if (this.views.get(client)?.get(terminal) !== v) return clearInterval(v.behind);
      if ((this.deps.clients.get(client)?.socket.buffered?.() ?? 0) > CAUGHT_UP_AT) return;
      clearInterval(v.behind);
      v.behind = undefined;
      void this.repaint(client, terminal, v);
    }, DRAIN_POLL_MS);
  }

  /** Opens the terminal for the client again: the answer is its repaint, sent as a reset. */
  private async repaint(client: string, terminal: string, v: View): Promise<void> {
    v.reopening = true;
    let r: ClientResult<"terminal.open">;
    try {
      r = (await this.deps.forward(v.node, "terminal.open", { terminal, client, ...(v.input && !v.drive ? { input: true } : {}), ...(v.drive ? { drive: v.drive } : {}) }, {})) as ClientResult<"terminal.open">;
    } catch (e) {
      this.deps.log.debug("terminal repaint from another node failed", { client, terminal, node: v.node, error: e instanceof Error ? e.message : String(e) });
      if (this.views.get(client)?.get(terminal) === v) this.forget(client, terminal);
      return;
    }
    if (this.views.get(client)?.get(terminal) !== v) return;
    v.reopening = false;
    if (!this.deps.clients.send(client, "terminal.output", { terminal, seq: r.seq, data: r.data, reset: true, cols: r.cols, rows: r.rows })) this.drop(client);
  }
}

/** Why a node serves the primary none of its terminals, or undefined when it serves them. */
export function terminalsRefused(n: NodeTerminals | undefined, confined: boolean): RpcError | undefined {
  if (!n) return new RpcError("unsupported", "this node runs no terminals");
  if (confined) return new RpcError("denied", "this node shares folders alone, not its terminals");
  return undefined;
}
