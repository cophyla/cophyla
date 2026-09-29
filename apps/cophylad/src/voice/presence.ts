// Where the user is, for where a reply is read out. A reply is read on a device, not on one
// connection: a machine's desktop app (`desktop@<node>`), a paired phone (`phone:<grant>`,
// however many sockets it holds), or any other client on its own (`client:<id>`).
//
// Per device, the node keeps when the user last acted in the app: a request of the kind a
// person makes (sending, typing, pressing the talk button, answering, opening a terminal, ...,
// counted where requests come in, so an old app counts too) or a view saying it saw input
// (`voice.presence {active}`). Per client, what the app says of its window: visible, focused,
// and whether its speaker is on. On the primary's own Windows machine the window in front is
// also asked of the system (`foreground.ts`): the desktop app there is focused exactly when it
// is in front.
//
// A session is watched when a client that has the user's attention shows it (its tab is the
// one open, `session.watch`, or its terminal is open there), or when the session's own window
// is in front on this machine. A client that never said whether it is focused has the user's
// attention: an app from before this knew nothing to say, and silence is the safer mistake.
//
// A device is heard through one of its clients: connected, able to play audio, holding voice
// and the whole of the node's access, its speaker not muted. One with a conversation already
// is taken first, then the desktop app's own client.

import { FULL, isLimited } from "@cophyla/protocol";
import type { Client, Session, TerminalRef } from "@cophyla/protocol";
import { DESKTOP_NAME } from "../api/clients.ts";
import type { ClientRegistry, Registered } from "../api/clients.ts";
import type { Foreground, WindowChains } from "./foreground.ts";
import { APP_EXE } from "./foreground.ts";

/** What a client said of itself with `voice.presence`. */
export interface PresenceReport {
  visible?: boolean;
  focused?: boolean;
  active?: boolean;
  speaker?: boolean;
}

/** The device a client runs on: its phone's grant, its machine for a desktop app, or the connection itself. */
export function deviceOf(client: Client): string {
  if (client.controller !== undefined) return `phone:${client.controller}`;
  if (client.kind === "ui" && client.node !== undefined) return `desktop@${client.node}`;
  return `client:${client.id}`;
}

export interface PresenceDeps {
  clients: ClientRegistry;
  /** This node: only its own sessions' windows are looked for in front. */
  nodeId: string;
  session: (id: string) => Session | undefined;
  /** The clients a terminal is open in. */
  viewers?: (ref: TerminalRef) => string[];
  /** The processes of the windows tether attached to a terminal. */
  windowPids?: (ref: TerminalRef) => number[];
  /** Whether a client is in a voice conversation already. */
  conversing?: (client: string) => boolean;
  /** A node's name, for what a device is called. */
  nodeName?: (node: string) => string | undefined;
  /** What is in front on this machine, and the processes each root's window may belong to. */
  foreground?: Foreground;
  chains?: WindowChains;
  now?: () => number;
}

export class Presence {
  private deps: PresenceDeps;
  private reports = new Map<string, Omit<PresenceReport, "active">>();
  private actions = new Map<string, number>();

