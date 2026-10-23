// Files between two people's Cophylas, the module alone: an offer read only by the side it was
// offered to, and for a day; a group's file only for a teammate in the group; a file coming in
// pulled at once into the agent's machine, or, over a gigabyte, once the user says so, and a
// "no" told back; how it ended told to the side that sent it; a machine of this user's reads
// another person's file through the primary only for a transfer the primary started there.

import { describe, expect, test } from "bun:test";
import type { Ask, PeerSource, Session, Transfer } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { Asks } from "../src/gate/asks.ts";
import type { SaveStart } from "../src/groups/index.ts";
import { silentLogger } from "../src/log.ts";
import { PeerFiles } from "../src/peerfiles/index.ts";
import type { PeerLink } from "../src/peerfiles/index.ts";
import { Store } from "../src/store/index.ts";
import { waitFor } from "./helpers.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const BOB: PeerLink = { kind: "teammate", id: "tm_01ARZ3NDEKTSV4RRFFQ69G5TM1", user: "bob", owner: "usr_BOB" };
const CAROL: PeerLink = { kind: "connection", id: "con_01ARZ3NDEKTSV4RRFFQ69G5FE1", user: "carol" };

function sess(node = DESK): Session {
  return { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", node, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: "x", transport: "pipe", pid: 1 }, origin: "user", cwd: "C:/code/api", tags: [], status: "idle", startedAt: 1, lastActivity: 0 };
}

function rig() {
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, DESK, bus);
  const clock = { t: 1_758_000_000_000 };
  const requests: { peer: { kind: string; id: string }; method: string; params: unknown }[] = [];
  const started: SaveStart[] = [];
  const told: { session: string; text: string }[] = [];
  const reads: { node: string; path: string; rel?: string; at: number }[] = [];
  const pf = new PeerFiles({
    store,
    bus,
    log: silentLogger,
    selfId: () => DESK,
    nodeName: (n) => (n === DESK ? "Desk" : "Laptop"),
    tree: async (_n, path) => ({ kind: "file", name: path.split("/").pop()!, entries: [{ rel: "", size: 5, mtimeMs: 1 }], total: 5, files: 1, count: 1, skipped: 0 }),
    read: async (node, path, rel, at) => (reads.push({ node, path, ...(rel !== undefined ? { rel } : {}), at }), { data: new Uint8Array([1, 2, 3]), size: 3, mtimeMs: 1 }),
    request: async (peer, method, params) => {
      requests.push({ peer, method, params });
      return method === "send" ? { status: "sending" } : {};
    },
    groups: () => undefined,
    start: async (p) => {
      started.push(p);
      return { transfer: { id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", from: p.from, to: { node: p.to.node, dir: "D" }, kind: "file", name: p.from.path, total: 5, bytes: 0, state: "queued", by: p.by, ...(p.peer ? { peer: { user: p.peer.user } } : {}), startedAt: 1 } };
    },
    tell: async (session, text) => void told.push({ session, text }),
    asks,
    now: () => clock.t,
  });
  pf.start();
  return { pf, bus, asks, clock, requests, started, told, reads };
}

describe("files between two people", () => {
  test("an offer is read by the side it was offered to alone, and for a day after its last read", async () => {
    const r = rig();
    const status = await r.pf.offer(sess(LAPTOP), "api-claude", { src: { node: LAPTOP, path: "/home/me/report.md" }, what: { kind: "file", name: "report.md", total: 3, files: 1 }, reason: "the findings", peer: BOB, to: "web" });
    expect(status).toBe("sending");
    const send = r.requests[0]!;
    expect(send).toMatchObject({ peer: { kind: "teammate", id: BOB.id }, method: "send", params: { to: "web", name: "report.md", kind: "file", total: 3, reason: "the findings", from: { name: "api-claude" } } });
    // the offer names no path and no machine
    expect(JSON.stringify(send.params)).not.toContain("/home/me");
    const file = (send.params as { file: string }).file;
    const piece = await r.pf.serveRead(BOB, { file, at: 0 });
    expect(piece).toEqual({ data: Buffer.from([1, 2, 3]).toString("base64"), size: 3, mtimeMs: 1 });
    expect(r.reads).toEqual([{ node: LAPTOP, path: "/home/me/report.md", at: 0 }]);
    expect((await r.pf.serveTree(BOB, { file })).name).toBe("report.md");
    // another person, or a group's file asked of no group, is refused
    await expect(r.pf.serveRead(CAROL, { file, at: 0 })).rejects.toThrow("no such file offered to you");
    await expect(r.pf.serveRead(BOB, { file: "gfile_01ARZ3NDEKTSV4RRFFQ69G5GF1", at: 0 })).rejects.toThrow("no such file offered to you");
    // a day with no read: gone
    r.clock.t += 25 * 3600_000;
    await expect(r.pf.serveRead(BOB, { file, at: 0 })).rejects.toThrow("more than a day ago");
    r.pf.stop();
  });

  test("how an offer ended there is told to the agent that sent it, once, and the offer goes", async () => {
    const r = rig();
    await r.pf.offer(sess(), "api-claude", { src: { node: DESK, path: "C:/x/a.zip" }, what: { kind: "file", name: "a.zip", total: 3, files: 1 }, peer: BOB, to: "web" });
    const file = (r.requests[0]!.params as { file: string }).file;
    await r.pf.doneThere(CAROL, { file, ok: true });
    expect(r.told).toEqual([]);
    await r.pf.doneThere(BOB, { file, ok: false, why: "the disk is full" });
    expect(r.told).toEqual([{ session: sess().id, text: "a.zip did not reach bob/web: the disk is full." }]);
    await expect(r.pf.serveRead(BOB, { file, at: 0 })).rejects.toThrow("no such file offered to you");
    r.pf.stop();
  });

  test("a file coming in lands at once on the agent's machine; over a gigabyte the user is asked, and a no is told back", async () => {
    const r = rig();
    const agent = sess(LAPTOP);
    const small = await r.pf.incoming(BOB, { file: "pfile_01ARZ3NDEKTSV4RRFFQ69G5PF1", to: "api", name: "notes.md", kind: "file", total: 10, files: 1, reason: "for you", from: { name: "web", harness: "claude" }, sentAt: 1 }, agent);
    expect(small).toEqual({ status: "sending" });
    const src: PeerSource = { kind: "teammate", id: BOB.id, file: "pfile_01ARZ3NDEKTSV4RRFFQ69G5PF1", user: "bob", agent: "web" };
    expect(r.started[0]).toEqual({ from: { node: DESK, path: "notes.md" }, to: { node: LAPTOP }, reason: "for you", by: { kind: "user" }, notify: agent.id, peer: src });
    // the laptop may read it through the primary; another machine, or another file, may not
    expect(r.pf.mayPull(LAPTOP, src)).toBe(true);
    expect(r.pf.mayPull(DESK, src)).toBe(false);
    expect(r.pf.mayPull(LAPTOP, { ...src, file: "pfile_01ARZ3NDEKTSV4RRFFQ69G5PF2" })).toBe(false);
    // it landed: bob's side is told
    r.bus.emit("transfer.state", { id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", from: { node: DESK, path: "notes.md" }, to: { node: LAPTOP, dir: "D", path: "D/notes.md" }, kind: "file", name: "notes.md", total: 10, bytes: 10, state: "done", by: { kind: "user" }, peer: { user: "bob", agent: "web" }, startedAt: 1, endedAt: 2 } satisfies Transfer);
    await waitFor(() => r.requests.some((q) => q.method === "done"));
    expect(r.requests.find((q) => q.method === "done")!.params).toEqual({ file: "pfile_01ARZ3NDEKTSV4RRFFQ69G5PF1", ok: true });
    expect(r.pf.mayPull(LAPTOP, src)).toBe(false);

    const big = await r.pf.incoming(BOB, { file: "pfile_01ARZ3NDEKTSV4RRFFQ69G5PF3", to: "api", name: "dump.tar", kind: "file", total: 3 * 1024 ** 3, files: 1, from: { name: "web" }, sentAt: 1 }, agent);
    expect(big).toEqual({ status: "asked" });
    expect(r.started).toHaveLength(1);
    const ask = r.asks.listOpen()[0] as Ask;
    expect(ask.title).toBe("Take dump.tar (3.0 GB) from bob/web?");
    expect(ask.answerableBy).toEqual(["user"]);
    r.asks.answer(ask.id, { option: "deny" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FC7" });
    await waitFor(() => r.requests.some((q) => q.method === "done" && (q.params as { file: string }).file.endsWith("PF3")));
    expect(r.requests.at(-1)!.params).toEqual({ file: "pfile_01ARZ3NDEKTSV4RRFFQ69G5PF3", ok: false, why: "the person it was for turned it down" });
    r.pf.stop();
  });
});
