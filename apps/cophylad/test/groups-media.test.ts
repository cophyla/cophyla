// Photos and files in group chats, the groups module over a real store, bus and gate, the
// agents' router in front of it, a teammate's side played by a stub. Covered: the app's upload a
// piece at a time, a photo and a file posted from it; an agent shown the photos it reads as
// images and a file by its id; a photo and a file attached by their paths, made where they are;
// an agent's post with photos or files into a group with another person asked first unless the
// agent runs without prompts, and what crosses to the other side naming no machine; another
// side's photo fetched from it and kept; a copy of a file saved from where it is, through the
// teammate when it is theirs; a group deleted taking its photos with it.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import type { GroupEntry, GroupPhoto, Session, TeamAgent } from "@cophyla/protocol";
import type { EnvelopeInfo } from "../src/agentmsg/envelope.ts";
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
import type { GroupTeams, SaveStart } from "../src/groups/index.ts";
import { GroupMedia } from "../src/groups/media.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { PNG_1X1 } from "./images.ts";
import { tempHome, waitFor } from "./helpers.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TM = "tm_01ARZ3NDEKTSV4RRFFQ69G5TM1";
const BOB_SESS = "sess_01ARZ3NDEKTSV4RRFFQ69G5BB1";
const USER = { kind: "user" as const, client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FC7" };

let started = 1_000;
function sess(cwd: string): Session {
  return { id: newId("session"), node: DESK, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: crypto.randomUUID(), transport: "pipe", pid: 5000 + started }, origin: "user", cwd, tags: [], status: "idle", startedAt: started++, lastActivity: 0 };
}

function rig(local: Session[], opts: { bypass?: boolean } = {}) {
  const home = tempHome();
  const config = Config.parse({});
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, DESK, bus);
  const audit = new Audit(store, DESK, config.gate.audit_result_cap, bus);
  const policy = new Policy(config.gate, store);
  const gate = new Gate({ config: config.gate, policy, asks, audit, log: silentLogger });
  const delivered: { session: string; text: string; info: EnvelopeInfo }[] = [];
  const entries: { group: string; seq: number; entry: GroupEntry }[] = [];
  const started: SaveStart[] = [];
  const madeFrom: { node: string; path: string }[] = [];
  const theirPhotos = new Map<string, Uint8Array>();
  const sessions: AgentSessions = {
    list: () => local,
    get: (id) => local.find((s) => s.id === id),
    send: async () => ({ status: "queued" }),
    codexThread: () => undefined,
    claudeSession: () => undefined,
    byPipe: () => undefined,
    byPid: (pid) => local.find((s) => s.native.pid === pid),
    byNonce: () => undefined,
    byTerminal: () => undefined,
    bypasses: () => opts.bypass === true,
    acceptsInbound: () => false,
  };
  let groups: Groups;
  const deliver = async (s: Session, text: string, info: EnvelopeInfo) => {
    delivered.push({ session: s.id, text, info });
    return { status: "queued" as const };
  };
  const focus = new Focuses({ store, bus, log: silentLogger, routes: () => true, sessions: () => local, deliver, linked: () => true, ended: (s, told) => groups.focusEnded(s, told), sweepMs: 60_000 });
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
  });
  const bobWeb: TeamAgent = { session: BOB_SESS, name: "web", harness: "claude", workspace: "web" };
  const teams: GroupTeams = {
    teammateOf: (owner) => (owner === "usr_BOB" ? { id: TM, user: "bob" } : undefined),
    teammate: (id) => (id === TM ? { owner: "usr_BOB", user: "bob" } : undefined),
    agents: async () => [bobWeb],
    openTo: () => true,
    send: async (_t, group, seq, entry) => (entries.push({ group, seq, entry }), true),
    sync: async () => undefined,
    photo: async (_t, _g, photo, at) => {
      const bytes = theirPhotos.get(photo);
      if (!bytes) throw new Error("no such photo");
      return { type: "image/png", data: Buffer.from(bytes.subarray(at)).toString("base64"), at, total: bytes.length };
    },
  };
  const media = new GroupMedia(join(home, "data"), silentLogger);
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
    teams: () => teams,
    media,
    selfId: () => DESK,
    photoFrom: async (node, path) => {
      madeFrom.push({ node, path });
      return { type: "image/png", width: 1, height: 1, bytes: PNG_1X1, name: path.split("/").pop()! };
    },
    peek: async (_node, path) => ({ kind: "file", name: path.split("/").pop()!, total: 1234, files: 1 }),
    resolvePath: (_n, cwd, path) => (path.startsWith("/") || /^[A-Z]:/.test(path) ? path : `${cwd}/${path}`),
    start: async (p) => {
      started.push(p);
      return { transfer: { id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", from: p.from, to: { node: p.to.node, dir: p.to.dir ?? "/home/me/Downloads" }, kind: "file", name: "x", total: 1, bytes: 0, state: "queued", by: p.by, startedAt: 1 } };
    },
    sweepMs: 60_000,
  });
  media.init();
  focus.start();
  groups.start();
  const call = async (caller: Session, tool: string, args: Record<string, unknown>) => {
    const answer = (await router.mcp({ harness: caller.harness, ppid: caller.native.pid! }, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: tool, arguments: args } })) as {
      result: { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
    };
    const text = answer.result.content.find((c) => c.type === "text") as { text: string };
    const images = answer.result.content.filter((c) => c.type === "image") as { data: string; mimeType: string }[];
    return { text: text.text, images, ...(answer.result.isError ? { isError: true } : {}) };
  };
  const stop = () => {
    groups.stop();
    focus.stop();
  };
  return { home, store, groups, media, asks, delivered, entries, started, madeFrom, theirPhotos, call, stop };
}

