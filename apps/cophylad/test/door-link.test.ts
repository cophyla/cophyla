// A machine at its sign-in screen, end to end on one machine: a signed-in primary on the LAN
// (TURN from its account), a secondary sharing its desktop on the fake host, and that
// secondary's sign-in door with a scripted shim. With the secondary's daemon gone and the
// console at the sign-in screen, the door joins the primary as the machine (`door: true`):
// its row says so, and only its desktop is reached. A phone on the primary opens it without
// anyone asked, the page coming through the pipes; the desktop app of a machine that never
// paired with it is refused; a request for anything else of the machine is told why, and a
// fan-out leaves the door out. The machine's own daemon coming back stands the door down
// before its join (no link replaced on the primary) and lets the phone back in unasked. A door
// never takes the link from a daemon that holds it. A key the primary hands the grant, and the
// grant's end, reach the daemon through the door's answer to its attach. A hands machine's door
// joins as hands, switched only on the machine itself.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/load.ts";
import type { Kit } from "../src/door/kit.ts";
import { startDoor } from "../src/door/index.ts";
import { Serving } from "../src/door/serving.ts";
import type { ServingDeps } from "../src/door/serving.ts";
import { readLinkFile } from "../src/grants/link-file.ts";
import { createLogger, silentLogger } from "../src/log.ts";
import { HostApi } from "../src/remote/host.ts";
import { startFakeApollo } from "./fakes/apollo.ts";
import type { FakeApollo } from "./fakes/apollo.ts";
import { FakeShim } from "./fakes/door-shim.ts";
import { FakeNet, FakeWire } from "./fakes/net.ts";
import { TestForwarder } from "./fakes/pipe-forwarder.ts";
import type { PipeLink } from "./fakes/pipe-forwarder.ts";
import { FAKE_WEB, remoteSeams } from "./fakes/remote.ts";
import type { RemoteSeams } from "./fakes/remote.ts";
import { FakeServer } from "./fakes/server.ts";
import { removeHome, TestClient, tempHome, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
let fake: FakeServer | undefined;
let apollo: FakeApollo | undefined;
const closers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
  await fake?.stop();
  fake = undefined;
  await apollo?.stop();
  apollo = undefined;
});

function signedInHome(f: FakeServer): { home: string; toml: string } {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, f.mintToken() + "\n", { mode: 0o600 });
  return { home, toml: `[cloud]\nenabled = true\nurl = "${f.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n[direct]\nrestart_backoff_ms = 50\n\n` };
}

interface Setup {
  p: Primary;
  s: Started;
  seams: RemoteSeams;
  wire: FakeWire;
  /** What the secondary was started with, to start it again on its home. */
  secondaryOpts: Parameters<typeof startSecondary>[1];
}

/** The primary on the LAN, signed in; the secondary linked to it there (as hands if asked), sharing its desktop on the fake host, with direct connections on. */
async function start(opts: { hands?: boolean } = {}): Promise<Setup> {
  fake = new FakeServer();
  apollo = await startFakeApollo();
  apollo.acceptAny = true;
  const wire = new FakeWire();
  const netP = new FakeNet();
  const netS = new FakeNet();
  netP.wire = wire;
  netS.wire = wire;
  const ph = signedInHome(fake);
  // `lan_route` off: the primary treats the secondary's desktop as one it has no route to, as it is from a phone away
  primary = await startPrimary({ heartbeatMs: 1000, home: ph.home, toml: ph.toml + `[remote]\nlan_route = false\n\n`, daemon: { cloud: { keys: [fake.publicKey] }, direct: { spawn: netP.spawn, command: () => "cophyla-net" } } });
  await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
  await primary.d.direct.enable();
  await waitFor(() => primary!.d.direct.ready, 5000);
  const seams = remoteSeams();
  seams.screen = { width: 1920, height: 1080 };
  const port = apollo.port;
  const secondaryOpts: Parameters<typeof startSecondary>[1] = {
    node: `name = "den"\n`,
    ...(opts.hands ? { hands: true } : {}),
    toml: `[remote]\nenabled = true\nhost_command = "C:\\\\fake\\\\Apollo\\\\sunshine.exe"\npoll_ms = 100\n\n[direct]\nrestart_backoff_ms = 50\n\n`,
    heartbeatMs: 1000,
    daemon: {
      direct: { spawn: netS.spawn, command: () => "cophyla-net", link: { firstTryMs: 60_000, retryMs: [60_000] } },
      remote: {
        os: "windows",
        exec: seams.exec,
        hostApi: (kind) => new HostApi({ kind, port, log: silentLogger, timeoutMs: 3000 }),
        moonlight: { spawn: seams.spawn, command: seams.moonlight },
        screenshot: seams.screenshot,
        display: seams.display,
        web: { command: [process.execPath, FAKE_WEB] },
      },
    },
  };
  secondary = await startSecondary(primary, secondaryOpts);
  await secondary.remote.ready();
  await linked(secondary, 10_000);
  // a guest's direct connections run on its primary's plan while linked
  await waitFor(async () => {
    await secondary!.direct.enable().catch(() => undefined);
    return secondary!.direct.ready;
  }, 10_000);
  return { p: primary, s: secondary, seams, wire, secondaryOpts };
}

