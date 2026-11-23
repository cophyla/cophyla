// A machine's web pages in Devices, as the view keeps them: what listens on each machine
// (`ports.list`, asked as Devices opens and on Refresh), the ports this client opened
// (`port.state`, which the node sends this client alone, whole each time), and what a machine's
// Web pages block shows of both. A port opens only where the bytes go straight between the two
// machines; the node says why not when they cannot, and the block says it as it was said. Kept
// apart from model.ts, which folds these in through `applyPorts`.

import type { ListeningPort, Node, NodeId, PortForward, PortRoute } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";

/** What listens on a machine, as last asked: the ports once answered, while it is asked, or why it could not be read. */
export interface PortListing {
  ports?: ListeningPort[];
  loading: boolean;
  error?: string;
}

/** Folds a ports action in; false when the action is none of them. */
export function applyPorts(state: ViewState, action: Action): boolean {
  switch (action.type) {
    case "ports.loading": {
      const was = state.portLists.get(action.node);
      state.portLists.set(action.node, { ...(was?.ports ? { ports: was.ports } : {}), loading: true });
      return true;
    }
    case "ports":
      // a failed ask keeps what was listed before, with why this one did not come
      if (action.ports) state.portLists.set(action.node, { ports: action.ports, loading: false });
      else {
        const was = state.portLists.get(action.node);
        state.portLists.set(action.node, { ...(was?.ports ? { ports: was.ports } : {}), loading: false, ...(action.error !== undefined ? { error: action.error } : {}) });
      }
      return true;
    case "port.state":
      state.forwards = new Map(action.params.forwards.map((f) => [f.id, f]));
      return true;
    default:
      return false;
  }
}

/** The blocks' part of the view's own state: what is on its way, and why the last Open of a machine's did not go. */
export interface PortsUi {
  /** Ports whose Open is on its way, by `<node>:<port>` (`openingKey`). */
  opening: Set<string>;
  /** Open ports whose Close is on its way, by id. */
  closing: Set<string>;
  /** Why the last Open did not go, by machine. */
  errors: Map<NodeId, string>;
}

export function newPortsUi(): PortsUi {
  return { opening: new Set(), closing: new Set(), errors: new Map() };
}

/** The key a port's Open waits under. */
export const openingKey = (node: string, port: number): string => `${node}:${port}`;

/** A machine's Web pages block: what listens there, what this client has open of it, and what else there is to say. */
export interface PortsCard {
  node: NodeId;
  name: string;
  /** What listens there, by port. */
  listening: ListenRow[];
  /** Asking what listens now. */
  loading: boolean;
  /** Asked and answered: nothing listens there that can be opened. */
  none: boolean;
  /** Why what listens could not be read. */
  error?: string;
  /** What this client has open of the machine's, the first opened first. */
  open: ForwardRow[];
  /** Under them, while one is open on this computer: who else can use it, and for how long. */
  note?: string;
}

/** One port that listens on a machine: its number, the program, and whether this client has it open. */
export interface ListenRow {
  key: string;
  port: number;
  program: string;
  title: string;
  open: boolean;
}

/** One port this client has open: where it is reached here, how its bytes go, and what does not work when its number was taken. */
export interface ForwardRow {
  key: string;
  id: string;
  port: number;
  /** `localhost:3000`, as it is on the machine. */
  address: string;
  words: string;
  /** The port was taken here, so it opened on another: what that breaks. */
  note?: string;
  /** The page, where this client opens it in a browser of this computer. */
  url?: string;
  title: string;
}

/** What the block says under the open ports, while one is reached on this computer's loopback. */
export const PORTS_NOTE = "Any program on this computer can use an open page while it is open. It closes 2 minutes after it was last used.";

/** How an open port's bytes go, in words. */
export function routeWords(route: PortRoute): string {
  switch (route) {
    case "here":
      return "on this machine";
    case "lan":
      return "on this network";
    case "direct":
      return "direct";
  }
}

/** How many connections a port has open now, in words. */
export function connectionsWords(n: number): string {
  return n === 0 ? "no connections" : n === 1 ? "1 connection" : `${n} connections`;
}

