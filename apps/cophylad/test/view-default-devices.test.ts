// The default view's Status and Devices, pure: a line per machine in the rail (what it is, its
// readings, its shared desktop, what wants the user, and the ways onto its desktop), a line per
// phone, each login's name told from a twin's, memory and cost short enough for it; and in Devices, who can
// view a desktop a device a line, the user's machines by name whatever they were paired under,
// what each machine is and its facts, and a desktop's state in words. The node on its own
// network: how it stands in a line, the switch where the app is on the machine, its addresses
// and what else there is to say; the browsers on other computers apart from the phones; and in
// a desktop browser, a desktop beside the view, the node's own included, with Connect asking
// for the same page.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Controller, Grant, HarnessProfile, LanState, MetricsSample, Node, RemoteState, RemoteViewer, Scope } from "@cophyla/protocol";
import { apply, connectEmbeds, connectTitle, controllerWords, desktopWords, devicesWords, ERRORS_KEEP, initialState, loadsHistory, machineFacts, selectBrowsers, selectLan, selectNodes, selectPhones, selectRemote, selectSpend, selectStatusMachines, selectStatusPhones, shortCost, memoryWords, statusMeters, viewerOwner, viewerRows } from "../views/default/model.ts";
import type { HostReady, RemoteCard, ViewState } from "../views/default/model.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const MAC = "node_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const BUILD = "node_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const NOW = 1_790_870_000_000;
const H = 3_600_000;
const GB = 1024 ** 3;

function ready(kind: Client["kind"], embed = kind === "ui"): HostReady {
  const scopes = [...ACCESS_PRESETS.full.scopes] as Scope[];
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1, ...(kind === "ui" ? { node: DESK } : {}) };
  return { client, node: DESK, protocolVersion: 1, platformVersion: "0.12.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes, ...(embed ? { embed: true } : {}) };
}

const node = (id: string, name: string, over: Partial<Node> = {}): Node => ({
  id,
  name,
  role: id === DESK ? "primary" : "secondary",
  status: "online",
  via: "direct",
  platform: "windows",
  scope: { kind: "machine" },
  capabilities: { brain: id === DESK, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: true },
  versions: { platform: "0.12.0", protocol: 1 },
  lastSeen: NOW - 3 * H,
  ...over,
});

const sample = (id: string, cpu: number, used: number, total: number, gpu?: MetricsSample["gpu"]): MetricsSample => ({ node: id, at: NOW, cpu, memory: { used: used * GB, total: total * GB }, ...(gpu ? { gpu } : {}), processes: [], llm: {} });

const native = (id: string, name: string | undefined, over: Partial<RemoteViewer> = {}): RemoteViewer => ({ id, ...(name !== undefined ? { name } : {}), kind: "native", since: NOW - 11 * H, connected: false, ...over });

function cluster(kind: Client["kind"] = "ui"): ViewState {
  const state = initialState();
  apply(state, { type: "host.ready", params: ready(kind) });
  apply(state, { type: "host.state", params: { connected: true } });
  apply(state, { type: "nodes", nodes: [node(BUILD, "Build box", { status: "offline", platform: "linux" }), node(LAPTOP, "Laptop", { backup: true }), node(DESK, "Desk"), node(MAC, "Studio Mac", { platform: "macos", via: "relay", hands: true })] });
  return state;
}

const remote = (state: ViewState, s: RemoteState) => apply(state, { type: "remote.state", params: s });

