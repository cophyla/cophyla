// `teammates`: another Cophyla user made a teammate, a standing link between the two accounts'
// primaries through which each user's agents reach the other's in the folders they share, as
// the user's own agents on another machine are reached. Both users signed in. A connection
// (`connections/`) joins one terminal of each for one piece of work; a teammate is for the work
// two people do every day.
//
// Each side says what it shares (`share.ts`): folders with every folder under them, or every
// workspace but those named; and how open: every agent working there (`always`), or only the
// ones the user opens by hand (`chosen`). An agent in a shared folder may message the other
// side's open agents; an open agent may be messaged by the other side's agents; and any agent
// may answer a message it was sent. Each side answers for its own agents alone: what the other
// may reach is asked of it (`team.directory`), and what comes in is checked against this side's
// own sharing before it is delivered, never on the sender's word.
//
// Making one is a connection's redemption over again, keyed for teammates: a code good for a
// day or one use (`cophyla-team:`), a tunnel on the invite's throwaway relay peer keyed from its
// secret, each side's identity from the server bound to that redemption and to which side
// speaks, each side's own relay peer and a key the two share. It rides the relay as a
// connection's does (the `connection` peer kind), so the server routes it to each account's
// primary. Messages to a side that cannot be reached wait a day on this side; a teammate ended
// on either side ends at both, their agents leaving every group chat.

import { createHash, randomBytes } from "node:crypto";
import { InviteError, newId, parseTeammateInvite, RpcError, TEAMMATE_MAX_CHARS, teammateInviteText, teammateLinkRequests, teamAudience } from "@cophyla/protocol";
import type { AgentMode, ConnectionRelay, Focus, GroupEntry, Session, TeamAgent, Teammate, TeammateListing, TeammateShare, TeammateTheirs } from "@cophyla/protocol";
import { pskFromHex, pskFromSecret } from "@cophyla/relay";
import type { EnvelopeInfo } from "../agentmsg/envelope.ts";
import type { Focuses } from "../agentmsg/focus.ts";
import { Limits } from "../agentmsg/limits.ts";
import type { LimitsConfig } from "../agentmsg/limits.ts";
import type { Bus } from "../bus.ts";
import type { VerifiedIdentity } from "../cloud/identity.ts";
import type { ConnectionTunnel } from "../cloud/tunnels.ts";
import { clientOver, dialRelay, farEnded, IDLE_MS, REQUEST_MS, serveOver } from "../connections/link.ts";
import type { Dial } from "../connections/link.ts";
import type { Gate } from "../gate/index.ts";
import type { GroupTeams, Groups } from "../groups/index.ts";
import type { Logger } from "../log.ts";
import type { LinkSocket } from "../nodes/outbound.ts";
import type { RpcPeer } from "../rpc/peer.ts";
import type { Store } from "../store/index.ts";
import { placeKey, shares, tidyShare, within } from "./share.ts";
import type { PathPlatform } from "./share.ts";
import { clientTeammate, TeammateStore } from "./store.ts";
import type { TeammateRow, TeamQueued } from "./store.ts";

/** How long a teammate's code may be used. */
export const INVITE_MS = 24 * 60 * 60_000;
/** How many messages wait for the far side, and for how long. */
export const QUEUE_MAX = 50;
export const QUEUE_MS = 24 * 60 * 60_000;
/** How long a redemption may hold an invite before it confirms. */
const REDEEM_MS = 6 * 60_000;
/** How long a teammate's open agents are kept once asked for. */
const DIRECTORY_MS = 30_000;
const SWEEP_MS = 30_000;
/** One agent's messages to a teammate: the limits as a connection's, a conversation's length as the user's own agents'. */
const LIMITS: LimitsConfig = { max_chars: TEAMMATE_MAX_CHARS, per_minute: 6, per_target_per_minute: 6, duplicate_window_s: 300, max_hops: 12 };
/** Every agent's messages together, each way: a minute's, and a day's. */
const PER_MINUTE = 30;
const PER_DAY = 500;
/** How long a message this side sent may be answered by the agent it went to, whether or not this side's sender is open. */
const ANSWER_MS = 24 * 60 * 60_000;
const SEEN = 500;
const AUDIT_TEXT = 2000;


/** What the module needs of the account. */
export interface TeammateCloud {
  allowed(): RpcError | undefined;
  subject(): string | undefined;
  serverUrl(): string;
  relayGrant(peer: string, opts: { kind: "connection"; name?: string; expiresAt?: number }): Promise<{ url: string; token: string }>;
  revokeRelay(peer: string): Promise<boolean>;
  attest(aud: string): Promise<string>;
  verifyIdentity(token: string, aud: string): VerifiedIdentity;
}

export interface TeammatesDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  gate: Gate;
  /** Whether this node keeps the teammates: the primary, or a node in no cluster. */
  routes: () => boolean;
  cloud: TeammateCloud;
  /** Every session this node knows, its own and its linked nodes'. */
  sessions: () => Session[];
  /** The user's agents' aliases now, with every form each answers to. */
  names: () => Map<string, { alias: string; forms: string[] }>;
  /** The workspace a session works in (its name), and its folder. */
  place: (s: Session) => { workspace?: string; path: string };
  /** The user's workspaces on every machine: where they are, and their names. */
  places: () => { node: string; path: string; name: string }[];
  /** A node's platform, as `node:path` names it. */
  platformOf: (node: string) => PathPlatform;
  /** Delivers into a session wherever it is, past focus. */
  deliver: (s: Session, text: string, info: EnvelopeInfo) => Promise<{ status: "queued" | "held" }>;
  focus: Focuses;
  groups: () => Groups | undefined;
  linked: (node: string) => boolean;
  dial?: Dial;
  now?: () => number;
  sweepMs?: number;
}

