// Group chats and focus, the modules alone over a real store, bus and gate, with fake sessions
// on one machine and the agent router in front of them as the agents' tools reach it. Covered:
// reading tags out of a post (members, @agents, @users, @everyone, code left alone, a tag that
// names no one refused); a tag sends one notice, not the post, and no second one until the
// agent reads; read_group's words and read point; a reply tags the writer; an agent told of
// every post gets them gathered once its turn is over; the limits; a thumbs up wakes no one;
// a member whose session ended is gone and told on its return; focus holds messages and a
// group's notices, tells the sender at once, and hands everything over when the turn ends; the
// user's posts, and where the rail puts a group.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { Session } from "@cophyla/protocol";
import type { DeliverOptions, EnvelopeInfo } from "../src/agentmsg/envelope.ts";
import { Focuses } from "../src/agentmsg/focus.ts";
import { AgentMessages } from "../src/agentmsg/index.ts";
import type { AgentSessions } from "../src/agentmsg/index.ts";
import { Bus } from "../src/bus.ts";
import { Config } from "../src/config/schema.ts";
import { Asks } from "../src/gate/asks.ts";
import { Audit } from "../src/gate/audit.ts";
import { Gate } from "../src/gate/index.ts";
import { Policy } from "../src/gate/policy.ts";
import { Groups } from "../src/groups/index.ts";
import { readTags, writeTags } from "../src/groups/text.ts";
import { silentLogger } from "../src/log.ts";
import type { SendOptions } from "../src/sessions/index.ts";
import { Store } from "../src/store/index.ts";
import { waitFor } from "./helpers.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

let started = 1_000;
function sess(harness: Session["harness"], cwd: string, extra: Partial<Session> = {}): Session {
  const native = { id: crypto.randomUUID(), transport: harness === "codex" ? ("app-server" as const) : ("pipe" as const), ...(harness === "claude" ? { pid: 4000 + started } : {}) };
  return { id: newId("session"), node: DESK, harness, profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native, origin: "user", cwd, tags: [], status: "busy", startedAt: started++, lastActivity: 0, ...extra };
}

interface Delivery {
  session: string;
  text: string;
  info: EnvelopeInfo;
  quiet?: boolean;
  /** Handed over with it as one message. */
  more?: DeliverOptions["more"];
}

function rig(local: Session[]) {
  const config = Config.parse({});
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, DESK, bus);
  const audit = new Audit(store, DESK, config.gate.audit_result_cap, bus);
  const policy = new Policy(config.gate, store);
  const gate = new Gate({ config: config.gate, policy, asks, audit, log: silentLogger });
  const delivered: Delivery[] = [];
  const sent: { id: string; text: string; opts: SendOptions }[] = [];
  const pushed: { group: string; from: string; text: string }[] = [];
  const clock = { t: 1_758_000_000_000 };
  const sessions: AgentSessions = {
    list: () => local.filter((s) => s.status !== "ended"),
    get: (id) => local.find((s) => s.id === id),
    send: async (id, text, o) => {
      sent.push({ id, text, opts: o });
      return { status: "queued" };
    },
    codexThread: (id) => local.find((s) => s.native.id === id),
    claudeSession: (id) => local.find((s) => s.native.id === id),
    byPipe: () => undefined,
    byPid: (pid) => local.find((s) => s.native.pid === pid),
    byNonce: () => undefined,
    byTerminal: () => undefined,
    bypasses: () => false,
    acceptsInbound: () => false,
  };
  let groups: Groups;
  const deliver = async (s: Session, text: string, info: EnvelopeInfo, opts?: DeliverOptions) => {
    delivered.push({ session: s.id, text, info, ...(opts?.quiet ? { quiet: true } : {}), ...(opts?.more ? { more: opts.more } : {}) });
    return { status: "queued" as const };
  };
  const focus = new Focuses({ store, bus, log: silentLogger, routes: () => true, sessions: () => local, deliver, linked: () => true, ended: (s, told) => groups.focusEnded(s, told), now: () => clock.t, sweepMs: 60_000 });
  const router: AgentMessages = new AgentMessages({
    config: () => config.agent_messages,
    self: () => ({ id: DESK, name: "Desk" }),
    sessions,
    cluster: {
      routes: () => true,
      primaryName: () => "Desk",
      primaryLinked: () => true,
      mirrorSessions: () => [],
      ownerOfSession: () => undefined,
      nodes: () => [],
      linked: () => true,
      forward: async () => ({ status: "queued" }),
      requestPrimary: async () => {
        throw new Error("no primary");
      },
      grant: () => undefined,
    },
    gate,
    log: silentLogger,
    version: "test",
    focus: () => focus,
    groups: () => groups,
    now: () => clock.t,
  });
  groups = new Groups({
    store,
    bus,
    log: silentLogger,
    gate,
    routes: () => true,
    me: () => ({ owner: "usr_ME", user: "ferit" }),
    sessions: () => local,
    names: () => router.agentNames(),
    nodeName: () => "Desk",
    place: (s) => ({ workspace: s.cwd.split("/").pop()!, path: s.cwd }),
    deliver,
    holds: () => false,
    linked: () => true,
    focus,
    push: (m) => pushed.push({ group: m.group.name, from: m.from, text: m.text }),
    now: () => clock.t,
    sweepMs: 60_000,
    gatherMs: 5,
  });
  focus.start();
  groups.start();
  const call = async (caller: Session, tool: string, args: Record<string, unknown>) => {
    const answer = (await router.mcp({ harness: caller.harness, ...(caller.native.pid ? { ppid: caller.native.pid } : {}) }, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: tool, arguments: args, _meta: { threadId: caller.native.id } } })) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: answer.result.content[0]!.text, ...(answer.result.isError ? { isError: true } : {}) };
  };
  const set = (s: Session, patch: Partial<Session>) => {
    Object.assign(s, patch);
    if (!("waiting" in patch) && patch.status !== undefined) delete s.waiting;
    bus.emit("session.state", { ...s });
  };
  const stop = () => {
    groups.stop();
    focus.stop();
  };
  return { store, bus, groups, focus, router, delivered, sent, pushed, clock, call, set, stop, asks };
}

