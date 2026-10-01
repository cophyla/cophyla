// Terminals across nodes: two daemons on one machine, each with a fake tether host of its own.
// The secondary's terminals reach the primary's clients at hello, as they change and in
// `terminal.list`; a client of the primary opens one, gets its repaint and its output alone,
// and its keys reach the secondary's host; a shell starts on the node named, or where the
// workspace is, in a folder the picker listed there; a client that goes takes its views with
// it; a terminal of a node that left is exited for every client. A node that shares some
// folders alone sends no terminal up and serves none.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClientNotificationParams, FolderPick, Terminal } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { silentLogger } from "../src/log.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { isMethod, sleep, tempHome, TestClient, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

type Output = ClientNotificationParams<"terminal.output">;

function tetherFor(fake: FakeTether, scratch: string): Tether {
  return new Tether({
    config: { idle_exit_s: 600, window: "none", window_on_start: false, profiles: false, on_path: false, dir: fake.dir },
    env: {},
    dataDir: join(scratch, "data"),
    nodeId: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    log: silentLogger,
    exe: "C:/fake/tether.exe",
    run: async () => ({ code: 0, out: "tether 0.1.0\n", err: "" }),
    connectOrStart: (opts) => TetherClient.connect(fake.host, { name: opts.name ?? "cophylad" }),
  });
}

const TETHER = `[tether]\nprofiles = false\n\n`;
/** What the secondary allows its primary without asking: the tests answer no ask. */
const NODE_RULES = { "node:terminal.spawn": "allow", "node:terminal.open": "allow", "node:terminal.close": "allow", "node:workspace.put": "allow" };

describe("terminals across nodes", () => {
  let scratch: string;
  let fakeP: FakeTether;
  let fakeS: FakeTether;
  let primary: Primary;
  let secondary: Started;
  let c: TestClient;
  let ts: FakeSession;
  let tp: FakeSession;

  beforeAll(async () => {
    scratch = tempHome();
    fakeP = await new FakeTether(join(scratch, "tether-p")).start();
    fakeS = await new FakeTether(join(scratch, "tether-s")).start();
    fakeP.prefix = "p";
    fakeS.prefix = "s";
    tp = fakeP.add({ argv: ["pwsh.exe"], cwd: scratch });
    ts = fakeS.add({ argv: ["bash"], cwd: scratch });
    ts.setScreen(["$ "]);
    primary = await startPrimary({ toml: TETHER, daemon: { tether: tetherFor(fakeP, join(scratch, "p")) } });
    secondary = await startSecondary(primary, { toml: TETHER, gateRules: NODE_RULES, daemon: { tether: tetherFor(fakeS, join(scratch, "s")) } });
    await linked(secondary);
    c = await client(primary.d);
  }, 60_000);

  afterAll(async () => {
    c?.close();
    await stopAll(secondary, primary?.d);
    await fakeP?.stop();
    await fakeS?.stop();
  });

  test("a node's terminals reach the primary's clients at hello, as they change, and in terminal.list", async () => {
    const row = await c.next(isMethod("terminal.state", (p) => (p as Terminal).id === ts.id));
    expect(row.params).toMatchObject({ id: ts.id, node: secondary.identity.id, argv0: "bash", status: "running" });
    const { terminals } = await c.request<{ terminals: Terminal[] }>("terminal.list");
    expect(terminals.map((t) => [t.id, t.node])).toEqual(expect.arrayContaining([[tp.id, primary.d.identity.id], [ts.id, secondary.identity.id]]));
    const more = fakeS.add({ argv: ["zsh"], cwd: scratch });
    const told = await c.next(isMethod("terminal.state", (p) => (p as Terminal).id === more.id));
    expect(told.params).toMatchObject({ node: secondary.identity.id, argv0: "zsh" });
    // the node says it starts terminals, so a view offers it in New terminal
    const nodes = await c.request<{ nodes: { id: string; capabilities: { terminals?: boolean } }[] }>("node.list");
    expect(nodes.nodes.find((n) => n.id === secondary.identity.id)?.capabilities.terminals).toBe(true);
  });

  test("a client opens another node's terminal: its repaint, its output to it alone, its keys and size down the link", async () => {
    const other = await client(primary.d, "other");
    try {
      const r = await c.request<{ terminal: Terminal; seq: number; data: string }>("terminal.open", { terminal: ts.id, input: true });
      expect(r.terminal.node).toBe(secondary.identity.id);
      expect(r.data).toContain("$ ");
      ts.output("hello from the secondary");
      const out = await c.next(isMethod("terminal.output", (p) => (p as Output).data.includes("hello from the secondary")));
      expect(out.params).toMatchObject({ terminal: ts.id });
      expect((out.params as Output).seq).toBeGreaterThan(r.seq);
      c.signal("terminal.input", { terminal: ts.id, data: "ls\r" });
      await waitFor(() => ts.typed.includes("write:ls\r"));
      await sleep(100);
      // a client that did not open it hears none of it, and its keys go nowhere
      expect(other.notifications.some((n) => n.method === "terminal.output")).toBe(false);
      other.signal("terminal.input", { terminal: ts.id, data: "rm\r" });
      await sleep(150);
      expect(ts.typed).not.toContain("write:rm\r");
      await c.request("terminal.close", { terminal: ts.id });
      ts.output("after the close");
      await sleep(150);
      expect(c.notifications.some((n) => n.method === "terminal.output" && (n.params as Output).data.includes("after the close"))).toBe(false);
    } finally {
      other.close();
    }
  });

  test("a client that goes takes its views on the node with it", async () => {
    const leaving = await client(primary.d, "leaving");
    await leaving.request("terminal.open", { terminal: ts.id });
    const unsubscribes = () => fakeS.requests.filter((q) => q.op === "unsubscribe").length;
    const before = unsubscribes();
    leaving.close();
    await waitFor(() => unsubscribes() > before);
  });

  test("the picker lists a folder of the node named, and a shell starts there, or where its workspace is", async () => {
    const dir = join(scratch, "on-secondary");
    mkdirSync(join(dir, "proj"), { recursive: true });
    mkdirSync(join(dir, ".hidden"), { recursive: true });
    const pick = await c.request<FolderPick>("terminal.folders", { node: secondary.identity.id, path: dir });
    expect(pick.path).toBe(dir);
    expect(pick.folders).toEqual([{ name: "proj", path: join(dir, "proj") }]);
    expect(pick.parent).toBe(scratch);
    const spawned = await c.request<{ terminal: Terminal }>("terminal.spawn", { node: secondary.identity.id, cwd: join(dir, "proj") });
    expect(spawned.terminal.node).toBe(secondary.identity.id);
    expect(fakeS.requests.some((q) => q.op === "spawn" && q.body["cwd"] === join(dir, "proj"))).toBe(true);
    // opened at once, as the view does, before the node's own row came up
    const opened = await c.request<{ terminal: Terminal }>("terminal.open", { terminal: spawned.terminal.id, input: true });
    expect(opened.terminal.node).toBe(secondary.identity.id);
    await c.request("terminal.close", { terminal: spawned.terminal.id });
    expect(fakeP.requests.some((q) => q.op === "spawn")).toBe(false);
    const missing = await c.call("terminal.spawn", { node: secondary.identity.id, cwd: join(dir, "gone") });
    expect("error" in missing && missing.error.data?.code).toBe("not_found");
    // a workspace of the secondary's: the shell starts there, though no node is named
    const { id } = await c.request<{ id: string }>("workspace.put", { node: secondary.identity.id, path: dir, name: "on secondary" });
    await c.next(isMethod("workspace.state", (p) => (p as { id: string }).id === id));
    const inWs = await c.request<{ terminal: Terminal }>("terminal.spawn", { workspace: id });
    expect(inWs.terminal).toMatchObject({ node: secondary.identity.id, cwd: dir });
  });

  test("a terminal of a node that left is exited for the primary's clients", async () => {
    await stopAll(secondary);
    const gone = await c.next(isMethod("terminal.state", (p) => (p as Terminal).id === ts.id && (p as Terminal).status === "exited"), 10_000);
    expect(gone.params).toMatchObject({ node: secondary.identity.id });
    const { terminals } = await c.request<{ terminals: Terminal[] }>("terminal.list");
    expect(terminals.map((t) => t.id)).not.toContain(ts.id);
    const open = await c.call("terminal.open", { terminal: ts.id });
    expect("error" in open && open.error.data?.code).toBe("not_found");
  }, 20_000);
});

