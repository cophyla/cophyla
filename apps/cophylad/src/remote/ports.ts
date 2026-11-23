// A machine's localhost opened from another of the user's devices, as if they sat at that
// machine: `localhost:3000` of the Desk, on the laptop or the phone, its bytes riding the link
// Cophyla already has between the two, never the relay. Both halves are here.
//
// On the machine whose port it is (the host), a share: a port a node asked for (`port.share`,
// gated on the links as the node that asked), named by a random id the pipes name it by, never
// by its number. It lasts until it is unshared, the link it came on goes, or a day passes, and
// a restart drops it. A pipe to it connects to this machine's loopback alone (pipes.ts).
//
// On the device's side, a forward: the port this client opened (`port.open`, answered by the
// node its socket is on). The desktop app gets a forwarder on its machine's loopback, on the
// same port where nothing here has it; the phone app opens pipes itself from its own forwarder
// (`remote.pipe.open {share}`), and no other client may open one to that share; on the host
// itself the page is on its own loopback, with nothing between. A forward ends when it is
// closed, after ten minutes with no connection (the desktop's), when its client goes, or when a
// link under it goes. The client is told what it has open (`port.state`), whole each time.
//
// Every share and every forward is audited where it ends, with how many connections went
// through it and how many bytes, never what they carried.

import { newId, RpcError } from "@cophyla/protocol";
import type { Client, ListeningPort, PortForward, PortRoute } from "@cophyla/protocol";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import { Forwarder, PORT_IDLE_MS } from "./forwarder.ts";
import type { PipeHub, PortMeter, PortTarget } from "./pipes.ts";

/** How long a share lasts at most. */
export const SHARE_MS = 24 * 60 * 60_000;
/** How soon after a connection opens or closes the client is told. */
const STATE_DEBOUNCE_MS = 250;

/** What the device side reads of a machine before it asks it to share a port. */
export interface PortHost {
  name: string;
  online: boolean;
  /** It shares the whole machine, not some folders alone. */
  machine: boolean;
  hands: boolean;
  door: boolean;
  /** It runs a Cophyla that shares ports. */
  ports: boolean;
}

/** How a client of this node reaches it: its listener, and on a data channel whether that is TURN's. */
export interface ClientWay {
  listener: string;
  path?: "direct" | "turn";
  /** The client fetches pages through a forwarder of its own: the phone app. */
  forward?: boolean;
  /** A page in a browser, which has no forwarder. */
  browser?: boolean;
}

/** The way between this node and another, for a port: straight as `lan` or `direct`, or why not. */
export type LinkWay = { route: "lan" | "direct" } | { refused: "relay" | "none" };

export interface PortsDeps {
  selfId: string;
  /** This machine's name, read each time. */
  readonly selfName: string;
  /** This node joined as hands: it reaches no other machine. */
  hands?: () => boolean;
  /** This node shares some folders alone, or is a sign-in door: it shares no port of its own. */
  sharesNone?: () => string | undefined;
  hub: PipeHub;
  gate: Gate;
  log: Logger;
  /** Another node's `port.share` and `port.unshare`, over the links. */
  request: (node: string, method: "port.share" | "port.unshare", params: unknown) => Promise<unknown>;
  /** A machine of the user's as this node knows it. */
  host: (node: string) => PortHost | undefined;
  /** The primary's name, for an older one's refusal. */
  primaryName?: () => string | undefined;
  /** How the links between this node and `node` go now. */
  way: (node: string) => LinkWay;
  /** What a client is told of the ports it opened. */
  notify: (client: string, forwards: PortForward[]) => void;
  /** What listens on this machine. */
  list: () => Promise<ListeningPort[]>;
  /** Whether what listens on a port of this machine speaks TLS. */
  tls?: (port: number) => Promise<boolean>;
  now?: () => number;
  idleMs?: number;
  shareMs?: number;
  /** The forwarder's seam: whether a port is free here. */
  free?: (port: number) => Promise<boolean>;
}

interface Counts {
  connections: number;
  open: number;
  bytes: number;
}