interface RedeemTunnel {
  spent?: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface Redeeming {
  tunnel: RedeemTunnel;
  inbound: string;
  key: string;
  outbound: ConnectionRelay;
  peer: { user: string; subject: string };
  theirs: TeammateTheirs;
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

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol.replace(/^ws/, "http")}//${u.host}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export class Teammates {
  private deps: TeammatesDeps;
  private log: Logger;
  private rows: TeammateStore;
  private dial: Dial;
  private now: () => number;
  private limits: Limits;
  private redeeming = new Map<string, Redeeming>();
  private out = new Map<string, Outbound>();
  private opening = new Map<string, Promise<RpcPeer>>();
  /** The messages this side sent lately: who sent each, and to which teammate, so its answer reaches it. */
  private sentBy = new Map<string, { session: string; teammate: string; at: number }>();
  private seen = new Map<string, Set<string>>();
  private days = new Map<string, { day: string; in: number; out: number }>();
  private minutes = new Map<string, number[]>();
  private dirs = new Map<string, { at: number; agents: TeamAgent[]; theirs: TeammateTheirs }>();
  private flushing = new Set<string>();
  private again = new Set<string>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryMs = 30_000;

  constructor(deps: TeammatesDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.rows = new TeammateStore(deps.store);
    this.dial = deps.dial ?? dialRelay;
    this.now = deps.now ?? Date.now;
    this.limits = new Limits(() => LIMITS, this.now);
  }

