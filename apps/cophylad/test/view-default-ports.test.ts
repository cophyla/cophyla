// The default view's Web pages, on a machine's card in Devices: shown for a machine of the
// user's whole, online and itself, whose Cophyla opens ports, and never onto the desktop app's
// own machine nor in a desktop browser; what listens there, sorted, with its program and
// whether it is open from here, while asked, when nothing listens, and when it could not be
// read; what this client has open, in words, its route and connections, with what a port taken
// here breaks and who else may use it; the port typed; and the presses: Open shows the page
// where this client shows one (the phone app's dialog, the desktop's browser), opens a port
// already open again rather than twice, closes what the app could not show, and says why an
// Open did not go in the node's words; Close, Refresh, and the form.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Node, PortForward, Scope } from "@cophyla/protocol";
import { apply, initialState } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";
import { connectionsWords, newPortsUi, openingKey, PORTS_NOTE, portNumber, portOpenStep, routeWords, selectPorts } from "../views/default/portmodel.ts";
import { PortsControl } from "../views/default/portctl.ts";
import type { PortsForm, PortsRpc, PortsTarget } from "../views/default/portctl.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NOW = 1_790_870_000_000;
const SHARE = "prt_01ARZ3NDEKTSV4RRFFQ69G5FP1";
const OTHER = "prt_01ARZ3NDEKTSV4RRFFQ69G5FP2";

function ready(kind: Client["kind"], over: Partial<HostReady> = {}): HostReady {
  const scopes = [...ACCESS_PRESETS.full.scopes] as Scope[];
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1, ...(kind === "ui" ? { node: DESK } : {}) };
  return { client, node: DESK, protocolVersion: 1, platformVersion: "0.30.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes, ...over };
}

const node = (id: string, name: string, over: Partial<Node> = {}): Node => ({
  id,
  name,
  role: id === DESK ? "primary" : "secondary",
  status: "online",
  via: "direct",
  platform: "windows",
  scope: { kind: "machine" },
  capabilities: { brain: id === DESK, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: true, ports: true },
  versions: { platform: "0.30.0", protocol: 1 },
  lastSeen: NOW,
  ...over,
});

function cluster(kind: Client["kind"] = "ui", laptop: Partial<Node> = {}, over: Partial<HostReady> = {}): ViewState {
  const state = initialState();
  apply(state, { type: "host.ready", params: ready(kind, over) });
  apply(state, { type: "host.state", params: { connected: true } });
  apply(state, { type: "nodes", nodes: [node(DESK, "Desk"), node(LAPTOP, "Laptop", laptop)] });
  return state;
}

const forward = (over: Partial<PortForward> = {}): PortForward => ({ id: SHARE, node: LAPTOP, port: 3000, local: 3000, url: "http://localhost:3000/", route: "lan", since: NOW, connections: 0, bytes: 0, ...over });

const card = (state: ViewState, id = LAPTOP) => selectPorts(state, state.nodes.get(id)!);

describe("Web pages: where the block shows", () => {
  test("on another machine of the user's, from the desktop app and from the phone, the node it talks to among them", () => {
    expect(card(cluster("ui"))?.name).toBe("Laptop");
    const phone = cluster("controller");
    expect(card(phone)?.name).toBe("Laptop");
    // the phone's socket is on Desk: Desk's own localhost is a page it opens too
    expect(card(phone, DESK)?.name).toBe("Desk");
  });

  test("never onto the desktop app's own machine, nor in a browser on a computer, which has no forwarder", () => {
    expect(card(cluster("ui"), DESK)).toBeUndefined();
    expect(card(cluster("controller", {}, { desk: true }))).toBeUndefined();
  });

  test("not for a machine offline, lending folders alone, lent as hands, at its sign-in screen, or older than ports", () => {
    expect(card(cluster("ui", { status: "offline" }))).toBeUndefined();
    expect(card(cluster("ui", { scope: { kind: "workspaces", workspaces: [] } as unknown as Node["scope"] }))).toBeUndefined();
    expect(card(cluster("ui", { hands: true }))).toBeUndefined();
    expect(card(cluster("ui", { door: "signin" }))).toBeUndefined();
    expect(card(cluster("ui", { capabilities: { brain: false, harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: true } }))).toBeUndefined();
  });

  test("not when the node this view talks to is older than ports: it is the one that opens them", () => {
    const state = cluster("controller");
    apply(state, { type: "node.state", params: node(DESK, "Desk", { capabilities: { brain: true, harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: true } }) });
    expect(card(state)).toBeUndefined();
  });

  test("not without the remote scope", () => {
    const state = cluster("ui");
    state.scopes = state.scopes.filter((s) => s !== "remote");
    expect(card(state)).toBeUndefined();
  });
});