interface Share extends Counts {
  id: string;
  port: number;
  viewer: string;
  name?: string;
  /** The node on the link it was asked on: its going ends it. */
  link: string;
  at: number;
  expiresAt: number;
  tls: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface Forward extends Counts {
  id: string;
  client: string;
  node: string;
  port: number;
  local?: number;
  url?: string;
  /** The share the phone opens pipes to. */
  share?: string;
  route: PortRoute;
  since: number;
  forwarder?: Forwarder;
  closed: boolean;
}

/** The words a port is refused with where the bytes would go through the relay: `who` is "this phone", "this computer" or a machine's name. */
export function relayWords(host: string, who: string): string {
  return `Opening ${host}'s localhost needs a direct connection; ${who} reaches ${host} only through the relay right now`;
}

/** The refusal a phone gets for an HTTPS dev server. */
export const HTTPS_ON_PHONE = "HTTPS dev servers don't open on the phone yet";

/** Whether what listens on a port of this machine's loopback speaks TLS: it completes a handshake within a second and a half. */
export async function speaksTls(port: number): Promise<boolean> {
  const tryOn = (hostname: string) =>
    new Promise<boolean | undefined>((resolve) => {
      let done = false;
      const finish = (v: boolean | undefined, s?: { end(): void }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          s?.end();
        } catch {
          // gone already
        }
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), 1500);
      Bun.connect({
        hostname,
        port,
        tls: { rejectUnauthorized: false },
        socket: {
          // a handshake that did not complete is a server that answered something else (plain HTTP)
          handshake: (s, ok) => finish(ok, s),
          data: () => undefined,
          error: (s) => finish(false, s),
          close: () => finish(false),
          connectError: () => finish(undefined),
        },
      }).catch(() => finish(undefined));
    });
  const v4 = await tryOn("127.0.0.1");
  if (v4 !== undefined) return v4;
  return (await tryOn("::1")) ?? false;
}

export class Ports {
  private deps: PortsDeps;
  private log: Logger;
  private shares = new Map<string, Share>();
  private forwards = new Map<string, Forward>();
  private told = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: PortsDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- what listens here ------------------------------------------------------------------------

  /** What listens on this machine's loopback and every address, Cophyla's own left out. */
  async list(): Promise<{ ports: ListeningPort[] }> {
    const refused = this.deps.sharesNone?.();
    if (refused) throw new RpcError("denied", refused);
    return { ports: await this.deps.list() };
  }

  // --- the host's side --------------------------------------------------------------------------

  /** Shares `port` of this machine with `viewer`, asked on the link to `link`; the caller gated it. */
  async share(p: { port: number; viewer: string; name?: string; link: string }): Promise<{ share: string; expiresAt: number; tls?: boolean }> {
    const refused = this.deps.sharesNone?.();
    if (refused) throw new RpcError("denied", refused);
    const tls = (await this.deps.tls?.(p.port)) ?? false;
    const at = this.now();
    const s: Share = { id: newId("portShare", at), port: p.port, viewer: p.viewer, ...(p.name !== undefined ? { name: p.name } : {}), link: p.link, at, expiresAt: at + (this.deps.shareMs ?? SHARE_MS), tls, connections: 0, open: 0, bytes: 0 };
    s.timer = setTimeout(() => this.endShare(s, "a day passed"), this.deps.shareMs ?? SHARE_MS);
    if (typeof s.timer === "object" && "unref" in s.timer) s.timer.unref();
    this.shares.set(s.id, s);
    this.log.info("port shared", { share: s.id, port: s.port, viewer: s.viewer, ...(tls ? { tls: true } : {}) });
    return { share: s.id, expiresAt: s.expiresAt, ...(tls ? { tls: true } : {}) };
  }

  /** Ends a share for `viewer`; the answer is what went through it. The caller gated it. */
  unshare(id: string, viewer: string): { connections: number; bytes: number } {
    const s = this.shares.get(id);
    if (!s || s.viewer !== viewer) throw new RpcError("not_found", "no such port is shared here");
    this.endShare(s, "unshared", false);
    return { connections: s.connections, bytes: s.bytes };
  }

  /** The port a share names, for a pipe from `viewer`, and the meter it tells. */
  portOf(id: string, viewer: string): { port: number; meter: PortMeter } {
    const s = this.shares.get(id);
    if (!s || s.viewer !== viewer) throw new RpcError("not_found", "no such port is shared here");
    return { port: s.port, meter: this.meterOf(s) };
  }

