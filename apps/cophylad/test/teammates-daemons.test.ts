// Teammates and group chats, end to end: two daemons signed in to two accounts of one (fake)
// server, each a cluster of its own. Alice's app makes a teammate's code sharing her home; Bob's
// app uses it sharing his; the relay carries it, sealed, each side shown the server's word on
// who the other is. Their agents list and message each other; Alice's app makes a group chat
// with an agent of each, and a post that tags Bob's agent reaches it on Bob's side as a notice
// from cophyla. An agent takes focus and the apps see it; the app ends it. Ending the teammate
// at one side ends it at the other.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Group, GroupCandidate, GroupPost, Session, Teammate } from "@cophyla/protocol";
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

async function user(login: string): Promise<{ d: Started; ui: TestClient }> {
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
  return { d: started.d, ui };
}

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

describe("teammates between two users", () => {
  test("a code from one app, used in the other's: agents list and message each other, a group chat crosses over, focus shows, an end ends both", async () => {
    fake = new FakeServer();
    const alice = await user("alice");
    const bob = await user("bob");
    const a = await spawnOn(alice.d);
    const b = await spawnOn(bob.d);

    const made = await alice.ui.request<{ teammate: Teammate; invite: { code: string; expiresAt: number } }>("teammate.invite", { share: { mode: "include", folders: [{ node: alice.d.identity.id, path: alice.d.home }], open: "always" } });
    expect(made.teammate).toMatchObject({ state: "pending", share: { mode: "include", open: "always" } });
    expect(made.invite.code.startsWith("cophyla-team:")).toBe(true);
    expect(made.invite.expiresAt - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(JSON.stringify(alice.d.store.audit.list({ limit: 50 }))).not.toContain(made.invite.code.slice(20, 60));

    const kept = await bob.ui.request<{ teammate: Teammate }>("teammate.accept", { code: made.invite.code, share: { mode: "include", folders: [{ node: bob.d.identity.id, path: bob.d.home }], open: "always" } });
    expect(kept.teammate).toMatchObject({ state: "active", user: "alice", theirs: { open: "always" } });
    await alice.ui.next((n) => n.method === "teammate.state" && (n.params as Teammate).state === "active");
    const listedA = await alice.ui.request<{ teammates: Teammate[] }>("teammate.list", {});
    expect(listedA.teammates[0]).toMatchObject({ state: "active", user: "bob" });

    // the agents see each other under the login, and a message lands as another person's agent's
    const seen = await callAs(alice.d, a, "list_agents", {});
    const line = /^- (bob\/\S+): bob's Claude Code/m.exec(seen.text);
    expect(line).not.toBeNull();
    const sent = await callAs(alice.d, a, "send_message", { to: line![1]!, text: "hello from alice's agent" });
    expect(sent.text).toMatch(/^Sent to bob\//);
    const turn = await waitFor(() => agentTurns(bob.d, b).find((e) => (e.payload as { text?: string }).text === "hello from alice's agent"), 10_000);
    expect((turn.payload as { peer?: { user: string; teammate?: string } }).peer).toMatchObject({ user: "alice", teammate: kept.teammate.id });

    // a group chat with an agent of each, made in Alice's app
    const cands = await alice.ui.request<{ agents: GroupCandidate[] }>("group.candidates", {});
    const bobs = cands.agents.find((c) => c.user === "bob")!;
    expect(bobs).toBeDefined();
    const made2 = await alice.ui.request<{ group: Group }>("group.create", { name: "release", purpose: "Ship it", members: [{ session: a.id }, bobs.ref] });
    expect(made2.group.members.map((m) => (m.kind === "person" ? m.user : m.handle))).toContain("alice");
    await waitFor(async () => (await bob.ui.request<{ groups: Group[] }>("group.list", {})).groups.length === 1, 10_000);
    // Alice tags Bob's agent from her app: told on Bob's side, as a notice from cophyla
    const handle = made2.group.members.find((m) => m.kind === "agent" && m.user === "bob")!;
    const posted = await alice.ui.request<{ post: GroupPost }>("group.post", { group: made2.group.id, text: `@${handle.kind === "agent" ? handle.handle : ""} please check the build` });
    expect(posted.post.mentions).toHaveLength(1);
    const notice = await waitFor(() => agentTurns(bob.d, b).find((e) => ((e.payload as { text?: string }).text ?? "").includes("tagged you in #release")), 10_000);
    expect((notice.payload as { group?: { name: string } }).group?.name).toBe("release");
    const bobPost = await bob.ui.next((n) => n.method === "group.posted", 10_000);
    expect((bobPost.params as { post: GroupPost }).post.text).toContain("please check the build");

    // focus: the agent takes it, the apps see it, the app ends it
    const focus = await callAs(alice.d, a, "focus", { minutes: 60, reason: "deep work" });
    expect(focus.text).toContain("You are in focus until");
    const listed = await alice.ui.request<{ focus: { session: string }[] }>("focus.list", {});
    expect(listed.focus.map((f) => f.session)).toEqual([a.id]);
    await alice.ui.request("focus.end", { session: a.id });
    expect((await alice.ui.request<{ focus: unknown[] }>("focus.list", {})).focus).toEqual([]);

    // an end at one side ends it at the other
    await bob.ui.request("teammate.end", { id: kept.teammate.id });
    await waitFor(async () => (await alice.ui.request<{ teammates: Teammate[] }>("teammate.list", {})).teammates.length === 0, 10_000);
  }, 60_000);
});
