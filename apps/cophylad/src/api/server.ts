// The WebSocket and HTTP server: token auth on `hello`, JSON-RPC dispatch through the gate,
// and the notification stream to every authenticated client. One `startApi` serves one
// listener, and a node runs one or two: the loopback api the desktop app speaks to, and,
// when `[controller]` is on or other nodes may link here, a second one on the LAN over TLS
// that serves the controller app, its views, a second `/ws/client` and `/ws/node`. Both
// register their clients in one `ClientRegistry`, so a notification reaches a phone and a
// desktop alike; the loopback listener owns the bus subscription and broadcasts through
// that registry.
//
// Two seams belong to the nodes module. On a primary, a client of a linked secondary is
// relayed here frame for frame: `relayHost` registers it as a virtual client (listener
// `relay`) whose socket writes go back down the link, and dispatches its frames as if they
// had arrived on a socket. On a secondary that is linked, `hello` on its own listeners
// answers from the primary through `nodes.relay`, and the socket is registered as `relayed`:
// its frames are tunnelled verbatim, but for the requests about this node itself: `view.stage`
// (a URL from the primary is one this client cannot fetch), the pairing and controller
// requests (the phones paired here are this node's rows) and `remote.open` (the viewer runs
// where the client is). The controller listener also serves the remote-desktop proxy under
// `/remote`: a stream page and its socket, behind a ticket `remote.open` minted.
//
// A third way in arrived with milestone 12: a paired phone's tunnel through the server
// relay, decrypted by the cloud module and handed here as `acceptTunnel`. It is served
// exactly like a socket on this listener (the same `hello` by controller token, the same
// gate, the same audit), under the listener kind `cloud`: `pair.claim` never happens over
// it (a code is the LAN's), and `view.stage` and `remote.open` answer `unsupported` there,
// since a phone on another network cannot fetch this node's URLs. Since 12.1 a tunnel may
// also be a pairing one — a phone that signed in with the account and has no token yet —
// and that socket answers `pair.account` and nothing else, not even `hello`. Since grants a
// phone may also come with an invite: `invite.redeem` before `hello` on the LAN listener, or
// on a tunnel of the invite's own throwaway peer, which answers that and nothing else.
//
// Neither pairing puts its secrets in the audit: the token and the relay access are minted
// inside the gate, but the row records the controller alone and the phone gets the rest
// outside it.
//
// A client is what its credential lets it be: the desktop's shared token is everything, a
// phone is its grant's scopes and access (`Client.access`). A limited phone's requests pass
// the protocol's filter tables inside the gate, so a refusal is audited like any outcome; its
// lists come back cut to what it reaches, its welcome and every notification after it too
// (the registry's filter), and its signals need their scopes. A secondary's client relayed
// here is held to this node's own row of its grant when there is one, else to the access the
// secondary reports, else is a desktop on that node.

import { timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import {
  clientRequests,
  clientSignals,
  ControllerId,
  failure,
  FULL,
  newId,
  notification,
  notificationScopes,
  PROTOCOL_VERSION,
  protocolError,
  refuseRequest,
  requestScopes,
  RpcError,
  RpcMessage,
  signalScopes,
  success,
  validateAccess,
} from "@cophyla/protocol";
import type { Access, Ask, AudioCodec, Client, ClientNotificationName, ClientNotificationParams, ClientRequestName, ClientResult, ClientSignalName, Controller, Node, NodeRecord, PairedLan, RelayAccess, RiskClass, RpcRequest, Session, Task, Terminal, TurnProgress, Workspace } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Config } from "../config/schema.ts";
import type { Asks } from "../gate/asks.ts";
import { toldToClients } from "../gate/audit.ts";
import type { Gate } from "../gate/index.ts";
import type { Policy } from "../gate/policy.ts";
import type { Logger } from "../log.ts";
import { clientResult, clientRow, ClientRegistry, forAccess } from "./clients.ts";
import type { ClientSocket, ListenerKind, SendOptions } from "./clients.ts";
import type { Redeemed } from "../grants/phones.ts";
import type { Grants } from "../grants/store.ts";
import { handleHook } from "./hooks.ts";
import type { HookHarness, HookIngress } from "./hooks.ts";
import type { MethodContext, MethodTable, SignalTable } from "./methods.ts";
import type { Pairing } from "./pairing.ts";
import { isBuilt, NOT_BUILT_PAGE, serveStatic } from "./static.ts";
import { RemoteProxy } from "../remote/proxy.ts";
import type { Bridge } from "../remote/proxy.ts";
import { viewHeaders, ViewTickets } from "./tickets.ts";
import { lanAddress } from "./tls.ts";

type UpdateState = ClientNotificationParams<"update.state">;
type VoiceStateParams = ClientNotificationParams<"voice.state">;
type VoiceSetupParams = ClientNotificationParams<"voice.setup">;
type HelloResult = ClientResult<"hello">;
type RemoteStateParams = ClientNotificationParams<"remote.state">;
type DirectStateParams = ClientNotificationParams<"direct.state">;
type AccountStateParams = ClientNotificationParams<"account.state">;
type HelloInfo = { kind: Client["kind"]; name?: string; node?: string; audio: Client["audio"] };

/** What a client hears right after `hello`, beside the open asks. */
export interface InitialState {
  sessions: Session[];
  workspaces: Workspace[];
  /** The node's terminals, sent after the sessions to a client that reads sessions. */
  terminals?: Terminal[];
  tasks?: Task[];
  updates?: UpdateState[];
  /** The voice conversations in flight and the engine bootstrap, if one is running. */
  voice?: { states?: VoiceStateParams[]; setup?: VoiceSetupParams[] };
  /** The brain's turn in progress, if one is running: a client that connects mid-turn sees what it is doing. */
  progress?: TurnProgress;
  /** Open asks held on other nodes, sent after this node's own. */
  asks?: Ask[];
  /** Every node of the user, sent as `node.state` after the workspaces. */
  nodes?: NodeRecord[];
  /** Every node's last `remote.state`, sent after the nodes to a client with the `remote` scope. */
  remote?: RemoteStateParams[];
  /** The account as this node sees it, sent to a client with the `account` scope. */
  account?: AccountStateParams;
  /** Every node's last `direct.state`, sent after the account to a client with the `account` scope. */
  direct?: DirectStateParams[];
}

/** A socket a node link arrives on: what the nodes module gets to speak through; a tunnel's also carries relayed clients, whose urgent frames go first. */
export interface NodeSocket {
  send(text: string, opts?: SendOptions): void;
  /** A sealed socket's settles once what was queued has left and its transport was told. */
  close(code: number, reason: string): void | Promise<void>;
  remote: string;
  /** Bytes waiting to leave, where the socket can tell: a data channel's. */
  buffered?(): number;
}

