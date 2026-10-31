// The default view's group chats and focus, pure: the groups and their posts as the node says
// them (a page, an earlier page, a post as it lands, a group left), where a group's tab stands
// in the rail, how a post is drawn (its writer, the post it answers, its tags lit, the user's
// own brighter, its thumbs, the agents that have not read it), the members' chips, the tags the
// composer offers, New group's picker and what it sends, and an agent's focus.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Group, GroupCandidate, GroupMember, GroupPost, Node, ClientSession as Session, ClientWorkspace as Workspace } from "@cophyla/protocol";
import {
  apply,
  canEndGroup,
  candidateGroups,
  chatDraw,
  completeTag,
  focusWords,
  groupCreateParams,
  groupMaker,
  groupMemberWords,
  groupTabWords,
  initialState,
  memberChips,
  placeGroupChats,
  postView,
  readUpTo,
  selectGroups,
  sessionFocus,
  slot,
  tagCompletion,
  tagSlots,
  teamEndWords,
  teamworkFailure,
  unreadBy,
} from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";
import { attachParams, isImagePath, toBase64 } from "../views/default/attach.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB4";
const BOBS = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB5";
const G1 = "grp_01ARZ3NDEKTSV4RRFFQ69G5FC1";
const G2 = "grp_01ARZ3NDEKTSV4RRFFQ69G5FC2";
const G3 = "grp_01ARZ3NDEKTSV4RRFFQ69G5FC3";
const NOW = 1_758_196_800_000;

function node(id: string, name: string, over: Partial<Node> = {}): Node {
  return { id, name, role: "secondary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: false, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false }, versions: { platform: "0.17.0", protocol: 1 }, lastSeen: 0, ...over } as Node;
}

function connected(): ViewState {
  const scopes = [...ACCESS_PRESETS.full.scopes];
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.17.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  apply(state, { type: "nodes", nodes: [node(DESK, "Desk", { role: "primary" }), node(LAPTOP, "Laptop")] });
  return state;
}

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, node: DESK, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: id + "-n", transport: "pipe" }, origin: "user", cwd: "C:\\work\\web", status: "idle", startedAt: 1, lastActivity: 1, ...over }) as Session;
const workspace = (id: string, path: string, name: string, n = DESK): Workspace => ({ id, node: n, path, name, origin: "user", lastActivity: 1 }) as Workspace;

const me: GroupMember = { kind: "person", key: "person:usr_alice", user: "alice", readTo: 2, me: true };
const bobPerson: GroupMember = { kind: "person", key: "person:usr_bob", user: "bob", readTo: 3 };
const web: GroupMember = { kind: "agent", key: `agent:${A}`, session: A, handle: "web", harness: "claude", notify: "tags", readTo: 3, unread: 0, mine: true, addedBy: "alice", addedAt: 1 };
const api: GroupMember = { kind: "agent", key: `agent:${B}`, session: B, handle: "api-codex", harness: "codex", notify: "all", readTo: 1, unread: 2, mine: true, addedBy: "alice", addedAt: 1 };
const bobs: GroupMember = { kind: "agent", key: `agent:${BOBS}`, session: BOBS, user: "bob", handle: "bob/api", harness: "claude", notify: "tags", readTo: 0, unread: 3, addedBy: "bob", addedAt: 1 };

function group(over: Partial<Group> = {}): Group {
  return { id: G1, name: "release", purpose: "Ship 0.18", by: "alice", notify: "tags", members: [me, web, api, bobs, bobPerson], unread: 1, tagged: 0, createdAt: 10, ...over };
}

function post(n: number, over: Partial<GroupPost> = {}): GroupPost {
  return { id: `gmsg_01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, "0")}`, group: G1, n, from: { kind: "person", key: "person:usr_alice", user: "alice" }, text: `post ${n}`, mentions: [], acks: [], at: NOW - (10 - n) * 60_000, ...over };
}

