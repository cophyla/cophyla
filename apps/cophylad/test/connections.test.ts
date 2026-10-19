// The connections module as a unit: two users' primaries, each a `Connections` over a store,
// a gate and asks of its own, joined by an in-memory relay that hands a dial to the far end's
// `acceptTunnel` and refuses a key that does not match, as a sealed tunnel would. Covered:
// the invite and its redemption, who the server vouched for, the code's one use and its
// login, a redemption that stops short; messages both ways with nothing to address another
// terminal; the life of a terminal (an agent started again in it, a terminal that closes,
// told by its node or missed twice); what waits while the far end sleeps or no agent runs;
// the ask before a session that runs without prompts; the limits; an end at either side;
// and the envelope.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { newId, RpcError } from "@cophyla/protocol";
import type { ConnectionRelay, Session, Terminal } from "@cophyla/protocol";
import type { Psk } from "@cophyla/relay";
import { envelope, readEnvelope } from "../src/agentmsg/envelope.ts";
import type { EnvelopeInfo } from "../src/agentmsg/envelope.ts";
import type { NodeSocket, NodeSocketHandler } from "../src/api/server.ts";
import { Bus } from "../src/bus.ts";
import { verifyIdentity } from "../src/cloud/identity.ts";
import { Config } from "../src/config/schema.ts";
import { Connections, QUEUE_MAX } from "../src/connections/index.ts";
import type { ConnectionCloud } from "../src/connections/index.ts";
import { Asks } from "../src/gate/asks.ts";
import { Audit } from "../src/gate/audit.ts";
import { Gate } from "../src/gate/index.ts";
import { Policy } from "../src/gate/policy.ts";
import { silentLogger } from "../src/log.ts";
import type { LinkSocket } from "../src/nodes/outbound.ts";
import { Store } from "../src/store/index.ts";
import { waitFor } from "./helpers.ts";

const SERVER = "https://orc.test";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEYS = [{ kid: "test-1", key: publicKey.export({ type: "spki", format: "der" }).toString("base64") }];
const b64url = (s: string | Buffer) => (typeof s === "string" ? Buffer.from(s, "utf8") : s).toString("base64url");

/** The server's word, as `identity.attest` signs it. */
function attest(sub: string, login: string, aud: string, now: number): string {
  const h = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "test-1" }));
  const p = b64url(JSON.stringify({ typ: "cophyla-identity", sub, login, aud, iat: now, exp: now + 600_000 }));
  return `${h}.${p}.${b64url(sign(null, Buffer.from(`${h}.${p}`), privateKey))}`;
}

/** The relay between the two: tokens by peer, who minted each, and which sides are reached now. */
class Relay {
  readonly tokens = new Map<string, { side: Side; peer: string; revoked: boolean }>();
  /** The tunnels open to each side: a side that goes to sleep takes its tunnels down with it. */
  private open = new Set<{ side: Side; sock: LinkSocket }>();
  dials = 0;
  sleep(side: Side): void {
    side.online = false;
    for (const t of [...this.open]) {
      if (t.side !== side) continue;
      this.open.delete(t);
      t.sock.close(4409, "node link closed");
    }
  }
  wake(side: Side): void {
    side.online = true;
  }
  grant(side: Side, peer: string): { url: string; token: string } {
    const token = `rly_${peer}`;
    this.tokens.set(token, { side, peer, revoked: false });
    return { url: SERVER, token };
  }
  revoke(peer: string): void {
    for (const t of this.tokens.values()) if (t.peer === peer) t.revoked = true;
  }
  async dial(relay: ConnectionRelay, psk: Psk): Promise<LinkSocket> {
    this.dials++;
    const t = this.tokens.get(relay.token);
    if (!t || t.revoked) throw new RpcError("denied", "the relay token is unknown or revoked");
    if (t.peer !== relay.peer) throw new RpcError("denied", "auth: another peer");
    if (!t.side.online) throw new RpcError("unavailable", "that Cophyla is not linked to the server");
    const far = t.side.c.acceptTunnel(relay.peer);
    if (!far) throw new RpcError("denied", "no such connection on this node");
    if (Buffer.compare(Buffer.from(far.psk), Buffer.from(psk)) !== 0) throw new RpcError("unavailable", "the tunnel closed (4403 a record failed to open)");
    const sock = pipe(far.accept);
    const entry = { side: t.side, sock };
    this.open.add(entry);
    sock.onClose(() => this.open.delete(entry));
    return sock;
  }
}

