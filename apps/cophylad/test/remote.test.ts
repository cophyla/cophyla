// The remote module through a daemon, on fakes: the host comes up (located by its
// configured path, its service seen running, its credentials made, its config written and
// applied) and `remote.state` reaches a client on connect and on change; `capabilities.remote`
// follows the host; `remote.pair`, `remote.invite` and `remote.revoke` are audited with the
// secrets redacted; a desktop client's `remote.open` pairs moonlight-qt through the host's
// gate and opens the window, a second open replacing it without ending the host's app, sized
// to the host's screen (which `remote.state` carries, read at each poll) until the user saves
// Moonlight's own settings, whose window `remote.open {settings}` opens for the desktop app
// here alone; `remote.state.streaming` follows the host's clients, never the viewer's window; the brain gets
// a frame with the shape the protocol promises; with the host off the host methods answer
// `unavailable`, and a controller on loopback cannot open a stream page.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, Client, RemoteState } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { RemoteConfig } from "../src/config/schema.ts";
import type { Daemon } from "../src/daemon.ts";
import { HostApi, PERM_VIEWER } from "../src/remote/host.ts";
import { Remote } from "../src/remote/index.ts";
import { silentLogger } from "../src/log.ts";
import type { Sidecars } from "../src/sidecars/index.ts";
import { startFakeApollo } from "./fakes/apollo.ts";
import type { FakeApollo } from "./fakes/apollo.ts";
import { remoteSeams, TINY_JPEG } from "./fakes/remote.ts";
import type { RemoteSeams } from "./fakes/remote.ts";
import { brainFrames, isMethod, removeHome, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");

interface Started {
  d: Daemon & { home: string };
  fake: FakeApollo;
  seams: RemoteSeams;
  scratch: string;
  brainLog: string;
}

let current: Started | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  if (!current) return;
  await stopDaemon(current.d);
  await current.fake.stop();
  removeHome(current.scratch);
  current = undefined;
});

interface StartOptions {
  enabled?: boolean;
  toml?: string;
  seams?: Partial<Parameters<typeof remoteSeams>[0]>;
  /** The fake brain's script; no brain when absent. */
  script?: object;
  hostCredentials?: { username: string; password: string };
  kind?: "apollo" | "sunshine";
}

