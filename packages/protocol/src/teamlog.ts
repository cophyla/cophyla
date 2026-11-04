// A team's member list: a chain of changes, each signed on the machine of the person who made
// it and naming the hash of the change before it, so whoever holds the chain checks it alone.
// The server keeps the chain and hands it out, and checks what it can before it takes a change,
// but every member's Cophyla checks it again: the server can hold a change back, never forge,
// drop or reorder one, since a change it made up would carry no member's signature.
//
// Who may make which change:
//   create  the first change, by the one who makes the team: its owner, whose keys root it
//   invite  the owner or an admin: one GitHub account may join, once, until `expiresAt`
//   cancel  the owner or an admin: an invite still open is no longer
//   join    the person invited: signed by their own new key and by the invite's check key,
//           which only its secret derives, with the server's word that the account is theirs
//   remove  the owner takes out anyone but themselves; an admin takes out a member
//   leave   anyone but the owner, of themselves
//   role    the owner makes a member an admin, or an admin a member
//   owner   the owner hands the team to a member, and is an admin from then on
//   update  the owner or an admin renames the team or changes what it is for
//   end     the owner ends the team: nothing more is taken
//
// The invite's secret never reaches the server: it travels in the invite the inviter sends the
// person by whatever means they like, and derives the check key the invite names. A join
// passes that check, so any member's Cophyla takes it with every admin asleep; the server's
// word ties it to the GitHub account the invite was for, so a code that leaks is no use to
// anyone else, and the server alone, without the secret, makes no join either.
//
// Two members' Cophylas key the link between them from both people's keys as the chain names
// them (`teamPairKey`), so nobody in between, the server included, can stand for either.

import { z } from "zod";
import { GroupId, TeamId, TeamInviteId, Timestamp } from "./ids.ts";

/** How long an invite is open. */
export const TEAM_INVITE_MS = 7 * 24 * 60 * 60_000;
/** The most people a team holds. */
export const TEAM_PEOPLE_MAX = 50;
/** The most changes a team's chain holds. */
export const TEAM_LOG_MAX = 5_000;
/** A team's name, and what it is for. */
export const TEAM_NAME_MAX = 80;
export const TEAM_PURPOSE_MAX = 300;

const B64U_32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, { message: "expected 32 bytes, base64url" });
const B64U_64 = z.string().regex(/^[A-Za-z0-9_-]{86}$/, { message: "expected 64 bytes, base64url" });
/** An account as the server names it. */
const Subject = z.string().min(1).max(120);
/** A GitHub login. */
const Login = z.string().min(1).max(64);

/** A person's public keys for teams: Ed25519 to sign the changes they make, X25519 for the links to other members. */
export const TeamKeys = z.object({ sign: B64U_32, dh: B64U_32 });
export type TeamKeys = z.infer<typeof TeamKeys>;

/** A person as the chain names them: their account, their login and their keys. */
export const TeamPerson = z.object({ subject: Subject, login: Login, keys: TeamKeys });
export type TeamPerson = z.infer<typeof TeamPerson>;

export const TeamRole = z.enum(["owner", "admin", "member"]);
export type TeamRole = z.infer<typeof TeamRole>;

export const TeamChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name: z.string().min(1).max(TEAM_NAME_MAX), purpose: z.string().max(TEAM_PURPOSE_MAX).optional(), chat: GroupId, owner: TeamPerson }),
  z.object({ kind: z.literal("invite"), invite: TeamInviteId, login: Login, check: B64U_32, expiresAt: Timestamp }),
  z.object({ kind: z.literal("cancel"), invite: TeamInviteId }),
  z.object({ kind: z.literal("join"), invite: TeamInviteId, member: TeamPerson, identity: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("remove"), subject: Subject, why: z.string().max(200).optional() }),
  z.object({ kind: z.literal("leave") }),
  z.object({ kind: z.literal("role"), subject: Subject, role: z.enum(["admin", "member"]) }),
  z.object({ kind: z.literal("owner"), subject: Subject }),
  z.object({ kind: z.literal("update"), name: z.string().min(1).max(TEAM_NAME_MAX).optional(), purpose: z.string().max(TEAM_PURPOSE_MAX).optional() }),
  z.object({ kind: z.literal("end") }),
]);
export type TeamChange = z.infer<typeof TeamChange>;

