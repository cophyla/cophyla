// Every authenticated client on every listener, in one place. Both the loopback listener and
// the controller listener register here, so a notification reaches a desktop app and a phone
// alike, `voice.audio` and `terminal.output` can be sent to one client by id, and
// `controller.revoke` can close the sockets of the controller it revoked. The socket is kept
// behind a small interface (send, close, and how much it holds unsent), so this module knows
// nothing of Bun's. Two more kinds belong to the node link: a `relay`
// entry is a virtual client on the primary standing for a secondary's client, whose writes
// go down the link and who hears broadcasts like anyone; a `relayed` entry is a real socket
// on a secondary whose frames are tunnelled to the primary, so nothing here is sent to it.
//
// A session's traffic is kept to who looks at it. Each client names the sessions it watches
// (`session.watch`: the tab that is open); a `session.event` goes to those clients alone,
// and a `session.state` goes to everyone only when the session started, ended or changed
// what it is doing, a row that moved only `lastActivity` or `stats` to its watchers alone.
// A `workspace.state` that moved only `lastActivity`, which every event of its sessions does,
// goes to no one.
//
// A session, workspace or thread row leaves for a client without the summary and tags the
// archive writes: they are the brain's. The node link carries them whole. A row that would
// reach a client as it was last sent, since only those moved, is not sent again.
//
// A client whose grant limits it hears a notification only when its access reaches what the
// notification is about (the protocol's filter tables, through `look`), and a sample of a
// node's processes with the sessions out of its reach summed into one row.
//
// Every `voice.*` notification is sent urgent: a socket that queues (a tunnel through the
// server relay) lets it overtake the bulk waiting in front of it.

import { allows, allowsNotification, filterResult, FULL, isLimited, notification, notificationScopes, trimSample } from "@cophyla/protocol";
import type { Access, Client, ClientNotificationName, ClientNotificationParams, ClientRequestName, ClientSession, ClientWorkspace, MetricsSample, Session, SessionEvent, TargetLookup, Thread, Workspace } from "@cophyla/protocol";
import { EMPTY_LOOKUP } from "../grants/lookup.ts";

/** The name the desktop app's shell says `hello` with; it starts cophylad whenever it finds none. */
export const DESKTOP_NAME = "desktop";

/** Which listener a client came in on: the loopback api, the controller listener on the LAN, a relay from a secondary, a socket relayed to the primary, or a tunnel through the server relay. */
/** Where a client came in: this machine, the LAN, a secondary relaying it, the server relay, or a phone's data channel. */
export type ListenerKind = "loopback" | "controller" | "relay" | "relayed" | "cloud" | "p2p";

/** How a frame is sent: `urgent` may overtake the frames queued ahead of it that are not. */
export interface SendOptions {
  urgent?: boolean;
}

export interface ClientSocket {
  send(data: string, opts?: SendOptions): void;
  close(code?: number, reason?: string): void;
  /** Bytes sent and not yet written to the network, where the socket can tell. */
  buffered?(): number;
}

export interface Registered {
  client: Client;
  socket: ClientSocket;
  listener: ListenerKind;
  /** The sessions this client hears every event of. */
  watching: Set<string>;
}

/** A row as a client gets it: without the archive's summary and tags. */
export function clientRow<T extends { summary?: string; tags: string[] }>(row: T): Omit<T, "summary" | "tags"> {
  const { summary: _summary, tags: _tags, ...rest } = row;
  return rest;
}

/** A request's answer as a client gets it: the rows of a list or a chat page through `clientRow`, and, for limited access, without the rows out of its reach. */
export function clientResult(name: ClientRequestName, result: unknown, access: Access = FULL, look: TargetLookup = EMPTY_LOOKUP): unknown {
  const r = result as Record<string, unknown>;
  let out: unknown;
  switch (name) {
    case "session.list":
      out = { ...r, sessions: (r["sessions"] as Session[]).map(clientRow) };
      break;
    case "workspace.list":
      out = { ...r, workspaces: (r["workspaces"] as Workspace[]).map(clientRow) };
      break;
    case "chat.load":
      out = { ...r, threads: (r["threads"] as Thread[]).map(clientRow) };
      break;
    default:
      out = result;
  }
  return filterResult(access, name, out as never, look);
}