/** A tunnel in memory: the dialing end's socket, the far end's handler. */
function pipe(accept: (sock: NodeSocket) => NodeSocketHandler): LinkSocket {
  const listeners: ((t: string) => void)[] = [];
  const closers: ((code: number, reason: string) => void)[] = [];
  let open = true;
  const shut = (code: number, reason: string) => {
    if (!open) return;
    open = false;
    handler.close(code, reason);
    for (const fn of closers.splice(0)) fn(code, reason);
  };
  const handler = accept({ send: (text) => open && queueMicrotask(() => listeners.forEach((fn) => fn(text))), close: (code, reason) => shut(code, reason), remote: "test" });
  return {
    send: (text) => {
      if (!open) return false;
      queueMicrotask(() => open && handler.message(text));
      return true;
    },
    close: (code = 1000, reason = "closed") => shut(code, reason),
    onMessage: (fn) => listeners.push(fn),
    onClose: (fn) => closers.push(fn),
  };
}

interface Side {
  c: Connections;
  node: string;
  login: string;
  online: boolean;
  store: Store;
  asks: Asks;
  bus: Bus;
  sessions: Session[];
  terminals: Terminal[];
  bypass: Set<string>;
  delivered: { session: string; text: string; info: EnvelopeInfo }[];
  now: { t: number };
}

let started = 1_000;
function sess(node: string, cwd: string, extra: Partial<Session> = {}): Session {
  return { id: newId("session"), node, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: crypto.randomUUID(), transport: "pipe" }, origin: "user", cwd, tags: [], status: "idle", startedAt: started++, lastActivity: 0, ...extra };
}

function term(node: string, id: string): Terminal {
  return { id, node, host: "h1", argv0: "claude", cwd: "/w", cols: 80, rows: 24, status: "running", windows: 1, startedAt: 0 };
}

function side(relay: Relay, login: string, clock: { t: number }): Side {
  const node = newId("node");
  const config = Config.parse({});
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, node, bus);
  const audit = new Audit(store, node, config.gate.audit_result_cap, bus);
  const gate = new Gate({ config: config.gate, policy: new Policy(config.gate, store), asks, audit, log: silentLogger });
  const s = { node, login, online: true, store, asks, bus, sessions: [] as Session[], terminals: [] as Terminal[], bypass: new Set<string>(), delivered: [] as Side["delivered"], now: clock } as Side;
  const cloud: ConnectionCloud = {
    allowed: () => undefined,
    subject: () => `usr_${login}`,
    serverUrl: () => SERVER,
    relayGrant: async (peer) => relay.grant(s, peer),
    revokeRelay: async (peer) => (relay.revoke(peer), true),
    attest: async (aud) => attest(`usr_${login}`, login, aud, clock.t),
    verifyIdentity: (token, aud) => verifyIdentity(token, KEYS, aud, clock.t),
  };
  s.c = new Connections({
    store,
    bus,
    log: silentLogger,
    gate,
    asks,
    self: () => ({ id: node, name: `${login}'s desk` }),
    routes: () => true,
    cloud,
    sessions: () => s.sessions,
    bypasses: (x) => s.bypass.has(x.id),
    deliver: async (x, text, info) => {
      if (x.status === "ended") throw new RpcError("not_found", "that session has ended; not sent");
      s.delivered.push({ session: x.id, text, info });
      return { status: "queued" };
    },
    linked: () => true,
    terminals: (n) => (n === node ? s.terminals : undefined),
    nodeName: () => `${login}'s desk`,
    dial: (r, psk) => relay.dial(r, psk),
    now: () => clock.t,
    sweepMs: 3_600_000,
  });
  s.c.start();
  return s;
}

/** Alice and Bob, each with an agent in a terminal, connected through Alice's invite. */
async function connected(): Promise<{ relay: Relay; alice: Side; bob: Side; a: Session; b: Session; id: string }> {
  const clock = { t: Date.now() };
  const relay = new Relay();
  const alice = side(relay, "alice", clock);
  const bob = side(relay, "bob", clock);
  alice.terminals.push(term(alice.node, "t-a"));
  bob.terminals.push(term(bob.node, "t-b"));
  const a = sess(alice.node, "/work/web", { name: "web", native: { id: "n-a", transport: "pipe", terminal: { host: "h1", id: "t-a" } } });
  const b = sess(bob.node, "/src/api", { harness: "codex", native: { id: "n-b", transport: "app-server", terminal: { host: "h1", id: "t-b" } } });
  alice.sessions.push(a);
  bob.sessions.push(b);
  const made = await alice.c.invite({ session: a.id }, "app");
  const kept = await bob.c.accept({ session: b.id, code: made.code }, "app");
  await waitFor(() => alice.c.list()[0]?.state === "active");
  return { relay, alice, bob, a, b, id: kept.id };
}