/** Which addresses a port listens on, in words. */
function familyWords(p: ListeningPort): string {
  return p.v4 && p.v6 ? "IPv4 and IPv6" : p.v6 ? "IPv6" : "IPv4";
}

/**
 * A machine's Web pages block, or undefined where there is none: without the `remote` scope,
 * for a machine that is not online, lends some folders alone, is lent as hands, is at its
 * sign-in screen or runs a Cophyla older than ports, or when the node this view talks to is
 * older. The desktop app opens no page of the machine it runs on (it is that machine's own
 * localhost), and a browser on a computer has no forwarder to open one through.
 */
export function selectPorts(state: ViewState, node: Node): PortsCard | undefined {
  if (!state.scopes.includes("remote") || node.status !== "online") return undefined;
  if (node.scope.kind !== "machine" || node.hands === true || node.door !== undefined || node.capabilities.ports !== true) return undefined;
  const client = state.client;
  if (client?.kind === "ui" && client.node === node.id) return undefined;
  if (state.hostDesk) return undefined;
  // the node the view's socket is on answers `port.open`: one older than ports cannot
  const here = state.node !== undefined ? state.nodes.get(state.node) : undefined;
  if (here && here.capabilities.ports !== true) return undefined;
  const forwards = [...state.forwards.values()].filter((f) => f.node === node.id).sort((a, b) => a.since - b.since);
  const openPorts = new Set(forwards.map((f) => f.port));
  const listing = state.portLists.get(node.id);
  const ports = [...(listing?.ports ?? [])].sort((a, b) => a.port - b.port);
  const listening = ports.map((p): ListenRow => ({
    key: String(p.port),
    port: p.port,
    program: p.process ?? "",
    title: `${p.port} · ${familyWords(p)} · ${p.process ?? "the program is not known"}`,
    open: openPorts.has(p.port),
  }));
  const open = forwards.map((f) => forwardRow(f, node.name));
  const local = forwards.some((f) => f.local !== undefined);
  return {
    node: node.id,
    name: node.name,
    listening,
    loading: listing?.loading === true,
    none: listing?.ports !== undefined && ports.length === 0,
    ...(listing?.error !== undefined ? { error: listing.error } : {}),
    open,
    ...(local ? { note: PORTS_NOTE } : {}),
  };
}

/** One open port as its row says it: `open here at localhost:3000 · on this network · 2 connections`. */
function forwardRow(f: PortForward, machine: string): ForwardRow {
  const where = f.local !== undefined ? `open here at localhost:${f.local}` : f.route === "here" ? "open on this machine" : "open on this phone";
  const moved = f.local !== undefined && f.local !== f.port;
  return {
    key: f.id,
    id: f.id,
    port: f.port,
    address: `localhost:${f.port}`,
    words: [where, routeWords(f.route), connectionsWords(f.connections)].join(" · "),
    ...(moved ? { note: `${f.port} is taken on this computer: links, redirects and logins that name :${f.port} will not work.` } : {}),
    ...(f.url !== undefined ? { url: f.url } : {}),
    title: `${machine}'s localhost:${f.port}`,
  };
}

/** A port typed into the block: a whole number from 1 to 65535, else none. */
export function portNumber(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/** What `port.open` answers, as far as the view reads it. */
export interface PortOpened {
  id: string;
  node: string;
  port: number;
  url?: string;
  share?: string;
}

/** What the view does with `port.open`'s answer: the phone app shows the page itself, the desktop app's browser opens it, or nothing. */
export type PortOpenStep = { kind: "host.open"; params: { port: { id: string; node: string; port: number; share: string; name: string } } } | { kind: "link"; url: string } | { kind: "none" };

/** The next step after `port.open`: a share for the phone's own forwarder, else the page's address for the browser here. */
export function portOpenStep(r: PortOpened, name: string): PortOpenStep {
  if (r.share !== undefined) return { kind: "host.open", params: { port: { id: r.id, node: r.node, port: r.port, share: r.share, name } } };
  if (r.url !== undefined) return { kind: "link", url: r.url };
  return { kind: "none" };
}