describe("group chats in the view", () => {
  test("the list, a group changed, and a group left takes its posts with it", () => {
    const state = connected();
    apply(state, { type: "groups", groups: [group(), group({ id: G2, name: "auth" })] });
    expect([...state.groups.keys()]).toEqual([G1, G2]);
    apply(state, { type: "group.posts", group: G1, posts: [post(1)], more: false });
    apply(state, { type: "group.state", params: group({ name: "release-0.18", unread: 0 }) });
    expect(state.groups.get(G1)).toMatchObject({ name: "release-0.18", unread: 0 });
    apply(state, { type: "group.state", params: { ...group(), left: true } });
    expect(state.groups.has(G1)).toBe(false);
    expect(state.groupPosts.has(G1)).toBe(false);
    // a new list drops the posts of a group no longer in it
    apply(state, { type: "group.posts", group: G2, posts: [post(1, { group: G2 })], more: false });
    apply(state, { type: "groups", groups: [] });
    expect(state.groupPosts.size).toBe(0);
  });

  test("the latest page, an earlier one before it, a post as it lands, and the same post again with its thumbs", () => {
    const state = connected();
    apply(state, { type: "groups", groups: [group()] });
    apply(state, { type: "group.posts.loading", group: G1 });
    expect(state.groupPosts.get(G1)).toMatchObject({ loaded: false, loading: true, posts: [] });
    // a post that lands while the page is on its way is kept, newer than the page
    apply(state, { type: "group.posted", params: { group: G1, post: post(6) } });
    apply(state, { type: "group.posts", group: G1, posts: [post(4), post(5)], more: true });
    expect(state.groupPosts.get(G1)!.posts.map((p) => p.n)).toEqual([4, 5, 6]);
    expect(state.groupPosts.get(G1)).toMatchObject({ loaded: true, more: true });
    apply(state, { type: "group.posts.loading", group: G1 });
    apply(state, { type: "group.posts", group: G1, posts: [post(2), post(3)], more: false, before: 4 });
    expect(state.groupPosts.get(G1)!.posts.map((p) => p.n)).toEqual([2, 3, 4, 5, 6]);
    expect(state.groupPosts.get(G1)).toMatchObject({ more: false, loading: false });
    apply(state, { type: "group.posted", params: { group: G1, post: post(5, { acks: ["web"] }) } });
    expect(state.groupPosts.get(G1)!.posts.map((p) => p.n)).toEqual([2, 3, 4, 5, 6]);
    expect(state.groupPosts.get(G1)!.posts[3]!.acks).toEqual(["web"]);
    // a group never opened keeps no posts: they load when it is
    apply(state, { type: "group.posted", params: { group: G2, post: post(1, { group: G2 }) } });
    expect(state.groupPosts.has(G2)).toBe(false);
  });

  test("a lost line leaves the posts stale, and the latest page replaces them", () => {
    const state = connected();
    apply(state, { type: "group.posts", group: G1, posts: [post(1), post(2)], more: false });
    apply(state, { type: "focus", focus: [{ session: A, focus: { since: NOW, until: NOW + 3_600_000, reason: "deep work" } }] });
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.groupPosts.get(G1)).toMatchObject({ stale: true, loading: false });
    expect(state.focus.size).toBe(0);
    apply(state, { type: "host.state", params: { connected: true } });
    apply(state, { type: "group.posts", group: G1, posts: [post(60), post(61)], more: true });
    expect(state.groupPosts.get(G1)!.posts.map((p) => p.n)).toEqual([60, 61]);
    expect(state.groupPosts.get(G1)!.stale).toBeUndefined();
  });

  test("none of it redraws the chat's items", () => {
    for (const type of ["groups", "group.state", "group.posted", "group.posts", "focus", "focus.state", "teammates", "teammate.state", "teammate.code"] as const) {
      expect(chatDraw({ type } as Parameters<typeof chatDraw>[0])).toBe("none");
    }
  });

  test("a group's tab stands under the innermost folder group its home names, counted there and around it; else under Groups", () => {
    const state = connected();
    apply(state, { type: "workspace.state", params: workspace("ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", "C:\\work", "work") });
    apply(state, { type: "workspace.state", params: workspace("ws_01ARZ3NDEKTSV4RRFFQ69G5FD2", "C:\\work\\web", "web") });
    apply(state, { type: "session.state", params: session(A, { workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD2" }) });
    apply(state, { type: "session.state", params: session(B, { workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", cwd: "C:\\work" }) });
    apply(state, {
      type: "groups",
      groups: [
        group({ id: G2, name: "web-only", home: { node: DESK, path: "c:\\Work\\web\\src" }, createdAt: 20 }),
        group({ home: { node: DESK, path: "C:\\work\\web" } }),
        group({ id: G3, name: "elsewhere", home: { node: LAPTOP, path: "/home/me/api" } }),
      ],
    });
    const groups = selectGroups(state);
    const { placed, loose } = placeGroupChats(state, groups);
    const outer = groups[0]!;
    const inner = outer.groups[0]!;
    expect(outer.name).toBe("work");
    expect(inner.name).toBe("web");
    // under web, which holds the folder and the one below it, the older first
    expect(placed.get(inner.key)!.map((g) => g.id)).toEqual([G1, G2]);
    expect(placed.has(outer.key)).toBe(false);
    expect(inner.count).toBe(1 + 2);
    expect(outer.count).toBe(1 + 3);
    // no session works on the laptop's folder: under Groups
    expect(loose.map((g) => g.id)).toEqual([G3]);
    // and one with no home at all
    const lone = placeGroupChats({ groups: new Map([[G1, group()]]), nodes: state.nodes }, []);
    expect(lone.loose.map((g) => g.id)).toEqual([G1]);
  });

  test("the tab's words: the purpose, the agents, unread, tagged, ended", () => {
    expect(groupTabWords(group({ unread: 3, tagged: 1 }))).toEqual({ title: "release: Ship 0.18\n3 agents · 3 unread · you are tagged", label: "Group chat, 3 unread, you are tagged" });
    expect(groupTabWords(group({ purpose: undefined, unread: 0, ended: { at: NOW, by: "alice" }, members: [me, { ...bobs, gone: true }] }))).toEqual({ title: "release\n0 agents · ended, read only", label: "Group chat, ended, read only" });
  });

  test("the folded head's words: the agents, those gone not counted, and the people", () => {
    expect(groupMemberWords(group())).toBe("3 agents · 2 people");
    expect(groupMemberWords(group({ members: [me, web, { ...bobs, gone: true }] }))).toBe("1 agent · 1 person");
  });

  test("the maker ends the group; anyone else, or an ended one, does not", () => {
    expect(groupMaker(group())).toBe(true);
    expect(canEndGroup(group())).toBe(true);
    expect(canEndGroup(group({ by: "bob" }))).toBe(false);
    expect(canEndGroup(group({ ended: { at: NOW, by: "alice" } }))).toBe(false);
    expect(canEndGroup(group({ members: [web] }))).toBe(false);
  });

  test("tags are slots outside code, the longest handle that fits, the user's own and everyone's marked", () => {
    const g = group();
    const r = tagSlots("@bob/api and @web, and @everyone: see `@web` and mail a@web.dev. @alice? @nobody", g);
    expect(r.tags).toEqual([
      { label: "@bob/api", own: false },
      { label: "@web", own: false },
      { label: "@everyone", own: true },
      { label: "@alice", own: true },
    ]);
    expect(r.text).toBe(`${slot(0)} and ${slot(1)}, and ${slot(2)}: see \`@web\` and mail a@web.dev. ${slot(3)}? @nobody`);
    // a handle that goes on is not this one; a fenced block is code
    expect(tagSlots("@webby and\n```\n@web\n```\n@API-CODEX.", g).tags).toEqual([{ label: "@API-CODEX", own: false }]);
    expect(tagSlots("@bob please", g).tags).toEqual([{ label: "@bob", own: false }]);
  });

  test("a post as drawn: its writer, what it answers, its tags, its thumbs, a reply awaited, the agents that have not read it", () => {
    const g = group();
    const asked = post(2, { from: { kind: "agent", key: `agent:${BOBS}`, session: BOBS, user: "bob", handle: "bob/api", harness: "claude" }, text: "Is the build green?\nmore", mentions: [{ member: `agent:${A}` }] });
    const answer = post(3, { text: "@web @api-codex check it", replyTo: asked.id, mentions: [{ member: `agent:${A}` }, { member: `agent:${B}` }], expectsReply: true, acks: ["bob", "alice"] });
    const page = { posts: [asked, answer] };
    const v = postView(g, answer, page);
    expect(v).toMatchObject({ n: 3, writer: { kind: "person", name: "alice" }, quote: { name: "bob/api", excerpt: "Is the build green?" }, awaiting: true, acks: 2, ackTitle: "Thumbs up from bob, alice", acked: true, unreadBy: ["api-codex"], mine: true });
    expect(v.tags.map((t) => t.label)).toEqual(["@web", "@api-codex"]);
    expect(postView(g, { ...answer, answered: true, replyTo: "gmsg_01ARZ3NDEKTSV4RRFFQ69G5F99" }, page)).toMatchObject({ awaiting: false, quote: { excerpt: "an earlier post" } });
    const agentPost = postView(g, asked, page);
    expect(agentPost.writer).toEqual({ kind: "agent", name: "bob/api", harness: "claude", title: "bob/api: Claude, bob's" });
    expect(agentPost).toMatchObject({ mine: false, acked: false, ackTitle: "Thumbs up" });
    expect(postView(g, post(5, { from: { kind: "cophyla" }, text: "bob/api joined" }), page).writer.kind).toBe("cophyla");
  });

  test("who has not read a post: the agents it tags, all of them for @agents and @everyone, never its writer or one gone", () => {
    const g = group({ members: [me, web, api, { ...bobs, gone: true }] });
    expect(unreadBy(g, { n: 2, from: { kind: "person", key: "person:usr_alice", user: "alice" }, mentions: [{ all: "agents" }] })).toEqual(["api-codex"]);
    expect(unreadBy(g, { n: 5, from: { kind: "agent", key: `agent:${A}`, session: A, handle: "web", harness: "claude" }, mentions: [{ all: "everyone" }] })).toEqual(["api-codex"]);
    expect(unreadBy(g, { n: 5, from: { kind: "cophyla" }, mentions: [{ all: "users" }] })).toEqual([]);
  });

  test("the members' chips: busy or idle from the session, focus, held, unread, Every post | Tags only and Remove on one's own", () => {
    const state = connected();
    apply(state, { type: "session.state", params: session(A, { status: "busy" }) });
    apply(state, { type: "session.state", params: session(B, { harness: "codex" }) });
    apply(state, { type: "focus.state", params: { session: B, focus: { since: NOW - 60_000, until: NOW + 3_600_000, reason: "migration" } } });
    const g = group({ members: [me, web, { ...api, held: true }, bobs, { ...bobs, key: "agent:gone", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB9", handle: "bob/old", gone: true }, bobPerson] });
    const chips = memberChips(state, g, NOW);
    expect(chips.map((c) => [c.name, c.status])).toEqual([
      ["alice", "person"],
      ["web", "busy"],
      ["api-codex", "idle"],
      ["bob/api", "unknown"],
      ["bob/old", "gone"],
      ["bob", "person"],
    ]);
    expect(chips[0]).toMatchObject({ me: true, removable: false });
    expect(chips[2]).toMatchObject({ held: true, unread: 2, mine: true, notify: "all", removable: true });
    expect(chips[2]!.focus).toBe(focusWords({ until: NOW + 3_600_000, reason: "migration" }));
    expect(chips[2]!.title).toContain("told of every post");
    // the maker may take a teammate's agent out; a member who did not make it, only their own
    expect(chips[3]).toMatchObject({ mine: false, removable: true });
    expect(memberChips(state, group({ by: "bob", members: [me, web, bobs] }), NOW).map((c) => c.removable)).toEqual([false, true, false]);
    // an ended group takes no one out
    expect(memberChips(state, group({ ended: { at: NOW, by: "alice" } }), NOW).some((c) => c.removable)).toBe(false);
  });

  test("the composer offers the tags that start with what follows the @, and writes one in", () => {
    const g = group();
    expect(tagCompletion(g, "hi @", 4)).toEqual({ start: 3, options: ["web", "api-codex", "bob/api", "bob", "agents", "users", "everyone"] });
    expect(tagCompletion(g, "hi @b and more", 5)).toEqual({ start: 3, options: ["bob/api", "bob"] });
    expect(tagCompletion(g, "mail a@b", 8)).toBeUndefined();
    expect(tagCompletion(g, "@everyone", 9)).toBeUndefined();
    expect(tagCompletion(g, "@zz", 3)).toBeUndefined();
    expect(completeTag("hi @b and more", 3, 5, "bob/api")).toEqual({ text: "hi @bob/api  and more", caret: 12 });
  });

  test("New group's picker: the user's own by machine and folder first, teammates' under their login, one in the group left out", () => {
    const cands: GroupCandidate[] = [
      { ref: { session: A }, handle: "web", harness: "claude", workspace: "web", folder: "web", node: DESK, machine: "Desk", status: "busy", intent: "login page" },
      { ref: { session: B }, handle: "api-codex", harness: "codex", folder: "api", node: LAPTOP, machine: "Laptop", status: "idle" },
      { ref: { teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5FE1", name: "api" }, handle: "bob/api", harness: "claude", user: "bob", workspace: "backend", status: "idle" },
    ];
    const groups = candidateGroups(cands);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.handle)])).toEqual([
      ["api · Laptop", ["api-codex"]],
      ["web · Desk", ["web"]],
      ["bob and their agents", ["bob/api"]],
    ]);
    expect(groups[1]!.items[0]).toMatchObject({ key: `s:${A}`, words: "Claude · busy · login page" });
    expect(groups[2]!.items[0]).toMatchObject({ key: "t:tm_01ARZ3NDEKTSV4RRFFQ69G5FE1:api", words: "Claude · idle · backend" });
    expect(candidateGroups(cands, group()).map((g) => g.title)).toEqual([]);
    const made = groupCreateParams({ name: "  release ", purpose: " ", notify: "tags", picked: [`s:${A}`, "t:tm_01ARZ3NDEKTSV4RRFFQ69G5FE1:api"] }, cands);
    expect(made).toEqual({ params: { name: "release", notify: "tags", members: [{ session: A }, { teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5FE1", name: "api" }] } });
    expect(groupCreateParams({ name: " ", purpose: "", notify: "all", picked: [] }, cands)).toEqual({ error: "Name the group." });
  });

  test("a teammate comes first by themselves, and one who is not a teammate of someone in the group or picked is held, saying who", () => {
    const BOB = "tm_01ARZ3NDEKTSV4RRFFQ69G5FE1";
    const CAROL = "tm_01ARZ3NDEKTSV4RRFFQ69G5FE2";
    const DAVE = "tm_01ARZ3NDEKTSV4RRFFQ69G5FE3";
    const cands: GroupCandidate[] = [
      { ref: { teammate: BOB, name: "api" }, handle: "bob/api", session: BOBS, harness: "claude", user: "bob", workspace: "backend", status: "idle", peers: ["carol"] },
      { ref: { teammate: BOB }, handle: "bob", person: true, user: "bob", peers: ["carol"] },
      // a closed agent of carol's comes with no state
      { ref: { teammate: CAROL, name: "deploy" }, handle: "carol/deploy", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FC1", harness: "codex", user: "carol", workspace: "infra", peers: ["bob"] },
      { ref: { teammate: CAROL }, handle: "carol", person: true, user: "carol", peers: ["bob"] },
      { ref: { teammate: DAVE }, handle: "dave", person: true, user: "dave", peers: [] },
      // erin's side could not say who its teammates are
      { ref: { teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5FE4" }, handle: "erin", person: true, user: "erin" },
    ];
    const fresh = candidateGroups(cands);
    expect(fresh.map((g) => [g.title, g.items.map((i) => i.handle), g.blocked])).toEqual([
      ["bob and their agents", ["bob", "bob/api"], undefined],
      ["carol and their agents", ["carol", "carol/deploy"], undefined],
      ["dave and their agents", ["dave"], undefined],
      ["erin and their agents", ["erin"], undefined],
    ]);
    expect(fresh[0]!.items[0]).toMatchObject({ key: `p:${BOB}`, person: true, words: "Just them, without an agent" });
    expect(fresh[1]!.items[1]).toMatchObject({ key: `t:${CAROL}:deploy`, words: "Codex · infra" });
    // bob picked: carol may join him, dave may not, erin's side could not say
    const picked = candidateGroups(cands, undefined, [`t:${BOB}:api`]);
    expect(picked.map((g) => g.blocked)).toEqual([
      undefined,
      undefined,
      "dave is not a teammate of bob, and everyone in a group is a teammate of everyone else.",
      "erin can join a group with bob once their Cophyla is updated.",
    ]);
    // in a group with bob already: bob is not offered again, nor his agent in it, and the same holds
    const g = group();
    const adding = candidateGroups(cands, g);
    expect(adding.find((x) => x.title.startsWith("bob"))).toBeUndefined();
    expect(adding.find((x) => x.title.startsWith("dave"))!.blocked).toContain("dave is not a teammate of bob,");
    expect(adding.find((x) => x.title.startsWith("carol"))!.blocked).toBeUndefined();
    // carol picked too: dave is held for both
    expect(candidateGroups(cands, g, [`p:${CAROL}`]).find((x) => x.title.startsWith("dave"))!.blocked).toBe("dave is not a teammate of bob and carol, and everyone in a group is a teammate of everyone else.");
  });

  test("End asks what ending a teammate does to the groups both are in with someone else", () => {
    const carol: GroupMember = { kind: "person", key: "person:usr_carol", user: "carol", readTo: 0 };
    const mine = { name: "release", by: "alice", members: [me, bobPerson, carol] };
    const theirs = { name: "ops", by: "carol", members: [me, bobPerson, carol] };
    const pair = { name: "pair", by: "alice", members: [me, bobPerson] };
    expect(teamEndWords("bob", [pair])).toBe("End bob as a teammate? Their agents leave every group, and nothing reaches either side any more.");
    expect(teamEndWords("bob", [mine, theirs, pair])).toBe(
      "End bob as a teammate? Their agents leave every group, and nothing reaches either side any more. bob leaves #release and #ops too, for everyone in them, since everyone in a group is a teammate of everyone else.",
    );
    expect(teamEndWords("bob", [theirs])).toContain("bob leaves #ops too, for everyone in it,");
  });

  test("Add members leaves out a teammate's agent in the group under the name it had, by its session", () => {
    // bob renamed his api agent "stick" since it was put in: the same session, a new name
    const renamed: GroupCandidate = { ref: { teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5FE1", name: "stick" }, handle: "bob/stick", session: BOBS, harness: "claude", user: "bob", status: "idle" };
    const other: GroupCandidate = { ref: { teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5FE1", name: "black" }, handle: "bob/black", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FC9", harness: "claude", user: "bob", status: "idle" };
    expect(candidateGroups([renamed, other], group()).flatMap((g) => g.items.map((i) => i.handle))).toEqual(["bob/black"]);
    // a node from before sessions came with a teammate's agents: matched by handle as before
    const { session: _s, ...old } = renamed;
    expect(candidateGroups([old, { ...old, handle: "bob/api", ref: { teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5FE1", name: "api" } }], group()).flatMap((g) => g.items.map((i) => i.handle))).toEqual(["bob/stick"]);
  });

  test("what the user read is told up to the last post loaded, once", () => {
    const g = group();
    expect(readUpTo(g, { posts: [post(1), post(2)] })).toBeUndefined();
    expect(readUpTo(g, { posts: [post(2), post(3)] })).toBe(3);
    expect(readUpTo(g, { posts: [] })).toBeUndefined();
    expect(readUpTo(g, undefined)).toBeUndefined();
  });

  test("an agent's focus while it holds: until when and why", () => {
    const state = connected();
    const at = new Date(2026, 9, 22, 14, 30).getTime();
    apply(state, { type: "focus", focus: [{ session: A, focus: { since: at - 60_000, until: at, reason: "deep work" } }] });
    expect(focusWords(sessionFocus(state, A, at - 1)!)).toBe("Focus until 14:30 — deep work");
    expect(sessionFocus(state, A, at)).toBeUndefined();
    apply(state, { type: "focus.state", params: { session: A } });
    expect(state.focus.size).toBe(0);
  });

  test("an app or a node older than group chats says to update", () => {
    expect(teamworkFailure("unsupported", "unknown method group.list")).toBe("This Cophyla app is older than group chats and teammates: update it, or open it again after an update, then try again.");
    expect(teamworkFailure("unsupported", "the node cannot do teammate.invite")).toBe("Cophyla on this computer is older than group chats and teammates: update it, then try again.");
    expect(teamworkFailure("invalid", "the post tags no member")).toBe("the post tags no member");
  });
});

describe("photos and files in the view", () => {
  test("a post carries its photos and files to the pane, and one with only a photo has no words", () => {
    const g = group();
    const photo = { id: "gph_01ARZ3NDEKTSV4RRFFQ69G5PH1", type: "image/png" as const, bytes: 70, width: 1, height: 1, name: "board.png" };
    const file = { id: "gfile_01ARZ3NDEKTSV4RRFFQ69G5GF1", name: "schema.sql", kind: "file" as const, bytes: 1234, machine: "Desk" };
    const v = postView(g, post(4, { text: "", photos: [photo], files: [file] }), undefined);
    expect(v.text).toBe("");
    expect(v.photos).toEqual([photo]);
    expect(v.files).toEqual([file]);
    expect(postView(g, post(5), undefined)).toMatchObject({ photos: [], files: [] });
  });

  test("the composer posts once every attachment is there: an upload done, a path as it is; one that failed or still goes says so", () => {
    expect(attachParams([])).toEqual({ photos: [], files: [] });
    expect(
      attachParams([
        { key: "a1", kind: "photo", name: "board.jpg", upload: "upl_01ARZ3NDEKTSV4RRFFQ69G5XP1", done: true },
        { key: "a2", kind: "file", name: "schema.sql", node: DESK, path: "C:\work\schema.sql" },
      ]),
    ).toEqual({ photos: [{ upload: "upl_01ARZ3NDEKTSV4RRFFQ69G5XP1" }], files: [{ node: DESK, path: "C:\work\schema.sql" }] });
    expect(attachParams([{ key: "a1", kind: "file", name: "big.iso", upload: "upl_01ARZ3NDEKTSV4RRFFQ69G5XP1", sent: 10, bytes: 100 }])).toEqual({ wait: "big.iso is still uploading" });
    expect(attachParams([{ key: "a1", kind: "photo", name: "x.heic", error: "this kind of image cannot be read here: attach it as a file" }])).toEqual({ wait: "x.heic: this kind of image cannot be read here: attach it as a file. Take it off to post." });
    expect(isImagePath("C:\shots\Screen Shot.PNG")).toBe(true);
    expect(isImagePath("/home/me/IMG_0001.heic")).toBe(true);
    expect(isImagePath("/home/me/report.pdf")).toBe(false);
    expect(toBase64(new Uint8Array([1, 2, 3, 250]))).toBe(Buffer.from([1, 2, 3, 250]).toString("base64"));
  });

  test("an app or a node older than photos and files in group chats is named as the one to update", () => {
    expect(teamworkFailure("unsupported", "unknown method group.upload")).toContain("This Cophyla app is older than photos and files");
    expect(teamworkFailure("unsupported", "unsupported: group.photo")).toContain("Cophyla on this computer is older than photos and files");
  });
});
