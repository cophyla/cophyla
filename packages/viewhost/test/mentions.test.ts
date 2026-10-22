// A tag of the user in a group chat on an OS notification: a new post naming the user's person,
// @users or @everyone, or answering one of theirs, is toasted once per group, a later one in
// its place; never the user's own post, an old one met first after a reconnect, one already
// read, nor a post that only changed. A group's state that says the user read that far, left or
// ended takes the toast down. A post that comes before its group's state waits for it. Only
// where someone is at the machine.

import { describe, expect, test } from "bun:test";
import type { Group, GroupPost, RpcNotification } from "@cophyla/protocol";
import { MentionNotifier, mentionToastId } from "../src/mentions.ts";
import type { NotifyAsk } from "../src/notify.ts";

const n = (method: string, params: unknown): RpcNotification => ({ jsonrpc: "2.0", method, params });
const G = "grp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = 1_758_000_000_000;
const ME = "person:usr_ME";

function group(readTo = 0, extra: Partial<Group> = {}): Group {
  return {
    id: G,
    name: "release",
    by: "ferit",
    notify: "tags",
    members: [
      { kind: "person", key: ME, user: "ferit", readTo, me: true },
      { kind: "person", key: "person:usr_BOB", user: "bob", readTo: 0 },
    ],
    unread: 0,
    tagged: 0,
    createdAt: 1,
    ...extra,
  } as Group;
}

let ids = 0;
function post(nr: number, extra: Partial<GroupPost> = {}): GroupPost {
  return {
    id: `gmsg_01ARZ3NDEKTSV4RRFFQ69G5F${String(ids++).padStart(2, "0")}`,
    group: G,
    n: nr,
    from: { kind: "agent", key: "agent:sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", user: "bob", handle: "bob/api", harness: "claude" },
    text: "@ferit the build is green",
    mentions: [{ member: ME }],
    acks: [],
    at: NOW,
    ...extra,
  } as GroupPost;
}

function rig(idle: number | undefined = 0) {
  const shown: NotifyAsk[] = [];
  const dismissed: string[] = [];
  const m = new MentionNotifier({
    notify: async (t) => void shown.push(t),
    dismiss: async (id) => void dismissed.push(id),
    idleMs: async () => idle,
    now: () => NOW,
  });
  return { m, shown, dismissed };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("a tag of the user in a group", () => {
  test("is toasted once, with no buttons, under who wrote it and the group", async () => {
    const r = rig();
    r.m.onNotification(n("group.state", group()));
    r.m.onNotification(n("group.posted", { group: G, post: post(1) }));
    await settle();
    expect(r.shown).toEqual([{ id: mentionToastId(G), title: "bob/api tagged you in #release", detail: "@ferit the build is green", options: [], multiple: true }]);
    // the same post again, with a thumbs up: not new
    r.m.onNotification(n("group.posted", { group: G, post: { ...post(1), acks: ["person:usr_BOB"] } }));
    await settle();
    expect(r.shown).toHaveLength(1);
  });

  test("@users, @everyone and a reply to the user's post count; an untagged post and the user's own do not", async () => {
    const r = rig();
    r.m.onNotification(n("group.state", group()));
    const mine = post(1, { from: { kind: "person", key: ME, user: "ferit" }, mentions: [] });
    r.m.onNotification(n("group.posted", { group: G, post: mine }));
    r.m.onNotification(n("group.posted", { group: G, post: post(2, { mentions: [] }) }));
    await settle();
    expect(r.shown).toHaveLength(0);
    r.m.onNotification(n("group.posted", { group: G, post: post(3, { mentions: [], replyTo: mine.id }) }));
    await settle();
    expect(r.shown).toHaveLength(1);
    r.m.onNotification(n("group.posted", { group: G, post: post(4, { mentions: [{ all: "everyone" }] }) }));
    r.m.onNotification(n("group.posted", { group: G, post: post(5, { mentions: [{ all: "users" }] }) }));
    await settle();
    expect(r.shown).toHaveLength(3);
    // a later toast takes the group's earlier one's place
    expect(r.dismissed).toEqual([mentionToastId(G), mentionToastId(G)]);
  });

  test("read that far, left or ended: the toast comes down; read already: none goes up", async () => {
    const r = rig();
    r.m.onNotification(n("group.state", group()));
    r.m.onNotification(n("group.posted", { group: G, post: post(1) }));
    await settle();
    r.m.onNotification(n("group.state", group(1)));
    expect(r.dismissed).toEqual([mentionToastId(G)]);
    r.m.onNotification(n("group.state", group(5)));
    r.m.onNotification(n("group.posted", { group: G, post: post(4) }));
    await settle();
    expect(r.shown).toHaveLength(1);
    r.m.onNotification(n("group.posted", { group: G, post: post(6) }));
    await settle();
    r.m.onNotification(n("group.state", { ...group(5), left: true }));
    expect(r.dismissed).toHaveLength(2);
  });

  test("a post before its group's state waits for it; an old one met first is not new; no one here, no toast", async () => {
    const r = rig();
    r.m.onNotification(n("group.posted", { group: G, post: post(7) }));
    await settle();
    expect(r.shown).toHaveLength(0);
    r.m.onNotification(n("group.state", group()));
    await settle();
    expect(r.shown).toHaveLength(1);

    const old = rig();
    old.m.onNotification(n("group.state", group()));
    old.m.onNotification(n("group.posted", { group: G, post: post(3, { at: NOW - 10 * 60_000 }) }));
    await settle();
    expect(old.shown).toHaveLength(0);

    const away = rig(5 * 60_000);
    away.m.onNotification(n("group.state", group()));
    away.m.onNotification(n("group.posted", { group: G, post: post(1) }));
    await settle();
    expect(away.shown).toHaveLength(0);
  });
});
