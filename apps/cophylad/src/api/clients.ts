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
//
// A phone is held for its return (`HOLD_MS`). Out of sight (`client.away`) on its open
// socket, or with its socket closed (`park`), it is sent nothing: what it would be sent is
// kept in order, its machines' samples folded into one each (the latest reading, what the
// profiles spent summed), speech and the words heard dropped, and its terminals read it as a
// socket too full to take more, so a terminal stream stops and repaints it once it is back.
// Held, it is nobody's audience: the presence that picks who hears speech, who looks at a
// session and whether a phone is there to be pushed to pass it over. Back on that socket, or
// taken up by a hello on another (`resume`), it is sent what was kept. One held past its time,
// or kept more than `HOLD_MAX_BYTES`, is let go as a close lets a client go, and its next hello
// begins it again.

import { allows, allowsNotification, filterResult, FULL, isLimited, notification, notificationScopes, trimSample } from "@cophyla/protocol";
import type { Access, Client, ClientNotificationName, ClientNotificationParams, ClientRequestName, ClientSession, ClientWorkspace, MetricsSample, Session, SessionEvent, TargetLookup, Thread, Workspace } from "@cophyla/protocol";
import { EMPTY_LOOKUP } from "../grants/lookup.ts";
import { addLlm, addProfiles } from "../metrics/delivery.ts";
import type { LlmCounts, ProfileCounts } from "../metrics/sampler.ts";

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
  /** The connection that carries it, as its listener knows it: none while its socket is gone. */
  owner?: object;
  /** Held for its return: out of sight, or its socket gone. */
  hold?: Hold;
}

/** How long a client is held for its return, from when it went out of sight or its socket closed. */
export const HOLD_MS = 10 * 60_000;
/** What a held client may be kept before it is let go, to begin again when it is back. */
export const HOLD_MAX_BYTES = 4 * 1024 * 1024;
export const HOLD_MAX_FRAMES = 5000;
/** The code a held client's open socket is closed with when it is let go. */
export const CLOSE_HOLD_ENDED = 4411;
/** Not kept for a held client: speech and the words heard are nothing late. */
const NOT_HELD: ReadonlySet<string> = new Set(["voice.audio", "voice.partial"]);
/** What a held client's socket says it has queued: more than any stream sends into. */
const HELD_BACKLOG = Number.MAX_SAFE_INTEGER;

interface Hold {
  why: "away" | "parked";
  frames: string[];
  bytes: number;
  /** Where each machine's sample sits in `frames`: later ones fold into it. */
  samples: Map<string, number>;
  /** The open socket a client away still has. */
  live?: ClientSocket;
  timer?: ReturnType<typeof setTimeout>;
}

/** What holding a client does beyond what is sent: the daemon's modules, told. */
export interface HoldDeps {
  /** Out of sight on its open socket: its conversation ends, and what it types stops. */
  away(client: Client): void;
  /** Its socket closed while it is held: what lives with a socket goes (streams, pipes, voice). */
  parked(client: Client): void;
  /** Let go for good, its socket gone: everything of it goes, as on a close (`parked` already ran when it was). */
  gone(client: Client, parked: boolean): void;
  holdMs?: number;
  maxBytes?: number;
  maxFrames?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
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
    case "chat.history":
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
  private holds?: HoldDeps;
  /** Connections whose client was let go while away: their close has nothing left to end. */
  private ended = new WeakSet<object>();
  /** Each live session's row as last told to everyone, to tell a change of what it is doing from one of its counters. */
  private told = new Map<string, string>();
  /** Each recent session's row as last sent to anyone, whole. */
  private sentSessions = new Map<string, string>();
  /** Each workspace's row as last told, without its activity. */
  private toldWorkspaces = new Map<string, string>();
  /** Each recent thread's row as last told. */
  private toldThreads = new Map<string, string>();

  add(client: Client, socket: ClientSocket, listener: ListenerKind, owner?: object): void {
    const was = this.entries.get(client.id);
    if (was?.hold?.timer) clearTimeout(was.hold.timer);
    this.entries.set(client.id, { client, socket, listener, watching: new Set(), ...(owner ? { owner } : {}) });
  }

  /** Clients may be held for their return from now on; without this, every close ends one. */
  enableHolds(deps: HoldDeps): void {
    this.holds = deps;
  }

  /** Whether a client is held: out of sight, or its socket gone. */
  held(id: string): "away" | "parked" | undefined {
    return this.entries.get(id)?.hold?.why;
  }