describe("Web pages: what listens there", () => {
  test("by port, the program beside it, marked where it is open from here; the title says the addresses", () => {
    const state = cluster("ui");
    apply(state, {
      type: "ports",
      node: LAPTOP,
      ports: [
        { port: 5432, v4: true, v6: true },
        { port: 3000, v4: false, v6: true, process: "node.exe" },
      ],
    });
    apply(state, { type: "port.state", params: { forwards: [forward()] } });
    const c = card(state)!;
    expect(c.listening.map((r) => [r.port, r.program, r.open])).toEqual([
      [3000, "node.exe", true],
      [5432, "", false],
    ]);
    expect(c.listening[0]!.title).toBe("3000 · IPv6 · node.exe");
    expect(c.listening[1]!.title).toBe("5432 · IPv4 and IPv6 · the program is not known");
    expect(c.none).toBe(false);
  });

  test("while asked it says so and keeps what it listed; nothing listening is said; a failure keeps the list with why", () => {
    const state = cluster("ui");
    expect(card(state)!.loading).toBe(false);
    expect(card(state)!.none).toBe(false);
    apply(state, { type: "ports", node: LAPTOP, ports: [{ port: 8080, v4: true, v6: false }] });
    apply(state, { type: "ports.loading", node: LAPTOP });
    expect(card(state)!.loading).toBe(true);
    expect(card(state)!.listening.map((r) => r.port)).toEqual([8080]);
    apply(state, { type: "ports", node: LAPTOP, error: "netstat did not answer" });
    expect(card(state)!.loading).toBe(false);
    expect(card(state)!.error).toBe("netstat did not answer");
    expect(card(state)!.listening.map((r) => r.port)).toEqual([8080]);
    apply(state, { type: "ports", node: LAPTOP, ports: [] });
    expect(card(state)!.none).toBe(true);
    expect(card(state)!.error).toBeUndefined();
  });
});

describe("Web pages: what is open from here", () => {
  test("on the same port: its address, where it is open here, the route and the connections; who else may use it", () => {
    const state = cluster("ui");
    apply(state, { type: "port.state", params: { forwards: [forward({ connections: 2 })] } });
    const c = card(state)!;
    expect(c.open).toHaveLength(1);
    const row = c.open[0]!;
    expect(row.address).toBe("localhost:3000");
    expect(row.words).toBe("open here at localhost:3000 · on this network · 2 connections");
    expect(row.note).toBeUndefined();
    expect(row.url).toBe("http://localhost:3000/");
    expect(c.note).toBe(PORTS_NOTE);
  });

  test("on another port when its own was taken here: what that breaks", () => {
    const state = cluster("ui");
    apply(state, { type: "port.state", params: { forwards: [forward({ local: 53122, url: "http://localhost:53122/", route: "direct", connections: 1 })] } });
    const row = card(state)!.open[0]!;
    expect(row.words).toBe("open here at localhost:53122 · direct · 1 connection");
    expect(row.note).toBe("3000 is taken on this computer: links, redirects and logins that name :3000 will not work.");
  });

  test("the phone's own: shown in the app, no address here to open and nothing to say of other programs", () => {
    const state = cluster("controller");
    apply(state, { type: "port.state", params: { forwards: [{ id: SHARE, node: LAPTOP, port: 5173, route: "lan", since: NOW, connections: 0, bytes: 0 }] } });
    const c = card(state)!;
    expect(c.open[0]!.words).toBe("open on this phone · on this network · no connections");
    expect(c.open[0]!.url).toBeUndefined();
    expect(c.note).toBeUndefined();
  });

  test("each machine's own, the first opened first; the whole list each time; gone with the line", () => {
    const state = cluster("controller");
    apply(state, { type: "port.state", params: { forwards: [forward({ id: OTHER, port: 8080, since: NOW + 5 }), forward(), forward({ id: "prt_01ARZ3NDEKTSV4RRFFQ69G5FP3", node: DESK, port: 9000 })] } });
    expect(card(state)!.open.map((r) => r.port)).toEqual([3000, 8080]);
    expect(card(state, DESK)!.open.map((r) => r.port)).toEqual([9000]);
    apply(state, { type: "port.state", params: { forwards: [forward({ id: OTHER, port: 8080 })] } });
    expect(card(state)!.open.map((r) => r.port)).toEqual([8080]);
    apply(state, { type: "ports", node: LAPTOP, ports: [{ port: 8080, v4: true, v6: false }] });
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.forwards.size).toBe(0);
    expect(state.portLists.size).toBe(0);
  });

  test("the words for a route and a count", () => {
    expect(routeWords("here")).toBe("on this machine");
    expect(routeWords("lan")).toBe("on this network");
    expect(routeWords("direct")).toBe("direct");
    expect([0, 1, 7].map(connectionsWords)).toEqual(["no connections", "1 connection", "7 connections"]);
  });
});

