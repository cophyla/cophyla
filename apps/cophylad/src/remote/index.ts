// The remote module: this node's desktop shared through a streaming host, the viewers it
// runs for its own clients, and one frame for the brain. While sharing is on (the switch the
// app sets with `remote.enable`, kept in the store over `[remote] enabled`) the host (Apollo,
// or Sunshine) is located or installed, health-checked (on Windows it is a service;
// elsewhere a sidecar), given credentials cophylad keeps under `data/remote`, named after
// this node and told to serve its web UI to this machine only; its client list is polled, so
// `remote.state` says who is paired and whether someone is watching. `remote.disable` ends
// the streams and keeps the pairings: elsewhere the sidecar stops, while a Windows service
// keeps running, so its list is still read and its viewers can still be revoked, since they
// can still connect to it directly until they are. Viewing needs no flag: a desktop client's
// `remote.open` pairs moonlight-qt with the host node (the PIN it chose is posted there
// through `pairOn`, the gate's one ask) and opens the window, or, asked to embed it beside
// the view, gets a loopback ticket to the moonlight-web sidecar this node runs, as a
// controller gets one on its own origin. `remote.open` is answered by the node the client's
// socket is on, so the viewing node owns both viewers and nothing forwards it — except where
// there is no route to the desktop: a phone off the LAN, or a desktop app on a node with no
// way to the host. Then the host mints the ticket (`remote.ticket`, gated there as the node
// that asked), its own web viewer serves the page to its loopback proxy, the page's
// connections ride pipes over the links (the phone's own forwarder, or one on the viewing
// node), and the video goes over WebRTC with the host's TURN servers, never through the relay.
// A stream the desktop app opens is sized to the host's screen (which each node reads and says
// in its `remote.state`) with a bitrate to match, unless the user saved Moonlight's own settings
// (`remote.open` with `settings` opens its window), and its page hides the user's pointer over
// the picture.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { RpcError } from "@cophyla/protocol";
import type { CapabilityResult, Client, ClientResult, DisplaySize, RemoteHost, RemoteState, RemoteViewer, StreamTransport } from "@cophyla/protocol";
import type { ListenerKind } from "../api/clients.ts";
import type { Bus } from "../bus.ts";
import type { RemoteConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Sidecar, Sidecars } from "../sidecars/index.ts";
import { defaultExec } from "../sidecars/tts-py.ts";
import type { Exec } from "../sidecars/tts-py.ts";
import { hostOs } from "../update/platform.ts";
import type { HostOs } from "../update/platform.ts";
import { HostApi, HostApiError } from "./host.ts";
import type { HostClient, HostCredentials } from "./host.ts";
import { displaySize } from "./display.ts";
import { install, locateHost, locateMoonlight } from "./install.ts";
import type { HostKind, Located } from "./install.ts";
import { hostOfEndpoint, Moonlight, moonlightSaved, randomPin } from "./moonlight.ts";
import type { Spawner } from "./moonlight.ts";
import { RemoteProxy, RemoteTickets } from "./proxy.ts";
import { streamVideo } from "./quality.ts";
import { screenshotter } from "./screenshot.ts";
import type { Capture } from "./screenshot.ts";
import { HOST_PORT, hostLabel, spawnHost, windowsServiceStart, windowsServiceState } from "./service.ts";
import { Forwarder } from "./forwarder.ts";
import { LoopbackProxy } from "./loopback.ts";
import type { PipeHub } from "./pipes.ts";
import { MoonlightWeb, WEB_RTC_PORTS } from "./web.ts";

export interface OpenContext {
  client: Client;
  origin: string;
  listener: ListenerKind;
  /** The client fetches the stream page through a forwarder of its own: it gets the path, not a URL. */
  forward?: boolean;
  /** The desktop app shows the page beside its view: a loopback URL rather than moonlight-qt's window. */
  embed?: boolean;
  /** The host's screen as the client last heard it, for a host whose `remote.state` this node has not. */
  display?: DisplaySize;
}

