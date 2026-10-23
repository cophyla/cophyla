// `connections`: one terminal of this user's joined to one of another Cophyla user's, so the
// agents in the two may message each other and reach nothing else of either side. The
// primary keeps them (a node in no cluster keeps its own), since the other user's Cophyla
// reaches this account through the relay, which routes to the primary.
//
// One end makes an invite for a terminal (the one a session runs in, or one by its ref): a
// pending connection, a one-use secret, and a relay peer of the invite's own, as a code to
// hand the other person. Their Cophyla spends it on that peer's tunnel, keyed from the secret:
// each side shows the other the server's word on who it is (an identity bound to the invite
// and to which end speaks), the redeemer its end and a relay peer it minted, the inviter its
// end, a relay peer of its own and the key the connection's tunnels are keyed from; the
// redeemer's user may be asked then, knowing who it connects to, and `connection.confirm`
// makes it live at both ends. A redemption that stops short leaves the invite open again.
//
// A connection lives with its terminal: whichever agent runs there now is its end, so a
// `/clear`, a harness started again in it, a daemon restart or either machine asleep leave it
// as it is. The terminal closing ends it, told by the node that holds the terminal (never
// guessed from a link that dropped), or noticed missing twice while that node is reached; a
// session in no tether terminal is its own end. Either user, or either agent, ends it too.
//
// A message carries no address: the far end's tunnel delivers it into this connection's
// terminal and nowhere else, in an envelope that names the other person and says it is
// external. It is checked against limits of the connection's own (a few a minute, a day's
// worth, a short conversation), never typed into a Claude session, and asked about before it
// reaches a session that runs without permission prompts unless the user said it may. Each
// end keeps what the other cannot take now: its own messages while the far end cannot be
// reached, the far end's while no agent runs in its terminal, for a day.

import { createHash, randomBytes } from "node:crypto";
import { CONNECTION_MAX_CHARS, connectionInviteText, connectionLinkRequests, identityAudience, InviteError, newId, parseConnectionInvite, RpcError } from "@cophyla/protocol";
import type { Ask, AskOption, Connection, ConnectionEndInfo, ConnectionListing, ConnectionRelay, ConnectionSendStatus, PeerFileSend, Session, Terminal, TerminalRef } from "@cophyla/protocol";
import { pskFromHex, pskFromSecret } from "@cophyla/relay";
import type { Bus } from "../bus.ts";
import type { ConnectionTunnel } from "../cloud/tunnels.ts";
import type { VerifiedIdentity } from "../cloud/identity.ts";
import type { Asks } from "../gate/asks.ts";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { LinkSocket } from "../nodes/outbound.ts";
import type { PeerFiles, PeerLink } from "../peerfiles/index.ts";
import type { RpcPeer } from "../rpc/peer.ts";
import type { Store } from "../store/index.ts";
import { base, folderOf, slug } from "../agentmsg/directory.ts";
import { peerAlias } from "../agentmsg/envelope.ts";
import type { EnvelopeInfo } from "../agentmsg/envelope.ts";
import { Limits } from "../agentmsg/limits.ts";
import type { LimitsConfig } from "../agentmsg/limits.ts";
import { clientOver, dialRelay, farEnded, FILE_REQUEST_MS, IDLE_MS, Pacer, REQUEST_MS, serveOver } from "./link.ts";
import type { Dial } from "./link.ts";
import { clientConnection, ConnectionStore } from "./store.ts";
import type { ConnectionRow, Queued } from "./store.ts";

/** How long an invite may be used. */
export const INVITE_MS = 15 * 60_000;
/** How many messages wait on either side of one connection, and for how long. */
export const QUEUE_MAX = 20;
export const QUEUE_MS = 24 * 60 * 60_000;
/** How long a redemption may hold an invite before it confirms, its user asked meanwhile. */
const REDEEM_MS = 6 * 60_000;
/** How long the user has to answer an agent's invite or acceptance, and a message into a session that runs without prompts. */
const ASK_MS = 5 * 60_000;
const ESCALATE_MS = 10 * 60_000;
/** How long an agent's tool call waits on its user's answer before it is told the outcome comes later. */
const TOOL_WAIT_MS = 90_000;
/** How often the connections are looked over: terminals gone, invites run out, messages waiting. */
const SWEEP_MS = 30_000;
/** The limits of one connection, each way: tighter than the user's own agents', since the other side spends this user's tokens. */
const LIMITS: LimitsConfig = { max_chars: CONNECTION_MAX_CHARS, per_minute: 6, per_target_per_minute: 6, duplicate_window_s: 300, max_hops: 8 };
const PER_DAY = 200;
const AUDIT_TEXT = 2000;
/** Inbound message ids remembered per connection, so a message sent again after a lost answer is delivered once. */
const SEEN = 500;

const HARNESS_WORDS: Record<string, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse", acp: "an ACP agent" };

/** Which terminal a connection is for: the one a session runs in, or one by its ref on `node`. */
export interface Endpoint {
  session?: string;
  terminal?: TerminalRef;
  node?: string;
}

/** What a send on a connection became, as the agent that sent it is told. */
export interface ConnectionSendAnswer {
  status: ConnectionSendStatus | "queued";
  id: string;
  connection: string;
  alias: string;
}

/** What the module needs of the account. */
export interface ConnectionCloud {
  /** Why connections cannot be made or reached now (signed out, no relay on the plan, the link down); undefined when they can. */
  allowed(): RpcError | undefined;
  /** The account this node is signed in to. */
  subject(): string | undefined;
  /** The server's origin, the only one a connection's tunnels go to. */
  serverUrl(): string;
  relayGrant(peer: string, opts: { kind: "connection"; name?: string; expiresAt?: number }): Promise<{ url: string; token: string }>;
  revokeRelay(peer: string): Promise<boolean>;
  attest(aud: string): Promise<string>;
  verifyIdentity(token: string, aud: string): VerifiedIdentity;
}

export interface ConnectionsDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  gate: Gate;
  asks: Asks;
  self: () => { id: string; name: string };
  /** Whether this node keeps the connections: the primary, or a node in no cluster. */
  routes: () => boolean;
  cloud: ConnectionCloud;
  /** Every session this node knows: its own and its linked nodes'. */
  sessions: () => Session[];
  /** Whether a session runs without permission prompts. */
  bypasses: (s: Session) => boolean;
  /** Delivers into a session wherever it is: here, or forwarded to its node. */
  deliver: (s: Session, text: string, info: EnvelopeInfo) => Promise<{ status: "queued" | "held" }>;
  /** Whether a node can be reached now: this one always, another while its link is up. */
  linked: (node: string) => boolean;
  /** Files on connections, on the primary. */
  files?: () => PeerFiles | undefined;
  /** A node's terminals as known now; undefined while that is not known (the node not linked). */
  terminals: (node: string) => Terminal[] | undefined;
  /** A node's name, for the words. */
  nodeName: (node: string) => string;
  dial?: Dial;
  now?: () => number;
  sweepMs?: number;
}