export interface NodeSocketHandler {
  message(text: string): void;
  close(code: number, reason: string): void;
  /** A data channel's route changed: TURN or straight. */
  setPath?(path: "direct" | "turn"): void;
}

/** The nodes module's two seams into a listener: accepting links, and relaying this node's clients up. */
export interface NodesSeams {
  /** Whether `/ws/node` is open here now. */
  accepting?: () => boolean;
  acceptSocket?: (sock: NodeSocket) => NodeSocketHandler;
  relay?: RelayUplink;
}

/** What a relayed client authenticated as on the node it came to: its grant there, and that grant's access. */
export interface RelayedAs {
  grant?: string;
  access?: Access;
}

/** On a secondary: a client's hello answered by the primary, its frames tunnelled from then on. */
export interface RelayUplink {
  linked(): boolean;
  open(peer: string, info: HelloInfo, origin: string, port: ClientSocket, as?: RelayedAs): Promise<HelloResult>;
  frame(peer: string, text: string): void;
  close(peer: string): void;
}

/** On a primary: the relayed clients of a secondary, served as if on a socket here. */
export interface RelayHost {
  open(info: HelloInfo, origin: string, port: ClientSocket, relayedBy: string, as?: RelayedAs): Promise<{ client: Client; result: HelloResult }>;
  frame(clientId: string, text: string): void;
  close(clientId: string): void;
}

export interface ApiDeps {
  config: Config;
  log: Logger;
  gate: Gate;
  policy: Policy;
  asks: Asks;
  bus: Bus;
  /** Every client of the node, on either listener. */
  registry: ClientRegistry;
  /** What `hello` accepts: the shared token on loopback, a paired controller's token anywhere. */
  auth: { shared?: string; grants?: Grants };
  /** The pairing window; only a listener that has one answers `pair.claim`. */
  pairing?: Pairing;
  /** Staged view files, served under `/view/<ticket>/…` on this listener. */
  tickets?: ViewTickets;
  /** The controller app's directory, served from `/`. */
  static?: string;
  node: () => Node;
  methods: MethodTable;
  /** Signal handlers: notifications from a client that get no response and no audit row. */
  signals?: SignalTable;
  platformVersion: string;
  /** What `hello` tells a client of the node's audio: the codecs `voice.audio` may use. */
  audio?: { codecs: AudioCodec[] };
  /** The hook ingress behind `/hooks/<harness>`; absent in a daemon without the sessions module. */
  hooks?: HookIngress;
  /** What a new client is told right after `hello`, beside the open asks. */
  initial?: () => InitialState;
  /** A client went away. */
  onDisconnect?: (client: Client) => void;
  nodes?: NodesSeams;
  /** The remote-desktop proxy under `/remote`, on the controller listener: the phone's stream page and its socket. */
  remote?: RemoteProxy;
  /** The relay access a freshly paired phone gets with its token, when the cloud can mint it now; nothing otherwise. */
  relayAccess?: (controller: string, name: string) => Promise<RelayAccess | undefined>;
  /** A phone that signed in with the account, on its pairing tunnel: the controller, its token, its relay access and the LAN listener's pin. */
  accountPairing?: (name: string, login: string) => Promise<AccountPaired>;
  /** A controller whose pairing answer found the tunnel gone: the phone never got its token, so the row and its relay access go. */
  abandonPairing?: (controller: string) => void;
  /** A phone's invite redeemed: its token, row, relay access and LAN pin, and what to do once it has them or has gone. */
  redeemInvite?: (p: { grant: string; secret: string }, via: { peer?: string }) => Promise<Redeemed>;
}

/** What `pair.account` answers. */
export interface AccountPaired {
  token: string;
  client: Controller;
  relay: RelayAccess;
  lan?: PairedLan;
}

/**
 * A tunnel's socket as the cloud module hands it over, with the account a pairing phone
 * signed in as; or a phone's data channel (`p2p`), which belongs to the controller it was
 * keyed for and says how it reaches the node.
 */
export interface TunnelOptions {
  pairing?: { login: string };
  /** The throwaway relay peer of a phone's invite: the tunnel answers `invite.redeem` for it alone. */
  invite?: { grant: string; peer: string };
  listener?: "cloud" | "p2p";
  controller?: string;
  path?: "direct" | "turn";
}

export interface ListenerOptions {
  host?: string;
  port?: number;
  tls?: { key: string; cert: string };
  listener?: ListenerKind;
}

interface Connection {
  kind: "client" | "node" | "remote";
  client?: Client;
  listener: ListenerKind;
  /** The origin this socket reached the node on, from the request's `Host`. */
  origin: string;
  /** An id for the gate before `hello`, so a `pair.claim` is audited under something stable. */
  provisional: string;
  helloTimer?: ReturnType<typeof setTimeout>;
  /** A claim already succeeded on this socket; a second one is a conflict. */
  claimed?: boolean;
  failedClaims: number;
  /** The peer id this socket is relayed to the primary under. */
  relayed?: string;
  /** A pairing tunnel: the phone signed in with the account as this login, and has no token yet. */
  pairing?: { login: string };
  /** An invite's tunnel: the grant it redeems and the throwaway peer it came in on. */
  invite?: { grant: string; peer: string };
  /** The invite redeemed on an invite's tunnel: its throwaway peer goes when the phone closes it. */
  redeemed?: Redeemed;
  /** The socket has closed: an answer still being made has nobody to go to. */
  closed?: boolean;
  remote: string;
  nodeHandler?: NodeSocketHandler;
  /** A remote-desktop stream socket, bridged to the web viewer. */
  bridge?: Bridge;
  /** The connection over this socket, for a client socket. */
  conn?: Conn;
  /** The client shows a stream page through a forwarder of its own (`hello`'s `forward`). */
  forward?: boolean;
  /** A data channel: the controller it was keyed for, and how it reaches the node. */
  boundController?: string;
  path?: "direct" | "turn";
}

/** A client's socket as the dispatcher sees it: where to write, and where the client came in. */
export interface Port extends ClientSocket {
  origin: string;
  listener: ListenerKind;
  forward?: boolean;
}

/** One client connection, whatever carries it: Bun's socket on a listener, or a relay tunnel. */
interface Conn {
  data: Connection;
  send(text: string, opts?: SendOptions): void;
  close(code: number, reason: string): void;
  remoteAddress: string;
  buffered?(): number;
}

