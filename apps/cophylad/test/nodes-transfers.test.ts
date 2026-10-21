// Transfers across nodes: three daemons on one machine, a primary and two secondaries linked
// over the LAN. A client of the primary sends a file and a folder from one machine to another:
// the receiving machine pulls them through the pipes, from the primary, from a secondary, and
// from one secondary to the other through the primary; every client sees the rows, and the
// merged list has them all. What lands takes a free name beside what is there. A link that
// drops mid-file leaves the transfer waiting, and it goes on from where it stopped once the
// link is back; a cancel deletes what came; a confined node sends and receives only inside
// the folders it shares; a hands node sends and receives too, pulling only what its primary
// sent it; a big one over a relayed hop waits for the user's word.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcNotification, Transfer } from "@cophyla/protocol";
import { HANDS_PULLS_NS, HandsPulls } from "../src/nodes/transfers.ts";
import type { FileTarget } from "../src/remote/pipes.ts";
import { removeHome, tempHome, TestClient, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function rowOf(c: TestClient, id: string, pred: (t: Transfer) => boolean = () => true): Promise<Transfer> {
  return c.next((n: RpcNotification) => n.method === "transfer.state" && (n.params as Transfer).id === id && pred(n.params as Transfer), 20_000).then((n) => n.params as Transfer);
}

const ended = (t: Transfer) => t.state === "done" || t.state === "failed" || t.state === "cancelled";

/** Bytes whose every word is its own offset: a resume at the wrong place shows. */
function counted(n: number): Uint8Array {
  const words = new Uint32Array(Math.ceil(n / 4));
  for (let i = 0; i < words.length; i++) words[i] = i;
  return new Uint8Array(words.buffer, 0, n);
}

const FAST = { transfers: { backoff: { firstMs: 100, maxMs: 400 }, relayConfirmBytes: 1000 } };
/** Heartbeats at a second, as remote-forward's: a pipe pumping in the same process must not stall a slow runner's links past them. */
const BEAT = 1000;

describe("transfers across nodes", () => {
  let scratch: string;
  let primary: Primary;
  let a: Started;
  let b: Started;
  let c: TestClient;
  const shown: [string, string][] = [];

  beforeAll(async () => {
    scratch = tempHome();
    primary = await startPrimary({ heartbeatMs: BEAT, daemon: { ...FAST, revealer: async (path, kind) => void shown.push([path, kind]) } });
    a = await startSecondary(primary, { heartbeatMs: BEAT, daemon: FAST });
    b = await startSecondary(primary, { heartbeatMs: BEAT, daemon: FAST });
    await linked(a);
    await linked(b);
    c = await client(primary.d);
    await waitFor(() => primary.d.nodes.registry.get(a.identity.id)?.capabilities.files && primary.d.nodes.registry.get(b.identity.id)?.capabilities.files);
    await waitFor(() => b.nodes.registry.get(a.identity.id)?.status === "online" && a.nodes.registry.get(b.identity.id)?.status === "online");
  }, 60_000);

  afterAll(async () => {
    c?.close();
    await stopAll(a, b, primary?.d);
    removeHome(scratch);
  });

  test("every full node says it takes files", () => {
    expect(primary.d.nodes.registry.get(primary.d.identity.id)?.capabilities.files).toBe(true);
    expect(a.nodes.registry.get(a.identity.id)?.capabilities.files).toBe(true);
  });

  test("a file from the primary lands on a secondary, whole, and the merged list has it", async () => {
    const src = join(scratch, "from-primary");
    mkdirSync(src, { recursive: true });
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    writeFileSync(join(src, "build.zip"), bytes);
    const dir = join(scratch, "a-in");
    const r = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: primary.d.identity.id, path: join(src, "build.zip") }, to: { node: a.identity.id, dir } });
    expect(r.transfer.to.node).toBe(a.identity.id);
    expect(r.transfer.by).toEqual({ kind: "user" });
    const done = await rowOf(c, r.transfer.id, ended);
    expect(done.state).toBe("done");
    expect(done.to.path).toBe(join(dir, "build.zip"));
    expect(done.bytes).toBe(bytes.length);
    expect(sha(readFileSync(join(dir, "build.zip")))).toBe(sha(bytes));
    const list = await c.request<{ transfers: Transfer[] }>("transfer.list", {});
    expect(list.transfers.find((t) => t.id === r.transfer.id)?.state).toBe("done");
  }, 30_000);

  test("a folder from one secondary reaches the other through the primary, its empty folders kept, beside what is there", async () => {
    const src = join(scratch, "on-a", "dist");
    mkdirSync(join(src, "assets", "img"), { recursive: true });
    mkdirSync(join(src, "empty"), { recursive: true });
    writeFileSync(join(src, "index.html"), "<p>hi</p>");
    const big = randomBytes(1024 * 1024 + 3);
    writeFileSync(join(src, "assets", "app.js"), big);
    writeFileSync(join(src, "assets", "img", "zero.png"), new Uint8Array(0));
    const dir = join(scratch, "b-in");
    mkdirSync(join(dir, "dist"), { recursive: true });
    const r = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: a.identity.id, path: src }, to: { node: b.identity.id, dir } });
    expect(r.transfer.kind).toBe("folder");
    expect(r.transfer.files).toEqual({ done: 0, total: 3 });
    const done = await rowOf(c, r.transfer.id, ended);
    expect(done.state).toBe("done");
    expect(done.to.path).toBe(join(dir, "dist (1)"));
    expect(done.files).toEqual({ done: 3, total: 3 });
    const landed = join(dir, "dist (1)");
    expect(readFileSync(join(landed, "index.html"), "utf8")).toBe("<p>hi</p>");
    expect(sha(readFileSync(join(landed, "assets", "app.js")))).toBe(sha(big));
    expect(readFileSync(join(landed, "assets", "img", "zero.png")).length).toBe(0);
    expect(existsSync(join(landed, "empty"))).toBe(true);
    // no partial left behind
    expect(readdirSync(dir).filter((n) => n.endsWith(".cophyla-part"))).toEqual([]);
  }, 30_000);

  test("a file from a secondary lands on the primary", async () => {
    const src = join(scratch, "on-b");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "notes.txt"), "from b");
    const dir = join(scratch, "p-in");
    const r = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: b.identity.id, path: join(src, "notes.txt") }, to: { node: primary.d.identity.id, dir } });
    const done = await rowOf(c, r.transfer.id, ended);
    expect(done.state).toBe("done");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("from b");
    // the desktop app here shows it in the file manager; an app that is not on this computer may not
    expect(await c.request<Record<string, unknown>>("transfer.reveal", { id: r.transfer.id })).toEqual({});
    expect(shown).toEqual([[join(dir, "notes.txt"), "file"]]);
    const elsewhere = await TestClient.connect(primary.d.api.url);
    try {
      await elsewhere.hello(primary.d.token, { node: a.identity.id });
      const refused = await elsewhere.call("transfer.reveal", { id: r.transfer.id });
      expect("error" in refused && (refused.error.data as { code: string }).code).toBe("unsupported");
    } finally {
      elsewhere.close();
    }
  }, 30_000);

  test("one that landed on another machine is not shown here", async () => {
    const src = join(scratch, "reveal-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "x.txt"), "x");
    const r = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: primary.d.identity.id, path: join(src, "x.txt") }, to: { node: a.identity.id, dir: join(scratch, "a-reveal") } });
    expect((await rowOf(c, r.transfer.id, ended)).state).toBe("done");
    const refused = await c.call("transfer.reveal", { id: r.transfer.id });
    expect("error" in refused && (refused.error.data as { code: string }).code).toBe("not_found");
  }, 30_000);

  test("Send to…'s picker lists a secondary's folders, though it runs no terminals", async () => {
    const home = join(scratch, "pick");
    mkdirSync(join(home, "Downloads"), { recursive: true });
    const pick = await c.request<{ path: string; folders: { name: string }[] }>("terminal.folders", { node: a.identity.id, path: home });
    expect(pick.path).toBe(home);
    expect(pick.folders.map((f) => f.name)).toContain("Downloads");
  }, 30_000);

  test("the sending machine's link drops mid-file: the transfer waits, then goes on from where it stopped", async () => {
    const src = join(scratch, "on-a-big");
    mkdirSync(src, { recursive: true });
    const bytes = counted(32 * 1024 * 1024);
    writeFileSync(join(src, "disk.img"), bytes);
    const dir = join(scratch, "b-big");
    // every file pipe b opens, and from where
    const opened: number[] = [];
    const open = b.pipes.openForFile.bind(b.pipes);
    b.pipes.openForFile = (node: string, target: FileTarget, near) => {
      opened.push(target.at);
      return open(node, target, near);
    };
    try {
      const r = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: a.identity.id, path: join(src, "disk.img") }, to: { node: b.identity.id, dir } });
      await waitFor(() => (b.transfers.get(r.transfer.id)?.bytes ?? 0) > 4 * 1024 * 1024, 20_000, 2);
      const at = b.transfers.get(r.transfer.id)!.bytes;
      expect(at).toBeLessThan(bytes.length);
      // the primary's side of a's link goes
      (primary.d.nodes as unknown as { inbound: { peer(id: string): { close(code: number, reason: string): void } | undefined } }).inbound.peer(a.identity.id)!.close(4000, "dropped by the test");
      await rowOf(c, r.transfer.id, (t) => t.state === "waiting");
      const done = await rowOf(c, r.transfer.id, ended);
      expect(done.state).toBe("done");
      expect(sha(readFileSync(join(dir, "disk.img")))).toBe(sha(bytes));
      // it went on from what had come, never from nothing
      expect(opened[0]).toBe(0);
      expect(opened.length).toBeGreaterThan(1);
      expect(opened.slice(1).every((n) => n > 0)).toBe(true);
    } finally {
      b.pipes.openForFile = open;
    }
    await linked(a);
  }, 60_000);

  test("a cancel stops it and deletes what came", async () => {
    await waitFor(() => primary.d.nodes.linkedTo(a.identity.id) && primary.d.nodes.linkedTo(b.identity.id) && b.nodes.registry.get(a.identity.id)?.status === "online", 10_000);
    const src = join(scratch, "on-a-cancel");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "big.bin"), counted(32 * 1024 * 1024));
    const dir = join(scratch, "b-cancel");
    const r = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: a.identity.id, path: join(src, "big.bin") }, to: { node: b.identity.id, dir } });
    await waitFor(() => (b.transfers.get(r.transfer.id)?.bytes ?? 0) > 0, 20_000, 2);
    await c.request("transfer.cancel", { id: r.transfer.id });
    const row = await rowOf(c, r.transfer.id, ended);
    expect(row.state).toBe("cancelled");
    expect(readdirSync(dir)).toEqual([]);
    // gone from the list once dismissed, for every client
    await c.request("transfer.dismiss", { id: r.transfer.id });
    await rowOf(c, r.transfer.id, (t) => t.dismissed === true);
    const list = await c.request<{ transfers: Transfer[] }>("transfer.list", {});
    expect(list.transfers.some((t) => t.id === r.transfer.id)).toBe(false);
  }, 60_000);

  test("over the threshold with a hop on the relay, a start waits for the user's word", async () => {
    const src = join(scratch, "on-a-relay");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "movie.mkv"), counted(4096));
    const dir = join(scratch, "b-relay");
    const row = b.nodes.registry.get(a.identity.id)!;
    b.nodes.registry.take([{ ...row, via: "relay" }]);
    try {
      const params = { from: { node: a.identity.id, path: join(src, "movie.mkv") }, to: { node: b.identity.id, dir } };
      const asked = await c.request<{ transfer?: Transfer; confirm?: { bytes: number; relayHops: string[] } }>("transfer.start", params);
      expect(asked.transfer).toBeUndefined();
      expect(asked.confirm).toEqual({ bytes: 4096, relayHops: [a.identity.id] });
      const r = await c.request<{ transfer: Transfer }>("transfer.start", { ...params, relayOk: true });
      expect(r.transfer.via).toBe("relay");
      expect((await rowOf(c, r.transfer.id, ended)).state).toBe("done");
      // with a data channel under the relay, nothing is asked
      b.nodes.registry.take([{ ...row, via: "relay", p2p: { path: "host", since: Date.now() } }]);
      const direct = await c.request<{ transfer: Transfer }>("transfer.start", params);
      expect(direct.transfer?.via).toBe("direct");
      expect((await rowOf(c, direct.transfer!.id, ended)).state).toBe("done");
    } finally {
      b.nodes.registry.take([row]);
    }
  }, 30_000);

  test("a machine on an older Cophyla is told to update, and a path that is not there fails at the start", async () => {
    const row = b.nodes.registry.get(a.identity.id)!;
    b.nodes.registry.take([{ ...row, capabilities: { ...row.capabilities, files: false } }]);
    try {
      const r = await c.call("transfer.start", { from: { node: a.identity.id, path: join(scratch, "x") }, to: { node: b.identity.id, dir: join(scratch, "b-old") } });
      expect("error" in r && r.error.message).toContain("runs an older Cophyla");
    } finally {
      b.nodes.registry.take([row]);
    }
    const missing = await c.call("transfer.start", { from: { node: a.identity.id, path: join(scratch, "no-such-file") }, to: { node: b.identity.id, dir: join(scratch, "b-old") } });
    expect("error" in missing && missing.error.data?.code).toBe("not_found");
  }, 30_000);
});