describe("the rail's Status: a line per machine", () => {
  test("this computer first, then the primary, the others by name, the offline ones last; what each is at the line's right", () => {
    const state = cluster();
    expect(selectStatusMachines(state, NOW).map((m) => [m.name, m.sub, m.online])).toEqual([
      ["Desk", "this computer · primary", true],
      ["Laptop", "", true],
      ["Studio Mac", "hands · via relay", true],
      ["Build box", "offline", false],
    ]);
    // the cards in Devices go in the same order
    expect(selectNodes(state).map((c) => c.node.name)).toEqual(["Desk", "Laptop", "Studio Mac", "Build box"]);
    // the line's title says since when the offline one is gone
    expect(selectStatusMachines(state, NOW)[3]!.title).toBe("Build box · Linux · last seen 3h ago");
  });

  test("its readings once a sample came: cpu, memory, and the busiest GPU, coloured as they near the top; none offline", () => {
    const state = cluster();
    apply(state, { type: "metrics.sample", params: sample(DESK, 9.3, 34.3, 63.7, [{ name: "iGPU", util: 3, vramUsed: 0, vramTotal: 0 }, { name: "NVIDIA GeForce RTX 4080", util: 14, vramUsed: 7.6 * GB, vramTotal: 16 * GB }]) });
    apply(state, { type: "metrics.sample", params: sample(LAPTOP, 88, 15.2, 15.7) });
    const [desk, laptop, mac, build] = selectStatusMachines(state, NOW);
    expect(desk!.meters.map((m) => [m.label, m.words, m.level])).toEqual([
      ["CPU", "9%", "normal"],
      ["RAM", "34/64 GB", "normal"],
      ["GPU", "14%", "normal"],
    ]);
    // memory says used of total; its track is still the share
    expect(Math.round(desk!.meters[1]!.percent)).toBe(54);
    expect(desk!.meters[2]!.title).toBe("NVIDIA GeForce RTX 4080 14% · 7.6/16.0 GB");
    expect(desk!.meters[1]!.title).toBe("Memory 34.3/63.7 GB");
    expect(laptop!.meters.map((m) => [m.label, m.level])).toEqual([
      ["CPU", "warn"],
      ["RAM", "critical"],
    ]);
    expect(mac!.meters).toEqual([]);
    expect(build!.meters).toEqual([]);
    expect(statusMeters(sample(DESK, 120, 1, 0))[0]!.percent).toBe(100);
  });

  test("a shared desktop has its mark, green with who watches it; Connect and Beside where this app can open it", () => {
    const state = cluster();
    remote(state, { node: DESK, host: { kind: "apollo", status: "ready" }, streaming: true, viewers: [native("M", "Laptop", { pairedBy: LAPTOP, connected: true })] });
    remote(state, { node: LAPTOP, host: { kind: "sunshine", status: "ready" }, streaming: false, viewers: [] });
    remote(state, { node: MAC, host: { kind: "none", status: "off" }, streaming: false, viewers: [] });
    const [desk, laptop, mac] = selectStatusMachines(state, NOW);
    expect(desk!.desktop).toEqual({ watched: true, title: "Its desktop: Laptop watching" });
    // the desktop app opens no viewer onto the desktop it runs on
    expect([desk!.connect, desk!.beside]).toEqual([false, false]);
    expect(laptop!.desktop).toEqual({ watched: false, title: "Its desktop is shared" });
    expect([laptop!.connect, laptop!.beside]).toEqual([true, true]);
    expect(mac!.desktop).toBeUndefined();
    expect([mac!.connect, mac!.beside]).toEqual([false, false]);

    // a phone opens every shared desktop, and none beside a view
    const phone = cluster("controller");
    remote(phone, { node: DESK, host: { kind: "apollo", status: "ready" }, streaming: false, viewers: [] });
    expect(selectStatusMachines(phone, NOW).map((m) => [m.name, m.sub, m.connect, m.beside])[0]).toEqual(["Desk", "primary", true, false]);
  });

  test("what wants the user in Devices: a machine to invite again, a desktop that could not start", () => {
    const state = cluster();
    const g: Grant = { id: "grt_01BUILD", kind: "node", name: "Build box", access: { scopes: [], messages: "none" }, status: "reinvite", role: "full", node: BUILD, createdAt: NOW - 9 * H, connected: false };
    apply(state, { type: "grants", grants: [g] });
    remote(state, { node: LAPTOP, host: { kind: "sunshine", status: "unavailable", reason: "the service stopped" }, streaming: false, viewers: [] });
    const lines = selectStatusMachines(state, NOW);
    expect(lines.find((m) => m.node === BUILD)!.alert).toBe("invite it again");
    expect(lines.find((m) => m.node === LAPTOP)!.alert).toBe("its desktop could not start");
    expect(lines.find((m) => m.node === DESK)!.alert).toBeUndefined();
  });

  test("a line per phone, the connected first: connected, when it was last, or never", () => {
    const state = cluster();
    const c = (id: string, name: string, over: Partial<Controller> = {}): Controller => ({ id: id as Controller["id"], name, pairedAt: NOW - 30 * H, connected: false, ...over });
    apply(state, { type: "controllers", controllers: [c("ctl_01A", "iPad", { lastSeen: NOW - 2 * H }), c("ctl_01B", "Pixel", { connected: true, lastSeen: NOW }), c("ctl_01C", "Work phone")] });
    expect(selectStatusPhones(state, NOW).map((p) => [p.name, p.words, p.connected])).toEqual([
      ["Pixel", "connected", true],
      ["iPad", "2h ago", false],
      ["Work phone", "never connected", false],
    ]);
    expect(devicesWords(state)).toBe("4 computers · 3 phones");
    expect(devicesWords(initialState())).toBe("");
  });
});

