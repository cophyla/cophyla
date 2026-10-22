// The transfer engine on the receiving machine, with the sending machine played by a pipe
// hub on the same computer and a tap that can cut a pipe after so many bytes. One transfer
// runs at a time; what lands takes a free name; a pipe cut short leaves it waiting, and it
// goes on from the partial's size; a file that changed since the walk starts again from
// nothing; a daemon that stops and starts again carries on with what it kept; a cancel
// deletes the partial, a failure keeps it for a retry; a big one over the relay waits for the
// user's word; an agent session it was sent to is told where it landed, and why when the
// sender said: a reason kept as one line, cut to its most.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import type { NodeRecord, Transfer } from "@cophyla/protocol";
import { PROTOCOL_VERSION, TRANSFER_REASON_MAX } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { PipeHub } from "../src/remote/pipes.ts";
import type { End, FilePipe, FileTarget } from "../src/remote/pipes.ts";
import { ensureDir, PART, Transfers } from "../src/transfers/index.ts";
import type { Hop } from "../src/transfers/index.ts";
import { openSource } from "../src/transfers/source.ts";
import { TreeCache } from "../src/transfers/tree.ts";
import { removeHome, tempHome, waitFor } from "./helpers.ts";

const SRC = "node_01ARZ3NDEKTSV4RRFFQ69G5FS1";
const DST = "node_01ARZ3NDEKTSV4RRFFQ69G5FD1";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function counted(n: number, salt = 0): Uint8Array {
  const words = new Uint32Array(Math.ceil(n / 4));
  for (let i = 0; i < words.length; i++) words[i] = i + salt;
  return new Uint8Array(words.buffer, 0, n);
}

function row(id: string, name: string): NodeRecord {
  return {
    id,
    name,
    role: "secondary",
    status: "online",
    via: "direct",
    platform: "windows",
    scope: { kind: "machine" },
    capabilities: { harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false, files: true },
    versions: { platform: "0.17.0", protocol: PROTOCOL_VERSION },
    lastSeen: Date.now(),
    endpoints: [],
  };
}

interface Rig {
  home: string;
  dataDir: string;
  t: Transfers;
  rows: Transfer[];
  /** Every pipe opened, and from where. */
  opened: number[];
  /** The next pipe (of the file `rel`, when named) is cut after this many bytes. */
  cutNext(bytes: number, rel?: string): void;
  reachable: boolean;
  hop: Hop | undefined;
  told: { session: string; text: string }[];
  make(): Transfers;
}

const rigs: Rig[] = [];

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.t.stop();
    removeHome(r.home);
  }
});

function rig(): Rig {
  const home = tempHome();
  const dataDir = join(home, "data");
  const hub = new PipeHub({
    selfId: () => SRC,
    loopbackPort: () => 0,
    clientWire: () => ({ data: () => true, ack: () => undefined, close: () => undefined }),
    linkWire: () => undefined,
    nextHop: () => undefined,
    openOnLink: async () => ({ window: 1 }),
    openFile: (target, deliver, gone) => openSource(target, deliver, gone),
    log: silentLogger,
  });
  let cut: { bytes: number; rel?: string } | undefined;
  const r: Rig = {
    home,
    dataDir,
    t: undefined as unknown as Transfers,
    rows: [],
    opened: [],
    cutNext: (bytes, rel) => (cut = { bytes, ...(rel !== undefined ? { rel } : {}) }),
    reachable: true,
    hop: "lan",
    told: [],
    make: () =>
      new Transfers({
        selfId: () => DST,
        nodeName: (id) => (id === SRC ? "Laptop" : "Desk"),
        dataDir,
        bus: { emit: (_n, t) => void r.rows.push(t as Transfer) },
        pipes: {
          openForFile: async (node: string, target: FileTarget, near: End): Promise<FilePipe> => {
            r.opened.push(target.at);
            const mine = cut !== undefined && (cut.rel === undefined || cut.rel === target.rel);
            const limit = mine ? cut!.bytes : undefined;
            if (mine) cut = undefined;
            let seen = 0;
            let cutOff = false;
            let pipe: FilePipe | undefined;
            const tap: End = {
              get room() {
                return near.room;
              },
              write(d) {
                if (cutOff) return;
                if (limit !== undefined && seen + d.length >= limit) {
                  const keep = d.subarray(0, Math.max(0, limit - seen));
                  if (keep.length > 0) near.write(keep);
                  seen = limit;
                  cutOff = true;
                  setTimeout(() => {
                    pipe?.close("cut by the test");
                    near.close("cut by the test");
                  }, 0);
                  return;
                }
                seen += d.length;
                near.write(d);
              },
              close: (reason) => near.close(reason),
            };
            near.onRoom = () => tap.onRoom?.();
            pipe = await hub.openForFile(node, target, tap);
            return pipe;
          },
        },
        tree: (_n, path, from) => trees.page(path, from),
        reachable: () => r.reachable,
        nodes: () => [row(SRC, "Laptop")],
        primary: () => DST,
        hop: () => r.hop,
        tell: async (session, text) => void r.told.push({ session, text }),
        log: silentLogger,
        backoff: { firstMs: 20, maxMs: 80 },
        relayConfirmBytes: 100_000,
      }),
  };
  const trees = new TreeCache();
  r.t = r.make();
  r.t.start();
  rigs.push(r);
  return r;
}