describe("a confined node and a hands node", () => {
  let scratch: string;
  let primary: Primary;
  let conf: Started;
  let hands: Started;
  let c: TestClient;
  let shared: string;

  beforeAll(async () => {
    scratch = tempHome();
    shared = join(scratch, "shared");
    mkdirSync(shared, { recursive: true });
    primary = await startPrimary({ heartbeatMs: BEAT, daemon: FAST });
    conf = await startSecondary(primary, { heartbeatMs: BEAT, daemon: FAST, paths: [shared] });
    hands = await startSecondary(primary, { heartbeatMs: BEAT, daemon: FAST, hands: true });
    await linked(conf);
    await linked(hands);
    c = await client(primary.d);
    await waitFor(() => primary.d.nodes.registry.get(conf.identity.id)?.capabilities.files && primary.d.nodes.registry.get(hands.identity.id) !== undefined);
  }, 60_000);

  afterAll(async () => {
    c?.close();
    await stopAll(conf, hands, primary?.d);
    removeHome(scratch);
  });

  test("a confined node receives into the folders it shares alone, and sends from them alone", async () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "not shared");
    writeFileSync(join(shared, "ok.txt"), "shared");
    const src = join(scratch, "p-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "in.txt"), "in");
    const into = await c.call("transfer.start", { from: { node: primary.d.identity.id, path: join(src, "in.txt") }, to: { node: conf.identity.id, dir: outside } });
    expect("error" in into && into.error.data?.code).toBe("denied");
    const ok = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: primary.d.identity.id, path: join(src, "in.txt") }, to: { node: conf.identity.id, dir: join(shared, "inbox") } });
    expect((await rowOf(c, ok.transfer.id, ended)).state).toBe("done");
    expect(readFileSync(join(shared, "inbox", "in.txt"), "utf8")).toBe("in");
    const out = await c.call("transfer.start", { from: { node: conf.identity.id, path: join(outside, "secret.txt") }, to: { node: primary.d.identity.id, dir: join(scratch, "p-in") } });
    expect("error" in out && out.error.data?.code).toBe("denied");
    expect(existsSync(join(scratch, "p-in", "secret.txt"))).toBe(false);
    const sent = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: conf.identity.id, path: join(shared, "ok.txt") }, to: { node: primary.d.identity.id, dir: join(scratch, "p-in") } });
    expect((await rowOf(c, sent.transfer.id, ended)).state).toBe("done");
  }, 30_000);

  test("a hands node takes files from the primary and from another machine, and sends them", async () => {
    expect(primary.d.nodes.registry.get(hands.identity.id)?.capabilities.files).toBe(true);
    writeFileSync(join(scratch, "h.txt"), "h");
    const to = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: primary.d.identity.id, path: join(scratch, "h.txt") }, to: { node: hands.identity.id, dir: join(scratch, "h-in") } });
    expect((await rowOf(c, to.transfer.id, ended)).state).toBe("done");
    expect(readFileSync(join(scratch, "h-in", "h.txt"), "utf8")).toBe("h");
    // a folder from another secondary, through the primary, which the hands node hears nothing of
    const dist = join(shared, "dist");
    mkdirSync(join(dist, "sub"), { recursive: true });
    writeFileSync(join(dist, "a.txt"), "a");
    writeFileSync(join(dist, "sub", "b.txt"), "b");
    const folder = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: conf.identity.id, path: dist }, to: { node: hands.identity.id, dir: join(scratch, "h-in") } });
    const landed = await rowOf(c, folder.transfer.id, ended);
    expect(landed.state).toBe("done");
    expect(readFileSync(join(scratch, "h-in", "dist", "sub", "b.txt"), "utf8")).toBe("b");
    // what it sent is not pulled again once it landed
    expect(primary.d.store.kv.list(HANDS_PULLS_NS)).toEqual([]);
    // and the other way, from the hands node to the primary
    writeFileSync(join(scratch, "from-hands.txt"), "from hands");
    const back = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: hands.identity.id, path: join(scratch, "from-hands.txt") }, to: { node: primary.d.identity.id, dir: join(scratch, "p-from-hands") } });
    expect((await rowOf(c, back.transfer.id, ended)).state).toBe("done");
    expect(readFileSync(join(scratch, "p-from-hands", "from-hands.txt"), "utf8")).toBe("from hands");
  }, 30_000);

  test("a hands node pulls only what its primary sent it, here or on another machine", async () => {
    writeFileSync(join(scratch, "private.txt"), "the primary's own");
    writeFileSync(join(shared, "other.txt"), "the other machine's");
    const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e as { code?: string }).code ?? String(e));
    expect(await code(hands.nodes.tree(primary.d.identity.id, join(scratch, "private.txt")))).toBe("denied");
    expect(await code(hands.nodes.tree(conf.identity.id, join(shared, "other.txt")))).toBe("denied");
    // sent, it may pull that path while the transfer lasts, and no other
    writeFileSync(join(scratch, "sent.txt"), "sent");
    const pulls = new HandsPulls(primary.d.store.kv);
    pulls.sent(hands.identity.id, { id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FZZ", from: { node: primary.d.identity.id, path: join(scratch, "sent.txt") } });
    expect(await code(hands.nodes.tree(primary.d.identity.id, join(scratch, "sent.txt")))).toBe("ok");
    expect(await code(hands.nodes.tree(primary.d.identity.id, join(scratch, "private.txt")))).toBe("denied");
    pulls.ended("xfr_01ARZ3NDEKTSV4RRFFQ69G5FZZ");
    expect(await code(hands.nodes.tree(primary.d.identity.id, join(scratch, "sent.txt")))).toBe("denied");
  }, 30_000);
});