describe("Devices: the node on its own network", () => {
  const FINGERPRINT = "3A:1F:9C:02:7D:E4:55:B1:08:6E:A2:C9:40:1D:73:F6:8B:2E:91:5A:C4:07:DE:38:6F:B0:12:A7:4C:E9:53:8D";
  const on: LanState = { enabled: true, state: "on", port: 4818, addresses: ["https://192.168.1.44:4818", "https://10.0.0.5:4818"], fingerprints: { certificate: FINGERPRINT, key: "q2f0y5Hk9u1m3C1vJb0pZ6oQnqQ8yWm3rX4vA1Rk2tE=" }, stream: { port: 4820 }, keys: 0 };
  const lan = (state: ViewState, l: LanState | undefined) => apply(state, { type: "lan", ...(l ? { lan: l } : {}) });

  test("on: its addresses, best first, the firewall's two ports and the certificate's fingerprint; the switch where the app is on the machine", () => {
    const state = cluster();
    lan(state, on);
    const card = selectLan(state, NOW)!;
    expect(card.state).toBe("on");
    expect(card.words).toBe("On: phones and browsers on this network reach Cophyla on this computer.");
    expect(card.addresses).toEqual(["https://192.168.1.44:4818", "https://10.0.0.5:4818"]);
    expect(card.notes).toEqual([
      { key: "firewall", text: "If another device cannot open it, allow TCP ports 4818 and 4820 on private networks in the firewall of this computer." },
      { key: "fingerprint", text: `Opened by address, a browser warns the first time: the certificate is one this computer made for itself. Its SHA-256 fingerprint is ${FINGERPRINT}` },
    ]);
    expect([card.turnOn, card.turnOff]).toEqual([false, true]);

    // a browser, or a phone, reads it and has no switch: turning it on is asked on the machine itself
    const browser = cluster("controller");
    lan(browser, on);
    const seen = selectLan(browser, NOW)!;
    expect(seen.words).toBe("On: phones and browsers on this network reach Cophyla on the computer this page comes from.");
    expect([seen.turnOn, seen.turnOff]).toEqual([false, false]);
  });

  test("off, up for the user's other computers alone, or failed, in a line; nothing to type while it serves no device", () => {
    const state = cluster();
    lan(state, { enabled: false, state: "off", addresses: [], keys: 0 });
    expect(selectLan(state, NOW)).toEqual({ state: "off", words: "Off: nothing on this network reaches Cophyla on this computer.", addresses: [], notes: [], turnOn: true, turnOff: false });
    lan(state, { enabled: false, state: "nodes", port: 4818, addresses: [], fingerprints: on.fingerprints!, keys: 0 });
    expect(selectLan(state, NOW)).toMatchObject({ state: "nodes", words: "Off for phones and browsers. Your other computers still link to this computer.", notes: [], turnOn: true });
    lan(state, { enabled: true, state: "failed", reason: "port 4818 is in use", addresses: [], keys: 0 });
    expect(selectLan(state, NOW)).toMatchObject({ state: "failed", words: "It could not start: port 4818 is in use.", turnOn: false, turnOff: true });
  });

  test("what else there is to say: the user's own certificate or why it is not in use, a stream port that could not open, the last request turned away", () => {
    const state = cluster();
    lan(state, { ...on, addresses: ["https://desk.home.example:4818", "https://192.168.1.44:4818"], certificate: { names: ["desk.home.example"], validTo: Date.UTC(2027, 0, 15) }, stream: { error: "port 4820 is in use" }, refused: { at: NOW - 3 * 60_000, address: "100.101.102.103", why: "peer", detail: 'it is not on a network this machine is on; to serve it, add "100.101.102.0/24" to [controller] networks' } });
    const notes = Object.fromEntries(selectLan(state, NOW, "en-GB")!.notes.map((n) => [n.key, n]));
    expect(notes["firewall"]!.text).toContain("allow TCP port 4818 on private networks");
    expect(notes["certificate"]).toEqual({ key: "certificate", text: "Your own certificate serves desk.home.example, until 15 January 2027: opened under that name, no browser warns." });
    expect(notes["stream"]).toEqual({ key: "stream", text: "A desktop cannot be shown in a browser: port 4820 is in use.", trouble: true });
    expect(notes["refused"]!.text).toBe('Turned away 3 min ago: it is not on a network this machine is on; to serve it, add "100.101.102.0/24" to [controller] networks.');
    // one that does not pass is said, in use before or not
    lan(state, { ...on, certificate: { names: [], error: "the key does not match the certificate" } });
    expect(selectLan(state, NOW)!.notes.find((n) => n.key === "certificate")).toEqual({ key: "certificate", text: "Your own certificate is not in use: the key does not match the certificate.", trouble: true });
    lan(state, { ...on, certificate: { names: ["desk.home.example"], error: "it ran out on 2026-10-01" } });
    expect(selectLan(state, NOW)!.notes.find((n) => n.key === "certificate")!.text).toBe("The certificate for desk.home.example stays in use; the one on disk now does not pass: it ran out on 2026-10-01.");
  });

  test("a node that does not say, and a client that may not manage devices, show nothing of it", () => {
    const state = cluster();
    expect(selectLan(state, NOW)).toBeUndefined();
    lan(state, on);
    lan(state, undefined);
    expect(selectLan(state, NOW)).toBeUndefined();
    lan(state, on);
    state.scopes = state.scopes.filter((s) => s !== "controllers");
    expect(selectLan(state, NOW)).toBeUndefined();
  });

  test("the browsers on other computers are told from the phones; a shared computer's session and this browser's own row say so", () => {
    const state = cluster("controller");
    const c = (id: string, name: string, over: Partial<Controller> = {}): Controller => ({ id: id as Controller["id"], name, pairedAt: NOW - 30 * H, connected: false, ...over });
    const own = c("ctl_01D", "Firefox on Linux", { form: "browser", connected: true, expiresAt: NOW + 29 * 24 * H });
    const shared = c("ctl_01E", "Library PC", { form: "browser", session: true, connected: true, expiresAt: NOW + 12 * H });
    apply(state, { type: "controllers", controllers: [c("ctl_01A", "iPad", { lastSeen: NOW - 2 * H }), own, shared, c("ctl_01B", "Pixel", { connected: true })] });
    expect(selectPhones(state).map((x) => x.name)).toEqual(["Pixel", "iPad"]);
    expect(selectBrowsers(state).map((x) => x.name).sort()).toEqual(["Firefox on Linux", "Library PC"]);
    expect(devicesWords(state)).toBe("4 computers · 2 phones · 2 browsers");
    expect(controllerWords(own, NOW, "ctl_01D")).toBe("this browser · connected");
    expect(controllerWords(own, NOW, "ctl_01B")).toBe("connected");
    expect(controllerWords(shared, NOW)).toBe("connected · a shared computer's session");
    expect(controllerWords(c("ctl_01B", "Pixel", { connected: true }), NOW, "ctl_01B")).toBe("this phone · connected");
  });
});

