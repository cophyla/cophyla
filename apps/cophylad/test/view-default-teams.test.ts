// The default view's teams, pure: a team's row coming and going, the invite on show until it is
// taken, the rail's teams with their chats, the people on a team's page and what the user may do
// about each, Waiting for you (invites and workspaces new in a team's share), and the Connect
// panel standing on what is shared with the teams two people are both in.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Group, Node, ClientSession as Session, Team, Teammate, TeamOffer, ClientWorkspace as Workspace } from "@cophyla/protocol";
import { apply, connectStanding, initialState, railTeams, teamPeople, waitingItems } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const TEAM = "team_01ARZ3NDEKTSV4RRFFQ69G5TE1";
const TEAM2 = "team_01ARZ3NDEKTSV4RRFFQ69G5TE2";
const CHAT = "grp_01ARZ3NDEKTSV4RRFFQ69G5GR1";
const INV = "tinv_01ARZ3NDEKTSV4RRFFQ69G5TV1";
const TM = "tm_01ARZ3NDEKTSV4RRFFQ69G5FE1";

function connected(scopes = [...ACCESS_PRESETS.full.scopes]): ViewState {
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.25.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  apply(state, { type: "nodes", nodes: [{ id: DESK, name: "Desk", role: "primary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: false, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false }, versions: { platform: "0.25.0", protocol: 1 }, lastSeen: 0 } as Node] });
  apply(state, { type: "workspace.state", params: { id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", node: DESK, path: "C:\\work\\web", name: "web", origin: "user", lastActivity: 1 } as Workspace });
  return state;
}

const team = (over: Partial<Team> = {}): Team => ({
  id: TEAM,
  name: "Studio",
  chat: CHAT,
  role: "admin",
  members: [
    { user: "bob", role: "owner", joinedAt: 1, teammate: TM, linked: true, theirs: { open: "always", workspaces: ["api", "infra"] } },
    { user: "alice", role: "admin", joinedAt: 2, you: true },
    { user: "carol", role: "member", joinedAt: 3, teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5FE2" },
  ],
  invites: [{ id: INV, user: "dave", by: "alice", at: 4, expiresAt: Date.now() + 86400_000 }],
  share: { mode: "include", folders: [{ node: DESK, path: "C:\\work\\web" }], open: "always" },
  createdAt: 1,
  updatedAt: 4,
  ...over,
});

const chat = (over: Partial<Group> = {}): Group => ({ id: CHAT, name: "Studio", by: "bob", notify: "tags", members: [], unread: 2, tagged: 1, createdAt: 1, team: TEAM, teamChat: true, ...over });

const offer = (over: Partial<TeamOffer> = {}): TeamOffer => ({ id: INV, team: TEAM2, name: "Design", by: "carol", people: [{ user: "carol", role: "owner" }, { user: "erin", role: "member" }], via: "code", at: 10, expiresAt: Date.now() + 86400_000, ...over });

describe("teams in the view", () => {
  test("a team comes with the list and its notices, and goes when the user is no longer in it; the invite on show goes once taken", () => {
    const state = connected();
    apply(state, { type: "teams", teams: [team()], offers: [offer()] });
    expect(state.teams.get(TEAM)?.name).toBe("Studio");
    expect(state.teamOffers.get(INV)?.name).toBe("Design");
    apply(state, { type: "team.code", code: { team: TEAM, invite: INV, user: "dave", code: "cophyla-join:x", expiresAt: 9 } });
    // the invite was used: no longer open on the team, its panel goes
    apply(state, { type: "teams.state", params: team({ invites: [] }) });
    expect(state.teamCode).toBeUndefined();
    apply(state, { type: "teams.offer", params: { ...offer(), gone: true } });
    expect(state.teamOffers.size).toBe(0);
    apply(state, { type: "teams.state", params: { ...team(), gone: true } });
    expect(state.teams.size).toBe(0);
  });

  test("the rail: each team with its chat first and its groups no folder holds, counted unread", () => {
    const state = connected();
    apply(state, { type: "teams", teams: [team(), team({ id: TEAM2, name: "Design", chat: "grp_01ARZ3NDEKTSV4RRFFQ69G5GR9" })], offers: [] });
    apply(state, { type: "groups", groups: [chat({ id: "grp_01ARZ3NDEKTSV4RRFFQ69G5GR2", name: "release", teamChat: undefined, unread: 1, tagged: 0, createdAt: 0 }), chat()] });
    const rail = railTeams(state);
    expect(rail.map((t) => t.name)).toEqual(["Design", "Studio"]);
    const studio = rail[1]!;
    expect(studio.chats.map((g) => g.name)).toEqual(["Studio", "release"]);
    expect(studio).toMatchObject({ people: 3, unread: 3, tagged: true });
  });

  test("a team's people: by role, what they share, and what an admin or the owner may do about each", () => {
    const rows = teamPeople(team());
    expect(rows.map((r) => [r.user, r.role])).toEqual([
      ["bob", "owner"],
      ["alice", "admin"],
      ["carol", "member"],
    ]);
    expect(rows[0]!.words).toBe("shares api, infra · every agent open");
    expect(rows[2]!.words).toBe("linking…");
    // an admin takes out members alone, and names no admins
    expect(rows.find((r) => r.user === "carol")!.can).toEqual(["remove"]);
    expect(rows.find((r) => r.user === "bob")!.can).toEqual([]);
    // the owner: take out, make admin or member, hand over
    const owned = teamPeople(team({ role: "owner", members: [{ user: "alice", role: "owner", joinedAt: 1, you: true }, { user: "carol", role: "admin", joinedAt: 2, linked: true }] }));
    expect(owned.find((r) => r.user === "carol")!.can).toEqual(["remove", "member", "owner"]);
    // a member does nothing to anyone
    expect(teamPeople(team({ role: "member" })).every((r) => r.can.length === 0)).toBe(true);
  });

  test("Waiting for you: an invite, and a workspace new in a team's share, with the words to act on it", () => {
    const state = connected();
    apply(state, { type: "teams", teams: [team({ share: { mode: "exclude", folders: [], open: "always", closed: [{ node: DESK, path: "C:\\work\\web" }] } })], offers: [offer()] });
    const items = waitingItems(state);
    expect(items.map((i) => i.kind)).toEqual(["offer", "closed"]);
    expect(items[0]).toMatchObject({ words: "carol invited you to Design", offer: INV });
    expect(items[1]).toMatchObject({ words: "web is new in a folder you share with Studio", open: "Open to Studio", keep: "Keep closed" });
    // without the right to manage devices, none
    const limited = connected(["sessions:read"]);
    apply(limited, { type: "teams", teams: [team()], offers: [offer()] });
    expect(waitingItems(limited)).toEqual([]);
  });

  test("the Connect panel stands on what is shared with the teams both are in, and its button names the team", () => {
    const state = connected();
    const s = { id: A, node: DESK, cwd: "C:\\work\\web", status: "idle" } as Session;
    const bob: Teammate = { id: TM, state: "active", user: "bob", share: { mode: "include", folders: [], open: "chosen" }, createdAt: 1, sent: 0, received: 0, teams: [TEAM] };
    apply(state, { type: "teams", teams: [team()], offers: [] });
    // the teammate's own share holds nothing; the team's holds web, always open
    expect(connectStanding(state, bob, s)).toMatchObject({ kind: "always", lead: "Open to bob through Studio.", team: TEAM });
    apply(state, { type: "teams.state", params: team({ share: { mode: "include", folders: [{ node: DESK, path: "C:\\work\\web" }], open: "chosen" } }) });
    expect(connectStanding(state, bob, s)).toMatchObject({ kind: "closed", label: "Open to everyone in Studio", team: TEAM });
    apply(state, { type: "teams.state", params: team({ share: { mode: "include", folders: [{ node: DESK, path: "C:\\other" }], open: "always" } }) });
    expect(connectStanding(state, bob, s)).toMatchObject({ kind: "outside", label: "Share web with Studio…", team: TEAM });
  });
});