async function start(opts: StartOptions = {}): Promise<Started> {
  const scratch = tempHome();
  const fake = await startFakeApollo({ ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.hostCredentials ? { credentials: opts.hostCredentials } : {}) });
  const seams = remoteSeams(opts.seams ?? {});
  seams.onPair = (_host, pin) => fake.expectPin(pin);
  const brainLog = join(scratch, "brain.log");
  const scriptPath = join(scratch, "brain-script.json");
  if (opts.script) writeFileSync(scriptPath, JSON.stringify(opts.script));
  const brain = opts.script ? `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n"brain:remote.screenshot" = "allow"\n\n` : "";
  const toml =
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[node]\nname = "study"\n\n` +
    brain +
    `[remote]\nenabled = ${opts.enabled === false ? "false" : "true"}\nhost_command = ${tomlString(`C:\\fake\\${opts.kind === "sunshine" ? "Sunshine\\sunshine.exe" : "Apollo\\sunshine.exe"}`)}\nmoonlight = ${tomlString(seams.moonlight)}\npoll_ms = 100\n${opts.toml ?? ""}`;
  writeFileSync(join(scratch, "config.toml"), toml);
  const { startDaemon } = await import("../src/daemon.ts");
  const d = Object.assign(
    await startDaemon({
      home: scratch,
      port: 0,
      log: silentLogger,
      brain: Boolean(opts.script),
      embedder: null,
      env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: brainLog, GEMINI_API_KEY: undefined },
      remote: {
        os: "windows",
        exec: seams.exec,
        hostApi: (kind) => new HostApi({ kind, port: fake.port, log: silentLogger, timeoutMs: 3000 }),
        moonlight: { spawn: seams.spawn, command: seams.moonlight },
        screenshot: seams.screenshot,
        display: seams.display,
      },
    }),
    { home: scratch },
  );
  await d.remote.ready();
  current = { d, fake, seams, scratch, brainLog };
  return current;
}

/** The same home started again, config.toml untouched, the host still up. */
async function restart(s: Started): Promise<Started> {
  for (const c of clients.splice(0)) c.close();
  // stopped, not removed: the store with the switch in it stays
  await s.d.stop();
  const { startDaemon } = await import("../src/daemon.ts");
  const d = Object.assign(
    await startDaemon({
      home: s.scratch,
      port: 0,
      log: silentLogger,
      brain: false,
      embedder: null,
      remote: {
        os: "windows",
        exec: s.seams.exec,
        hostApi: (kind) => new HostApi({ kind, port: s.fake.port, log: silentLogger, timeoutMs: 3000 }),
        moonlight: { spawn: s.seams.spawn, command: s.seams.moonlight },
        screenshot: s.seams.screenshot,
        display: s.seams.display,
      },
    }),
    { home: s.scratch },
  );
  await d.remote.ready();
  current = { ...s, d };
  return current;
}

/** A client of the host's, as a viewer it paired outside cophylad. */
const hostClient = (uuid: string, name: string, connected = false) => ({ uuid, name, perm: 119480064, connected, allow_client_commands: true, always_use_virtual_display: false, display_mode: "", enable_legacy_ordering: true });

async function ui(d: Daemon, name = "desk"): Promise<TestClient> {
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name });
  clients.push(c);
  return c;
}

const audit = (d: Daemon, action: string): AuditEntry[] => d.store.audit.list({ limit: 200 }).filter((e) => e.action === action).reverse();

/** A request that must fail: its error code and message. */
async function failure(c: TestClient, method: string, params?: unknown): Promise<{ code: string; message: string }> {
  const r = await c.call(method, params);
  if (!("error" in r)) throw new Error(`${method} succeeded: ${JSON.stringify(r.result)}`);
  return { code: (r.error.data as { code?: string } | undefined)?.code ?? "", message: r.error.message };
}

describe("remote desktop", () => {
  test("the host comes up: credentials made, config written and applied, state on connect and on change, the node capable", async () => {
    const { d, fake, seams } = await start();
    expect(d.remote.state().host).toEqual({ kind: "apollo", status: "ready" });
    expect(fake.credentials?.username).toBe("cophyla");
    const kept = JSON.parse(readFileSync(join(d.paths.data, "remote", "host.json"), "utf8"));
    expect(kept).toEqual(fake.credentials);
    expect(fake.config).toEqual({ sunshine_name: "study", origin_web_ui_allowed: "pc" });
    expect(fake.restarts).toBe(1);
    expect(seams.commands.some((c) => c.startsWith("winget"))).toBe(false);

    const c = await ui(d);
    const first = (await c.next(isMethod("remote.state"))).params as RemoteState;
    expect(first.node).toBe(d.identity.id);
    expect(first.host.status).toBe("ready");
    expect(first.viewers).toEqual([]);
    expect(first.streaming).toBe(false);
    const nodes = await c.request<{ nodes: { capabilities: { remote: boolean } }[] }>("node.list");
    expect(nodes.nodes[0]!.capabilities.remote).toBe(true);

    // a client the host pairs outside cophylad shows up on the next poll, and its stream flips `streaming`
    fake.clients.push({ uuid: "UUID-X", name: "laptop", perm: 119480064, connected: false, allow_client_commands: true, always_use_virtual_display: false, display_mode: "", enable_legacy_ordering: true });
    const seen = (await c.next(isMethod("remote.state", (p) => (p as RemoteState).viewers.length === 1))).params as RemoteState;
    expect(seen.viewers[0]).toMatchObject({ id: "UUID-X", name: "laptop", kind: "native", connected: false });
    fake.connect("UUID-X");
    const streaming = (await c.next(isMethod("remote.state", (p) => (p as RemoteState).streaming))).params as RemoteState;
    expect(streaming.viewers[0]!.connected).toBe(true);
  });

  test("a client paired under a machine's name is that machine's viewer, its web viewer under the name and \" web\"; the match outlives a rename and a restart, and goes with the client", async () => {
    let s = await start();
    const { fake } = s;
    fake.clients.push(hostClient("UUID-M", "study"), hostClient("UUID-W", "study web"), hostClient("UUID-O", "Artemis on a phone"));
    await waitFor(() => s.d.remote.state().viewers.length === 3);
    const byId = () => new Map(s.d.remote.state().viewers.map((v) => [v.id, v]));
    expect(byId().get("UUID-M")).toMatchObject({ name: "study", pairedBy: s.d.identity.id });
    expect(byId().get("UUID-M")!.browser).toBeUndefined();
    expect(byId().get("UUID-W")).toMatchObject({ name: "study web", pairedBy: s.d.identity.id, browser: true });
    // paired by hand, or by another app: nobody's
    expect(byId().get("UUID-O")!.pairedBy).toBeUndefined();

    // renamed, the machine keeps the clients it paired under its old name
    const c = await ui(s.d);
    await c.request("node.rename", { id: s.d.identity.id, name: "Den" });
    fake.clients.push(hostClient("UUID-N", "laptop"));
    await waitFor(() => s.d.remote.state().viewers.length === 4);
    expect(byId().get("UUID-M")!.pairedBy).toBe(s.d.identity.id);
    expect(byId().get("UUID-W")!.browser).toBe(true);
    expect(byId().get("UUID-N")!.pairedBy).toBeUndefined();

    s = await restart(s);
    await waitFor(() => s.d.remote.state().viewers.length === 4);
    expect(byId().get("UUID-M")!.pairedBy).toBe(s.d.identity.id);
    expect(byId().get("UUID-W")).toMatchObject({ pairedBy: s.d.identity.id, browser: true });

    // a client the host no longer lists takes its match with it: one paired again under the name is matched afresh
    fake.clients.splice(fake.clients.findIndex((x) => x.uuid === "UUID-W"), 1);
    await waitFor(() => s.d.remote.state().viewers.length === 3);
    expect(Object.keys(JSON.parse(s.d.store.meta.get("remote_paired_by") ?? "{}"))).toEqual(["study"]);
  });

  test("a stopped service is started; a silent host with no service leaves the host unavailable with the reason", async () => {
    // the host answers nothing until `sc start` runs
    const scratchA = tempHome();
    const fakeA = await startFakeApollo();
    fakeA.down = true;
    const seamsA = remoteSeams({ service: "STOPPED" });
    const execA = seamsA.exec;
    seamsA.exec = async (command, o) => {
      const r = await execA(command, o);
      if (command[0] === "sc" && command[1] === "start") fakeA.down = false;
      return r;
    };
    writeFileSync(join(scratchA, "config.toml"), `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[remote]\nenabled = true\nhost_command = "C:\\\\fake\\\\Apollo\\\\sunshine.exe"\npoll_ms = 100\n`);
    const { startDaemon: startA } = await import("../src/daemon.ts");
    const dA = Object.assign(
      await startA({
        home: scratchA,
        port: 0,
        log: silentLogger,
        brain: false,
        embedder: null,
        remote: { os: "windows", exec: seamsA.exec, hostApi: (kind) => new HostApi({ kind, port: fakeA.port, log: silentLogger, timeoutMs: 500 }), moonlight: { spawn: seamsA.spawn, command: seamsA.moonlight }, screenshot: seamsA.screenshot, display: seamsA.display },
      }),
      { home: scratchA },
    );
    current = { d: dA, fake: fakeA, seams: seamsA, scratch: scratchA, brainLog: "" };
    await dA.remote.ready();
    expect(dA.remote.state().host.status).toBe("ready");
    expect(seamsA.commands).toContain("sc query ApolloService");
    expect(seamsA.commands).toContain("sc start ApolloService");
    await stopDaemon(dA);
    await fakeA.stop();
    removeHome(scratchA);
    current = undefined;

    // the host API pointed at ports nothing listens on: the daemon consults the service manager for the reason
    const scratch = tempHome();
    const silent = await startFakeApollo();
    const port = silent.port;
    await silent.stop();
    const seams = remoteSeams({ service: "absent" });
    writeFileSync(join(scratch, "config.toml"), `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[remote]\nenabled = true\nhost_command = "C:\\\\fake\\\\Apollo\\\\sunshine.exe"\npoll_ms = 100\n`);
    const { startDaemon } = await import("../src/daemon.ts");
    const d = Object.assign(
      await startDaemon({
        home: scratch,
        port: 0,
        log: silentLogger,
        brain: false,
        embedder: null,
        remote: { os: "windows", exec: seams.exec, hostApi: (kind) => new HostApi({ kind, port, log: silentLogger, timeoutMs: 500 }), moonlight: { spawn: seams.spawn, command: seams.moonlight }, screenshot: seams.screenshot, display: seams.display },
      }),
      { home: scratch },
    );
    const fake = await startFakeApollo();
    current = { d, fake, seams, scratch, brainLog: "" };
    await d.remote.ready();
    expect(d.remote.state().host.status).toBe("unavailable");
    expect(d.remote.state().host.reason).toContain("ApolloService is not installed");
    const c = await ui(d);
    expect((await failure(c, "remote.pair", { node: d.identity.id, pin: "1234" })).code).toBe("unavailable");
  });

  test("the host is installed through winget when missing and [remote] install is on", async () => {
    const scratch = tempHome();
    const fake = await startFakeApollo();
    const seams = remoteSeams();
    writeFileSync(join(scratch, "config.toml"), `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[remote]\nenabled = true\npoll_ms = 100\n`);
    const { startDaemon } = await import("../src/daemon.ts");
    const fs = await import("node:fs");
    let installed = false;
    const d = Object.assign(
      await startDaemon({
        home: scratch,
        port: 0,
        log: silentLogger,
        brain: false,
        embedder: null,
        remote: {
          os: "windows",
          env: { ProgramFiles: join(scratch, "pf") },
          exec: async (command, o) => {
            const r = await seams.exec(command, o);
            if (command[0] === "winget") {
              installed = true;
              mkdirSync(join(scratch, "pf", "Apollo"), { recursive: true });
              fs.writeFileSync(join(scratch, "pf", "Apollo", "sunshine.exe"), "");
            }
            return r;
          },
          hostApi: (kind) => new HostApi({ kind, port: fake.port, log: silentLogger, timeoutMs: 3000 }),
          moonlight: { spawn: seams.spawn, command: seams.moonlight },
          screenshot: seams.screenshot,
          display: seams.display,
        },
      }),
      { home: scratch },
    );
    current = { d, fake, seams, scratch, brainLog: "" };
    await d.remote.ready();
    expect(installed).toBe(true);
    expect(seams.commands[0]).toBe("winget install -e --id ClassicOldSong.Apollo --accept-package-agreements --accept-source-agreements");
    expect(d.remote.state().host).toEqual({ kind: "apollo", status: "ready" });
  });

  test("remote.pair, remote.invite and remote.revoke are audited with the pin, the code and the link redacted", async () => {
    const { d, fake } = await start();
    const c = await ui(d);
    fake.expectPin("4821");
    await c.request("remote.pair", { node: d.identity.id, pin: "4821", name: "laptop" });
    expect(fake.clients.map((x) => x.name)).toEqual(["laptop"]);
    // the first client the host pairs gets everything already; the grant leaves it alone
    const [pair] = audit(d, "remote.pair");
    expect(pair!.outcome).toBe("ok");
    expect(pair!.target).toBe("laptop");
    expect((pair!.args as { pin: string }).pin).toBe("[redacted]");
    // a later one gets view and list only, and is listed a moment after the host takes its PIN:
    // it is waited for and granted its inputs
    fake.listDelayMs = 700;
    fake.expectPin("5930");
    await c.request("remote.pair", { node: d.identity.id, pin: "5930", name: "tablet" });
    expect((fake.clients.find((x) => x.name === "tablet")!.perm as number) & PERM_VIEWER).toBe(PERM_VIEWER);
    await c.request("remote.revoke", { node: d.identity.id, viewer: fake.clients.find((x) => x.name === "tablet")!.uuid as string });
    fake.listDelayMs = 0;

    const invite = await c.request<{ otp: string; link: string; passphrase: string; expiresAt: number }>("remote.invite", { node: d.identity.id });
    expect(invite.otp).toBe("1000");
    expect(invite.link).toBe(`art://192.168.1.44:47989?pin=1000&passphrase=${invite.passphrase}&name=study`);
    expect(invite.passphrase).toMatch(/^cophyla-[0-9a-f]{6}$/);
    expect(invite.expiresAt).toBeGreaterThan(Date.now());
    const [inv] = audit(d, "remote.invite");
    const body = inv!.result!.body as { otp: string; link: string; passphrase: string };
    expect(body.otp).toBe("[redacted]");
    expect(body.passphrase).toBe("[redacted]");
    expect(body.link).toBe("art://192.168.1.44:47989?pin=[redacted]&passphrase=[redacted]&name=study");
    expect(inv!.result!.summary).not.toContain("1000");

    const state = await c.next(isMethod("remote.state", (p) => (p as RemoteState).viewers.length === 1));
    const viewer = (state.params as RemoteState).viewers[0]!;
    await c.request("remote.revoke", { node: d.identity.id, viewer: viewer.id });
    expect(fake.clients).toEqual([]);
    expect(audit(d, "remote.revoke").at(-1)!.target).toBe(viewer.id);
    expect((await failure(c, "remote.revoke", { node: d.identity.id, viewer: "nobody" })).message).toMatch(/no viewer/);
  });

  test("a desktop client opens this desktop: moonlight is checked, paired through the host's gate under the node's name, and streamed", async () => {
    const { d, fake, seams } = await start();
    const c = await ui(d);
    await c.next(isMethod("remote.state"));
    expect(await c.request<object>("remote.open", { node: d.identity.id })).toEqual({});
    const moon = seams.commands.filter((x) => x.startsWith(seams.moonlight)).map((x) => x.slice(seams.moonlight.length + 1));
    expect(moon[0]).toBe("list 127.0.0.1");
    expect(moon[1]).toMatch(/^pair 127\.0\.0\.1 --pin \d{4}$/);
    // the app list answering again is the proof the pairing was kept; the pair process is then ended
    expect(moon[2]).toBe("list 127.0.0.1");
    // no screen read here: the stream falls back to 1080p, at the bitrate for it
    expect(moon[3]).toBe("stream 127.0.0.1 Desktop --resolution 1920x1080 --fps 60 --bitrate 31104 --display-mode windowed --absolute-mouse --quit-after");
    expect(seams.children.find((ch) => ch.args[0] === "pair")!.killed).toBe(true);
    const pin = moon[1]!.split(" ").at(-1)!;
    expect(fake.pins.some((p) => p.pin === pin && p.name === "study" && p.ok)).toBe(true);
    expect(fake.clients.map((x) => x.name)).toEqual(["study"]);
    const pair = audit(d, "remote.pair")[0]!;
    expect(pair.principal.kind).toBe("user");
    expect(pair.target).toBe("study");
    expect((pair.args as { pin: string }).pin).toBe("[redacted]");
    expect(audit(d, "remote.open")[0]!.outcome).toBe("ok");
    // the window is this node viewing, not this desktop watched: `streaming` stays with the host's list
    expect(d.remote.state().streaming).toBe(false);
    // a second open streams again without pairing, ending the first window rather than the host's app
    await c.request("remote.open", { node: d.identity.id });
    const later = seams.commands.filter((x) => x.startsWith(seams.moonlight)).map((x) => x.slice(seams.moonlight.length + 1));
    expect(later.filter((x) => x.startsWith("pair")).length).toBe(1);
    expect(later.filter((x) => x.startsWith("quit")).length).toBe(0);
    const streams = seams.children.filter((ch) => ch.args[0] === "stream");
    expect(streams.map((ch) => ch.killed)).toEqual([true, false]);
  });

  test("the host's screen rides its remote.state, read at each poll; Connect sizes Moonlight to it until the user saves Moonlight's own settings", async () => {
    const { d, seams } = await start({ seams: { paired: ["127.0.0.1"] } });
    const c = await ui(d);
    await c.next(isMethod("remote.state"));
    seams.screen = { width: 1920, height: 1200 };
    await c.next(isMethod("remote.state", (p) => (p as RemoteState).host.display?.height === 1200));
    expect(d.remote.state().host).toEqual({ kind: "apollo", status: "ready", display: { width: 1920, height: 1200 } });
    const streams = () => seams.children.filter((ch) => ch.args[0] === "stream").map((ch) => ch.args.slice(1).join(" "));
    await c.request("remote.open", { node: d.identity.id });
    expect(streams().at(-1)).toBe("127.0.0.1 Desktop --resolution 1920x1200 --fps 60 --bitrate 34560 --display-mode windowed --absolute-mouse --quit-after");
    expect(seams.commands).toContain("reg query HKCU\\Software\\Moonlight Game Streaming Project\\Moonlight /v width");
    // a change of resolution reaches the state at the next poll, and the next window
    seams.screen = { width: 2560, height: 1440 };
    await c.next(isMethod("remote.state", (p) => (p as RemoteState).host.display?.width === 2560));
    await c.request("remote.open", { node: d.identity.id });
    expect(streams().at(-1)).toContain(" --resolution 2560x1440 --fps 60 --bitrate 55296 ");
    // saved in Moonlight's own window: its settings, none of Cophyla's picks
    seams.moonlightSaved = true;
    await c.request("remote.open", { node: d.identity.id });
    expect(streams().at(-1)).toBe("127.0.0.1 Desktop --display-mode windowed --absolute-mouse --quit-after");
  });

  test("remote.open with settings opens Moonlight's own window for the desktop app on this machine, and for nobody else", async () => {
    const { d, seams } = await start();
    const c = await ui(d);
    expect(await c.request<object>("remote.open", { node: d.identity.id, settings: true })).toEqual({});
    expect(seams.children.map((ch) => `${ch.command} ${ch.args.join(" ")}`.trim())).toEqual([seams.moonlight]);
    expect(audit(d, "remote.open")[0]!.outcome).toBe("ok");
    // a phone has no Moonlight here, nor does an app on another node
    const { token } = d.grants.createController("phone");
    const phone = await TestClient.connect(d.api.url);
    clients.push(phone);
    await phone.call("hello", { token, kind: "controller", audio: { in: false, out: false } });
    expect((await failure(phone, "remote.open", { node: d.identity.id, settings: true })).message).toMatch(/desktop app on this machine/);
    const elsewhere = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FC9", kind: "ui", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW" } as unknown as Client;
    await expect(d.remote.settings(elsewhere)).rejects.toThrow(/desktop app on this machine/);
    expect(seams.children).toHaveLength(1);
  });

  test("the pin the host is asked to accept goes through the host's own gate rule and can be denied", async () => {
    const { d, fake, seams } = await start({ toml: `\n[gate.rules]\n"user:remote.pair@study" = "deny"\n` });
    const c = await ui(d);
    expect((await failure(c, "remote.open", { node: d.identity.id })).message).toMatch(/policy rule/);
    expect(fake.clients).toEqual([]);
    const pairChild = seams.children.find((ch) => ch.args[0] === "pair");
    expect(pairChild?.killed).toBe(true);
    expect(seams.children.some((ch) => ch.args[0] === "stream")).toBe(false);
  });

  test("the brain's remote.screenshot answers a frame with its size, display and time", async () => {
    const { d, brainLog } = await start({
      script: { on: [{ event: "hello", requests: [{ method: "remote.screenshot", params: { node: "$event.nodeId", display: 1 } }] }] },
    });
    await waitFor(() => d.brain?.state === "up");
    await waitFor(() => brainFrames(brainLog).some((f) => f.dir === "in" && f.frame["result"] !== undefined));
    const frame = brainFrames(brainLog).find((f) => f.dir === "in" && f.frame["result"] !== undefined)!;
    const result = frame.frame["result"] as { image: { mime: string; base64: string }; width: number; height: number; display: number; at: number };
    expect(result.image).toEqual({ mime: "image/jpeg", base64: TINY_JPEG.toString("base64") });
    expect(result).toMatchObject({ width: 1280, height: 800, display: 1 });
    expect(result.at).toBeGreaterThan(0);
    const [entry] = audit(d, "remote.screenshot");
    expect(entry!.principal.kind).toBe("brain");
    expect(entry!.result!.summary).toContain("image");
    // the audit row says a frame was taken and how big it was, and keeps no copy of the screen
    expect((entry!.result!.body as { image: { base64: string } }).image.base64).toBe(`[${Math.floor((TINY_JPEG.toString("base64").length * 3) / 4)} bytes]`);
    expect(entry!.result!.summary).not.toContain(TINY_JPEG.toString("base64").slice(0, 16));
  });

  test("with the host off the host methods answer unavailable, the screenshot still works, and a controller on loopback gets no stream page", async () => {
    const { d } = await start({ enabled: false });
    expect(d.remote.state().host).toEqual({ kind: "none", status: "off" });
    const c = await ui(d);
    const state = (await c.next(isMethod("remote.state"))).params as RemoteState;
    expect(state.host.status).toBe("off");
    expect((await failure(c, "remote.pair", { node: d.identity.id, pin: "1234" })).message).toMatch(/sharing is off/);
    expect((await failure(c, "remote.invite", { node: d.identity.id })).message).toMatch(/sharing is off/);
    expect((await d.remote.screenshot()).width).toBe(1280);
    const nodes = await c.request<{ nodes: { capabilities: { remote: boolean } }[] }>("node.list");
    expect(nodes.nodes[0]!.capabilities.remote).toBe(false);

    const { token } = d.grants.createController("phone");
    const phone = await TestClient.connect(d.api.url);
    clients.push(phone);
    await phone.call("hello", { token, kind: "controller", audio: { in: false, out: false } });
    expect((await failure(phone, "remote.open", { node: d.identity.id })).message).toMatch(/controller listener/);
  });

  test("remote.enable shares a desktop config.toml leaves off; the switch outlives a restart, either way", async () => {
    let s = await start({ enabled: false });
    const c = await ui(s.d);
    await c.next(isMethod("remote.state"));
    expect(await c.request<object>("remote.enable", {})).toEqual({});
    await c.next(isMethod("remote.state", (p) => (p as RemoteState).host.status === "ready"), 10_000);
    expect(s.d.store.meta.get("remote_enabled")).toBe("1");
    expect(audit(s.d, "remote.enable")[0]!.outcome).toBe("ok");
    const nodes = await c.request<{ nodes: { capabilities: { remote: boolean } }[] }>("node.list");
    expect(nodes.nodes[0]!.capabilities.remote).toBe(true);
    // enabling again while it is up changes nothing
    await c.request("remote.enable", {});
    expect(s.fake.restarts).toBe(1);

    s = await restart(s);
    expect(s.d.remote.state().host).toEqual({ kind: "apollo", status: "ready" });
    const c2 = await ui(s.d);
    await c2.request("remote.disable", {});
    expect(s.d.remote.state().host.status).toBe("off");
    s = await restart(s);
    expect(s.d.remote.state().host.status).toBe("off");
   }, 30_000);

  test("remote.disable ends the streams and keeps the pairings: a Windows host is still read, and its viewers can be revoked", async () => {
    const { d, fake } = await start();
    const c = await ui(d);
    fake.clients.push(hostClient("UUID-X", "laptop", true), hostClient("UUID-Y", "tablet"));
    await waitFor(() => d.remote.state().streaming);
    await c.request("remote.disable", { node: d.identity.id });
    // the stream ended, the pairing kept
    expect(fake.requests).toContain("POST /api/clients/disconnect");
    expect(fake.clients.find((x) => x.uuid === "UUID-X")!.connected).toBe(false);
    const off = d.remote.state();
    expect(off.host).toEqual({ kind: "apollo", status: "off" });
    expect(off.viewers.map((v) => v.id).sort()).toEqual(["UUID-X", "UUID-Y"]);
    expect(off.streaming).toBe(false);
    const nodes = await c.request<{ nodes: { capabilities: { remote: boolean } }[] }>("node.list");
    expect(nodes.nodes[0]!.capabilities.remote).toBe(false);

    // still read: a viewer connecting to the service directly shows, as one still paired
    fake.connect("UUID-Y");
    await waitFor(() => d.remote.state().streaming);
    // nothing new is handed out while off; what is there can be taken back
    expect((await failure(c, "remote.invite", { node: d.identity.id })).message).toMatch(/sharing is off/);
    expect((await failure(c, "remote.pair", { node: d.identity.id, pin: "1234" })).message).toMatch(/sharing is off/);
    await c.request("remote.revoke", { node: d.identity.id, viewer: "UUID-X" });
    expect(fake.clients.map((x) => x.uuid)).toEqual(["UUID-Y"]);
    expect(d.store.meta.get("remote_enabled")).toBe("0");
    expect(audit(d, "remote.disable")[0]!.outcome).toBe("ok");

    // shared again, it comes back without a second restart of the host's config
    await c.request("remote.enable", {});
    await waitFor(() => d.remote.state().host.status === "ready", 10_000);
    expect(fake.restarts).toBe(1);
  });

  test("a daemon started with sharing off reads a Windows host that runs anyway, with credentials it knows", async () => {
    const credentials = { username: "me", password: "pw" };
    const { d, fake } = await start({ enabled: false, hostCredentials: credentials, toml: `host_user = "me"\nhost_password = "pw"\n` });
    // nothing is configured or restarted: the host is only read
    expect(fake.restarts).toBe(0);
    expect(fake.config).toEqual({});
    fake.clients.push(hostClient("UUID-Z", "phone"));
    await waitFor(() => d.remote.state().viewers.length === 1);
    expect(d.remote.state().host).toEqual({ kind: "apollo", status: "off" });
    const c = await ui(d);
    await c.request("remote.revoke", { node: d.identity.id, viewer: "UUID-Z" });
    expect(fake.clients).toEqual([]);
  });

  test("a desktop client cannot show this node's own desktop beside its view", async () => {
    const { d } = await start();
    const c = await ui(d);
    expect((await failure(c, "remote.open", { node: d.identity.id, embed: true })).code).toBe("invalid");
  });

  test("a sunshine host has no invite codes and streaming comes from serverinfo", async () => {
    const { d, fake } = await start({ kind: "sunshine" });
    expect(d.remote.state().host.kind).toBe("sunshine");
    const c = await ui(d);
    expect((await failure(c, "remote.invite", { node: d.identity.id })).message).toMatch(/invite/);
    fake.expectPin("1111");
    await c.request("remote.pair", { node: d.identity.id, pin: "1111", name: "laptop" });
    fake.connect("UUID-1");
    const streaming = (await c.next(isMethod("remote.state", (p) => (p as RemoteState).streaming))).params as RemoteState;
    expect(streaming.viewers[0]).toMatchObject({ id: "UUID-1", name: "laptop", kind: "native" });
    expect(streaming.viewers[0]!.connected).toBeUndefined();
  });
});