describe("a desktop browser", () => {
  test("shows a shared desktop beside its view, the node's own included, and Connect asks for the same page; a phone's page does neither", () => {
    const browser = initialState();
    apply(browser, { type: "host.ready", params: { ...ready("controller", true), desk: true } });
    apply(browser, { type: "host.state", params: { connected: true } });
    apply(browser, { type: "nodes", nodes: [node(DESK, "Desk"), node(LAPTOP, "Laptop")] });
    remote(browser, { node: DESK, host: { kind: "apollo", status: "ready" }, streaming: false, viewers: [] });
    remote(browser, { node: LAPTOP, host: { kind: "sunshine", status: "off" }, streaming: false, viewers: [] });
    const desk = selectRemote(browser, browser.nodes.get(DESK)!)!;
    expect([desk.connect, desk.beside, desk.settings]).toEqual([true, true, false]);
    expect(selectRemote(browser, browser.nodes.get(LAPTOP)!)!.beside).toBe(false);
    expect(connectEmbeds(browser)).toBe(true);
    expect(connectTitle(browser)).toBe("Show this desktop over the whole page");
    // loaded as the desktop app is: history comes unasked
    expect(loadsHistory(browser)).toBe(true);

    const phone = cluster("controller");
    remote(phone, { node: DESK, host: { kind: "apollo", status: "ready" }, streaming: false, viewers: [] });
    expect(selectRemote(phone, phone.nodes.get(DESK)!)!.beside).toBe(false);
    expect(connectEmbeds(phone)).toBe(false);
    expect(loadsHistory(phone)).toBe(false);

    // the desktop app: Moonlight's window, and never the page seeded for a browser
    const app = cluster();
    expect(connectEmbeds(app)).toBe(false);
    expect(connectTitle(app)).toBe("Open this desktop in Moonlight, in a window of its own");
  });
});

