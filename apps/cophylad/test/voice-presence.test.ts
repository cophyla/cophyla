// Where the user is: the device a client runs on, the client a device is heard through, the
// device used last, and whether a session is in front of the user — through a client showing
// it, through its terminal open in one, or through its own window in front on this machine,
// found by walking up from its roots to the first ancestor that stands for many sessions.

import { describe, expect, test } from "bun:test";
import type { Access, Client, Session, TerminalRef } from "@cophyla/protocol";
import { SESSIONS } from "@cophyla/protocol";
import { ClientRegistry } from "../src/api/clients.ts";
import type { ListenerKind } from "../src/api/clients.ts";
import type { ProcessInfo, ProcessTree } from "../src/sessions/focus.ts";
import { APP_EXE, CHAIN_TTL_MS, cutChain, windowsForeground, WindowChains } from "../src/voice/foreground.ts";
import type { ForegroundWindow } from "../src/voice/foreground.ts";
import { deviceOf, Presence } from "../src/voice/presence.ts";

const N1 = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const N2 = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const S1 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB0";
const S2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const TERM: TerminalRef = { host: "h1", id: "t1" };

function client(id: string, over: Partial<Client> = {}): Client {
  return { id, kind: "ui", scopes: ["voice", "chat", "sessions:read"], via: "direct", audio: { in: false, out: true }, connectedAt: 1, ...over };
}

function session(id: string, over: Partial<Session> = {}): Session {
  return { id, node: N1, harness: "claude", profile: "prof_1", native: { id: "x", transport: "pipe" }, origin: "user", cwd: "C:/w", tags: [], status: "running", startedAt: 1, lastActivity: 1, ...over } as Session;
}

interface Kit {
  registry: ClientRegistry;
  presence: Presence;
  front: { now?: ForegroundWindow };
  viewers: Map<string, string[]>;
  sessions: Map<string, Session>;
  chains: WindowChains;
  tree: Map<number, ProcessInfo[]>;
  add(c: Client, listener?: ListenerKind): Client;
  clock: { t: number };
}

function kit(opts: { probe?: boolean; conversing?: string[]; windowPids?: number[] } = {}): Kit {
  const registry = new ClientRegistry();
  const viewers = new Map<string, string[]>();
  const sessions = new Map<string, Session>();
  const front: { now?: ForegroundWindow } = {};
  const tree = new Map<number, ProcessInfo[]>();
  const clock = { t: 1_000_000 };
  const processTree: ProcessTree = { ancestors: async (pid) => tree.get(pid) ?? [] };
  const chains = new WindowChains({ tree: processTree, selfPid: 999, now: () => clock.t });
  const presence = new Presence({
    clients: registry,
    nodeId: N1,
    session: (id) => sessions.get(id),
    viewers: (ref) => viewers.get(`${ref.host}/${ref.id}`) ?? [],
    windowPids: () => opts.windowPids ?? [],
    conversing: (id) => opts.conversing?.includes(id) ?? false,
    nodeName: (node) => (node === N1 ? "desk" : undefined),
    ...(opts.probe ? { foreground: () => front.now, chains } : {}),
    now: () => clock.t,
  });
  const add = (c: Client, listener: ListenerKind = "loopback") => {
    registry.add(c, { send: () => {}, close: () => {} }, listener);
    return c;
  };
  return { registry, presence, front, viewers, sessions, chains, tree, add, clock };
}