interface DoorRun {
  shim: FakeShim;
  door: ReturnType<typeof startDoor>;
  lines: string[];
  home: string;
}

/** The secondary's sign-in door, on a home and a program folder of its own, its kit written there, its shim scripted. */
async function startDoorFor(setup: Setup, kit: Kit, opts: { console?: "signin" | "locked" | "active" } = {}): Promise<DoorRun> {
  const home = tempHome();
  const program = join(home, "program");
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "kit.json"), JSON.stringify(kit));
  const shim = new FakeShim({ console: opts.console ?? "signin" });
  const lines: string[] = [];
  const log = createLogger("debug", (line) => void lines.push(line), "door");
  const netD = new FakeNet();
  netD.wire = setup.wire;
  const port = apollo!.port;
  const door = startDoor({
    home,
    program,
    io: shim.io,
    log,
    door: {
      timing: { goneMs: 100, graceMs: 2000 },
      prepare: async () => undefined,
      exit: () => undefined,
      serving: (d: ServingDeps) =>
        new Serving({
          ...d,
          remote: { os: "windows", exec: setup.seams.exec, hostApi: (kind) => new HostApi({ kind, port, log: silentLogger, timeoutMs: 3000 }), web: { command: [process.execPath, FAKE_WEB] }, display: setup.seams.display },
          spawnNet: netD.spawn,
          netCommand: () => "cophyla-net",
          streamerGone: async () => undefined,
        }),
    },
  });
  await shim.start();
  closers.push(async () => {
    await door.stop();
    await shim.stop();
    removeHome(home);
  });
  return { shim, door, lines, home };
}

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { redirect: "manual", headers });

/** A phone on the primary's controller listener, said hello with a grant of the user's. */
async function phoneOn(p: Primary): Promise<TestClient> {
  const { token } = p.d.grants.createController("Pixel");
  const phone = await TestClient.connect(`wss://127.0.0.1:${p.d.controller!.port}/ws/client`, { insecure: true });
  closers.push(() => phone.close());
  expect("error" in (await phone.call("hello", { token, kind: "controller", name: "Pixel", audio: { in: false, out: false }, forward: true }))).toBe(false);
  return phone;
}

/** The phone's own forwarder over its socket, its pipes running through the primary. */
function forwarderFor(phone: TestClient, node: string): TestForwarder {
  const link: PipeLink = {
    request: (method, params) => phone.request(method, params),
    signal: (method, params) => phone.signal(method, params),
    listen: (handler) => {
      phone.onNotification = (n) => handler(n.method, n.params);
    },
  };
  const f = new TestForwarder(link, node);
  closers.push(() => f.stop());
  return f;
}

