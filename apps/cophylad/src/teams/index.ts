// `teams` (milestone 35): people who work together, each a teammate of every other, with a chat
// everyone in the team is in. The owner or an admin adds a person with an invite only that
// person's GitHub account can take, once; the person looks at it and chooses what of theirs the
// team reaches before they join. From then on every member's Cophyla links to every other's on
// its own, through the teammate links (`teammates/`), with no code between any two of them.
//
// The member list is a chain of signed changes (`teamlog.ts` in the protocol). The server keeps
// it and tells the members when it moves (`teams.changed`), but this side checks every change
// itself, from the team's making, and acts only on the chain it checked: a link is made with
// each person the chain names, keyed from both people's keys as the chain names them, and a
// person the chain says left or was taken out loses their link and leaves the team's groups.
// Each side asks the other members' sides where the chain stands (`team.head`), so a server
// that showed two members different chains is caught.
//
// A link a team makes needs each side's relay peer told to the other: each side leaves the
// other a note on the server, sealed with the key the two share (`teams.note`), and dials what
// the other's note names. A teammate pair made with a code before teams becomes a team of two
// over the link it has (`team.offer` with `carry`), keeping what each side shares.
//
// What this side shares with a team is its own (`share`), as a teammate's share is: folders,
// or every workspace but some, and every agent there or only the ones opened by hand. Someone in
// two teams with this user reaches what is shared with either.

import { createHash, randomBytes } from "node:crypto";
import {
  applyTeamEntry,
  inviteOpen,
  makeTeamKeys,
  newId,
  openTeamNote,
  parseTeamInvite,
  RpcError,
  sealTeamNote,
  signTeamEntry,
  TEAM_INVITE_MS,
  TeamEntry,
  teamEntryHash,
  teamInviteCheck,
  teamInviteText,
  teamJoinAudience,
  teamKeysHash,
  TeamLogError,
  TeamNote,
  teamPairKey,
} from "@cophyla/protocol";
import type { ConnectionRelay, Session, Team, TeamChange, TeamInviteCode, TeamKeyPair, TeammateShare, TeamMemberRole, TeamOffer, TeamState } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Groups } from "../groups/index.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { placeKey, shares, tidyShare, within } from "../teammates/share.ts";
import type { PathPlatform } from "../teammates/share.ts";
import type { Teammates } from "../teammates/index.ts";
import { TeamStore } from "./store.ts";
import type { OfferRow, TeamKeysRow, TeamRow } from "./store.ts";

const SWEEP_MS = 60_000;
/** How often a member's side is asked where a team's chain stands. */
const HEAD_MS = 10 * 60_000;
/** How long a teammate pair that could not be moved into a team waits before it is tried again: their Cophyla may be older. */
const PAIR_RETRY_MS = 6 * 60 * 60_000;
/** How often the teams are taken from the server again, whatever it said between. */
const SYNC_MS = 10 * 60_000;
/** How soon a note that came early is read again. */
const NOTES_AGAIN_MS = 2_000;
/** How often an append is tried again when the chain moved under it. */
const APPEND_TRIES = 4;

/** What the teams need of the account and the server. */
export interface TeamsCloud {
  allowed(): RpcError | undefined;
  subject(): string | undefined;
  serverUrl(): string;
  linked(): boolean;
  request(method: "teams.append" | "teams.log" | "teams.mine" | "teams.note" | "teams.notes" | "teams.notes.ack", params: unknown): Promise<unknown>;
  attest(aud: string): Promise<string>;
  /** The server's word on an account, bound to `aud`, whenever it was made. */
  verifyBinding(token: string, aud: string): { subject: string; login: string };
}

export interface TeamsDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  /** Whether this node keeps the teams: the primary, or a node in no cluster. */
  routes: () => boolean;
  cloud: TeamsCloud;
  /** This side's user: their account and login. */
  me: () => { owner: string; user: string };
  teammates: () => Teammates;
  groups: () => Groups | undefined;
  /** Every session this node knows, its own and its linked nodes'. */
  sessions: () => Session[];
  place: (s: Session) => { workspace?: string; path: string };
  places: () => { node: string; path: string; name: string }[];
  platformOf: (node: string) => PathPlatform;
  now?: () => number;
  sweepMs?: number;
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

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const cleanLogin = (s: string) => s.trim().replace(/^@/, "");

export class Teams {
  private deps: TeamsDeps;
  private log: Logger;
  private rows: TeamStore;
  private now: () => number;
  /** Each team's state as its chain says, folded once and kept current. */
  private states = new Map<string, TeamState>();
  private timer?: ReturnType<typeof setInterval>;
  private syncing?: Promise<void>;
  private reconciling = new Map<string, Promise<void>>();
  /** When the teams last caught up with the server: never, while this node was not the primary. */
  private syncedAt = 0;
  private notesAgain?: ReturnType<typeof setTimeout>;
  private again = new Set<string>();