describe("Web pages: a port typed, and what Open does with the answer", () => {
  test("a whole number from 1 to 65535, spaces around it let be", () => {
    expect(portNumber(" 3000 ")).toBe(3000);
    expect(portNumber("65535")).toBe(65535);
    for (const bad of ["", "0", "65536", "30a0", "3000.5", "-1", "123456", ":3000"]) expect(portNumber(bad)).toBeUndefined();
  });

  test("a share goes to the phone app's own dialog with the machine's name; an address to this computer's browser", () => {
    expect(portOpenStep({ id: SHARE, node: LAPTOP, port: 3000, share: SHARE }, "Laptop")).toEqual({ kind: "host.open", params: { port: { id: SHARE, node: LAPTOP, port: 3000, share: SHARE, name: "Laptop" } } });
    expect(portOpenStep({ id: SHARE, node: LAPTOP, port: 3000, url: "http://localhost:3000/" }, "Laptop")).toEqual({ kind: "link", url: "http://localhost:3000/" });
    expect(portOpenStep({ id: SHARE, node: LAPTOP, port: 3000 }, "Laptop")).toEqual({ kind: "none" });
  });
});

// --- the presses ------------------------------------------------------------------------------

type Call = [string, unknown];

/** A host line that answers each method as told, a failure for an `Error`, and records what was asked. */
function fakeRpc(answers: Record<string, unknown>): { rpc: PortsRpc; calls: Call[] } {
  const calls: Call[] = [];
  const rpc: PortsRpc = {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push([method, params]);
      const a = answers[method];
      if (a instanceof Error) throw a;
      return (a ?? {}) as T;
    },
  };
  return { rpc, calls };
}

function control(state: ViewState, answers: Record<string, unknown>) {
  const ui = { ports: newPortsUi() };
  const { rpc, calls } = fakeRpc(answers);
  let draws = 0;
  const ctl = new PortsControl({ rpc, state, ui, dispatch: (a) => void apply(state, a), draw: () => void draws++ });
  return { ctl, ui, calls, draws: () => draws };
}

/** A form as the block's is, for `submit`. */
function form(node: string, value: string): { el: PortsForm; field: { value: string } } {
  const field = { value };
  const el: PortsForm = { classList: { contains: (c: string) => c === "ports-form" }, dataset: { node }, querySelector: () => field };
  return { el, field };
}