describe("tags in a post", () => {
  const table = new Map<string, string[]>([
    ["api-codex", ["agent:a"]],
    ["web-claude", ["agent:w"]],
    ["bob/web", ["agent:b"]],
    ["ferit", ["person:me"]],
    ["twin", ["agent:t1", "agent:t2"]],
  ]);

  test("a member's tag becomes its marker, @agents and @users are kept, and code is left alone", () => {
    const r = readTags("@api-codex and @bob/web, see `@Injectable` and\n```\n@twin\n```\nthen @agents.", table, { person: false });
    if ("error" in r) throw new Error(r.error);
    expect(r.text).toBe("@[agent:a] and @[agent:b], see `@Injectable` and\n```\n@twin\n```\nthen @agents.");
    expect(r.mentions).toEqual([{ member: "agent:a" }, { member: "agent:b" }, { all: "agents" }]);
    expect(writeTags(r.text, (k) => ({ "agent:a": "api-codex", "agent:b": "bob/web" })[k])).toBe("@api-codex and @bob/web, see `@Injectable` and\n```\n@twin\n```\nthen @agents.");
  });

  test("an e-mail address tags no one, a full stop after a handle is not part of it, and case does not matter", () => {
    const r = readTags("mail me@example.com, or ask @API-Codex.", table, { person: true });
    if ("error" in r) throw new Error(r.error);
    expect(r.mentions).toEqual([{ member: "agent:a" }]);
    expect(r.text).toBe("mail me@example.com, or ask @[agent:a].");
  });

  test("a tag that names no member, or two, refuses the post; @everyone is a person's alone", () => {
    expect(readTags("@nobody look", table, { person: true })).toMatchObject({ error: "@nobody names no member" });
    expect(readTags("@twin look", table, { person: true })).toMatchObject({ error: "@twin names more than one member" });
    expect(readTags("@everyone look", table, { person: false })).toMatchObject({ error: expect.stringContaining("only a person tags @everyone") });
    expect(readTags("@everyone look", table, { person: true })).toMatchObject({ mentions: [{ all: "everyone" }] });
  });
});

