// The default view's grants, pure: the invites a machine or a phone is let in with (the
// params its forms give, the one on show until Done or until it is used, the ones still
// open), a phone's access and end in words, each machine's role and end on its card and
// what removing it says, and what the desktop offers this node itself (Join another
// computer while it is alone, Leave once it joined one). The QR code the invite panel draws,
// and the one `cophylad invite --phone` prints on a terminal, read back as the invite's link.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS, inviteLink } from "@cophyla/protocol";
import type { Client, Grant, Node, Scope, ClientWorkspace as Workspace } from "@cophyla/protocol";
import { encode } from "uqr";
import { terminalQr } from "../src/cli.ts";
import { accessWords, apply, endWords, GRANT_ENDS, initialState, joinPaths, limitChoices, membershipOffer, nodeGrant, nodeGrantWords, nodeInviteParams, PHONE_PRESETS, phoneInviteParams, selectPendingInvites } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";
import { QR_BORDER, qrModules, qrPath } from "../views/default/qr.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const WS = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const NOW = 1_758_196_800_000;

function ready(kind: Client["kind"], scopes: Scope[]): HostReady {
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 };
  return { client, node: NODE, protocolVersion: 1, platformVersion: "0.9.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
}

function connected(kind: Client["kind"] = "ui", scopes: Scope[] = [...ACCESS_PRESETS.full.scopes]): ViewState {
  const state = initialState();
  apply(state, { type: "host.ready", params: ready(kind, scopes) });
  apply(state, { type: "host.state", params: { connected: true } });
  return state;
}

const node = (id: string, name: string, over: Partial<Node> = {}): Node => ({
  id,
  name,
  role: id === NODE ? "primary" : "secondary",
  status: "online",
  via: "direct",
  platform: "windows",
  scope: { kind: "machine" },
  capabilities: { brain: id === NODE, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false },
  versions: { platform: "0.9.0", protocol: 1 },
  lastSeen: 1000,
  ...over,
});

const grant = (id: string, over: Partial<Grant> = {}): Grant => ({ id, kind: "controller", name: "Work phone", access: ACCESS_PRESETS.full, status: "active", createdAt: NOW - 1000, connected: false, ...over });

describe("default view: the invites", () => {
  test("a phone's form gives its preset, perhaps kept to one node or workspace, and its end", () => {
    expect(phoneInviteParams({ name: " Work phone ", preset: "view", end: "1d" })).toEqual({ kind: "controller", name: "Work phone", access: { scopes: ["sessions:read", "views", "metrics:read"], messages: "none" }, expiresIn: 86_400_000 });
    expect(phoneInviteParams({ name: "Tablet", preset: "sessions", limit: `workspace:${WS}`, end: "never" })).toEqual({ kind: "controller", name: "Tablet", access: { scopes: [...ACCESS_PRESETS.sessions.scopes], workspaces: [WS], messages: "none" } });
    expect(phoneInviteParams({ name: "Tablet", preset: "view", limit: `node:${OTHER}`, end: "1h" })).toMatchObject({ access: { nodes: [OTHER] }, expiresIn: 3_600_000 });
    expect(phoneInviteParams({ name: "Mine", preset: "full", end: "never" })).toEqual({ kind: "controller", name: "Mine", access: ACCESS_PRESETS.full });
    // everything cannot be kept to one place, and a phone needs a name
    expect(phoneInviteParams({ name: "Mine", preset: "full", limit: `node:${NODE}`, end: "never" })).toHaveProperty("error");
    expect(phoneInviteParams({ name: "  ", preset: "view", end: "never" })).toHaveProperty("error");
  });

  test("the view's presets are the protocol's, and every end but the last has a length", () => {
    for (const k of ["full", "sessions", "view"] as const) expect([...PHONE_PRESETS[k].scopes].sort()).toEqual([...ACCESS_PRESETS[k].scopes].sort());
    expect(GRANT_ENDS.filter((e) => !("ms" in e)).map((e) => e.key)).toEqual(["never"]);
  });

  test("a machine's form gives its role and its end", () => {
    expect(nodeInviteParams({ name: "build box", role: "hands", end: "7d" })).toEqual({ kind: "node", name: "build box", role: "hands", expiresIn: 7 * 86_400_000 });
    expect(nodeInviteParams({ name: "laptop", role: "full", end: "never" })).toEqual({ kind: "node", name: "laptop", role: "full" });
    expect(nodeInviteParams({ name: "", role: "full", end: "never" })).toHaveProperty("error");
  });

  test("the invite on show stays until Done, or until the list says it was used; a cancelled one goes with its row", () => {
    const state = connected();
    const issued = { grant: "ctl_1", kind: "controller" as const, name: "Work phone", text: "cophyla-invite:x", link: "cophyla://invite?i=x", expiresAt: NOW + 60_000 };
    apply(state, { type: "invite", invite: issued });
    apply(state, { type: "grants", grants: [grant("ctl_1", { status: "pending", inviteExpiresAt: NOW + 60_000 })] });
    expect(state.invite).toEqual(issued);
    apply(state, { type: "grants", grants: [grant("ctl_1")] });
    expect(state.invite).toBeUndefined();
    apply(state, { type: "invite", invite: issued });
    apply(state, { type: "grant.removed", id: "ctl_1" });
    expect(state.invite).toBeUndefined();
    expect(state.grants.size).toBe(0);
    apply(state, { type: "invite", invite: issued });
    apply(state, { type: "invite" });
    expect(state.invite).toBeUndefined();
  });

  test("the invites still open, the soonest to run out first", () => {
    const state = connected();
    apply(state, {
      type: "grants",
      grants: [
        grant("ctl_1", { status: "pending", name: "later", inviteExpiresAt: NOW + 600_000 }),
        grant("grt_1", { kind: "node", status: "pending", name: "sooner", inviteExpiresAt: NOW + 65_000, role: "hands" }),
        grant("ctl_2", { status: "pending", name: "gone", inviteExpiresAt: NOW - 1 }),
        grant("ctl_3", { name: "active" }),
      ],
    });
    expect(selectPendingInvites(state, NOW).map((p) => [p.grant.name, p.left, p.expired])).toEqual([
      ["gone", "0:00", true],
      ["sooner", "1:05", false],
      ["later", "10:00", false],
    ]);
  });
});

