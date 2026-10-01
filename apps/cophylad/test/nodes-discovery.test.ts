// Discovery over a LAN in memory: a secondary whose grant no longer says where the primary
// is finds it by its answer to a query; a primary of another cluster is ignored; `[nodes]
// primary` wins over what the network says; a machine that joined a cluster seeks the
// primary the user chose, whatever its config says. The datagram parser refuses what is not
// a beacon.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLinkFile, writeLinkFile } from "../src/grants/link-file.ts";
import { MemoryLan, parseDatagram } from "../src/nodes/discovery.ts";
import { waitFor } from "./helpers.ts";
import { linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const started: (Started | undefined)[] = [];
let primaries: Primary[] = [];

afterEach(async () => {
  await stopAll(...started, ...primaries.map((p) => p.d));
  started.length = 0;
  primaries = [];
});

describe("discovery", () => {
  test("a secondary finds the primary by broadcast; a foreign cluster is ignored; the configured endpoint wins", async () => {
    const lan = new MemoryLan();
    const other = await startPrimary({ discovery: lan });
    primaries.push(other);
    const mine = await startPrimary({ discovery: lan });
    primaries.push(mine);
    // No endpoint configured, and none in its grant: the secondary asks the LAN and links to the primary of its own cluster, not the other one.
    const joined = await startSecondary(mine, { discovery: lan, noEndpoint: true });
    await linked(joined, 8000);
    await joined.stop();
    const { endpoints: _endpoints, ...file } = readLinkFile(joined.paths.linkFile)!;
    writeLinkFile(joined.paths.linkFile, file);
    const from = lan.log.length;
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    const s = Object.assign(await startDaemon({ home: joined.home, port: 0, log: silentLogger, brain: false, embedder: null, nodes: { discovery: lan } }), { home: joined.home });
    started.push(s);
    await linked(s, 8000);
    expect(s.nodes.primaryId()).toBe(mine.d.identity.id);
    expect(mine.d.nodes.linkedNodes()).toEqual([s.identity.id]);
    expect(other.d.nodes.linkedNodes()).toEqual([]);
    // The query went out after the restart and only the right primary answered it.
    const answers = lan.log.slice(from).filter((l) => l.msg.t === "a");
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((a) => a.msg.nodeId === mine.d.identity.id)).toBe(true);
    expect(lan.log.some((l) => l.msg.t === "b" && l.msg.nodeId === mine.d.identity.id)).toBe(true);
    // A configured endpoint is tried first, whatever the network says.
    const told = await startSecondary(mine, { discovery: lan });
    started.push(told);
    await linked(told, 8000);
    expect(told.nodes.primaryId()).toBe(mine.d.identity.id);
  }, 30_000);

  test("a machine that joined and restarts configured primary seeks the primary the user chose: the config chooses nothing", async () => {
    const lan = new MemoryLan();
    const live = await startPrimary({ discovery: lan });
    primaries.push(live);
    // A node that joined the live primary's cluster, then restarted configured primary: it never claims, and joins the live one as a backup.
    const joined = await startSecondary(live, { discovery: lan, noEndpoint: true });
    await linked(joined, 8000);
    await joined.stop();
    const home = joined.home;
    writeFileSync(join(home, "config.toml"), `[sessions]\ndiscover = false\ninstall_hooks = false\n\n[node]\nrole = "primary"\n\n[controller]\nenabled = false\nport = 0\n\n[nodes]\naccept = true\ndiscovery = true\nclaim_wait_ms = 1500\nheartbeat_ms = 200\nreconnect_ms = 100\n`);
    expect(readFileSync(joined.paths.linkFile, "utf8")).toContain('"via": "join"');
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    const d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null, nodes: { discovery: lan } }), { home });
    started.push(d);
    expect(d.nodes.roleOf()).toBe("secondary");
    expect(d.nodes.transitions.some((t) => t.from === "claiming" || t.to === "claiming")).toBe(false);
    await linked(d, 8000);
    expect(d.nodes.primaryId()).toBe(live.d.identity.id);
    expect(live.d.nodes.registry.get(d.identity.id)?.backup).toBe(true);
    expect(d.node().backup).toBe(true);
  }, 30_000);

  test("a hand-over with discovery on: the new primary's first beacon is not a rival, and node.promote answers ok", async () => {
    const lan = new MemoryLan();
    const primary = await startPrimary({ discovery: lan });
    primaries.push(primary);
    const backup = await startSecondary(primary, { discovery: lan, backup: true });
    started.push(backup);
    await linked(backup, 8000);
    const { client } = await import("./nodes-helpers.ts");
    const c = await client(primary.d);
    const r = await c.call("node.promote", { id: backup.identity.id });
    expect("error" in r ? r.error : r.result).toEqual({});
    await waitFor(() => backup.nodes.roleOf() === "primary", 10_000);
    await waitFor(() => primary.d.nodes.roleOf() === "secondary" && primary.d.nodes.linked() && primary.d.nodes.primaryId() === backup.identity.id, 10_000);
    expect(backup.nodes.epoch()).toBe(2);
    c.close();
  }, 30_000);

  test("datagrams: only a well-formed beacon parses", () => {
    expect(parseDatagram(JSON.stringify({ cophyla: 1, t: "b", cluster: "abc", nodeId: "node_x", name: "desk", port: 4818, epoch: 2, role: "primary" }))).toEqual({ cophyla: 1, t: "b", cluster: "abc", nodeId: "node_x", name: "desk", port: 4818, epoch: 2, role: "primary" });
    expect(parseDatagram("not json")).toBeUndefined();
    expect(parseDatagram(JSON.stringify({ cophyla: 2, t: "b", cluster: "abc", nodeId: "n", port: 1 }))).toBeUndefined();
    expect(parseDatagram(JSON.stringify({ cophyla: 1, t: "x", cluster: "abc", nodeId: "n", port: 1 }))).toBeUndefined();
    expect(parseDatagram(JSON.stringify({ cophyla: 1, t: "q", cluster: "abc", nodeId: "n", port: 0 }))).toMatchObject({ t: "q", role: "secondary", name: "?", epoch: 0 });
  });
});