describe("the rail's Status: each login's usage", () => {
  const profile = (id: string, nodeId: string, harness: HarnessProfile["harness"], name: string): HarnessProfile => ({ id: id as HarnessProfile["id"], node: nodeId as HarnessProfile["node"], harness, name, configDir: "x", env: {}, origin: "discovered", status: "ok" });

  test("two logins of one name are told apart by their harness's mark, and of one harness too by their machine", () => {
    const state = cluster();
    apply(state, { type: "profiles", profiles: [profile("prof_A", DESK, "claude", "default"), profile("prof_B", DESK, "codex", "default"), profile("prof_C", DESK, "claude", "gmail"), profile("prof_D", LAPTOP, "codex", "default")] });
    const limits = { at: NOW, weekly: { percent: 10 } };
    apply(state, { type: "metrics.sample", params: { ...sample(DESK, 1, 1, 2), limits: { prof_A: limits, prof_B: limits, prof_C: limits } } });
    apply(state, { type: "metrics.sample", params: { ...sample(LAPTOP, 1, 1, 2), limits: { prof_D: limits } } });
    const rows = selectSpend(state);
    expect(Object.fromEntries(rows.map((r) => [r.profile, [r.label, r.harness]]))).toEqual({
      prof_A: ["default", "claude"],
      prof_B: ["default · Desk", "codex"],
      prof_C: ["gmail", "claude"],
      prof_D: ["default · Laptop", "codex"],
    });
  });

  test("memory as used of total and today's cost, short enough for the rail", () => {
    expect(memoryWords(34.3 * GB, 63.7 * GB)).toBe("34/64 GB");
    expect(memoryWords(14.6 * GB, 15.7 * GB)).toBe("15/16 GB");
    expect(memoryWords(1.2 * GB, 3.8 * GB)).toBe("1.2/3.8 GB");
    expect([shortCost(0), shortCost(0.004), shortCost(69.84), shortCost(312.31), shortCost(7026.97)]).toEqual(["$0", "<$0.01", "$69.84", "$312", "$7027"]);
  });
});