  /** A share or a forward counts a pipe: opened now, its bytes, its end. */
  private meterOf(c: Counts, changed?: () => void): PortMeter {
    c.connections++;
    c.open++;
    changed?.();
    let done = false;
    return {
      bytes: (n) => {
        c.bytes += n;
      },
      done: () => {
        if (done) return;
        done = true;
        c.open = Math.max(0, c.open - 1);
        changed?.();
      },
    };
  }

  /** A share ends: its pipes close, and its row says what went through it, unless the gated unshare's did. */
  private endShare(s: Share, why: string, audit = true): void {
    if (this.shares.get(s.id) !== s) return;
    this.shares.delete(s.id);
    clearTimeout(s.timer);
    this.deps.hub.closeShare(s.id, `the port stopped being shared: ${why}`);
    this.log.info("port unshared", { share: s.id, port: s.port, viewer: s.viewer, why, connections: s.connections, bytes: s.bytes });
    if (audit) this.audit("port.unshare", { share: s.id, port: s.port, viewer: s.viewer, why }, { connections: s.connections, bytes: s.bytes });
  }

  /** An end no request made, in the audit as the daemon's, with what went through. */
  private audit(action: "port.unshare" | "port.close", args: Record<string, unknown>, result: { connections: number; bytes: number }): void {
    void this.deps.gate.run({ principal: { kind: "system" }, action, args }, () => result).catch(() => undefined);
  }

  // --- the device's side ------------------------------------------------------------------------

  /**
   * Opens `port` of `node`'s for `client`, which came in as `way` says: a forwarder here for
   * the desktop app, a share the phone's own forwarder opens pipes to, or, on `node` itself,
   * the page on its own loopback. Refused where the bytes would go through the relay.
   */
  async open(client: Client, way: ClientWay, node: string, port: number): Promise<{ id: string; node: string; port: number; local?: number; url?: string; share?: string; route: PortRoute }> {
    const self = this.deps.selfId;
    const desktop = client.kind === "ui" && client.node === self && way.listener === "loopback";
    const phone = client.kind === "controller" && way.forward === true && way.browser !== true;
    if (!desktop && !phone) throw new RpcError("unsupported", "A machine's localhost opens in the Cophyla app, on a computer or a phone, not in a browser");
    if (node === self) {
      if (desktop) {
        const tls = (await this.deps.tls?.(port)) ?? false;
        return { id: newId("portShare", this.now()), node, port, url: pageUrl(port, tls), route: "here" };
      }
      // the phone on this machine's own network: its pipes end at this loopback
      const route = this.clientRoute(way, this.deps.selfName);
      const shared = await this.share({ port, viewer: self, ...(client.name !== undefined ? { name: client.name } : {}), link: self });
      if (shared.tls) {
        this.endShare(this.shares.get(shared.share)!, "an HTTPS server, which the phone does not open yet");
        throw new RpcError("unsupported", HTTPS_ON_PHONE);
      }
      return this.opened(this.forward({ id: shared.share, client: client.id, node, port, share: shared.share, route }));
    }
    if (this.deps.hands?.()) throw new RpcError("denied", "This machine is lent as hands: it opens no other machine's localhost");
    const host = this.deps.host(node);
    if (!host) throw new RpcError("not_found", "No such machine");
    if (!host.online) throw new RpcError("unavailable", `${host.name} is offline`);
    if (host.door) throw new RpcError("unavailable", `${host.name} is at its sign-in screen: its localhost opens once someone signs in there`);
    if (!host.machine) throw new RpcError("denied", `${host.name} shares some folders alone, not its localhost`);
    if (host.hands) throw new RpcError("denied", `${host.name} is lent as hands: its localhost is its owner's`);
    if (!host.ports) throw new RpcError("unsupported", `Update Cophyla on ${host.name} to open its localhost from here`);
    const clientRoute = phone ? this.clientRoute(way, host.name) : undefined;
    const link = this.deps.way(node);
    if ("refused" in link) throw new RpcError("unavailable", link.refused === "relay" ? relayWords(host.name, phone ? "this phone" : "this computer") : `${host.name} cannot be reached from here right now`);
    const route: PortRoute = clientRoute === "direct" || link.route === "direct" ? "direct" : "lan";
    const shared = await this.ask(node, host.name, { node, port, viewer: self, ...(client.name !== undefined ? { name: client.name } : {}) });
    if (phone && shared.tls) {
      void this.deps.request(node, "port.unshare", { node, share: shared.share, viewer: this.deps.selfId }).catch(() => undefined);
      throw new RpcError("unsupported", HTTPS_ON_PHONE);
    }
    if (phone) return this.opened(this.forward({ id: shared.share, client: client.id, node, port, share: shared.share, route }));
    const f = this.forward({ id: shared.share, client: client.id, node, port, route });
    const target: PortTarget = { kind: "port", share: shared.share };
    const forwarder = new Forwarder({
      hub: this.deps.hub,
      node,
      target,
      port,
      log: this.log.child("forwarder"),
      idleMs: this.deps.idleMs ?? PORT_IDLE_MS,
      onClose: () => this.end(f, "no connection for ten minutes"),
      ...(this.deps.free ? { free: this.deps.free } : {}),
    });
    f.forwarder = forwarder;
    let local: number;
    try {
      local = await forwarder.startBoth();
    } catch (e) {
      void this.deps.request(node, "port.unshare", { node, share: shared.share, viewer: this.deps.selfId }).catch(() => undefined);
      throw new RpcError("unavailable", `No port could be opened on this computer: ${e instanceof Error ? e.message : String(e)}`);
    }
    f.local = local;
    f.url = pageUrl(local, shared.tls === true);
    return this.opened(f);
  }