  /** The daemon stopping: every held client goes with no word, its timer with it. */
  forgetHeld(): void {
    for (const entry of [...this.entries.values()]) {
      if (!entry.hold) continue;
      if (entry.hold.timer) clearTimeout(entry.hold.timer);
      this.entries.delete(entry.client.id);
    }
  }

  /** Whether this connection's client was let go while away, so its close ends nothing more. */
  endedOn(owner: object): boolean {
    return this.ended.has(owner);
  }

  /** `client.away {away: true}`: what the client would be sent is held from now on. False when holds are off or it is not here. */
  goAway(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !this.holds) return false;
    if (entry.hold) return true;
    const hold = this.startHold(entry, "away");
    hold.live = entry.socket;
    entry.socket = this.heldSocket(entry.client.id, entry.socket);
    this.holds.away(entry.client);
    return true;
  }

  /** `client.away {away: false}`: back on the socket it went away on, it is sent what was held, in order. */
  comeBack(id: string): boolean {
    const entry = this.entries.get(id);
    const hold = entry?.hold;
    if (!entry || !hold || hold.why !== "away" || !hold.live) return false;
    const live = hold.live;
    const frames = this.endHold(entry);
    entry.socket = live;
    for (const f of frames) live.send(f);
    return true;
  }

  /**
   * A client's socket closed and it may come back: held, with what it would be sent, until a
   * hello takes it up or its time runs out. False when this connection no longer carries it.
   */
  park(id: string, owner: object): boolean {
    const entry = this.entries.get(id);
    if (!entry || !this.holds || entry.owner !== owner) return false;
    const hold = entry.hold ?? this.startHold(entry, "parked");
    hold.why = "parked";
    delete hold.live;
    delete entry.owner;
    entry.socket = this.heldSocket(entry.client.id);
    this.holds.parked(entry.client);
    return true;
  }

  /**
   * A hello naming a client to take up again, on a new connection: the same phone's, of the
   * same kind, here and not relayed. Its socket, listener and connection become the new one's;
   * what was held for it comes back to be sent after the answer. A client still live on another
   * connection (a phone moving between ways to the node) moves with nothing held; one away on a
   * socket that never came back hands that socket over to be closed.
   */
  resume(id: string, who: { controller: string; kind: Client["kind"] }, socket: ClientSocket, listener: ListenerKind, owner: object): { entry: Registered; frames: string[]; stale?: ClientSocket } | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.client.controller !== who.controller || entry.client.kind !== who.kind) return undefined;
    if (entry.listener === "relayed" || entry.listener === "relay") return undefined;
    const stale = entry.hold?.why === "away" ? entry.hold.live : undefined;
    const frames = entry.hold ? this.endHold(entry) : [];
    entry.socket = socket;
    entry.listener = listener;
    entry.owner = owner;
    return { entry, frames, ...(stale ? { stale } : {}) };
  }

  private startHold(entry: Registered, why: Hold["why"]): Hold {
    const hold: Hold = { why, frames: [], bytes: 0, samples: new Map() };
    entry.hold = hold;
    hold.timer = setTimeout(() => {
      if (this.entries.get(entry.client.id) === entry && entry.hold === hold) this.letGo(entry, "held past its time");
    }, this.holds?.holdMs ?? HOLD_MS);
    (hold.timer as { unref?: () => void }).unref?.();
    return hold;
  }

  /** The hold is over: its timer stopped, and what it kept handed back. */
  private endHold(entry: Registered): string[] {
    const hold = entry.hold;
    if (!hold) return [];
    if (hold.timer) clearTimeout(hold.timer);
    delete entry.hold;
    return hold.frames;
  }

  /** A held client's socket: what is sent to it straight is kept like the rest; full to the streams; closing it ends the hold. */
  private heldSocket(id: string, live?: ClientSocket): ClientSocket {
    return {
      send: (data) => {
        const entry = this.entries.get(id);
        if (entry?.hold) this.keep(entry, "", data);
      },
      close: (code, reason) => {
        if (live) {
          live.close(code, reason);
          return;
        }
        const entry = this.entries.get(id);
        if (entry?.hold?.why === "parked") this.letGo(entry, reason ?? "closed");
      },
      buffered: () => HELD_BACKLOG,
    };
  }

  /** What a held client would have been sent, kept in order; past what is kept, it is let go. */
  private keep(entry: Registered, method: string, frame: string): void {
    const hold = entry.hold!;
    if (NOT_HELD.has(method)) return;
    if (method === "metrics.sample" && this.fold(hold, frame)) return;
    hold.frames.push(frame);
    hold.bytes += frame.length;
    if (hold.bytes > (this.holds?.maxBytes ?? HOLD_MAX_BYTES) || hold.frames.length > (this.holds?.maxFrames ?? HOLD_MAX_FRAMES)) {
      hold.frames = [];
      hold.bytes = 0;
      this.letGo(entry, "held more than is kept");
    }
  }

  /** A machine's sample folded into the one kept for it: the latest reading, the tokens and spend since the first summed, as a slow feed folds them. True when it was. */
  private fold(hold: Hold, frame: string): boolean {
    let sample: MetricsSample;
    try {
      sample = (JSON.parse(frame) as { params: MetricsSample }).params;
    } catch {
      return false;
    }
    if (typeof sample?.node !== "string") return false;
    const at = hold.samples.get(sample.node);
    if (at === undefined) {
      hold.samples.set(sample.node, hold.frames.length);
      return false;
    }
    const before = hold.frames[at]!;
    const prior = (JSON.parse(before) as { params: MetricsSample }).params;
    const llm: LlmCounts = {};
    addLlm(llm, prior.llm ?? {});
    addLlm(llm, sample.llm ?? {});
    const profiles: ProfileCounts = {};
    addProfiles(profiles, prior.profiles);
    addProfiles(profiles, sample.profiles);
    const folded: MetricsSample = { ...sample, llm };
    if (Object.keys(profiles).length > 0) folded.profiles = profiles;
    else delete folded.profiles;
    const merged = JSON.stringify(notification("metrics.sample", folded));
    hold.frames[at] = merged;
    hold.bytes += merged.length - before.length;
    return true;
  }

  /** A held client goes for good: one away has its socket closed, whose close ends it; one parked ends here. */
  private letGo(entry: Registered, why: string): void {
    const hold = entry.hold;
    if (hold?.timer) clearTimeout(hold.timer);
    this.holds?.log?.("held client let go", { client: entry.client.id, why, held: hold?.why });
    if (hold?.why === "away" && hold.live) {
      const live = hold.live;
      // nothing more is kept for it while its close is on the way
      hold.frames = [];
      this.entries.delete(entry.client.id);
      if (entry.owner) this.ended.add(entry.owner);
      this.holds?.gone(entry.client, false);
      live.close(CLOSE_HOLD_ENDED, why);
      return;
    }
    this.entries.delete(entry.client.id);
    this.holds?.gone(entry.client, true);
  }

  /** The sessions a client watches from now on, replacing the ones before; empty stops them. */
  watch(id: string, sessions: string[]): void {
    const entry = this.entries.get(id);
    if (entry) entry.watching = new Set(sessions);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.hold?.timer) clearTimeout(entry.hold.timer);
    this.entries.delete(id);
  }

  get(id: string): Registered | undefined {
    return this.entries.get(id);
  }

  /** The clients that are here: a held one is not. */
  list(): Client[] {
    return [...this.entries.values()].filter((e) => !e.hold).map((e) => e.client);
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

  /** The clients that authenticated as one paired controller and are here; a phone may hold two sockets. `held` counts the held ones too. */
  byController(controller: string, opts: { held?: boolean } = {}): Registered[] {
    return [...this.entries.values()].filter((e) => e.client.controller === controller && (opts.held === true || !e.hold));
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
    this.deliver(entry, method, frame, urgency(method));
    return true;
  }

  /** A frame on its way to one client: kept while it is held, sent otherwise. */
  private deliver(entry: Registered, method: string, frame: string, opts: SendOptions | undefined): void {
    if (entry.hold) this.keep(entry, method, frame);
    else entry.socket.send(frame, opts);
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
    this.deliver(entry, method, frame, urgency(method));
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

  /** A message in a session's conversation with other agents, to the clients watching that session; its count goes to everyone (`talk.state`). */
  broadcastTalk(said: ClientNotificationParams<"talk.said">): void {
    this.broadcastTo("talk.said", said, (entry) => entry.watching.has(said.message.session));
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
      if (out !== undefined) this.deliver(entry, method, out, opts);
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
      this.remove(entry.client.id);
    }
  }

  /** Closes the sockets on the listeners named: what a role change does to the clients that must reconnect. */
  closeOn(code: number, reason: string, listeners: ListenerKind[]): number {
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (!listeners.includes(entry.listener)) continue;
      entry.socket.close(code, reason);
      this.remove(entry.client.id);
      n++;
    }
    return n;
  }
}
