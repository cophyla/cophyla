// The controller's side of the link to the node, shaped like the desktop shell's so the view
// host sees no difference: it owns the connection, says `pair.claim` and `hello` for itself,
// keeps the credential, reconnects with backoff while the page is visible, and hands the
// host frames and link states. The shell keeps its credential on the native side and hands
// frames to the page over Tauri events; here the page (or the native app's web view) holds
// it, because there is no other side. `hello`, `pair.claim` and `relay.info` are refused to
// anything that tries to send them through `cophylad_send`.
//
// Two transports carry it: the LAN first, and, when the node handed out relay access at
// pairing, a tunnel through the server relay. The LAN is given a head start, and the relay
// is opened beside it once that passes (or at once when the LAN fails): a LAN out of reach
// then costs the head start, not its whole timeout, and the first of the two to open
// carries the link. A code pairs on the LAN alone. The credential's relay access is asked
// for (`relay.info`) on a LAN hello that finds it missing, so a phone paired while the node
// was signed out gets it later. The native app can also pair through the account
// (`pairAccount`): the sign-in's grant opens a pairing tunnel, `pair.account` on it hands
// the token, the relay access and the LAN listener's pin, and the link comes back up
// through the relay with them, the LAN tried as ever. And a phone may redeem an invite the
// desktop minted (`redeem`): the LAN addresses the invite names, pinned to its key, with
// their head start, and the invite's own relay peer beside them; `invite.redeem` on the first
// to open, then hello on the same LAN socket, or back through the relay on the access the
// node minted for this phone.
//
// A third carries it when the node has direct connections on: a data channel (`p2p`),
// signalled over the relay connection with the core's own `d<n>` requests, which never reach
// the view. Moving between them never drops the link: the new connection says hello, the
// link swaps to it once the node answered, and the old one is kept a few seconds for the
// answers still on their way (`promote`). Two seconds after a hello on the relay, while the
// app is quiet, the core tries the data channel, and again whenever the node says its direct
// connections are ready; a node that does not know them, or refuses, is not asked again on
// this connection, and a try that timed out waits 30 s, then two minutes, then ten. On the
// relay or the data channel the LAN is tried every minute and whenever the network changes,
// and a LAN that answers takes over the same way. A data channel that stops answering has
// the relay opened and promoted beside it before it is gone.
//
// A stream's pipes are the app's too, never the view's: `pipeOpen` asks the node with the
// core's own requests, `pipeSignal` sends a pipe's bytes, window and end on the connection
// that carries the link, and the node's `remote.pipe.*` go to `onPipe` and nowhere else.

import type { AudioCodec, Controller, PairedLan, RelayAccess } from "@cophyla/protocol";
import { EVENT_FRAME, EVENT_STATE } from "@cophyla/viewhost";
import type { LinkSnapshot, LinkState, TauriIo } from "@cophyla/viewhost";
import type { Credential, CredentialStore } from "./pairing.ts";
import type { CandidateInit, Signalling } from "./direct.ts";
import type { Duplex, Transport, TransportKind } from "./transport.ts";

export const RECONNECT_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** Off the LAN, how often the LAN is tried again. */
export const LAN_RETRY_MS = 60_000;
/** How long the LAN has to itself before the relay is opened beside it: a LAN at home answers well within it. */
export const LAN_HEAD_START_MS = 500;
/** After a hello on the relay, how long before the data channel is tried. */
export const UPGRADE_DELAY_MS = 2000;
/** The waits after a data channel that did not open: then the last one, over and over. */
export const UPGRADE_BACKOFF_MS = [30_000, 120_000, 600_000];
/** While the app is busy (a stream shows, the button is held), how often a move is asked again. */
export const QUIET_RETRY_MS = 10_000;
/** How long a connection the link moved off is kept for the answers still on it. */
export const DRAIN_MS = 3000;
/** How long a connection the link would move to has to answer its hello. */
export const PROMOTE_HELLO_MS = 10_000;
/** How long a pipe may take to open: the node may carry it on to another. */
export const PIPE_OPEN_MS = 20_000;
/** Ids of the frames this module sends for itself. */
const CLAIM_ID = "p1";
const HELLO_ID = "p2";
const RELAY_INFO_ID = "p3";
const PROMOTE_ID = "p4";
/** The relay's close code for a token it no longer knows. */
const RELAY_UNAUTHORIZED = 4401;
/** What only this module sends: the handshakes, the relay access, a data channel's signalling. */
const OWN_METHODS = new Set(["hello", "pair.claim", "pair.account", "invite.redeem", "relay.info", "direct.info", "direct.offer", "direct.candidate"]);

export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The snapshot the host sees, plus which transport carries the link, and on a data channel whether TURN carries that. */
export interface CoreSnapshot extends LinkSnapshot {
  via?: TransportKind;
  path?: "direct" | "turn";
}

/** A data channel's duplex: it may say it is failing before it closes, and how it reaches the node. */
export interface P2pDuplex extends Duplex {
  onfailing: (() => void) | null;
  readonly path?: "direct" | "turn";
}