  start(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), this.deps.sweepMs ?? SWEEP_MS);
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const id of [...this.out.keys()]) this.closeOut(id, "stopping");
  }

  // --- what clients see ---------------------------------------------------------------------------

  list(): Teammate[] {
    if (!this.deps.routes()) return [];
    return this.rows.list().map((r) => clientTeammate(this.refreshClosed(r)));
  }

  /** The active teammates, for the group chats' picker. */
  active(): { id: string; user: string }[] {
    if (!this.deps.routes()) return [];
    return this.rows
      .list()
      .filter((r) => r.state === "active" && r.peer)
      .map((r) => ({ id: r.id, user: r.peer!.user }));
  }

  private emit(row: TeammateRow): void {
    this.deps.bus.emit("teammate.state", clientTeammate(row));
  }

  private emitEnded(row: TeammateRow, reason: string): void {
    this.deps.bus.emit("teammate.state", { ...clientTeammate(row), state: "ended", reason });
  }

  private routing(): void {
    if (!this.deps.routes()) throw new RpcError("unavailable", "teammates are kept by the primary: ask there");
  }

  private reachable(): void {
    const why = this.deps.cloud.allowed();
    if (why) throw new RpcError("unavailable", `teammates need this Cophyla signed in, with the relay on its plan and the server reached (${why.message})`);
  }

  // --- sharing ----------------------------------------------------------------------------------------

  /** The place an agent works in: its workspace's folder, or its own. */
  private placeOf(s: Session): { node: string; path: string; workspace?: string } {
    const p = this.deps.place(s);
    return { node: s.node, path: p.path, ...(p.workspace ? { workspace: p.workspace } : {}) };
  }

  /** The keys of every place there is now: the workspaces and the folders agents work in. */
  private placeKeys(): string[] {
    const keys = new Set<string>();
    for (const w of this.deps.places()) keys.add(placeKey(w.node, w.path, this.deps.platformOf));
    for (const s of this.deps.sessions()) {
      if (s.status === "ended" || s.role === "assistant") continue;
      const p = this.placeOf(s);
      keys.add(placeKey(p.node, p.path, this.deps.platformOf));
    }
    return [...keys];
  }

  /** An exclude share's places that appeared since it was made: added to `closed`, told once. */
  private refreshClosed(row: TeammateRow): TeammateRow {
    if (row.share.mode !== "exclude" || !row.known) return row;
    const known = new Set(row.known);
    const closed = [...(row.share.closed ?? [])];
    const closedKeys = new Set(closed.map((c) => placeKey(c.node, c.path, this.deps.platformOf)));
    let added = false;
    const consider = (node: string, path: string) => {
      const k = placeKey(node, path, this.deps.platformOf);
      if (known.has(k) || closedKeys.has(k)) return;
      if (!shares(row.share, node, path, this.deps.platformOf)) return;
      closed.push({ node, path });
      closedKeys.add(k);
      added = true;
    };
    for (const w of this.deps.places()) consider(w.node, w.path);
    for (const s of this.deps.sessions()) {
      if (s.status === "ended" || s.role === "assistant") continue;
      const p = this.placeOf(s);
      consider(p.node, p.path);
    }
    if (!added) return row;
    row.share = { ...row.share, closed };
    this.rows.put(row);
    this.emit(row);
    this.log.info("a workspace shared closed with a teammate until the user opens it", { id: row.id, closed: closed.length });
    return row;
  }

  /** Whether an agent of this side works in what it shares with `row`. */
  private sharedWith(row: TeammateRow, s: Session): boolean {
    const p = this.placeOf(s);
    return shares(row.share, p.node, p.path, this.deps.platformOf);
  }

  /** Whether an agent of this side is open to `row`'s side now. */
  private openWith(row: TeammateRow, s: Session): boolean {
    if (s.status === "ended" || s.role === "assistant" || !this.sharedWith(row, s)) return false;
    if (row.share.opened?.includes(s.id)) return true;
    if (row.share.open !== "always") return false;
    const p = this.placeOf(s);
    return !within(row.share.closed ?? [], p.node, p.path, this.deps.platformOf);
  }

  /** What this side shares with `row`, as the other side is told it: how open, and the workspaces' names alone. */
  private summary(row: TeammateRow): TeammateTheirs {
    const names = new Set<string>();
    if (row.share.mode === "include") {
      for (const f of row.share.folders) names.add(lastPart(f.path));
      for (const w of this.deps.places()) if (shares(row.share, w.node, w.path, this.deps.platformOf)) names.add(w.name);
    } else {
      for (const w of this.deps.places()) {
        if (!shares(row.share, w.node, w.path, this.deps.platformOf)) continue;
        if (within(row.share.closed ?? [], w.node, w.path, this.deps.platformOf)) continue;
        names.add(w.name);
      }
    }
    return { open: row.share.open, workspaces: [...names].filter(Boolean).slice(0, 500) };
  }

  /** The agents this side lets `row`'s side reach now. */
  private directoryFor(row: TeammateRow): TeamAgent[] {
    const names = this.deps.names();
    const out: TeamAgent[] = [];
    for (const s of this.deps.sessions()) {
      if (!this.openWith(row, s)) continue;
      const alias = names.get(s.id)?.alias;
      if (!alias) continue;
      const p = this.placeOf(s);
      const focus = this.deps.focus.get(s.id);
      out.push({
        session: s.id,
        name: alias,
        harness: s.harness,
        ...(p.workspace ? { workspace: p.workspace } : { workspace: lastPart(p.path) }),
        status: s.status,
        ...(s.intent ? { intent: cap(s.intent, 300) } : {}),
        ...(focus ? { focus } : {}),
      });
    }
    return out;
  }

  // --- making one -------------------------------------------------------------------------------------

  /** A code for another Cophyla user to become this user's teammate, sharing `share`: good for a day or one use. */
  async invite(share: TeammateShare): Promise<{ teammate: Teammate; code: string; expiresAt: number }> {
    this.routing();
    this.reachable();
    const now = this.now();
    const id = newId("teammate");
    const peer = newId("connection");
    const secret = randomBytes(32).toString("hex");
    const expiresAt = now + INVITE_MS;
    const { url, token } = await this.deps.cloud.relayGrant(peer, { kind: "connection", name: "teammate invite", expiresAt });
    const tidy = tidyShare(share);
    const row: TeammateRow = {
      id,
      state: "pending",
      createdAt: now,
      expiresAt,
      share: tidy,
      ...(tidy.mode === "exclude" ? { known: this.placeKeys() } : {}),
      invite: { secretHash: sha256hex(secret), peer },
      sent: 0,
      received: 0,
      outbox: [],
    };
    this.rows.put(row);
    this.emit(row);
    this.log.info("teammate invite made", { id, mode: tidy.mode, open: tidy.open, folders: tidy.folders.length });
    return { teammate: clientTeammate(row), code: teammateInviteText({ v: 1, id, secret, expiresAt, relay: { url, peer, token } }), expiresAt };
  }

  /** Uses another user's code, sharing `share` with them; kept once their side has it too. */
  async accept(code: string, share: TeammateShare): Promise<Teammate> {
    this.routing();
    this.reachable();
    let body;
    try {
      body = parseTeammateInvite(code);
    } catch (e) {
      throw new RpcError("invalid", e instanceof InviteError ? e.message : "not a Cophyla teammate code");
    }
    const now = this.now();
    if (body.expiresAt <= now) throw new RpcError("invalid", "the code has run out: ask for a new one");
    if (this.rows.get(body.id)) throw new RpcError("conflict", "that code was made here, or was used here already");
    if (originOf(body.relay.url) !== originOf(this.deps.cloud.serverUrl())) throw new RpcError("invalid", "the code is for another Cophyla server");
    const tidy = tidyShare(share);
    const secretHash = sha256hex(body.secret);
    const inbound = newId("connection");
    const mine = await this.deps.cloud.relayGrant(inbound, { kind: "connection", name: "teammate" });
    let sock: LinkSocket | undefined;
    let kept = false;
    const draft: TeammateRow = { id: body.id, state: "active", createdAt: now, share: tidy, ...(tidy.mode === "exclude" ? { known: this.placeKeys() } : {}), sent: 0, received: 0, outbox: [] };
    try {
      const identity = await this.deps.cloud.attest(teamAudience(secretHash, "redeemer"));
      try {
        sock = await this.dial(body.relay, await pskFromSecret(body.secret));
      } catch (e) {
        if (e instanceof RpcError && e.code === "denied") throw new RpcError("denied", "the code was used already, or cancelled");
        throw new RpcError("unavailable", `the Cophyla that made the code cannot be reached now (${message(e)})`);
      }
      const rpc = clientOver(sock, this.log, `teammate invite ${body.id}`);
      const answer = teammateLinkRequests["team.redeem"].result.parse(
        await rpc.request("team.redeem", { id: body.id, identity, theirs: this.summary(draft), relay: { url: mine.url, peer: inbound, token: mine.token } }, { timeoutMs: REQUEST_MS }),
      );
      const who = this.deps.cloud.verifyIdentity(answer.identity, teamAudience(secretHash, "inviter"));
      if (who.subject === this.deps.cloud.subject()) throw new RpcError("denied", "that code was made on this same account: your own agents reach each other already");
      if (this.rows.bySubject(who.subject)) throw new RpcError("conflict", `${who.login} is your teammate already`);
      if (originOf(answer.relay.url) !== originOf(this.deps.cloud.serverUrl())) throw new RpcError("invalid", "the other side named another Cophyla server");
      await rpc.request("team.confirm", { id: body.id }, { timeoutMs: REQUEST_MS });
      const at = this.now();
      const row: TeammateRow = { ...draft, acceptedAt: at, key: answer.key, inbound, outbound: answer.relay, peer: { user: who.login, subject: who.subject }, theirs: answer.theirs, seenAt: at };
      this.rows.put(row);
      kept = true;
      this.emit(row);
      this.log.info("teammate made", { id: row.id, user: who.login });
      void this.audit("teammate.accept", row, `became ${who.login}'s teammate`);
      return clientTeammate(row);
    } finally {
      sock?.close(1000, "redeemed");
      if (!kept) void this.deps.cloud.revokeRelay(inbound);
    }
  }

  /** Changes what this side shares; the other side is told. Agents no longer open leave that teammate's groups. */
  update(id: string, share: TeammateShare): Teammate {
    this.routing();
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", `no teammate ${id}`);
    const before = row.state === "active" ? this.openSessions(row) : [];
    const tidy = tidyShare(share);
    // an exclude share keeps the places it knew, and knows the ones opened or excluded now
    if (tidy.mode === "exclude") {
      const known = new Set(row.known ?? this.placeKeys());
      const stillClosed = new Set((tidy.closed ?? []).map((c) => placeKey(c.node, c.path, this.deps.platformOf)));
      for (const c of row.share.closed ?? []) {
        const k = placeKey(c.node, c.path, this.deps.platformOf);
        if (!stillClosed.has(k)) known.add(k);
      }
      row.known = [...known];
    } else delete row.known;
    row.share = tidy;
    this.rows.put(row);
    this.dirs.delete(id);
    this.emit(row);
    if (row.state === "active") {
      const after = new Set(this.openSessions(row));
      for (const s of before) if (!after.has(s)) this.deps.groups()?.closedTo(row.peer!.subject, s);
      void this.request(row, "team.share", this.summary(row)).catch(() => undefined);
    }
    this.log.info("teammate share changed", { id, mode: tidy.mode, open: tidy.open });
    return clientTeammate(row);
  }

  private openSessions(row: TeammateRow): string[] {
    return this.deps
      .sessions()
      .filter((s) => this.openWith(row, s))
      .map((s) => s.id);
  }

  /** Opens one agent to a teammate by hand, or closes it again. */
  open(id: string, session: string, on: boolean): Teammate {
    this.routing();
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", `no teammate ${id}`);
    const s = this.deps.sessions().find((x) => x.id === session);
    if (!s || s.status === "ended") throw new RpcError("not_found", `no live session ${session}`);
    if (on && !this.sharedWith(row, s)) throw new RpcError("invalid", `that agent works in a folder you do not share with ${row.peer?.user ?? "them"}: share it first`);
    const opened = new Set(row.share.opened ?? []);
    if (!on && row.share.open === "always" && !within(row.share.closed ?? [], s.node, this.placeOf(s).path, this.deps.platformOf) && !opened.has(session)) {
      throw new RpcError("invalid", "every agent in what you share is open to them: narrow the share to close one");
    }
    if (on) opened.add(session);
    else opened.delete(session);
    return this.update(id, { ...row.share, opened: [...opened] });
  }

  /** Cancels a code that waits, or ends a teammate at both sides. */
  async end(id: string, reason: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", `no teammate ${id}`);
    if (row.state === "pending") {
      this.rows.delete(id);
      this.redeeming.delete(id);
      if (row.invite) void this.deps.cloud.revokeRelay(row.invite.peer);
      this.emitEnded(row, reason);
      this.log.info("teammate invite cancelled", { id, reason });
      return;
    }
    try {
      await this.request(row, "team.end", { reason }, 5_000);
    } catch (e) {
      this.log.info("the far side was not told of the end", { id, error: message(e) });
    }
    this.drop(row, reason);
  }

  private drop(row: TeammateRow, reason: string): void {
    if (!this.rows.delete(row.id)) return;
    this.closeOut(row.id, "ended");
    if (row.inbound) void this.deps.cloud.revokeRelay(row.inbound);
    for (const k of [this.seen, this.days, this.dirs, this.minutes]) k.delete(row.id);
    if (row.peer) this.deps.groups()?.teammateEnded(row.peer.subject);
    this.emitEnded(row, reason);
    this.log.info("teammate ended", { id: row.id, reason, user: row.peer?.user });
  }

  // --- the far side's tunnels --------------------------------------------------------------------------

  /** A tunnel the other user's Cophyla opens: a live teammate's, keyed from its key, or a pending invite's, keyed from its secret. */
  acceptTunnel(peer: string): ConnectionTunnel | undefined {
    if (!this.deps.routes()) return undefined;
    const active = this.rows.byInbound(peer);
    if (active?.key) {
      const id = active.id;
      return { psk: pskFromHex(active.key), accept: (sock) => serveOver(sock, this.log, `teammate ${id}`, (m, p) => this.serveLink(id, m, p), () => undefined) };
    }
    const pending = this.rows.byInvitePeer(peer);
    if (pending?.invite && (pending.expiresAt ?? 0) > this.now()) {
      const id = pending.id;
      const tunnel: RedeemTunnel = {};
      return {
        psk: pskFromHex(pending.invite.secretHash),
        accept: (sock) => serveOver(sock, this.log, `teammate invite ${id}`, (m, p) => this.serveRedeem(id, tunnel, m, p), () => this.redeemClosed(id, tunnel)),
      };
    }
    return undefined;
  }

  private async serveRedeem(id: string, tunnel: RedeemTunnel, method: string, params: unknown): Promise<unknown> {
    if (method === "team.redeem") {
      const p = teammateLinkRequests["team.redeem"].params.safeParse(params);
      if (!p.success) throw new RpcError("invalid", "bad team.redeem");
      const row = this.rows.get(id);
      if (!row || row.state !== "pending" || !row.invite || p.data.id !== id) throw new RpcError("denied", "that code is no longer open");
      if ((row.expiresAt ?? 0) <= this.now()) throw new RpcError("denied", "the code has run out");
      if (this.redeeming.has(id)) throw new RpcError("conflict", "the code is being used");
      const who = this.deps.cloud.verifyIdentity(p.data.identity, teamAudience(row.invite.secretHash, "redeemer"));
      if (who.subject === this.deps.cloud.subject()) throw new RpcError("denied", "that is this same account");
      if (this.rows.bySubject(who.subject)) throw new RpcError("conflict", "you are this user's teammate already");
      if (originOf(p.data.relay.url) !== originOf(this.deps.cloud.serverUrl())) throw new RpcError("invalid", "the code's server is not the one named");
      const hold: Redeeming = { tunnel, inbound: newId("connection"), key: randomBytes(32).toString("hex"), outbound: p.data.relay, peer: { user: who.login, subject: who.subject }, theirs: p.data.theirs, at: this.now() };
      this.redeeming.set(id, hold);
      try {
        const mine = await this.deps.cloud.relayGrant(hold.inbound, { kind: "connection", name: "teammate" });
        const identity = await this.deps.cloud.attest(teamAudience(row.invite.secretHash, "inviter"));
        return { identity, theirs: this.summary(row), relay: { url: mine.url, peer: hold.inbound, token: mine.token }, key: hold.key };
      } catch (e) {
        if (this.redeeming.get(id) === hold) this.redeeming.delete(id);
        void this.deps.cloud.revokeRelay(hold.inbound);
        throw e;
      }
    }
    if (method === "team.confirm") {
      const hold = this.redeeming.get(id);
      const row = this.rows.get(id);
      if (!hold || hold.tunnel !== tunnel || !row || row.state !== "pending" || !row.invite) throw new RpcError("denied", "nothing to confirm on this tunnel");
      this.redeeming.delete(id);
      const invitePeer = row.invite.peer;
      const { invite: _invite, expiresAt: _expires, ...rest } = row;
      const active: TeammateRow = { ...rest, state: "active", acceptedAt: this.now(), key: hold.key, inbound: hold.inbound, outbound: hold.outbound, peer: hold.peer, theirs: hold.theirs, seenAt: this.now() };
      this.rows.put(active);
      tunnel.spent = invitePeer;
      tunnel.timer = setTimeout(() => this.spend(tunnel), 30_000);
      if (typeof tunnel.timer === "object" && "unref" in tunnel.timer) tunnel.timer.unref();
      this.emit(active);
      this.log.info("teammate made", { id, user: hold.peer.user });
      void this.audit("teammate.accept", active, `${hold.peer.user} used the invite`);
      return {};
    }
    throw new RpcError("unsupported", `unsupported: ${method}`);
  }

  private spend(tunnel: RedeemTunnel): void {
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.timer = undefined;
    const peer = tunnel.spent;
    tunnel.spent = undefined;
    if (peer) void this.deps.cloud.revokeRelay(peer);
  }

  private redeemClosed(id: string, tunnel: RedeemTunnel): void {
    if (tunnel.spent) {
      this.spend(tunnel);
      return;
    }
    const hold = this.redeeming.get(id);
    if (!hold || hold.tunnel !== tunnel) return;
    this.redeeming.delete(id);
    void this.deps.cloud.revokeRelay(hold.inbound);
    this.log.info("teammate invite open again: its redemption stopped short", { id });
  }

  /** A live teammate's tunnel: the `team.*` requests, about this teammate alone. */
  private async serveLink(id: string, method: string, params: unknown): Promise<unknown> {
    const row = this.rows.get(id);
    if (!row || row.state !== "active" || !row.peer) throw new RpcError("denied", "no such teammate");
    const name = method as keyof typeof teammateLinkRequests;
    const def = teammateLinkRequests[name];
    if (!def || name === "team.redeem" || name === "team.confirm") throw new RpcError("unsupported", `unsupported: ${method}`);
    const parsed = def.params.safeParse(params);
    if (!parsed.success) throw new RpcError("invalid", `bad ${method}`);
    row.seenAt = this.now();
    this.rows.put(row);
    switch (name) {
      case "team.directory":
        return { agents: this.directoryFor(this.refreshClosed(row)), theirs: this.summary(row) };
      case "team.share": {
        this.update2(id, (r) => (r.theirs = parsed.data as TeammateTheirs));
        this.dirs.delete(id);
        void this.flushOutbox(id);
        return {};
      }
      case "team.send":
        return this.receive(row, parsed.data as { id: string; to: string; text: string; replyTo?: string; from: { name: string; harness?: Session["harness"] }; sentAt: number });
      case "team.notice": {
        const n = parsed.data as { about: string; why: string };
        const by = this.sentBy.get(n.about);
        await this.notify(by?.session, `Your message ${n.about} to ${row.peer.user} was not delivered: ${n.why}.`, n.about);
        return {};
      }
      case "team.end": {
        const why = (parsed.data as { reason: string }).reason;
        this.drop(row, `${row.peer.user} ended it (${why})`);
        return {};
      }
      case "team.group": {
        const g = parsed.data as { group: string; seq: number; entry: GroupEntry; at: number };
        const groups = this.deps.groups();
        if (!groups) throw new RpcError("unavailable", "group chats are off here");
        await groups.take(row.peer.subject, g.group, g.seq, g.entry, g.at);
        return {};
      }
      case "team.group.sync": {
        const s = parsed.data as { group: string; after: number };
        const groups = this.deps.groups();
        if (!groups) throw new RpcError("unavailable", "group chats are off here");
        return groups.entriesFor(row.peer.subject, s.group, s.after);
      }
      default:
        throw new RpcError("unsupported", `unsupported: ${method}`);
    }
  }

  private update2(id: string, change: (row: TeammateRow) => void): TeammateRow | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    change(row);
    this.rows.put(row);
    this.emit(row);
    return row;
  }

  // --- the directory, and messages ----------------------------------------------------------------------

  /** A teammate's agents open to this side now, asked of their side and kept half a minute. */
  async agents(teammate: string, fresh = false): Promise<TeamAgent[]> {
    const row = this.rows.get(teammate);
    if (!row || row.state !== "active") throw new RpcError("not_found", `no teammate ${teammate}`);
    const kept = this.dirs.get(teammate);
    if (kept && !fresh && this.now() - kept.at < DIRECTORY_MS) return kept.agents;
    const r = teammateLinkRequests["team.directory"].result.parse(await this.request(row, "team.directory", {}));
    this.dirs.set(teammate, { at: this.now(), agents: r.agents, theirs: r.theirs });
    if (JSON.stringify(row.theirs) !== JSON.stringify(r.theirs)) this.update2(teammate, (x) => (x.theirs = r.theirs));
    return r.agents;
  }

  /** The teammates' agents open to `caller`, for `list_agents`: none for an agent outside what is shared with each. */
  async listing(caller: Session): Promise<TeammateListing[]> {
    if (!this.deps.routes()) return [];
    const out: TeammateListing[] = [];
    for (const row of this.rows.list()) {
      if (row.state !== "active" || !row.peer || !this.sharedWith(row, caller)) continue;
      let agents: TeamAgent[];
      try {
        agents = await this.agents(row.id);
      } catch (e) {
        this.log.info("a teammate's agents could not be listed", { id: row.id, error: message(e) });
        continue;
      }
      for (const a of agents) {
        out.push({
          teammate: row.id,
          alias: `${row.peer.user}/${a.name}`,
          user: row.peer.user,
          name: a.name,
          ...(a.harness ? { harness: a.harness } : {}),
          ...(a.workspace ? { workspace: a.workspace } : {}),
          ...(a.status ? { status: a.status } : {}),
          ...(a.intent ? { intent: a.intent } : {}),
          ...(a.focus ? { focus: a.focus } : {}),
        });
      }
    }
    return out;
  }

  /** Whether `to` names a teammate's agent: `<login>/<name>` with a teammate's login, or `tm_…/<name>`. */
  names(to: string): boolean {
    const want = to.trim();
    const slash = want.indexOf("/");
    if (slash <= 0) return false;
    const who = want.slice(0, slash);
    if (/^tm_/i.test(who)) return this.rows.get(who) !== undefined;
    return this.rows.byLogin(who) !== undefined;
  }

  private resolve(to: string): { row: TeammateRow; name: string } {
    const want = to.trim();
    const slash = want.indexOf("/");
    const who = want.slice(0, slash);
    const name = want.slice(slash + 1);
    const row = /^tm_/i.test(who) ? this.rows.get(who) : this.rows.byLogin(who);
    if (!row || row.state !== "active" || !row.peer) throw new RpcError("not_found", `no teammate called ${who}`);
    if (!name) throw new RpcError("invalid", "name the agent after the login: login/name");
    return { row, name };
  }

  private day(id: string): { day: string; in: number; out: number } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    let d = this.days.get(id);
    if (!d || d.day !== today) this.days.set(id, (d = { day: today, in: 0, out: 0 }));
    return d;
  }

  /** Every agent's messages on a teammate this minute, one way. */
  private minute(key: string): number {
    const now = this.now();
    const list = (this.minutes.get(key) ?? []).filter((t) => now - t < 60_000);
    this.minutes.set(key, list);
    return list.length;
  }

  private count(key: string): void {
    const list = this.minutes.get(key) ?? [];
    list.push(this.now());
    this.minutes.set(key, list);
  }

  /** A message from an agent of this side to a teammate's agent. */
  async send(caller: Session, _mode: AgentMode, p: { to: string; text: string; replyTo?: string }): Promise<{ status: "sent" | "held" | "queued" | "focus"; id: string; teammate: string; alias: string; focus?: Focus }> {
    this.routing();
    const { row, name } = this.resolve(p.to);
    const alias = `${row.peer!.user}/${name}`;
    if (!this.sharedWith(row, caller)) throw new RpcError("denied", `you work in a folder your user does not share with ${row.peer!.user}, so you reach none of their agents`);
    const kept = this.dirs.get(row.id);
    if (kept && this.now() - kept.at < DIRECTORY_MS && !kept.agents.some((a) => a.name === name) && !p.replyTo) throw new RpcError("not_found", `${alias} is not open to you: list_agents shows who is`);
    const local = `L:${row.id}:${caller.id}`;
    const remote = `R:${row.id}:${name}`;
    const { hops } = this.limits.hops(local, p.replyTo);
    const day = this.day(row.id);
    const why =
      this.limits.check(local, remote, alias, p.text, hops) ??
      (this.minute(`out:${row.id}`) >= PER_MINUTE ? `your agents sent ${row.peer!.user} ${PER_MINUTE} messages in the last minute, the most a teammate takes` : undefined) ??
      (day.out >= PER_DAY ? `your agents sent ${row.peer!.user} ${PER_DAY} messages today, the most in a day` : undefined);
    if (why) throw new RpcError("denied", why);
    const id = newId("agentMessage");
    this.limits.record(id, local, remote, p.text, hops);
    this.count(`out:${row.id}`);
    day.out++;
    this.sentBy.set(id, { session: caller.id, teammate: row.id, at: this.now() });
    while (this.sentBy.size > 2000) this.sentBy.delete(this.sentBy.keys().next().value!);
    const fromName = this.deps.names().get(caller.id)?.alias ?? caller.id;
    const q: TeamQueued = { id, to: name, text: p.text, ...(p.replyTo ? { replyTo: p.replyTo } : {}), from: { name: fromName, harness: caller.harness }, at: this.now(), sender: caller.id };
    return this.deps.gate.run(
      { principal: { kind: "harness", session: caller.id }, action: "teammate.send", target: row.id, args: { to: alias, text: cap(p.text), ...(p.replyTo ? { replyTo: p.replyTo } : {}), id }, sessionKey: caller.id },
      async () => {
        const answer = { id, teammate: row.id, alias };
        if ((this.rows.get(row.id)?.outbox.length ?? 0) > 0) {
          this.queueOut(row.id, q);
          void this.flushOutbox(row.id);
          return { ...answer, status: "queued" as const };
        }
        try {
          const r = await this.sendNow(row, q);
          return { ...answer, status: r.status, ...(r.focus ? { focus: r.focus } : {}) };
        } catch (e) {
          if (farEnded(e)) {
            this.drop(row, `${row.peer!.user} ended it`);
            throw new RpcError("unavailable", `${row.peer!.user} is no longer your user's teammate; not sent`);
          }
          if (e instanceof RpcError && (e.code === "denied" || e.code === "invalid" || e.code === "not_found")) throw e;
          this.queueOut(row.id, q);
          this.scheduleRetry();
          return { ...answer, status: "queued" as const };
        }
      },
    );
  }

  private async sendNow(row: TeammateRow, q: TeamQueued): Promise<{ status: "sent" | "held" | "focus"; focus?: Focus }> {
    const r = teammateLinkRequests["team.send"].result.parse(
      await this.request(row, "team.send", { id: q.id, to: q.to, text: q.text, ...(q.replyTo ? { replyTo: q.replyTo } : {}), from: q.from, sentAt: q.at }),
    );
    this.update2(row.id, (x) => {
      x.sent++;
      x.lastAt = this.now();
      x.seenAt = this.now();
    });
    return r;
  }

  private queueOut(id: string, q: TeamQueued): void {
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", "the teammate ended");
    if (row.outbox.length >= QUEUE_MAX) throw new RpcError("unavailable", `${QUEUE_MAX} messages already wait for ${row.peer?.user ?? "their"} Cophyla to be reached; not sent`);
    this.update2(id, (r) => r.outbox.push(q));
  }

  private flushOutbox(id: string): Promise<void> {
    return this.once(`out:${id}`, () => this.drainOutbox(id));
  }

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
        if (e instanceof RpcError && (e.code === "denied" || e.code === "invalid" || e.code === "not_found")) {
          this.update2(id, (r) => (r.outbox = r.outbox.filter((m) => m.id !== q.id)));
          await this.notify(q.sender, `Your message ${q.id} to ${row.peer?.user ?? "them"}/${q.to} was not delivered: ${e.message}.`, q.id);
          continue;
        }
        this.scheduleRetry();
        return;
      }
      this.update2(id, (r) => (r.outbox = r.outbox.filter((m) => m.id !== q.id)));
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

  /** The server link came back: whatever waits for a far side goes now, and the groups catch up. */
  linkUp(): void {
    this.retryMs = 30_000;
    for (const r of this.rows.list()) if (r.state === "active" && r.outbox.length > 0) void this.flushOutbox(r.id);
    void this.deps.groups()?.sweep();
  }

  /**
   * A message from a teammate's agent: to an agent of this side open to them, or to the one that
   * sent the message it answers; checked against the limits, held for an agent in focus, and
   * delivered as another person's agent's, without asking.
   */
  private async receive(row: TeammateRow, p: { id: string; to: string; text: string; replyTo?: string; from: { name: string; harness?: Session["harness"] }; sentAt: number }): Promise<{ status: "sent" | "held" | "focus"; focus?: Focus }> {
    let seen = this.seen.get(row.id);
    if (!seen) this.seen.set(row.id, (seen = new Set()));
    if (seen.has(p.id)) return { status: "sent" };
    const target = this.target(row, p.to, p.replyTo);
    if (!target) throw new RpcError("not_found", `no agent called ${p.to} is open to you`);
    const remote = `R:${row.id}:${p.from.name}`;
    const local = `L:${row.id}:${target.id}`;
    const { hops } = this.limits.hops(remote, p.replyTo);
    const day = this.day(row.id);
    const why =
      this.limits.check(remote, local, p.to, p.text, hops) ??
      (this.minute(`in:${row.id}`) >= PER_MINUTE ? `your agents sent ${PER_MINUTE} messages in the last minute, the most a teammate takes` : undefined) ??
      (day.in >= PER_DAY ? `your agents sent ${PER_DAY} messages today, the most a teammate takes in a day` : undefined);
    if (why) throw new RpcError("denied", why);
    seen.add(p.id);
    if (seen.size > SEEN) seen.delete(seen.values().next().value!);
    this.limits.record(p.id, remote, local, p.text, hops);
    this.count(`in:${row.id}`);
    day.in++;
    const info: EnvelopeInfo = { peer: { teammate: row.id, user: row.peer!.user, name: p.from.name, ...(p.from.harness ? { harness: p.from.harness } : {}) }, messageId: p.id, ...(p.replyTo ? { replyTo: p.replyTo } : {}) };
    const status = await this.deps.gate.run(
      { principal: { kind: "system" }, action: "teammate.deliver", target: target.id, args: { teammate: row.id, from: `${row.peer!.user}/${p.from.name}`, text: cap(p.text), id: p.id } },
      async () => {
        if (this.deps.focus.hold(target, p.text, info, `${row.peer!.user}/${p.from.name}`)) return { status: "focus" as const, focus: this.deps.focus.get(target.id)! };
        const r = await this.deps.deliver(target, p.text, info);
        return { status: r.status === "held" ? ("held" as const) : ("sent" as const) };
      },
    );
    this.update2(row.id, (x) => {
      x.received++;
      x.lastAt = this.now();
    });
    this.log.info("a teammate's message came in", { id: row.id, message: p.id, from: p.from.name, status: status.status });
    return status;
  }

  /** The agent of this side a teammate's message is for: an open one by its name, or the one that sent what it answers. */
  private target(row: TeammateRow, to: string, replyTo: string | undefined): Session | undefined {
    const names = this.deps.names();
    const key = to.trim().toLowerCase();
    const live = this.deps.sessions().filter((s) => s.status !== "ended" && s.role !== "assistant");
    const byName = live.filter((s) => {
      const n = names.get(s.id);
      return n !== undefined && (n.alias.toLowerCase() === key || n.forms.includes(key) || s.id.toLowerCase() === key);
    });
    const open = byName.find((s) => this.openWith(row, s));
    if (open) return open;
    if (replyTo) {
      const sent = this.sentBy.get(replyTo);
      if (sent && sent.teammate === row.id && this.now() - sent.at < ANSWER_MS) return live.find((s) => s.id === sent.session);
    }
    return undefined;
  }

  // --- the group chats' way to the other sides ----------------------------------------------------------

  teammateOf(owner: string): { id: string; user: string } | undefined {
    const row = this.rows.bySubject(owner);
    return row?.peer ? { id: row.id, user: row.peer.user } : undefined;
  }

  teammate(id: string): { owner: string; user: string } | undefined {
    const row = this.rows.get(id);
    return row?.state === "active" && row.peer ? { owner: row.peer.subject, user: row.peer.user } : undefined;
  }

  openTo(session: string, owner: string): boolean {
    const row = this.rows.bySubject(owner);
    const s = this.deps.sessions().find((x) => x.id === session);
    return row !== undefined && s !== undefined && this.openWith(row, s);
  }

  /** What the group chats reach the other sides through. */
  forGroups(): GroupTeams {
    return {
      teammateOf: (owner) => this.teammateOf(owner),
      teammate: (id) => this.teammate(id),
      agents: (id, fresh) => this.agents(id, fresh),
      openTo: (session, owner) => this.openTo(session, owner),
      send: (teammate, group, seq, entry, at) => this.sendEntry(teammate, group, seq, entry, at),
      sync: (teammate, group, after) => this.sync(teammate, group, after),
    };
  }

  async sendEntry(teammate: string, group: string, seq: number, entry: GroupEntry, at: number): Promise<boolean> {
    const row = this.rows.get(teammate);
    if (!row || row.state !== "active") return false;
    try {
      await this.request(row, "team.group", { group, seq, entry, at });
      return true;
    } catch (e) {
      this.log.info("a group entry waits for the teammate's side", { teammate, group, seq, error: message(e) });
      return false;
    }
  }

  async sync(teammate: string, group: string, after: number): Promise<{ entries: { seq: number; entry: GroupEntry; at: number }[]; more: boolean } | undefined> {
    const row = this.rows.get(teammate);
    if (!row || row.state !== "active") return undefined;
    try {
      const r = teammateLinkRequests["team.group.sync"].result.parse(await this.request(row, "team.group.sync", { group, after }));
      return { entries: r.entries, more: r.more === true };
    } catch (e) {
      this.log.info("a group could not catch up from the teammate now", { teammate, group, error: message(e) });
      return undefined;
    }
  }

  // --- tunnels this side opens ----------------------------------------------------------------------------

  private async request(row: TeammateRow, method: string, params: unknown, timeoutMs = REQUEST_MS): Promise<unknown> {
    const rpc = await this.rpcFor(row);
    const entry = this.out.get(row.id);
    if (entry) this.idle(row.id, entry);
    return rpc.request(method, params, { timeoutMs });
  }

  private async rpcFor(row: TeammateRow): Promise<RpcPeer> {
    const live = this.out.get(row.id);
    if (live?.rpc.open) return live.rpc;
    const opening = this.opening.get(row.id);
    if (opening) return opening;
    if (!row.outbound || !row.key) throw new RpcError("unavailable", "the teammate is not live");
    const outbound = row.outbound;
    const key = row.key;
    const p = (async () => {
      const sock = await this.dial(outbound, pskFromHex(key));
      const rpc = clientOver(sock, this.log, `teammate ${row.id}`);
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

  /** A notice of cophyla's own into the session that sent a message. */
  private async notify(session: string | undefined, text: string, replyTo: string): Promise<void> {
    const s = session ? this.deps.sessions().find((x) => x.id === session && x.status !== "ended") : undefined;
    if (!s || !this.deps.linked(s.node)) return;
    try {
      await this.deps.deliver(s, text, { messageId: newId("agentMessage"), replyTo });
    } catch (e) {
      this.log.warn("a teammate's notice could not be delivered", { session, error: message(e) });
    }
  }

  /** Invites run out; what waited past its day goes back as not delivered; what waits is tried again. */
  async sweep(): Promise<void> {
    if (!this.deps.routes()) return;
    const now = this.now();
    for (const [id, hold] of [...this.redeeming]) if (now - hold.at > REDEEM_MS) this.redeeming.delete(id);
    for (const row of this.rows.list()) {
      if (row.state === "pending") {
        if ((row.expiresAt ?? 0) <= now && !this.redeeming.has(row.id)) await this.end(row.id, "its code ran out").catch(() => undefined);
        continue;
      }
      this.refreshClosed(row);
      const stale = row.outbox.filter((m) => now - m.at > QUEUE_MS);
      if (stale.length > 0) {
        this.update2(row.id, (r) => (r.outbox = r.outbox.filter((m) => now - m.at <= QUEUE_MS)));
        for (const m of stale) await this.notify(m.sender, `Your message ${m.id} to ${row.peer?.user ?? "them"}/${m.to} was not delivered: their Cophyla could not be reached for a day.`, m.id);
      }
      if (row.outbox.length > 0) void this.flushOutbox(row.id);
    }
  }

  private async audit(action: "teammate.accept" | "teammate.invite" | "teammate.end", row: TeammateRow, what: string): Promise<void> {
    try {
      await this.deps.gate.run({ principal: { kind: "system" }, action, target: row.id, args: { what, ...(row.peer ? { user: row.peer.user } : {}) } }, () => undefined);
    } catch {
      // a rule of the user's that denies it is told in the row itself
    }
  }

}

function lastPart(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p !== "" && !p.endsWith(":"));
  return parts[parts.length - 1] ?? path;
}

