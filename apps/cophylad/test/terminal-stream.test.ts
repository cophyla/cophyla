// Terminals in the views, against a fake tether host speaking the real protocol: a client that
// opens a terminal gets its repaint and then its output, batched, after the answer; a character
// split across two reads arrives whole; clients share one subscription, each from its own
// repaint; a batch holds at most 64 KiB; a client that fell behind, or all of them when the
// daemon's subscription did, get a repaint instead of what they missed. Watching neither types
// nor sizes; `input` types, `drive` sizes, on a connection of its own. Each terminal's row is
// told once per change. A shell started in a workspace runs in its folder and counts as work
// there. Through the daemon: the rows reach a client at hello and in
// `terminal.list`, and opening a terminal to type into it is gated as `exec`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scope } from "@cophyla/protocol";
import type { ClientNotificationParams, Session, Terminal, Workspace } from "@cophyla/protocol";
import { TetherClient } from "@tether-pty/client";
import { ClientRegistry } from "../src/api/clients.ts";
import { Bus } from "../src/bus.ts";
import { silentLogger } from "../src/log.ts";
import { Tether } from "../src/sessions/tether/index.ts";
import { BATCH_CAP, BEHIND_AT, shellOf, TerminalRows, TerminalStreams } from "../src/sessions/tether/streams.ts";
import type { Workspaces } from "../src/workspaces/index.ts";
import { FakeTether } from "./fakes/tether.ts";
import type { FakeSession } from "./fakes/tether.ts";
import { isMethod, SAFE_NODES, SAFE_SESSIONS, SAFE_UPDATE, sleep, stopDaemon, tempHome, testDaemon, TestClient, waitFor } from "./helpers.ts";

type Output = ClientNotificationParams<"terminal.output">;

const A = "cli_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const B = "cli_01ARZ3NDEKTSV4RRFFQ69G5FA2";
const C = "cli_01ARZ3NDEKTSV4RRFFQ69G5FA3";
const D = "cli_01ARZ3NDEKTSV4RRFFQ69G5FA4";

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