/** The data channel, as the core opens it: over the signalling of the connection it has, keyed from the credential. */
export interface P2pTransport {
  label: string;
  open(sig: Signalling, credential: Credential): Promise<P2pDuplex>;
}

export interface LinkCoreOptions {
  store: CredentialStore;
  /** The name this controller pairs under. */
  name: string;
  /** The LAN transports to try in order, from the credential (its recorded URLs) or the page's own when there is none. */
  lan: (credential: Credential | undefined) => Transport[];
  /** The relay transport for a credential's access; absent in a build that keeps the browser LAN-only. */
  relay?: (access: RelayAccess) => Transport;
  /** The data channel; absent where the page has no WebRTC, or the build keeps to the relay. */
  p2p?: P2pTransport;
  /** Whether the link may move now: false while a stream shows or the button is held. */
  quiet?: () => boolean;
  /** What a fresh credential records beside the token after pairing over `transport`: the LAN URLs (the transport's own by default), the node's address and key in the native app. */
  credentialFor?: (transport: Transport) => Partial<Credential>;
  timers?: Timers;
  now?: () => number;
  random?: () => number;
  lanRetryMs?: number;
  lanHeadStartMs?: number;
  upgradeDelayMs?: number;
  /** A transport opened: the native app learns the node's key here. */
  onOpened?: (transport: Transport, duplex: Duplex) => void;
  /** What a credential records of the LAN listener `pair.account` named: the native app's address and pin. Nothing by default. */
  credentialForLan?: (lan: PairedLan) => Partial<Credential>;
  /** Said in every `hello` beside the credential: the native app's `forward`. */
  helloExtra?: { forward?: boolean };
}

type Handler = (payload: never) => void;

interface Pairing {
  code?: string;
  invite?: { grant: string; secret: string };
  name: string;
  transport?: Transport;
  lans?: Transport[];
  relay?: Transport;
  /** What the credential records of the LAN transport an invite was redeemed over. */
  credentialFor?: (transport: Transport) => Partial<Credential>;
  resolve: (c: Controller) => void;
  reject: (e: Error) => void;
}

/** The ways to a node an invite names, as the platform builds them: its LAN addresses pinned to its key, and its relay peer. */
export interface InviteWays {
  lans: Transport[];
  relay?: Transport;
  credentialFor?: (transport: Transport) => Partial<Credential>;
}

interface Active {
  duplex: Duplex;
  transport: Transport;
}

interface CorePending {
  active: Active;
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

/** An answer from the node that failed, with its code. */
export class CoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

export class LinkCore implements TauriIo {
  private opts: LinkCoreOptions;
  private active?: Active;
  private opening = false;
  private state: CoreSnapshot = { state: "starting", since: 0 };
  private listeners = new Map<string, Set<Handler>>();
  private attempt = 0;
  private timer?: unknown;
  private lanRetryTimer?: unknown;
  private suspended = false;
  private helloDone = false;
  private cred?: Credential;
  private loaded = false;
  /** The relay carries the next attempt: the LAN could not be reached. */
  private useRelay = false;
  /** The codecs this phone speaks, best first, said in every hello; the app sets them once it knows. */
  codecs: AudioCodec[] = ["pcm"];
  /**
   * A pairing in flight: the code, or the invite, or neither when it goes through the account;
   * the transport it goes over (an invite's LAN transports and relay, raced); and what to tell the caller.
   */
  private pairing?: Pairing;
  /** A connection saying hello to take the link over, and the close of the one it would replace if that came first. */
  private promoting?: { candidate: Active; lost?: { code: number; reason: string; active: Active } };
  /** Connections the link moved off, kept for the answers still on them. */
  private draining = new Set<Active>();
  /** The core's own requests (`d<n>`), which never reach the view. */
  private corePending = new Map<string, CorePending>();
  private coreSeq = 0;
  private candidateListeners = new Set<(p: { peer: string; candidate: CandidateInit | null }) => void>();
  private pipeListeners = new Set<(method: string, params: unknown) => void>();
  /** The data channel's tries on this connection: its timer, how far the backoff went, whether the node said no. */
  private upgrade: { timer?: unknown; backoff: number; blocked: boolean; running: boolean; seq: number } = { backoff: 0, blocked: false, running: false, seq: 0 };

  constructor(opts: LinkCoreOptions) {
    this.opts = opts;
  }

  /** Reads the credential once; the host attaches after this. */
  async load(): Promise<Credential | undefined> {
    this.cred = await this.opts.store.read();
    this.loaded = true;
    return this.cred;
  }

  // --- the host's view of it ---------------------------------------------------------------

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (cmd === "cophylad_attach") {
      if (!this.loaded) await this.load();
      this.connect();
      return this.state as T;
    }
    if (cmd === "cophylad_send") {
      const frame = args?.["frame"] as { method?: unknown } | undefined;
      if (!frame || typeof frame !== "object") throw new Error("invalid: a frame must be an object");
      // These are this module's alone; a view may not authenticate, ask for the access, or signal a channel.
      if (OWN_METHODS.has(String(frame.method)) || String(frame.method).startsWith("remote.pipe.")) throw new Error(`denied: ${String(frame.method)} is the controller's own`);
      if (!this.active || this.state.state !== "connected") throw new Error("unavailable: not connected to the node");
      this.active.duplex.send(JSON.stringify(frame));
      return undefined as T;
    }
    throw new Error(`unavailable: unknown command ${cmd}`);
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  private emit(event: string, payload: unknown): void {
    for (const h of this.listeners.get(event) ?? []) (h as (p: unknown) => void)(payload);
  }