describe("devices", () => {
  test("a desktop app is its machine, a phone its grant, anything else its own connection", () => {
    expect(deviceOf(client("cli_a", { node: N1 }))).toBe(`desktop@${N1}`);
    // A secondary's desktop app, relayed to the primary, names the secondary.
    expect(deviceOf(client("cli_b", { node: N2, via: "relay" }))).toBe(`desktop@${N2}`);
    expect(deviceOf(client("cli_c", { kind: "controller", controller: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC0" }))).toBe("phone:ctl_01ARZ3NDEKTSV4RRFFQ69G5FC0");
    expect(deviceOf(client("cli_d"))).toBe("client:cli_d");
  });

  test("a device is heard through a client that plays audio, holds voice and full access, its speaker on; one in a conversation first, then the app's own", () => {
    const k = kit({ conversing: ["cli_phone2"] });
    const limited: Access = { ...SESSIONS, nodes: [N1] };
    k.add(client("cli_lim", { kind: "controller", controller: "ctl_lim", scopes: SESSIONS.scopes, access: limited }), "controller");
    expect(k.presence.speakable("phone:ctl_lim")).toBeUndefined();
    k.add(client("cli_mute", { kind: "controller", controller: "ctl_mute" }), "controller");
    k.presence.report(k.registry.get("cli_mute")!.client, { speaker: false });
    expect(k.presence.speakable("phone:ctl_mute")).toBeUndefined();
    k.presence.report(k.registry.get("cli_mute")!.client, { speaker: true });
    expect(k.presence.speakable("phone:ctl_mute")?.client.id).toBe("cli_mute");
    k.add(client("cli_deaf", { kind: "controller", controller: "ctl_deaf", audio: { in: true, out: false } }), "controller");
    expect(k.presence.speakable("phone:ctl_deaf")).toBeUndefined();
    // A phone with two sockets: the one in a conversation.
    k.add(client("cli_phone1", { kind: "controller", controller: "ctl_p" }), "controller");
    k.add(client("cli_phone2", { kind: "controller", controller: "ctl_p" }), "cloud");
    expect(k.presence.speakable("phone:ctl_p")?.client.id).toBe("cli_phone2");
    // A machine with a terminal command beside its app: the app.
    k.add(client("cli_cli", { node: N1, name: "cophyla" }));
    k.add(client("cli_app", { node: N1, name: "desktop" }));
    expect(k.presence.speakable(`desktop@${N1}`)?.client.id).toBe("cli_app");
    expect(k.presence.nameOf(`desktop@${N1}`, k.registry.get("cli_app")!.client)).toBe("desk");
    expect(k.presence.nameOf("phone:ctl_p", client("x", { name: "Pixel" }))).toBe("Pixel");
    // A client that went is not heard.
    k.registry.remove("cli_app");
    k.registry.remove("cli_cli");
    expect(k.presence.speakable(`desktop@${N1}`)).toBeUndefined();
  });

  test("the last action is kept per device, past a disconnect; recent is the device acted on last", () => {
    const k = kit();
    const app = k.add(client("cli_app", { node: N1, name: "desktop" }));
    const phone = k.add(client("cli_phone", { kind: "controller", controller: "ctl_p" }), "controller");
    expect(k.presence.recent()).toBeUndefined();
    k.presence.acted(app);
    k.clock.t += 1000;
    k.presence.report(phone, { active: true });
    expect(k.presence.recent()).toBe("phone:ctl_p");
    expect(k.presence.lastAction(`desktop@${N1}`)).toBe(1_000_000);
    k.presence.forget("cli_phone");
    k.registry.remove("cli_phone");
    expect(k.presence.lastAction("phone:ctl_p")).toBe(1_001_000);
    // What changed is said: a report that changes nothing is none.
    expect(k.presence.report(app, { focused: true })).toBe(true);
    expect(k.presence.report(app, { focused: true })).toBe(false);
  });
});

describe("watching a session", () => {
  test("through a client with the user's attention showing its tab; unknown focus counts, a blur or a hidden window does not", () => {
    const k = kit();
    k.sessions.set(S1, session(S1));
    const phone = k.add(client("cli_phone", { kind: "controller", controller: "ctl_p" }), "controller");
    expect(k.presence.watched([S1])).toBe(false);
    k.registry.watch("cli_phone", [S1]);
    // An app that never said whether it is focused: the tab it shows is watched.
    expect(k.presence.watched([S1])).toBe(true);
    expect(k.presence.watched([S2])).toBe(false);
    k.presence.report(phone, { focused: false });
    expect(k.presence.watched([S1])).toBe(false);
    k.presence.report(phone, { focused: true, visible: false });
    expect(k.presence.watched([S1])).toBe(false);
    k.presence.report(phone, { visible: true });
    expect(k.presence.watched([S1, S2])).toBe(true);
    expect(k.presence.watched([])).toBe(false);
  });

  test("through its terminal open in a client", () => {
    const k = kit();
    k.sessions.set(S1, session(S1, { native: { id: "x", transport: "pipe", terminal: TERM } }));
    const app = k.add(client("cli_app", { node: N1, name: "desktop" }));
    expect(k.presence.watched([S1])).toBe(false);
    k.viewers.set("h1/t1", ["cli_app"]);
    expect(k.presence.watched([S1])).toBe(true);
    k.presence.report(app, { focused: false });
    expect(k.presence.watched([S1])).toBe(false);
  });

  test("on this machine the system says whether the app is in front, over what the app said", () => {
    const k = kit({ probe: true });
    k.sessions.set(S1, session(S1));
    const app = k.add(client("cli_app", { node: N1, name: "desktop" }));
    k.registry.watch("cli_app", [S1]);
    k.front.now = { pid: 10, exe: "chrome.exe" };
    expect(k.presence.watched([S1])).toBe(false);
    k.presence.report(app, { focused: true });
    expect(k.presence.watched([S1])).toBe(false);
    k.front.now = { pid: 11, exe: APP_EXE };
    expect(k.presence.watched([S1])).toBe(true);
    // Nothing can be told (a locked screen): what the app said stands.
    k.front.now = undefined;
    expect(k.presence.watched([S1])).toBe(true);
    // A phone is not this machine's: its own word stands.
    const phone = k.add(client("cli_phone", { kind: "controller", controller: "ctl_p" }), "controller");
    k.registry.watch("cli_app", []);
    k.registry.watch("cli_phone", [S1]);
    k.front.now = { pid: 10, exe: "chrome.exe" };
    expect(k.presence.watched([S1])).toBe(true);
    k.presence.report(phone, { focused: false });
    expect(k.presence.watched([S1])).toBe(false);
  });

  test("through its own window in front: up from its process to the first ancestor that stands for many", async () => {
    const k = kit({ probe: true });
    k.sessions.set(S1, session(S1, { native: { id: "x", pid: 100, transport: "pipe" } }));
    k.sessions.set(S2, session(S2, { node: N2, native: { id: "y", pid: 200, transport: "pipe" } }));
    k.tree.set(100, [
      { pid: 100, name: "claude.exe" },
      { pid: 90, name: "pwsh.exe" },
      { pid: 80, name: "WindowsTerminal.exe" },
      { pid: 5, name: "explorer.exe" },
      { pid: 1, name: "wininit.exe" },
    ]);
    expect(k.presence.roots([S1, S2])).toEqual([100]);
    k.front.now = { pid: 80, exe: "windowsterminal.exe" };
    // Not read yet: nothing is known.
    expect(k.presence.watched([S1])).toBe(false);
    await k.chains.refresh(k.presence.roots([S1]));
    expect(k.chains.chain(100)).toEqual([100, 90, 80]);
    expect(k.presence.watched([S1])).toBe(true);
    // The desktop in front is every session's ancestor, and so no one's window.
    k.front.now = { pid: 5, exe: "explorer.exe" };
    expect(k.presence.watched([S1])).toBe(false);
    // Another node's session is not looked for here.
    k.front.now = { pid: 200, exe: "claude.exe" };
    expect(k.presence.watched([S2])).toBe(false);
  });

  test("a tether terminal's windows are the roots; the daemon, the app and a tether host stop the walk", async () => {
    const k = kit({ probe: true, windowPids: [300] });
    k.sessions.set(S1, session(S1, { native: { id: "x", pid: 100, transport: "pipe", terminal: TERM } }));
    k.tree.set(300, [
      { pid: 300, name: "tether.exe" },
      { pid: 310, name: "WindowsTerminal.exe" },
      { pid: 5, name: "explorer.exe" },
    ]);
    expect(k.presence.roots([S1])).toEqual([300]);
    await k.chains.refresh([300]);
    expect(k.chains.chain(300)).toEqual([300, 310]);
    k.front.now = { pid: 310, exe: "windowsterminal.exe" };
    expect(k.presence.watched([S1])).toBe(true);

    const stop = (p: ProcessInfo) => p.pid === 999 || p.name === APP_EXE || p.name === "tether.exe";
    expect(cutChain([{ pid: 100, name: "claude.exe" }, { pid: 999, name: "bun.exe" }, { pid: 50, name: APP_EXE }], stop)).toEqual([100]);
    expect(cutChain([{ pid: 100, name: "claude.exe" }, { pid: 60, name: "tether.exe" }, { pid: 61, name: "x" }], stop)).toEqual([100]);
    expect(cutChain([], stop)).toEqual([]);
  });

  test("chains are kept a while, read again after, and forgotten once no one asks", async () => {
    const k = kit({ probe: true });
    k.tree.set(100, [{ pid: 100, name: "claude.exe" }, { pid: 80, name: "WindowsTerminal.exe" }]);
    await k.chains.refresh([100]);
    k.tree.set(100, [{ pid: 100, name: "claude.exe" }, { pid: 81, name: "Code.exe" }]);
    await k.chains.refresh([100]);
    expect(k.chains.chain(100)).toEqual([100, 80]);
    k.clock.t += CHAIN_TTL_MS;
    await k.chains.refresh([100]);
    expect(k.chains.chain(100)).toEqual([100, 81]);
    await k.chains.refresh([]);
    expect(k.chains.chain(100)).toBeUndefined();
    // A process the table no longer has is its own window, if any.
    await k.chains.refresh([400]);
    expect(k.chains.chain(400)).toEqual([400]);
  });
});

describe.skipIf(process.platform !== "win32")("the window in front on Windows", () => {
  test("is asked of the system without throwing", () => {
    const probe = windowsForeground();
    expect(probe).toBeDefined();
    const front = probe!();
    if (front) {
      expect(front.pid).toBeGreaterThan(0);
      if (front.exe !== undefined) expect(front.exe).toMatch(/\.exe$/);
    }
  });
});