const HELLO_DEADLINE_MS = 5000;
const STOP_WAIT_MS = 200;
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_ROLE_CHANGED = 4409;
const MAX_PAYLOAD = 16 * 1024 * 1024;
/** Wrong codes one socket may try before it is closed. */
const MAX_CLAIMS_PER_SOCKET = 3;


/** A `Host` header safe to put in a URL and a content-security policy. */
const HOST = /^[A-Za-z0-9._-]+(:\d{1,5})?$/;
const HOST_IPV6 = /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

export interface ApiServer {
  port: number;
  url: string;
  /** How this listener is reached from outside: `https://192.168.1.44:4818` on the LAN. */
  origin: string;
  clients(): Client[];
  broadcast<N extends ClientNotificationName>(method: N, params: ClientNotificationParams<N>): void;
  /** Serves relayed clients of linked secondaries through this listener's methods. */
  relayHost: RelayHost;
  /** A paired phone's tunnel through the server relay, served like a socket here under the `cloud` listener kind; a pairing one answers `pair.account` alone. */
  acceptTunnel(sock: NodeSocket, opts?: TunnelOptions): NodeSocketHandler;
  stop(): Promise<void>;
}

export { CLOSE_ROLE_CHANGED };

export function startApi(deps: ApiDeps, opts: ListenerOptions = {}): ApiServer {
  const listener: ListenerKind = opts.listener ?? "loopback";
  const log = deps.log.child(listener === "loopback" ? "api" : "controller");
  const registry = deps.registry;
  const scheme = opts.tls ? "https" : "http";
  /** Connections of this listener, so stopping one does not close the other's. */
  const sockets = new Map<string, Conn>();

  const send = (ws: Conn, message: unknown) => {
    ws.send(JSON.stringify(message));
  };
  const portOf = (ws: Conn): Port => ({ send: (data, o) => ws.send(data, o), close: (code, reason) => ws.close(code ?? 1000, reason ?? ""), buffered: () => ws.buffered?.() ?? 0, origin: ws.data.origin, listener: ws.data.listener, ...(ws.data.forward ? { forward: true } : {}) });

  const broadcast: ApiServer["broadcast"] = (method, params) => registry.broadcast(method, params);

  // The loopback listener owns the bus: it broadcasts through the shared registry, which
  // holds the controller listener's clients too, so one subscription serves both. A
  // session's events go to the clients watching it and its row to everyone only when what it
  // is doing changed; the audit entry of a read or of the brain's own bookkeeping is kept, not
  // streamed (`toldToClients`); a row carries no archive summary or tags (`clientRow`).
  const unsubscribe =
    listener === "loopback"
      ? [
          deps.bus.on("ask.state", (ask) => broadcast("ask.state", ask)),
          deps.bus.on("audit.entry", (entry) => toldToClients(entry) && broadcast("audit.entry", entry)),
          deps.bus.on("session.state", (session) => registry.broadcastSession(session)),
          deps.bus.on("session.event", (event) => registry.broadcastEvent(event)),
          deps.bus.on("terminal.state", (terminal) => broadcast("terminal.state", terminal)),
          deps.bus.on("workspace.state", (workspace) => registry.broadcastWorkspace(workspace)),
          deps.bus.on("chat.message", (message) => broadcast("chat.message", { message })),
          deps.bus.on("chat.delta", (delta) => broadcast("chat.delta", delta)),
          deps.bus.on("chat.retract", (retract) => broadcast("chat.retract", retract)),
          deps.bus.on("chat.progress", (progress) => broadcast("chat.progress", progress)),
          deps.bus.on("task.state", (task) => broadcast("task.state", task)),
          deps.bus.on("thread.state", (thread) => registry.broadcastThread(thread)),
          deps.bus.on("update.state", (state) => broadcast("update.state", state)),
          deps.bus.on("view.changed", (changed) => broadcast("view.changed", changed)),
          deps.bus.on("voice.state", (state) => broadcast("voice.state", state)),
          deps.bus.on("voice.setup", (setup) => broadcast("voice.setup", setup)),
          deps.bus.on("node.state", (node) => broadcast("node.state", node)),
          deps.bus.on("remote.state", (state) => broadcast("remote.state", state)),
          deps.bus.on("account.state", (state) => broadcast("account.state", state)),
          deps.bus.on("direct.state", (state) => broadcast("direct.state", state)),
        ]
      : [];

  const tokenMatches = (candidate: string, expected: string): boolean => {
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const armHello = (ws: Conn) => {
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = setTimeout(() => {
      if (!ws.data.client) ws.close(CLOSE_UNAUTHENTICATED, "no hello");
    }, HELLO_DEADLINE_MS);
  };

  /** What a client hears right after `hello`: every open prompt, live session, workspace, task and node, as far as its scopes and its access reach. */
  const welcome = (port: Port, client: Client) => {
    const tell = <N extends ClientNotificationName>(method: N, params: ClientNotificationParams<N>) => {
      const needs = notificationScopes[method];
      if (needs !== null && !client.scopes.includes(needs)) return;
      const shaped = forAccess(client.access ?? FULL, method, params, registry.look);
      if (shaped !== undefined) port.send(JSON.stringify(notification(method, shaped)));
    };
    const initial = deps.initial?.();
    if (client.scopes.includes("asks:answer")) {
      for (const ask of deps.asks.listOpen()) tell("ask.state", ask);
      for (const ask of initial?.asks ?? []) tell("ask.state", ask);
    }
    if (!initial) return;
    for (const session of initial.sessions) tell("session.state", clientRow(session));
    if (client.scopes.includes("sessions:read")) for (const terminal of initial.terminals ?? []) tell("terminal.state", terminal);
    for (const workspace of initial.workspaces) tell("workspace.state", clientRow(workspace));
    if (client.scopes.includes("nodes")) for (const node of initial.nodes ?? []) tell("node.state", node);
    if (client.scopes.includes("remote")) for (const state of initial.remote ?? []) tell("remote.state", state);
    if (client.scopes.includes("tasks:read")) for (const task of initial.tasks ?? []) tell("task.state", task);
    if (client.scopes.includes("updates")) for (const state of initial.updates ?? []) tell("update.state", state);
    if (client.scopes.includes("voice")) {
      for (const state of initial.voice?.states ?? []) tell("voice.state", state);
      for (const setup of initial.voice?.setup ?? []) tell("voice.setup", setup);
    }
    if (client.scopes.includes("account") && initial.account) tell("account.state", initial.account);
    if (client.scopes.includes("account")) for (const state of initial.direct ?? []) tell("direct.state", state);
    if (initial.progress) tell("chat.progress", { turn: initial.progress });
  };

  /** The phone's first frame: a code for a token of its own, before it can say `hello`. */
  const handleClaim = async (ws: Conn, req: RpcRequest) => {
    const pairing = deps.pairing;
    if (ws.data.listener === "cloud" || ws.data.listener === "p2p") {
      send(ws, failure(req.id, protocolError("unsupported", "pairing happens on the node's own network, not over the relay")));
      return;
    }
    if (!pairing || !deps.auth.grants) {
      send(ws, failure(req.id, protocolError("unsupported", "this listener does not pair controllers")));
      return;
    }
    if (ws.data.client) {
      send(ws, failure(req.id, protocolError("conflict", "already said hello")));
      return;
    }
    if (ws.data.claimed) {
      send(ws, failure(req.id, protocolError("conflict", "already paired on this connection")));
      return;
    }
    const parsed = clientRequests["pair.claim"].params.safeParse(req.params ?? {});
    if (!parsed.success) {
      send(ws, failure(req.id, protocolError("invalid", "bad pair.claim params", parsed.error.issues)));
      return;
    }
    const p = parsed.data;
    const principal = { kind: "user", client: ws.data.provisional } as const;
    try {
      // What the phone gets carries its token and its relay secret; the audit row gets the controller alone.
      let secret: { token: string; relay?: RelayAccess } | undefined;
      const client = await deps.gate.run(
        // The code is not audited: the row would be the pairing secret in the log.
        { principal, action: "pair.claim", args: { name: p.name }, sessionKey: ws.data.provisional },
        async () => {
          const paired = pairing.claim(p.code, p.name);
          if (!paired) throw new RpcError("denied", "that code is not open");
          // the relay access rides along when the node can mint it now; the phone asks `relay.info` later otherwise
          const relay = await deps.relayAccess?.(paired.controller.id, paired.controller.name);
          secret = { token: paired.token, ...(relay ? { relay } : {}) };
          return relay ? { ...paired.controller, relay: true } : paired.controller;
        },
      );
      const result = { token: secret!.token, client, ...(secret!.relay ? { relay: secret!.relay } : {}) };
      ws.data.claimed = true;
      ws.data.failedClaims = 0;
      armHello(ws);
      send(ws, success(req.id, result));
      log.info("controller paired", { controller: result.client.id, name: result.client.name, remote: ws.remoteAddress });
    } catch (e) {
      ws.data.failedClaims++;
      send(ws, failure(req.id, e instanceof RpcError ? e.error : protocolError("denied", "that code is not open")));
      log.warn("pairing code refused", { remote: ws.remoteAddress, attempts: ws.data.failedClaims });
      if (ws.data.failedClaims >= MAX_CLAIMS_PER_SOCKET) ws.close(CLOSE_UNAUTHENTICATED, "too many pairing attempts");
    }
  };

  /** A phone that signed in with the account, on its pairing tunnel: a controller of its own, before `hello`. */
  const handleAccountPairing = async (ws: Conn, req: RpcRequest) => {
    const pairing = ws.data.pairing;
    if (!pairing) {
      send(ws, failure(req.id, protocolError("unsupported", "pair.account is answered on a pairing tunnel only")));
      return;
    }
    if (!deps.accountPairing) {
      send(ws, failure(req.id, protocolError("unsupported", "this node does not pair through the account")));
      return;
    }
    if (ws.data.claimed) {
      send(ws, failure(req.id, protocolError("conflict", "already paired on this tunnel")));
      return;
    }
    const parsed = clientRequests["pair.account"].params.safeParse(req.params ?? {});
    if (!parsed.success) {
      send(ws, failure(req.id, protocolError("invalid", "bad pair.account params", parsed.error.issues)));
      return;
    }
    const name = parsed.data.name;
    const principal = { kind: "user", client: ws.data.provisional } as const;
    try {
      let paired: AccountPaired | undefined;
      const client = await deps.gate.run(
        { principal, action: "pair.account", args: { name, account: pairing.login }, sessionKey: ws.data.provisional },
        async () => {
          paired = await deps.accountPairing!(name, pairing.login);
          return paired.client;
        },
      );
      ws.data.claimed = true;
      // The phone left before the answer (the app paused, the network dropped): nobody holds this token.
      if (ws.data.closed) {
        deps.abandonPairing?.(client.id);
        log.warn("pairing through the account abandoned: the phone left before the answer", { controller: client.id, account: pairing.login });
        return;
      }
      send(ws, success(req.id, { ...paired!, client }));
      log.info("controller paired through the account", { controller: client.id, name: client.name, account: pairing.login, lan: paired!.lan !== undefined });
    } catch (e) {
      send(ws, failure(req.id, e instanceof RpcError ? e.error : protocolError("unavailable", "the pairing failed")));
      log.warn("pairing through the account failed", { account: pairing.login, error: e instanceof Error ? e.message : String(e) });
    }
  };

  /**
   * A phone's first frame with an invite: on the LAN listener, or on the invite's own tunnel
   * for its grant alone. The secret is not audited; the answer goes to the phone outside the
   * gate. On the LAN the phone says hello on the same socket; the invite's throwaway peer goes
   * then, or, on its tunnel, once the phone closes it.
   */
  const handleRedeem = async (ws: Conn, req: RpcRequest) => {
    const listener = ws.data.listener;
    if (ws.data.client) {
      send(ws, failure(req.id, protocolError("conflict", "already said hello")));
      return;
    }
    if (!deps.redeemInvite || !(listener === "controller" || (listener === "cloud" && ws.data.invite))) {
      send(ws, failure(req.id, protocolError("unsupported", "an invite is redeemed on the node's LAN listener or the invite's own relay peer")));
      return;
    }
    if (ws.data.claimed) {
      send(ws, failure(req.id, protocolError("conflict", "already redeemed on this connection")));
      return;
    }
    const parsed = clientRequests["invite.redeem"].params.safeParse(req.params ?? {});
    if (!parsed.success) {
      send(ws, failure(req.id, protocolError("invalid", "bad invite.redeem params", parsed.error.issues)));
      return;
    }
    const p = parsed.data;
    const principal = { kind: "user", client: ws.data.provisional } as const;
    try {
      if (ws.data.invite && p.grant !== ws.data.invite.grant) throw new RpcError("denied", "that invite is not open");
      let redeemed: Redeemed | undefined;
      const client = await deps.gate.run(
        { principal, action: "invite.redeem", args: { grant: p.grant, name: p.name }, sessionKey: ws.data.provisional },
        async () => {
          redeemed = await deps.redeemInvite!({ grant: p.grant, secret: p.secret }, ws.data.invite ? { peer: ws.data.invite.peer } : {});
          return redeemed.answer.client;
        },
      );
      ws.data.claimed = true;
      ws.data.failedClaims = 0;
      // The phone left before the answer: it never held the token, so the invite is open again.
      if (ws.data.closed) {
        redeemed!.abandon();
        return;
      }
      send(ws, success(req.id, { ...redeemed!.answer, client }));
      log.info("phone redeemed an invite", { controller: client.id, name: client.name, remote: ws.remoteAddress, via: listener });
      if (ws.data.invite) ws.data.redeemed = redeemed;
      else {
        redeemed!.settle();
        armHello(ws);
      }
    } catch (e) {
      ws.data.failedClaims++;
      send(ws, failure(req.id, e instanceof RpcError ? e.error : protocolError("denied", "that invite is not open")));
      log.warn("invite refused", { remote: ws.remoteAddress, attempts: ws.data.failedClaims });
      if (ws.data.failedClaims >= MAX_CLAIMS_PER_SOCKET) ws.close(CLOSE_UNAUTHENTICATED, "too many invite attempts");
    }
  };

  const handleHello = async (ws: Conn, req: RpcRequest) => {
    const parsed = clientRequests.hello.params.safeParse(req.params ?? {});
    if (!parsed.success) {
      send(ws, failure(req.id, protocolError("invalid", "bad hello params", parsed.error.issues)));
      ws.close(CLOSE_UNAUTHENTICATED, "bad hello");
      return;
    }
    const p = parsed.data;
    // A paired controller's own token first; the shared token is the desktop's, on loopback only.
    const controller = deps.auth.grants?.authenticate(p.token);
    const shared = deps.auth.shared !== undefined && ws.data.listener === "loopback" && tokenMatches(p.token, deps.auth.shared);
    if (!controller && !shared) {
      log.warn("hello refused: bad token", { remote: ws.remoteAddress, listener });
      send(ws, failure(req.id, protocolError("denied", "bad token")));
      ws.close(CLOSE_UNAUTHENTICATED, "bad token");
      return;
    }
    // A data channel was keyed for one phone: another's token does not ride it.
    if (ws.data.boundController !== undefined && controller?.id !== ws.data.boundController) {
      log.warn("hello refused: another phone's channel", { listener: ws.data.listener });
      send(ws, failure(req.id, protocolError("denied", "this channel was opened for another phone")));
      ws.close(CLOSE_UNAUTHENTICATED, "not this channel's phone");
      return;
    }
    const now = Date.now();
    // A phone is what its grant lets it be; the desktop's shared token is everything.
    const access = controller?.access ?? FULL;
    const client: Client = {
      id: newId("client", now),
      kind: p.kind,
      scopes: [...access.scopes],
      access,
      via: ws.data.listener === "cloud" || ws.data.listener === "p2p" ? "relay" : "direct",
      audio: p.audio,
      connectedAt: now,
    };
    if (p.name !== undefined) client.name = p.name;
    if (ws.data.listener === "p2p") client.path = ws.data.path ?? "direct";
    // A desktop app on loopback sits on this node; a relayed hello carries the name on.
    if (p.node !== undefined) client.node = p.node;
    else if (p.kind === "ui" && listener === "loopback") client.node = deps.node().id;
    if (controller) {
      client.controller = controller.id;
      if (client.name === undefined) client.name = controller.name;
    }

    const principal = { kind: "user", client: client.id } as const;
    try {
      const result = await deps.gate.run(
        { principal, via: client.id, action: "hello", args: { ...p, token: "[redacted]" }, sessionKey: client.id },
        () => ({ client, node: deps.node().id, protocolVersion: PROTOCOL_VERSION, platformVersion: deps.platformVersion, ...(deps.audio ? { audio: deps.audio } : {}) }),
      );
      if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
      if (controller) deps.auth.grants!.touch(controller.id, now);
      if (p.forward) ws.data.forward = true;
      // Linked to a primary: the primary answers this hello and serves the client from here on.
      const relay = deps.nodes?.relay;
      if (relay?.linked()) {
        const peer = ws.data.provisional;
        const port = portOf(ws);
        const info: HelloInfo = { kind: p.kind, audio: p.audio, ...(p.name !== undefined ? { name: p.name } : {}), ...(client.node !== undefined ? { node: client.node } : {}) };
        // The phone's grant goes up with it: the primary holds it to its own row, or to this access.
        const relayedResult = await relay.open(peer, info, ws.data.origin, port, controller ? { grant: controller.id, access } : {});
        // The local copy of the client keeps the controller it authenticated as, so a revoke here still closes it.
        const local: Client = { ...relayedResult.client, ...(controller ? { controller: controller.id } : {}) };
        ws.data.client = local;
        ws.data.relayed = peer;
        sockets.set(local.id, ws);
        registry.add(local, port, "relayed");
        send(ws, success(req.id, relayedResult));
        log.info("client connected, relayed to the primary", { client: relayedResult.client.id, kind: client.kind, name: client.name, node: relayedResult.node });
        return;
      }
      ws.data.client = client;
      sockets.set(client.id, ws);
      registry.add(client, { send: (data, o) => ws.send(data, o), close: (code, reason) => ws.close(code ?? 1000, reason ?? ""), buffered: () => ws.buffered?.() ?? 0 }, ws.data.listener);
      send(ws, success(req.id, result));
      log.info("client connected", { client: client.id, kind: client.kind, name: client.name, via: client.via, ...(controller ? { controller: controller.id } : {}) });
      welcome(portOf(ws), client);
    } catch (e) {
      send(ws, failure(req.id, e instanceof RpcError ? e.error : protocolError("denied", "hello refused")));
      ws.close(CLOSE_UNAUTHENTICATED, "hello refused");
    }
  };

  /** One request from an authenticated client, on a socket here or relayed from a secondary. */
  const dispatchFor = async (port: Port, client: Client, req: RpcRequest) => {
    const reply = (message: unknown) => port.send(JSON.stringify(message));
    const name = req.method as ClientRequestName;
    const def = clientRequests[name];
    const method = deps.methods[name];
    if (!def || !method) {
      reply(failure(req.id, protocolError("unsupported", `unknown method ${req.method}`)));
      return;
    }
    // A phone on another network cannot fetch this node's URLs: the two requests that answer one are not served over the relay, nor on its data channel;
    // except a stream the phone reads through a forwarder of its own, over pipes.
    if ((port.listener === "cloud" || port.listener === "p2p") && NOT_OVER_RELAY.has(name) && !(name === "remote.open" && forwards(port, req.params))) {
      reply(failure(req.id, protocolError("unsupported", `${req.method} is not served over the relay`)));
      return;
    }
    // A data channel is not signalled over itself.
    if (port.listener === "p2p" && NOT_OVER_P2P.has(name)) {
      reply(failure(req.id, protocolError("unsupported", `${req.method} is not served on a data channel`)));
      return;
    }
    const parsed = def.params.safeParse(req.params ?? {});
    if (!parsed.success) {
      reply(failure(req.id, protocolError("invalid", `bad params for ${req.method}`, parsed.error.issues)));
      return;
    }
    const params = parsed.data;
    const principal = { kind: "user", client: client.id } as const;
    const target = (method as { target?: (p: unknown) => string | undefined }).target?.(params);
    const ask = (method as { ask?: (p: unknown) => { title: string; detail?: string } }).ask?.(params);
    const redact = (method as { redact?: (p: unknown) => unknown }).redact;
    const redactResult = (method as { redactResult?: (r: unknown) => unknown }).redactResult;
    const risk = (method as { risk?: (p: unknown) => RiskClass }).risk?.(params);
    const needs = requestScopes[name];
    try {
      const result = await deps.gate.run(
        { principal, via: client.id, action: req.method, args: redact ? redact(params) : params, sessionKey: client.id, ...(target !== undefined ? { target } : {}), ...(ask ? { ask } : {}), ...(risk !== undefined ? { risk } : {}), ...(redactResult ? { redactResult } : {}) },
        (ctx) => {
          // Inside the gate so a refusal is audited like any other outcome: the scope, then what
          // a limited grant may reach. A view is narrowed further by its host.
          if (needs !== null && !client.scopes.includes(needs)) throw new RpcError("denied", `${req.method} needs scope ${needs}`);
          const refused = refuseRequest(client.access ?? FULL, name, params as never, registry.look);
          if (refused) throw new RpcError("denied", refused);
          const mctx: MethodContext = { ...ctx, client, principal, origin: port.origin, listener: port.listener, ...(port.forward ? { forward: true } : {}) };
          return (method as { handler: (p: unknown, c: MethodContext) => unknown }).handler(params, mctx);
        },
      );
      reply(success(req.id, clientResult(name, result, client.access ?? FULL, registry.look)));
    } catch (e) {
      if (e instanceof RpcError) {
        reply(failure(req.id, e.error));
      } else {
        log.error("method failed", { method: req.method, error: e });
        reply(failure(req.id, protocolError("unavailable", "internal error")));
      }
    }
  };

  /** A signal: no response, no audit row. Unknown ones are ignored. */
  const handleSignal = (client: Client, msg: { method: string; params?: unknown }) => {
    const name = msg.method as ClientSignalName;
    const schema = clientSignals[name];
    const handler = deps.signals?.[name];
    if (!schema || !handler) {
      log.debug("unknown signal ignored", { method: msg.method });
      return;
    }
    const needs = signalScopes[name];
    if (needs !== null && !client.scopes.includes(needs)) {
      log.debug("signal ignored: no scope", { method: msg.method, client: client.id });
      return;
    }
    const parsed = schema.safeParse(msg.params ?? {});
    if (!parsed.success) {
      log.debug("bad signal ignored", { method: msg.method });
      return;
    }
    try {
      (handler as (c: Client, p: unknown) => void)(client, parsed.data);
    } catch (e) {
      log.warn("signal handler failed", { method: msg.method, error: e instanceof Error ? e.message : String(e) });
    }
  };

  /** A frame from an authenticated client, wherever its socket is. */
  const handleFrame = (port: Port, client: Client, text: string) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      port.send(JSON.stringify(failure(null, protocolError("invalid", "frame is not JSON"))));
      return;
    }
    const parsed = RpcMessage.safeParse(value);
    if (!parsed.success) {
      port.send(JSON.stringify(failure(null, protocolError("invalid", "frame is not JSON-RPC"))));
      return;
    }
    const msg = parsed.data;
    if ("method" in msg && "id" in msg) {
      if (msg.method === "hello" || msg.method === "pair.claim" || msg.method === "pair.account" || msg.method === "invite.redeem") {
        port.send(JSON.stringify(failure(msg.id, protocolError("conflict", `already said hello`))));
        return;
      }
      void dispatchFor(port, client, msg);
      return;
    }
    if ("method" in msg) handleSignal(client, msg);
    // A response to a request the daemon never sends; ignored.
  };

  // --- relayed clients of a secondary, served here on the primary ------------------------------

  const relayed = new Map<string, { client: Client; port: Port }>();
  /**
   * A relayed client's access: the primary's own row of its grant when it keeps one (a phone
   * paired here, come in through a backup), else what the relaying node holds of it (a phone
   * paired there), else everything (a desktop on that node).
   */
  const relayedAccess = (as: RelayedAs): Access => {
    if (as.grant !== undefined) {
      const row = deps.auth.grants?.get(as.grant);
      if (row) {
        if (row.kind !== "controller" || deps.auth.grants!.status(row) !== "active" || deps.auth.grants!.expired(row)) throw new RpcError("denied", `grant ${as.grant} is not a phone's that may connect`);
        return row.access;
      }
    }
    if (as.access !== undefined) {
      const why = validateAccess(as.access);
      if (why) throw new RpcError("invalid", `the relayed client's access: ${why}`);
      return as.access;
    }
    return FULL;
  };

  const relayHost: RelayHost = {
    open: async (info, origin, port, relayedBy, as = {}) => {
      const now = Date.now();
      const access = relayedAccess(as);
      const client: Client = { id: newId("client", now), kind: info.kind, scopes: [...access.scopes], access, via: "relay", audio: info.audio, connectedAt: now };
      if (as.grant !== undefined && ControllerId.safeParse(as.grant).success) client.controller = as.grant;
      if (info.name !== undefined) client.name = info.name;
      if (info.node !== undefined) client.node = info.node;
      const principal = { kind: "user", client: client.id } as const;
      const result = await deps.gate.run(
        { principal, via: client.id, action: "hello", args: { ...info, relayedBy }, sessionKey: client.id },
        () => ({ client, node: deps.node().id, protocolVersion: PROTOCOL_VERSION, platformVersion: deps.platformVersion, ...(deps.audio ? { audio: deps.audio } : {}) }),
      );
      const full: Port = { ...port, origin, listener: "relay" };
      relayed.set(client.id, { client, port: full });
      registry.add(client, port, "relay");
      log.info("relayed client connected", { client: client.id, kind: client.kind, name: client.name, from: relayedBy });
      welcome(full, client);
      return { client, result };
    },
    frame: (clientId, text) => {
      const entry = relayed.get(clientId);
      if (!entry) return;
      handleFrame(entry.port, entry.client, text);
    },
    close: (clientId) => {
      const entry = relayed.get(clientId);
      if (!entry) return;
      relayed.delete(clientId);
      registry.remove(clientId);
      deps.policy.forgetSession(clientId);
      deps.onDisconnect?.(entry.client);
      log.info("relayed client disconnected", { client: clientId });
    },
  };

  /** The origin a request came in on, from its `Host`; the listener's own when the header is missing or odd. */
  const originOf = (req: Request, fallback: () => string): string => {
    const host = req.headers.get("host") ?? "";
    return HOST.test(host) || HOST_IPV6.test(host) ? `${scheme}://${host}` : fallback();
  };

  const server: Server<Connection> = Bun.serve<Connection>({
    hostname: opts.host ?? deps.config.api.host,
    port: opts.port ?? deps.config.api.port,
    ...(opts.tls ? { tls: opts.tls } : {}),
    fetch(req, srv) {
      const url = new URL(req.url);
      const origin = originOf(req, () => selfOrigin());
      const remote = srv.requestIP(req)?.address ?? "?";
      if (url.pathname === "/ws/client") {
        if (srv.upgrade(req, { data: { kind: "client", listener, origin, provisional: newId("client"), failedClaims: 0, remote } satisfies Connection })) return undefined;
        return new Response("expected a websocket", { status: 426 });
      }
      // Other nodes link here, on the listener the daemon gave the seam to, while it accepts.
      if (url.pathname === "/ws/node" && deps.nodes?.acceptSocket) {
        if (!deps.nodes.accepting?.()) return new Response("not accepting nodes", { status: 503 });
        if (srv.upgrade(req, { data: { kind: "node", listener, origin, provisional: newId("client"), failedClaims: 0, remote } satisfies Connection })) return undefined;
        return new Response("expected a websocket", { status: 426 });
      }
      // The remote-desktop stream page and its socket: the controller listener's alone, behind a ticket.
      if (deps.remote && listener === "controller" && RemoteProxy.owns(url.pathname)) {
        return deps.remote.handle(req, (bridge) => srv.upgrade(req, { data: { kind: "remote", listener, origin, provisional: newId("client"), failedClaims: 0, remote, bridge } satisfies Connection }));
      }
      // The harness hooks are loopback's alone: nothing on the LAN answers them.
      const hook = listener === "loopback" && deps.hooks ? /^\/hooks\/(claude|codex|muse)$/.exec(url.pathname) : null;
      if (hook) return handleHook(req, srv, hook[1] as HookHarness, deps.hooks!, log.child("hooks"));
      if (deps.tickets) {
        const view = /^\/view\/([0-9a-f]{8,64})\/(.+)$/.exec(url.pathname);
        if (view) {
          const file = deps.tickets.serve(view[1]!, decodeURIComponent(view[2]!));
          if (!file) return new Response("not found", { status: 404 });
          return new Response(file.bytes, { headers: viewHeaders(origin, file.mime) });
        }
      }
      if (deps.static !== undefined) {
        const file = serveStatic(deps.static, url.pathname);
        if (file) return new Response(file.bytes, { headers: { "content-type": file.mime, "cache-control": "no-cache" } });
        // Only the app's own entry falls back to the "not built" page; every other path is a 404.
        if ((url.pathname === "/" || url.pathname === "/index.html") && !isBuilt(deps.static)) {
          return new Response(NOT_BUILT_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
        }
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_PAYLOAD,
      idleTimeout: 960,
      open(ws) {
        if (ws.data.kind === "remote") {
          deps.remote!.ws.open(ws.data.bridge!, (data) => void ws.send(data), () => ws.close(1000, "session ended"));
          return;
        }
        if (ws.data.kind === "node") {
          ws.data.nodeHandler = deps.nodes!.acceptSocket!({ send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason), remote: ws.data.remote });
          return;
        }
        ws.data.conn = { data: ws.data, send: (text) => void ws.send(text), close: (code, reason) => ws.close(code, reason), remoteAddress: ws.remoteAddress, buffered: () => ws.getBufferedAmount() };
        openConn(ws.data.conn);
      },
      message(ws, raw) {
        if (ws.data.kind === "remote") {
          deps.remote!.ws.message(ws.data.bridge!, raw);
          return;
        }
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        if (ws.data.kind === "node") {
          ws.data.nodeHandler?.message(text);
          return;
        }
        if (ws.data.conn) messageConn(ws.data.conn, text);
      },
      close(ws, code, reason) {
        if (ws.data.kind === "remote") {
          deps.remote!.ws.close(ws.data.bridge!);
          return;
        }
        if (ws.data.kind === "node") {
          ws.data.nodeHandler?.close(code, reason);
          return;
        }
        if (ws.data.conn) closeConn(ws.data.conn, code, reason);
      },
    },
  });

  // --- one client connection, on a socket here or in a tunnel ------------------------------------

  function openConn(ws: Conn): void {
    armHello(ws);
  }

  function messageConn(ws: Conn, text: string): void {
    // A relayed socket: everything goes up verbatim, but what is about this node is answered here.
    if (ws.data.relayed !== undefined && ws.data.client) {
      if (isLocalOnly(text)) {
        handleFrame(portOf(ws), ws.data.client, text);
        return;
      }
      deps.nodes!.relay!.frame(ws.data.relayed, text);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      send(ws, failure(null, protocolError("invalid", "frame is not JSON")));
      return;
    }
    const parsed = RpcMessage.safeParse(value);
    if (!parsed.success) {
      send(ws, failure(null, protocolError("invalid", "frame is not JSON-RPC")));
      return;
    }
    const msg = parsed.data;
    // An invite's tunnel: the one request it exists for, and nothing else.
    if (ws.data.invite) {
      if ("method" in msg && "id" in msg) {
        if (msg.method === "invite.redeem") void handleRedeem(ws, msg);
        else send(ws, failure(msg.id, protocolError("unsupported", `an invite's tunnel answers invite.redeem alone, not ${msg.method}`)));
      }
      return;
    }
    // A pairing tunnel: the one request it exists for, and nothing else.
    if (ws.data.pairing) {
      if ("method" in msg && "id" in msg) {
        if (msg.method === "pair.account") void handleAccountPairing(ws, msg);
        else send(ws, failure(msg.id, protocolError("unsupported", `a pairing tunnel answers pair.account alone, not ${msg.method}`)));
      }
      return;
    }
    if ("method" in msg && "id" in msg) {
      if (msg.method === "pair.claim") {
        void handleClaim(ws, msg);
        return;
      }
      if (msg.method === "pair.account") {
        void handleAccountPairing(ws, msg);
        return;
      }
      if (msg.method === "invite.redeem") {
        void handleRedeem(ws, msg);
        return;
      }
      if (msg.method === "hello") {
        if (ws.data.client) {
          send(ws, failure(msg.id, protocolError("conflict", "already said hello")));
          return;
        }
        void handleHello(ws, msg);
        return;
      }
      if (!ws.data.client) {
        send(ws, failure(msg.id, protocolError("denied", "say hello first")));
        ws.close(CLOSE_UNAUTHENTICATED, "no hello");
        return;
      }
      void dispatchFor(portOf(ws), ws.data.client, msg);
      return;
    }
    if ("method" in msg) {
      const client = ws.data.client;
      if (!client) return;
      handleSignal(client, msg);
      return;
    }
    // A response to a request the daemon never sends; ignored.
  }

  function closeConn(ws: Conn, code: number, reason: string): void {
    ws.data.closed = true;
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    // an invite's tunnel the phone closed with its answer: the throwaway peer goes
    ws.data.redeemed?.settle();
    delete ws.data.redeemed;
    const client = ws.data.client;
    if (client) {
      sockets.delete(client.id);
      registry.remove(client.id);
      if (ws.data.relayed !== undefined) {
        deps.nodes?.relay?.close(ws.data.relayed);
        log.info("relayed client disconnected", { client: client.id, code, reason });
        return;
      }
      deps.policy.forgetSession(client.id);
      deps.onDisconnect?.(client);
      log.info("client disconnected", { client: client.id, code, reason, via: client.via });
    }
  }

  /**
   * A tunnel from the server relay, served here as a connection of the `cloud` kind (a pairing
   * one carries the account it signed in as), or a phone's data channel, of the `p2p` kind,
   * which only its own phone may say hello on.
   */
  const acceptTunnel = (sock: NodeSocket, tunnelOpts: TunnelOptions = {}): NodeSocketHandler => {
    const conn: Conn = {
      data: {
        kind: "client",
        listener: tunnelOpts.listener ?? "cloud",
        origin: selfOrigin(),
        provisional: newId("client"),
        failedClaims: 0,
        remote: sock.remote,
        ...(tunnelOpts.pairing ? { pairing: tunnelOpts.pairing } : {}),
        ...(tunnelOpts.invite ? { invite: tunnelOpts.invite } : {}),
        ...(tunnelOpts.controller !== undefined ? { boundController: tunnelOpts.controller } : {}),
        ...(tunnelOpts.path ? { path: tunnelOpts.path } : {}),
      },
      send: (text, o) => sock.send(text, o),
      close: (code, reason) => sock.close(code, reason),
      remoteAddress: sock.remote,
      ...(sock.buffered ? { buffered: () => sock.buffered!() } : {}),
    };
    openConn(conn);
    return {
      message: (text) => messageConn(conn, text),
      close: (code, reason) => closeConn(conn, code, reason),
      setPath: (path) => {
        conn.data.path = path;
        if (conn.data.client && conn.data.listener === "p2p") conn.data.client.path = path;
      },
    };
  };

  /** This listener as something outside can reach: a bound address, or the LAN one behind `0.0.0.0`. */
  function selfOrigin(): string {
    const bound = server.hostname ?? "127.0.0.1";
    const host = bound === "0.0.0.0" || bound === "::" ? (lanHost ?? "127.0.0.1") : bound;
    return `${scheme}://${host}:${server.port}`;
  }
  // Only a listener bound to every interface needs this, and only for the URL a phone types.
  const bindHost = opts.host ?? deps.config.api.host;
  const lanHost: string | undefined = bindHost === "0.0.0.0" || bindHost === "::" ? lanAddress() : undefined;

  const url = `${scheme === "https" ? "wss" : "ws"}://${server.hostname}:${server.port}/ws/client`;
  log.info("listening", { url, ...(deps.static !== undefined ? { app: deps.static } : {}), ...(deps.nodes?.acceptSocket ? { nodes: "/ws/node" } : {}) });

  return {
    port: server.port ?? 0,
    url,
    origin: selfOrigin(),
    clients: () => [...sockets.values()].map((ws) => ws.data.client!).filter(Boolean),
    broadcast,
    relayHost,
    acceptTunnel,
    stop: async () => {
      for (const off of unsubscribe) off();
      for (const ws of sockets.values()) {
        const client = ws.data.client;
        if (client) registry.remove(client.id);
        ws.close(1001, "daemon stopping");
      }
      sockets.clear();
      for (const id of [...relayed.keys()]) relayHost.close(id);
      // Bun 1.3.14 on Windows: once a socket was closed from the server side, the promise
      // from `stop(true)` never settles, though the listener is released at once. Bound it.
      await Promise.race([server.stop(true), Bun.sleep(STOP_WAIT_MS)]);
    },
  };
}