  // --- what the page reads ----------------------------------------------------------------------

  get snapshot(): CoreSnapshot {
    return this.state;
  }

  get credential(): Credential | undefined {
    return this.cred;
  }

  /** Bytes the link has not yet put on the wire; 0 when not connected or when the transport cannot tell. */
  backlog(): number {
    return this.active?.duplex.buffered?.() ?? 0;
  }

  /** Which transport carries the link now, if any. */
  get via(): TransportKind | undefined {
    return this.active?.transport.kind;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private timers(): Timers {
    return this.opts.timers ?? REAL_TIMERS;
  }

  private setState(state: LinkState, extra: Partial<CoreSnapshot> = {}): void {
    this.state = { state, since: this.now(), ...extra };
    this.emit(EVENT_STATE, this.state);
  }

  private async saveCredential(next: Credential | undefined): Promise<void> {
    this.cred = next;
    try {
      if (next) await this.opts.store.write(next);
      else await this.opts.store.forget();
    } catch {
      // a store that fails leaves the in-memory credential in force for this run
    }
  }

  // --- connecting -----------------------------------------------------------------------------

  /** Opens a connection, unless one is open or being opened, or the page is hidden. */
  connect(): void {
    if (this.suspended || this.active || this.opening) return;
    if (!this.cred && !this.pairing) {
      // Nothing to authenticate with and no code to spend: the page shows the pairing form.
      this.setState("unauthorized", { error: "not paired" });
      return;
    }
    void this.attemptOnce();
  }

  private relayTransport(): Transport | undefined {
    const access = this.cred?.relay;
    if (!access || !this.opts.relay) return undefined;
    return this.opts.relay(access);
  }

  /** One round: the pairing transport, or the LAN transports and the relay raced (the relay alone once the LAN has failed). */
  private async attemptOnce(): Promise<void> {
    this.opening = true;
    this.setState("connecting");
    this.helloDone = false;
    try {
      if (this.pairing) {
        const pairing = this.pairing;
        try {
          if (pairing.invite) {
            // an invite's ways, raced as the link's own are: its LAN with a head start, its relay peer beside it
            const won = await this.openFirst(pairing.lans ?? [], pairing.relay);
            this.adopt(won.transport, won.duplex);
          } else {
            await this.tryOpen(pairing.transport!);
          }
        } catch (e) {
          // the node could not be reached (or the grant was refused): the caller hears it, and nothing retries a code or a spent grant
          if (this.pairing === pairing) this.pairing = undefined;
          const message = e instanceof Error ? e.message : String(e);
          pairing.reject(new Error(message));
          if (!this.cred) this.setState("unauthorized", { error: message });
        }
        return;
      }
      const relay = this.relayTransport();
      const lans = this.useRelay && relay ? [] : this.opts.lan(this.cred);
      let won: Active;
      try {
        won = await this.openFirst(lans, relay);
      } catch (e) {
        if (this.suspended) return;
        this.opening = false;
        this.onClosed(1006, messageOf(e), undefined);
        return;
      }
      if (this.suspended) {
        won.duplex.close(1000, "paused");
        return;
      }
      this.adopt(won.transport, won.duplex);
    } finally {
      this.opening = false;
    }
  }

  /**
   * Opens the LAN transports in order, and the relay beside them once the LAN's head start
   * has passed or the LAN has failed. The first to open is the one; one that opens after it
   * is closed unused. Rejects when none opens, with the relay's reason when it was tried.
   */
  private openFirst(lans: Transport[], relay: Transport | undefined): Promise<Active> {
    return new Promise<Active>((resolve, reject) => {
      const timers = this.timers();
      let settled = false;
      let running = 0;
      let relayStarted = false;
      let headStart: unknown;
      let lanError = "no way to reach the node";
      let relayError: string | undefined;
      const disarm = (): void => {
        if (headStart !== undefined) timers.clearTimeout(headStart);
        headStart = undefined;
      };
      const opened = (transport: Transport, duplex: Duplex): void => {
        if (settled) {
          duplex.close(1000, "another way answered first");
          return;
        }
        settled = true;
        disarm();
        resolve({ transport, duplex });
      };
      const failed = (): void => {
        if (--running > 0 || settled) return;
        settled = true;
        disarm();
        reject(new Error(relayError ?? lanError));
      };
      const startRelay = (): void => {
        if (!relay || relayStarted || settled || this.suspended) return;
        relayStarted = true;
        running++;
        relay.open().then(
          (duplex) => opened(relay, duplex),
          (e: unknown) => {
            relayError = messageOf(e);
            failed();
          },
        );
      };
      running++;
      if (relay && lans.length > 0) {
        headStart = timers.setTimeout(() => {
          headStart = undefined;
          startRelay();
        }, this.opts.lanHeadStartMs ?? LAN_HEAD_START_MS);
      }
      void (async () => {
        for (const t of lans) {
          if (settled || this.suspended) break;
          try {
            opened(t, await t.open());
            return;
          } catch (e) {
            lanError = messageOf(e);
          }
        }
        // The LAN is out of reach: the relay now, and it carries the reconnects after this one too.
        disarm();
        if (!settled && !this.suspended && relay) this.useRelay = true;
        startRelay();
        failed();
      })();
    });
  }

  /** Opens the pairing's transport; resolves once frames flow, and the claim is sent. */
  private async tryOpen(transport: Transport): Promise<void> {
    const duplex = await transport.open();
    // A pairing goes on in the background: its grant or code is spent by the time it opens.
    if (this.suspended && !this.pairing) {
      duplex.close(1000, "paused");
      throw new Error("paused");
    }
    this.adopt(transport, duplex);
  }

  /** Takes an open transport as the link's, and sends the handshake on it. */
  private adopt(transport: Transport, duplex: Duplex): void {
    const active: Active = { duplex, transport };
    this.active = active;
    this.opening = false;
    duplex.onmessage = (text) => this.onMessage(active, text);
    duplex.onclose = (code, reason) => this.onClosed(code, reason, active);
    this.opts.onOpened?.(transport, duplex);
    this.attempt = 0;
    // a fresh connection: the node may know direct connections now, whatever the last one said
    this.upgrade.blocked = false;
    this.upgrade.backoff = 0;
    if (this.pairing) {
      const p = this.pairing;
      if (p.invite) this.send({ jsonrpc: "2.0", id: CLAIM_ID, method: "invite.redeem", params: { grant: p.invite.grant, secret: p.invite.secret, name: p.name } });
      else if (p.code !== undefined) this.send({ jsonrpc: "2.0", id: CLAIM_ID, method: "pair.claim", params: { code: p.code, name: p.name } });
      else this.send({ jsonrpc: "2.0", id: CLAIM_ID, method: "pair.account", params: { name: p.name } });
      return;
    }
    this.sayHello();
  }

  private helloParams(credential: Credential): Record<string, unknown> {
    return { token: credential.token, kind: "controller", name: credential.name, audio: { in: true, out: true, codecs: this.codecs, played: true }, ...(this.opts.helloExtra ?? {}) };
  }

  private sayHello(): void {
    const credential = this.cred;
    if (!credential) {
      this.setState("unauthorized", { error: "not paired" });
      this.active?.duplex.close();
      return;
    }
    this.send({ jsonrpc: "2.0", id: HELLO_ID, method: "hello", params: this.helloParams(credential) });
  }

  private send(frame: unknown): void {
    this.active?.duplex.send(JSON.stringify(frame));
  }

  private onMessage(active: Active, text: string): void {
    let frame: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string; data?: { code?: string; message?: string } } };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.id === "string" && frame.id.startsWith("d") && this.corePending.has(frame.id)) {
      this.settleCore(frame.id, frame);
      return;
    }
    if (this.active !== active) {
      // A connection the link moved off: the answers to what the view asked on it still reach the view; its notifications are the new one's to give.
      if (this.draining.has(active) && frame.method === undefined && frame.id !== undefined) this.emit(EVENT_FRAME, text);
      return;
    }
    if (frame.id === CLAIM_ID) {
      void this.onClaim(active, frame);
      return;
    }
    if (frame.id === HELLO_ID) {
      this.onHello(active, frame);
      return;
    }
    if (frame.id === RELAY_INFO_ID) {
      void this.onRelayInfo(frame);
      return;
    }
    if (frame.method === "direct.candidate") {
      for (const fn of [...this.candidateListeners]) fn(frame.params as { peer: string; candidate: CandidateInit | null });
      return;
    }
    if (typeof frame.method === "string" && frame.method.startsWith("remote.pipe.")) {
      for (const fn of [...this.pipeListeners]) fn(frame.method, frame.params);
      return;
    }
    if (frame.method === "direct.state") this.onDirectState(frame.params as { node?: string; state?: string });
    // Everything else is the host's: it is handed over as text, as the shell does.
    this.emit(EVENT_FRAME, text);
  }

  private async onClaim(active: Active, frame: { result?: unknown; error?: { data?: { message?: string }; message?: string } }): Promise<void> {
    const pairing = this.pairing;
    this.pairing = undefined;
    if (!pairing) return;
    if (frame.error || !frame.result) {
      const message = frame.error?.data?.message ?? frame.error?.message ?? (pairing.invite ? "that invite is not open" : "that code is not open");
      pairing.reject(new Error(message));
      this.setState("unauthorized", { error: message });
      active.duplex.close();
      return;
    }
    const result = frame.result as { token: string; client: Controller; relay?: RelayAccess; lan?: PairedLan };
    if (pairing.invite ? active.transport.kind === "relay" : pairing.code === undefined) {
      // Through the account, or an invite through its relay peer: that tunnel has done its one job. The
      // credential names the LAN listener the node reported, and the link comes back through the relay with the token.
      const credential: Credential = { ...(result.lan ? (this.opts.credentialForLan?.(result.lan) ?? {}) : {}), token: result.token, controller: result.client.id, name: pairing.name };
      if (result.relay) credential.relay = result.relay;
      await this.saveCredential(credential);
      pairing.resolve(result.client);
      if (this.active === active) {
        this.active = undefined;
        active.duplex.onclose = null;
        active.duplex.close(1000, "paired");
      }
      this.useRelay = credential.relay !== undefined;
      this.attempt = 0;
      this.connect();
      return;
    }
    const extra = pairing.credentialFor?.(active.transport) ?? this.opts.credentialFor?.(active.transport) ?? { lan: [active.transport.label] };
    const credential: Credential = { ...extra, token: result.token, controller: result.client.id, name: pairing.name };
    if (result.relay) credential.relay = result.relay;
    await this.saveCredential(credential);
    pairing.resolve(result.client);
    // Paired: the same connection carries the hello.
    if (this.active === active) this.sayHello();
  }

  private onHello(active: Active, frame: { result?: unknown; error?: { data?: { code?: string; message?: string }; message?: string } }): void {
    if (frame.error || !frame.result) {
      // The node does not know this token any more: the desktop revoked it.
      void this.saveCredential(undefined);
      const message = frame.error?.data?.message ?? frame.error?.message ?? "refused";
      this.setState("unauthorized", { error: message });
      active.duplex.close();
      return;
    }
    this.connected(active, frame.result as LinkSnapshot["hello"]);
  }

  /** A hello answered on `active`, which carries the link from now on. */
  private connected(active: Active, hello: LinkSnapshot["hello"]): void {
    this.helloDone = true;
    const kind = active.transport.kind;
    if (kind !== "p2p") this.useRelay = kind === "relay";
    const path = kind === "p2p" ? (active.duplex as P2pDuplex).path : undefined;
    this.setState("connected", { hello, url: active.transport.label, via: kind, ...(path ? { path } : {}) });
    this.disarmUpgrade();
    if (kind === "lan") {
      this.disarmLanRetry();
      // A phone paired while the node was signed out asks for its relay access on the LAN, once.
      if (!this.cred?.relay && this.opts.relay) this.send({ jsonrpc: "2.0", id: RELAY_INFO_ID, method: "relay.info", params: {} });
      return;
    }
    this.armLanRetry();
    if (kind === "relay") this.armUpgrade(this.opts.upgradeDelayMs ?? UPGRADE_DELAY_MS);
    else (active.duplex as P2pDuplex).onfailing = () => void this.fallBack(active);
  }

  private async onRelayInfo(frame: { result?: unknown; error?: unknown }): Promise<void> {
    if (frame.error || !frame.result || !this.cred) return;
    const r = frame.result as Partial<RelayAccess>;
    if (typeof r.url !== "string" || typeof r.peer !== "string" || typeof r.token !== "string" || typeof r.key !== "string") return;
    await this.saveCredential({ ...this.cred, relay: { url: r.url, peer: r.peer, token: r.token, key: r.key } });
  }

  private onClosed(code: number, reason: string, active: Active | undefined): void {
    if (active && this.active !== active) return;
    if (active) this.failCore(active, reason || `closed ${code}`);
    // A move under way takes over from a connection lost meanwhile, or the loss is taken as it came.
    if (active && this.promoting) {
      this.active = undefined;
      this.promoting.lost = { code, reason, active };
      return;
    }
    this.active = undefined;
    this.lost(code, reason, active);
  }

  /** The link is down: a pairing cut off is settled, a refusal waits for the user, anything else reconnects. */
  private lost(code: number, reason: string, active: Active | undefined): void {
    this.disarmLanRetry();
    this.disarmUpgrade();
    // A pairing cut off before its answer is settled here, once: its grant or code is spent,
    // so opening its transport again could only be refused.
    const pairing = this.pairing;
    if (pairing) {
      this.pairing = undefined;
      const message = pairing.invite
        ? "the connection closed before the node answered: open the invite again"
        : pairing.code === undefined
          ? "the sign-in was cut off before the node answered: sign in again"
          : "the connection closed before the node answered: pair again";
      pairing.reject(new Error(message));
      if (!this.cred) {
        this.setState("unauthorized", { error: message });
        return;
      }
    }
    if (this.suspended) {
      this.setState("disconnected", { error: "paused" });
      return;
    }
    // A refusal is not retried on a loop: the page has something to say to the user.
    if (this.state.state === "unauthorized") return;
    // The relay no longer knows the token (revoked, or a fresh grant replaced it): the LAN, and `relay.info` there.
    if (active?.transport.kind === "relay" && code === RELAY_UNAUTHORIZED && this.cred?.relay) {
      const { relay: _gone, ...rest } = this.cred;
      void this.saveCredential(rest);
      this.useRelay = false;
    }
    this.setState("disconnected", { error: reason || `closed ${code}` });
    if (!this.cred) return;
    this.schedule();
  }

  private schedule(): void {
    const timers = this.timers();
    if (this.timer !== undefined) timers.clearTimeout(this.timer);
    const random = this.opts.random ?? Math.random;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MS * 2 ** this.attempt++);
    // Jitter, so a node coming back does not meet every phone at once.
    const delay = Math.round(base * (0.8 + 0.4 * random()));
    this.timer = timers.setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }

  // --- moving the link without dropping it --------------------------------------------------------

  /**
   * Makes `duplex` the link's if the node answers its hello: the link swaps to it, the view
   * hears the new hello with no gap, and the connection it came off is kept for the answers
   * still on it. A hello refused, or not answered in time, closes the new one and leaves the
   * link where it was.
   */
  private promote(transport: Transport, duplex: Duplex): Promise<boolean> {
    const credential = this.cred;
    if (!credential || !this.active || this.promoting || this.suspended) {
      duplex.close(1000, "the link is not there to move");
      return Promise.resolve(false);
    }
    const candidate: Active = { duplex, transport };
    const promoting: NonNullable<LinkCore["promoting"]> = { candidate };
    this.promoting = promoting;
    const timers = this.timers();
    return new Promise<boolean>((resolve) => {
      let done = false;
      const give = (ok: boolean, why: string): void => {
        if (done) return;
        done = true;
        timers.clearTimeout(timer);
        if (this.promoting === promoting) this.promoting = undefined;
        if (!ok) {
          duplex.onmessage = null;
          duplex.onclose = null;
          duplex.close(1000, why);
          // the connection it would have replaced went meanwhile: that loss is taken now
          if (promoting.lost) this.lost(promoting.lost.code, promoting.lost.reason, promoting.lost.active);
        }
        resolve(ok);
      };
      const timer = timers.setTimeout(() => give(false, "no answer to the hello"), PROMOTE_HELLO_MS);
      duplex.onclose = () => give(false, "closed");
      duplex.onmessage = (text) => {
        let frame: { id?: unknown; result?: unknown; error?: unknown };
        try {
          frame = JSON.parse(text) as typeof frame;
        } catch {
          return;
        }
        if (frame.id !== PROMOTE_ID) return;
        if (frame.error || !frame.result || this.suspended || (!this.active && !promoting.lost)) {
          give(false, frame.error ? "hello refused" : "the link moved on");
          return;
        }
        done = true;
        timers.clearTimeout(timer);
        this.promoting = undefined;
        const old = this.active;
        this.active = candidate;
        duplex.onmessage = (t) => this.onMessage(candidate, t);
        duplex.onclose = (code, reason) => this.onClosed(code, reason, candidate);
        this.opts.onOpened?.(transport, duplex);
        if (old) this.drain(old);
        this.connected(candidate, frame.result as LinkSnapshot["hello"]);
        resolve(true);
      };
      duplex.send(JSON.stringify({ jsonrpc: "2.0", id: PROMOTE_ID, method: "hello", params: this.helloParams(credential) }));
    });
  }

  /** The connection the link moved off: its answers still reach the view for a few seconds, then it closes. */
  private drain(old: Active): void {
    this.draining.add(old);
    old.duplex.onclose = () => {
      this.draining.delete(old);
      this.failCore(old, "moved");
    };
    this.timers().setTimeout(() => {
      if (!this.draining.delete(old)) return;
      old.duplex.onclose = null;
      this.failCore(old, "moved");
      old.duplex.close(1000, "the link moved");
    }, DRAIN_MS);
  }

  /** The data channel is failing: the relay is opened beside it and takes the link over, before the channel is lost. */
  private async fallBack(active: Active): Promise<void> {
    if (this.active !== active || this.suspended) return;
    const relay = this.relayTransport();
    if (!relay) return;
    let duplex: Duplex;
    try {
      duplex = await relay.open();
    } catch {
      // the channel's own close brings the reconnect
      return;
    }
    if (this.active === active) {
      await this.promote(relay, duplex);
      return;
    }
    if (!this.active && !this.opening && !this.suspended && this.cred) {
      // the channel went while the relay opened: the relay carries the link, as the reconnect would have
      if (this.timer !== undefined) this.timers().clearTimeout(this.timer);
      this.timer = undefined;
      this.adopt(relay, duplex);
      return;
    }
    duplex.close(1000, "the link moved on");
  }

  // --- a stream's pipes, the app's own ----------------------------------------------------------

  /** Opens a pipe toward `node`'s stream proxy on the connection that carries the link. */
  pipeOpen(node: string): Promise<{ pipe: string; window: number }> {
    const active = this.active;
    if (!active || this.state.state !== "connected") return Promise.reject(new CoreError("unavailable", "not connected to the node"));
    return this.coreRequest(active, "remote.pipe.open", { node }, PIPE_OPEN_MS) as Promise<{ pipe: string; window: number }>;
  }

  /** A pipe's bytes, window or end, on the connection that carries the link. */
  pipeSignal(method: "remote.pipe.data" | "remote.pipe.ack" | "remote.pipe.close", params: unknown): void {
    if (this.active && this.state.state === "connected") this.active.duplex.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Hears the node's `remote.pipe.*`; the view never does. */
  onPipe(fn: (method: string, params: unknown) => void): () => void {
    this.pipeListeners.add(fn);
    return () => this.pipeListeners.delete(fn);
  }

  // --- the core's own requests, for the signalling ---------------------------------------------

  private signalling(active: Active): Signalling {
    return {
      request: (method, params, timeoutMs) => this.coreRequest(active, method, params, timeoutMs),
      signal: (method, params) => {
        if (this.active === active) active.duplex.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      },
      onCandidate: (fn) => {
        this.candidateListeners.add(fn);
        return () => this.candidateListeners.delete(fn);
      },
    };
  }

  private coreRequest(active: Active, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.active !== active) return Promise.reject(new CoreError("unavailable", "the link moved"));
    const id = `d${++this.coreSeq}`;
    const timers = this.timers();
    return new Promise<unknown>((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        this.corePending.delete(id);
        reject(new CoreError("timeout", `${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.corePending.set(id, { active, method, resolve, reject, timer });
      active.duplex.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private settleCore(id: string, frame: { result?: unknown; error?: { message?: string; data?: { code?: string; message?: string } } }): void {
    const p = this.corePending.get(id)!;
    this.corePending.delete(id);
    this.timers().clearTimeout(p.timer);
    if (frame.error) p.reject(new CoreError(frame.error.data?.code ?? "unavailable", frame.error.data?.message ?? frame.error.message ?? `${p.method} failed`));
    else p.resolve(frame.result);
  }

  private failCore(active: Active, reason: string): void {
    for (const [id, p] of this.corePending) {
      if (p.active !== active) continue;
      this.corePending.delete(id);
      this.timers().clearTimeout(p.timer);
      p.reject(new CoreError("unavailable", `${p.method}: ${reason}`));
    }
  }

  // --- the data channel, tried while on the relay --------------------------------------------------

  private armUpgrade(delayMs: number): void {
    this.disarmUpgrade();
    if (!this.opts.p2p || this.upgrade.blocked || !this.cred?.relay) return;
    if (this.active?.transport.kind !== "relay") return;
    this.upgrade.timer = this.timers().setTimeout(() => {
      this.upgrade.timer = undefined;
      void this.tryUpgrade();
    }, delayMs);
  }

  private disarmUpgrade(): void {
    if (this.upgrade.timer !== undefined) this.timers().clearTimeout(this.upgrade.timer);
    this.upgrade.timer = undefined;
  }

  /** The node said its direct connections are ready: a relay link tries the channel now. */
  private onDirectState(p: { node?: string; state?: string }): void {
    if (p?.state !== "ready" || p.node !== this.state.hello?.node) return;
    if (this.active?.transport.kind !== "relay" || this.upgrade.running) return;
    this.upgrade.backoff = 0;
    this.armUpgrade(0);
  }

  private async tryUpgrade(): Promise<void> {
    const active = this.active;
    const p2p = this.opts.p2p;
    const credential = this.cred;
    if (!p2p || !credential || !active || active.transport.kind !== "relay" || this.suspended || this.upgrade.running || this.promoting) return;
    if (this.opts.quiet && !this.opts.quiet()) {
      this.armUpgrade(QUIET_RETRY_MS);
      return;
    }
    this.upgrade.running = true;
    const seq = ++this.upgrade.seq;
    try {
      const duplex = await p2p.open(this.signalling(active), credential);
      if (seq !== this.upgrade.seq || this.active !== active || this.suspended) {
        duplex.close(1000, "the link moved on");
        return;
      }
      const transport: Transport = { kind: "p2p", label: p2p.label, open: () => Promise.reject(new Error("a data channel opens over the link")) };
      if (await this.promote(transport, duplex)) this.upgrade.backoff = 0;
      else this.backOffUpgrade();
    } catch (e) {
      const code = codeOf(e);
      // a node without direct connections, or one that refuses this phone, is not asked again on this connection
      if (code === "unsupported" || code === "denied") this.upgrade.blocked = true;
      // switched off or not up yet: its `direct.state` says when it is
      else if (code !== "unavailable") this.backOffUpgrade();
    } finally {
      this.upgrade.running = false;
    }
  }

  private backOffUpgrade(): void {
    const delay = UPGRADE_BACKOFF_MS[Math.min(this.upgrade.backoff, UPGRADE_BACKOFF_MS.length - 1)]!;
    this.upgrade.backoff++;
    this.armUpgrade(delay);
  }

  // --- the LAN, tried again while off it ----------------------------------------------------------

  private armLanRetry(): void {
    this.disarmLanRetry();
    this.lanRetryTimer = this.timers().setTimeout(() => {
      this.lanRetryTimer = undefined;
      void this.retryLan();
    }, this.opts.lanRetryMs ?? LAN_RETRY_MS);
  }

  private disarmLanRetry(): void {
    if (this.lanRetryTimer !== undefined) this.timers().clearTimeout(this.lanRetryTimer);
    this.lanRetryTimer = undefined;
  }

  /** Off the LAN: tries it now (the timer fired, or the network changed); a LAN that answers takes the link over. */
  async retryLan(): Promise<boolean> {
    const active = this.active;
    if (!active || active.transport.kind === "lan" || this.suspended || this.opening || this.promoting) return false;
    this.disarmLanRetry();
    if (this.opts.quiet && !this.opts.quiet()) {
      this.armLanRetry();
      return false;
    }
    for (const t of this.opts.lan(this.cred)) {
      let duplex: Duplex;
      try {
        duplex = await t.open();
      } catch {
        continue;
      }
      if (this.active !== active) {
        duplex.close(1000, "the link moved on");
        return false;
      }
      this.useRelay = false;
      this.attempt = 0;
      if (await this.promote(t, duplex)) return true;
    }
    if (this.active === active) this.armLanRetry();
    return false;
  }

  /** The phone's network changed: the LAN is tried at once, and on the relay the data channel is tried afresh. */
  async networkChanged(): Promise<void> {
    this.upgrade.backoff = 0;
    const kind = this.active?.transport.kind;
    if (kind === undefined || kind === "lan") return;
    const moved = await this.retryLan();
    if (!moved && this.active?.transport.kind === "relay" && !this.upgrade.running) this.armUpgrade(this.opts.upgradeDelayMs ?? UPGRADE_DELAY_MS);
  }

  // --- what the page drives ---------------------------------------------------------------------

  /** Spends a pairing code over the LAN: opens a connection, claims, and says hello on the same one. */
  pair(code: string, name: string, transport?: Transport): Promise<Controller> {
    return new Promise<Controller>((resolve, reject) => {
      const t = transport ?? this.opts.lan(undefined)[0];
      if (!t) {
        reject(new Error("no node address to pair with"));
        return;
      }
      if (this.active) {
        if (this.helloDone) {
          reject(new Error("already paired"));
          return;
        }
        // A connection that is open but unauthenticated: claim on it.
        this.pairing = { code, name, transport: t, resolve, reject };
        this.send({ jsonrpc: "2.0", id: CLAIM_ID, method: "pair.claim", params: { code, name } });
        return;
      }
      this.pairing = { code, name, transport: t, resolve, reject };
      this.suspended = false;
      this.connect();
    });
  }

  /**
   * Pairs through the account: `transport` is the pairing tunnel the sign-in's grant opens
   * (`pairingTransport`); `pair.account` on it, then the relay with the new token.
   */
  pairAccount(name: string, transport: Transport): Promise<Controller> {
    return new Promise<Controller>((resolve, reject) => {
      if (this.active && this.helloDone) {
        reject(new Error("already paired"));
        return;
      }
      if (this.pairing) {
        reject(new Error("a pairing is already under way"));
        return;
      }
      // an unauthenticated connection has nothing to offer this pairing
      if (this.active) {
        const stale = this.active;
        this.active = undefined;
        stale.duplex.onclose = null;
        stale.duplex.close(1000, "pairing through the account");
      }
      this.pairing = { name, transport, resolve, reject };
      this.suspended = false;
      this.connect();
    });
  }

  /**
   * Redeems an invite from the desktop over the ways it names: `invite.redeem` on the first to
   * open, then hello on the same LAN socket, or the link back through the relay on the access
   * the node minted for this phone. A redemption cut off is settled once; the node opens the
   * invite again for a phone that never got its answer.
   */
  redeem(invite: { grant: string; secret: string }, name: string, ways: InviteWays): Promise<Controller> {
    return new Promise<Controller>((resolve, reject) => {
      if (this.active && this.helloDone) {
        reject(new Error("this phone is paired already: forget it first"));
        return;
      }
      if (this.pairing) {
        reject(new Error("a pairing is already under way"));
        return;
      }
      if (ways.lans.length === 0 && !ways.relay) {
        reject(new Error("no way to reach the node that sent the invite from here"));
        return;
      }
      if (this.active) {
        const stale = this.active;
        this.active = undefined;
        stale.duplex.onclose = null;
        stale.duplex.close(1000, "redeeming an invite");
      }
      this.pairing = { invite, name, lans: ways.lans, ...(ways.relay ? { relay: ways.relay } : {}), ...(ways.credentialFor ? { credentialFor: ways.credentialFor } : {}), resolve, reject };
      this.suspended = false;
      this.connect();
    });
  }

  /** Drops the credential and the connection: the phone is not paired any more. */
  forget(): void {
    void this.saveCredential(undefined);
    this.useRelay = false;
    this.setState("unauthorized", { error: "not paired" });
    this.active?.duplex.close();
    this.active = undefined;
    this.disarmLanRetry();
    this.disarmUpgrade();
  }

  /**
   * The page went away: close the connection and stop reconnecting. A pairing in flight is
   * left to finish — the browser handing back, or a second tap on Sign in, pauses the app
   * for a moment, and what the pairing spent cannot be spent twice; the credential it brings
   * back waits for `resume`.
   */
  suspend(): void {
    this.suspended = true;
    const timers = this.timers();
    if (this.timer !== undefined) timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.disarmLanRetry();
    this.disarmUpgrade();
    this.upgrade.seq++;
    if (this.pairing) return;
    this.active?.duplex.close();
    this.active = undefined;
    for (const old of [...this.draining]) {
      this.draining.delete(old);
      old.duplex.onclose = null;
      old.duplex.close(1000, "paused");
    }
    this.setState("disconnected", { error: "paused" });
  }

  /** The page is back: the LAN is tried first again. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.attempt = 0;
    this.useRelay = false;
    this.connect();
  }
}
