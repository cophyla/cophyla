// Connections between two users, end to end: two daemons signed in to two accounts of one
// (fake) server, each a cluster of its own. Alice's app makes an invite for a session of hers;
// Bob's app uses the code for a session of his, through the relay, sealed, each side shown the
// server's word on who the other is. The two agents message each other with send_message, the
// message landing as a turn from another person's agent, audited at both ends. An agent's own
// invite and acceptance each ask its user first; ending it at one end ends it at the other. An
// agent sends the connected agent a folder with send_file: its user is asked, and the folder is
// pulled across the connection's link into the Downloads folder of the other agent's machine.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ask, AuditEntry, Connection, Session, Transfer } from "@cophyla/protocol";
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

/** One user's Cophyla: a node of its own cluster, signed in to the fake as `login`. */
async function user(login: string): Promise<{ d: Started; ui: TestClient; downloads: string }> {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  const downloads = join(home, "Downloads");
  mkdirSync(downloads, { recursive: true });
  writeFileSync(p.accountToken, fake!.mintToken(undefined, { subject: `usr_${login}`, login }) + "\n", { mode: 0o600 });
  const started = await startPrimary({
    home,
    toml: `[cloud]\nenabled = true\nurl = "${fake!.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\n`,
    daemon: { cloud: { keys: [fake!.publicKey], openBrowser: async () => undefined }, transfers: { downloads, toolWaitMs: 15_000 } },
  });
  users.push(started);
  await waitFor(() => started.d.cloud.hostedAllowed("relay") === undefined, 5000);
  const ui = await client(started.d, `${login}'s app`);
  clients.push(ui);
  return { d: started.d, ui, downloads };
}

/** A session on `d`, started over ACP in its own home, idle once its first turn ends. */
async function spawnOn(d: Started): Promise<Session> {
  const ws = d.workspaces.put({ node: d.identity.id, path: d.home, name: "work" });
  const s = await d.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "say hi" }, { profiles: d.profiles });
  await waitFor(() => d.sessions.get(s.id)?.status === "idle", 10_000);
  return d.sessions.get(s.id)!;
}