/** The requests a relayed client still gets answered by the node it is on: its own files, its own phones (and their relay and push rows), its own viewer, its own data channel, its own membership. */
const LOCAL_ONLY = new Set(["view.stage", "pair.start", "controller.list", "controller.revoke", "remote.open", "remote.close", "remote.pipe.open", "relay.info", "push.register", "push.unregister", "direct.info", "direct.offer", "node.join", "node.leave"]);

/** The signals a relayed client sends this node itself: a data channel's candidates end here, where its helper is, and a stream's pipes where they were opened. */
const LOCAL_SIGNALS = new Set(["direct.candidate", "remote.pipe.data", "remote.pipe.ack", "remote.pipe.close"]);

/** Whether a `remote.open` is for a client that reads the stream page through a forwarder of its own. */
function forwards(port: { forward?: boolean }, params: unknown): boolean {
  return port.forward === true || (typeof params === "object" && params !== null && (params as { forward?: unknown }).forward === true);
}

/** What a data channel does not carry: its own signalling. */
const NOT_OVER_P2P = new Set<string>(["direct.info", "direct.offer"]);

/** The requests not served over the relay: the two that answer a URL on this node, which a phone on another network cannot fetch, and the relay access itself, whose fresh grant would replace the token the tunnel holds. */
const NOT_OVER_RELAY = new Set<string>(["view.stage", "remote.open", "relay.info"]);

/** Whether a raw frame is a request or a signal this node answers itself, without parsing it in full. */
function isLocalOnly(text: string): boolean {
  if (![...LOCAL_ONLY, ...LOCAL_SIGNALS].some((m) => text.includes(`"${m}"`))) return false;
  try {
    const m = JSON.parse(text) as { method?: unknown; id?: unknown };
    if (typeof m.method !== "string") return false;
    return m.id !== undefined ? LOCAL_ONLY.has(m.method) : LOCAL_SIGNALS.has(m.method);
  } catch {
    return false;
  }
}