/** A notification as limited access hears it, or undefined when it does not: a sample's other sessions are summed away. */
export function forAccess<N extends ClientNotificationName>(access: Access, method: N, params: ClientNotificationParams<N>, look: TargetLookup): ClientNotificationParams<N> | undefined {
  if (!allowsNotification(access, method, params, look)) return undefined;
  if (method === "metrics.sample" && isLimited(access) && (access.workspaces || access.paths)) {
    return trimSample(params as MetricsSample, (session) => allows(access, { session }, look)) as ClientNotificationParams<N>;
  }
  return params;
}

/** A session row as everyone is told of it: the fields that move with every event left out. */
function headline(s: ClientSession): string {
  const { lastActivity: _lastActivity, stats: _stats, ...rest } = s;
  return JSON.stringify(rest);
}

/** Speech and the conversation's state: late is as bad as lost. */
function urgency(method: ClientNotificationName): SendOptions | undefined {
  return method.startsWith("voice.") ? { urgent: true } : undefined;
}

/** A workspace row without its activity. */
function workspaceLine(w: ClientWorkspace): string {
  const { lastActivity: _lastActivity, ...rest } = w;
  return JSON.stringify(rest);
}

/** Rows remembered per kind as last sent: the recent past, where an archive's write lands. */
const SENT_CAP = 512;

/** Remembers `line` as `id`'s, newest last, the oldest dropped past the cap. */
function remember(map: Map<string, string>, id: string, line: string): void {
  map.delete(id);
  map.set(id, line);
  if (map.size > SENT_CAP) map.delete(map.keys().next().value!);
}

export class ClientRegistry {
  private entries = new Map<string, Registered>();
  /** Each live session's row as last told to everyone, to tell a change of what it is doing from one of its counters. */
  private told = new Map<string, string>();
  /** Each recent session's row as last sent to anyone, whole. */
  private sentSessions = new Map<string, string>();
  /** Each workspace's row as last told, without its activity. */
  private toldWorkspaces = new Map<string, string>();
  /** Each recent thread's row as last told. */
  private toldThreads = new Map<string, string>();

  add(client: Client, socket: ClientSocket, listener: ListenerKind): void {
    this.entries.set(client.id, { client, socket, listener, watching: new Set() });
  }