const start = (r: Rig, path: string, dir: string, extra: Record<string, unknown> = {}) => r.t.begin({ from: { node: SRC, path }, to: { node: DST, dir }, ...extra });
const state = (r: Rig, id: string) => r.t.get(id)?.state;
const ended = (s: string | undefined) => s === "done" || s === "failed" || s === "cancelled";

describe("the transfer engine", () => {
  test("a file lands whole beside what is there, one transfer at a time, its rows told as it goes", async () => {
    const r = rig();
    const src = join(r.home, "src");
    const dir = join(r.home, "in");
    mkdirSync(src);
    mkdirSync(dir);
    const one = counted(3 * 1024 * 1024 + 5);
    writeFileSync(join(src, "a.bin"), one);
    writeFileSync(join(src, "b.bin"), "b");
    writeFileSync(join(dir, "a.bin"), "already here");
    const first = (await start(r, join(src, "a.bin"), dir)).transfer!;
    const second = (await start(r, join(src, "b.bin"), dir)).transfer!;
    expect(second.state).toBe("queued");
    await waitFor(() => ended(state(r, first.id)) && ended(state(r, second.id)), 10_000);
    const a = r.t.get(first.id)!;
    expect(a).toMatchObject({ state: "done", bytes: one.length, total: one.length, kind: "file", name: "a.bin", by: { kind: "user" } });
    expect(a.to.path).toBe(join(dir, "a (1).bin"));
    expect(sha(readFileSync(join(dir, "a (1).bin")))).toBe(sha(one));
    expect(readFileSync(join(dir, "a.bin"), "utf8")).toBe("already here");
    // the second ran once the first was done
    const runningB = r.rows.findIndex((t) => t.id === second.id && t.state === "running");
    const doneA = r.rows.findIndex((t) => t.id === first.id && t.state === "done");
    expect(runningB).toBeGreaterThan(doneA);
    expect(r.rows.filter((t) => t.id === first.id).map((t) => t.state)).toContain("running");
    expect(readdirSync(dir).filter((n) => n.endsWith(PART))).toEqual([]);
  });

  test("a pipe cut short leaves it waiting, and it goes on from the partial's size", async () => {
    const r = rig();
    const src = join(r.home, "src");
    mkdirSync(src);
    const bytes = counted(2 * 1024 * 1024 + 1);
    writeFileSync(join(src, "c.bin"), bytes);
    r.cutNext(700_001);
    const t = (await start(r, join(src, "c.bin"), join(r.home, "in"))).transfer!;
    r.reachable = false;
    await waitFor(() => state(r, t.id) === "waiting", 5000);
    expect(r.t.get(t.id)!.error).toBe("waiting for Laptop");
    expect(r.t.get(t.id)!.bytes).toBe(700_001);
    r.reachable = true;
    r.t.poke(SRC);
    await waitFor(() => ended(state(r, t.id)), 10_000);
    expect(state(r, t.id)).toBe("done");
    expect(r.opened).toEqual([0, 700_001]);
    expect(sha(readFileSync(join(r.home, "in", "c.bin")))).toBe(sha(bytes));
  });

  test("a file that changed since the walk starts again from nothing", async () => {
    const r = rig();
    const src = join(r.home, "src");
    mkdirSync(src);
    writeFileSync(join(src, "d.bin"), counted(1024 * 1024));
    r.cutNext(300_000);
    const t = (await start(r, join(src, "d.bin"), join(r.home, "in"))).transfer!;
    r.reachable = false;
    await waitFor(() => state(r, t.id) === "waiting", 5000);
    const changed = counted(1024 * 1024 + 8, 7);
    writeFileSync(join(src, "d.bin"), changed);
    utimesSync(join(src, "d.bin"), new Date(), new Date(Date.now() + 5000));
    r.reachable = true;
    r.t.poke();
    await waitFor(() => ended(state(r, t.id)), 10_000);
    expect(state(r, t.id)).toBe("done");
    expect(r.opened).toEqual([0, 300_000, 0]);
    expect(r.t.get(t.id)!.total).toBe(changed.length);
    expect(sha(readFileSync(join(r.home, "in", "d.bin")))).toBe(sha(changed));
  });

  test("a daemon that stops and starts again carries on from what it kept", async () => {
    const r = rig();
    const src = join(r.home, "src", "folder");
    mkdirSync(join(src, "sub"), { recursive: true });
    const big = counted(1024 * 1024 + 2);
    writeFileSync(join(src, "a.txt"), "first");
    writeFileSync(join(src, "sub", "big.bin"), big);
    r.cutNext(400_000, "sub/big.bin");
    const t = (await start(r, src, join(r.home, "in"))).transfer!;
    r.reachable = false;
    expect(t.files).toEqual({ done: 0, total: 2 });
    await waitFor(() => state(r, t.id) === "waiting", 5000);
    expect(r.t.get(t.id)!.files).toEqual({ done: 1, total: 2 });
    await r.t.stop();
    // the next daemon
    r.reachable = true;
    r.t = r.make();
    expect(r.t.get(t.id)).toMatchObject({ state: "waiting", files: { done: 1, total: 2 } });
    r.t.start();
    await waitFor(() => ended(state(r, t.id)), 10_000);
    expect(r.t.get(t.id)).toMatchObject({ state: "done", files: { done: 2, total: 2 }, bytes: big.length + 5 });
    // the folder's second file went on from where it stopped, the first was not sent again
    expect(r.opened).toEqual([0, 0, 400_000]);
    const landed = join(r.home, "in", "folder");
    expect(readFileSync(join(landed, "a.txt"), "utf8")).toBe("first");
    expect(sha(readFileSync(join(landed, "sub", "big.bin")))).toBe(sha(big));
  });

  test("one that ran when the daemon stopped is queued at the next start", async () => {
    const r = rig();
    const src = join(r.home, "src");
    mkdirSync(src);
    writeFileSync(join(src, "e.bin"), counted(4 * 1024 * 1024));
    r.cutNext(10);
    const t = (await start(r, join(src, "e.bin"), join(r.home, "in"))).transfer!;
    r.reachable = false;
    await waitFor(() => state(r, t.id) === "waiting");
    await r.t.stop();
    // as a daemon that stopped while it ran leaves it
    const kept = JSON.parse(readFileSync(join(r.dataDir, "transfers.json"), "utf8")) as { rows: { t: Transfer }[] };
    kept.rows[0]!.t.state = "running";
    writeFileSync(join(r.dataDir, "transfers.json"), JSON.stringify(kept));
    r.t = r.make();
    expect(state(r, t.id)).toBe("queued");
  });

  test("a cancel deletes what came; a dismissal forgets it", async () => {
    const r = rig();
    const src = join(r.home, "src", "tree");
    mkdirSync(join(src, "x"), { recursive: true });
    writeFileSync(join(src, "x", "big.bin"), counted(1024 * 1024));
    const dir = join(r.home, "in");
    r.cutNext(1000);
    const t = (await start(r, src, dir)).transfer!;
    r.reachable = false;
    await waitFor(() => state(r, t.id) === "waiting");
    expect(readdirSync(dir)).toEqual([`tree${PART}`]);
    await r.t.cancel(t.id);
    expect(state(r, t.id)).toBe("cancelled");
    expect(readdirSync(dir)).toEqual([]);
    await r.t.dismiss(t.id);
    expect(r.t.get(t.id)).toBeUndefined();
    expect(r.rows.at(-1)).toMatchObject({ id: t.id, dismissed: true });
    expect(existsSync(join(r.dataDir, "transfers", `${t.id}.json`))).toBe(false);
  });

  test("a failure keeps what came for a retry, until it is dismissed", async () => {
    const r = rig();
    const src = join(r.home, "src");
    mkdirSync(src);
    const bytes = counted(1024 * 1024);
    writeFileSync(join(src, "f.bin"), bytes);
    const dir = join(r.home, "in");
    r.cutNext(5000);
    const t = (await start(r, join(src, "f.bin"), dir)).transfer!;
    r.reachable = false;
    await waitFor(() => state(r, t.id) === "waiting");
    rmSync(join(src, "f.bin"));
    r.reachable = true;
    r.t.poke();
    await waitFor(() => state(r, t.id) === "failed");
    expect(r.t.get(t.id)!.error).toContain("no such file");
    expect(readdirSync(dir)).toEqual([`f.bin${PART}`]);
    expect(() => r.t.retry("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX9")).toThrow();
    writeFileSync(join(src, "f.bin"), bytes);
    r.t.retry(t.id);
    await waitFor(() => ended(state(r, t.id)), 10_000);
    expect(state(r, t.id)).toBe("done");
    expect(sha(readFileSync(join(dir, "f.bin")))).toBe(sha(bytes));
    // and a failed one dismissed takes its partial with it
    r.cutNext(10);
    const u = (await start(r, join(src, "f.bin"), dir)).transfer!;
    r.reachable = false;
    await waitFor(() => state(r, u.id) === "waiting");
    rmSync(join(src, "f.bin"));
    r.reachable = true;
    r.t.poke();
    await waitFor(() => state(r, u.id) === "failed");
    expect(readdirSync(dir).some((n) => n.endsWith(PART))).toBe(true);
    await r.t.dismiss(u.id);
    expect(readdirSync(dir).some((n) => n.endsWith(PART))).toBe(false);
  });

  test("over the threshold with a hop on the relay, it waits for the user's word; with it, it runs", async () => {
    const r = rig();
    const src = join(r.home, "src");
    mkdirSync(src);
    writeFileSync(join(src, "big.iso"), counted(200_000));
    writeFileSync(join(src, "small.txt"), "s");
    r.hop = "relay";
    const asked = await start(r, join(src, "big.iso"), join(r.home, "in"));
    expect(asked).toEqual({ confirm: { bytes: 200_000, relayHops: [SRC] } });
    expect(r.t.list()).toEqual([]);
    expect((await start(r, join(src, "small.txt"), join(r.home, "in"))).transfer?.via).toBe("relay");
    const ok = (await start(r, join(src, "big.iso"), join(r.home, "in"), { relayOk: true })).transfer!;
    await waitFor(() => ended(state(r, ok.id)), 10_000);
    expect(r.t.get(ok.id)).toMatchObject({ state: "done", via: "relay" });
  });

  test("an agent session it was sent to is told where it landed", async () => {
    const r = rig();
    const src = join(r.home, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(join(src, "dist", "x.js"), "x");
    const t = (await start(r, join(src, "dist"), join(r.home, "in"), { by: { kind: "agent", alias: "api-codex", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" }, notify: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2" })).transfer!;
    await waitFor(() => r.told.length > 0, 10_000);
    expect(r.t.get(t.id)!.by).toEqual({ kind: "agent", alias: "api-codex", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" });
    expect(r.told).toEqual([{ session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2", text: `api-codex sent you the folder dist: ${join(r.home, "in", "dist")}` }]);
  });

  test("a reason is kept as one line, cut to its most, and the session it was sent to is told it", async () => {
    const r = rig();
    const src = join(r.home, "src");
    mkdirSync(src);
    writeFileSync(join(src, "a.bundle"), "a");
    writeFileSync(join(src, "b.bundle"), "b");
    writeFileSync(join(src, "c.bundle"), "c");
    const by = { kind: "agent", alias: "fauna-core", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" };
    const a = (await start(r, join(src, "a.bundle"), join(r.home, "in"), { by, notify: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2", reason: "  Nightly backup\n  of fauna-core " })).transfer!;
    expect(a.reason).toBe("Nightly backup of fauna-core");
    const long = (await start(r, join(src, "b.bundle"), join(r.home, "in"), { reason: "x ".repeat(100) })).transfer!;
    expect(long.reason).toHaveLength(TRANSFER_REASON_MAX);
    expect(long.reason!.endsWith("…")).toBe(true);
    expect("reason" in (await start(r, join(src, "c.bundle"), join(r.home, "in"), { reason: " \n " })).transfer!).toBe(false);
    await waitFor(() => r.told.length > 0, 10_000);
    expect(r.told[0]).toEqual({ session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2", text: `fauna-core sent you a.bundle ("Nightly backup of fauna-core"): ${join(r.home, "in", "a.bundle")}` });
    // kept by the next daemon, as the rest of the row is
    await waitFor(() => ended(state(r, long.id)), 10_000);
    await r.t.stop();
    r.t = r.make();
    expect(r.t.get(a.id)!.reason).toBe("Nightly backup of fauna-core");
  });

  test("a start is refused for a machine that sends no files, a folder that cannot be made, and a relative path", async () => {
    const r = rig();
    // a machine this node has no row of and no way to: a full member knows every one there is
    r.reachable = false;
    await expect(r.t.begin({ from: { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FZ9", path: "C:\\x" }, to: { node: DST, dir: r.home } })).rejects.toThrow("no machine");
    r.reachable = true;
    await expect(start(r, join(r.home, "nope.txt"), r.home)).rejects.toThrow("no such file");
    await expect(start(r, "relative.txt", r.home)).rejects.toThrow("not an absolute path");
    writeFileSync(join(r.home, "a-file"), "x");
    await expect(start(r, join(r.home, "a-file"), join(r.home, "a-file", "under"))).rejects.toThrow("no folder to put it in");
    await expect(start(r, join(r.home, "a-file"), "relative-dir")).rejects.toThrow("not an absolute path");
  });

  test("a start is kept on disk before it is answered: a daemon that stops a moment after still has it", async () => {
    const r = rig();
    writeFileSync(join(r.home, "keep.txt"), "kept");
    const { transfer } = await start(r, join(r.home, "keep.txt"), join(r.home, "in-keep"));
    const kept = JSON.parse(readFileSync(join(r.dataDir, "transfers.json"), "utf8")) as { rows: { t: Transfer }[] };
    expect(kept.rows.map((x) => x.t.id)).toContain(transfer!.id);
  });

  // Windows marks Downloads and the other known folders read-only, where Bun's recursive mkdir
  // says EEXIST of the folder that is there; and a drive's root, where it says EPERM.
  test.if(process.platform === "win32")("it lands in a folder Windows marks read-only, as Downloads is, and takes a drive's root as a folder", async () => {
    const r = rig();
    const marked = join(r.home, "Downloads");
    mkdirSync(marked);
    spawnSync("attrib", ["+r", marked], { windowsHide: true });
    try {
      writeFileSync(join(r.home, "ro.txt"), "into a read-only folder");
      const { transfer } = await start(r, join(r.home, "ro.txt"), marked);
      await waitFor(() => ended(state(r, transfer!.id)));
      expect(state(r, transfer!.id)).toBe("done");
      expect(readFileSync(join(marked, "ro.txt"), "utf8")).toBe("into a read-only folder");
      await ensureDir(parse(r.home).root);
    } finally {
      spawnSync("attrib", ["-r", marked], { windowsHide: true });
    }
  });
});