describe("Devices: who can view a desktop", () => {
  const card = (state: ViewState, nodeId: string): RemoteCard => selectRemote(state, state.nodes.get(nodeId)!)!;

  test("a client's machine: the one its node says paired it, else the one whose name it carries, its web viewer under the name and \" web\"", () => {
    const state = cluster();
    expect(viewerOwner(state, native("1", "DESKTOP-OLD", { pairedBy: LAPTOP }))).toEqual({ node: LAPTOP, browser: false });
    expect(viewerOwner(state, native("2", "anything", { pairedBy: LAPTOP, browser: true }))).toEqual({ node: LAPTOP, browser: true });
    // from a node older than pairedBy: by name
    expect(viewerOwner(state, native("3", "Laptop"))).toEqual({ node: LAPTOP, browser: false });
    expect(viewerOwner(state, native("4", "Studio Mac web"))).toEqual({ node: MAC, browser: true });
    expect(viewerOwner(state, native("5", "m10-primary web"))).toBeUndefined();
    expect(viewerOwner(state, native("6", undefined))).toBeUndefined();
    expect(viewerOwner(state, { id: "w", name: "Laptop", kind: "web", since: NOW })).toBeUndefined();
  });

  test("a device a line: a machine's Moonlight and web viewer as one, this desktop's own web viewer as its phones and browsers, a browser watching, then the rest; watching first", () => {
    const state = cluster();
    remote(state, {
      node: DESK,
      host: { kind: "apollo", status: "ready" },
      streaming: true,
      viewers: [
        native("m10", "m10-second"),
        native("LW", "DESKTOP-QUHMV7Q web", { pairedBy: LAPTOP, browser: true }),
        native("LM", "DESKTOP-QUHMV7Q", { pairedBy: LAPTOP }),
        native("DW", "Desk web", { pairedBy: DESK, browser: true }),
        native("MW", "Studio Mac web", { pairedBy: MAC, browser: true }),
        { id: "web_1", name: "Pixel", kind: "web", since: NOW - 6 * 60_000, connected: true },
      ],
    });
    const rows = viewerRows(state, card(state, DESK), NOW);
    expect(rows.map((r) => [r.kind, r.name, r.words, r.ids, r.forget])).toEqual([
      ["session", "Pixel", "watching now in a browser", ["web_1"], "End"],
      ["machine", "Laptop", "Moonlight and Beside", ["LM", "LW"], "Forget"],
      ["machine", "Studio Mac", "Beside", ["MW"], "Forget"],
      ["browsers", "Phones and browsers", "through this computer's web viewer", ["DW"], "Forget"],
      ["app", "m10-second", "paired by hand or by another app", ["m10"], "Forget"],
    ]);

    // the machine watching moves up, and says so
    remote(state, { node: DESK, host: { kind: "apollo", status: "ready" }, streaming: true, viewers: [native("MW", "Studio Mac web", { pairedBy: MAC, browser: true }), native("LM", "x", { pairedBy: LAPTOP, connected: true })] });
    expect(viewerRows(state, card(state, DESK), NOW).map((r) => [r.name, r.words, r.watching])).toEqual([
      ["Laptop", "watching now · Moonlight", true],
      ["Studio Mac", "Beside", false],
    ]);
  });

  test("seen from another machine, a desktop's web viewer is named for its host; while sharing is off, Forget revokes what can still connect", () => {
    const state = cluster("controller");
    remote(state, { node: LAPTOP, host: { kind: "apollo", status: "off" }, streaming: false, viewers: [native("LW", "Laptop web", { pairedBy: LAPTOP, browser: true })] });
    const [row] = viewerRows(state, card(state, LAPTOP), NOW);
    expect([row!.name, row!.words, row!.forget]).toEqual(["Phones and browsers", "through Laptop's web viewer", "Revoke"]);
  });

  test("a desktop's state in words: not shared, shared, being watched, coming up, failing", () => {
    expect(desktopWords({ host: { kind: "none", status: "off" }, streaming: false })).toBe("Not shared");
    expect(desktopWords({ host: { kind: "apollo", status: "ready" }, streaming: false })).toBe("Shared");
    expect(desktopWords({ host: { kind: "apollo", status: "ready" }, streaming: true })).toBe("Shared · being watched");
    expect(desktopWords({ host: { kind: "apollo", status: "installing", step: "installing Apollo", progress: 0.4 }, streaming: false })).toBe("Shared · installing Apollo 40%");
    expect(desktopWords({ host: { kind: "sunshine", status: "unavailable", reason: "no GPU" }, streaming: false })).toBe("Shared · unavailable: no GPU");
  });
});

describe("Devices: what went wrong while it showed", () => {
  test("the errors are counted past the ones kept, so one that came since a moment is told even at the cap", () => {
    const state = initialState();
    for (let i = 0; i < ERRORS_KEEP; i++) apply(state, { type: "error", message: `old ${i}` });
    const at = state.errorsSeen;
    apply(state, { type: "error", message: "forget: the node is gone" });
    expect(state.errors.length).toBe(ERRORS_KEEP);
    expect(state.errorsSeen).toBe(at + 1);
    expect(state.errors.at(-1)).toBe("forget: the node is gone");
  });
});

describe("Devices: a machine's head", () => {
  test("what it is as tags beside its name, and its platform, version, how it is reached and when its grant ends", () => {
    const state = cluster();
    const g = (id: string, nodeId: string, over: Partial<Grant>): Grant => ({ id: id as Grant["id"], kind: "node", name: "x", access: { scopes: [], messages: "none" }, status: "active", node: nodeId as Grant["node"], createdAt: NOW - H, connected: true, ...over });
    apply(state, { type: "grants", grants: [g("grt_01MAC", MAC, { role: "hands", expiresAt: NOW + 6 * 24 * H }), g("grt_01BUILD", BUILD, { role: "full", status: "reinvite" })] });
    const facts = (id: string) => machineFacts(state, state.nodes.get(id)!, NOW);
    expect(facts(DESK)).toEqual({ tags: [expect.objectContaining({ key: "self", label: "This computer" }), expect.objectContaining({ key: "primary", label: "Primary" })], line: "Windows · Cophyla 0.12.0 · online" });
    expect(facts(MAC).tags.map((t) => t.label)).toEqual(["Hands"]);
    expect(facts(MAC).line).toBe("macOS · Cophyla 0.12.0 · online through the relay · ends in 6d");
    expect(facts(BUILD)).toEqual({ tags: [expect.objectContaining({ key: "reinvite", label: "Invite it again" })], line: "Linux · Cophyla 0.12.0 · offline, last seen 3h ago" });
    // a full member is the usual: no tag says it
    expect(facts(LAPTOP).tags).toEqual([]);
  });
});