describe("a machine at its sign-in screen", () => {
  test("its door joins as the machine, a phone reaches its desktop unasked, nothing else of it is reached; the daemon back stands the door down and lets the phone back in", async () => {
    const setup = await start();
    const { p, s } = setup;
    const id = s.identity.id;
    s.store.meta.set("door_enabled", "1");
    const kit = s.door.kitNow()!;
    expect(kit.host).toBeDefined();
    expect(kit.primary).toBe(false);
    expect(kitRefusalOf(kit)).toBeUndefined();

    // the machine's daemon goes; the door, at the sign-in screen, takes the machine's place
    const home = s.home;
    await s.stop();
    secondary = undefined;
    await waitFor(() => p.d.nodes.registry.get(id)?.status === "offline", 10_000);
    const run = await startDoorFor(setup, kit);
    const row = await waitFor(() => {
      const r = p.d.nodes.registry.get(id);
      return r?.status === "online" && r.door === "signin" ? r : undefined;
    }, 15_000);
    expect(row.backup).toBeUndefined();
    expect(row.hands).toBeUndefined();
    expect(row.capabilities.harnesses).toEqual([]);
    // the console locks: the row follows
    run.shim.console("locked");
    await waitFor(() => p.d.nodes.registry.get(id)?.door === "locked", 5000);
    run.shim.console("signin");
    await waitFor(() => p.d.nodes.registry.get(id)?.door === "signin", 5000);

    // the phone: no ask anywhere, the page through the pipes
    const phone = await phoneOn(p);
    await waitFor(async () => {
      const st = (await p.d.remote.states()).find((x) => x.node === id);
      return st?.host.status === "ready" && st.door?.state === "serving";
    }, 15_000);
    const opened = await phone.request<{ path: string; transport: string; node: string; stream: string }>("remote.open", { node: id });
    expect(opened).toMatchObject({ transport: "webrtc", node: id });
    expect(p.d.asks.listOpen().filter((a) => a.source.kind === "gate")).toEqual([]);
    const f = forwarderFor(phone, id);
    const claim = await get(`http://127.0.0.1:${f.port}${opened.path}`);
    expect(claim.status).toBe(200);
    expect(await claim.text()).toContain(`s.dataTransport="webrtc"`);
    // the door's own audit row says why it let the phone in
    expect(run.lines.some((l) => l.includes('"source":"door"') && l.includes("phones"))).toBe(true);

    // the desktop app on the primary: a machine that never paired a viewer with this desktop
    const ui = await client(p.d, "desk app");
    closers.push(() => ui.close());
    const refused = await ui.call("remote.open", { node: id, embed: true });
    expect("error" in refused && refused.error.message).toMatch(/has not viewed this desktop before/);

    // anything else of the machine is told why; a fan-out leaves the door out
    const enable = await ui.call("remote.enable", { node: id });
    expect("error" in enable && enable.error.message).toBe("den is at its sign-in screen: only its desktop can be reached until someone signs in there");
    const terminals = await ui.call("terminal.folders", { node: id });
    expect("error" in terminals && terminals.error.message).toMatch(/at its sign-in screen/);
    expect("error" in (await ui.call("session.list", {}))).toBe(false);

    // the machine's daemon comes back: the door stands down before its join, no link is replaced
    const restarted = await startSecondaryOn(home, setup, run.shim.pipe);
    secondary = restarted;
    await waitFor(() => restarted.door.attached, 10_000);
    await linked(restarted, 15_000);
    await waitFor(() => p.d.nodes.registry.get(id)?.door === undefined && p.d.nodes.registry.get(id)?.status === "online", 10_000);
    expect(run.door.door.servingNow).toBe(false);
    expect(run.lines.some((l) => l.includes("replaced by a new link"))).toBe(false);
    expect(run.lines.some((l) => l.includes("the sign-in door stands down") && l.includes("Cophyla started here"))).toBe(true);
    await restarted.remote.ready();
    await waitFor(() => restarted.direct.ready, 10_000);

    // the phone opens it again: the daemon lets the viewer the door held back in, with no one asked
    const again = await phone.request<{ path: string; stream: string }>("remote.open", { node: id });
    expect(again.path).toMatch(/^\/remote\/\?t=[0-9a-f]{32}$/);
    expect(restarted.asks.listOpen().filter((a) => a.source.kind === "gate" && a.source.action === "remote.ticket")).toEqual([]);
  }, 120_000);

  test("a hands machine's door joins as hands, switched by its owner alone: a phone reaches its desktop unasked, and the daemon back takes the machine again", async () => {
    const setup = await start({ hands: true });
    const { p, s } = setup;
    const id = s.identity.id;
    // from the primary the switch is the owner's, as sharing is
    const ui = await client(p.d, "desk app");
    closers.push(() => ui.close());
    const thrown = await ui.call("remote.door", { node: id, on: true });
    expect("error" in thrown && thrown.error.message).toMatch(/its owner's to switch/);
    expect(s.store.meta.get("door_enabled")).not.toBe("1");
    // on the machine itself it is switched as anywhere else
    s.store.meta.set("door_enabled", "1");
    const kit = s.door.kitNow()!;
    expect(kit.hands).toBe(true);
    expect(kitRefusalOf(kit)).toBeUndefined();

    const home = s.home;
    await s.stop();
    secondary = undefined;
    await waitFor(() => p.d.nodes.registry.get(id)?.status === "offline", 10_000);
    const run = await startDoorFor(setup, kit);
    const row = await waitFor(() => {
      const r = p.d.nodes.registry.get(id);
      return r?.status === "online" && r.door === "signin" ? r : undefined;
    }, 15_000);
    expect(row.hands).toBe(true);
    expect(row.backup).toBeUndefined();

    const phone = await phoneOn(p);
    await waitFor(async () => (await p.d.remote.states()).find((x) => x.node === id)?.door?.state === "serving", 15_000);
    const opened = await phone.request<{ path: string; node: string }>("remote.open", { node: id });
    expect(opened.node).toBe(id);
    expect(p.d.asks.listOpen().filter((a) => a.source.kind === "gate")).toEqual([]);
    const claim = await get(`http://127.0.0.1:${forwarderFor(phone, id).port}${opened.path}`);
    expect(claim.status).toBe(200);

    // the machine's daemon back: the door stands down, and the node links as hands again
    const restarted = await startSecondaryOn(home, setup, run.shim.pipe);
    secondary = restarted;
    await linked(restarted, 15_000);
    await waitFor(() => p.d.nodes.registry.get(id)?.door === undefined && p.d.nodes.registry.get(id)?.status === "online", 10_000);
    expect(p.d.nodes.registry.get(id)?.hands).toBe(true);
    expect(run.lines.some((l) => l.includes("replaced by a new link"))).toBe(false);
  }, 120_000);

  test("a door never takes the link from the machine's own daemon", async () => {
    const setup = await start();
    const { p, s } = setup;
    const id = s.identity.id;
    s.store.meta.set("door_enabled", "1");
    const run = await startDoorFor(setup, s.door.kitNow()!);
    // it tries, and the primary refuses it while the node is linked itself
    await waitFor(() => run.lines.some((l) => l.includes("the sign-in door holds this machine's desktop")), 10_000);
    await Bun.sleep(1500);
    expect(s.nodes.linked()).toBe(true);
    expect(p.d.nodes.registry.get(id)?.door).toBeUndefined();
    expect(p.d.nodes.registry.get(id)?.status).toBe("online");
  }, 60_000);

  test("a key the primary handed the grant and the grant's end reach the daemon through the door", async () => {
    const setup = await start();
    const { p, s } = setup;
    const id = s.identity.id;
    s.store.meta.set("door_enabled", "1");
    const kit = s.door.kitNow()!;
    const grant = kit.link.grant;
    const home = s.home;
    await s.stop();
    secondary = undefined;
    await waitFor(() => p.d.nodes.registry.get(id)?.status === "offline", 10_000);
    const run = await startDoorFor(setup, kit);
    await waitFor(() => p.d.nodes.registry.get(id)?.door === "signin" && p.d.nodes.registry.get(id)?.status === "online", 15_000);

    // the primary hands the grant a new key over the door's link
    const key = "a".repeat(64);
    const inbound = (p.d.nodes as unknown as { inbound: { rekey(node: string, key: string, timeoutMs: number): Promise<boolean> } }).inbound;
    expect(await inbound.rekey(id, key, 3000)).toBe(true);
    p.d.grants.rekey(grant, key);
    // the daemon back takes it before it links, and links with it
    const restarted = await startSecondaryOn(home, setup, run.shim.pipe);
    secondary = restarted;
    await linked(restarted, 15_000);
    expect(readLinkFile(restarted.paths.linkFile)!.key).toBe(key);

    // the grant ends while the door holds the link again: the daemon back forgets its membership
    await restarted.stop();
    secondary = undefined;
    await waitFor(() => p.d.nodes.registry.get(id)?.door === "signin" && p.d.nodes.registry.get(id)?.status === "online", 15_000);
    await p.d.nodes.revoke(grant);
    await waitFor(() => run.lines.some((l) => l.includes("the primary ended this machine's grant")), 10_000);
    const last = await startSecondaryOn(home, setup, run.shim.pipe);
    secondary = last;
    await waitFor(() => last.nodes.member() === undefined, 10_000);
    expect(readLinkFile(last.paths.linkFile)).toBeUndefined();
    // and the door holds nothing for the machine: the kit its daemon still brought was not taken
    expect(existsSync(join(run.home, "data", "kit.json"))).toBe(false);
  }, 120_000);
});

function kitRefusalOf(kit: Kit): string | undefined {
  return kit.confined || kit.primary || !kit.sharing || !kit.host ? "refused" : undefined;
}

/** The secondary started again on its home, its daemon attaching to the door's pipe first. */
async function startSecondaryOn(home: string, setup: Setup, pipe: string): Promise<Started> {
  const { startDaemon } = await import("../src/daemon.ts");
  const d = await startDaemon({
    home,
    port: 0,
    log: silentLogger,
    brain: false,
    embedder: null,
    env: { ...process.env, GEMINI_API_KEY: undefined },
    ...setup.secondaryOpts!.daemon,
    door: { os: "windows", pipe, client: { verify: async () => undefined }, install: () => undefined },
  });
  return Object.assign(d, { home });
}