/** One change as the chain holds it: signed by its author (`sig`), and a join by the invite's check key too (`check`). */
export const TeamEntry = z.object({
  team: TeamId,
  seq: z.number().int().positive(),
  /** The hash of the change before it; empty for the first. */
  prev: z.string().max(43),
  /** The account that made it. */
  by: Subject,
  at: Timestamp,
  change: TeamChange,
  sig: B64U_64,
  check: B64U_64.optional(),
});
export type TeamEntry = z.infer<typeof TeamEntry>;

export type UnsignedTeamEntry = Omit<TeamEntry, "sig" | "check">;

export interface TeamMemberState {
  subject: string;
  login: string;
  role: TeamRole;
  keys: TeamKeys;
  joinedAt: number;
  /** Who invited them; absent for the one who made the team. */
  invitedBy?: string;
}

export interface TeamInviteState {
  id: string;
  login: string;
  check: string;
  expiresAt: number;
  by: string;
  at: number;
  state: "open" | "used" | "cancelled";
  /** The account that used it. */
  usedBy?: string;
}

export interface TeamGone {
  subject: string;
  login: string;
  at: number;
  how: "removed" | "left";
  by: string;
  why?: string;
}

/** A team as its chain says it is now. */
export interface TeamState {
  id: string;
  name: string;
  purpose?: string;
  chat: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  members: Map<string, TeamMemberState>;
  invites: Map<string, TeamInviteState>;
  /** Everyone who was in it and is no longer: by account, the last time they went. */
  gone: Map<string, TeamGone>;
  ended?: { at: number; by: string };
  seq: number;
  head: string;
}

export class TeamLogError extends Error {
  readonly seq: number;
  constructor(message: string, seq: number) {
    super(message);
    this.seq = seq;
  }
}

/** Checks the server's word on an account, for a join: who it says, bound to `aud`. Throws when it does not hold. */
export type TeamIdentityCheck = (token: string, aud: string) => { subject: string; login: string } | Promise<{ subject: string; login: string }>;

// --- bytes ------------------------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("no WebCrypto here");
  return s;
}

const utf8 = new TextEncoder();