describe("a group chat", () => {
  test("a tag sends one notice and not the post; more tags wait for the read; read_group catches the agent up", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      const g = await r.groups.create({ name: "release", purpose: "Ship 0.18 by Friday", members: [{ session: api.id }, { session: web.id }] });
      expect(g.members.map((m) => (m.kind === "agent" ? m.handle : m.user))).toEqual(["ferit", "api-codex", "web-claude"]);
      expect(g.home).toEqual({ node: DESK, path: "C:/code/api" });
      // the welcome: each agent is told what the group is for and who is in it
      await waitFor(() => r.delivered.length === 2);
      expect(r.delivered[0]!.text).toContain("put you in the group chat #release: Ship 0.18 by Friday");
      expect(r.delivered[0]!.info.group).toEqual({ id: g.id, name: "release" });
      r.delivered.length = 0;

      await r.groups.postAsUser(g.id, "@api-codex is the schema merged?");
      await waitFor(() => r.delivered.length === 1);
      const n = r.delivered[0]!;
      expect(n.session).toBe(api.id);
      // who and how many, never the words: read_group shows them; quiet, so a working agent gets it by a hook
      // and that it stands for every tag until the group is read, and how an answer reaches the writer
      expect(n.text).toBe("ferit (your user) tagged you in #release (1 unread, 1 tagging you). read_group shows it when it suits your work; until you read it, no other notice comes for #release. If you answer, post_group with its id as reply_to tells them.");
      expect(n.text).not.toContain("schema");
      expect(n.quiet).toBe(true);
      expect(n.info.from).toBeUndefined();

      // three more before it reads: no second notice
      for (const t of ["@api-codex one", "@api-codex two", "@agents three"]) await r.groups.postAsUser(g.id, t);
      await Bun.sleep(20);
      expect(r.delivered.filter((d) => d.session === api.id)).toHaveLength(1);
      // @agents told web-claude, which had no notice waiting
      expect(r.delivered.filter((d) => d.session === web.id)).toHaveLength(1);
      // still unread ten minutes on, at rest: one reminder, which says it is the last
      r.set(api, { status: "idle" });
      r.clock.t += 10 * 60_000 + 1;
      await r.groups.sweep();
      await waitFor(() => r.delivered.filter((d) => d.session === api.id).length === 2);
      expect(r.delivered.filter((d) => d.session === api.id)[1]!.text).toBe("Reminder: ferit (your user) tagged you in #release and it is still unread (4 unread, 4 tagging you). read_group shows it when it suits your work; no more notices come for #release until you read it.");
      r.clock.t += 10 * 60_000 + 1;
      await r.groups.sweep();
      await r.groups.postAsUser(g.id, "@api-codex five");
      await Bun.sleep(20);
      expect(r.delivered.filter((d) => d.session === api.id)).toHaveLength(2);

      const read = await r.call(api, "read_group", { group: "release" });
      expect(read.isError).toBeUndefined();
      expect(read.text).toContain("#release (" + g.id + "): Ship 0.18 by Friday");
      expect(read.text).toContain("@api-codex (you)");
      expect(read.text).toContain("@ferit (your user)");
      expect(read.text).toMatch(/\[1 gmsg_\w+\] @?ferit \(your user\), \d\d:\d\d, tags you: @api-codex is the schema merged\?/);
      expect(read.text).toContain("That is everything for you.");
      // read: the next tag sends a notice again
      await r.groups.postAsUser(g.id, "@api-codex and now?");
      await waitFor(() => r.delivered.filter((d) => d.session === api.id).length === 3);
      // nothing unread: the last posts for context, and the read point stays
      const again = await r.call(api, "read_group", { group: "release" });
      expect(again.text).toContain("and now?");
      const quiet = await r.call(api, "read_group", { group: "release" });
      expect(quiet.text).toContain("Nothing unread; the last 5 for context");
    } finally {
      r.stop();
    }
  });

  test("an agent's post: its tags are checked, it says whether it waits for an answer, and a reply tags the writer", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }, { session: web.id }] });
      await waitFor(() => r.delivered.length === 2);
      r.delivered.length = 0;
      const unknown = await r.call(api, "post_group", { group: "release", text: "@nobody look", expects_reply: false });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("@nobody names no member of #release. Its members: @ferit, @api-codex, @web-claude");
      const noFlag = await r.call(api, "post_group", { group: "release", text: "hello" });
      expect(noFlag.text).toContain("needs expects_reply");
      const everyone = await r.call(api, "post_group", { group: "release", text: "@everyone hi", expects_reply: false });
      expect(everyone.text).toContain("only a person tags @everyone");

      const asked = await r.call(api, "post_group", { group: "release", text: "@web-claude can you run the login test?", expects_reply: true });
      expect(asked.text).toMatch(/Posted in #release as post 1 \(gmsg_\w+\)\. Told: @web-claude\. An answer comes to you as a notice when it tags you or answers this post; do not wait for it in a loop\.$/);
      await waitFor(() => r.delivered.length === 1);
      expect(r.delivered[0]!.text).toContain("It waits for your answer: post_group with its id as reply_to tells them.");
      expect(r.delivered[0]!.text).not.toContain("login test");
      const postId = /\((gmsg_\w+)\)/.exec(asked.text)![1]!;
      // a post that waits on its reader says how to answer it
      const shown = await r.call(web, "read_group", { group: "release" });
      expect(shown.text).toContain("tags you, awaiting your reply");
      expect(shown.text).toContain("That is everything for you. Answer a post with post_group and its id as reply_to, which tells its writer.");
      // a question that tags no one: no one was told, and the asker hears so
      const untagged = await r.call(api, "post_group", { group: "release", text: "does anyone know the staging URL?", expects_reply: true });
      expect(untagged.text).toContain("It tags no one, so no one was told: the others read it when they choose. It waits for an answer no one was asked for: post again tagging whoever should answer.");
      const told = await r.call(api, "post_group", { group: "release", text: "the build is up", expects_reply: false });
      expect(told.text).toMatch(/It tags no one, so no one was told: the others read it when they choose\.$/);
      await Bun.sleep(20);
      expect(r.delivered).toHaveLength(1);
      const answer = await r.call(web, "post_group", { group: "release", text: "Passed: 14 tests.", expects_reply: false, reply_to: postId });
      expect(answer.text).toContain("Told: @api-codex.");
      await waitFor(() => r.delivered.some((d) => d.session === api.id));
      const post = r.groups.posts(g.id).posts.find((p) => p.id === postId)!;
      expect(post.answered).toBe(true);
      // a thumbs up wakes no one
      r.delivered.length = 0;
      const ack = await r.call(api, "ack_post", { group: "release", post: r.groups.posts(g.id).posts[1]!.id });
      expect(ack.text).toStartWith("Thumbs up on post 2 in #release; no one was woken.");
      expect(r.groups.posts(g.id).posts[1]!.acks).toEqual(["api-codex"]);
      await Bun.sleep(20);
      expect(r.delivered).toHaveLength(0);
      // a tag of the user goes to their phones
      await r.call(web, "post_group", { group: "release", text: "@ferit all green", expects_reply: false });
      expect(r.pushed).toEqual([{ group: "release", from: "web-claude", text: "@ferit all green" }]);
    } finally {
      r.stop();
    }
  });

  test("an agent told of every post gets them gathered once its turn is over; its owner sets that, not the group", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }, { session: web.id }] });
      await waitFor(() => r.delivered.length === 2);
      r.delivered.length = 0;
      r.groups.setNotify(g.id, `agent:${web.id}`, "all");
      // busy: nothing yet
      await r.groups.postAsUser(g.id, "first");
      const second = await r.call(api, "post_group", { group: "release", text: "second", expects_reply: false });
      // a post that tags no one names who gets it all the same
      expect(second.text).toContain("It tags no one: @web-claude hears every post and gets it; the others read it when they choose.");
      await Bun.sleep(20);
      expect(r.delivered.filter((d) => d.session === web.id)).toHaveLength(0);
      // its turn ends: one message with both
      r.set(web, { status: "idle" });
      await waitFor(() => r.delivered.some((d) => d.session === web.id));
      const gathered = r.delivered.find((d) => d.session === web.id)!;
      expect(gathered.text).toMatch(/^New in #release \(2 posts\):\n\[1 gmsg_\w+\] @?ferit \(your user\), \d\d:\d\d: first\n\[2 gmsg_\w+\] @api-codex, \d\d:\d\d: second\n/);
      expect(r.groups.list()[0]!.members.find((m) => m.key === `agent:${web.id}`)!.readTo).toBe(2);
      // idle now: the next post goes after a moment, on its own
      await r.groups.postAsUser(g.id, "third");
      await waitFor(() => r.delivered.filter((d) => d.session === web.id).length === 2);
      expect(r.delivered.filter((d) => d.session === web.id)[1]!.text).toContain("third");
    } finally {
      r.stop();
    }
  });

  test("a tool's answer carries what the agent has not read in its groups, once; a read's does not", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      await r.groups.create({ name: "release", members: [{ session: api.id }, { session: web.id }] });
      await r.groups.postAsUser([...r.groups.list()][0]!.id, "the release branch is cut");
      const listed = await r.call(web, "list_agents", {});
      // the user's post tags no one, and is for every agent of theirs to read
      expect(listed.text).toContain("Unread in your group chats, which read_group shows when it suits your work: #release: 1 new post (1 for you).");
      expect((await r.call(web, "list_agents", {})).text).not.toContain("Unread in your group chats");
      await r.groups.postAsUser([...r.groups.list()][0]!.id, "and tagged 0.18.0");
      const read = await r.call(web, "read_group", { group: "release" });
      expect(read.text).not.toContain("Unread in your group chats");
      expect((await r.call(web, "list_agents", {})).text).not.toContain("Unread in your group chats");
    } finally {
      r.stop();
    }
  });

  test("the limits: six posts a minute in one group, the same text once in five minutes", async () => {
    const api = sess("codex", "C:/code/api");
    const r = rig([api]);
    try {
      await r.groups.create({ name: "solo", members: [{ session: api.id }] });
      for (let i = 0; i < 6; i++) expect((await r.call(api, "post_group", { group: "solo", text: `post ${i}`, expects_reply: false })).isError).toBeUndefined();
      expect((await r.call(api, "post_group", { group: "solo", text: "post 7", expects_reply: false })).text).toContain("6 times in a minute in this group");
      r.clock.t += 61_000;
      expect((await r.call(api, "post_group", { group: "solo", text: "post 0", expects_reply: false })).text).toContain("the same text in this group in the last five minutes");
      expect((await r.call(api, "post_group", { group: "solo", text: "post 8", expects_reply: false })).isError).toBeUndefined();
    } finally {
      r.stop();
    }
  });

  test("a member whose session ended is gone, kept, and told once of what tagged it when it is resumed", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }, { session: web.id }] });
      await waitFor(() => r.delivered.length === 2);
      r.delivered.length = 0;
      r.set(web, { status: "ended" });
      expect(r.groups.list()[0]!.members.find((m) => m.key === `agent:${web.id}`)).toMatchObject({ gone: true });
      const posted = await r.call(api, "post_group", { group: "release", text: "@web-claude when you are back: rebase", expects_reply: false });
      expect(posted.text).toContain("Not told, their sessions have ended: @web-claude.");
      expect(r.delivered).toHaveLength(0);
      // resumed: the same record, back in its group, told of the tag
      r.set(web, { status: "idle" });
      await waitFor(() => r.delivered.some((d) => d.session === web.id));
      expect(r.delivered.find((d) => d.session === web.id)!.text).toContain("tagged you in #release");
      expect(r.groups.list()[0]!.members.find((m) => m.key === `agent:${web.id}`)).not.toHaveProperty("gone");
      void g;
    } finally {
      r.stop();
    }
  });

  test("the user's own posts, reads and thumbs up; a group's maker ends it; deleting drops the copy", async () => {
    const api = sess("codex", "C:/code/api");
    const r = rig([api]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }] });
      const p = await r.groups.postAsUser(g.id, "a note for later");
      expect(p.from).toMatchObject({ kind: "person", user: "ferit" });
      expect(r.groups.list()[0]!.unread).toBe(0);
      await r.call(api, "post_group", { group: "release", text: "@ferit noted", expects_reply: false });
      expect(r.groups.list()[0]).toMatchObject({ unread: 1, tagged: 1 });
      r.groups.readAsUser(g.id, 2);
      expect(r.groups.list()[0]).toMatchObject({ unread: 0, tagged: 0 });
      r.groups.react(g.id, p.id, true);
      expect(r.groups.posts(g.id).posts[0]!.acks).toEqual(["ferit"]);
      r.groups.end(g.id);
      expect((await r.call(api, "post_group", { group: "release", text: "late", expects_reply: false })).text).toContain("has ended: it is read only");
      r.groups.delete(g.id);
      expect(r.groups.list()).toEqual([]);
    } finally {
      r.stop();
    }
  });
});