/** An upload of `bytes` in two pieces, as the app sends them. */
async function upload(g: Groups, group: string, name: string, bytes: Uint8Array, photo = false): Promise<string> {
  const cut = Math.max(1, Math.floor(bytes.length / 2));
  const first = await g.upload({ group, name, size: bytes.length, at: 0, data: Buffer.from(bytes.subarray(0, cut)).toString("base64"), ...(photo ? { photo: true } : {}) });
  const rest = await g.upload({ group, upload: first.upload, name, size: bytes.length, at: cut, data: Buffer.from(bytes.subarray(cut)).toString("base64") });
  expect(rest.received).toBe(bytes.length);
  return first.upload;
}

describe("photos and files in a group chat", () => {
  test("the app's photo and file, uploaded a piece at a time; an agent reading is shown the photo and told the file's id", async () => {
    const api = sess("C:/code/api");
    const r = rig([api]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }] });
      const up = await upload(r.groups, g.id, "whiteboard.png", PNG_1X1, true);
      const photoPost = await r.groups.postAsUser(g.id, undefined, undefined, { photos: [{ upload: up }] });
      expect(photoPost.text).toBe("");
      expect(photoPost.photos).toEqual([{ id: expect.stringMatching(/^gph_/), type: "image/png", bytes: PNG_1X1.length, width: 1, height: 1, name: "whiteboard.png" }]);
      const read = await r.groups.photo(g.id, photoPost.photos![0]!.id);
      expect(Buffer.from(read.base64, "base64").equals(PNG_1X1)).toBe(true);
      expect(read).toMatchObject({ type: "image/png", at: 0, total: PNG_1X1.length });

      const notes = Buffer.from("the release notes\n");
      const upFile = await upload(r.groups, g.id, "notes.txt", notes);
      const filePost = await r.groups.postAsUser(g.id, "@api-claude the notes", undefined, { files: [{ upload: upFile }] });
      expect(filePost.files).toEqual([{ id: expect.stringMatching(/^gfile_/), name: "notes.txt", kind: "file", bytes: notes.length, machine: "Desk" }]);
      // kept on the primary, where a copy is saved from
      const saved = await r.groups.save(g.id, filePost.id, filePost.files![0]!.id, { node: DESK, dir: "C:/Users/me/Desktop" }, { by: { kind: "user" } });
      expect(saved.transfer).toBeDefined();
      expect(r.started[0]).toMatchObject({ from: { node: DESK }, to: { node: DESK, dir: "C:/Users/me/Desktop" }, reason: "posted in #release by ferit", by: { kind: "user" } });
      expect(r.started[0]!.from.path.endsWith(join(filePost.files![0]!.id, "notes.txt"))).toBe(true);
      expect(r.started[0]!.peer).toBeUndefined();

      // the agent reads: the photo is shown, the file named with its id
      const out = await r.call(api, "read_group", { group: "release" });
      expect(out.images).toEqual([{ type: "image", data: PNG_1X1.toString("base64"), mimeType: "image/png" } as never]);
      expect(out.text).toContain("photo: whiteboard.png (1×1, shown below)");
      expect(out.text).toContain(`notes.txt (${notes.length} B) ${filePost.files![0]!.id}; get_file copies one to your machine`);

      // a photo upload that is no image is refused, and an empty post too
      const bad = await upload(r.groups, g.id, "fake.png", Buffer.from("not an image"), true);
      await expect(r.groups.postAsUser(g.id, "look", undefined, { photos: [{ upload: bad }] })).rejects.toThrow("not a JPEG, PNG, WebP or GIF");
      await expect(r.groups.postAsUser(g.id, "  ")).rejects.toThrow("the post is empty");
      await expect(r.groups.upload({ group: g.id, upload: up, name: "x", size: 10, at: 0, data: "AA==" })).rejects.toThrow("no such upload");
    } finally {
      r.stop();
    }
  });

  test("an agent's photos and files by their paths, made where they are; with another person in the group, asked first", async () => {
    const api = sess("C:/code/api");
    const r = rig([api]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }] });
      // the user's own group: no ask
      const own = await r.call(api, "post_group", { group: "release", text: "the build", expects_reply: false, photos: ["out/shot.png"], files: ["C:/code/api/schema.sql"] });
      expect(own.isError).toBeUndefined();
      expect(own.text).toContain("Posted in #release");
      expect(r.madeFrom).toEqual([{ node: DESK, path: "C:/code/api/out/shot.png" }]);
      const posts = r.groups.posts(g.id).posts;
      expect(posts.at(-1)!.files).toEqual([{ id: expect.stringMatching(/^gfile_/), name: "schema.sql", kind: "file", bytes: 1234, machine: "Desk" }]);
      expect(r.asks.listOpen()).toEqual([]);

      // bob joins: a post that carries photos or files is asked about, and goes once allowed
      await r.groups.addMembers(g.id, [{ teammate: TM, name: "web" }]);
      const pending = r.call(api, "post_group", { group: "release", text: "the schema", expects_reply: false, files: ["schema.sql"] });
      const ask = await waitFor(() => r.asks.listOpen()[0]);
      expect(ask.title).toBe("Let api-claude post 1 file in #release?");
      expect(ask.detail).toContain("bob is in it and may see and copy them");
      r.asks.answer(ask.id, { option: "allow" }, USER);
      expect((await pending).text).toContain("Posted in #release");
      // what crosses to bob's side names no machine and no path
      const post = r.entries.map((e) => e.entry).find((e) => e.kind === "post" && e.post.text === "the schema");
      expect(post).toBeDefined();
      const crossed = JSON.stringify(post);
      expect(crossed).not.toContain("C:/code/api");
      expect(crossed).not.toContain("Desk");
      expect(crossed).toContain("schema.sql");
      // text alone is never asked about
      const words = await r.call(api, "post_group", { group: "release", text: "only words", expects_reply: false });
      expect(words.text).toContain("Posted in #release");
    } finally {
      r.stop();
    }
  });

  test("an agent that runs without prompts posts photos to a group with another person unasked", async () => {
    const api = sess("C:/code/api");
    const r = rig([api], { bypass: true });
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }] });
      await r.groups.addMembers(g.id, [{ teammate: TM, name: "web" }]);
      const out = await r.call(api, "post_group", { group: "release", text: "", expects_reply: false, photos: ["shot.png"] });
      expect(out.text).toContain("Posted in #release");
      expect(r.asks.listOpen()).toEqual([]);
    } finally {
      r.stop();
    }
  });

  test("another side's photo is fetched from it and kept; a copy of its file is saved through the teammate; a group deleted takes its photos", async () => {
    const api = sess("C:/code/api");
    const r = rig([api]);
    try {
      const g = await r.groups.create({ name: "release", members: [{ session: api.id }] });
      await r.groups.addMembers(g.id, [{ teammate: TM, name: "web" }]);
      const photo: GroupPhoto = { id: newId("groupPhoto"), type: "image/png", bytes: PNG_1X1.length, width: 1, height: 1, name: "theirs.png" };
      r.theirPhotos.set(photo.id, PNG_1X1);
      const fileId = newId("groupFile");
      const postId = newId("groupPost");
      // bob's side hands the group over, then posts
      await r.groups.take("usr_BOB", g.id, 1, { kind: "snapshot", group: { id: g.id, name: "release", by: "ferit", notify: "tags", createdAt: 1, members: [], posts: [] } }, 1);
      await r.groups.take(
        "usr_BOB",
        g.id,
        2,
        { kind: "post", post: { id: postId, from: { kind: "agent", key: `agent:${BOB_SESS}`, session: BOB_SESS, user: "bob", name: "web", harness: "claude" }, text: "look", mentions: [], photos: [photo], files: [{ id: fileId, name: "dump.sql", kind: "file", bytes: 99 }], at: Date.now() } },
        Date.now(),
      );
      await waitFor(() => r.media.hasPhoto(g.id, photo.id));
      const theirs = r.groups.posts(g.id).posts.find((p) => p.id === postId)!;
      // another side's file names no machine here
      expect(theirs.files).toEqual([{ id: fileId, name: "dump.sql", kind: "file", bytes: 99 }]);
      await r.groups.save(g.id, postId, fileId, { node: DESK }, { by: { kind: "user" } });
      expect(r.started.at(-1)).toMatchObject({ from: { node: DESK, path: "dump.sql" }, peer: { kind: "teammate", id: TM, file: fileId, group: g.id, user: "bob", agent: "web" } });
      // bob's side may read this side's own files alone
      expect(() => r.groups.fileSource("usr_BOB", g.id, fileId)).toThrow("no such file of this side's");
      expect(() => r.groups.fileSource("usr_NOBODY", g.id, fileId)).toThrow("no such group with you in it");
      // a photo of bob's not here yet is fetched when the app asks for it
      const later: GroupPhoto = { ...photo, id: newId("groupPhoto") };
      r.theirPhotos.set(later.id, PNG_1X1);
      await r.groups.take("usr_BOB", g.id, 3, { kind: "post", post: { id: newId("groupPost"), from: { kind: "person", key: "person:usr_BOB", user: "bob" }, text: "", mentions: [], photos: [later], at: Date.now() } }, Date.now());
      const got = await r.groups.photo(g.id, later.id);
      expect(Buffer.from(got.base64, "base64").equals(PNG_1X1)).toBe(true);

      r.groups.delete(g.id);
      expect(existsSync(join(r.home, "data", "groups", "photos", g.id))).toBe(false);
      expect(readdirSync(join(r.home, "data", "groups"))).not.toContain(g.id);
    } finally {
      r.stop();
    }
  });
});