export function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(text: string): Bytes {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Bytes {
  const out = new Uint8Array(new ArrayBuffer(text.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** JSON with every object's keys in order and nothing undefined: the same bytes on every side. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

async function sha256(data: Uint8Array | string): Promise<Bytes> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  return new Uint8Array(await subtle().digest("SHA-256", bytes as Bytes));
}

/** What an entry's signatures cover: everything but the signatures. */
export function signedBytes(e: UnsignedTeamEntry): Bytes {
  return utf8.encode(canonical({ team: e.team, seq: e.seq, prev: e.prev, by: e.by, at: e.at, change: e.change }));
}

/** An entry's hash, which the next one names. */
export async function teamEntryHash(e: TeamEntry): Promise<string> {
  return b64u(await sha256(canonical(e)));
}

/** The hash a join's identity is bound to: the keys it joins with. */
export async function teamKeysHash(keys: TeamKeys): Promise<string> {
  return hex(await sha256(canonical(keys)));
}

/** The audience of the server's word on the account that joins: this team, this invite, these keys. */
export function teamJoinAudience(team: string, invite: string, keysHash: string): string {
  return `cophyla-teamjoin/1|${team}|${invite}|${keysHash}`;
}

const ED25519_PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

async function verifyEd25519(pub: string, sig: string, data: Bytes): Promise<boolean> {
  try {
    const key = await subtle().importKey("raw", fromB64u(pub), { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify("Ed25519", key, fromB64u(sig), data);
  } catch {
    return false;
  }
}

/** Signs with an Ed25519 key kept as PKCS#8, base64url. */
export async function signEd25519(privPkcs8: string, data: Bytes): Promise<string> {
  const key = await subtle().importKey("pkcs8", fromB64u(privPkcs8), { name: "Ed25519" }, false, ["sign"]);
  return b64u(new Uint8Array(await subtle().sign("Ed25519", key, data)));
}

/** A person's team keys, made once per account: the public halves for the chain, the private ones kept on their machines alone. */
export interface TeamKeyPair {
  keys: TeamKeys;
  /** PKCS#8, base64url. */
  signPriv: string;
  dhPriv: string;
}

export async function makeTeamKeys(): Promise<TeamKeyPair> {
  const s = subtle();
  const sign = (await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const dh = (await s.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as CryptoKeyPair;
  return {
    keys: {
      sign: b64u(new Uint8Array(await s.exportKey("raw", sign.publicKey))),
      dh: b64u(new Uint8Array(await s.exportKey("raw", dh.publicKey))),
    },
    signPriv: b64u(new Uint8Array(await s.exportKey("pkcs8", sign.privateKey))),
    dhPriv: b64u(new Uint8Array(await s.exportKey("pkcs8", dh.privateKey))),
  };
}

async function hkdf(ikm: Bytes, salt: string, info: string, bytes = 32): Promise<Bytes> {
  const s = subtle();
  const key = await s.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8.encode(salt), info: utf8.encode(info) }, key, bytes * 8));
}

/** An invite's check key, derived from its secret: the public half goes in the chain, the private one signs the join. */
export async function teamInviteCheck(secretHex: string, team: string, invite: string): Promise<{ pub: string; priv: string }> {
  const seed = await hkdf(fromHex(secretHex), "cophyla-teaminvite/1", `${team}|${invite}`);
  const pkcs8 = new Uint8Array(new ArrayBuffer(ED25519_PKCS8.length + 32));
  pkcs8.set(ED25519_PKCS8, 0);
  pkcs8.set(seed, ED25519_PKCS8.length);
  const s = subtle();
  const priv = await s.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await s.exportKey("jwk", priv);
  if (typeof jwk.x !== "string") throw new Error("the check key has no public half");
  return { pub: jwk.x, priv: b64u(pkcs8) };
}

/**
 * The key two members' link is keyed from: X25519 of one's private key and the other's public
 * one, the same from either end, bound to the two accounts. 32 bytes, hex, as a teammate's key is.
 */
export async function teamPairKey(myDhPriv: string, theirDh: string, a: string, b: string): Promise<string> {
  const s = subtle();
  const priv = await s.importKey("pkcs8", fromB64u(myDhPriv), { name: "X25519" }, false, ["deriveBits"]);
  const pub = await s.importKey("raw", fromB64u(theirDh), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await s.deriveBits({ name: "X25519", public: pub }, priv, 256));
  const [x, y] = [a, b].sort();
  return hex(await hkdf(shared, "cophyla-teamlink/1", `${x}|${y}`));
}

/** Seals a note for the other end of a pair, keyed from their pair key: only the two read it, and the server cannot make one. */
export async function sealTeamNote(pairKeyHex: string, value: unknown): Promise<string> {
  const s = subtle();
  const key = await s.importKey("raw", await hkdf(fromHex(pairKeyHex), "cophyla-teamnote/1", "note"), "AES-GCM", false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv }, key, utf8.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return b64u(out);
}

export async function openTeamNote(pairKeyHex: string, sealed: string): Promise<unknown> {
  const s = subtle();
  const key = await s.importKey("raw", await hkdf(fromHex(pairKeyHex), "cophyla-teamnote/1", "note"), "AES-GCM", false, ["decrypt"]);
  const bytes = fromB64u(sealed);
  const pt = await s.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Signs an entry with its author's key, and a join with the invite's check key too. */
export async function signTeamEntry(e: UnsignedTeamEntry, signPriv: string, checkPriv?: string): Promise<TeamEntry> {
  const data = signedBytes(e);
  const sig = await signEd25519(signPriv, data);
  return { ...e, sig, ...(checkPriv ? { check: await signEd25519(checkPriv, data) } : {}) };
}

// --- reading the chain --------------------------------------------------------------------------------

function cloneState(s: TeamState): TeamState {
  return { ...s, members: new Map([...s.members].map(([k, v]) => [k, { ...v }])), invites: new Map([...s.invites].map(([k, v]) => [k, { ...v }])), gone: new Map([...s.gone].map(([k, v]) => [k, { ...v }])) };
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The team after one more change, checked: its place in the chain, its author's signature, and
 * that its author may make it. Throws `TeamLogError` saying why not; `state` is left as it was.
 */
export async function applyTeamEntry(state: TeamState | undefined, raw: unknown, identity: TeamIdentityCheck): Promise<TeamState> {
  const parsed = TeamEntry.safeParse(raw);
  const seqOf = (state?.seq ?? 0) + 1;
  if (!parsed.success) throw new TeamLogError("a change that is not one", seqOf);
  const e = parsed.data;
  const refuse = (why: string): never => {
    throw new TeamLogError(why, e.seq);
  };
  const data = signedBytes(e);
  const c = e.change;
  if (!state) {
    if (e.seq !== 1 || e.prev !== "") refuse("the chain does not start at its first change");
    if (c.kind !== "create") refuse("the first change is not the team's making");
    if (c.kind !== "create") throw new Error("unreachable");
    if (c.owner.subject !== e.by) refuse("the team's maker is not its owner");
    if (!(await verifyEd25519(c.owner.keys.sign, e.sig, data))) refuse("the making is not signed by its maker");
    const owner: TeamMemberState = { subject: c.owner.subject, login: c.owner.login, role: "owner", keys: c.owner.keys, joinedAt: e.at };
    return {
      id: e.team,
      name: c.name,
      ...(c.purpose ? { purpose: c.purpose } : {}),
      chat: c.chat,
      owner: c.owner.subject,
      createdAt: e.at,
      updatedAt: e.at,
      members: new Map([[owner.subject, owner]]),
      invites: new Map(),
      gone: new Map(),
      seq: 1,
      head: await teamEntryHash(e),
    };
  }
  if (e.team !== state.id) refuse("a change of another team");
  if (e.seq !== state.seq + 1) refuse(`change ${e.seq} where ${state.seq + 1} comes next`);
  if (e.prev !== state.head) refuse("a change that names another change before it");
  if (state.ended) refuse("the team has ended");
  const next = cloneState(state);
  next.seq = e.seq;
  next.head = await teamEntryHash(e);
  if (c.kind === "join") {
    const inv = next.invites.get(c.invite);
    if (!inv) refuse("a join to an invite there is none of");
    if (!inv) throw new Error("unreachable");
    if (inv.state !== "open") refuse(inv.state === "used" ? "the invite was used already" : "the invite was cancelled");
    if (e.at > inv.expiresAt) refuse("the invite had run out");
    if (c.member.subject !== e.by) refuse("a join for someone else");
    if (next.members.has(e.by)) refuse("they are in the team already");
    if (next.members.size >= TEAM_PEOPLE_MAX) refuse(`a team holds ${TEAM_PEOPLE_MAX} people at most`);
    if (!(await verifyEd25519(c.member.keys.sign, e.sig, data))) refuse("the join is not signed by the key it brings");
    if (!e.check || !(await verifyEd25519(inv.check, e.check, data))) refuse("the join does not pass the invite's check");
    let who: { subject: string; login: string };
    try {
      who = await identity(c.identity, teamJoinAudience(e.team, c.invite, await teamKeysHash(c.member.keys)));
    } catch (err) {
      return refuse(`the server's word on the account that joined does not hold (${err instanceof Error ? err.message : String(err)})`);
    }
    if (who.subject !== e.by) refuse("the server's word names another account");
    if (!sameLogin(who.login, inv.login)) refuse(`the invite was for ${inv.login}, not ${who.login}`);
    inv.state = "used";
    inv.usedBy = e.by;
    next.members.set(e.by, { subject: e.by, login: who.login, role: "member", keys: c.member.keys, joinedAt: e.at, invitedBy: inv.by });
    next.gone.delete(e.by);
    next.updatedAt = e.at;
    return next;
  }
  const author = next.members.get(e.by);
  if (!author) refuse("a change by someone not in the team");
  if (!author) throw new Error("unreachable");
  if (!(await verifyEd25519(author.keys.sign, e.sig, data))) refuse("a change not signed by its author");
  const manager = author.role === "owner" || author.role === "admin";
  switch (c.kind) {
    case "create":
      refuse("a team is made once");
      break;
    case "invite": {
      if (!manager) refuse("only the owner or an admin invites");
      if (next.invites.has(c.invite)) refuse("that invite was made already");
      if (c.expiresAt <= e.at) refuse("an invite that ran out as it was made");
      next.invites.set(c.invite, { id: c.invite, login: c.login, check: c.check, expiresAt: c.expiresAt, by: e.by, at: e.at, state: "open" });
      break;
    }
    case "cancel": {
      if (!manager) refuse("only the owner or an admin cancels an invite");
      const inv = next.invites.get(c.invite);
      if (!inv || inv.state !== "open") refuse("no open invite to cancel");
      inv!.state = "cancelled";
      break;
    }
    case "remove": {
      if (!manager) refuse("only the owner or an admin takes someone out");
      const target = next.members.get(c.subject);
      if (!target) refuse("taking out someone not in the team");
      if (c.subject === e.by) refuse("one leaves rather than takes oneself out");
      if (author.role === "admin" && target!.role !== "member") refuse("an admin takes out members alone");
      next.members.delete(c.subject);
      next.gone.set(c.subject, { subject: c.subject, login: target!.login, at: e.at, how: "removed", by: e.by, ...(c.why ? { why: c.why } : {}) });
      break;
    }
    case "leave": {
      if (author.role === "owner") refuse("the owner hands the team over or ends it before leaving");
      next.members.delete(e.by);
      next.gone.set(e.by, { subject: e.by, login: author.login, at: e.at, how: "left", by: e.by });
      break;
    }
    case "role": {
      if (author.role !== "owner") refuse("only the owner makes or unmakes admins");
      const target = next.members.get(c.subject);
      if (!target || target.role === "owner") refuse("no member to change");
      target!.role = c.role;
      break;
    }
    case "owner": {
      if (author.role !== "owner") refuse("only the owner hands the team over");
      const target = next.members.get(c.subject);
      if (!target || c.subject === e.by) refuse("no member to hand it to");
      target!.role = "owner";
      author.role = "admin";
      next.owner = c.subject;
      break;
    }
    case "update": {
      if (!manager) refuse("only the owner or an admin renames the team");
      if (c.name !== undefined) next.name = c.name;
      if (c.purpose !== undefined) {
        if (c.purpose) next.purpose = c.purpose;
        else delete next.purpose;
      }
      break;
    }
    case "end": {
      if (author.role !== "owner") refuse("only the owner ends the team");
      next.ended = { at: e.at, by: e.by };
      break;
    }
  }
  next.updatedAt = e.at;
  return next;
}

/** The team a whole chain says, checked change by change from its making. */
export async function foldTeamLog(entries: readonly unknown[], identity: TeamIdentityCheck): Promise<TeamState> {
  if (entries.length === 0) throw new TeamLogError("an empty chain", 1);
  if (entries.length > TEAM_LOG_MAX) throw new TeamLogError(`a chain longer than ${TEAM_LOG_MAX}`, TEAM_LOG_MAX + 1);
  let state: TeamState | undefined;
  for (const e of entries) state = await applyTeamEntry(state, e, identity);
  return state!;
}

/** Whether an invite would be open at `now`, as the chain says it is. */
export function inviteOpen(inv: TeamInviteState | undefined, now: number): boolean {
  return inv !== undefined && inv.state === "open" && inv.expiresAt > now;
}

// --- the invite as the inviter sends it -------------------------------------------------------------------

export const TEAM_JOIN_PREFIX = "cophyla-join:";

export const TeamInviteCode = z.object({
  v: z.literal(1),
  /** The server the team is kept on: its origin. */
  server: z.string().min(1).max(300),
  team: TeamId,
  invite: TeamInviteId,
  /** 32 bytes, hex: derives the invite's check key. Never stored by the server, never sent to it. */
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  /** The hash of the change that made the invite: the joiner checks the chain it is handed against it. */
  at: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** For the joiner's eyes before the chain is fetched: the team's name and who invited them. */
  name: z.string().max(TEAM_NAME_MAX).optional(),
  by: z.string().max(64).optional(),
});
export type TeamInviteCode = z.infer<typeof TeamInviteCode>;

export class TeamInviteError extends Error {}

export function teamInviteText(code: TeamInviteCode): string {
  return TEAM_JOIN_PREFIX + b64u(utf8.encode(JSON.stringify(code)));
}

/** An invite read back from its text, or from a link with it after `#`; throws `TeamInviteError` on anything else. */
export function parseTeamInvite(input: string): TeamInviteCode {
  const compact = input.replace(/\s+/g, "");
  let payload: string | undefined;
  if (compact.startsWith(TEAM_JOIN_PREFIX)) payload = compact.slice(TEAM_JOIN_PREFIX.length);
  else {
    const hash = compact.indexOf("#");
    const rest = hash >= 0 ? compact.slice(hash + 1) : "";
    payload = rest.startsWith(TEAM_JOIN_PREFIX) ? rest.slice(TEAM_JOIN_PREFIX.length) : rest || undefined;
  }
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new TeamInviteError("not a Cophyla team invite");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64u(payload)));
  } catch {
    throw new TeamInviteError("the invite is damaged");
  }
  const p = TeamInviteCode.safeParse(json);
  if (!p.success) throw new TeamInviteError("the invite is damaged or from another version");
  return p.data;
}