  constructor(deps: PresenceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** `voice.presence`: what changed of this client's window, and whether the user acted in it. True when anything did. */
  report(client: Client, p: PresenceReport): boolean {
    const was = this.reports.get(client.id) ?? {};
    const next = { ...was };
    if (p.visible !== undefined) next.visible = p.visible;
    if (p.focused !== undefined) next.focused = p.focused;
    if (p.speaker !== undefined) next.speaker = p.speaker;
    this.reports.set(client.id, next);
    const changed = next.visible !== was.visible || next.focused !== was.focused || next.speaker !== was.speaker;
    if (p.active === true) this.acted(client);
    return changed || p.active === true;
  }

  /** The user acted in the app on this client's device. */
  acted(client: Client): void {
    this.actions.set(deviceOf(client), this.now());
  }

  /** A client went away: what it said of its window goes too; its device's last action stays. */
  forget(clientId: string): void {
    this.reports.delete(clientId);
  }

  /** When the user last acted on a device. */
  lastAction(device: string): number | undefined {
    return this.actions.get(device);
  }

  /** The device the user acted on last. */
  recent(): string | undefined {
    let best: string | undefined;
    let at = -Infinity;
    for (const [device, t] of this.actions) {
      if (t > at) {
        at = t;
        best = device;
      }
    }
    return best;
  }

  /** Whether a client's speaker is on: true unless it said it is muted. */
  speakerOn(clientId: string): boolean {
    return this.reports.get(clientId)?.speaker !== false;
  }

  /** The desktop app on this machine, whose focus the system can tell. */
  private local(entry: Registered): boolean {
    return entry.listener === "loopback" && entry.client.kind === "ui" && entry.client.name === DESKTOP_NAME;
  }

  /** Whether a client has the user's attention: in front and shown, as far as anyone can tell. */
  attending(entry: Registered): boolean {
    const r = this.reports.get(entry.client.id);
    if (r?.visible === false) return false;
    if (this.deps.foreground && this.local(entry)) {
      const front = this.deps.foreground();
      if (front?.exe !== undefined) return front.exe === APP_EXE;
    }
    return r?.focused !== false;
  }

  /** The clients of a device, connected on this node. */
  private clientsOf(device: string): Registered[] {
    const out: Registered[] = [];
    for (const client of this.deps.clients.list()) {
      if (deviceOf(client) !== device) continue;
      const entry = this.deps.clients.get(client.id);
      if (entry && entry.listener !== "relayed") out.push(entry);
    }
    return out;
  }

  /** The client a device is heard through now, or none: connected, playing audio, with voice and full access, its speaker on. */
  speakable(device: string): Registered | undefined {
    const able = this.clientsOf(device).filter((e) => e.client.audio.out && e.client.scopes.includes("voice") && !isLimited(e.client.access ?? FULL) && this.speakerOn(e.client.id));
    return able.find((e) => this.deps.conversing?.(e.client.id)) ?? able.find((e) => e.client.name === DESKTOP_NAME) ?? able[0];
  }

  /** What a device is called: its machine's name for a desktop app, else its client's. */
  nameOf(device: string, client?: Client): string | undefined {
    if (device.startsWith("desktop@")) {
      const name = this.deps.nodeName?.(device.slice("desktop@".length));
      if (name !== undefined) return name;
    }
    return client?.name;
  }

  /** The processes whose windows would show these sessions: this node's sessions' roots, for the chains to be read. */
  roots(sessions: string[]): number[] {
    const out = new Set<number>();
    for (const id of sessions) {
      const s = this.deps.session(id);
      if (!s || s.node !== this.deps.nodeId || s.status === "ended") continue;
      const ref = s.native.terminal;
      const windows = ref ? (this.deps.windowPids?.(ref) ?? []) : [];
      for (const pid of windows) out.add(pid);
      if (windows.length === 0 && s.native.pid !== undefined) out.add(s.native.pid);
    }
    return [...out];
  }

  /** Whether any of these sessions is in front of the user: shown by a client with their attention, or its own window in front here. */
  watched(sessions: string[]): boolean {
    if (sessions.length === 0) return false;
    for (const client of this.deps.clients.list()) {
      const entry = this.deps.clients.get(client.id);
      if (!entry || entry.listener === "relayed" || !this.attending(entry)) continue;
      for (const id of sessions) {
        if (entry.watching.has(id)) return true;
        const ref = this.deps.session(id)?.native.terminal;
        if (ref && this.deps.viewers?.(ref).includes(client.id)) return true;
      }
    }
    const front = this.deps.foreground?.();
    const chains = this.deps.chains;
    if (!front || !chains) return false;
    for (const root of this.roots(sessions)) if (chains.chain(root)?.includes(front.pid)) return true;
    return false;
  }
}
