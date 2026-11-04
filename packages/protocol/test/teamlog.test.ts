// A team's chain of signed changes: who may make which, and what a forger, a reorderer or a
// server without the invite's secret cannot get past.

import { describe, expect, test } from "bun:test";
import {
  applyTeamEntry,
  foldTeamLog,
  makeTeamKeys,
  newId,
  openTeamNote,
  parseTeamInvite,
  sealTeamNote,
  signTeamEntry,
  teamEntryHash,
  teamInviteCheck,
  teamInviteText,
  teamJoinAudience,
  teamKeysHash,
  TeamLogError,
  teamPairKey,
} from "../src/index.ts";
import type { TeamChange, TeamEntry, TeamIdentityCheck, TeamKeyPair, TeamState } from "../src/index.ts";

interface Person {
  subject: string;
  login: string;
  kp: TeamKeyPair;
}

async function person(subject: string, login: string): Promise<Person> {
  return { subject, login, kp: await makeTeamKeys() };
}

// the server's word, as a test stands it in: a token that names the account and the audience
const identity: TeamIdentityCheck = (token, aud) => {
  const t = JSON.parse(token) as { sub: string; login: string; aud: string };
  if (t.aud !== aud) throw new Error("made for another exchange");
  return { subject: t.sub, login: t.login };
};
const token = (p: Person, aud: string) => JSON.stringify({ sub: p.subject, login: p.login, aud });

class Chain {
  entries: TeamEntry[] = [];
  state?: TeamState;
  readonly team: string;
  constructor(team: string) {
    this.team = team;
  }
  async entry(by: Person, change: TeamChange, at = 1000 + this.entries.length, checkPriv?: string): Promise<TeamEntry> {
    const prev = this.entries.length === 0 ? "" : await teamEntryHash(this.entries[this.entries.length - 1]!);
    return signTeamEntry({ team: this.team, seq: this.entries.length + 1, prev, by: by.subject, at, change }, by.kp.signPriv, checkPriv);
  }
  async add(e: TeamEntry): Promise<TeamState> {
    this.state = await applyTeamEntry(this.state, e, identity);
    this.entries.push(e);
    return this.state;
  }
  async make(by: Person, change: TeamChange, at?: number): Promise<TeamState> {
    return this.add(await this.entry(by, change, at));
  }
  /** An invite and its join, as the invited person's Cophyla makes it with the secret. */
  async invite(admin: Person, login: string, expiresAt = 10_000_000): Promise<{ invite: string; secret: string }> {
    const invite = newId("teamInvite");
    const secret = "ab".repeat(32);
    const check = await teamInviteCheck(secret, this.team, invite);
    await this.make(admin, { kind: "invite", invite, login, check: check.pub, expiresAt });
    return { invite, secret };
  }
  async joinEntry(p: Person, invite: string, secret: string, at?: number): Promise<TeamEntry> {
    const check = await teamInviteCheck(secret, this.team, invite);
    const aud = teamJoinAudience(this.team, invite, await teamKeysHash(p.kp.keys));
    return this.entry(p, { kind: "join", invite, member: { subject: p.subject, login: p.login, keys: p.kp.keys }, identity: token(p, aud) }, at, check.priv);
  }
}

async function teamOf(owner: Person): Promise<Chain> {
  const c = new Chain(newId("team"));
  await c.make(owner, { kind: "create", name: "Studio", chat: newId("group"), owner: { subject: owner.subject, login: owner.login, keys: owner.kp.keys } });
  return c;
}

async function refused(p: Promise<unknown>, words: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TeamLogError);
    expect((e as Error).message).toMatch(words);
    return;
  }
  throw new Error("expected a refusal");
}