describe("a node that shares some folders alone", () => {
  let scratch: string;
  let fakeS: FakeTether;
  let primary: Primary;
  let secondary: Started;
  let c: TestClient;
  let ts: FakeSession;

  beforeAll(async () => {
    scratch = tempHome();
    fakeS = await new FakeTether(join(scratch, "tether-s")).start();
    fakeS.prefix = "s";
    ts = fakeS.add({ argv: ["bash"], cwd: scratch });
    primary = await startPrimary({ toml: TETHER });
    secondary = await startSecondary(primary, { toml: TETHER, gateRules: NODE_RULES, paths: [scratch], daemon: { tether: tetherFor(fakeS, join(scratch, "s")) } });
    await linked(secondary);
    c = await client(primary.d);
  }, 60_000);

  afterAll(async () => {
    c?.close();
    await stopAll(secondary, primary?.d);
    await fakeS?.stop();
  });

  test("sends no terminal up, says it starts none, and serves none", async () => {
    const { terminals } = await c.request<{ terminals: Terminal[] }>("terminal.list");
    expect(terminals.map((t) => t.id)).not.toContain(ts.id);
    const nodes = await c.request<{ nodes: { id: string; capabilities: { terminals?: boolean } }[] }>("node.list");
    await waitFor(async () => (await c.request<{ nodes: { id: string; capabilities: { terminals?: boolean } }[] }>("node.list")).nodes.find((n) => n.id === secondary.identity.id)?.capabilities.terminals === false || undefined);
    expect(nodes.nodes.some((n) => n.id === secondary.identity.id)).toBe(true);
    const spawn = await c.call("terminal.spawn", { node: secondary.identity.id, cwd: scratch });
    expect("error" in spawn && spawn.error.data?.code).toBe("denied");
    const pick = await c.call("terminal.folders", { node: secondary.identity.id, path: scratch });
    expect("error" in pick && pick.error.data?.code).toBe("denied");
    expect(fakeS.requests.some((q) => q.op === "spawn")).toBe(false);
  });
});