describe("terminal streams", () => {
  let fake: FakeTether;
  let tether: Tether;
  let registry: ClientRegistry;
  let bus: Bus;
  let rows: TerminalRows;
  let streams: TerminalStreams;
  let t: FakeSession;
  const frames: Record<string, { method: string; params: unknown }[]> = {};
  const buffered: Record<string, number> = {};
  const sessionIn = new Map<string, Session>();
  const told: Terminal[] = [];
  // the folders a shell starts in are real: one that is not there is refused
  const places = tempHome();
  const WS: Workspace = { id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB2", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", path: join(places, "app"), name: "app", origin: "discovered", tags: [], lastActivity: 1 };
  const ELSEWHERE = join(places, "elsewhere");
  const WS_AWAY: Workspace = { ...WS, id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB3", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FC0" };
  const touched: string[] = [];

  const outputs = (client: string, id = t.id): Output[] =>
    (frames[client] ?? []).filter((f) => f.method === "terminal.output" && (f.params as Output).terminal === id).map((f) => f.params as Output);
  const text = (client: string) => outputs(client).map((o) => o.data).join("");

  function connect(id: string): void {
    frames[id] = [];
    buffered[id] = 0;
    registry.add(
      { id, kind: "ui", scopes: [...Scope.options], via: "direct", audio: { in: false, out: false }, connectedAt: 1 },
      { send: (d) => frames[id]!.push(JSON.parse(d)), close() {}, buffered: () => buffered[id]! },
      "loopback",
    );
  }

  beforeAll(async () => {
    const scratch = tempHome();
    fake = await new FakeTether(join(scratch, "tether")).start();
    tether = tetherFor(fake, scratch);
    await tether.start();
    registry = new ClientRegistry();
    bus = new Bus();
    bus.on("terminal.state", (row) => told.push(row));
    for (const dir of [WS.path, ELSEWHERE]) mkdirSync(dir, { recursive: true });
    const workspaces = { get: (id: string) => [WS, WS_AWAY].find((w) => w.id === id), touch: (id: string) => touched.push(id) } as unknown as Workspaces;
    rows = new TerminalRows({ tether, bus, nodeId: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", workspaces, env: { PATH: "x" }, sessionOf: (ref) => sessionIn.get(ref.id), log: silentLogger, rowMs: 20 });
    streams = new TerminalStreams({ tether, registry, rows, log: silentLogger });
    for (const id of [A, B, C, D]) connect(id);
    t = fake.add({ argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoLogo"], cwd: scratch });
    t.setScreen(["PS> "]);
    await waitFor(() => tether.byId(t.id));
  }, 30_000);

  afterAll(async () => {
    await streams.stop();
    rows.stop();
    await tether.stop();
    await fake.stop();
  });

  test("opening gives the repaint and where it stands; the output from there follows, batched, after the answer", async () => {
    t.output("before");
    const r = await streams.open(A, t.id, {});
    expect(r.seq).toBe(6);
    expect(r.data).toContain("PS> ");
    expect(r.terminal).toMatchObject({ id: t.id, argv0: "pwsh.exe", status: "running", windows: 0 });
    expect(outputs(A)).toEqual([]);
    t.output("one");
    t.output("two");
    await waitFor(() => outputs(A).length > 0);
    await sleep(40);
    expect(outputs(A)).toEqual([{ terminal: t.id, seq: 12, data: "onetwo" }]);
  });

  test("a character split across two reads arrives whole", async () => {
    const euro = new TextEncoder().encode("€");
    t.output(euro.subarray(0, 1));
    await sleep(20);
    t.output(euro.subarray(1));
    await waitFor(() => text(A).endsWith("€"));
    expect(text(A)).not.toContain("\ufffd");
  });

  test("clients share one subscription, each from its own repaint", async () => {
    const subscribes = () => fake.requests.filter((r) => r.op === "subscribe" && r.body["session"] === t.id).length;
    const before = subscribes();
    const r = await streams.open(B, t.id, {});
    expect(subscribes()).toBe(before);
    expect(r.seq).toBe(t.seq);
    t.output("both");
    await waitFor(() => text(B) === "both" && text(A).endsWith("both"));
    expect(streams.viewers(t.id)).toBe(2);
  });

  test("a batch holds at most 64 KiB", async () => {
    const start = outputs(A).length;
    t.output("a".repeat(40_000));
    t.output("b".repeat(40_000));
    await waitFor(() => text(A).endsWith("b".repeat(40_000)));
    const batches = outputs(A).slice(start);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const b of batches) expect(b.data.length).toBeLessThanOrEqual(BATCH_CAP);
  });

  test("watching neither types nor sizes; input types through the shared subscription", async () => {
    streams.input(A, t.id, "nope\r");
    streams.resize(A, t.id, { cols: 50, rows: 10 });
    await sleep(100);
    expect(t.typed).toEqual([]);
    expect([t.cols, t.rows]).toEqual([120, 32]);
    await streams.open(C, t.id, { input: true });
    streams.input(C, t.id, "ls\r");
    await waitFor(() => t.typed.includes("write:ls\r"));
    streams.resize(C, t.id, { cols: 50, rows: 10 });
    await sleep(100);
    expect([t.cols, t.rows]).toEqual([120, 32]);
  });

  test("a client that drives sizes the terminal, on a connection of its own, and lets go when it closes", async () => {
    const conns = fake.conns.size;
    await streams.open(D, t.id, { drive: { cols: 90, rows: 25 } });
    expect(fake.conns.size).toBe(conns + 1);
    expect([t.cols, t.rows]).toEqual([90, 25]);
    streams.resize(D, t.id, { cols: 100, rows: 30 });
    await waitFor(() => t.cols === 100 && t.rows === 30);
    streams.input(D, t.id, "y");
    await waitFor(() => t.typed.includes("write:y"));
    await streams.close(D, t.id);
    await waitFor(() => fake.conns.size === conns);
  });

  test("a client that fell behind gets nothing until it drained, then a repaint", async () => {
    buffered[B] = BEHIND_AT + 1;
    t.output("x");
    await sleep(50);
    t.output("lost");
    await sleep(50);
    expect(text(B)).not.toContain("lost");
    const seen = outputs(B).length;
    buffered[B] = 0;
    const reset = await waitFor(() => outputs(B).slice(seen).find((o) => o.reset));
    expect(reset.data).toContain("PS> ");
    expect(reset.seq).toBe(t.seq);
    t.output("again");
    await waitFor(() => outputs(B).at(-1)?.data === "again");
    // The other client missed nothing.
    expect(text(A)).toContain("lost");
  });

  test("when the daemon's own subscription fell behind the host, every client gets a repaint", async () => {
    const seenA = outputs(A).length;
    const seenB = outputs(B).length;
    t.resync();
    await waitFor(() => outputs(A).slice(seenA).some((o) => o.reset) && outputs(B).slice(seenB).some((o) => o.reset));
  });

  test("each terminal's row is told once per change: a burst of resizes as one, the session in it, its end", async () => {
    told.length = 0;
    t.sized(80, 24);
    t.sized(81, 24);
    t.sized(82, 24);
    await waitFor(() => told.length > 0);
    await sleep(60);
    expect(told.map((r) => [r.cols, r.rows])).toEqual([[82, 24]]);
    const session = { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", status: "idle", native: { id: "x", transport: "pipe", terminal: { host: fake.host.host, id: t.id } } } as Session;
    sessionIn.set(t.id, session);
    bus.emit("session.state", session);
    await waitFor(() => told.some((r) => r.session === session.id));
    expect(rows.list().find((r) => r.id === t.id)?.session).toBe(session.id);
  });

  test("a shell started in a workspace runs in its folder, and counts as work there", async () => {
    const r = await rows.spawn({ workspace: WS.id });
    const spawned = fake.requests.findLast((q) => q.op === "spawn")!;
    expect(spawned.body["cwd"]).toBe(WS.path);
    expect(r).toMatchObject({ id: expect.any(String), status: "running" });
    expect(touched).toEqual([WS.id]);
    // Given a folder, it runs there, whatever workspace it is in: no workspace is touched.
    await rows.spawn({ cwd: ELSEWHERE, workspace: WS.id });
    expect(fake.requests.findLast((q) => q.op === "spawn")!.body["cwd"]).toBe(ELSEWHERE);
    expect(touched).toEqual([WS.id]);
    await expect(rows.spawn({ workspace: WS_AWAY.id })).rejects.toMatchObject({ code: "unsupported" });
    // a folder that is not there, and another node's terminal, are refused before the host hears of them
    const spawns = fake.requests.filter((q) => q.op === "spawn").length;
    await expect(rows.spawn({ cwd: join(places, "gone") })).rejects.toMatchObject({ code: "not_found" });
    await expect(rows.spawn({ node: "node_01ARZ3NDEKTSV4RRFFQ69G5FC0" })).rejects.toMatchObject({ code: "unsupported" });
    expect(fake.requests.filter((q) => q.op === "spawn").length).toBe(spawns);
    await expect(rows.spawn({ workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB9" })).rejects.toMatchObject({ code: "not_found" });
    expect(touched).toEqual([WS.id]);
  });

  test("closing with `end` ends the program; a client that goes stops the subscription", async () => {
    const other = fake.add({ argv: ["bash"] });
    await waitFor(() => tether.byId(other.id));
    await streams.open(A, other.id, {});
    await streams.close(A, other.id, true);
    expect(fake.requests.some((r) => r.op === "kill" && r.body["session"] === other.id)).toBe(true);
    await waitFor(() => told.some((r) => r.id === other.id && r.status === "exited"));
    for (const id of [A, B, C, D]) streams.dropClient(id);
    expect(streams.viewers(t.id)).toBe(0);
    await waitFor(() => fake.requests.some((r) => r.op === "unsubscribe"));
  });
});

describe("terminals through the daemon", () => {
  let fake: FakeTether;
  let d: Awaited<ReturnType<typeof testDaemon>>;
  let c: TestClient;
  let t: FakeSession;
  let scratch: string;

  beforeAll(async () => {
    scratch = tempHome();
    fake = await new FakeTether(join(scratch, "tether")).start();
    t = fake.add({ argv: ["pwsh.exe"], cwd: scratch });
    t.setScreen(["PS> "]);
    // Typing into a terminal is `exec`; this user may read but not run.
    d = await testDaemon(`${SAFE_SESSIONS}${SAFE_UPDATE}${SAFE_NODES}[tether]\nprofiles = false\n\n[gate.policy.user]\nexec = "deny"\n`, { tether: tetherFor(fake, scratch) });
    c = await TestClient.connect(d.api.url);
    await c.hello(d.token);
  }, 30_000);

  afterAll(async () => {
    c.close();
    await stopDaemon(d);
    await fake.stop();
  });

  test("a client hears the terminals at hello, and in terminal.list", async () => {
    const row = await c.next(isMethod("terminal.state", (p) => (p as Terminal).id === t.id));
    expect(row.params).toMatchObject({ id: t.id, argv0: "pwsh.exe", status: "running" });
    const { terminals } = await c.request<{ terminals: Terminal[] }>("terminal.list");
    expect(terminals.map((x) => x.id)).toContain(t.id);
  });

  test("watching is a read; opening to type or drive is exec, and gated as such", async () => {
    const r = await c.request<{ data: string; seq: number }>("terminal.open", { terminal: t.id });
    expect(r.data).toContain("PS> ");
    t.output("hi");
    const out = await c.next(isMethod("terminal.output", (p) => (p as Output).data === "hi"));
    expect(out.params).toMatchObject({ terminal: t.id, seq: r.seq + 2 });
    const typed = await c.call("terminal.open", { terminal: t.id, input: true });
    expect("error" in typed && typed.error.data?.code).toBe("denied");
    const drive = await c.call("terminal.open", { terminal: t.id, drive: { cols: 80, rows: 24 } });
    expect("error" in drive && drive.error.data?.code).toBe("denied");
    // Keys from a client that may not type go nowhere.
    c.signal("terminal.input", { terminal: t.id, data: "x" });
    await sleep(100);
    expect(t.typed).toEqual([]);
  });

  test("a file under the folder a terminal started in is read for its viewer, audited without its text", async () => {
    mkdirSync(join(scratch, "notes"), { recursive: true });
    writeFileSync(join(scratch, "notes", "todo.md"), "- ship the viewer");
    writeFileSync(join(scratch, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(await c.request("terminal.file", { terminal: t.id, path: "notes/todo.md" })).toMatchObject({ path: "notes/todo.md", size: 17, text: "- ship the viewer" });
    expect(await c.request("terminal.file", { terminal: t.id, path: "dot.png", image: true })).toMatchObject({ binary: true, mime: "image/png", base64: "iVBORw0KGgoA" });
    const outside = await c.call("terminal.file", { terminal: t.id, path: "../x.md" });
    expect("error" in outside && outside.error.data?.code).toBe("invalid");
    const gone = await c.call("terminal.file", { terminal: "0c9e41b27a53", path: "notes/todo.md" });
    expect("error" in gone && gone.error.data?.code).toBe("not_found");
    const row = d.store.audit.list({ limit: 50 }).find((e) => e.action === "terminal.file" && e.outcome === "ok")!;
    expect(row.target).toBe(t.id);
    expect(JSON.stringify(row)).not.toContain("ship the viewer");
  });
});

describe("the shell a terminal starts", () => {
  test("$SHELL, a login shell on macOS as Terminal starts it; /bin/sh without one", () => {
    expect(shellOf({ SHELL: "/bin/zsh" }, "darwin")).toEqual(["/bin/zsh", "-l"]);
    expect(shellOf({ SHELL: "/bin/bash" }, "linux")).toEqual(["/bin/bash"]);
    expect(shellOf({}, "linux")).toEqual(["/bin/sh"]);
  });
});