describe("remote desktop on a sidecar host", () => {
  test("remote.disable stops the host and its list; one switched off while it comes up is stopped again", async () => {
    const fake = await startFakeApollo({ kind: "sunshine" });
    const scratch = tempHome();
    const meta = new Map<string, string>();
    let release: () => void = () => undefined;
    let held = Promise.resolve();
    const calls: string[] = [];
    const sidecar = {
      start: async () => {
        calls.push("start");
        await held;
      },
      stop: async () => void calls.push("stop"),
      state: () => ({ status: "ready" }),
    };
    const sidecars = { spawn: () => sidecar, forget: () => undefined } as unknown as Sidecars;
    const remote = new Remote({
      config: RemoteConfig.parse({ enabled: false, host_command: "/opt/sunshine/bin/sunshine", poll_ms: 100 }),
      store: { meta: { get: (k: string) => meta.get(k), set: (k: string, v: string) => void meta.set(k, v) } },
      nodeId: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      nodeName: "box",
      dir: join(scratch, "remote"),
      sidecarsDir: join(scratch, "sidecars"),
      bus: new Bus(),
      log: silentLogger,
      sidecars,
      pairOn: async () => undefined,
      addressOf: () => undefined,
      lanIps: () => [],
      os: "linux",
      hostApi: (kind) => new HostApi({ kind, port: fake.port, log: silentLogger, timeoutMs: 3000 }),
    });
    try {
      remote.start();
      await remote.ready();
      expect(remote.state().host).toEqual({ kind: "none", status: "off" });
      expect(calls).toEqual([]);

      remote.enable();
      await remote.ready();
      expect(remote.state().host).toEqual({ kind: "sunshine", status: "ready" });
      fake.clients.push(hostClient("UUID-1", "laptop"));
      await waitFor(() => remote.state().viewers.length === 1);

      await remote.disable();
      expect(calls).toEqual(["start", "stop"]);
      expect(remote.state()).toMatchObject({ host: { kind: "sunshine", status: "off" }, viewers: [], streaming: false });
      // its list is not read any more
      fake.clients.push(hostClient("UUID-2", "tablet"));
      await Bun.sleep(300);
      expect(remote.state().viewers).toEqual([]);
      await expect(remote.revoke("UUID-1")).rejects.toThrow(/sharing is off/);

      // switched on, and off again while the host is starting: it gives up and the host goes
      held = new Promise((r) => (release = r));
      remote.enable();
      await waitFor(() => calls.length === 3);
      expect(remote.state().host.status).toBe("starting");
      await remote.disable();
      release();
      await remote.ready();
      expect(remote.state().host.status).toBe("off");
      expect(calls).toEqual(["start", "stop", "start", "stop"]);
    } finally {
      await remote.stop();
      await fake.stop();
      removeHome(scratch);
    }
  });
});