export interface RemoteDeps {
  config: RemoteConfig;
  /** Where the sharing switch is kept once the app has set it. */
  store: { meta: { get(key: string): string | undefined; set(key: string, value: string): void } };
  nodeId: string;
  /** This node's name, read each time (the user may rename the machine): the host is called by it, and so is this node's viewer in other hosts' lists. */
  readonly nodeName: string;
  /** `<home>/data/remote`: the host credentials and the capture script. */
  dir: string;
  /** `<home>/data/sidecars`: the web viewer's releases. */
  sidecarsDir: string;
  bus: Bus;
  log: Logger;
  sidecars: Sidecars;
  /**
   * Has `node`'s host accept a viewer's PIN under `name`: this node's own through the gate as
   * the client that asked (`via`), or the owner's through the nodes module, gated there.
   */
  pairOn: (node: string, p: { pin: string; name: string }, via: string) => Promise<void>;
  /** Where a node's host is reached: its first endpoint without the port; loopback for this node. */
  addressOf: (node: string) => string | undefined;
  /** Whether this machine has a route to `node`'s; without it, whether the node has an address. */
  lanRoute?: (node: string) => boolean;
  lanIps: () => string[];
  /** The node's row changed: the host came up or went. */
  onStateChange?: () => void;
  os?: HostOs;
  env?: Record<string, string | undefined>;
  /** The seams: the command runner, the host API, the viewer's spawner and binary, the web sidecar's command, the capture. */
  exec?: Exec;
  fetch?: typeof fetch;
  hostApi?: (kind: HostKind) => HostApi;
  moonlight?: { spawn?: Spawner; command?: string };
  web?: { command?: string[]; target?: string };
  screenshot?: Capture;
  /** This machine's primary display, in physical pixels; `displaySize` without it. */
  display?: () => DisplaySize | undefined;
  now?: () => number;
  /** The node links, for a stream on a node this one has no route to: its ticket there, and its end. */
  links?: {
    request(node: string, method: "remote.ticket" | "remote.close", params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  };
  /** The pipes a stream page's connections ride where there is no route to the host. */
  pipes?: PipeHub;
  /** This node's direct connections: the TURN servers a stream's own WebRTC uses, and the router's mapping of its ports. */
  direct?: { readonly ready: boolean; iceServers(): Promise<unknown>; request(method: string, params: unknown): Promise<unknown> };
}

/** A stream shown where there is no route to its host: which host, whose it is, and the forwarder a window reads it through. */
interface Away {
  node: string;
  client: string;
  forwarder?: Forwarder;
}

const CREDENTIALS_FILE = "host.json";
/** The store's key for the sharing switch: "1" or "0", over `[remote] enabled` once set. */
export const ENABLED_KEY = "remote_enabled";
/** How long a viewer has to show it kept a pairing the host accepted. */
const PAIR_CONFIRM_MS = 15_000;
/** Polls the host may miss before it is called unavailable. */
const MISSES = 3;
/** Reads of the host's list, 250 ms apart, for a client it just paired to show up. */
const CLIENT_WAIT_TRIES = 40;

export class Remote {
  private deps: RemoteDeps;
  private log: Logger;
  private config: RemoteConfig;
  private os: HostOs;
  private exec: Exec;
  private host: RemoteHost = { kind: "none", status: "off" };
  private hostApi?: HostApi;
  private hostSidecar?: Sidecar;
  private located?: Located;
  private moonlight: Moonlight;
  private web: MoonlightWeb;
  readonly tickets: RemoteTickets;
  readonly proxy: RemoteProxy;
  /** The stream proxy on loopback, for the pages that come through pipes. */
  readonly loopback: LoopbackProxy;
  private away = new Map<string, Away>();
  private capture: Capture;
  private native: RemoteViewer[] = [];
  /** This machine's primary display as the last poll read it. */
  private display?: DisplaySize;
  private firstSeen = new Map<string, number>();
  private hostStreaming = false;
  private timer?: ReturnType<typeof setTimeout>;
  private misses = 0;
  private stopped = false;
  private starting?: Promise<void>;
  /** Counts the switch's moves: a bring-up from before the last one gives up. */
  private generation = 0;
  /** The host came up since sharing was last switched on: an unavailable one that answers again is ready. */
  private up = false;
  private last?: string;
  private others = new Map<string, RemoteState>();
  private unsubscribe: (() => void)[] = [];

