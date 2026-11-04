// Teams, end to end (milestone 35): daemons signed in to separate accounts of one (fake) server.
// Alice makes a team; she invites Bob, whose app looks at the invite and joins sharing a folder;
// the two link with no teammate code, their agents list and message each other, and Bob is
// handed the team's chat. Bob, made an admin, invites Carol, who links with both of them with no
// code from either. A change the server made up is refused. Carol taken out loses her links and
// the chat. A teammate pair made with a code before teams becomes a team of two.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeTeamKeys, signTeamEntry, teamEntryHash } from "@cophyla/protocol";
import type { Group, GroupPost, Session, Team, Teammate, TeamOffer } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { FakeServer } from "./fakes/server.ts";
import { tempHome, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, startPrimary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let fake: FakeServer | undefined;
const users: Primary[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await stopAll(...users.splice(0).map((u) => u.d));
  await fake?.stop();
  fake = undefined;
});

interface User {
  d: Started;
  ui: TestClient;
  login: string;
}

async function user(login: string): Promise<User> {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, fake!.mintToken(undefined, { subject: `usr_${login}`, login }) + "\n", { mode: 0o600 });
  const started = await startPrimary({
    home,
    toml: `[cloud]\nenabled = true\nurl = "${fake!.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\n`,
    daemon: { cloud: { keys: [fake!.publicKey], openBrowser: async () => undefined } },
  });
  users.push(started);
  await waitFor(() => started.d.cloud.hostedAllowed("relay") === undefined, 5000);
  const ui = await client(started.d, `${login}'s app`);
  clients.push(ui);
  // the login comes from the server's word on the account, a moment after the link is up
  await waitFor(async () => {
    try {
      await ui.request("teams.list", {});
      return started.d.cloud.linked;
    } catch {
      return false;
    }
  }, 5000);
  return { d: started.d, ui, login };
}

const homeShare = (u: User) => ({ mode: "include" as const, folders: [{ node: u.d.identity.id, path: u.d.home }], open: "always" as const });

async function spawnOn(d: Started): Promise<Session> {
  const ws = d.workspaces.put({ node: d.identity.id, path: d.home, name: "work" });
  const s = await d.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "say hi" }, { profiles: d.profiles });
  await waitFor(() => d.sessions.get(s.id)?.status === "idle", 10_000);
  return d.sessions.get(s.id)!;
}