describe("focus", () => {
  test("holds another agent's message and a group's tags, tells the sender at once, and hands it all over when the turn ends", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }, { session: web.id }] });
      await waitFor(() => r.delivered.length === 2);
      r.delivered.length = 0;

      const taken = await r.call(web, "focus", { minutes: 60, reason: "finishing the migration" });
      expect(taken.text).toContain("You are in focus until");
      expect(r.focus.list()).toHaveLength(1);
      // list_agents shows it
      const listed = await r.call(api, "list_agents", {});
      expect(listed.text).toContain("web-claude: Claude Code on Desk, in web, in focus for 1 h more (finishing the migration): what you send waits for it");

      const sent = await r.call(api, "send_message", { to: "web-claude", text: "the schema is merged" });
      expect(sent.text).toMatch(/^Held for web-claude \(pmsg_\w+\): it is in focus until \d\d:\d\d, 1 h from now, or until its turn ends \(finishing the migration\)/);
      expect(r.sent).toHaveLength(0);
      const posted = await r.call(api, "post_group", { group: "release", text: "@web-claude rebase when you can", expects_reply: false });
      expect(posted.text).toContain("@web-claude is in focus for 1 h more (finishing the migration) and is told when it comes out");
      await Bun.sleep(20);
      expect(r.delivered).toHaveLength(0);

      // its turn ends: one message, the notice of what came with the message after it in its own envelope
      r.set(web, { status: "idle" });
      await waitFor(() => r.delivered.length === 1);
      expect(r.delivered[0]!.text).toBe("Your focus ended with your turn. While you were in focus: 1 tag of you in #release; 1 message (from api-codex), below. Read a group with read_group when it suits your work.");
      expect(r.delivered[0]!.info.from).toBeUndefined();
      expect(r.delivered[0]!.more).toHaveLength(1);
      expect(r.delivered[0]!.more![0]).toMatchObject({ text: "the schema is merged", from: { alias: "api-codex" }, mode: "prompting" });
      expect(r.focus.list()).toEqual([]);
      // the catch-up stood for the tag's notice: no second one
      await Bun.sleep(20);
      expect(r.delivered).toHaveLength(1);
      void g;
    } finally {
      r.stop();
    }
  });

  test("a turn over with its own shells running is not the end; the agent or the user ends it; it runs out at its time", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      await r.call(web, "focus", { minutes: 120, reason: "a long build" });
      r.set(web, { status: "idle", waiting: { on: "shell" } });
      await Bun.sleep(10);
      expect(r.focus.get(web.id)).toBeDefined();
      const off = await r.call(web, "focus", { off: true });
      expect(off.text).toBe("Your focus has ended; what came meanwhile follows.");
      expect(r.delivered[0]!.text).toBe("You ended your focus; nothing came meanwhile.");
      // the user ends it from the app
      r.set(web, { status: "busy" });
      await r.call(web, "focus", { minutes: 60, reason: "again" });
      await r.focus.end(web.id, "user");
      expect(r.delivered[1]!.text).toBe("Your user ended your focus; nothing came meanwhile.");
      // its time runs out
      await r.call(web, "focus", { minutes: 60, reason: "once more" });
      r.clock.t += 61 * 60_000;
      await r.focus.sweep();
      expect(r.delivered[2]!.text).toBe("Your focus ran its time; nothing came meanwhile.");
      expect((await r.call(web, "focus", { minutes: 30, reason: "x" })).text).toContain("minutes is 60 or 120");
      expect((await r.call(web, "focus", { minutes: 60 })).text).toContain("focus needs reason");
    } finally {
      r.stop();
    }
  });

  test("a session that ends in focus drops what was held, and its senders are told", async () => {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const r = rig([api, web]);
    try {
      await r.call(web, "focus", { minutes: 60, reason: "deep work" });
      const sent = await r.call(api, "send_message", { to: "web-claude", text: "are you there?" });
      const id = /\((pmsg_\w+)\)/.exec(sent.text)![1]!;
      r.set(web, { status: "ended" });
      await waitFor(() => r.delivered.length === 1);
      expect(r.delivered[0]).toMatchObject({ session: api.id, text: `Your message ${id} was not delivered: its session ended while it was in focus.`, info: { replyTo: id } });
    } finally {
      r.stop();
    }
  });
});