  /** The sessions a client watches from now on, replacing the ones before; empty stops them. */
  watch(id: string, sessions: string[]): void {
    const entry = this.entries.get(id);
    if (entry) entry.watching = new Set(sessions);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  get(id: string): Registered | undefined {
    return this.entries.get(id);
  }

  list(): Client[] {
    return [...this.entries.values()].map((e) => e.client);
  }

  /** A desktop app on this machine is attached: the shell's `ui` client on the loopback listener. */
  desktopAttached(): boolean {
    for (const e of this.entries.values()) if (e.listener === "loopback" && e.client.kind === "ui" && e.client.name === DESKTOP_NAME) return true;
    return false;
  }

  /** The clients that authenticated here with a phone's grant, on the LAN listener or a relay tunnel of this node. */
  withGrants(): Registered[] {
    return [...this.entries.values()].filter((e) => e.client.controller !== undefined && (e.listener === "controller" || e.listener === "cloud"));
  }

  /** The clients that authenticated as one paired controller; a phone may hold two sockets. */
  byController(controller: string): Registered[] {
    return [...this.entries.values()].filter((e) => e.client.controller === controller);
  }

  /** How a notification's targets are looked up for limited clients: the daemon's, once its modules are up. */
  look: TargetLookup = EMPTY_LOOKUP;

  /** The frame a client gets for a notification: none without the scope (a scope-less one is the client's own) or past its access. */
  private frameFor<N extends ClientNotificationName>(entry: Registered, method: N, params: ClientNotificationParams<N>, whole: () => string): string | undefined {
    const needs = notificationScopes[method];
    if (needs !== null && !entry.client.scopes.includes(needs)) return undefined;
    const access = entry.client.access;
    if (!access || !isLimited(access)) return whole();
    const shaped = forAccess(access, method, params, this.look);
    if (shaped === undefined) return undefined;
    return shaped === params ? whole() : JSON.stringify(notification(method, shaped));
  }

  /** Sends one notification to one client, when it is connected and holds the scope, and its access reaches what it is about. */
  send<N extends ClientNotificationName>(id: string, method: N, params: ClientNotificationParams<N>): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.listener === "relayed") return true;
    const frame = this.frameFor(entry, method, params, () => JSON.stringify(notification(method, params)));
    if (frame === undefined) return false;
    entry.socket.send(frame, urgency(method));
    return true;
  }

  /**
   * Sends one notification to one client even when its socket is relayed to the primary: for
   * what this node answers itself on such a socket (a data channel's candidates, a pipe's
   * bytes), which the primary never sees.
   */
  sendLocal<N extends ClientNotificationName>(id: string, method: N, params: ClientNotificationParams<N>): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const frame = this.frameFor(entry, method, params, () => JSON.stringify(notification(method, params)));
    if (frame === undefined) return false;
    entry.socket.send(frame, urgency(method));
    return true;
  }

  /** Sends one notification to every client that holds its scope and reaches it; the frame is built once. A scope-less one is never broadcast. */
  broadcast<N extends ClientNotificationName>(method: N, params: ClientNotificationParams<N>): void {
    this.broadcastTo(method, params, () => true);
  }

  /** A session event, to the clients watching its session. */
  broadcastEvent(event: SessionEvent): void {
    this.broadcastTo("session.event", event, (entry) => entry.watching.has(event.session));
  }

  /** A session's row: to everyone when what it is doing changed, else to its watchers alone. */
  broadcastSession(session: Session): void {
    const row = clientRow(session);
    const whole = JSON.stringify(row);
    if (this.sentSessions.get(session.id) === whole) return;
    remember(this.sentSessions, session.id, whole);
    const line = headline(row);
    const changed = this.told.get(session.id) !== line;
    if (session.status === "ended") this.told.delete(session.id);
    else if (changed) this.told.set(session.id, line);
    this.broadcastTo("session.state", row, changed ? () => true : (entry) => entry.watching.has(session.id));
  }

  /** A workspace's row, to everyone unless only its activity (or what a client never sees) moved. */
  broadcastWorkspace(workspace: Workspace): void {
    const row = clientRow(workspace);
    const line = workspaceLine(row);
    if (this.toldWorkspaces.get(workspace.id) === line) return;
    this.toldWorkspaces.set(workspace.id, line);
    this.broadcastTo("workspace.state", row, () => true);
  }

  /** A thread's row, to every client with `chat` unless nothing a client sees moved. */
  broadcastThread(thread: Thread): void {
    const row = clientRow(thread);
    const line = JSON.stringify(row);
    if (this.toldThreads.get(thread.id) === line) return;
    remember(this.toldThreads, thread.id, line);
    this.broadcastTo("thread.state", row, () => true);
  }

  private broadcastTo<N extends ClientNotificationName>(method: N, params: ClientNotificationParams<N>, who: (entry: Registered) => boolean): void {
    // a scope-less notification is one client's own, never broadcast
    if (notificationScopes[method] === null) return;
    let frame: string | undefined;
    const whole = () => (frame ??= JSON.stringify(notification(method, params)));
    const opts = urgency(method);
    for (const entry of this.entries.values()) {
      if (entry.listener === "relayed" || !who(entry)) continue;
      const out = this.frameFor(entry, method, params, whole);
      if (out !== undefined) entry.socket.send(out, opts);
    }
  }

  close(id: string, code: number, reason: string): void {
    this.entries.get(id)?.socket.close(code, reason);
  }

  /** Closes every socket on one listener, or all of them. */
  closeAll(code: number, reason: string, listener?: ListenerKind): void {
    for (const entry of [...this.entries.values()]) {
      if (listener && entry.listener !== listener) continue;
      entry.socket.close(code, reason);
      this.entries.delete(entry.client.id);
    }
  }

  /** Closes the sockets on the listeners named: what a role change does to the clients that must reconnect. */
  closeOn(code: number, reason: string, listeners: ListenerKind[]): number {
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (!listeners.includes(entry.listener)) continue;
      entry.socket.close(code, reason);
      this.entries.delete(entry.client.id);
      n++;
    }
    return n;
  }
}
