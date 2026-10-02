// The default view's Status and Devices, pure: a line per machine in the rail (what it is, its
// readings, its shared desktop, what wants the user, and the ways onto its desktop), a line per
// phone, each login's limits as meters and its name told from a twin's; and in Devices, who can
// view a desktop a device a line, the user's machines by name whatever they were paired under,
// what each machine is and its facts, and a desktop's state in words.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Controller, Grant, HarnessProfile, MetricsSample, Node, RemoteState, RemoteViewer, Scope } from "@cophyla/protocol";
import { apply, desktopWords, devicesWords, ERRORS_KEEP, initialState, machineFacts, selectNodes, selectRemote, selectSpend, selectStatusMachines, selectStatusPhones, statusMeters, usageMeters, viewerOwner, viewerRows } from "../views/default/model.ts";
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
      ["RAM", "54%", "normal"],
      ["GPU", "14%", "normal"],
    ]);
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

describe("the rail's Status: each login's usage", () => {
  const profile = (id: string, nodeId: string, harness: HarnessProfile["harness"], name: string): HarnessProfile => ({ id: id as HarnessProfile["id"], node: nodeId as HarnessProfile["node"], harness, name, configDir: "x", env: {}, origin: "discovered", status: "ok" });

  test("two logins of one name are told apart by their harness, then by their machine; each has its harness's mark", () => {
    const state = cluster();
    apply(state, { type: "profiles", profiles: [profile("prof_A", DESK, "claude", "default"), profile("prof_B", DESK, "codex", "default"), profile("prof_C", DESK, "claude", "gmail"), profile("prof_D", LAPTOP, "codex", "default")] });
    const limits = { at: NOW, weekly: { percent: 10 } };
    apply(state, { type: "metrics.sample", params: { ...sample(DESK, 1, 1, 2), limits: { prof_A: limits, prof_B: limits, prof_C: limits } } });
    apply(state, { type: "metrics.sample", params: { ...sample(LAPTOP, 1, 1, 2), limits: { prof_D: limits } } });
    const rows = selectSpend(state);
    expect(Object.fromEntries(rows.map((r) => [r.profile, [r.label, r.harness]]))).toEqual({
      prof_A: ["default · Claude", "claude"],
      prof_B: ["default · Codex · Desk", "codex"],
      prof_C: ["gmail", "claude"],
      prof_D: ["default · Codex · Laptop", "codex"],
    });
  });

  test("its session and weekly limits as meters, each saying when it starts over; a dash while one is not known", () => {
    const [session, week] = usageMeters({ profile: "p", name: "gmail", label: "gmail", spend: { in: 0, out: 0, cached: 0, cost: 0 }, limits: { at: NOW, session: { percent: 96.4, resetsAt: NOW + 2 * H + 40 * 60_000 } } }, NOW);
    expect(session).toEqual({ key: "session", label: "Session", percent: 96.4, words: "96%", level: "critical", title: "Session limit (five hours): 96% used, starts over in 2 h 40 min" });
    expect(week).toEqual({ key: "weekly", label: "Week", percent: 0, words: "—", level: "none", title: "Weekly limit: not known" });
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