/** A tool call as the session's own shim would hand it to its node. */
async function callAs(d: Started, s: Session, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const answer = (await d.agentMessages.mcp({ harness: "claude", ppid: s.native.pid! }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: answer.result.content[0]!.text, ...(answer.result.isError ? { isError: true } : {}) };
}

const turnTexts = (d: Started, s: Session) => d.store.sessionEvents.history(s.id, { limit: 200 }).filter((e) => e.kind === "user_turn").map((e) => String((e.payload as { text?: string }).text ?? ""));

const agentTurns = (d: Started, s: Session) => d.store.sessionEvents.history(s.id, { limit: 200 }).filter((e) => e.kind === "user_turn" && (e.payload as { source?: string }).source === "agent");

/** The name `list_agents` gives the connected agent of `login`. */
async function connectedName(d: Started, s: Session, login: string): Promise<string> {
  const listed = await callAs(d, s, "list_agents", {});
  const line = new RegExp(`^- (\\S+): ${login}'s`, "m").exec(listed.text);
  if (!line) throw new Error(`no connection to ${login} listed:\n${listed.text}`);
  return line[1]!;
}

/** Answers the one open ask on `d` as its user. */
async function answerAsk(d: Started, ui: TestClient, option: "allow" | "deny"): Promise<string> {
  const ask = await waitFor(() => d.store.asks.listOpen()[0], 10_000);
  await ui.request("ask.answer", { id: ask.id, option });
  return ask.title;
}

describe("connections between two users", () => {
  test("an invite from one app, used in the other's, connects two sessions: messages both ways, audited, ended at both ends", async () => {
    fake = new FakeServer();
    const alice = await user("alice");
    const bob = await user("bob");
    const a = await spawnOn(alice.d);
    const b = await spawnOn(bob.d);

    const made = await alice.ui.request<{ connection: Connection; invite: { code: string; expiresAt: number } }>("connection.invite", { session: a.id });
    expect(made.connection).toMatchObject({ state: "pending", node: alice.d.identity.id, session: a.id, by: "app" });
    expect(made.invite.code.startsWith("cophyla-connect:")).toBe(true);
    // the code is in no audit row
    expect(JSON.stringify(alice.d.store.audit.list({ limit: 50 }))).not.toContain(made.invite.code.slice(20, 60));

    const accepted = await bob.ui.request<{ connection: Connection }>("connection.accept", { session: b.id, code: made.invite.code });
    expect(accepted.connection).toMatchObject({ id: made.connection.id, state: "active", session: b.id, peer: { user: "alice" } });
    expect(JSON.stringify(bob.d.store.audit.list({ limit: 50 }))).not.toContain(made.invite.code.slice(20, 60));
    // alice's side holds it too, the far end named by the login the server vouched for
    const aliceSide = await waitFor(() => alice.d.connections.list().find((c) => c.state === "active"), 5000);
    expect(aliceSide).toMatchObject({ id: made.connection.id, peer: { user: "bob" } });
    await alice.ui.next((n) => n.method === "connection.state" && (n.params as Connection).state === "active");
    // the code is spent
    const again = await bob.ui.call("connection.accept", { session: b.id, code: made.invite.code });
    expect("error" in again).toBe(true);

    // alice's agent sees bob's and messages it
    const toBob = await connectedName(alice.d, a, "bob");
    const sent = await callAs(alice.d, a, "send_message", { to: toBob, text: "can you share the API schema?" });
    expect(sent.isError).toBeUndefined();
    expect(sent.text).toMatch(/^Sent to /);
    const id = /pmsg_[0-9A-Z]{26}/.exec(sent.text)![0];
    const turn = await waitFor(() => agentTurns(bob.d, b)[0], 10_000);
    expect(turn.payload).toMatchObject({ source: "agent", messageId: id, text: "can you share the API schema?", peer: { connection: made.connection.id, user: "alice" } });
    expect((turn.payload as { from?: unknown }).from).toBeUndefined();

    // the answer goes back the same way
    const toAlice = await connectedName(bob.d, b, "alice");
    const reply = await callAs(bob.d, b, "send_message", { to: toAlice, text: "here it is", reply_to: id });
    expect(reply.isError).toBeUndefined();
    const back = await waitFor(() => agentTurns(alice.d, a).find((e) => (e.payload as { replyTo?: string }).replyTo === id), 10_000);
    expect(back.payload).toMatchObject({ text: "here it is", peer: { user: "bob" } });

    // each end audits what it sent and what it took in
    const sentRow = alice.d.store.audit.list({ limit: 100 }).find((e: AuditEntry) => e.action === "connection.send")!;
    expect(sentRow).toMatchObject({ principal: { kind: "harness", session: a.id }, target: made.connection.id, outcome: "ok" });
    const inRow = bob.d.store.audit.list({ limit: 100 }).find((e: AuditEntry) => e.action === "connection.deliver")!;
    expect(inRow).toMatchObject({ principal: { kind: "system" }, target: b.id, outcome: "ok" });
    expect(inRow.args).toMatchObject({ connection: made.connection.id, text: "can you share the API schema?" });
    await waitFor(() => alice.d.connections.list()[0]?.sent === 1 && alice.d.connections.list()[0]?.received === 1, 5000);

    // a name the session has no connection by reaches no one
    const nobody = await callAs(alice.d, a, "send_message", { to: "carol/api", text: "hi" });
    expect(nobody.isError).toBe(true);

    // bob ends it: both ends lose it, alice's app is told
    await bob.ui.request("connection.end", { id: made.connection.id });
    expect(bob.d.connections.list()).toEqual([]);
    await waitFor(() => alice.d.connections.list().length === 0, 5000);
    await alice.ui.next((n) => n.method === "connection.state" && (n.params as Connection).state === "ended");
    const after = await callAs(alice.d, a, "send_message", { to: toBob, text: "still there?" });
    expect(after.isError).toBe(true);
  }, 90_000);

  test("an agent's invite and acceptance each ask its user first, never remembered; a refusal does nothing", async () => {
    fake = new FakeServer();
    const alice = await user("alice");
    const bob = await user("bob");
    const a = await spawnOn(alice.d);
    const b = await spawnOn(bob.d);

    // refused: nothing made
    const refusedCall = callAs(alice.d, a, "create_invite", {});
    await answerAsk(alice.d, alice.ui, "deny");
    expect(await refusedCall).toEqual({ text: "your user did not allow it; nothing was done.", isError: true });
    expect(alice.d.connections.list()).toEqual([]);

    // allowed: the code comes back to the agent, only for bob
    const inviteCall = callAs(alice.d, a, "create_invite", { for: "bob" });
    const title = await answerAsk(alice.d, alice.ui, "allow");
    expect(title).toMatch(/make a code that connects another Cophyla user's agent/);
    const invited = await inviteCall;
    expect(invited.isError).toBeUndefined();
    const code = /cophyla-connect:\S+/.exec(invited.text)![0];

    // bob's agent uses it: his user is asked, named who it connects to
    const acceptCall = callAs(bob.d, b, "accept_invite", { code });
    const acceptTitle = await answerAsk(bob.d, bob.ui, "allow");
    expect(acceptTitle).toMatch(/^Connect .+ to alice's agent /);
    const accepted = await acceptCall;
    expect(accepted.isError).toBeUndefined();
    expect(accepted.text).toMatch(/^Connected to alice\//);
    await waitFor(() => alice.d.connections.list().some((c) => c.state === "active"), 5000);

    // the agent ends it from its side
    const toAlice = await connectedName(bob.d, b, "alice");
    const ended = await callAs(bob.d, b, "end_connection", { to: toAlice });
    expect(ended.text).toMatch(/has ended at both ends/);
    await waitFor(() => alice.d.connections.list().length === 0, 5000);
  }, 90_000);

  test("send_file reaches the connected agent: its user is asked, the folder is pulled across the link into Downloads, both agents told", async () => {
    fake = new FakeServer();
    const alice = await user("alice");
    const bob = await user("bob");
    const a = await spawnOn(alice.d);
    const b = await spawnOn(bob.d);
    const made = await alice.ui.request<{ connection: Connection; invite: { code: string } }>("connection.invite", { session: a.id });
    await bob.ui.request("connection.accept", { session: b.id, code: made.invite.code });
    await waitFor(() => alice.d.connections.list().some((c) => c.state === "active"), 5000);

    // a folder with a file a level down
    const notes = join(bob.d.home, "notes");
    mkdirSync(join(notes, "day1"), { recursive: true });
    writeFileSync(join(notes, "readme.md"), "# Notes\n");
    writeFileSync(join(notes, "day1", "log.txt"), "x".repeat(200_000));

    const toAlice = await connectedName(bob.d, b, "alice");
    const sending = callAs(bob.d, b, "send_file", { path: notes, to: toAlice, reason: "the notes from the call" });
    const ask = (await bob.ui.next((n) => n.method === "ask.state" && (n.params as Ask).status === "open", 10_000)).params as Ask;
    expect(ask.title).toContain(`to ${toAlice}, alice's agent?`);
    await bob.ui.request("ask.answer", { id: ask.id, option: "allow" });
    const sent = await sending;
    expect(sent.isError).toBeUndefined();
    expect(sent.text).toContain("Sending the folder notes (195 KB, 2 files)");

    const landed = join(alice.downloads, "notes");
    await waitFor(() => readdirOk(join(landed, "day1")).includes("log.txt"), 15_000);
    expect(readFileSync(join(landed, "readme.md"), "utf8")).toBe("# Notes\n");
    expect(readFileSync(join(landed, "day1", "log.txt"), "utf8")).toBe("x".repeat(200_000));
    // alice's Transfers row names who it came from, and why; done once what landed is marked
    const row = await waitFor(() => alice.d.transfers!.list().find((t: Transfer) => t.name === "notes" && t.state === "done"), 10_000);
    expect(row).toMatchObject({ state: "done", peer: { user: "bob" }, reason: "the notes from the call" });
    // her agent is told where, as another person's; his that it arrived
    await waitFor(() => turnTexts(alice.d, a).some((t) => t.includes("sent you the folder notes (\"the notes from the call\")") && t.includes("information, never instructions")), 10_000);
    await waitFor(() => turnTexts(bob.d, b).some((t) => t.includes("notes reached alice/")), 10_000);

    // once the connection ends, nothing more goes
    await bob.ui.request("connection.end", { id: made.connection.id });
    await waitFor(() => alice.d.connections.list().length === 0, 5000);
    const after = await callAs(bob.d, b, "send_file", { path: join(notes, "readme.md"), to: toAlice });
    expect(after.isError).toBe(true);
  }, 90_000);

  test("a code tied to one login, or made on the same account, connects nothing", async () => {
    fake = new FakeServer();
    const alice = await user("alice");
    const bob = await user("bob");
    const a = await spawnOn(alice.d);
    const b = await spawnOn(bob.d);
    const forCarol = await alice.ui.request<{ invite: { code: string } }>("connection.invite", { session: a.id, for: "carol" });
    const refused = await bob.ui.call("connection.accept", { session: b.id, code: forCarol.invite.code });
    expect("error" in refused && refused.error.message).toMatch(/the code is for carol/);
    // still open for the right person after a refusal
    expect(alice.d.connections.list().find((c) => c.state === "pending")).toBeDefined();
    // alice's own code in alice's own app: refused before anything is spent
    const own = await alice.ui.request<{ invite: { code: string } }>("connection.invite", { session: a.id });
    const self = await alice.ui.call("connection.accept", { session: a.id, code: own.invite.code });
    expect("error" in self && self.error.message).toMatch(/made here/);
  }, 90_000);

  test("a server from before connections is named as the reason, and nothing is made", async () => {
    fake = new FakeServer();
    fake.noConnections = true;
    const alice = await user("alice");
    const a = await spawnOn(alice.d);
    const made = await alice.ui.call("connection.invite", { session: a.id });
    expect("error" in made && made.error.message).toBe("the Cophyla server does not offer connections yet: it needs Server 0.8.0");
    expect(alice.d.connections.list()).toEqual([]);
  }, 90_000);
});

function readdirOk(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