  constructor(deps: RemoteDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.config = deps.config;
    this.os = deps.os ?? hostOs();
    this.exec = deps.exec ?? defaultExec;
    this.moonlight = new Moonlight({
      command: () => this.moonlightCommand(),
      exec: this.exec,
      ...(deps.moonlight?.spawn ? { spawn: deps.moonlight.spawn } : {}),
      log: this.log.child("moonlight"),
    });
    this.tickets = new RemoteTickets(deps.now ? { now: deps.now } : {});
    this.tickets.onChange(() => this.publish());
    this.web = new MoonlightWeb({
      root: join(deps.sidecarsDir, "moonlight-web"),
      sidecars: deps.sidecars,
      config: deps.config,
      log: this.log.child("web"),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.web?.target ? { target: deps.web.target } : {}),
      ...(deps.web?.command ? { command: deps.web.command } : {}),
      lanIps: deps.lanIps,
      pairOn: deps.pairOn,
      get viewerName() {
        return `${deps.nodeName} web`;
      },
      iceServersFile: join(deps.dir, "ice-servers.json"),
    });
    this.proxy = new RemoteProxy({
      tickets: this.tickets,
      upstream: () => this.web.url(),
      transport: () => this.config.web_transport,
      log: this.log.child("proxy"),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.loopback = new LoopbackProxy({ proxy: this.proxy, log: this.log.child("loopback") });
    this.capture = deps.screenshot ?? screenshotter({ dir: deps.dir, os: this.os, log: this.log.child("screenshot"), ...(deps.env ? { env: deps.env } : {}) });
    // Every node's last `remote.state` reaches the bus, this node's own included; the others are kept for `welcome`.
    this.unsubscribe.push(
      deps.bus.on("remote.state", (s) => {
        if (s.node !== deps.nodeId) this.others.set(s.node, s);
      }),
      // A node that left serves nothing until it is back and says so again.
      deps.bus.on("node.left", (e) => void this.others.delete(e.node)),
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- state ------------------------------------------------------------------------------------

  /** Whether this node shares its desktop now. */
  capable(): boolean {
    return this.host.status === "ready";
  }

  /** This node's `remote.state`. */
  state(): RemoteState {
    const viewers = [...this.native, ...this.tickets.viewers()];
    return { node: this.deps.nodeId, host: { ...this.host, ...(this.display ? { display: { ...this.display } } : {}) }, viewers, streaming: this.hostStreaming };
  }

  /** This machine's primary display now. */
  private readDisplay(): DisplaySize | undefined {
    return this.deps.display ? this.deps.display() : displaySize(this.os);
  }

  /**
   * The screen `node`'s host streams: this machine's own for this node; another's as its
   * `remote.state` says, else as the client heard it; else this machine's, the likeliest match.
   */
  private hostDisplay(node: string, heard?: DisplaySize): DisplaySize | undefined {
    if (node === this.deps.nodeId) return this.readDisplay();
    return this.others.get(node)?.host.display ?? heard ?? this.readDisplay();
  }

  /** Every node's last known `remote.state`, this node's first. */
  states(): RemoteState[] {
    return [this.state(), ...this.others.values()];
  }

  /** Emits `remote.state` when it changed since the last emit; `node.state` follows when the host came up or went. */
  private publish(): void {
    const s = this.state();
    const text = JSON.stringify(s);
    if (text === this.last) return;
    const before = this.last ? (JSON.parse(this.last) as RemoteState).host.status : undefined;
    this.last = text;
    this.deps.bus.emit("remote.state", s);
    if ((before === "ready") !== (s.host.status === "ready")) this.deps.onStateChange?.();
  }

  private setHost(patch: Partial<RemoteHost> & { status: RemoteHost["status"] }): void {
    const kind = patch.kind ?? this.host.kind;
    this.host = { kind, status: patch.status, ...(patch.step !== undefined ? { step: patch.step } : {}), ...(patch.progress !== undefined ? { progress: patch.progress } : {}), ...(patch.reason !== undefined ? { reason: patch.reason } : {}) };
    this.publish();
  }

  // --- the switch -------------------------------------------------------------------------------

  /** Whether this node shares its desktop: the app's switch once set, `[remote] enabled` before. */
  get enabled(): boolean {
    const kept = this.deps.store.meta.get(ENABLED_KEY);
    return kept === undefined ? this.config.enabled : kept === "1";
  }

  /** Shares this desktop: the host is brought up when it is off, or tried again when it is unavailable. */
  enable(): void {
    if (!this.enabled) this.log.info("desktop sharing switched on");
    this.deps.store.meta.set(ENABLED_KEY, "1");
    if (this.host.status === "off" || this.host.status === "unavailable") this.start();
  }

  /**
   * Stops sharing: the streams end, the pairings stay. A sidecar host stops, and its list goes
   * with it; a Windows service keeps running, so its list is still read: its viewers can still
   * connect to it directly until they are revoked.
   */
  async disable(): Promise<void> {
    if (this.enabled) this.log.info("desktop sharing switched off");
    this.deps.store.meta.set(ENABLED_KEY, "0");
    this.generation++;
    this.up = false;
    // the web sessions showing this desktop, to a client here or to a viewer elsewhere
    this.tickets.forgetWhere((_client, target) => target.node === this.deps.nodeId);
    const api = this.hostApi;
    if (api) {
      for (const v of this.native.filter((n) => n.connected === true)) {
        await api.disconnect(v.id).catch((e: unknown) => this.log.warn("a viewer's stream did not end", { viewer: v.name ?? v.id, error: e instanceof Error ? e.message : String(e) }));
      }
    }
    if (this.os !== "windows") {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      await this.stopHostSidecar();
      this.hostApi = undefined;
      this.native = [];
      this.firstSeen.clear();
      this.hostStreaming = false;
    } else if (api) {
      await this.poll().catch(() => undefined);
    }
    this.setHost({ status: "off" });
  }

  // --- the host ---------------------------------------------------------------------------------

  /** Brings the host up in the background, after a bring-up still running; `ready()` waits for it. */
  start(): void {
    if (!this.enabled) {
      this.setHost({ status: "off" });
      if (this.os === "windows" && !this.hostApi) this.starting = this.observe();
      return;
    }
    const generation = ++this.generation;
    const before = this.starting ?? Promise.resolve();
    this.starting = before
      .then(() => this.bringUp(generation))
      .catch(async (e: unknown) => {
        if (e instanceof Superseded) {
          // switched off while it came up: a sidecar it started goes again
          if (!this.enabled && this.os !== "windows") await this.stopHostSidecar();
          return;
        }
        const reason = e instanceof Error ? e.message : String(e);
        this.log.warn("remote host unavailable", { reason });
        this.setHost({ status: "unavailable", reason });
      });
  }

  /** For the tests and the live check: resolves once the host settled, ready or not. */
  ready(): Promise<void> {
    return this.starting ?? Promise.resolve();
  }

  private wantedKind(): HostKind {
    if (this.config.host !== "auto") return this.config.host;
    return this.os === "windows" ? "apollo" : "sunshine";
  }

  /** Throws once the switch moved after this bring-up began, or the module stopped. */
  private still(generation: number): void {
    if (generation !== this.generation || !this.enabled || this.stopped) throw new Superseded();
  }

  private async bringUp(generation: number): Promise<void> {
    this.still(generation);
    this.up = false;
    let located = locateHost(this.config, this.os, this.deps.env ?? process.env);
    if (!located) {
      const kind = this.wantedKind();
      if (!this.config.install) throw new Error(`no ${kind} found and [remote] install is off`);
      this.setHost({ kind, status: "installing", step: `installing ${kind}` });
      this.log.info("installing the remote host", { kind });
      await install(kind, {
        exec: this.exec,
        os: this.os,
        onLine: (line) => {
          if (this.host.status === "installing") this.setHost({ kind, status: "installing", step: line.slice(0, 120) });
        },
      });
      this.still(generation);
      located = locateHost(this.config, this.os, this.deps.env ?? process.env);
      if (!located) throw new Error(`${kind} was installed but its binary was not found`);
    }
    this.located = located;
    const kind = located.kind;
    this.setHost({ kind, status: "starting", step: `checking ${hostLabel(located)}` });
    const api = this.deps.hostApi ? this.deps.hostApi(kind) : new HostApi({ kind, port: HOST_PORT, log: this.log.child("host"), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
    this.hostApi = api;

    if (this.os === "windows") {
      if (!(await api.alive())) {
        const svc = await windowsServiceState(kind, this.exec);
        this.still(generation);
        if (svc.state === "stopped") {
          this.setHost({ kind, status: "starting", step: svc.detail });
          const started = await windowsServiceStart(kind, this.exec);
          if (!started.ok) throw new Error(started.detail);
        } else if (svc.state === "absent" || svc.state === "unknown") {
          throw new Error(`${hostLabel(located)} does not answer: ${svc.detail}`);
        }
      }
    } else {
      // the one from an earlier try when there is one: started again unless it is up
      this.setHost({ kind, status: "starting", step: `starting ${hostLabel(located)}` });
      this.hostSidecar = spawnHost(this.deps.sidecars, located, this.os);
      await this.hostSidecar.start();
    }
    this.still(generation);
    this.setHost({ kind, status: "starting", step: "waiting for the host" });
    if (!(await api.waitAlive())) throw new Error(`${hostLabel(located)} did not answer on port ${HOST_PORT}`);

    this.still(generation);
    this.setHost({ kind, status: "starting", step: "credentials" });
    await this.credentials(api);
    this.still(generation);
    this.setHost({ kind, status: "starting", step: "configuring" });
    const restarted = await api.configure({ sunshine_name: this.deps.nodeName, origin_web_ui_allowed: "pc" });
    if (restarted) {
      this.setHost({ kind, status: "starting", step: "restarting the host" });
      if (!(await api.waitAlive())) throw new Error(`${hostLabel(located)} did not come back after its restart`);
    }
    await this.poll();
    this.still(generation);
    this.up = true;
    this.setHost({ kind, status: "ready" });
    this.log.info("remote host ready", { host: hostLabel(located), name: this.deps.nodeName });
    this.schedule();
  }

  /**
   * Sharing is off on Windows at start: a host service that runs anyway, with credentials
   * cophylad knows, is read for its list, so its paired viewers are shown and can be revoked.
   * Nothing is installed, started or configured.
   */
  private async observe(): Promise<void> {
    try {
      const located = locateHost(this.config, this.os, this.deps.env ?? process.env);
      const known = this.configuredCredentials() ?? this.keptCredentials();
      if (!located || !known) return;
      const api = this.deps.hostApi ? this.deps.hostApi(located.kind) : new HostApi({ kind: located.kind, port: HOST_PORT, log: this.log.child("host"), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
      if (!(await api.alive())) return;
      api.setCredentials(known);
      await api.clients();
      if (this.enabled || this.stopped || this.hostApi) return;
      this.hostApi = api;
      this.located = located;
      await this.poll();
      this.setHost({ kind: located.kind, status: "off" });
      this.schedule();
    } catch (e) {
      this.log.debug("the host is not read while sharing is off", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private configuredCredentials(): HostCredentials | undefined {
    return this.config.host_user && this.config.host_password ? { username: this.config.host_user, password: this.config.host_password } : undefined;
  }

  /** The pair cophylad set through the welcome flow and kept. */
  private keptCredentials(): HostCredentials | undefined {
    const file = join(this.deps.dir, CREDENTIALS_FILE);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as HostCredentials;
    } catch {
      return undefined;
    }
  }

  /** The host's web credentials: the configured pair, the kept one, or a new one through the welcome flow. */
  private async credentials(api: HostApi): Promise<void> {
    const file = join(this.deps.dir, CREDENTIALS_FILE);
    const configured = this.configuredCredentials();
    const kept = configured ? undefined : this.keptCredentials();
    const fresh: HostCredentials = { username: "cophyla", password: randomBytes(18).toString("base64url") };
    const candidate = configured ?? kept ?? fresh;
    // The welcome flow takes the first credentials a host ever gets; afterwards it refuses, and the known pair is tried.
    if (await api.welcome(candidate)) {
      if (!configured) {
        mkdirSync(this.deps.dir, { recursive: true });
        writeFileSync(file, JSON.stringify(candidate, null, 2), { mode: 0o600 });
      }
      this.log.info("remote host credentials set", { user: candidate.username });
      return;
    }
    const known = configured ?? kept;
    if (!known) throw new Error("the host already has credentials cophylad does not know: set [remote] host_user and host_password");
    api.setCredentials(known);
    try {
      await api.config();
    } catch (e) {
      if (e instanceof HostApiError && e.status === 401) throw new Error("the host refused the known credentials: set [remote] host_user and host_password");
      throw e;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.config.poll_ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.poll();
      this.misses = 0;
      if (this.host.status === "unavailable" && this.up) {
        this.log.info("remote host back");
        this.setHost({ status: "ready" });
      }
    } catch (e) {
      this.misses++;
      if (this.misses >= MISSES && this.host.status === "ready") {
        let reason = e instanceof Error ? e.message : String(e);
        if (this.os === "windows" && this.located) reason = (await windowsServiceState(this.located.kind, this.exec)).detail;
        this.log.warn("remote host stopped answering", { reason });
        this.setHost({ status: "unavailable", reason });
      }
    }
    this.schedule();
  }

  /** One read of the host: who is paired, and whether one of them streams. */
  private async poll(): Promise<void> {
    const api = this.hostApi;
    if (!api) return;
    const clients = await api.clients();
    const now = this.now();
    const seen = new Set<string>();
    this.native = clients.map((c) => {
      seen.add(c.uuid);
      const since = this.firstSeen.get(c.uuid) ?? now;
      this.firstSeen.set(c.uuid, since);
      return { id: c.uuid, kind: "native", since, ...(c.name ? { name: c.name } : {}), ...(c.connected !== undefined ? { connected: c.connected } : {}) };
    });
    for (const id of [...this.firstSeen.keys()]) if (!seen.has(id)) this.firstSeen.delete(id);
    // read with the list, so a change of resolution reaches the viewers at the next poll
    this.display = this.readDisplay();
    let streaming = clients.some((c) => c.connected === true);
    if (api.kind === "sunshine") {
      const info = await api.serverInfo();
      streaming = streaming || info.state === "SUNSHINE_SERVER_BUSY";
    }
    this.hostStreaming = streaming;
    this.publish();
  }

  private requireHost(): HostApi {
    if (!this.enabled) throw new RpcError("unavailable", "this node does not share its desktop: sharing is off");
    if (this.host.status !== "ready" || !this.hostApi) throw new RpcError("unavailable", `this node's desktop host is ${this.host.status}${this.host.reason ? `: ${this.host.reason}` : ""}`);
    return this.hostApi;
  }

  /** The host whose pairings are revoked: the one serving, or a service still read while sharing is off. */
  private pairedHost(): HostApi {
    if (!this.enabled && this.host.status === "off" && this.hostApi) return this.hostApi;
    return this.requireHost();
  }

  private async stopHostSidecar(): Promise<void> {
    const sidecar = this.hostSidecar;
    if (!sidecar) return;
    this.hostSidecar = undefined;
    await sidecar.stop().catch(() => undefined);
    this.deps.sidecars.forget("remote-host");
  }

  /** The host accepts a viewer's PIN and the viewer gets what a viewer needs. */
  async pair(pin: string, name: string | undefined, opts: { signal?: AbortSignal } = {}): Promise<ClientResult<"remote.pair">> {
    const api = this.requireHost();
    const label = name ?? "viewer";
    const before = new Set((await api.clients()).map((c) => c.uuid));
    await api.pin(pin, label, opts.signal ? { signal: opts.signal } : {});
    const client = await this.newClient(api, label, before);
    if (!client) this.log.warn("the paired viewer never showed in the host's list; it may watch but not drive", { name: label });
    else await api.grantViewer(client).catch((e) => this.log.warn("could not grant the viewer its permissions", { name: label, error: e instanceof Error ? e.message : String(e) }));
    await this.poll().catch(() => undefined);
    return {};
  }

  /**
   * The client a PIN just paired: the host lists it only once the viewer has finished its half
   * of the handshake, moments after it took the PIN, so the list is read until a client of that
   * name that was not there before shows up.
   */
  private async newClient(api: HostApi, name: string, before: Set<string>): Promise<HostClient | undefined> {
    for (let i = 0; i < CLIENT_WAIT_TRIES; i++) {
      const found = (await api.clients()).find((c) => c.name === name && !before.has(c.uuid));
      if (found) return found;
      await Bun.sleep(250);
    }
    return undefined;
  }

  /** A code for a phone, from the host; Apollo's Artemis opens the link. */
  async invite(): Promise<ClientResult<"remote.invite">> {
    const api = this.requireHost();
    if (api.kind !== "apollo") throw new RpcError("unsupported", "this host mints no invite codes; pair by PIN");
    const passphrase = `cophyla-${randomBytes(3).toString("hex")}`;
    const r = await api.otp(passphrase, "phone");
    const ip = r.ip ?? this.deps.lanIps().find((a) => a !== "127.0.0.1") ?? "127.0.0.1";
    const link = `art://${ip}:${HOST_PORT}?pin=${encodeURIComponent(r.otp)}&passphrase=${encodeURIComponent(passphrase)}&name=${encodeURIComponent(this.deps.nodeName)}`;
    return { otp: r.otp, link, passphrase, expiresAt: this.now() + 3 * 60_000 };
  }

  /** Ends a viewer: a web session of this node, or a client paired with this node's host. */
  async revoke(viewer: string): Promise<ClientResult<"remote.revoke">> {
    const session = this.tickets.byViewer(viewer);
    if (session) {
      this.tickets.revoke(session.id);
      return {};
    }
    const api = this.pairedHost();
    const client = (await api.clients()).find((c) => c.uuid === viewer || c.name === viewer);
    if (!client) throw new RpcError("not_found", `no viewer ${viewer}`);
    await api.disconnect(client.uuid).catch(() => undefined);
    await api.unpair(client.uuid);
    await this.poll().catch(() => undefined);
    return {};
  }

  // --- viewing ----------------------------------------------------------------------------------

  private async moonlightCommand(): Promise<string> {
    if (this.deps.moonlight?.command) return this.deps.moonlight.command;
    const found = locateMoonlight(this.config, this.os, this.deps.env ?? process.env);
    if (found) return found;
    if (!this.config.install) throw new RpcError("unavailable", "moonlight is not installed and [remote] install is off");
    this.log.info("installing moonlight");
    await install("moonlight", { exec: this.exec, os: this.os });
    const after = locateMoonlight(this.config, this.os, this.deps.env ?? process.env);
    if (!after) throw new RpcError("unavailable", "moonlight was installed but its binary was not found");
    return after;
  }

  /** Whether this machine reaches `node`'s desktop over the LAN. */
  private routable(node: string): boolean {
    if (!this.config.lan_route) return false;
    return this.deps.lanRoute ? this.deps.lanRoute(node) : this.deps.addressOf(node) !== undefined;
  }

  /** Where `node`'s host is, for the viewer. */
  private hostAddress(node: string): string {
    if (node === this.deps.nodeId) return "127.0.0.1";
    const endpoint = this.deps.addressOf(node);
    if (!endpoint) throw new RpcError("not_found", `no node ${node}`);
    return hostOfEndpoint(endpoint);
  }

  /**
   * Opens `node`'s desktop for the client on this socket: a desktop client gets moonlight-qt
   * paired (the host's one ask) and a window; a controller gets a ticket to the web viewer
   * on this node's controller origin. The phone app, which cannot show a page from the
   * node's self-signed origin, fetches it through a forwarder on its own loopback over its
   * pinned socket: it gets the ticket's path, its cookie without `Secure`, and the video on
   * the page's WebSocket.
   */
  async open(node: string, ctx: OpenContext): Promise<ClientResult<"remote.open">> {
    // the phone off the LAN: the host's page through its own forwarder and pipes
    if (ctx.client.kind === "controller" && ctx.forward && (ctx.listener === "cloud" || ctx.listener === "p2p")) return this.openAway(node, ctx.client, "phone");
    if (ctx.embed && ctx.client.kind === "ui" && node === this.deps.nodeId) throw new RpcError("invalid", "this is the desktop the app runs on: it is not shown beside the view");
    // the desktop app on a node with no route to the host: the page through a forwarder here, in a window of its own or beside the view
    if (ctx.client.kind === "ui" && node !== this.deps.nodeId && ctx.client.node === this.deps.nodeId && !this.routable(node)) return this.openAway(node, ctx.client, "window");
    if (ctx.embed && ctx.client.kind === "ui") return this.openBeside(node, ctx.client, ctx.display);
    const address = this.hostAddress(node);
    if (ctx.client.kind === "controller") {
      if (ctx.listener !== "controller") throw new RpcError("unavailable", "a stream page is served on the controller listener only");
      if (!this.config.web) throw new RpcError("unsupported", "this node serves no web viewer: [remote] web is off");
      const ids = await this.web.ensureHost(node, address, ctx.client.id);
      const name = ctx.client.name !== undefined ? { name: ctx.client.name } : {};
      if (ctx.forward) {
        const { ticket, stream } = this.tickets.mint(ctx.client.id, { node, ...ids }, { ...name, transport: "websocket", secureCookie: false });
        this.log.info("web viewer ticket minted", { node, client: ctx.client.id, forward: true });
        return { path: `/remote/?t=${ticket}`, transport: "websocket", node, stream };
      }
      const { ticket, stream } = this.tickets.mint(ctx.client.id, { node, ...ids }, name);
      this.log.info("web viewer ticket minted", { node, client: ctx.client.id });
      return { url: `${ctx.origin}/remote/?t=${ticket}`, stream };
    }
    // A window opens on this machine: only for the desktop app that runs on it.
    if (ctx.client.node !== this.deps.nodeId) throw new RpcError("unsupported", "a viewer window opens only for the desktop app on this machine");
    if (!(await this.moonlight.paired(address))) {
      const pin = randomPin();
      const child = await this.moonlight.pair(address, pin);
      try {
        await this.deps.pairOn(node, { pin, name: this.deps.nodeName }, ctx.client.id);
        // moonlight finishes its half moments after the host's answer and then idles for most of a
        // minute; the app list answering is the proof it kept the pairing, and the process can go.
        const end = this.now() + PAIR_CONFIRM_MS;
        while (!(await this.moonlight.paired(address))) {
          if (this.now() > end) throw new RpcError("unavailable", `the viewer did not keep its pairing with ${node}`);
          await Bun.sleep(500);
        }
      } finally {
        child.kill();
      }
      this.log.info("viewer paired", { node, address });
    }
    // the user's own settings, once saved in Moonlight's window, over Cophyla's picks
    const saved = await moonlightSaved(this.os, this.exec, this.deps.env ?? process.env);
    await this.moonlight.stream(address, "Desktop", saved ? undefined : streamVideo(this.hostDisplay(node, ctx.display)));
    return {};
  }

  /** Opens moonlight-qt's own window on this machine, where its settings are: for the desktop app that runs here. */
  async settings(client: Client): Promise<ClientResult<"remote.open">> {
    if (client.kind !== "ui" || client.node !== this.deps.nodeId) throw new RpcError("unsupported", "Moonlight's window opens only for the desktop app on this machine");
    await this.moonlight.settings();
    return {};
  }

  /**
   * The desktop app shows `node`'s desktop beside its view, the host on its LAN: a ticket to
   * this node's web viewer, served by the stream proxy on this machine's loopback, the video
   * on the page's WebSocket and the page seeded to keep it a few frames behind, at the host's
   * screen size, with the user's pointer hidden over it. The first time, the host is asked
   * once to pair the web viewer.
   */
  private async openBeside(node: string, client: Client, heard?: DisplaySize): Promise<ClientResult<"remote.open">> {
    if (client.node !== this.deps.nodeId) throw new RpcError("unsupported", "a desktop is shown beside the view only in the desktop app on this machine");
    if (!this.config.web) throw new RpcError("unsupported", "this node serves no web viewer: [remote] web is off");
    const ids = await this.web.ensureHost(node, this.hostAddress(node), client.id);
    const video = streamVideo(this.hostDisplay(node, heard));
    const { ticket, stream } = this.tickets.mint(client.id, { node, ...ids }, { ...(client.name !== undefined ? { name: client.name } : {}), transport: "websocket", secureCookie: false, lowLatency: true, video, hideCursor: true });
    this.log.info("web viewer ticket minted beside the view", { node, client: client.id, video: `${video.width}x${video.height}@${video.fps} ${video.bitrate} kbps` });
    return { url: `http://127.0.0.1:${this.loopback.port()}/remote/?t=${ticket}`, stream, video: { width: video.width, height: video.height } };
  }

  /**
   * A stream where there is no route to its host: the host's ticket (this node's own for a
   * phone off its LAN), and for the desktop app on this machine, in a window or beside its
   * view, a forwarder here to read it through, the page seeded to keep the video a few frames
   * behind at the host's screen size, with the user's pointer hidden over it.
   */
  private async openAway(node: string, client: Client, how: "phone" | "window"): Promise<ClientResult<"remote.open">> {
    const self = this.deps.nodeId;
    let opened: { path: string; stream: string; video?: DisplaySize };
    if (node === self) opened = await this.ticket(client.id, client.name, "webrtc");
    else {
      if (!this.deps.links) throw new RpcError("unavailable", `no link to ${node}`);
      const params = { node, viewer: client.id, ...(client.name !== undefined ? { name: client.name } : {}), transport: "webrtc", ...(how === "window" ? { lowLatency: true, sized: true, hideCursor: true } : {}) };
      opened = (await this.deps.links.request(node, "remote.ticket", params, { timeoutMs: 180_000 })) as { path: string; stream: string; video?: DisplaySize };
    }
    const away: Away = { node, client: client.id };
    this.away.set(opened.stream, away);
    this.log.info("stream opened through pipes", { node, client: client.id, how });
    if (how === "phone") return { path: opened.path, transport: "webrtc", node, stream: opened.stream };
    if (!this.deps.pipes) throw new RpcError("unavailable", "this node carries no pipes");
    const forwarder = new Forwarder({ hub: this.deps.pipes, node, log: this.log.child("forwarder"), onClose: () => void this.endAway(opened.stream, client.id) });
    away.forwarder = forwarder;
    const port = forwarder.start();
    return { url: `http://127.0.0.1:${port}${opened.path}`, stream: opened.stream, ...(opened.video ? { video: opened.video } : {}) };
  }

  /**
   * A ticket to this node's own desktop for a viewer with no route here: the stream page's
   * path, its cookie without `Secure` (the page is on the viewer's loopback), its video over
   * WebRTC with this node's TURN servers, seeded for low latency when the viewer asks, sized
   * to this screen at the bitrate the internet carries when it asks that, and with its pointer
   * hidden over the picture. The caller gates it.
   */
  async ticket(viewer: string, name: string | undefined, transport: StreamTransport, opts: { lowLatency?: boolean; sized?: boolean; hideCursor?: boolean } = {}): Promise<{ path: string; stream: string; video?: DisplaySize }> {
    this.requireHost();
    if (!this.config.web) throw new RpcError("unsupported", "this node serves no web viewer: [remote] web is off");
    if (transport === "webrtc") {
      const direct = this.deps.direct;
      if (!direct?.ready) throw new RpcError("unavailable", "the host's direct connections are not on");
      // the stream's own WebRTC reads the TURN servers from the file this writes
      await direct.iceServers();
      const ports = Array.from({ length: WEB_RTC_PORTS.max - WEB_RTC_PORTS.min + 1 }, (_, i) => WEB_RTC_PORTS.min + i);
      void direct.request("map.ports", { ports }).catch(() => undefined);
    }
    const ids = await this.web.ensureHost(this.deps.nodeId, "127.0.0.1", viewer);
    const video = opts.sized ? streamVideo(this.readDisplay(), { away: true }) : undefined;
    const { ticket, stream } = this.tickets.mint(viewer, { node: this.deps.nodeId, ...ids }, { ...(name !== undefined ? { name } : {}), transport, secureCookie: false, ...(opts.lowLatency ? { lowLatency: true } : {}), ...(video ? { video } : {}), ...(opts.hideCursor ? { hideCursor: true } : {}) });
    this.log.info("web viewer ticket minted for a viewer elsewhere", { viewer, transport, ...(video ? { video: `${video.width}x${video.height}@${video.fps} ${video.bitrate} kbps` } : {}) });
    return { path: `/remote/?t=${ticket}`, stream, ...(video ? { video: { width: video.width, height: video.height } } : {}) };
  }

  /** A viewer elsewhere ended its stream here. */
  closeTicket(stream: string, viewer: string): void {
    if (this.tickets.close(stream, viewer)) this.log.info("web viewer closed by a viewer elsewhere", { viewer });
  }

  /** The client ended a stream it opened: its web session, the ticket not yet claimed, or the host's session for one away. */
  close(stream: string, client: string): ClientResult<"remote.close"> {
    if (this.endAway(stream, client)) return {};
    if (this.tickets.close(stream, client)) this.log.info("web viewer closed by its client", { client });
    return {};
  }

  /** Ends a stream shown away from its host: the forwarder here, the session there. */
  private endAway(stream: string, client: string): boolean {
    const away = this.away.get(stream);
    if (!away || away.client !== client) return false;
    this.away.delete(stream);
    away.forwarder?.stop();
    if (away.node === this.deps.nodeId) this.tickets.close(stream, client);
    else void this.deps.links?.request(away.node, "remote.close", { node: away.node, stream, viewer: client }).catch((e: unknown) => this.log.debug("the host did not hear the stream end", { error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  /** One frame of a display, for the brain; the host is not involved. */
  async screenshot(display?: number): Promise<CapabilityResult<"remote.screenshot">> {
    const shot = await this.capture(display, this.config.screenshot_width);
    return { image: { mime: shot.mime, base64: shot.base64 }, width: shot.width, height: shot.height, display: shot.display, at: this.now() };
  }

  /** The link to `node` went: the sessions its viewers opened here end (they are filed under it). */
  linkGone(node: string): void {
    this.tickets.forgetWhere((client) => client.startsWith(`${node}:`));
  }

  /** A client went: the web sessions it opened go with it, here and on hosts elsewhere. */
  onDisconnect(client: string): void {
    this.tickets.forgetClient(client);
    for (const [stream, away] of [...this.away]) if (away.client === client) this.endAway(stream, client);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.moonlight.stop();
    for (const away of this.away.values()) away.forwarder?.stop();
    this.away.clear();
    await this.loopback.stop();
    await this.web.stop().catch(() => undefined);
    await this.stopHostSidecar();
  }
}

/** A bring-up the switch overtook. */
class Superseded extends Error {
  constructor() {
    super("superseded");
    this.name = "Superseded";
  }
}