describe("Web pages: the presses", () => {
  test("the phone: Open asks the node, then the app shows the page in its own dialog", async () => {
    const state = cluster("controller");
    const { ctl, ui, calls } = control(state, { "port.open": { id: SHARE, node: LAPTOP, port: 3000, share: SHARE, route: "lan" } });
    const going = ctl.open(LAPTOP, 3000);
    expect(ui.ports.opening.has(openingKey(LAPTOP, 3000))).toBe(true);
    await going;
    expect(calls).toEqual([
      ["port.open", { node: LAPTOP, port: 3000 }],
      ["host.open", { port: { id: SHARE, node: LAPTOP, port: 3000, share: SHARE, name: "Laptop" } }],
    ]);
    expect(ui.ports.opening.size).toBe(0);
    expect(ui.ports.errors.size).toBe(0);
  });

  test("an app that cannot show it: the port is closed again, and why shows under the block", async () => {
    const state = cluster("controller");
    const { ctl, ui, calls } = control(state, { "port.open": { id: SHARE, node: LAPTOP, port: 3000, share: SHARE, route: "lan" }, "host.open": new Error("that page cannot be opened") });
    await ctl.open(LAPTOP, 3000);
    expect(calls.map((c) => c[0])).toEqual(["port.open", "host.open", "port.close"]);
    expect(calls[2]![1]).toEqual({ id: SHARE });
    expect(ui.ports.errors.get(LAPTOP)).toBe("that page cannot be opened");
  });

  test("the desktop: Open hands the page to this computer's browser; one that will not open now leaves the row's Open", async () => {
    const state = cluster("ui");
    const { ctl, ui, calls } = control(state, { "port.open": { id: SHARE, node: LAPTOP, port: 3000, local: 3000, url: "http://localhost:3000/", route: "lan" }, "host.openLink": new Error("a link opens only when it is clicked") });
    await ctl.open(LAPTOP, 3000);
    await Bun.sleep(0);
    expect(calls).toEqual([
      ["port.open", { node: LAPTOP, port: 3000 }],
      ["host.openLink", { url: "http://localhost:3000/" }],
    ]);
    expect(ui.ports.errors.size).toBe(0);
  });

  test("a port open here already opens again in the browser, not a second time on the node", async () => {
    const state = cluster("ui");
    apply(state, { type: "port.state", params: { forwards: [forward({ local: 53122, url: "http://localhost:53122/" })] } });
    const { ctl, calls } = control(state, {});
    await ctl.open(LAPTOP, 3000);
    expect(calls).toEqual([["host.openLink", { url: "http://localhost:53122/" }]]);
  });

  test("a refusal shows in the node's words, and the next Open clears it", async () => {
    const state = cluster("controller");
    const refusal = "Opening Laptop's localhost needs a direct connection; this phone reaches Laptop only through the relay right now";
    const { ctl, ui } = control(state, { "port.open": new Error(refusal) });
    await ctl.open(LAPTOP, 3000);
    expect(ui.ports.errors.get(LAPTOP)).toBe(refusal);
    const again = ctl.open(LAPTOP, 3000);
    expect(ui.ports.errors.has(LAPTOP)).toBe(false);
    await again;
  });

  test("Close asks the node; Refresh reads what listens again, its answer or why not folded in", async () => {
    const state = cluster("ui");
    apply(state, { type: "port.state", params: { forwards: [forward()] } });
    const { ctl, ui, calls } = control(state, { "ports.list": { ports: [{ port: 3000, v4: true, v6: true, process: "bun.exe" }] } });
    const target = (data: Record<string, string>): PortsTarget => ({ dataset: data, closest: () => null });
    expect(ctl.click(target({ action: "port-close", id: SHARE }))).toBe(true);
    expect(ui.ports.closing.has(SHARE)).toBe(true);
    expect(ctl.click(target({ action: "ports-refresh", node: LAPTOP }))).toBe(true);
    expect(card(state)!.loading).toBe(true);
    await Bun.sleep(0);
    expect(calls).toEqual([
      ["port.close", { id: SHARE }],
      ["ports.list", { node: LAPTOP }],
    ]);
    expect(ui.ports.closing.size).toBe(0);
    expect(card(state)!.listening.map((r) => r.program)).toEqual(["bun.exe"]);
    expect(ctl.click(target({ action: "something-else" }))).toBe(false);
  });

  test("the field: a port typed is opened and the field cleared; anything else says what a port is", async () => {
    const state = cluster("ui");
    const { ctl, ui, calls } = control(state, { "port.open": { id: SHARE, node: LAPTOP, port: 8080, local: 8080, url: "http://localhost:8080/", route: "lan" } });
    const bad = form(LAPTOP, "99999");
    expect(ctl.submit(bad.el)).toBe(true);
    expect(ui.ports.errors.get(LAPTOP)).toBe("A port is a number from 1 to 65535.");
    expect(calls).toEqual([]);
    const good = form(LAPTOP, "8080");
    expect(ctl.submit(good.el)).toBe(true);
    expect(good.field.value).toBe("");
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(calls[0]).toEqual(["port.open", { node: LAPTOP, port: 8080 }]);
    expect(ui.ports.errors.has(LAPTOP)).toBe(false);
  });

  test("Devices opening reads what listens on every machine whose block shows, and on no other", async () => {
    const state = cluster("ui");
    const { ctl, calls } = control(state, { "ports.list": { ports: [] } });
    ctl.devicesOpened();
    await Bun.sleep(0);
    expect(calls).toEqual([["ports.list", { node: LAPTOP }]]);
  });

  test("the line going takes what was on its way and why an Open did not go", () => {
    const state = cluster("ui");
    const { ctl, ui } = control(state, {});
    ui.ports.opening.add(openingKey(LAPTOP, 3000));
    ui.ports.closing.add(SHARE);
    ui.ports.errors.set(LAPTOP, "no");
    ctl.disconnected();
    expect([ui.ports.opening.size, ui.ports.closing.size, ui.ports.errors.size]).toEqual([0, 0, 0]);
  });
});