/** An invite's tunnel: once confirmed, the invite's relay peer to let go when it closes. */
interface RedeemTunnel {
  spent?: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** A redemption under way on the inviter's side: what it will keep once confirmed. */
interface Redeeming {
  tunnel: RedeemTunnel;
  inbound: string;
  key: string;
  outbound: ConnectionRelay;
  peer: NonNullable<ConnectionRow["peer"]>;
  at: number;
}

interface Outbound {
  rpc: RpcPeer;
  sock: LinkSocket;
  timer?: ReturnType<typeof setTimeout>;
}

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function cap(text: string, n = AUDIT_TEXT): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sameTerminal(a: TerminalRef | undefined, b: TerminalRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.host === b.host && a.id === b.id;
}

export class Connections {
  private deps: ConnectionsDeps;
  private log: Logger;
  private rows: ConnectionStore;
  private dial: Dial;
  private now: () => number;
  private limits: Limits;
  private redeeming = new Map<string, Redeeming>();
  private out = new Map<string, Outbound>();
  private opening = new Map<string, Promise<RpcPeer>>();
  /** The session that sent each message out lately, to tell it when one is not delivered. */
  private sentBy = new Map<string, string>();
  private seen = new Map<string, Set<string>>();
  /** Per connection, its messages each way today. */
  private days = new Map<string, { day: string; in: number; out: number }>();
  /** Per connection, the end the far side was last told. */
  private told = new Map<string, string>();
  /** Per connection, the sweeps in a row its terminal was missing. */
  private missing = new Map<string, number>();
  /** Per connection, the ask open for a message into a session that runs without prompts. */
  private escalating = new Map<string, string>();
  private flushing = new Set<string>();
  private again = new Set<string>();
  /** Each connection's tunnel, kept under the server's cap on frames a minute. */
  private pacer = new Pacer();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryMs = 30_000;
  private offs: (() => void)[] = [];
  private stateTimer?: ReturnType<typeof setTimeout>;

  constructor(deps: ConnectionsDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.rows = new ConnectionStore(deps.store);
    this.dial = deps.dial ?? dialRelay;
    this.now = deps.now ?? Date.now;
    this.limits = new Limits(() => LIMITS, this.now);
  }