describe("reading and searching a group", () => {
  /** A group of the user and three agents; web-claude reads. */
  async function setup(extra: Session[] = []) {
    const api = sess("codex", "C:/code/api");
    const web = sess("claude", "C:/code/web");
    const ops = sess("claude", "C:/code/ops");
    const r = rig([api, web, ops, ...extra]);
    const g = await r.groups.create({ name: "release", purpose: "Ship 0.18 by Friday", members: [{ session: api.id }, { session: web.id }, { session: ops.id }] });
    await waitFor(() => r.delivered.length === 3);
    r.delivered.length = 0;
    const readTo = () => r.groups.list().find((x) => x.id === g.id)!.members.find((m) => m.key === `agent:${web.id}`)!.readTo;
    const idOf = (text: string) => /\((gmsg_\w+)\)/.exec(text)![1]!;
    return { api, web, ops, r, g, readTo, idOf };
  }

  test("a read shows the posts for the agent and passes over the rest, read, as a range it can open", async () => {
    const { api, web, ops, r, g, readTo, idOf } = await setup();
    try {
      await r.call(api, "post_group", { group: "release", text: "the build is red", expects_reply: false });
      // the user's own, though it tags no one
      await r.groups.postAsUser(g.id, "everyone, rebase on main");
      const asked = await r.call(api, "post_group", { group: "release", text: "@web-claude can you check the login test?", expects_reply: true });
      // another's answer to what web-claude was asked
      await r.call(ops, "post_group", { group: "release", text: "on it, the login test passes here", expects_reply: false, reply_to: idOf(asked.text) });
      await r.call(ops, "post_group", { group: "release", text: "deploy queue is empty", expects_reply: false });
      const read = await r.call(web, "read_group", { group: "release" });
      expect(read.text).toContain("Members: @ferit (your user), @api-codex");
      expect(read.text).toMatch(/\[2 gmsg_\w+\] ferit \(your user\), \d\d:\d\d: everyone, rebase on main/);
      expect(read.text).toMatch(/\[3 gmsg_\w+\] @api-codex, \d\d:\d\d, tags you: @web-claude can you check the login test\?/);
      expect(read.text).toMatch(/\[4 gmsg_\w+\] @ops-claude, \d\d:\d\d, answering 3: on it, the login test passes here/);
      expect(read.text).not.toContain("the build is red");
      expect(read.text).not.toContain("deploy queue");
      expect(read.text).toContain('That is everything for you. Passed over 2 posts not for you, now read (posts 1 to 5; @api-codex 1, @ops-claude 1): read_group with posts="1-5" shows them.');
      expect(readTo()).toBe(5);

      // nothing for it: the members as listed before, and only the count of what it passed over
      await r.call(api, "post_group", { group: "release", text: "fixed the build", expects_reply: false });
      const quiet = await r.call(web, "read_group", { group: "release" });
      expect(quiet.text).toContain("Members: 4, as listed before; members=true lists them and how each stands.");
      expect(quiet.text).toContain('Nothing for you. Passed over 1 post not for you, now read (post 6; @api-codex 1): read_group with posts="6" shows it.');
      expect(quiet.text).not.toContain("fixed the build");
      expect((await r.call(web, "read_group", { group: "release", members: true })).text).toContain("Members: @ferit (your user), @api-codex");

      // an answer to its own post, which the read does not show, is shown with a line of it
      const mine = await r.call(web, "post_group", { group: "release", text: "@api-codex is the fix on main?", expects_reply: true });
      await r.call(api, "post_group", { group: "release", text: "yes, since 14:10", expects_reply: false, reply_to: idOf(mine.text) });
      const answer = await r.call(web, "read_group", { group: "release" });
      expect(answer.text).toMatch(/\[8 gmsg_\w+\] @api-codex, \d\d:\d\d, answering 7 by you \("@api-codex is the fix on main\?"\), tags you: yes, since 14:10/);
    } finally {
      r.stop();
    }
  });

  test("posts shows posts whole by number, thread a conversation, all every unread post; the first two move no read point", async () => {
    const { api, web, ops, r, g, readTo, idOf } = await setup();
    try {
      await r.groups.postAsUser(g.id, `@web-claude here is the log: ${"x".repeat(2_000)} end of log`);
      const asked = await r.call(api, "post_group", { group: "release", text: "who has the staging URL?", expects_reply: true });
      await r.call(ops, "post_group", { group: "release", text: "it is staging.example.com", expects_reply: false, reply_to: idOf(asked.text) });
      // a long post is cut in a list, and posts shows it whole
      const first = await r.call(web, "read_group", { group: "release" });
      expect(first.text).toContain('more characters: read_group with posts="1" shows it whole)');
      expect(first.text).not.toContain("end of log");
      expect(readTo()).toBe(3);
      const whole = await r.call(web, "read_group", { group: "release", posts: "1" });
      expect(whole.text).toContain("end of log");
      expect(whole.text).toContain("Your read point did not move.");
      // a range, an id, and a number that is no post
      const some = await r.call(web, "read_group", { group: "release", posts: `2-3, ${idOf(asked.text)}, 9` });
      expect(some.text).toMatch(/\[2 gmsg_\w+\] @api-codex, \d\d:\d\d: who has the staging URL\?/);
      expect(some.text).toMatch(/\[3 gmsg_\w+\] @ops-claude, \d\d:\d\d, answering 2: it is staging\.example\.com/);
      expect(some.text).toContain("No post 9 in #release.");
      expect((await r.call(web, "read_group", { group: "release", posts: "the staging one" })).text).toContain("posts takes post numbers, ranges like 30-52 and gmsg_ ids: the is none of them");

      // a conversation: the posts it answers, up to the first, and the answers to them
      await r.groups.postAsUser(g.id, "thanks", r.groups.posts(g.id).posts.find((p) => p.n === 3)!.id);
      const thread = await r.call(web, "read_group", { group: "release", thread: "3" });
      expect(thread.text).toContain("The conversation post 3 is in: 3 posts from post 2. Your read point did not move.");
      expect(thread.text).toContain("who has the staging URL?");
      expect(thread.text).toContain("thanks");
      expect(thread.text).not.toContain("here is the log");
      expect(readTo()).toBe(3);
      expect((await r.call(web, "read_group", { group: "release", posts: "1", thread: "3" })).text).toContain("read_group takes one of posts, thread, before and all at a time");

      // all: every unread post, those not for it too
      await r.call(api, "post_group", { group: "release", text: "the build is green", expects_reply: false });
      const everything = await r.call(web, "read_group", { group: "release", all: true });
      expect(everything.text).toContain("thanks");
      expect(everything.text).toContain("the build is green");
      expect(everything.text).toContain("That is everything unread.");
      expect(readTo()).toBe(5);
    } finally {
      r.stop();
    }
  });

  test("more posts for the agent than one read shows: its read point stops at the last shown, and the next read goes on", async () => {
    const { api, web, r, g, readTo } = await setup();
    try {
      await r.groups.postAsUser(g.id, "@web-claude first");
      await r.call(api, "post_group", { group: "release", text: "noise one", expects_reply: false });
      await r.groups.postAsUser(g.id, "@web-claude second");
      await r.call(api, "post_group", { group: "release", text: "noise two", expects_reply: false });
      const one = await r.call(web, "read_group", { group: "release", limit: 1 });
      expect(one.text).toContain("@web-claude first");
      expect(one.text).not.toContain("second");
      expect(one.text).toContain("1 of 2 posts for you; read_group again for the next.");
      expect(one.text).not.toContain("Passed over");
      expect(readTo()).toBe(1);
      const two = await r.call(web, "read_group", { group: "release", limit: 1 });
      expect(two.text).toContain("@web-claude second");
      expect(two.text).toContain('That is everything for you. Passed over 2 posts not for you, now read (posts 2 to 4; @api-codex 2): read_group with posts="2-4" shows them.');
      expect(readTo()).toBe(4);
    } finally {
      r.stop();
    }
  });

  test("the members are listed again once they change", async () => {
    const docs = sess("claude", "C:/code/docs");
    const { web, r, g } = await setup([docs]);
    try {
      expect((await r.call(web, "read_group", { group: "release" })).text).toContain("Members: @ferit (your user)");
      expect((await r.call(web, "read_group", { group: "release" })).text).toContain("Members: 4, as listed before");
      r.clock.t += 1_000;
      await r.groups.addMembers(g.id, [{ session: docs.id }]);
      expect((await r.call(web, "read_group", { group: "release" })).text).toContain("@docs-claude");
    } finally {
      r.stop();
    }
  });

  test("search_group finds posts by their words, a tag, a writer or for the agent, in one group or all, and moves no read point", async () => {
    const { api, web, ops, r, readTo } = await setup();
    try {
      const at = async (f: () => Promise<unknown>) => {
        r.clock.t += 1_000;
        await f();
      };
      await at(() => r.call(api, "post_group", { group: "release", text: "The staging URL is staging.example.com", expects_reply: false }));
      await at(() => r.call(ops, "post_group", { group: "release", text: "@web-claude the login test is flaky on staging", expects_reply: false }));
      await at(() => r.call(api, "post_group", { group: "release", text: "100% of the e2e suite passed", expects_reply: false }));
      await r.groups.create({ name: "ops", members: [{ session: web.id }, { session: ops.id }] });
      await at(() => r.call(ops, "post_group", { group: "ops", text: "staging is down for an hour", expects_reply: false }));

      // every word, case aside, newest first, across the agent's groups
      const both = await r.call(web, "search_group", { query: "STAGING" });
      expect(both.text).toMatch(/^3 posts in your groups, newest first:\n\[#ops 1 gmsg_\w+\] @ops-claude, \d\d:\d\d: staging is down for an hour\n\[#release 2 gmsg_\w+\] @ops-claude, \d\d:\d\d, tags you: @web-claude the login test is flaky on staging\n\[#release 1 gmsg_\w+\] @api-codex, \d\d:\d\d: The staging URL is staging\.example\.com\n/);
      expect(both.text).toContain('read_group with the group and posts="<number>" shows a post whole');
      expect((await r.call(web, "search_group", { group: "release", query: "login staging" })).text).toMatch(/^1 post in #release, newest first:\n\[#release 2 /);
      // a tag looks for the member it names; % and _ are plain characters
      expect((await r.call(web, "search_group", { group: "release", query: "@web-claude" })).text).toMatch(/^1 post in #release/);
      expect((await r.call(web, "search_group", { group: "release", query: "100%" })).text).toContain("100% of the e2e suite passed");
      expect((await r.call(web, "search_group", { group: "release", query: "1_0" })).text).toStartWith("Nothing in #release matches.");

      // by a writer, and for the agent
      expect((await r.call(web, "search_group", { group: "release", from: "@api-codex" })).text).toMatch(/^2 posts in #release/);
      expect((await r.call(web, "search_group", { for_you: true })).text).toMatch(/^1 post in your groups/);
      // paging back in one group
      const page = await r.call(web, "search_group", { group: "release", query: "the", limit: 1 });
      expect(page.text).toMatch(/^1 post in #release, newest first:\n\[#release 3 /);
      expect(page.text).toContain("Older ones with before=3.");
      expect((await r.call(web, "search_group", { group: "release", query: "the", before: 3 })).text).toMatch(/^2 posts in #release/);

      expect((await r.call(web, "search_group", {})).text).toContain("search_group needs query");
      expect((await r.call(web, "search_group", { query: "the", before: 3 })).text).toContain("before pages back in one group");
      expect((await r.call(web, "search_group", { from: "nobody" })).text).toContain("nobody names no member of your groups");
      expect(readTo()).toBe(0);
    } finally {
      r.stop();
    }
  });
});