  /** `port.share` on the links, an older Cophyla's refusal said in words. */
  private async ask(node: string, name: string, params: { node: string; port: number; viewer: string; name?: string }): Promise<{ share: string; expiresAt: number; tls?: boolean }> {
    try {
      return (await this.deps.request(node, "port.share", params)) as { share: string; expiresAt: number; tls?: boolean };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RpcError && e.code === "unsupported" && /not served upward/.test(message)) throw new RpcError("unsupported", `Update Cophyla on ${this.deps.primaryName?.() ?? "the primary"} to open a machine's localhost from here`);
      if (e instanceof RpcError && e.code === "unsupported" && /not served over the node link/.test(message)) throw new RpcError("unsupported", `Update Cophyla on ${name} to open its localhost from here`);
      throw e;
    }
  }

  /** The leg between the phone and this node: on its network, or a data channel of its own; never the relay. */
  private clientRoute(way: ClientWay, host: string): "lan" | "direct" {
    if (way.listener === "controller") return "lan";
    if (way.listener === "p2p" && way.path !== "turn") return "direct";
    throw new RpcError("unavailable", relayWords(host, "this phone"));
  }

  private forward(f: Pick<Forward, "id" | "client" | "node" | "port" | "route"> & { share?: string }): Forward {
    return { ...f, since: this.now(), connections: 0, open: 0, bytes: 0, closed: false };
  }

  /** A forward is open: kept, its client told, and what the client is answered. */
  private opened(forward: Forward): { id: string; node: string; port: number; local?: number; url?: string; share?: string; route: PortRoute } {
    this.forwards.set(forward.id, forward);
    this.log.info("port opened", { id: forward.id, node: forward.node, port: forward.port, client: forward.client, route: forward.route, ...(forward.local !== undefined ? { local: forward.local } : {}) });
    this.tell(forward.client, true);
    return { id: forward.id, node: forward.node, port: forward.port, ...(forward.local !== undefined ? { local: forward.local } : {}), ...(forward.url !== undefined ? { url: forward.url } : {}), ...(forward.share !== undefined ? { share: forward.share } : {}), route: forward.route };
  }

  /** The meter of a forward of this node's, by its share: the pipes its forwarder or its phone opens tell it. */
  meter(share: string): PortMeter | undefined {
    const f = this.forwards.get(share);
    if (!f || f.closed) return undefined;
    // the phone on the host's own network: the share counts it, and the forward reads the share
    if (this.shares.has(share)) return undefined;
    return this.meterOf(f, () => this.tell(f.client));
  }

  /** The pipe a phone opens to a port it opened (`remote.pipe.open {share}`): only its own. */
  pipeTo(client: string, share: string): { node: string; target: PortTarget } {
    const f = this.forwards.get(share);
    if (!f || f.closed || f.client !== client || f.share !== share) throw new RpcError("not_found", "no such port is open for this client");
    return { node: f.node, target: { kind: "port", share } };
  }

  /** Closes a port `client` opened. */
  close(client: string, id: string): Record<string, never> {
    const f = this.forwards.get(id);
    if (!f || f.client !== client) throw new RpcError("not_found", "no such port is open for this client");
    this.end(f, "closed");
    return {};
  }

  /** A forward ends: its forwarder and its connections, the host's share, and a row that says what went through it. */
  private end(f: Forward, why: string): void {
    if (f.closed) return;
    f.closed = true;
    this.forwards.delete(f.id);
    f.forwarder?.stop();
    this.deps.hub.closeShare(f.id, `the port was closed: ${why}`);
    const local = this.shares.get(f.id);
    const counts = local ?? f;
    if (local) this.endShare(local, why, false);
    else void this.deps.request(f.node, "port.unshare", { node: f.node, share: f.id, viewer: this.deps.selfId }).catch((e: unknown) => this.log.debug("the host did not hear the port close", { node: f.node, error: e instanceof Error ? e.message : String(e) }));
    this.log.info("port closed", { id: f.id, node: f.node, port: f.port, client: f.client, why, connections: counts.connections, bytes: counts.bytes });
    this.audit("port.close", { id: f.id, node: f.node, port: f.port, why }, { connections: counts.connections, bytes: counts.bytes });
    this.tell(f.client, true);
  }

  /** What `client` has open, as `port.state` says it. */
  forwardsOf(client: string): PortForward[] {
    return [...this.forwards.values()]
      .filter((f) => f.client === client && !f.closed)
      .map((f) => {
        const c = this.shares.get(f.id) ?? f;
        return { id: f.id, node: f.node, port: f.port, ...(f.local !== undefined ? { local: f.local } : {}), ...(f.url !== undefined ? { url: f.url } : {}), route: f.route, since: f.since, connections: c.open, bytes: c.bytes };
      });
  }

  /** Tells `client` what it has open: at once, or a moment after a connection opened or closed. */
  private tell(client: string, now = false): void {
    const pending = this.told.get(client);
    if (pending && !now) return;
    clearTimeout(pending);
    this.told.delete(client);
    const send = () => {
      this.told.delete(client);
      this.deps.notify(client, this.forwardsOf(client));
    };
    if (now) {
      send();
      return;
    }
    const t = setTimeout(send, STATE_DEBOUNCE_MS);
    if (typeof t === "object" && "unref" in t) t.unref();
    this.told.set(client, t);
  }

  // --- what goes -------------------------------------------------------------------------------

  /** A client went: what it opened closes. */
  clientGone(client: string): void {
    for (const f of [...this.forwards.values()]) if (f.client === client) this.end(f, "its app went");
    const pending = this.told.get(client);
    clearTimeout(pending);
    this.told.delete(client);
  }

  /** The link to `node` went: the shares asked on it end, and so do the forwards that ride it (all of them, when it was the primary's). */
  linkGone(node: string, primary: boolean): void {
    for (const s of [...this.shares.values()]) if (s.link === node || s.viewer === node) this.endShare(s, "the link to the machine that opened it went");
    for (const f of [...this.forwards.values()]) if (f.node !== this.deps.selfId && (primary || f.node === node)) this.end(f, "the link to the machine went");
  }

  /** The daemon stops: everything goes, nothing is told. */
  stop(): void {
    for (const f of this.forwards.values()) {
      f.closed = true;
      f.forwarder?.stop();
    }
    this.forwards.clear();
    for (const s of this.shares.values()) clearTimeout(s.timer);
    this.shares.clear();
    for (const t of this.told.values()) clearTimeout(t);
    this.told.clear();
  }

  /** How many shares and forwards there are now, for the tests. */
  get counts(): { shares: number; forwards: number } {
    return { shares: this.shares.size, forwards: this.forwards.size };
  }
}

/** The page a port serves, on this machine's loopback. */
function pageUrl(port: number, tls: boolean): string {
  return `${tls ? "https" : "http"}://localhost:${port}/`;
}