  start(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), this.deps.sweepMs ?? SWEEP_MS);
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) this.sweepTimer.unref();
    this.offs.push(
      this.deps.bus.on("terminal.state", (t) => this.onTerminal(t)),
      this.deps.bus.on("session.state", (s) => this.onSession(s)),
    );
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    for (const off of this.offs.splice(0)) off();
    for (const id of [...this.out.keys()]) this.closeOut(id, "stopping");
  }

  // --- what clients see --------------------------------------------------------------------------

  list(): Connection[] {
    return this.rows.list().map((r) => this.client(r));
  }

  private client(row: ConnectionRow): Connection {
    const s = this.sessionOf(row);
    const name = this.endInfo(row).name;
    return clientConnection(row, { ...(s ? { session: s.id } : {}), name });
  }

  private emit(row: ConnectionRow): void {
    this.deps.bus.emit("connection.state", this.client(row));
  }

  private emitEnded(row: ConnectionRow, reason: string): void {
    this.deps.bus.emit("connection.state", { ...clientConnection(row), state: "ended", reason });
  }

  // --- ends --------------------------------------------------------------------------------------

  private routing(): void {
    if (!this.deps.routes()) throw new RpcError("unavailable", "connections are kept by the primary: ask there");
  }

  private reachable(): void {
    const why = this.deps.cloud.allowed();
    if (why) throw new RpcError("unavailable", `a connection needs this Cophyla signed in, with the relay on its plan and the server reached (${why.message})`);
  }

  /** The terminal an endpoint names, with the agent session in it now. */
  resolveEndpoint(p: Endpoint): { node: string; terminal?: TerminalRef; session?: Session } {
    if (p.session !== undefined) {
      const s = this.deps.sessions().find((x) => x.id === p.session);
      if (!s || s.status === "ended") throw new RpcError("not_found", `no live session ${p.session}`);
      if (s.role === "assistant") throw new RpcError("invalid", "the chat's own session takes no connection");
      return { node: s.node, ...(s.native.terminal ? { terminal: s.native.terminal } : {}), session: s };
    }
    if (p.terminal !== undefined) {
      const node = p.node ?? this.deps.self().id;
      const t = this.deps.terminals(node)?.find((x) => x.host === p.terminal!.host && x.id === p.terminal!.id && x.status === "running");
      if (!t) throw new RpcError("not_found", "no such terminal is running");
      const s = this.sessionInTerminal(node, p.terminal);
      return { node, terminal: { host: t.host, id: t.id }, ...(s ? { session: s } : {}) };
    }
    throw new RpcError("invalid", "name the session or the terminal the connection is for");
  }

  private sessionInTerminal(node: string, ref: TerminalRef): Session | undefined {
    return this.deps
      .sessions()
      .filter((s) => s.status !== "ended" && s.node === node && s.role !== "assistant" && sameTerminal(s.native.terminal, ref))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  /** The agent session at this end now: the one in the terminal, or the session it lives with. */
  private sessionOf(row: Pick<ConnectionRow, "node" | "terminal" | "session">): Session | undefined {
    if (row.terminal) return this.sessionInTerminal(row.node, row.terminal);
    const s = row.session !== undefined ? this.deps.sessions().find((x) => x.id === row.session) : undefined;
    return s && s.status !== "ended" ? s : undefined;
  }

  /** Whether `s` is this connection's end now. */
  private isEnd(row: ConnectionRow, s: Session): boolean {
    if (row.terminal) return s.node === row.node && sameTerminal(s.native.terminal, row.terminal);
    return row.session === s.id;
  }

  /** This end as the other side is told it: the agent's name there, else the terminal's. */
  private endInfo(row: Pick<ConnectionRow, "node" | "terminal" | "session">, s = this.sessionOf(row)): ConnectionEndInfo {
    if (s) return { name: base(s), harness: s.harness, live: true };
    const t = row.terminal ? this.deps.terminals(row.node)?.find((x) => sameTerminal({ host: x.host, id: x.id }, row.terminal)) : undefined;
    const name = slug(t?.name ?? folderOf(t?.cwd ?? "") ?? "") || "terminal";
    return { name, live: false };
  }

  /** The words for where an end is: its agent and machine. */
  private where(row: Pick<ConnectionRow, "node" | "terminal" | "session">, s = this.sessionOf(row)): string {
    const machine = this.deps.nodeName(row.node);
    if (!s) return `a terminal on ${machine}`;
    return `${base(s)} (${HARNESS_WORDS[s.harness] ?? s.harness} on ${machine})`;
  }

  // --- making one --------------------------------------------------------------------------------

  /**
   * An invite for another user to connect a terminal of theirs to the one `p` names: a pending
   * connection, and the code to hand them, good once, for fifteen minutes, for `for` alone
   * when it names a login.
   */
  async invite(p: Endpoint & { for?: string }, by: "app" | "agent"): Promise<{ connection: Connection; code: string; expiresAt: number }> {
    this.routing();
    this.reachable();
    const end = this.resolveEndpoint(p);
    const now = this.now();
    const id = newId("connection");
    const peer = newId("connection");
    const secret = randomBytes(32).toString("hex");
    const expiresAt = now + INVITE_MS;
    const { url, token } = await this.deps.cloud.relayGrant(peer, { kind: "connection", name: "connection invite", expiresAt });
    const row: ConnectionRow = {
      id,
      state: "pending",
      node: end.node,
      ...(end.terminal ? { terminal: end.terminal } : {}),
      ...(end.session ? { session: end.session.id } : {}),
      by,
      createdAt: now,
      expiresAt,
      ...(p.for ? { for: p.for.trim() } : {}),
      invite: { secretHash: sha256hex(secret), peer },
      sent: 0,
      received: 0,
      outbox: [],
      inbox: [],
    };
    this.rows.put(row);
    this.emit(row);
    this.log.info("connection invite made", { id, node: end.node, ...(end.terminal ? { terminal: end.terminal.id } : {}), ...(end.session ? { session: end.session.id } : {}), by, ...(p.for ? { for: p.for } : {}) });
    return { connection: this.client(row), code: connectionInviteText({ v: 1, id, secret, expiresAt, relay: { url, peer, token } }), expiresAt };
  }

  /**
   * Uses another user's code for the terminal `p` names: redeems it on its tunnel, checks who
   * made it, lets `confirm` ask (it throws to decline), and keeps the connection once the
   * other side has it too.
   */
  async accept(p: Endpoint & { code: string }, by: "app" | "agent", confirm?: (who: { user: string; name: string; harness?: string }, end: { node: string; terminal?: TerminalRef; session?: Session }) => Promise<void>): Promise<Connection> {
    this.routing();
    this.reachable();
    let body;
    try {
      body = parseConnectionInvite(p.code);
    } catch (e) {
      throw new RpcError("invalid", e instanceof InviteError ? e.message : "not a Cophyla connection code");
    }
    const now = this.now();
    if (body.expiresAt <= now) throw new RpcError("invalid", "the code has run out: ask for a new one");
    if (this.rows.get(body.id)) throw new RpcError("conflict", "that code was made here, or was used here already");
    if (originOf(body.relay.url) !== originOf(this.deps.cloud.serverUrl())) throw new RpcError("invalid", "the code is for another Cophyla server");
    const end = this.resolveEndpoint(p);
    const secretHash = sha256hex(body.secret);
    const inbound = newId("connection");
    const mine = await this.deps.cloud.relayGrant(inbound, { kind: "connection", name: "connection" });
    let sock: LinkSocket | undefined;
    let kept = false;
    try {
      const identity = await this.deps.cloud.attest(identityAudience(secretHash, "redeemer"));
      try {
        sock = await this.dial(body.relay, await pskFromSecret(body.secret));
      } catch (e) {
        if (e instanceof RpcError && e.code === "denied") throw new RpcError("denied", "the code was used already, or cancelled");
        throw new RpcError("unavailable", `the Cophyla that made the code cannot be reached now (${message(e)})`);
      }
      const rpc = clientOver(sock, this.log, `connection invite ${body.id}`);
      const answer = connectionLinkRequests["connection.redeem"].result.parse(
        await rpc.request("connection.redeem", { id: body.id, identity, end: this.endInfo({ node: end.node, ...(end.terminal ? { terminal: end.terminal } : {}) }, end.session), relay: { url: mine.url, peer: inbound, token: mine.token } }, { timeoutMs: REQUEST_MS }),
      );
      const who = this.deps.cloud.verifyIdentity(answer.identity, identityAudience(secretHash, "inviter"));
      if (who.subject === this.deps.cloud.subject()) throw new RpcError("denied", "that code was made on this same account: your own agents reach each other with list_agents");
      if (originOf(answer.relay.url) !== originOf(this.deps.cloud.serverUrl())) throw new RpcError("invalid", "the other side named another Cophyla server");
      if (confirm) await confirm({ user: who.login, name: answer.end.name, ...(answer.end.harness ? { harness: answer.end.harness } : {}) }, end);
      await rpc.request("connection.confirm", { id: body.id }, { timeoutMs: REQUEST_MS });
      const at = this.now();
      const row: ConnectionRow = {
        id: body.id,
        state: "active",
        node: end.node,
        ...(end.terminal ? { terminal: end.terminal } : {}),
        ...(end.session ? { session: end.session.id } : {}),
        by,
        createdAt: at,
        key: answer.key,
        inbound,
        outbound: answer.relay,
        peer: { user: who.login, subject: who.subject, name: answer.end.name, ...(answer.end.harness ? { harness: answer.end.harness } : {}), live: answer.end.live, seenAt: at },
        ...(end.session && this.deps.bypasses(end.session) ? { bypassOk: true } : {}),
        sent: 0,
        received: 0,
        outbox: [],
        inbox: [],
      };
      this.rows.put(row);
      kept = true;
      this.told.set(row.id, JSON.stringify(this.endInfo(row)));
      this.emit(row);
      this.log.info("connection made", { id: row.id, user: who.login, node: end.node, by });
      return this.client(row);
    } finally {
      sock?.close(1000, "redeemed");
      if (!kept) void this.deps.cloud.revokeRelay(inbound);
    }
  }

  /** Ends a connection at both ends, or a pending one's invite. */
  async end(id: string, reason: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", `no connection ${id}`);
    if (row.state === "pending") {
      this.rows.delete(id);
      this.redeeming.delete(id);
      if (row.invite) void this.deps.cloud.revokeRelay(row.invite.peer);
      this.emitEnded(row, reason);
      this.log.info("connection invite cancelled", { id, reason });
      return;
    }
    // the far end is told first, briefly; one that does not hear it learns at its next dial
    try {
      await this.request(row, "conn.end", { reason }, 5_000);
    } catch (e) {
      this.log.info("the far end was not told of the end", { id, error: message(e) });
    }
    this.drop(row, reason);
  }

  /** Forgets a connection here: its tunnel, its relay peer, and anything waiting. */
  private drop(row: ConnectionRow, reason: string): void {
    if (!this.rows.delete(row.id)) return;
    this.closeOut(row.id, "ended");
    if (row.inbound) void this.deps.cloud.revokeRelay(row.inbound);
    for (const k of [this.told, this.missing, this.seen, this.days]) k.delete(row.id);
    this.emitEnded(row, reason);
    this.log.info("connection ended", { id: row.id, reason, user: row.peer?.user });
  }

  // --- the far end's tunnels ---------------------------------------------------------------------

  /** A tunnel the other user's Cophyla opens: a live connection's, keyed from its key, or a pending invite's, keyed from its secret. */
  acceptTunnel(peer: string): ConnectionTunnel | undefined {
    if (!this.deps.routes()) return undefined;
    const active = this.rows.byInbound(peer);
    if (active?.key) {
      const id = active.id;
      return { psk: pskFromHex(active.key), accept: (sock) => serveOver(sock, this.log, `connection ${id}`, (m, p) => this.serveLink(id, m, p), () => undefined) };
    }
    const pending = this.rows.byInvitePeer(peer);
    if (pending?.invite && (pending.expiresAt ?? 0) > this.now()) {
      const id = pending.id;
      const tunnel: RedeemTunnel = {};
      return {
        psk: pskFromHex(pending.invite.secretHash),
        accept: (sock) => serveOver(sock, this.log, `connection invite ${id}`, (m, p) => this.serveRedeem(id, tunnel, m, p), () => this.redeemClosed(id, tunnel)),
      };
    }
    return undefined;
  }

  /** The invite's tunnel: `connection.redeem`, then `connection.confirm`, and nothing else. */
  private async serveRedeem(id: string, tunnel: RedeemTunnel, method: string, params: unknown): Promise<unknown> {
    if (method === "connection.redeem") {
      const p = connectionLinkRequests["connection.redeem"].params.safeParse(params);
      if (!p.success) throw new RpcError("invalid", "bad connection.redeem");
      const row = this.rows.get(id);
      if (!row || row.state !== "pending" || !row.invite || p.data.id !== id) throw new RpcError("denied", "that code is no longer open");
      if ((row.expiresAt ?? 0) <= this.now()) throw new RpcError("denied", "the code has run out");
      if (this.redeeming.has(id)) throw new RpcError("conflict", "the code is being used");
      const who = this.deps.cloud.verifyIdentity(p.data.identity, identityAudience(row.invite.secretHash, "redeemer"));
      if (who.subject === this.deps.cloud.subject()) throw new RpcError("denied", "that is this same account: its agents reach each other with list_agents");
      if (row.for && who.login.toLowerCase() !== row.for.toLowerCase()) throw new RpcError("denied", `the code is for ${row.for}`);
      if (originOf(p.data.relay.url) !== originOf(this.deps.cloud.serverUrl())) throw new RpcError("invalid", "the code's server is not the one named");
      const at = this.now();
      const hold: Redeeming = {
        tunnel,
        inbound: newId("connection"),
        key: randomBytes(32).toString("hex"),
        outbound: p.data.relay,
        peer: { user: who.login, subject: who.subject, name: p.data.end.name, ...(p.data.end.harness ? { harness: p.data.end.harness } : {}), live: p.data.end.live, seenAt: at },
        at,
      };
      // spent before anything is awaited: a second redemption meets it
      this.redeeming.set(id, hold);
      try {
        const mine = await this.deps.cloud.relayGrant(hold.inbound, { kind: "connection", name: "connection" });
        const identity = await this.deps.cloud.attest(identityAudience(row.invite.secretHash, "inviter"));
        return { identity, end: this.endInfo(row), relay: { url: mine.url, peer: hold.inbound, token: mine.token }, key: hold.key };
      } catch (e) {
        if (this.redeeming.get(id) === hold) this.redeeming.delete(id);
        void this.deps.cloud.revokeRelay(hold.inbound);
        throw e;
      }
    }
    if (method === "connection.confirm") {
      const hold = this.redeeming.get(id);
      const row = this.rows.get(id);
      if (!hold || hold.tunnel !== tunnel || !row || row.state !== "pending" || !row.invite) throw new RpcError("denied", "nothing to confirm on this tunnel");
      this.redeeming.delete(id);
      const invitePeer = row.invite.peer;
      const s = this.sessionOf(row);
      const { invite: _invite, expiresAt: _expires, for: _for, ...rest } = row;
      const active: ConnectionRow = {
        ...rest,
        state: "active",
        ...(s ? { session: s.id } : {}),
        key: hold.key,
        inbound: hold.inbound,
        outbound: hold.outbound,
        peer: hold.peer,
        ...(s && this.deps.bypasses(s) ? { bypassOk: true } : {}),
      };
      this.rows.put(active);
      this.told.set(id, JSON.stringify(this.endInfo(active)));
      // the invite's peer goes once this tunnel has carried the answer and closed; a while later at the latest
      tunnel.spent = invitePeer;
      tunnel.timer = setTimeout(() => this.spend(tunnel), 30_000);
      if (typeof tunnel.timer === "object" && "unref" in tunnel.timer) tunnel.timer.unref();
      this.emit(active);
      this.log.info("connection made", { id, user: hold.peer.user, node: row.node, by: row.by });
      void this.audit("connection.accept", undefined, active, `${hold.peer.user}'s ${hold.peer.name} used the invite`);
      return {};
    }
    throw new RpcError("unsupported", `unsupported: ${method}`);
  }

  /** A confirmed invite's relay peer is let go. */
  private spend(tunnel: RedeemTunnel): void {
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.timer = undefined;
    const peer = tunnel.spent;
    tunnel.spent = undefined;
    if (peer) void this.deps.cloud.revokeRelay(peer);
  }

  /** The invite's tunnel closed: a confirmed invite's peer goes; a redemption that never confirmed leaves the invite open again. */
  private redeemClosed(id: string, tunnel: RedeemTunnel): void {
    if (tunnel.spent) {
      this.spend(tunnel);
      return;
    }
    const hold = this.redeeming.get(id);
    if (!hold || hold.tunnel !== tunnel) return;
    this.redeeming.delete(id);
    void this.deps.cloud.revokeRelay(hold.inbound);
    this.log.info("connection invite open again: its redemption stopped short", { id });
  }

  /** A live connection's tunnel: the `conn.*` requests, about this connection alone. */
  private async serveLink(id: string, method: string, params: unknown): Promise<unknown> {
    const row = this.rows.get(id);
    if (!row || row.state !== "active") throw new RpcError("denied", "no such connection");
    const name = method as keyof typeof connectionLinkRequests;
    const def = connectionLinkRequests[name];
    if (!def || !name.startsWith("conn.")) throw new RpcError("unsupported", `unsupported: ${method}`);
    const parsed = def.params.safeParse(params);
    if (!parsed.success) throw new RpcError("invalid", `bad ${method}`);
    this.update(id, (r) => {
      if (r.peer) r.peer.seenAt = this.now();
    });
    switch (name) {
      case "conn.send":
        return this.receive(id, parsed.data as { id: string; text: string; replyTo?: string; from: ConnectionEndInfo; sentAt: number });
      case "conn.state": {
        const end = parsed.data as ConnectionEndInfo;
        this.update(id, (r) => {
          if (r.peer) r.peer = { ...r.peer, name: end.name, live: end.live, ...(end.harness ? { harness: end.harness } : {}) };
          if (r.peer && !end.harness) delete r.peer.harness;
        });
        void this.flushOutbox(id);
        return {};
      }
      case "conn.notice": {
        const n = parsed.data as { about: string; why: string };
        const alias = row.peer ? peerAlias(row.peer) : "the other side";
        await this.notify(row, this.sentBy.get(n.about), `Your message ${n.about} to ${alias} was not delivered: ${n.why}.`, n.about);
        return {};
      }
      case "conn.end": {
        const why = (parsed.data as { reason: string }).reason;
        this.drop(row, `${row.peer?.user ?? "the other side"} ended it (${why})`);
        return {};
      }
      case "conn.file.send": {
        const f = parsed.data as PeerFileSend;
        // the agent at this end: a file waits for none, as a message would
        const s = this.sessionOf(row);
        if (!s || !this.deps.linked(s.node)) throw new RpcError("unavailable", "no agent runs at that end now: send it again once one does");
        return this.files().incoming(this.link(row), f, s);
      }
      case "conn.file.tree":
        return this.files().serveTree(this.link(row), parsed.data as { file: string; from?: number });
      case "conn.file.read":
        return this.files().serveRead(this.link(row), parsed.data as { file: string; rel?: string; at: number });
      case "conn.file.done":
        await this.files().doneThere(this.link(row), parsed.data as { file: string; ok: boolean; why?: string });
        return {};
      default:
        throw new RpcError("unsupported", `unsupported: ${method}`);
    }
  }

  /** The connection as the files module names the other end. */
  private link(row: ConnectionRow): PeerLink {
    return { kind: "connection", id: row.id, user: row.peer?.user ?? "someone" };
  }

  private files(): PeerFiles {
    const f = this.deps.files?.();
    if (!f) throw new RpcError("unavailable", "files on connections are off here");
    return f;
  }

  /** The far end's agent a file from `caller` goes to, as a message's does: one of `caller`'s connections. */
  fileTarget(caller: Session, to: string): { link: PeerLink; name: string; alias: string } {
    this.routing();
    const found = this.resolveFor(caller, to);
    if (!found) throw new RpcError("not_found", `this session has no connection called "${to}": list_agents shows the ones it has`);
    const { row, alias } = found;
    if (!row.peer) throw new RpcError("unavailable", "the connection is not live");
    return { link: this.link(row), name: row.peer.name, alias };
  }

  /** A file request to the other side, on the connection's tunnel, given longer than a message: a piece of a file is big. */
  async fileRequest(id: string, method: string, params: unknown): Promise<unknown> {
    const row = this.rows.get(id);
    if (!row || row.state !== "active") throw new RpcError("not_found", `no connection ${id}`);
    try {
      return await this.request(row, method, params, FILE_REQUEST_MS);
    } catch (e) {
      if (farEnded(e)) this.drop(row, `${row.peer?.user ?? "the other side"} ended it`);
      throw e;
    }
  }

  /** Reads, changes and keeps a row, and tells the clients. */
  private update(id: string, change: (row: ConnectionRow) => void): ConnectionRow | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    change(row);
    this.rows.put(row);
    this.emit(row);
    return row;
  }

  private day(id: string): { day: string; in: number; out: number } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    let d = this.days.get(id);
    if (!d || d.day !== today) this.days.set(id, (d = { day: today, in: 0, out: 0 }));
    return d;
  }

  // --- messages in ---------------------------------------------------------------------------------

  /** A message from the far end's agent: checked, then delivered, asked about, or kept until an agent runs here. */
  private async receive(id: string, p: { id: string; text: string; replyTo?: string; from: ConnectionEndInfo; sentAt: number }): Promise<{ status: ConnectionSendStatus }> {
    const row = this.rows.get(id)!;
    let seen = this.seen.get(id);
    if (!seen) this.seen.set(id, (seen = new Set()));
    // a message sent again after its answer was lost: it is not delivered twice
    if (seen.has(p.id)) return { status: "sent" };
    const remote = `R:${id}`;
    const local = `L:${id}`;
    const alias = row.peer ? peerAlias(row.peer) : "the other side";
    const { hops } = this.limits.hops(remote, p.replyTo);
    const day = this.day(id);
    const why = this.limits.check(remote, local, "this agent", p.text, hops) ?? (day.in >= PER_DAY ? `the connection took ${PER_DAY} messages today, the most it takes in a day` : undefined);
    if (why) {
      this.log.info("a connection's message refused", { id, why });
      throw new RpcError("denied", why);
    }
    seen.add(p.id);
    if (seen.size > SEEN) seen.delete(seen.values().next().value!);
    this.limits.record(p.id, remote, local, p.text, hops);
    day.in++;
    const q: Queued = { id: p.id, text: p.text, ...(p.replyTo ? { replyTo: p.replyTo } : {}), from: p.from, at: this.now() };
    this.log.info("a connection's message came in", { id, message: p.id, from: alias, hops });
    if (row.inbox.length > 0 || this.escalating.has(id)) return this.keep(id, q);
    return this.deliverIn(id, q);
  }

  /** Keeps the far end's message until an agent runs here to take it. */
  private keep(id: string, q: Queued): { status: ConnectionSendStatus } {
    const row = this.rows.get(id)!;
    if (row.inbox.length >= QUEUE_MAX) throw new RpcError("denied", `${QUEUE_MAX} messages already wait in that terminal for an agent to run there`);
    this.update(id, (r) => r.inbox.push(q));
    void this.flushInbox(id);
    return { status: "waiting" };
  }

  /** Delivers one message into the agent at this end, or keeps it, or asks first. */
  private async deliverIn(id: string, q: Queued): Promise<{ status: ConnectionSendStatus }> {
    const row = this.rows.get(id)!;
    const s = this.sessionOf(row);
    if (!s || !this.deps.linked(s.node)) return this.keep(id, q);
    if (this.deps.bypasses(s) && !row.bypassOk) {
      this.update(id, (r) => r.inbox.push(q));
      this.escalate(id, s, q);
      return { status: "pending" };
    }
    const r = await this.deliverTo(row, s, q);
    return { status: r.status === "held" ? "held" : "sent" };
  }

  private async deliverTo(row: ConnectionRow, s: Session, q: Queued): Promise<{ status: "queued" | "held" }> {
    const user = row.peer?.user ?? "unknown";
    const info: EnvelopeInfo = {
      peer: { connection: row.id, user, name: q.from.name, ...(q.from.harness ? { harness: q.from.harness } : {}) },
      messageId: q.id,
      ...(q.replyTo ? { replyTo: q.replyTo } : {}),
    };
    const r = await this.deps.gate.run(
      { principal: { kind: "system" }, action: "connection.deliver", target: s.id, args: { connection: row.id, from: peerAlias({ user, name: q.from.name }), text: cap(q.text), id: q.id } },
      () => this.deps.deliver(s, q.text, info),
    );
    this.update(row.id, (x) => {
      x.received++;
      x.lastAt = this.now();
    });
    return r;
  }

  /** Asks the user before the far end's messages reach a session that runs without prompts; their answer stands for the connection. */
  private escalate(id: string, s: Session, q: Queued): void {
    if (this.escalating.has(id)) return;
    const row = this.rows.get(id)!;
    const who = row.peer ? `${row.peer.user}'s agent ${row.peer.name}` : "another user's agent";
    const ask = this.deps.asks.open(
      {
        type: "choice",
        source: { kind: "harness", session: s.id },
        title: `Let ${who} message ${base(s)}, which runs without permission prompts?`,
        detail: `It comes on a connection to ${this.where(row, s)}. Allowing it lets this connection's messages into a session that does not ask before it acts. The first: ${cap(q.text, 600)}`,
        options: allowDeny("Allow on this connection", "Don't"),
        answerableBy: ["user"],
        expiresAt: this.now() + ESCALATE_MS,
      },
      this.now(),
      this.deps.self().id,
    );
    this.escalating.set(id, ask.id);
    void this.deps.asks.wait(ask.id).then(async (settled) => {
      this.escalating.delete(id);
      const allowed = settled.status === "answered" && settled.answer?.option === "allow";
      if (allowed) {
        this.update(id, (r) => (r.bypassOk = true));
        this.log.info("a connection may reach a session that runs without prompts", { id, session: s.id });
        await this.flushInbox(id);
        return;
      }
      // refused: what waited goes back as not delivered
      const r = this.rows.get(id);
      if (!r) return;
      const refused = r.inbox.splice(0);
      this.rows.put(r);
      this.emit(r);
      const why = settled.status === "expired" ? "no one answered the approval in time" : "the user did not allow it";
      for (const m of refused) void this.request(r, "conn.notice", { about: m.id, why }).catch(() => undefined);
    });
  }

  /** Runs one flush of a connection's queue at a time; one asked for meanwhile runs once that one ends. */
  private async once(key: string, run: () => Promise<void>): Promise<void> {
    if (this.flushing.has(key)) {
      this.again.add(key);
      return;
    }
    this.flushing.add(key);
    try {
      do {
        this.again.delete(key);
        await run();
      } while (this.again.has(key));
    } finally {
      this.flushing.delete(key);
    }
  }

  /** Delivers what waits here, in order, while an agent runs in the terminal and may take it. */
  private flushInbox(id: string): Promise<void> {
    return this.once(`in:${id}`, () => this.drainInbox(id));
  }

  private async drainInbox(id: string): Promise<void> {
    for (;;) {
      const row = this.rows.get(id);
      if (!row || row.inbox.length === 0 || this.escalating.has(id)) return;
      const s = this.sessionOf(row);
      if (!s || !this.deps.linked(s.node)) return;
      const q = row.inbox[0]!;
      if (this.deps.bypasses(s) && !row.bypassOk) {
        this.escalate(id, s, q);
        return;
      }
      try {
        await this.deliverTo(row, s, q);
      } catch (e) {
        this.log.warn("a waiting message could not be delivered yet", { id, message: q.id, error: message(e) });
        return;
      }
      this.update(id, (r) => {
        r.inbox = r.inbox.filter((m) => m.id !== q.id);
      });
    }
  }

  // --- messages out ---------------------------------------------------------------------------------

  /** The connections whose end is `s` now, with the name each is sent to by. */
  private ofSession(s: Session): { row: ConnectionRow; alias: string }[] {
    const rows = this.rows.list().filter((r) => r.state === "active" && r.peer && this.isEnd(r, s));
    const counts = new Map<string, number>();
    const plain = (r: ConnectionRow) => `${slug(r.peer!.user) || "someone"}/${slug(r.peer!.name) || "agent"}`;
    for (const r of rows) counts.set(plain(r), (counts.get(plain(r)) ?? 0) + 1);
    return rows.sort((a, b) => a.createdAt - b.createdAt).map((row) => ({ row, alias: (counts.get(plain(row)) ?? 0) > 1 ? row.id : plain(row) }));
  }

  /** What `list_agents` shows of the connections `s` is an end of. */
  listing(s: Session): ConnectionListing[] {
    if (!this.deps.routes()) return [];
    return this.ofSession(s).map(({ row, alias }) => ({
      connection: row.id,
      alias,
      user: row.peer!.user,
      name: row.peer!.name,
      ...(row.peer!.harness ? { harness: row.peer!.harness } : {}),
      ...(row.peer!.live !== undefined ? { live: row.peer!.live } : {}),
      ...(row.peer!.seenAt !== undefined ? { seenAt: row.peer!.seenAt } : {}),
      ...(row.outbox.length > 0 ? { queued: row.outbox.length } : {}),
    }));
  }

  /** The connection of `s` that `to` names: its id, its name, the login alone or the name alone where one connection has it. */
  resolveFor(s: Session, to: string): { row: ConnectionRow; alias: string } | undefined {
    const want = to.trim();
    const key = want.toLowerCase();
    const mine = this.ofSession(s);
    if (/^con_/i.test(want)) return mine.find((m) => m.row.id.toLowerCase() === key);
    const exact = mine.filter((m) => m.alias === key || peerAlias(m.row.peer!).toLowerCase() === key);
    if (exact.length === 1) return exact[0];
    const byUser = mine.filter((m) => m.row.peer!.user.toLowerCase() === key);
    if (byUser.length === 1) return byUser[0];
    return undefined;
  }

  /** Whether `to` could only mean a connection: a `con_` id, or `<login>/<name>`. */
  static names(to: string): boolean {
    return /^con_/i.test(to.trim()) || to.includes("/");
  }

  /** A message from the agent at this end to the far end's. */
  async send(caller: Session, p: { to: string; text: string; replyTo?: string }): Promise<ConnectionSendAnswer> {
    this.routing();
    const found = this.resolveFor(caller, p.to);
    if (!found) throw new RpcError("not_found", `this session has no connection called "${p.to}": list_agents shows the ones it has`);
    const { row, alias } = found;
    const local = `L:${row.id}`;
    const remote = `R:${row.id}`;
    const { hops } = this.limits.hops(local, p.replyTo);
    const day = this.day(row.id);
    const why = this.limits.check(local, remote, alias, p.text, hops) ?? (day.out >= PER_DAY ? `this connection carried ${PER_DAY} of your messages today, the most it carries in a day` : undefined);
    if (why) throw new RpcError("denied", why);
    const id = newId("agentMessage");
    this.limits.record(id, local, remote, p.text, hops);
    day.out++;
    this.sentBy.set(id, caller.id);
    while (this.sentBy.size > 2000) this.sentBy.delete(this.sentBy.keys().next().value!);
    const q: Queued = { id, text: p.text, ...(p.replyTo ? { replyTo: p.replyTo } : {}), from: this.endInfo(row, caller), at: this.now(), sender: caller.id };
    return this.deps.gate.run(
      {
        principal: { kind: "harness", session: caller.id },
        action: "connection.send",
        target: row.id,
        args: { to: alias, user: row.peer?.user, text: cap(p.text), ...(p.replyTo ? { replyTo: p.replyTo } : {}), id },
        sessionKey: caller.id,
      },
      async () => {
        const answer = { id, connection: row.id, alias };
        // what waits goes first: this one goes behind it
        if ((this.rows.get(row.id)?.outbox.length ?? 0) > 0) {
          this.queueOut(row.id, q);
          void this.flushOutbox(row.id);
          return { ...answer, status: "queued" as const };
        }
        try {
          const status = await this.sendNow(row, q);
          return { ...answer, status };
        } catch (e) {
          if (farEnded(e)) {
            this.drop(row, `${row.peer?.user ?? "the other side"} ended it`);
            throw new RpcError("unavailable", `${alias} ended the connection; not sent`);
          }
          if (e instanceof RpcError && (e.code === "denied" || e.code === "invalid")) throw e;
          this.queueOut(row.id, q);
          this.scheduleRetry();
          return { ...answer, status: "queued" as const };
        }
      },
    );
  }

  /** Sends one message on the connection's tunnel; counts it once the far end took it. */
  private async sendNow(row: ConnectionRow, q: Queued): Promise<ConnectionSendStatus> {
    const r = connectionLinkRequests["conn.send"].result.parse(await this.request(row, "conn.send", { id: q.id, text: q.text, ...(q.replyTo ? { replyTo: q.replyTo } : {}), from: q.from, sentAt: q.at }));
    this.update(row.id, (x) => {
      x.sent++;
      x.lastAt = this.now();
      if (x.peer) x.peer.seenAt = this.now();
    });
    return r.status;
  }

  private queueOut(id: string, q: Queued): void {
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", "the connection ended");
    if (row.outbox.length >= QUEUE_MAX) throw new RpcError("unavailable", `${QUEUE_MAX} of your messages already wait for ${row.peer?.user ?? "the other side"}'s Cophyla to be reached; not sent`);
    this.update(id, (r) => r.outbox.push(q));
  }

  /** Sends what waits here for the far end, in order, until it cannot be reached. */
  private flushOutbox(id: string): Promise<void> {
    return this.once(`out:${id}`, () => this.drainOutbox(id));
  }

  private async drainOutbox(id: string): Promise<void> {
    for (;;) {
      const row = this.rows.get(id);
      if (!row || row.outbox.length === 0) return;
      const q = row.outbox[0]!;
      try {
        await this.sendNow(row, q);
      } catch (e) {
        if (farEnded(e)) {
          this.drop(row, `${row.peer?.user ?? "the other side"} ended it`);
          return;
        }
        if (e instanceof RpcError && (e.code === "denied" || e.code === "invalid")) {
          // the far end refused it: its sender hears why, and the next goes
          this.update(id, (r) => (r.outbox = r.outbox.filter((m) => m.id !== q.id)));
          await this.notify(row, q.sender, `Your message ${q.id} to ${row.peer ? peerAlias(row.peer) : "the other side"} was not delivered: ${e.message}.`, q.id);
          continue;
        }
        this.scheduleRetry();
        return;
      }
      this.update(id, (r) => (r.outbox = r.outbox.filter((m) => m.id !== q.id)));
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const waiting = this.rows.list().filter((r) => r.state === "active" && r.outbox.length > 0);
      this.retryMs = waiting.length > 0 ? Math.min(this.retryMs * 2, 10 * 60_000) : 30_000;
      for (const r of waiting) void this.flushOutbox(r.id);
    }, this.retryMs);
    if (typeof this.retryTimer === "object" && "unref" in this.retryTimer) this.retryTimer.unref();
  }

  /** The server link came back: whatever waits for a far end is tried again now. */
  linkUp(): void {
    this.retryMs = 30_000;
    for (const r of this.rows.list()) if (r.state === "active" && r.outbox.length > 0) void this.flushOutbox(r.id);
  }

  /** One request on the connection's own tunnel, opened for it when none is. */
  private async request(row: ConnectionRow, method: string, params: unknown, timeoutMs = REQUEST_MS): Promise<unknown> {
    // every request and its answer are two frames: kept under the server's cap on the tunnel
    await this.pacer.take(row.id);
    const rpc = await this.rpcFor(row);
    const entry = this.out.get(row.id);
    if (entry) this.idle(row.id, entry);
    return rpc.request(method, params, { timeoutMs });
  }

  private async rpcFor(row: ConnectionRow): Promise<RpcPeer> {
    const live = this.out.get(row.id);
    if (live?.rpc.open) return live.rpc;
    const opening = this.opening.get(row.id);
    if (opening) return opening;
    if (!row.outbound || !row.key) throw new RpcError("unavailable", "the connection is not live");
    const outbound = row.outbound;
    const key = row.key;
    const p = (async () => {
      const sock = await this.dial(outbound, pskFromHex(key));
      const rpc = clientOver(sock, this.log, `connection ${row.id}`);
      const entry: Outbound = { rpc, sock };
      this.out.set(row.id, entry);
      sock.onClose(() => {
        if (this.out.get(row.id) === entry) this.out.delete(row.id);
        if (entry.timer) clearTimeout(entry.timer);
      });
      this.idle(row.id, entry);
      return rpc;
    })();
    this.opening.set(row.id, p);
    try {
      return await p;
    } finally {
      this.opening.delete(row.id);
    }
  }

  private idle(id: string, entry: Outbound): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.closeOut(id, "idle"), IDLE_MS);
    if (typeof entry.timer === "object" && "unref" in entry.timer) entry.timer.unref();
  }

  private closeOut(id: string, reason: string): void {
    const entry = this.out.get(id);
    if (!entry) return;
    this.out.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.rpc.close(reason);
    entry.sock.close(1000, reason);
  }

  /** A notice of cophyla's own into the session that sent a message, or the one at this end now. */
  private async notify(row: ConnectionRow, sender: string | undefined, text: string, replyTo: string): Promise<void> {
    const s = (sender !== undefined ? this.deps.sessions().find((x) => x.id === sender && x.status !== "ended") : undefined) ?? this.sessionOf(row);
    if (!s || !this.deps.linked(s.node)) return;
    try {
      await this.deps.deliver(s, text, { messageId: newId("agentMessage"), replyTo });
    } catch (e) {
      this.log.warn("a connection's notice could not be delivered", { id: row.id, error: message(e) });
    }
  }

  // --- the terminal's life -------------------------------------------------------------------------

  /** A terminal's row: one that exited ends its connections, said by its own node, never by a link that dropped. */
  private onTerminal(t: Terminal): void {
    if (t.status !== "exited" || !this.deps.routes()) return;
    if (t.node !== this.deps.self().id && !this.deps.linked(t.node)) return;
    for (const row of this.rows.list()) {
      if (row.node === t.node && sameTerminal(row.terminal, { host: t.host, id: t.id })) void this.terminalGone(row, "its terminal closed");
    }
  }

  /** A session's row: a session's end lets its connection go when it had no terminal; a new agent in a terminal is told to the far end and takes what waits. */
  private onSession(s: Session): void {
    if (!this.deps.routes()) return;
    for (const row of this.rows.list()) {
      if (row.state !== "active" || !this.isEnd(row, s)) continue;
      if (!row.terminal && s.status === "ended") {
        if (s.node === this.deps.self().id || this.deps.linked(s.node)) void this.terminalGone(row, "its session ended");
        continue;
      }
      if (row.inbox.length > 0 && s.status !== "ended") void this.flushInbox(row.id);
    }
    this.tellLater();
  }

  /** Tells each far end what changed at this end, a moment after the last change. */
  private tellLater(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      for (const row of this.rows.list()) {
        if (row.state !== "active") continue;
        const end = this.endInfo(row);
        const text = JSON.stringify(end);
        if (this.told.get(row.id) === text) continue;
        const s = this.sessionOf(row);
        if (s && row.session !== s.id) this.update(row.id, (r) => (r.session = s.id));
        else this.emit(row);
        void this.request(row, "conn.state", end)
          .then(() => this.told.set(row.id, text))
          .catch(() => undefined);
      }
    }, 2_000);
    if (typeof this.stateTimer === "object" && "unref" in this.stateTimer) this.stateTimer.unref();
  }

  private async terminalGone(row: ConnectionRow, reason: string): Promise<void> {
    if (row.state === "pending") {
      await this.end(row.id, reason).catch(() => undefined);
      return;
    }
    await this.end(row.id, reason).catch((e: unknown) => this.log.warn("a connection could not be ended", { id: row.id, error: message(e) }));
  }

  /**
   * Looks every connection over: an invite run out goes; a terminal its node no longer runs,
   * missing twice in a row while that node is reached, ends its connection; what waited past
   * its day goes back as not delivered; what waits is tried again.
   */
  async sweep(): Promise<void> {
    if (!this.deps.routes()) return;
    const now = this.now();
    for (const [id, hold] of [...this.redeeming]) if (now - hold.at > REDEEM_MS) this.redeeming.delete(id);
    for (const row of this.rows.list()) {
      if (row.state === "pending") {
        if ((row.expiresAt ?? 0) <= now && !this.redeeming.has(row.id)) await this.end(row.id, "its invite ran out").catch(() => undefined);
        continue;
      }
      // its end gone: a terminal its node no longer runs, or a session with no terminal that is no
      // longer live (one that ended while this daemon was down tells nothing), missed twice
      const reached = row.node === this.deps.self().id || this.deps.linked(row.node);
      let there: boolean | undefined;
      if (row.terminal) {
        const list = this.deps.terminals(row.node);
        there = list === undefined ? undefined : list.some((t) => t.status === "running" && sameTerminal({ host: t.host, id: t.id }, row.terminal));
      } else {
        there = reached ? this.sessionOf(row) !== undefined : undefined;
      }
      if (there !== false) this.missing.delete(row.id);
      else {
        const n = (this.missing.get(row.id) ?? 0) + 1;
        this.missing.set(row.id, n);
        if (n >= 2) {
          await this.terminalGone(row, row.terminal ? "its terminal closed" : "its session ended");
          continue;
        }
      }
      const stale = (m: Queued) => now - m.at > QUEUE_MS;
      if (row.outbox.some(stale) || row.inbox.some(stale)) {
        const goneOut = row.outbox.filter(stale);
        const goneIn = row.inbox.filter(stale);
        this.update(row.id, (r) => {
          r.outbox = r.outbox.filter((m) => !stale(m));
          r.inbox = r.inbox.filter((m) => !stale(m));
        });
        for (const m of goneOut) await this.notify(row, m.sender, `Your message ${m.id} to ${row.peer ? peerAlias(row.peer) : "the other side"} was not delivered: their Cophyla could not be reached for a day.`, m.id);
        for (const m of goneIn) void this.request(row, "conn.notice", { about: m.id, why: "no agent ran in that terminal for a day" }).catch(() => undefined);
      }
      if (row.inbox.length > 0) void this.flushInbox(row.id);
    }
  }

  // --- the agent's tools ---------------------------------------------------------------------------

  /**
   * One of the connection tools, called by the agent `caller`: making an invite or using one
   * asks its user first, always, and the answer is never remembered; ending one does not ask.
   * A call the user has not answered within a while is told so, and the outcome reaches the
   * session later as a notice of cophyla's own.
   */
  async tool(caller: Session, name: "create_invite" | "accept_invite" | "end_connection", args: Record<string, unknown>, bypasses?: boolean): Promise<string> {
    this.routing();
    if (name === "end_connection") {
      const to = typeof args["to"] === "string" ? args["to"] : "";
      if (!to.trim()) throw new RpcError("invalid", "end_connection needs to: the connected agent's name as list_agents gives it, or the con_ id");
      const found = this.resolveFor(caller, to);
      if (!found) throw new RpcError("not_found", `this session has no connection called "${to}"`);
      await this.audit("connection.end", caller, found.row, "ended by the agent");
      await this.end(found.row.id, `ended by the agent ${base(caller)}`);
      return `The connection to ${found.alias} has ended at both ends.`;
    }
    this.reachable();
    const alias = base(caller);
    const where = this.where({ node: caller.node, ...(caller.native.terminal ? { terminal: caller.native.terminal } : {}), session: caller.id }, caller);
    const bypass = (bypasses ?? this.deps.bypasses(caller)) ? ` ${alias} runs without permission prompts: their agent's messages will reach it as they are.` : "";
    if (name === "create_invite") {
      const forLogin = typeof args["for"] === "string" && args["for"].trim() ? args["for"].trim() : undefined;
      const work = async (): Promise<string> => {
        await this.askUser(caller, `Let ${alias} make a code that connects another Cophyla user's agent to it?`, `Whoever uses the code within fifteen minutes${forLogin ? ` (only ${forLogin} may)` : ""} gets a connection to ${where}: their agent can message ${alias} and ${alias} theirs, until its terminal closes or either of you ends it.${bypass}`, "Make the code");
        const made = await this.invite({ session: caller.id, ...(forLogin ? { for: forLogin } : {}) }, "agent");
        await this.audit("connection.invite", caller, undefined, "an invite made");
        return `Your user allowed it. The code, good once for the next fifteen minutes${forLogin ? ` and only for ${forLogin}` : ""}:\n${made.code}\nGive it to your user to pass on to the other person; they use it with accept_invite in their agent, or in Cophyla under Connections. You can message their agent once they have.`;
      };
      return this.waitOrLater(caller, work, "Waiting for your user to allow the invite. Once they do, the code comes to you as a message from cophyla.");
    }
    const code = typeof args["code"] === "string" ? args["code"] : "";
    if (!code.trim()) throw new RpcError("invalid", "accept_invite needs code: the code the other person made, starting cophyla-connect:");
    const work = async (): Promise<string> => {
      const made = await this.accept({ session: caller.id, code }, "agent", async (who) => {
        await this.askUser(caller, `Connect ${alias} to ${who.user}'s agent ${who.name}?`, `${who.user} (on GitHub, as the Cophyla server vouches) made the code. Their agent will be able to message ${alias} and ${alias} theirs, until its terminal closes or either of you ends it.${bypass}`, "Connect");
      });
      const alias2 = made.peer ? `${made.peer.user}/${made.peer.name}` : made.id;
      await this.audit("connection.accept", caller, this.rows.get(made.id), `connected to ${alias2}`);
      return `Connected to ${alias2} (${made.id}). Its messages come marked external, from another person's agent; send_message with to set to ${alias2} reaches it.`;
    };
    return this.waitOrLater(caller, work, "Waiting for your user to allow the connection. You will be told by a message from cophyla whether it was made.");
  }

  /** Runs `work`, answering with its words when it ends soon, else with `later`, its outcome then reaching the session as a notice. */
  private async waitOrLater(caller: Session, work: () => Promise<string>, later: string): Promise<string> {
    const p = work();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((r) => (timer = setTimeout(() => r("slow"), TOOL_WAIT_MS)));
    try {
      const first = await Promise.race([p, slow]);
      if (first !== "slow") return first;
    } finally {
      if (timer) clearTimeout(timer);
    }
    p.then(
      (text) => this.noticeTo(caller, text),
      (e: unknown) => this.noticeTo(caller, refusal(e)),
    );
    return later;
  }

  private async noticeTo(s: Session, text: string): Promise<void> {
    try {
      await this.deps.deliver(s, text, { messageId: newId("agentMessage") });
    } catch (e) {
      this.log.warn("a connection tool's outcome could not be told", { session: s.id, error: message(e) });
    }
  }

  /** An ask only the user answers, never remembered: allowed, or a `denied`/`timeout` error. */
  private async askUser(caller: Session, title: string, detail: string, yes: string): Promise<void> {
    const ask: Ask = this.deps.asks.open(
      { type: "choice", source: { kind: "harness", session: caller.id }, title, detail, options: allowDeny(yes, "Don't"), answerableBy: ["user"], expiresAt: this.now() + ASK_MS },
      this.now(),
      this.deps.self().id,
    );
    const settled = await this.deps.asks.wait(ask.id);
    if (settled.status === "answered" && settled.answer?.option === "allow") return;
    if (settled.status === "expired") throw new RpcError("timeout", "your user did not answer in time; nothing was done");
    throw new RpcError("denied", "your user did not allow it; nothing was done");
  }

  /** An audit row for what an agent or a redemption did, as the gate keeps every other. */
  private async audit(action: "connection.invite" | "connection.accept" | "connection.end", s: Session | undefined, row: ConnectionRow | undefined, what: string): Promise<void> {
    try {
      await this.deps.gate.run({ principal: s ? { kind: "harness", session: s.id } : { kind: "system" }, action, ...(row ? { target: row.id } : {}), args: { what, ...(row?.peer ? { user: row.peer.user } : {}) }, ...(s ? { sessionKey: s.id } : {}) }, () => undefined);
    } catch {
      // a rule of the user's that denies it is told in the row itself
    }
  }
}

function allowDeny(yes: string, no: string): AskOption[] {
  return [
    { id: "allow", label: yes, style: "primary" },
    { id: "deny", label: no, style: "danger" },
  ];
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol.replace(/^ws/, "http")}//${u.host}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** A refusal as an agent reads it. */
export function refusal(e: unknown): string {
  const text = message(e);
  const why = text.endsWith(".") ? text.slice(0, -1) : text;
  return /nothing was done|not sent|not delivered/.test(why) ? `${why}.` : `Not done: ${why}.`;
}