describe("a team's chain", () => {
  test("made, invited into, joined, with roles, a removal, a leave, a hand-over and an end", async () => {
    const bob = await person("acc_bob", "bob");
    const fm = await person("acc_fm", "FeritMelih");
    const carol = await person("acc_carol", "carol");
    const c = await teamOf(bob);
    expect(c.state!.owner).toBe("acc_bob");
    const i1 = await c.invite(bob, "feritmelih");
    let s = await c.add(await c.joinEntry(fm, i1.invite, i1.secret));
    expect(s.members.get("acc_fm")).toMatchObject({ role: "member", login: "FeritMelih", invitedBy: "acc_bob" });
    expect(s.invites.get(i1.invite)!.state).toBe("used");
    s = await c.make(bob, { kind: "role", subject: "acc_fm", role: "admin" });
    expect(s.members.get("acc_fm")!.role).toBe("admin");
    // an admin invites in turn
    const i2 = await c.invite(fm, "carol");
    s = await c.add(await c.joinEntry(carol, i2.invite, i2.secret));
    expect([...s.members.keys()].sort()).toEqual(["acc_bob", "acc_carol", "acc_fm"]);
    // an admin takes a member out; the member is gone, saying how
    s = await c.make(fm, { kind: "remove", subject: "acc_carol", why: "moved on" });
    expect(s.members.has("acc_carol")).toBe(false);
    expect(s.gone.get("acc_carol")).toMatchObject({ how: "removed", by: "acc_fm", why: "moved on" });
    s = await c.make(bob, { kind: "update", name: "Studio 2", purpose: "the 1.0 release" });
    expect(s.name).toBe("Studio 2");
    s = await c.make(bob, { kind: "owner", subject: "acc_fm" });
    expect(s.owner).toBe("acc_fm");
    expect(s.members.get("acc_bob")!.role).toBe("admin");
    s = await c.make(bob, { kind: "leave" });
    expect(s.gone.get("acc_bob")!.how).toBe("left");
    s = await c.make(fm, { kind: "end" });
    expect(s.ended?.by).toBe("acc_fm");
    // the whole chain read from the start says the same
    const again = await foldTeamLog(c.entries, identity);
    expect(again.head).toBe(s.head);
    expect([...again.members.keys()]).toEqual(["acc_fm"]);
    await refused(c.make(fm, { kind: "update", name: "after" }), /ended/);
  });

  test("only the owner or an admin invites, removes or renames; only the owner names admins or ends it", async () => {
    const bob = await person("acc_bob", "bob");
    const dan = await person("acc_dan", "dan");
    const eve = await person("acc_eve", "eve");
    const c = await teamOf(bob);
    const i = await c.invite(bob, "dan");
    await c.add(await c.joinEntry(dan, i.invite, i.secret));
    const j = await c.invite(bob, "eve");
    await c.add(await c.joinEntry(eve, j.invite, j.secret));
    await refused(c.make(dan, { kind: "invite", invite: newId("teamInvite"), login: "x", check: "A".repeat(43), expiresAt: 9_999_999 }), /only the owner or an admin invites/);
    await refused(c.make(dan, { kind: "remove", subject: "acc_eve" }), /only the owner or an admin/);
    await refused(c.make(dan, { kind: "update", name: "mine" }), /only the owner or an admin/);
    await refused(c.make(dan, { kind: "role", subject: "acc_dan", role: "admin" }), /only the owner/);
    await c.make(bob, { kind: "role", subject: "acc_dan", role: "admin" });
    await c.make(bob, { kind: "role", subject: "acc_eve", role: "admin" });
    // an admin takes out members alone, never another admin or the owner
    await refused(c.make(dan, { kind: "remove", subject: "acc_eve" }), /members alone/);
    await refused(c.make(dan, { kind: "remove", subject: "acc_bob" }), /members alone/);
    await refused(c.make(dan, { kind: "end" }), /only the owner ends/);
    await refused(c.make(bob, { kind: "leave" }), /hands the team over or ends it/);
  });

  test("a join needs the invite's secret, the account it was for, an open invite, and its own key's signature", async () => {
    const bob = await person("acc_bob", "bob");
    const fm = await person("acc_fm", "feritmelih");
    const mallory = await person("acc_mal", "mallory");
    const c = await teamOf(bob);
    const i = await c.invite(bob, "feritmelih", 5000);
    // the server, holding everything but the secret: a check signed with any other key
    await refused(c.add(await c.joinEntry(fm, i.invite, "cd".repeat(32))), /invite's check/);
    // someone else holding the secret: the server's word names another login
    await refused(c.add(await c.joinEntry(mallory, i.invite, i.secret)), /was for feritmelih, not mallory/);
    // a token bound to other keys
    const other = await makeTeamKeys();
    const e = await c.joinEntry(fm, i.invite, i.secret);
    const swapped = { ...e, change: { ...e.change, member: { subject: fm.subject, login: fm.login, keys: other.keys } } };
    await refused(c.add(swapped), /not signed by the key it brings/);
    // after it ran out
    await refused(c.add(await c.joinEntry(fm, i.invite, i.secret, 6000)), /run out/);
    await c.add(await c.joinEntry(fm, i.invite, i.secret, 4000));
    // once
    const fm2 = await person("acc_fm2", "feritmelih");
    await refused(c.add(await c.joinEntry(fm2, i.invite, i.secret, 4000)), /used already/);
  });

  test("a cancelled invite takes no join", async () => {
    const bob = await person("acc_bob", "bob");
    const fm = await person("acc_fm", "feritmelih");
    const c = await teamOf(bob);
    const i = await c.invite(bob, "feritmelih");
    await c.make(bob, { kind: "cancel", invite: i.invite });
    await refused(c.add(await c.joinEntry(fm, i.invite, i.secret)), /cancelled/);
  });

  test("a change by someone not in it, a forged signature, a reorder or a skipped change is refused", async () => {
    const bob = await person("acc_bob", "bob");
    const server = await person("acc_srv", "server");
    const c = await teamOf(bob);
    // the server signs a change as bob with a key of its own
    const forged = await signTeamEntry({ team: c.team, seq: 2, prev: c.state!.head, by: "acc_bob", at: 2000, change: { kind: "update", name: "taken" } }, server.kp.signPriv);
    await refused(c.add(forged), /not signed by its author/);
    await refused(c.make(server, { kind: "update", name: "taken" }), /not in the team/);
    const a = await c.entry(bob, { kind: "update", name: "one" });
    await c.add(a);
    const b = await c.entry(bob, { kind: "update", name: "two" });
    // the same change again, or one naming another before it
    await refused(c.add(a), /comes next/);
    await refused(applyTeamEntry(c.state, { ...b, prev: "A".repeat(43) }, identity), /names another change/);
    // a chain handed over out of order
    await refused(foldTeamLog([c.entries[0], b, c.entries[1]], identity), /names another change|comes next/);
    // a change of another team
    await refused(applyTeamEntry(c.state, { ...b, team: newId("team") }, identity), /another team/);
  });
});

describe("the keys between two members", () => {
  test("both ends derive the same link key, and notes sealed with it open only with it", async () => {
    const a = await makeTeamKeys();
    const b = await makeTeamKeys();
    const ab = await teamPairKey(a.dhPriv, b.keys.dh, "acc_a", "acc_b");
    const ba = await teamPairKey(b.dhPriv, a.keys.dh, "acc_b", "acc_a");
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^[0-9a-f]{64}$/);
    const c = await makeTeamKeys();
    expect(await teamPairKey(a.dhPriv, c.keys.dh, "acc_a", "acc_c")).not.toBe(ab);
    const sealed = await sealTeamNote(ab, { relay: { peer: "con_x" } });
    expect(await openTeamNote(ba, sealed)).toEqual({ relay: { peer: "con_x" } });
    await expect(openTeamNote(await teamPairKey(a.dhPriv, c.keys.dh, "acc_a", "acc_c"), sealed)).rejects.toThrow();
  });

  test("an invite reads back from its text or a link holding it", async () => {
    const team = newId("team");
    const invite = newId("teamInvite");
    const code = { v: 1 as const, server: "https://api.getcophyla.com", team, invite, secret: "0f".repeat(32), at: "A".repeat(43), name: "Studio", by: "bob" };
    const text = teamInviteText(code);
    expect(parseTeamInvite(text)).toEqual(code);
    expect(parseTeamInvite(`  ${text.slice(0, 20)}\n${text.slice(20)} `)).toEqual(code);
    expect(parseTeamInvite(`https://getcophyla.com/join#${text}`)).toEqual(code);
    expect(() => parseTeamInvite("cophyla-team:abc")).toThrow();
    expect(() => parseTeamInvite("cophyla-join:!!")).toThrow();
  });
});