describe("making a connection", () => {
  test("an invite, used once: both ends keep it, each naming the other by the login the server vouched for", async () => {
    const { alice, bob, a, b, id } = await connected();
    expect(alice.c.list()).toEqual([expect.objectContaining({ id, state: "active", node: alice.node, terminal: { host: "h1", id: "t-a" }, session: a.id, name: "web", peer: expect.objectContaining({ user: "bob", name: "api-codex", harness: "codex", live: true }), by: "app" })]);
    expect(bob.c.list()).toEqual([expect.objectContaining({ id, state: "active", session: b.id, name: "api-codex", peer: expect.objectContaining({ user: "alice", name: "web", harness: "claude" }) })]);
    // the client rows carry no key, token, secret or queued text
    expect(JSON.stringify(alice.c.list())).not.toMatch(/rly_|key|secret/);
  });

  test("a code works once, runs out, and is for its login alone; a redemption that stops short leaves it open", async () => {
    const clock = { t: Date.now() };
    const relay = new Relay();
    const alice = side(relay, "alice", clock);
    const bob = side(relay, "bob", clock);
    const carol = side(relay, "carol", clock);
    const a = sess(alice.node, "/w");
    const b = sess(bob.node, "/x");
    const c = sess(carol.node, "/y");
    alice.sessions.push(a);
    bob.sessions.push(b);
    carol.sessions.push(c);

    const forBob = await alice.c.invite({ session: a.id, for: "Bob" }, "app");
    await expect(carol.c.accept({ session: c.id, code: forBob.code }, "app")).rejects.toThrow(/the code is for Bob/);
    // carol's refusal spent nothing: bob still can
    // a redemption whose user says no on bob's side leaves it open too
    await expect(bob.c.accept({ session: b.id, code: forBob.code }, "agent", async () => Promise.reject(new RpcError("denied", "your user did not allow it")))).rejects.toThrow(/did not allow/);
    await waitFor(() => alice.c.list()[0]?.state === "pending");
    await bob.c.accept({ session: b.id, code: forBob.code }, "app");
    // and once used, it is gone
    await expect(carol.c.accept({ session: c.id, code: forBob.code }, "app")).rejects.toThrow(/used already|cancelled/);

    // a code past its fifteen minutes
    const late = await alice.c.invite({ session: a.id }, "app");
    clock.t += 16 * 60_000;
    await expect(bob.c.accept({ session: b.id, code: late.code }, "app")).rejects.toThrow(/run out/);
    // and the sweep lets its row go
    await alice.c.sweep();
    expect(alice.c.list().filter((x) => x.state === "pending")).toEqual([]);
  });

  test("not across one account, not into the chat's own session, not with another server's code", async () => {
    const clock = { t: Date.now() };
    const relay = new Relay();
    const alice = side(relay, "alice", clock);
    const alice2 = side(relay, "alice", clock);
    const a = sess(alice.node, "/w");
    const a2 = sess(alice2.node, "/w2");
    const chat = sess(alice2.node, "/w3", { role: "assistant" });
    alice.sessions.push(a);
    alice2.sessions.push(a2, chat);
    const made = await alice.c.invite({ session: a.id }, "app");
    await expect(alice2.c.accept({ session: a2.id, code: made.code }, "app")).rejects.toThrow(/same account/);
    await expect(alice2.c.accept({ session: chat.id, code: made.code }, "app")).rejects.toThrow(/chat's own session/);
    const body = JSON.parse(Buffer.from(made.code.slice("cophyla-connect:".length), "base64url").toString());
    const elsewhere = "cophyla-connect:" + Buffer.from(JSON.stringify({ ...body, relay: { ...body.relay, url: "https://evil.test" } })).toString("base64url");
    await expect(alice2.c.accept({ session: a2.id, code: elsewhere }, "app")).rejects.toThrow(/another Cophyla server/);
  });
});

describe("messages", () => {
  test("both ways, into the connection's own terminal alone, in an envelope that names the other person", async () => {
    const { alice, bob, a, b, id } = await connected();
    const sent = await alice.c.send(a, { to: "bob/api-codex", text: "what does /v2/users return?" });
    expect(sent).toMatchObject({ status: "sent", connection: id, alias: "bob/api-codex" });
    await waitFor(() => bob.delivered.length === 1);
    expect(bob.delivered[0]).toMatchObject({ session: b.id, text: "what does /v2/users return?", info: { peer: { connection: id, user: "alice", name: "web", harness: "claude" }, messageId: sent.id } });
    const wrapped = envelope(bob.delivered[0]!.info, "x");
    expect(wrapped).toBe(`<cophyla-message from="alice/web" harness="claude" user="alice" connection="${id}" external="true" id="${sent.id}">\nx\n</cophyla-message>`);
    expect(readEnvelope(wrapped)).toMatchObject({ from: { alias: "alice/web" }, peer: { connection: id, user: "alice" }, messageId: sent.id });

    // the answer, by the login alone since bob has one connection to alice
    const reply = await bob.c.send(b, { to: "alice", text: "a list of users", replyTo: sent.id });
    expect(reply.status).toBe("sent");
    await waitFor(() => alice.delivered.length === 1);
    expect(alice.delivered[0]!.info).toMatchObject({ replyTo: sent.id, peer: { user: "bob" } });
    expect(alice.c.list()[0]).toMatchObject({ sent: 1, received: 1 });

    // another session of alice's is no end of the connection
    const other = sess(alice.node, "/elsewhere");
    alice.sessions.push(other);
    expect(alice.c.listing(other)).toEqual([]);
    await expect(alice.c.send(other, { to: "bob/api-codex", text: "hi" })).rejects.toThrow(/no connection called/);
    // and a listing for the end itself
    expect(alice.c.listing(a)).toEqual([expect.objectContaining({ connection: id, alias: "bob/api-codex", user: "bob", harness: "codex", live: true })]);
  });

  test("a message sent again after a lost answer is delivered once", async () => {
    const { alice, bob, a } = await connected();
    const sent = await alice.c.send(a, { to: "bob", text: "once" });
    await waitFor(() => bob.delivered.length === 1);
    const tunnel = await (alice.c as unknown as { rpcFor(r: unknown): Promise<{ request(m: string, p: unknown): Promise<unknown> }> }).rpcFor((alice.c as unknown as { rows: { list(): unknown[] } }).rows.list()[0]);
    expect(await tunnel.request("conn.send", { id: sent.id, text: "once", from: { name: "web", live: true }, sentAt: Date.now() })).toEqual({ status: "sent" });
    expect(bob.delivered.length).toBe(1);
  });

  test("the limits: a few a minute, the same text twice, and a conversation that goes on too long", async () => {
    const { alice, bob, a, b } = await connected();
    for (let i = 0; i < 6; i++) await alice.c.send(a, { to: "bob", text: `note ${i}` });
    await expect(alice.c.send(a, { to: "bob", text: "one more" })).rejects.toThrow(/in the last minute/);
    alice.now.t += 61_000;
    await alice.c.send(a, { to: "bob", text: "again" });
    await expect(alice.c.send(a, { to: "bob", text: "again" })).rejects.toThrow(/this same message/);
    // back and forth: the eighth hop is the last
    alice.now.t += 61_000;
    let last = (await alice.c.send(a, { to: "bob", text: "hop 1" })).id;
    for (let hop = 2; hop <= 8; hop++) {
      alice.now.t += 11_000;
      const [from, fromSide, to] = hop % 2 === 0 ? [b, bob, "alice"] : [a, alice, "bob"];
      last = (await fromSide.c.send(from, { to, text: `hop ${hop}`, replyTo: last })).id;
    }
    alice.now.t += 11_000;
    await expect(alice.c.send(a, { to: "bob", text: "hop 9", replyTo: last })).rejects.toThrow(/back and forth/);
  });
});

describe("the terminal's life", () => {
  test("another agent started in the terminal is the end now, and the far end is told", async () => {
    const { alice, bob, b, id } = await connected();
    // the codex session in bob's terminal ends; a claude one starts there
    b.status = "ended";
    bob.bus.emit("session.state", b);
    const b2 = sess(bob.node, "/src/api", { name: "api-claude", native: { id: "n-b2", transport: "pipe", terminal: { host: "h1", id: "t-b" } } });
    bob.sessions.push(b2);
    bob.bus.emit("session.state", b2);
    await waitFor(() => alice.c.list()[0]?.peer?.name === "api-claude", 5_000);
    expect(alice.c.list()[0]!.peer).toMatchObject({ harness: "claude", live: true });
    expect(bob.c.list()[0]).toMatchObject({ id, session: b2.id, name: "api-claude" });
    // the message reaches the agent there now
    const a = alice.sessions[0]!;
    await alice.c.send(a, { to: "bob", text: "who is there now?" });
    await waitFor(() => bob.delivered.some((d) => d.session === b2.id));
  });

  test("no agent in the terminal: the message waits there, and goes in when one starts", async () => {
    const { alice, bob, a, b } = await connected();
    b.status = "ended";
    const sent = await alice.c.send(a, { to: "bob", text: "for whoever comes" });
    expect(sent.status).toBe("waiting");
    expect(bob.c.list()[0]!.queued).toBe(1);
    const b2 = sess(bob.node, "/src/api", { native: { id: "n-b3", transport: "pipe", terminal: { host: "h1", id: "t-b" } } });
    bob.sessions.push(b2);
    bob.bus.emit("session.state", b2);
    await waitFor(() => bob.delivered.length === 1 && bob.c.list()[0]!.queued === undefined);
    expect(bob.delivered[0]).toMatchObject({ session: b2.id, text: "for whoever comes" });
  });

  test("the terminal closing, told by its node, ends the connection at both ends", async () => {
    const { alice, bob, id } = await connected();
    bob.bus.emit("terminal.state", { ...bob.terminals[0]!, status: "exited" });
    await waitFor(() => bob.c.list().length === 0 && alice.c.list().length === 0);
    // the far end's relay peer is let go
    void id;
  });

  test("a terminal missed twice while its node is reached ends it; missed once, or its node not known, nothing", async () => {
    const { alice, bob } = await connected();
    bob.terminals.length = 0;
    await bob.c.sweep();
    expect(bob.c.list().length).toBe(1);
    // the terminal is back: the count starts over
    bob.terminals.push(term(bob.node, "t-b"));
    await bob.c.sweep();
    bob.terminals.length = 0;
    await bob.c.sweep();
    expect(bob.c.list().length).toBe(1);
    await bob.c.sweep();
    await waitFor(() => bob.c.list().length === 0 && alice.c.list().length === 0);
  });
});

describe("a session with no terminal", () => {
  test("its connection ends with it: told by its node, or missed twice when it ended unseen", async () => {
    const clock = { t: Date.now() };
    const relay = new Relay();
    const alice = side(relay, "alice", clock);
    const bob = side(relay, "bob", clock);
    const a = sess(alice.node, "/w");
    const b = sess(bob.node, "/x");
    alice.sessions.push(a);
    bob.sessions.push(b);
    const made = await alice.c.invite({ session: a.id }, "app");
    await bob.c.accept({ session: b.id, code: made.code }, "app");
    // told: the session's row says it ended
    b.status = "ended";
    bob.bus.emit("session.state", b);
    await waitFor(() => bob.c.list().length === 0 && alice.c.list().length === 0);

    // unseen: a session gone while nothing was watching, missed on two sweeps
    const a2 = sess(alice.node, "/w2");
    const b2 = sess(bob.node, "/x2");
    alice.sessions.push(a2);
    bob.sessions.push(b2);
    const made2 = await alice.c.invite({ session: a2.id }, "app");
    await bob.c.accept({ session: b2.id, code: made2.code }, "app");
    bob.sessions.splice(bob.sessions.indexOf(b2), 1);
    await bob.c.sweep();
    expect(bob.c.list().length).toBe(1);
    await bob.c.sweep();
    await waitFor(() => bob.c.list().length === 0 && alice.c.list().length === 0);
  });
});

describe("asleep, and the ask", () => {
  test("the far end asleep: what is sent is kept, in order, and goes when it is reached; past a day it comes back undelivered", async () => {
    const { relay, alice, bob, a } = await connected();
    relay.sleep(bob);
    expect((await alice.c.send(a, { to: "bob", text: "first" })).status).toBe("queued");
    expect((await alice.c.send(a, { to: "bob", text: "second" })).status).toBe("queued");
    expect(alice.c.list()[0]!.queued).toBe(2);
    relay.wake(bob);
    alice.c.linkUp();
    await waitFor(() => bob.delivered.length === 2);
    expect(bob.delivered.map((d) => d.text)).toEqual(["first", "second"]);
    expect(alice.c.list()[0]!.queued).toBeUndefined();

    relay.sleep(bob);
    alice.now.t += 61_000;
    const kept = await alice.c.send(a, { to: "bob", text: "into the void" });
    alice.now.t += 25 * 60 * 60_000;
    await alice.c.sweep();
    expect(alice.c.list()[0]!.queued).toBeUndefined();
    await waitFor(() => alice.delivered.some((d) => d.info.replyTo === kept.id));
    expect(alice.delivered.find((d) => d.info.replyTo === kept.id)!.text).toMatch(/was not delivered: their Cophyla could not be reached for a day/);
  });

  test("into a session that runs without prompts the user is asked once; allowed, it stands for the connection", async () => {
    const { alice, bob, a, b } = await connected();
    bob.bypass.add(b.id);
    const sent = await alice.c.send(a, { to: "bob", text: "please run the migration" });
    expect(sent.status).toBe("pending");
    const ask = bob.asks.listOpen()[0]!;
    expect(ask.title).toMatch(/^Let alice's agent web message api-codex, which runs without permission prompts\?/);
    expect(ask.answerableBy).toEqual(["user"]);
    bob.asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    await waitFor(() => bob.delivered.length === 1);
    // the next goes straight in
    expect((await alice.c.send(a, { to: "bob", text: "and the seed" })).status).toBe("sent");
    expect(bob.asks.listOpen()).toEqual([]);
  });

  test("refused, what waited goes back to its sender as not delivered", async () => {
    const { alice, bob, a, b } = await connected();
    bob.bypass.add(b.id);
    const sent = await alice.c.send(a, { to: "bob", text: "rm -rf build" });
    const ask = bob.asks.listOpen()[0]!;
    bob.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    await waitFor(() => alice.delivered.some((d) => d.info.replyTo === sent.id));
    expect(alice.delivered.find((d) => d.info.replyTo === sent.id)!.text).toBe(`Your message ${sent.id} to bob/api-codex was not delivered: the user did not allow it.`);
    expect(bob.delivered).toEqual([]);
  });

  test("a session that ran without prompts when it was connected was the user's choice then: no ask", async () => {
    const clock = { t: Date.now() };
    const relay = new Relay();
    const alice = side(relay, "alice", clock);
    const bob = side(relay, "bob", clock);
    const a = sess(alice.node, "/w");
    const b = sess(bob.node, "/x");
    alice.sessions.push(a);
    bob.sessions.push(b);
    bob.bypass.add(b.id);
    const made = await alice.c.invite({ session: a.id }, "app");
    await bob.c.accept({ session: b.id, code: made.code }, "app");
    expect((await alice.c.send(a, { to: "bob", text: "go" })).status).toBe("sent");
    expect(bob.asks.listOpen()).toEqual([]);
  });

  test(`at most ${QUEUE_MAX} wait for the far end`, async () => {
    const { relay, alice, bob, a } = await connected();
    relay.sleep(bob);
    // spaced out, to keep under the rate
    for (let i = 0; i < QUEUE_MAX; i++) {
      alice.now.t += 11_000;
      expect((await alice.c.send(a, { to: "bob", text: `m${i}` })).status).toBe("queued");
    }
    alice.now.t += 11_000;
    await expect(alice.c.send(a, { to: "bob", text: "overflow" })).rejects.toThrow(/already wait/);
  });
});

describe("ending", () => {
  test("ended at one side, gone at both; the other side's next dial is refused and it lets the connection go", async () => {
    const { relay, alice, bob, a, b, id } = await connected();
    await alice.c.end(id, "ended by the user");
    expect(alice.c.list()).toEqual([]);
    await waitFor(() => bob.c.list().length === 0);
    // an end that never reached the far side: its next send finds the peer revoked
    const again = await connected();
    again.relay.sleep(again.bob);
    await again.alice.c.end(again.id, "ended by the user");
    again.relay.wake(again.bob);
    await expect(again.bob.c.send(again.b, { to: "alice", text: "hello?" })).rejects.toThrow(/ended the connection/);
    expect(again.bob.c.list()).toEqual([]);
    void relay;
    void a;
    void b;
  });

  test("a pending invite cancelled: its code opens nothing", async () => {
    const clock = { t: Date.now() };
    const relay = new Relay();
    const alice = side(relay, "alice", clock);
    const bob = side(relay, "bob", clock);
    const a = sess(alice.node, "/w");
    const b = sess(bob.node, "/x");
    alice.sessions.push(a);
    bob.sessions.push(b);
    const made = await alice.c.invite({ session: a.id }, "app");
    await alice.c.end(made.connection.id, "cancelled");
    await expect(bob.c.accept({ session: b.id, code: made.code }, "app")).rejects.toThrow(/used already, or cancelled/);
  });
});