describe("default view: the phones' access and the machines' grants", () => {
  test("a phone's access in words: its preset, and where it is kept", () => {
    const state = connected();
    apply(state, { type: "nodes", nodes: [node(NODE, "Studio"), node(OTHER, "Laptop")] });
    apply(state, { type: "workspace.state", params: { id: WS, node: NODE, path: "C:\\src\\app", name: "app", origin: "user", createdAt: 1, lastUsedAt: 1 } as unknown as Workspace });
    expect(accessWords(undefined, state)).toBe("everything");
    expect(accessWords(ACCESS_PRESETS.full, state)).toBe("everything");
    expect(accessWords({ ...ACCESS_PRESETS.view, nodes: [OTHER] }, state)).toBe("look only · only Laptop");
    expect(accessWords({ ...ACCESS_PRESETS.sessions, workspaces: [WS] }, state)).toBe("its sessions · only app");
    expect(accessWords({ scopes: ["chat"], messages: "none" }, state)).toBe("1 scope");
    expect(limitChoices(state)).toEqual([
      { key: `node:${NODE}`, label: "only Studio" },
      { key: `node:${OTHER}`, label: "only Laptop" },
      { key: `workspace:${WS}`, label: "only app on Studio" },
    ]);
  });

  test("when a grant ends, in words", () => {
    expect(endWords(undefined, NOW)).toBeUndefined();
    expect(endWords(NOW - 1, NOW)).toBe("ended");
    expect(endWords(NOW + 90_000, NOW)).toBe("ends in 2m");
    expect(endWords(NOW + 5 * 3_600_000, NOW)).toBe("ends in 5h");
    expect(endWords(NOW + 3 * 86_400_000, NOW)).toBe("ends in 3d");
  });

  test("a machine's card: hands or a full member, its end, invite it again, and what Remove says", () => {
    const state = connected();
    apply(state, { type: "nodes", nodes: [node(NODE, "Studio"), node(OTHER, "build box", { hands: true }), node("node_01ARZ3NDEKTSV4RRFFQ69G5FAZ", "laptop", { backup: true })] });
    apply(state, {
      type: "grants",
      grants: [
        grant("grt_self", { kind: "node", node: NODE, role: "full", name: "Studio" }),
        grant("grt_hands", { kind: "node", node: OTHER, role: "hands", name: "build box", expiresAt: NOW + 2 * 3_600_000 }),
        grant("grt_full", { kind: "node", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAZ", role: "full", name: "laptop", status: "reinvite" }),
      ],
    });
    expect(nodeGrant(state, OTHER)?.id).toBe("grt_hands");
    // this node's own grant is not removed from here
    expect(nodeGrantWords(state, state.nodes.get(NODE)!, NOW)).toMatchObject({ badge: "full", removable: false, reinvite: false });
    expect(nodeGrantWords(state, state.nodes.get(OTHER)!, NOW)).toMatchObject({ badge: "hands", end: "ends in 2h", removable: true, removeWords: "Remove build box? It can no longer reach this node." });
    const backup = nodeGrantWords(state, state.nodes.get("node_01ARZ3NDEKTSV4RRFFQ69G5FAZ")!, NOW);
    expect(backup).toMatchObject({ badge: "full", reinvite: true, removable: true });
    expect(backup.removeWords).toMatch(/new keys/);
    // a client without the grants' scope removes nothing
    const phone = connected("controller", ["sessions:read", "nodes", "metrics:read"]);
    apply(phone, { type: "nodes", nodes: [node(NODE, "Studio"), node(OTHER, "build box", { hands: true })] });
    expect(nodeGrantWords(phone, phone.nodes.get(OTHER)!, NOW)).toMatchObject({ badge: "hands", removable: false });
  });

  test("the desktop offers Join while this node is alone and Leave once it joined one; a phone is offered neither", () => {
    const alone = connected();
    apply(alone, { type: "nodes", nodes: [node(NODE, "Studio")] });
    expect(membershipOffer(alone)).toBe("join");
    const primary = connected();
    apply(primary, { type: "nodes", nodes: [node(NODE, "Studio"), node(OTHER, "build box")] });
    expect(membershipOffer(primary)).toBeUndefined();
    const guest = connected();
    apply(guest, { type: "nodes", nodes: [node(NODE, "Studio", { role: "secondary" }), node(OTHER, "Office", { role: "primary" })] });
    expect(membershipOffer(guest)).toBe("leave");
    const phone = connected("controller");
    apply(phone, { type: "nodes", nodes: [node(NODE, "Studio")] });
    expect(membershipOffer(phone)).toBeUndefined();
  });

  test("the folders a join shares, one per line", () => {
    expect(joinPaths("  C:\\work\\a \r\n\r\n/home/me/b\n")).toEqual(["C:\\work\\a", "/home/me/b"]);
    expect(joinPaths("")).toEqual([]);
  });
});

describe("an invite's QR code", () => {
  const link = inviteLink({
    v: 1,
    kind: "controller",
    grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC5",
    secret: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    expiresAt: NOW,
    node: { id: NODE, name: "Studio" },
    lan: { hosts: ["192.168.1.44"], port: 4818, spki: "q2f0y5Hk9u1m3C1vJb0pZ6oQnqQ8yWm3rX4vA1Rk2tE=" },
    relay: { url: "https://api.getcophyla.com", peer: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC6", token: "rly_3q2-7fWv0XcQkJ1Lm9ZpRtYuIoPaSdFgHjKl" },
  });

  test("the panel's modules are the encoder's, quiet zone included, and its path draws exactly the dark ones", () => {
    const modules = qrModules(link);
    expect(modules).toEqual(encode(link, { ecc: "M", border: QR_BORDER }).data);
    const n = modules.length;
    expect(modules.every((row) => row.length === n)).toBe(true);
    for (let i = 0; i < QR_BORDER; i++) expect(modules[i]!.some(Boolean)).toBe(false);
    // the path read back: every run a rectangle one module high
    const drawn = modules.map((row) => row.map(() => false));
    for (const m of qrPath(modules).matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
      const [x, y, run, back] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      expect(back).toBe(run);
      for (let i = 0; i < run; i++) drawn[y]![x + i] = true;
    }
    expect(drawn).toEqual(modules);
  });

  test("the terminal's is two rows of modules a line, light modules lit", () => {
    const rows = encode(link, { ecc: "M", border: 2 }).data;
    const lines = terminalQr(link).trimEnd().split("\n");
    expect(lines).toHaveLength(Math.ceil(rows.length / 2));
    for (let y = 0; y < rows.length; y += 2) {
      const line = [...lines[y / 2]!];
      expect(line).toHaveLength(rows[y]!.length);
      line.forEach((ch, x) => {
        const top = !rows[y]![x];
        const bottom = !(rows[y + 1]?.[x] ?? false);
        expect(ch).toBe(top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ");
      });
    }
  });
});