async function callAs(d: Started, s: Session, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const answer = (await d.agentMessages.mcp({ harness: "claude", ppid: s.native.pid! }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: answer.result.content[0]!.text, ...(answer.result.isError ? { isError: true } : {}) };
}

const agentTurns = (d: Started, s: Session) => d.store.sessionEvents.history(s.id, { limit: 200 }).filter((e) => e.kind === "user_turn" && (e.payload as { source?: string }).source === "agent");
const teamsOf = async (u: User) => (await u.ui.request<{ teams: Team[]; offers: TeamOffer[] }>("teams.list", {})).teams;
const teammatesOf = async (u: User) => (await u.ui.request<{ teammates: Teammate[] }>("teammate.list", {})).teammates;
const groupsOf = async (u: User) => (await u.ui.request<{ groups: Group[] }>("group.list", {})).groups;

/** `waitFor`, saying which wait ran out. */
async function until<T>(label: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms?: number): Promise<T> {
  try {
    return await waitFor(check, ms);
  } catch (e) {
    throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A request the daemon refuses, saying why. */
async function refused(p: Promise<unknown>, why: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(String((e as { message?: string })?.message ?? e)).toMatch(why);
    return;
  }
  throw new Error("expected a refusal");
}

/** An invite made in one app, looked at and taken in another's. */
async function bringIn(admin: User, team: string, joiner: User, share = homeShare(joiner)): Promise<Team> {
  const inv = await admin.ui.request<{ invite: { code: string; expiresAt: number } }>("teams.invite", { team, user: joiner.login });
  expect(inv.invite.code.startsWith("cophyla-join:")).toBe(true);
  const looked = await joiner.ui.request<{ offer: TeamOffer }>("teams.look", { code: inv.invite.code });
  expect(looked.offer.team).toBe(team);
  return (await joiner.ui.request<{ team: Team }>("teams.join", { offer: looked.offer.id, share })).team;
}

describe("teams between three people", () => {
  test("made, joined with an invite each, everyone linked with everyone, the chat handed over, an admin invites, a removal takes the links and the chat", async () => {
    fake = new FakeServer();
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const a = await spawnOn(alice.d);
    const b = await spawnOn(bob.d);
    const c = await spawnOn(carol.d);

    const made = (await alice.ui.request<{ team: Team }>("teams.create", { name: "Studio", purpose: "the 1.0 release", share: homeShare(alice) })).team;
    expect(made).toMatchObject({ name: "Studio", role: "owner", members: [{ user: "alice", role: "owner", you: true }] });
    // its chat is made with it
    expect((await groupsOf(alice)).find((g) => g.id === made.chat)).toMatchObject({ team: made.id, teamChat: true, name: "Studio" });

    // an invite is for the account it names alone
    const forBob = await alice.ui.request<{ invite: { code: string } }>("teams.invite", { team: made.id, user: "bob" });
    expect(JSON.stringify(alice.d.store.audit.list({ limit: 100 }))).not.toContain(forBob.invite.code.slice(20, 60));
    // the server hands the chain to the account the invite is for alone
    await refused(carol.ui.request("teams.look", { code: forBob.invite.code }), /no open invite/);
    const looked = await bob.ui.request<{ offer: TeamOffer }>("teams.look", { code: forBob.invite.code });
    expect(looked.offer).toMatchObject({ name: "Studio", by: "alice", people: [{ user: "alice", role: "owner" }], via: "code" });
    const joined = (await bob.ui.request<{ team: Team }>("teams.join", { offer: looked.offer.id, share: homeShare(bob) })).team;
    expect(joined.members.map((m) => m.user).sort()).toEqual(["alice", "bob"]);

    // the two linked with no teammate code: each side's link reaches the other
    await until("line 127", async () => (await teammatesOf(alice)).some((t) => t.user === "bob" && t.teams?.includes(made.id)), 10_000);
    await until("line 128", async () => (await teamsOf(alice))[0]?.members.find((m) => m.user === "bob")?.linked === true, 10_000);
    await until("line 129", async () => (await teamsOf(bob))[0]?.members.find((m) => m.user === "alice")?.linked === true, 10_000);

    // the agents see each other under the login, and a message crosses
    const seen = await until("line 132", async () => {
      const r = await callAs(bob.d, b, "list_agents", {});
      return /^- (alice\/\S+):/m.exec(r.text) ? r : undefined;
    }, 10_000);
    const to = /^- (alice\/\S+):/m.exec(seen.text)![1]!;
    expect((await callAs(bob.d, b, "send_message", { to, text: "hello from bob's agent" })).text).toMatch(/^Sent to alice\//);
    await until("line 138", () => agentTurns(alice.d, a).find((e) => (e.payload as { text?: string }).text === "hello from bob's agent"), 10_000);

    // Bob is handed the team's chat, and a post crosses
    await until("line 141", async () => (await groupsOf(bob)).some((g) => g.id === made.chat && g.teamChat === true && g.team === made.id), 15_000);
    await bob.ui.request<{ post: GroupPost }>("group.post", { group: made.chat, text: "hi team" });
    await until("line 143", async () => (await alice.ui.request<{ posts: GroupPost[] }>("group.posts", { group: made.chat })).posts.some((p) => p.text === "hi team"), 10_000);

    // Bob made an admin invites Carol: she links with Alice too, though Alice made her nothing
    await alice.ui.request("teams.role", { team: made.id, user: "bob", role: "admin" });
    await until("line 147", async () => (await teamsOf(bob))[0]?.role === "admin", 10_000);
    await bringIn(bob, made.id, carol);
    await until("line 149", async () => (await teamsOf(carol))[0]?.members.filter((m) => m.linked).length === 2, 15_000);
    await until("line 150", async () => (await teamsOf(alice))[0]?.members.find((m) => m.user === "carol")?.linked === true, 15_000);
    const carolSees = await until("line 151", async () => {
      const r = await callAs(carol.d, c, "list_agents", {});
      return /^- alice\//m.test(r.text) && /^- bob\//m.test(r.text) ? r : undefined;
    }, 15_000);
    expect(carolSees.text).toMatch(/^- alice\//m);
    // and has the chat, with everyone in it
    await until("line 157", async () => {
      const g = (await groupsOf(carol)).find((x) => x.id === made.chat);
      return g !== undefined && ["alice", "bob", "carol"].every((u) => g.members.some((m) => m.kind === "person" && m.user === u));
    }, 15_000);

    // a change the server made up, signed with a key of its own as Alice: every side refuses it
    const t = fake.teams.get(made.id)!;
    const last = t.entries[t.entries.length - 1]!;
    const evil = await makeTeamKeys();
    const forged = await signTeamEntry({ team: made.id, seq: last.seq + 1, prev: await teamEntryHash(last), by: "usr_alice", at: Date.now(), change: { kind: "update", name: "Taken" } }, evil.signPriv);
    t.entries.push(forged);
    for (const who of ["usr_alice", "usr_bob", "usr_carol"]) (fake as unknown as { pushTo(s: string, m: string, p: unknown): void }).pushTo(who, "teams.changed", { team: made.id, seq: forged.seq });
    await until("line 169", async () => (await teamsOf(bob))[0]?.warning?.includes("does not check") === true, 10_000);
    expect((await teamsOf(bob))[0]?.name).toBe("Studio");
    t.entries.pop();

    // Carol taken out: her links and the chat go, and the others drop her
    await alice.ui.request("teams.remove", { team: made.id, user: "carol" });
    await until("line 175", async () => (await teamsOf(carol)).length === 0, 15_000);
    await until("line 176", async () => (await teammatesOf(carol)).length === 0, 15_000);
    await until("line 177", async () => !(await teammatesOf(bob)).some((x) => x.user === "carol"), 15_000);
    const carolChat = (await groupsOf(carol)).find((g) => g.id === made.chat);
    expect(carolChat === undefined || carolChat.ended !== undefined).toBe(true);
    await until("line 180", async () => !(await groupsOf(alice)).find((g) => g.id === made.chat)!.members.some((m) => m.kind === "person" && m.user === "carol"), 10_000);
    // Alice and Bob are still linked
    expect((await teamsOf(alice))[0]!.members.map((m) => m.user).sort()).toEqual(["alice", "bob"]);

    // Carol and Alice become teammates again with a code: the team's going ended the old link, never this one
    const again = await carol.ui.request<{ teammate: Teammate; invite: { code: string } }>("teammate.invite", { share: homeShare(carol) });
    const back = await alice.ui.request<{ teammate: Teammate }>("teammate.accept", { code: again.invite.code, share: homeShare(alice) });
    expect(back.teammate.state).toBe("active");
    await alice.d.teams.reconcile(made.id);
    await bob.d.teams.reconcile(made.id);
    await alice.d.teams.syncAll();
    expect((await teammatesOf(alice)).find((x) => x.id === back.teammate.id)?.state).toBe("active");
    expect((await teammatesOf(carol)).some((x) => x.user === "alice" && x.state === "active")).toBe(true);
  }, 120_000);

  test("a teammate pair made with a code becomes a team of two, keeping what each shares and their group", async () => {
    fake = new FakeServer();
    const alice = await user("alice");
    const dave = await user("dave");
    const made = await alice.ui.request<{ teammate: Teammate; invite: { code: string } }>("teammate.invite", { share: homeShare(alice) });
    const kept = await dave.ui.request<{ teammate: Teammate }>("teammate.accept", { code: made.invite.code, share: homeShare(dave) });
    expect(kept.teammate.state).toBe("active");
    await alice.ui.next((n) => n.method === "teammate.state" && (n.params as Teammate).state === "active");
    // a group the two of them are in
    const g = (await alice.ui.request<{ group: Group }>("group.create", { name: "pair", members: [{ teammate: made.teammate.id }] })).group;
    await until("line 195", async () => (await groupsOf(dave)).some((x) => x.id === g.id), 10_000);

    // the move: the side whose account sorts first makes the team, the other takes it at once
    await dave.d.teams.syncAll();
    await alice.d.teams.syncAll();
    await until("line 200", async () => (await teamsOf(dave)).length === 1, 15_000);
    await until("dave made an admin", async () => (await teamsOf(alice))[0]?.members.find((m) => m.user === "dave")?.role === "admin", 10_000);
    const team = (await teamsOf(alice))[0]!;
    expect(team.name).toBe("alice and dave");
    expect(team.members.map((m) => [m.user, m.role]).sort()).toEqual([
      ["alice", "owner"],
      ["dave", "admin"],
    ]);
    // each kept its share, and the link the code made stands
    expect(team.share).toMatchObject({ mode: "include", open: "always" });
    expect((await teamsOf(dave))[0]!.share.folders[0]!.path).toBe(dave.d.home);
    await until("line 210", async () => (await teammatesOf(dave))[0]?.teams?.includes(team.id) === true, 10_000);
    // both apps are told, so the pair leaves the Teams page's Teammates
    for (const side of [alice, dave]) await side.ui.next((n) => n.method === "teammate.state" && ((n.params as Teammate).teams ?? []).includes(team.id), 10_000);
    expect((await teammatesOf(alice)).map((x) => x.id)).toEqual([made.teammate.id]);
    // the pair's group goes under the team
    await until("line 213", async () => (await groupsOf(alice)).find((x) => x.id === g.id)?.team === team.id, 10_000);
    // a teammate in a team is left through the team, not ended
    await refused(dave.ui.request("teammate.end", { id: kept.teammate.id }), /in a team together/);
  }, 90_000);

  test("against a server older than teams, the app says so", async () => {
    fake = new FakeServer();
    fake.noTeams = true;
    const alice = await user("alice");
    await refused(alice.ui.request("teams.create", { name: "Studio", share: homeShare(alice) }), /Server 0.11.0/);
  }, 30_000);
});