  constructor(deps: TeamsDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.rows = new TeamStore(deps.store);
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.deps.sweepMs ?? SWEEP_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.notesAgain) clearTimeout(this.notesAgain);
  }

  private routing(): void {
    if (!this.deps.routes()) throw new RpcError("unavailable", "teams are kept by the primary: ask there");
  }

  private reachable(): void {
    const why = this.deps.cloud.allowed();
    if (why) throw new RpcError("unavailable", `teams need this Cophyla signed in, with the relay on its plan (${why.message})`);
    if (!this.deps.cloud.linked()) throw new RpcError("unavailable", "the server cannot be reached now: try again once it is");
  }

  private subject(): string {
    const s = this.deps.cloud.subject();
    if (!s) throw new RpcError("unavailable", "teams need this Cophyla signed in");
    return s;
  }

  private login(): string {
    const u = this.deps.me().user;
    if (!u || u === "you") throw new RpcError("unavailable", "the server has not said this account's GitHub login yet: try again in a moment");
    return u;
  }

  /** This account's team keys, made the first time they are needed. */
  private async keys(): Promise<TeamKeyPair> {
    const subject = this.subject();
    const kept = this.rows.keys();
    if (kept && kept.subject === subject) return kept.kp;
    const row: TeamKeysRow = { subject, kp: await makeTeamKeys(), at: this.now() };
    this.rows.putKeys(row);
    this.log.info("team keys made for the account");
    return row.kp;
  }

  private identity = (token: string, aud: string) => this.deps.cloud.verifyBinding(token, aud);

  private async stateOf(row: TeamRow): Promise<TeamState | undefined> {
    const kept = this.states.get(row.id);
    if (kept && kept.seq === row.entries.length) return kept;
    let s: TeamState | undefined;
    for (const e of row.entries) {
      try {
        s = await applyTeamEntry(s, e, this.identity);
      } catch (err) {
        this.log.error("a team's chain kept here no longer checks", { team: row.id, error: message(err) });
        return undefined;
      }
    }
    if (s) this.states.set(row.id, s);
    return s;
  }

  /** The state of a team as kept, without folding: what the synchronous paths read. */
  private known(id: string): TeamState | undefined {
    return this.states.get(id);
  }

  /** Folds every team kept here once, at start: the synchronous paths read the states. */
  async load(): Promise<void> {
    for (const row of this.rows.list()) await this.stateOf(row);
  }

  // --- what the apps see ------------------------------------------------------------------------------

  list(): { teams: Team[]; offers: TeamOffer[] } {
    if (!this.deps.routes()) return { teams: [], offers: [] };
    const teams: Team[] = [];
    for (const row of this.rows.list()) {
      const t = this.client(row);
      if (t) teams.push(t);
    }
    return { teams, offers: this.rows.offers().map((o) => o.offer) };
  }

  private client(row: TeamRow): Team | undefined {
    const s = this.known(row.id);
    const me = this.deps.cloud.subject();
    if (!s || !me) return undefined;
    const mine = s.members.get(me);
    if (!mine) return undefined;
    const tm = this.deps.teammates();
    const members = [...s.members.values()].map((m) => {
      const link = m.subject === me ? undefined : tm.teamLink(m.subject);
      const theirs = link ? tm.list().find((x) => x.id === link.id)?.theirs : undefined;
      return {
        user: m.login,
        role: m.role,
        joinedAt: m.joinedAt,
        ...(m.invitedBy ? { invitedBy: s.members.get(m.invitedBy)?.login ?? s.gone.get(m.invitedBy)?.login ?? "someone" } : {}),
        ...(m.subject === me ? { you: true } : {}),
        ...(link ? { teammate: link.id, ...(link.linked ? { linked: true } : {}) } : {}),
        ...(theirs ? { theirs } : {}),
      };
    });
    const now = this.now();
    const invites = [...s.invites.values()]
      .filter((i) => inviteOpen(i, now))
      .map((i) => ({ id: i.id, user: i.login, by: s.members.get(i.by)?.login ?? s.gone.get(i.by)?.login ?? "someone", at: i.at, expiresAt: i.expiresAt }));
    return {
      id: s.id,
      name: s.name,
      ...(s.purpose ? { purpose: s.purpose } : {}),
      chat: s.chat,
      role: mine.role,
      members,
      invites,
      share: row.share,
      ...(s.ended ? { ended: { at: s.ended.at, by: s.members.get(s.ended.by)?.login ?? s.gone.get(s.ended.by)?.login ?? "the owner" } } : {}),
      ...(row.warning ? { warning: row.warning } : {}),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  private emit(row: TeamRow): void {
    const t = this.client(row);
    if (t) this.deps.bus.emit("teams.state", t);
  }

  private emitGone(id: string, name: string): void {
    const s = this.known(id);
    this.deps.bus.emit("teams.state", {
      id,
      name,
      chat: s?.chat ?? newId("group"),
      role: "member",
      members: [],
      invites: [],
      share: { mode: "include", folders: [], open: "chosen" },
      createdAt: s?.createdAt ?? 0,
      updatedAt: this.now(),
      gone: true,
    });
  }

  /**
   * The teams this side's user and an account are both in, each with what this side shares with
   * it: what the teammate links read. Undefined while there is none.
   */
  sharesWith(subject: string): { team: string; share: TeammateShare }[] | undefined {
    const me = this.deps.cloud.subject();
    if (!me || subject === me) return undefined;
    const out: { team: string; share: TeammateShare }[] = [];
    for (const row of this.rows.list()) {
      const s = this.known(row.id);
      if (!s || s.ended || !s.members.has(me) || !s.members.has(subject)) continue;
      out.push({ team: row.id, share: row.share });
    }
    return out.length > 0 ? out : undefined;
  }

  /** Whether this side's user is in a team, and whether a group is its chat: what a group handed over may say it belongs to. */
  teamOf(team: string, group: string): { chat: boolean } | undefined {
    const s = this.known(team);
    const me = this.deps.cloud.subject();
    if (!s || !me || !s.members.has(me)) return undefined;
    return { chat: s.chat === group };
  }

  // --- the chain ------------------------------------------------------------------------------------------

  /** A team's changes after the ones kept here, from the server, each checked; then what they mean is done. */
  private async pull(id: string, opts: { invite?: string } = {}): Promise<TeamState | undefined> {
    let row = this.rows.get(id);
    let state = row ? await this.stateOf(row) : undefined;
    const entries = row ? [...row.entries] : [];
    for (let round = 0; round < 50; round++) {
      const r = (await this.deps.cloud.request("teams.log", { team: id, after: entries.length, ...(opts.invite ? { invite: opts.invite } : {}) })) as { entries?: unknown[]; more?: boolean };
      const got = Array.isArray(r?.entries) ? r.entries : [];
      for (const raw of got) {
        try {
          state = await applyTeamEntry(state, raw, this.identity);
          entries.push(TeamEntry.parse(raw));
        } catch (err) {
          const why = err instanceof TeamLogError ? err.message : message(err);
          this.log.warn("a team's chain from the server does not check: kept as it was", { team: id, error: why });
          if (row) {
            row.warning = `the team's list from the server does not check (${why}): the last good one is kept`;
            this.rows.put(row);
            this.emit(row);
          }
          return state;
        }
      }
      if (!r?.more || got.length === 0) break;
    }
    if (row && entries.length > row.entries.length) {
      row = { ...row, entries };
      if (row.warning?.startsWith("the team's list from the server")) delete row.warning;
      this.rows.put(row);
      if (state) this.states.set(id, state);
    }
    return state;
  }

  /** Adds a change to a team's chain: signed here, taken by the server, kept, then done. The chain moved under it: taken again, and it is made again on top. */
  private async append(id: string, change: TeamChange, opts: { checkPriv?: string } = {}): Promise<TeamEntry> {
    this.reachable();
    const kp = await this.keys();
    const by = this.subject();
    for (let tries = 0; ; tries++) {
      const row = this.rows.get(id);
      if (!row) throw new RpcError("not_found", `no team ${id}`);
      const state = await this.stateOf(row);
      if (!state) throw new RpcError("unavailable", "the team's list kept here does not check");
      const unsigned = { team: id, seq: state.seq + 1, prev: state.head, by, at: this.now(), change };
      const entry = await signTeamEntry(unsigned, kp.signPriv, opts.checkPriv);
      // checked here first: a change this side may not make is said in its own words
      let next: TeamState;
      try {
        next = await applyTeamEntry(state, entry, this.identity);
      } catch (err) {
        throw new RpcError("denied", message(err));
      }
      try {
        await this.deps.cloud.request("teams.append", { entry });
      } catch (err) {
        if (err instanceof RpcError && err.code === "conflict" && tries < APPEND_TRIES) {
          await this.pull(id);
          continue;
        }
        throw err;
      }
      const fresh = this.rows.get(id) ?? row;
      fresh.entries = [...fresh.entries, entry];
      this.rows.put(fresh);
      this.states.set(id, next);
      return entry;
    }
  }

  // --- making and joining ---------------------------------------------------------------------------------

  /** A new team, with this side's user its owner and alone in it, and its chat. */
  async create(p: { name: string; purpose?: string; share: TeammateShare }): Promise<Team> {
    this.routing();
    this.reachable();
    const name = p.name.trim().slice(0, 80);
    if (!name) throw new RpcError("invalid", "a team needs a name");
    const kp = await this.keys();
    const me = this.subject();
    const login = this.login();
    const id = newId("team");
    const chat = newId("group");
    const purpose = p.purpose?.trim() ? p.purpose.trim().slice(0, 300) : undefined;
    const entry = await signTeamEntry(
      { team: id, seq: 1, prev: "", by: me, at: this.now(), change: { kind: "create", name, ...(purpose ? { purpose } : {}), chat, owner: { subject: me, login, keys: kp.keys } } },
      kp.signPriv,
    );
    await this.deps.cloud.request("teams.append", { entry });
    const share = tidyShare(p.share);
    const row: TeamRow = { id, entries: [entry], share, ...(share.mode === "exclude" ? { known: this.placeKeys() } : {}), joinedAt: this.now() };
    this.rows.put(row);
    await this.stateOf(row);
    await this.deps.groups()?.create({ name, ...(purpose ? { purpose } : {}), members: [], team: id, id: chat, teamChat: true });
    this.emit(row);
    this.log.info("team made", { team: id });
    return this.client(row)!;
  }

  /**
   * An invite for a GitHub account, by the owner or an admin: its code holds the secret the join
   * must pass, which the server never sees. A teammate of this user's is handed it too.
   */
  async invite(id: string, user: string): Promise<{ team: Team; invite: { id: string; code: string; expiresAt: number }; offered?: boolean }> {
    this.routing();
    const login = cleanLogin(user);
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new RpcError("invalid", "that is not a GitHub name");
    const row = this.rows.get(id);
    const state = row ? await this.stateOf(row) : undefined;
    if (!row || !state) throw new RpcError("not_found", `no team ${id}`);
    const me = this.subject();
    const role = state.members.get(me)?.role;
    if (role !== "owner" && role !== "admin") throw new RpcError("denied", "only the team's owner or an admin adds people");
    if ([...state.members.values()].some((m) => sameLogin(m.login, login))) throw new RpcError("conflict", `${login} is in ${state.name} already`);
    const invite = newId("teamInvite");
    const secret = randomBytes(32).toString("hex");
    const check = await teamInviteCheck(secret, id, invite);
    const expiresAt = this.now() + TEAM_INVITE_MS;
    const entry = await this.append(id, { kind: "invite", invite, login, check: check.pub, expiresAt });
    const code = teamInviteText({ v: 1, server: originOf(this.deps.cloud.serverUrl()), team: id, invite, secret, at: await teamEntryHash(entry), name: state.name, by: this.login() });
    let offered = false;
    const mate = this.deps.teammates().list().find((t) => t.state === "active" && t.user && sameLogin(t.user, login));
    if (mate) {
      try {
        await this.deps.teammates().offerTeam(mate.id, code);
        offered = true;
      } catch (e) {
        this.log.info("a teammate's side was not handed the invite", { team: id, error: message(e) });
      }
    }
    void this.reconcile(id);
    this.log.info("team invite made", { team: id, offered });
    return { team: this.client(this.rows.get(id)!)!, invite: { id: invite, code, expiresAt }, ...(offered ? { offered: true } : {}) };
  }

  async cancel(id: string, invite: string): Promise<Team> {
    this.routing();
    await this.append(id, { kind: "cancel", invite });
    const row = this.rows.get(id)!;
    this.emit(row);
    return this.client(row)!;
  }

  /** Fetches and checks the chain an invite leads to: what joining it means, kept as an offer. */
  async look(text: string, opts: { via?: "code" | "teammate"; carry?: boolean; from?: string } = {}): Promise<TeamOffer> {
    this.routing();
    this.reachable();
    let code: TeamInviteCode;
    try {
      code = parseTeamInvite(text);
    } catch (e) {
      throw new RpcError("invalid", message(e));
    }
    if (originOf(code.server) !== originOf(this.deps.cloud.serverUrl())) throw new RpcError("invalid", "the invite is for a team on another Cophyla server");
    const me = this.subject();
    const myLogin = this.login();
    const kept = this.known(code.team);
    if (kept?.members.has(me)) throw new RpcError("conflict", `you are in ${kept.name} already`);
    const { state } = await this.checkInvite(code);
    const inv = state.invites.get(code.invite)!;
    if (!sameLogin(inv.login, myLogin)) throw new RpcError("denied", `the invite is for ${inv.login}, and this Cophyla is signed in as ${myLogin}`);
    const offer: TeamOffer = {
      id: code.invite,
      team: code.team,
      name: state.name,
      ...(state.purpose ? { purpose: state.purpose } : {}),
      by: state.members.get(inv.by)?.login ?? state.gone.get(inv.by)?.login ?? code.by ?? "someone",
      people: [...state.members.values()].map((m) => ({ user: m.login, role: m.role })),
      via: opts.via ?? "code",
      at: this.now(),
      expiresAt: inv.expiresAt,
    };
    const row: OfferRow = { offer, code, ...(opts.carry ? { carry: true } : {}), ...(opts.from ? { from: opts.from } : {}) };
    this.rows.putOffer(row);
    this.deps.bus.emit("teams.offer", offer);
    return offer;
  }

  /** The chain an invite leads to, fetched and checked whole, and the invite in it: open, and the one the code was made with. */
  private async checkInvite(code: TeamInviteCode): Promise<{ state: TeamState; entries: TeamEntry[] }> {
    const entries: TeamEntry[] = [];
    let state: TeamState | undefined;
    for (let round = 0; round < 50; round++) {
      const r = (await this.deps.cloud.request("teams.log", { team: code.team, after: entries.length, invite: code.invite })) as { entries?: unknown[]; more?: boolean };
      const got = Array.isArray(r?.entries) ? r.entries : [];
      for (const raw of got) {
        try {
          state = await applyTeamEntry(state, raw, this.identity);
        } catch (err) {
          throw new RpcError("denied", `the team's list does not check (${message(err)}): not joined`);
        }
        entries.push(TeamEntry.parse(raw));
      }
      if (!r?.more || got.length === 0) break;
    }
    if (!state) throw new RpcError("not_found", "the team is not on the server");
    const made = entries.find((e) => e.change.kind === "invite" && e.change.invite === code.invite);
    if (!made || (await teamEntryHash(made)) !== code.at) throw new RpcError("denied", "the team's list does not match the invite: it was not made by whoever sent it, or the server changed it");
    if (!inviteOpen(state.invites.get(code.invite), this.now())) throw new RpcError("denied", "the invite was used, cancelled, or ran out: ask for a new one");
    if (state.ended) throw new RpcError("denied", "the team has ended");
    return { state, entries };
  }

  /** Joins the team an offer is for, sharing `share` with it. */
  async join(offerId: string, share: TeammateShare): Promise<Team> {
    this.routing();
    this.reachable();
    const o = this.rows.offer(offerId);
    if (!o) throw new RpcError("not_found", "no such invite waiting");
    const { state, entries } = await this.checkInvite(o.code);
    const kp = await this.keys();
    const me = this.subject();
    const login = this.login();
    const inv = state.invites.get(o.code.invite)!;
    if (!sameLogin(inv.login, login)) throw new RpcError("denied", `the invite is for ${inv.login}`);
    const identity = await this.deps.cloud.attest(teamJoinAudience(o.code.team, o.code.invite, await teamKeysHash(kp.keys)));
    const check = await teamInviteCheck(o.code.secret, o.code.team, o.code.invite);
    const tidy = tidyShare(share);
    // the chain as checked, then this side's join on top of it
    const row: TeamRow = { id: o.code.team, entries, share: tidy, ...(tidy.mode === "exclude" ? { known: this.placeKeys() } : {}), joinedAt: this.now() };
    this.rows.put(row);
    this.states.set(row.id, state);
    try {
      await this.append(row.id, { kind: "join", invite: o.code.invite, member: { subject: me, login, keys: kp.keys }, identity }, { checkPriv: check.priv });
    } catch (e) {
      this.rows.delete(row.id);
      this.states.delete(row.id);
      throw e;
    }
    this.rows.dropOffer(offerId);
    this.deps.bus.emit("teams.offer", { ...o.offer, gone: true });
    this.log.info("team joined", { team: row.id });
    await this.reconcile(row.id);
    // the members' notes may have come while the join was on its way
    await this.fetchNotes().catch(() => undefined);
    const done = this.rows.get(row.id)!;
    this.emit(done);
    return this.client(done)!;
  }

  decline(offerId: string): void {
    this.routing();
    const o = this.rows.offer(offerId);
    if (!o) return;
    this.rows.dropOffer(offerId);
    this.deps.bus.emit("teams.offer", { ...o.offer, gone: true });
  }

  /** An invite a teammate's side handed over: kept for the user, or, a teammate pair's own team, taken at once. */
  async offered(from: { id: string; user: string; subject: string }, code: string, carry: boolean): Promise<void> {
    const offer = await this.look(code, { via: "teammate", carry, from: from.id });
    if (!carry) return;
    // a pair's own team: made by the teammate, with no one else in it
    const state = (await this.checkInvite(parseTeamInvite(code))).state;
    if (state.owner !== from.subject || state.members.size !== 1) throw new RpcError("denied", "a teammate pair's team holds the two of you alone");
    const pairRow = this.deps.teammates().teamlessRows().find((r) => r.id === from.id);
    if (!pairRow) throw new RpcError("conflict", "you are in a team together already");
    await this.join(offer.id, pairRow.share);
    const row = this.rows.get(state.id);
    if (row) {
      row.pair = from.subject;
      if (pairRow.known && row.share.mode === "exclude") row.known = pairRow.known;
      this.rows.put(row);
    }
    this.placePairGroups(state.id, from.subject);
  }

  // --- changing -----------------------------------------------------------------------------------------

  private async must(id: string): Promise<{ row: TeamRow; state: TeamState }> {
    const row = this.rows.get(id);
    const state = row ? await this.stateOf(row) : undefined;
    if (!row || !state) throw new RpcError("not_found", `no team ${id}`);
    return { row, state };
  }

  private memberByLogin(state: TeamState, user: string): string {
    const login = cleanLogin(user);
    const m = [...state.members.values()].find((x) => sameLogin(x.login, login));
    if (!m) throw new RpcError("not_found", `${login} is not in ${state.name}`);
    return m.subject;
  }

  async update(id: string, p: { name?: string; purpose?: string }): Promise<Team> {
    this.routing();
    const name = p.name?.trim();
    await this.append(id, { kind: "update", ...(name ? { name: name.slice(0, 80) } : {}), ...(p.purpose !== undefined ? { purpose: p.purpose.trim().slice(0, 300) } : {}) });
    await this.reconcile(id);
    return this.client(this.rows.get(id)!)!;
  }

  async remove(id: string, user: string): Promise<Team> {
    this.routing();
    const { state } = await this.must(id);
    const subject = this.memberByLogin(state, user);
    await this.append(id, { kind: "remove", subject, why: `taken out by ${this.login()}` });
    await this.reconcile(id);
    return this.client(this.rows.get(id)!)!;
  }

  async role(id: string, user: string, role: TeamMemberRole): Promise<Team> {
    this.routing();
    const { state } = await this.must(id);
    const subject = this.memberByLogin(state, user);
    await this.append(id, role === "owner" ? { kind: "owner", subject } : { kind: "role", subject, role });
    await this.reconcile(id);
    return this.client(this.rows.get(id)!)!;
  }

  async leave(id: string): Promise<void> {
    this.routing();
    await this.append(id, { kind: "leave" });
    await this.reconcile(id);
  }

  async end(id: string): Promise<void> {
    this.routing();
    await this.append(id, { kind: "end" });
    await this.reconcile(id);
  }

  /** What this side shares with a team: its teammates' sides are told, and an agent no longer shared leaves what it was in there. */
  share(id: string, share: TeammateShare): Team {
    this.routing();
    const row = this.rows.get(id);
    if (!row || !this.known(id)) throw new RpcError("not_found", `no team ${id}`);
    const tidy = tidyShare(share);
    this.deps.teammates().shareChange(() => {
      if (tidy.mode === "exclude") {
        // an exclude share keeps the places it knew, and knows the ones opened or excluded now
        const known = new Set(row.known ?? this.placeKeys());
        const still = new Set((tidy.closed ?? []).map((c) => placeKey(c.node, c.path, this.deps.platformOf)));
        for (const c of row.share.closed ?? []) {
          const k = placeKey(c.node, c.path, this.deps.platformOf);
          if (!still.has(k)) known.add(k);
        }
        row.known = [...known];
      } else delete row.known;
      row.share = tidy;
      this.rows.put(row);
    });
    this.emit(row);
    return this.client(row)!;
  }

  /** Opens one agent to a team by hand, or closes it again. */
  open(id: string, session: string, on: boolean): Team {
    this.routing();
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", `no team ${id}`);
    const s = this.deps.sessions().find((x) => x.id === session);
    if (!s || s.status === "ended") throw new RpcError("not_found", `no live session ${session}`);
    const p = this.placeOf(s);
    if (on && !shares(row.share, p.node, p.path, this.deps.platformOf)) throw new RpcError("invalid", "that agent works in a folder you do not share with the team: share it first");
    const opened = new Set(row.share.opened ?? []);
    if (on) opened.add(session);
    else opened.delete(session);
    return this.share(id, { ...row.share, opened: [...opened] });
  }

  private placeOf(s: Session): { node: string; path: string } {
    return { node: s.node, path: this.deps.place(s).path };
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

  /** An exclude share's places that appeared since it was set: shared closed until the user opens them. */
  private refreshClosed(row: TeamRow): boolean {
    if (row.share.mode !== "exclude" || !row.known) return false;
    const known = new Set(row.known);
    const closed = [...(row.share.closed ?? [])];
    const closedKeys = new Set(closed.map((c) => placeKey(c.node, c.path, this.deps.platformOf)));
    let added = false;
    const consider = (node: string, path: string) => {
      const k = placeKey(node, path, this.deps.platformOf);
      if (known.has(k) || closedKeys.has(k) || !shares(row.share, node, path, this.deps.platformOf)) return;
      if (within(closed, node, path, this.deps.platformOf)) return;
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
    if (!added) return false;
    row.share = { ...row.share, closed };
    this.rows.put(row);
    this.emit(row);
    return true;
  }

  // --- doing what the chain says ----------------------------------------------------------------------------

  /** Makes this side what a team's chain says: links with everyone in it, none with whoever went, the chat's people, the chat's name. Once at a time per team. */
  async reconcile(id: string): Promise<void> {
    const running = this.reconciling.get(id);
    if (running) {
      this.again.add(id);
      return running;
    }
    const p = (async () => {
      try {
        do {
          this.again.delete(id);
          await this.reconcileOnce(id);
        } while (this.again.has(id));
      } finally {
        this.reconciling.delete(id);
      }
    })();
    this.reconciling.set(id, p);
    return p;
  }

  private async reconcileOnce(id: string): Promise<void> {
    if (!this.deps.routes()) return;
    const row = this.rows.get(id);
    const state = row ? await this.stateOf(row) : undefined;
    const me = this.deps.cloud.subject();
    if (!row || !state || !me) return;
    const tm = this.deps.teammates();
    const groups = this.deps.groups();
    // this side's user is no longer in it: out of its groups, and the links only it held go
    if (!state.members.has(me)) {
      const gone = state.gone.get(me);
      const why = gone?.how === "removed" ? `${state.members.get(gone.by)?.login ?? "an admin"} took you out of ${state.name}` : `you left ${state.name}`;
      groups?.leaveTeam(id);
      const name = state.name;
      this.rows.delete(id);
      this.states.delete(id);
      for (const m of state.members.values()) if (!this.sharesWith(m.subject)) tm.teamUnlinked(m.subject, why, false);
      this.emitGone(id, name);
      this.log.info("out of a team", { team: id, how: gone?.how });
      return;
    }
    if (state.ended) {
      groups?.teamEnded(id, state.members.get(state.ended.by)?.login ?? "the owner");
      const name = state.name;
      this.rows.delete(id);
      this.states.delete(id);
      for (const m of state.members.values()) if (m.subject !== me && !this.sharesWith(m.subject)) tm.teamUnlinked(m.subject, `${name} ended`, true);
      this.emitGone(id, name);
      return;
    }
    // whoever went: no link left unless another team holds the two, and out of this team's groups
    for (const g of state.gone.values()) {
      if (g.subject === me) continue;
      groups?.teamPersonGone(id, g.subject);
      if (!this.sharesWith(g.subject) && tm.teamLink(g.subject)) tm.teamUnlinked(g.subject, g.how === "removed" ? `${g.login} was taken out of ${state.name}` : `${g.login} left ${state.name}`, true);
    }
    const kp = await this.keys().catch(() => undefined);
    const mine = state.members.get(me)!;
    if (!kp || kp.keys.sign !== mine.keys.sign) {
      // this machine holds keys other than the ones the chain names: an install that lost the account's keys
      if (row.warning !== "keys") {
        row.warning = "this Cophyla does not hold the keys you joined with: ask an admin to take you out and add you again";
        this.rows.put(row);
      }
      this.emit(row);
      return;
    }
    // a link with everyone in it, and a note telling each how to reach this side
    for (const m of state.members.values()) {
      if (m.subject === me) continue;
      const key = await teamPairKey(kp.dhPriv, m.keys.dh, me, m.subject);
      const r = await tm.linkForTeam({ subject: m.subject, user: m.login, key }).catch((e: unknown) => {
        this.log.info("a team's link could not be made now", { team: id, error: message(e) });
        return undefined;
      });
      if (!r?.note || row.told?.[m.subject] === r.note.peer || !this.deps.cloud.linked()) continue;
      try {
        const sealed = await sealTeamNote(key, { relay: r.note });
        await this.deps.cloud.request("teams.note", { to: m.subject, team: id, sealed });
        row.told = { ...(row.told ?? {}), [m.subject]: r.note.peer };
        this.rows.put(row);
      } catch (e) {
        this.log.info("a note to a team member waits", { team: id, error: message(e) });
      }
    }
    // a pair's own team: the other is an admin as soon as they join
    if (row.pair && state.owner === me) {
      const other = state.members.get(row.pair);
      if (other && other.role === "member") await this.append(id, { kind: "role", subject: row.pair, role: "admin" }).catch((e: unknown) => this.log.info("a pair's team could not make the other an admin now", { error: message(e) }));
    }
    this.chatPeople(row, state);
    this.refreshClosed(row);
    this.emit(row);
    void this.compareHeads(id);
  }

  /** The team's chat holds everyone in the team: put in here from the chain; a newcomer this side invited is handed the chat; a chat not held yet is asked for. */
  private chatPeople(row: TeamRow, state: TeamState): void {
    const groups = this.deps.groups();
    const me = this.deps.cloud.subject();
    if (!groups || !me) return;
    const tm = this.deps.teammates();
    const held = groups.hasPerson(state.chat, me) !== undefined;
    if (!held) {
      // asked of whoever invited this side's user, else of the owner
      const from = state.members.get(me)?.invitedBy;
      for (const subject of [from, state.owner]) {
        const link = subject && subject !== me ? tm.teamLink(subject) : undefined;
        if (link?.linked) {
          void groups.fetchGroup(subject!, link.id, state.chat).then((got) => {
            if (got) {
              groups.setTeam(state.chat, state.id, true);
              void this.reconcile(state.id);
            }
          });
          break;
        }
      }
      return;
    }
    groups.setTeam(state.chat, state.id, true);
    groups.renameTeamChat(state.chat, state.name, state.purpose);
    let handOver = false;
    for (const m of state.members.values()) {
      if (m.subject === me) continue;
      const link = tm.teamLink(m.subject);
      if (!link) continue;
      groups.ensureTeamPerson(state.chat, m.subject, m.login, link.id);
      // the one who invited them hands them the chat, or the owner when that one is gone
      const inviter = m.invitedBy && state.members.has(m.invitedBy) ? m.invitedBy : state.owner;
      if (inviter === me && link.linked && !row.handed?.[m.subject]) {
        row.handed = { ...(row.handed ?? {}), [m.subject]: true };
        handOver = true;
      }
    }
    if (handOver) {
      this.rows.put(row);
      groups.handOver(state.chat);
    }
  }

  /** A teammate pair's groups, the two of them alone in each, go under the pair's team. */
  private placePairGroups(team: string, other: string): void {
    const groups = this.deps.groups();
    const me = this.deps.cloud.subject();
    if (!groups || !me) return;
    const theirs: string | undefined = this.deps.teammates().teamLink(other)?.user;
    if (!theirs) return;
    for (const g of groups.list()) {
      if (g.team) continue;
      let mineIn = false;
      let theirsIn = false;
      let people = 0;
      for (const m of g.members) {
        if (m.kind !== "person") continue;
        people++;
        if (m.me) mineIn = true;
        else if (m.user === theirs) theirsIn = true;
      }
      if (people === 2 && mineIn && theirsIn) groups.setTeam(g.id, team);
    }
  }

  /** Asks the other members' sides where the chain stands, now and then: a fork the server made shows. */
  private async compareHeads(id: string): Promise<void> {
    const row = this.rows.get(id);
    const state = row ? this.known(id) : undefined;
    const me = this.deps.cloud.subject();
    if (!row || !state || !me) return;
    const now = this.now();
    for (const m of state.members.values()) {
      if (m.subject === me) continue;
      if (now - (row.heads?.[m.subject] ?? 0) < HEAD_MS) continue;
      const link = this.deps.teammates().teamLink(m.subject);
      if (!link?.linked) continue;
      row.heads = { ...(row.heads ?? {}), [m.subject]: now };
      this.rows.put(row);
      try {
        const theirs = await this.deps.teammates().teamHead(link.id, { team: id, seq: state.seq, head: state.head });
        await this.compare(id, m.login, theirs);
      } catch {
        // asked again later
      }
    }
  }

  /** Where another member's copy stands, against this side's: behind, it catches up; at a place this side holds, its hash must match. */
  private async compare(id: string, who: string, theirs: { seq: number; head: string }): Promise<void> {
    const row = this.rows.get(id);
    if (!row || theirs.seq === 0) return;
    if (theirs.seq > row.entries.length) {
      await this.pull(id).catch(() => undefined);
      void this.reconcile(id);
      return;
    }
    const at = row.entries[theirs.seq - 1];
    if (!at) return;
    if ((await teamEntryHash(at)) !== theirs.head) {
      row.warning = `${who}'s copy of the team's list differs from this one: the server may have shown you two different lists`;
      this.rows.put(row);
      this.emit(row);
      this.log.warn("a team member's copy of the chain differs", { team: id, seq: theirs.seq });
    }
  }

  /** A member's side says where a team's chain stands there: compared, and this side's own told back. */
  async head(from: { subject: string; user: string }, p: { team: string; seq: number; head: string }): Promise<{ seq: number; head: string }> {
    const state = this.known(p.team);
    if (!state || !state.members.has(from.subject)) throw new RpcError("not_found", "no such team with you in it");
    await this.compare(p.team, from.user, p);
    return { seq: state.seq, head: state.head };
  }

  // --- the server's word ------------------------------------------------------------------------------------

  /** The link to the server came up: every team is taken up to where its chain is, the notes waiting are read, and what they say is done. */
  linkUp(): void {
    void this.syncAll();
  }

  /** A frame from the server about teams. */
  onFrame(method: string, params: unknown): void {
    if (!this.deps.routes()) return;
    if (method === "teams.changed") {
      const team = (params as { team?: unknown })?.team;
      if (typeof team === "string") void this.changed(team);
      return;
    }
    if (method === "teams.note") {
      const n = TeamNote.safeParse(params);
      if (n.success) void this.takeNotes([n.data]);
    }
  }

  private async changed(team: string): Promise<void> {
    try {
      const held = this.rows.get(team);
      if (!held) {
        // a team this side is told of and holds no copy of: one an invite here is for has moved on, which looking again shows
        for (const o of this.rows.offers()) if (o.offer.team === team) void this.look(teamInviteText(o.code), { via: o.offer.via, ...(o.carry ? { carry: true } : {}), ...(o.from ? { from: o.from } : {}) }).catch(() => this.decline(o.offer.id));
        return;
      }
      await this.pull(team);
      await this.reconcile(team);
    } catch (e) {
      this.log.info("a team's change could not be taken now", { team, error: message(e) });
    }
  }

  async syncAll(): Promise<void> {
    if (this.syncing) return this.syncing;
    const run = (async () => {
      try {
        if (!this.deps.routes()) return;
        // a node that took the primary role holds the chains its replica brought: folded before anything reads them
        await this.load();
        if (!this.deps.cloud.linked() || this.deps.cloud.allowed()) return;
        this.syncedAt = this.now();
        const r = (await this.deps.cloud.request("teams.mine", {})) as { teams?: { team: string; seq: number; gone?: boolean }[] };
        for (const t of r?.teams ?? []) {
          const held = this.rows.get(t.team);
          if (!held && t.gone) continue;
          if (!held) {
            // in a team the server knows and this side does not: a machine that took the primary role with no copy
            this.log.warn("in a team this Cophyla holds no copy of: taken from the server", { team: t.team });
            this.rows.put({ id: t.team, entries: [], share: { mode: "include", folders: [], open: "chosen" }, joinedAt: this.now() });
          }
          if ((this.rows.get(t.team)?.entries.length ?? 0) < t.seq) await this.pull(t.team);
        }
        await this.fetchNotes();
        for (const row of this.rows.list()) await this.reconcile(row.id);
        await this.movePairs();
      } catch (e) {
        if (e instanceof RpcError && e.code === "unsupported") this.log.info("the server is older than teams");
        else this.log.info("teams could not catch up now", { error: message(e) });
      }
    })();
    this.syncing = run;
    try {
      await run;
    } finally {
      if (this.syncing === run) this.syncing = undefined;
    }
  }

  /** The notes waiting on the server, read. */
  private async fetchNotes(): Promise<void> {
    if (!this.deps.cloud.linked()) return;
    const notes = (await this.deps.cloud.request("teams.notes", {})) as { notes?: unknown[] };
    await this.takeNotes(
      (notes?.notes ?? []).flatMap((n) => {
        const p = TeamNote.safeParse(n);
        return p.success ? [p.data] : [];
      }),
    );
  }

  /** Notes other members left: what each says to dial, kept on their link; read ones are forgotten by the server. */
  private async takeNotes(notes: TeamNote[]): Promise<void> {
    if (notes.length === 0) return;
    const me = this.deps.cloud.subject();
    const kp = await this.keys().catch(() => undefined);
    if (!me || !kp) return;
    const done: string[] = [];
    const reached = new Set<string>();
    for (const n of notes) {
      let state = this.known(n.team);
      if (!state?.members.has(n.from)) {
        // a note may come before the change that let its writer in: the chain is taken first
        state = (await this.pull(n.team).catch(() => undefined)) ?? state;
        if (state) await this.reconcile(n.team);
      }
      const from = state?.members.get(n.from);
      if (!state || !from || !state.members.has(me)) {
        if (!state || state.gone.has(n.from)) done.push(n.id);
        continue;
      }
      try {
        const key = await teamPairKey(kp.dhPriv, from.keys.dh, me, n.from);
        const body = (await openTeamNote(key, n.sealed)) as { relay?: ConnectionRelay };
        if (body?.relay && typeof body.relay.url === "string" && typeof body.relay.peer === "string" && typeof body.relay.token === "string") {
          // the link it is about is made first: a note may come before this side made it
          if (!this.deps.teammates().teamLink(n.from)) await this.reconcile(n.team);
          if (!this.deps.teammates().teamReached(n.from, body.relay)) continue;
          reached.add(n.team);
        }
        done.push(n.id);
      } catch (e) {
        this.log.warn("a team member's note does not open: left", { team: n.team, error: message(e) });
        done.push(n.id);
      }
    }
    if (done.length > 0) await this.deps.cloud.request("teams.notes.ack", { ids: done }).catch(() => undefined);
    // a note that came before this side took the change it rests on (its own join, say) waits on the server: read again shortly
    if (done.length < notes.length && !this.notesAgain) {
      this.notesAgain = setTimeout(() => {
        this.notesAgain = undefined;
        void this.fetchNotes().catch(() => undefined);
      }, NOTES_AGAIN_MS);
      if (typeof this.notesAgain === "object" && "unref" in this.notesAgain) this.notesAgain.unref();
    }
    // a link that reaches its member now: the chat is handed over or asked for, heads compared
    for (const team of reached) void this.reconcile(team);
  }

  /**
   * The teammate pairs made with a code become teams of two, keeping what each side shares: the
   * side whose account sorts first makes the team and hands the other the invite on their link;
   * a side older than teams is tried again later.
   */
  private async movePairs(): Promise<void> {
    const me = this.deps.cloud.subject();
    if (!me || !this.deps.cloud.linked()) return;
    const tm = this.deps.teammates();
    for (const p of tm.teamlessRows()) {
      if (me > p.subject) continue;
      const moved = this.rows.pairMove(p.id);
      if (moved && this.now() - moved.at < PAIR_RETRY_MS) continue;
      try {
        // their Cophyla knows teams: a code that is not one is refused as invalid, not unsupported
        await tm.offerTeam(p.id, "probe").catch((e: unknown) => {
          if (e instanceof RpcError && e.code === "unsupported") throw e;
        });
        let team = moved?.team && this.rows.get(moved.team) ? moved.team : undefined;
        if (!team) {
          const made = await this.create({ name: `${this.login()} and ${p.user}`, share: p.share });
          team = made.id;
          const row = this.rows.get(team)!;
          row.pair = p.subject;
          if (p.known && row.share.mode === "exclude") row.known = p.known;
          this.rows.put(row);
          this.rows.putPairMove({ teammate: p.id, team, at: this.now() });
        }
        const inv = await this.invite(team, p.user);
        await tm.offerTeam(p.id, inv.invite.code, true);
        this.placePairGroups(team, p.subject);
        this.log.info("a teammate pair moved into a team", { team });
      } catch (e) {
        this.rows.putPairMove({ teammate: p.id, ...(moved?.team ? { team: moved.team } : {}), at: this.now() });
        this.log.info("a teammate pair stays as it is for now", { error: message(e) });
      }
    }
  }

  /** Offers run out; exclude shares find new places; teams are reconciled; pairs are moved; now and then all is taken from the server again. */
  async sweep(): Promise<void> {
    if (!this.deps.routes()) return;
    const now = this.now();
    // a node that became the primary after its link came up has not caught up yet
    if (now - this.syncedAt > SYNC_MS) await this.syncAll();
    for (const o of this.rows.offers()) {
      if (o.offer.expiresAt > now) continue;
      this.rows.dropOffer(o.offer.id);
      this.deps.bus.emit("teams.offer", { ...o.offer, gone: true });
    }
    for (const row of this.rows.list()) {
      if (this.refreshClosed(row)) this.deps.teammates().shareChange(() => undefined);
      await this.reconcile(row.id);
    }
    await this.movePairs();
  }
}

/** A short, stable id for logs: never the key. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}
