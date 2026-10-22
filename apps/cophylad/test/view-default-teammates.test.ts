// The default view's teammates, pure: the rows Teammates shows (what each side shares, the
// codes not used yet with the time they hold), a row going when the node says it ended, the
// code on show until it is used, the folders shared closed and what Open and Exclude send, the
// Connect panel of a session (how it stands with each teammate in words, their agents with
// Connect or Ask, what it is joined to, Someone else folded), the head's pill, a teammate's
// connections on the Teammates page, the share a form makes, and the question a share of a
// whole home folder or drive asks before it goes.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Node, Platform, ClientSession as Session, Teammate, TeammateShare, ClientWorkspace as Workspace } from "@cophyla/protocol";
import {
  apply,
  broadShares,
  broadWords,
  buildShare,
  closedPlaces,
  excludePlace,
  holdWords,
  initialState,
  inShare,
  openPlace,
  selectTeammates,
  teamBlock,
  teamShareWords,
  connectStanding,
  connectAgentRows,
  connectedRows,
  sessionLinks,
  connectTeamBlocks,
  connectNoTeam,
  connectElseFolded,
  teamConnectionRows,
} from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB4";
const NOW = 1_758_196_800_000;
const TM = (n: number) => `tm_01ARZ3NDEKTSV4RRFFQ69G5FE${n}`;

function node(id: string, name: string, over: Partial<Node> = {}): Node {
  return { id, name, role: "secondary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: false, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false }, versions: { platform: "0.17.0", protocol: 1 }, lastSeen: 0, ...over } as Node;
}

function connected(scopes = [...ACCESS_PRESETS.full.scopes]): ViewState {
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.17.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  apply(state, { type: "nodes", nodes: [node(DESK, "Desk", { role: "primary" }), node(LAPTOP, "Laptop", { platform: "linux" })] });
  apply(state, { type: "workspace.state", params: { id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", node: DESK, path: "C:\\work\\web", name: "web", origin: "user", lastActivity: 1 } as Workspace });
  return state;
}

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, node: DESK, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: id + "-n", transport: "pipe" }, origin: "user", cwd: "C:\\work\\web", status: "idle", startedAt: 1, lastActivity: 1, ...over }) as Session;

function teammate(n: number, over: Partial<Teammate> = {}): Teammate {
  return { id: TM(n), state: "active", user: "bob", share: { mode: "include", folders: [{ node: DESK, path: "C:\\work\\web" }], open: "always" }, createdAt: NOW - 3_600_000, sent: 0, received: 0, ...over };
}

describe("teammates in the view", () => {
  test("the list keeps the pending and active ones; an ended one goes; the code on show goes once it is used", () => {
    const state = connected();
    apply(state, { type: "teammates", teammates: [teammate(1), teammate(2, { state: "pending", user: undefined, expiresAt: NOW + 3_600_000 }), teammate(3, { state: "ended" })] });
    expect([...state.teammates.keys()]).toEqual([TM(1), TM(2)]);
    apply(state, { type: "teammate.code", code: { id: TM(2), code: "cophyla-team:x", expiresAt: NOW + 3_600_000 } });
    // a teammates list that still has it pending keeps it on show
    apply(state, { type: "teammates", teammates: [teammate(1), teammate(2, { state: "pending", user: undefined })] });
    expect(state.teammateCode?.id).toBe(TM(2));
    apply(state, { type: "teammate.state", params: teammate(2, { user: "carol", acceptedAt: NOW }) });
    expect(state.teammateCode).toBeUndefined();
    expect(state.teammates.get(TM(2))?.user).toBe("carol");
    apply(state, { type: "teammate.state", params: teammate(1, { state: "ended", reason: "ended by bob" }) });
    expect(state.teammates.has(TM(1))).toBe(false);
  });

  test("the rows: active ones by login with what each side shares, then the codes not used yet, newest first", () => {
    const state = connected();
    apply(state, {
      type: "teammates",
      teammates: [
        teammate(1, { user: "dave", share: { mode: "exclude", folders: [{ node: LAPTOP, path: "/home/me/secret" }], open: "chosen", closed: [{ node: DESK, path: "C:\\work\\new" }] } }),
        teammate(2, { state: "pending", user: undefined, createdAt: NOW - 60_000, expiresAt: NOW + 23.5 * 3_600_000 }),
        teammate(3, { theirs: { open: "chosen", workspaces: ["api", "infra"] }, sent: 3, received: 2, queued: 1 }),
        teammate(4, { state: "pending", user: undefined, createdAt: NOW - 120_000, expiresAt: NOW - 1 }),
      ],
    });
    const rows = selectTeammates(state, NOW);
    expect(rows.map((r) => r.id)).toEqual([TM(3), TM(1), TM(2), TM(4)]);
    expect(rows[0]).toEqual({ id: TM(3), state: "active", who: "bob", share: "web on Desk, and every folder under them · always open", theirs: "api, infra · opened by hand", words: "3 sent, 2 received · 1 waiting", expired: false });
    expect(rows[1]).toMatchObject({ who: "dave", share: "every workspace but secret on Laptop · opened by hand · 1 shared closed", words: "0 sent, 0 received" });
    expect(rows[1]!.theirs).toBeUndefined();
    expect(rows[2]).toMatchObject({ state: "pending", who: "A code not used yet", words: "the code holds, 23 h left", expired: false });
    expect(rows[3]).toMatchObject({ words: "the code ran out", expired: true });
    expect(holdWords(NOW + 90_000, NOW)).toEqual({ words: "2 min left", expired: false });
  });

  test("a share in words: nothing yet, every workspace", () => {
    const state = connected();
    expect(teamShareWords(state, { mode: "include", folders: [], open: "always" })).toBe("nothing yet · always open");
    expect(teamShareWords(state, { mode: "exclude", folders: [], open: "always" })).toBe("every workspace · always open");
  });

  test("a folder shared closed is a line under Status; Open takes it off the list, Exclude moves it to the folders kept back", () => {
    const state = connected();
    const share: TeammateShare = { mode: "exclude", folders: [{ node: DESK, path: "C:\\secret" }], open: "always", opened: [A], closed: [{ node: DESK, path: "C:\\work\\new" }, { node: DESK, path: "C:\\work\\web" }] };
    apply(state, { type: "teammates", teammates: [teammate(1, { user: "carol", share }), teammate(2, { state: "pending", share })] });
    const lines = closedPlaces(state);
    expect(lines.map((l) => l.words)).toEqual(["new on Desk is shared closed with carol", "web on Desk is shared closed with carol"]);
    expect(lines[0]).toMatchObject({ teammate: TM(1), login: "carol", place: { node: DESK, path: "C:\\work\\new" } });
    // the same folder as the node writes it, in another case: Windows compares paths without it
    expect(openPlace(share, { node: DESK, path: "c:\\WORK\\new" }, "windows")).toEqual({ ...share, closed: [{ node: DESK, path: "C:\\work\\web" }] });
    expect(excludePlace(share, { node: DESK, path: "C:\\work\\new" }, "windows")).toEqual({
      mode: "exclude",
      folders: [{ node: DESK, path: "C:\\secret" }, { node: DESK, path: "C:\\work\\new" }],
      open: "always",
      opened: [A],
      closed: [{ node: DESK, path: "C:\\work\\web" }],
    });
  });

  test("a session's Connect panel says in words how it stands with each teammate, and what changes it", () => {
    const state = connected();
    apply(state, {
      type: "teammates",
      teammates: [
        teammate(1, { user: "bob", share: { mode: "include", folders: [{ node: DESK, path: "C:\\work\\web" }], open: "chosen", opened: [A] } }),
        teammate(2, { user: "carol", share: { mode: "exclude", folders: [{ node: DESK, path: "C:\\secret" }], open: "always", closed: [{ node: DESK, path: "C:\\work\\new" }] } }),
        teammate(3, { user: "dave", share: { mode: "include", folders: [{ node: DESK, path: "C:\\other" }], open: "chosen" } }),
        teammate(4, { user: "erin", share: { mode: "include", folders: [{ node: DESK, path: "C:\\work" }], open: "always" } }),
        teammate(5, { user: "finn", share: { mode: "include", folders: [{ node: DESK, path: "C:\\work" }], open: "chosen" } }),
      ],
    });
    const web = session(A, { cwd: "C:\\work\\web\\src" });
    const t = (n: number) => state.teammates.get(TM(n))!;
    expect(connectStanding(state, t(1), web)).toEqual({ kind: "opened", lead: "Open to bob.", rest: "All their agents can message this one.", label: "Close" });
    expect(connectStanding(state, t(3), web)).toEqual({ kind: "outside", lead: "Not shared with dave.", rest: "This agent works in src, which you don't share with them.", label: "Share src with dave…" });
    expect(connectStanding(state, t(4), web)).toEqual({ kind: "always", lead: "Open to erin.", rest: "You share every agent in src with them." });
    expect(connectStanding(state, t(5), web)).toEqual({ kind: "closed", lead: "Closed to finn.", rest: "Only the agents you connect can message this one.", label: "Open to all of finn's agents" });
    // shared closed: Open | Exclude act on the Status line's key
    const fresh = session(B, { cwd: "C:\\Work\\New\\x" });
    expect(connectStanding(state, t(2), fresh)).toEqual({ kind: "shared-closed", lead: "x is shared closed with carol.", rest: "Their agents reach none of yours in it until you open it or exclude it.", placeKey: `${TM(2)}\n${DESK}\nC:\\work\\new` });
    // by its workspace's folder and name, not its cwd
    const inWs = session(A, { workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", cwd: "C:\\elsewhere" });
    expect(connectStanding(state, t(3), inWs).rest).toBe("This agent works in web, which you don't share with them.");
  });

  test("a teammate's agents: the open ones to Connect, the closed ones to ask for, and how each stands with this agent", () => {
    const S1 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC1";
    const S2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC2";
    const S3 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC3";
    const S4 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC4";
    const t = teammate(1, {
      share: { mode: "include", folders: [{ node: DESK, path: "C:\\work" }], open: "chosen" },
      connections: [
        { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC1", state: "active", session: A, agent: { session: S1, name: "api" }, by: "us", createdAt: NOW },
        { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC2", state: "asked", session: A, agent: { session: S3, name: "deploy" }, by: "us", createdAt: NOW },
        { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC3", state: "active", session: B, agent: { session: S2, name: "infra-bot" }, by: "us", createdAt: NOW },
      ],
    });
    const seen = {
      agents: [
        { session: S2, name: "infra-bot", harness: "codex" as const, workspace: "infra", status: "idle" as const, intent: "Terraform plan" },
        { session: S1, name: "api", harness: "claude" as const, workspace: "api", status: "busy" as const, intent: "Fix the auth tests" },
        { name: "old", status: "idle" as const },
      ],
      closed: [
        { session: S4, name: "notes", harness: "claude" as const, workspace: "api" },
        { session: S3, name: "deploy", harness: "codex" as const, workspace: "infra" },
      ],
    };
    const rows = connectAgentRows(t, { id: A }, seen);
    expect(rows.map((r) => [r.name, r.meta, r.tone, r.doing, r.action])).toEqual([
      ["api", "Claude · api", "busy", "working", { kind: "state", words: "Connected", tone: "ok" }],
      ["infra-bot", "Codex · infra", "idle", "idle", { kind: "connect", label: "Connect" }],
      // one from a Cophyla too old to name its session cannot be connected
      ["old", "", "idle", "idle", undefined],
      ["deploy", "Codex · infra", "closed", "closed: bob decides", { kind: "state", words: "Asked", tone: "wait" }],
      ["notes", "Claude · api", "closed", "closed: bob decides", { kind: "ask", label: "Ask bob" }],
    ]);
    expect(rows[1]!.intent).toBe("Terraform plan");
    // a closed one shows nothing of what it does
    expect(rows[4]!.intent).toBeUndefined();
    // the filter, by name, harness or workspace
    expect(connectAgentRows(t, { id: A }, seen, "INFRA").map((r) => r.name)).toEqual(["infra-bot", "deploy"]);
    // another agent of this side has its own connections
    expect(connectAgentRows(t, { id: B }, seen).find((r) => r.name === "infra-bot")?.action).toEqual({ kind: "state", words: "Connected", tone: "ok" });
  });

  test("Connected: the code connections, then the teammate ones, live first, each with what may be pressed; the pill names the live ones", () => {
    const state = connected();
    const S1 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC1";
    const S2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FC2";
    apply(state, {
      type: "connections",
      connections: [
        { id: "con_01ARZ3NDEKTSV4RRFFQ69G5CN1", state: "active", node: DESK, session: A, peer: { user: "zoe", name: "cli", harness: "codex", live: true }, by: "app", createdAt: NOW, sent: 0, received: 0 },
        { id: "con_01ARZ3NDEKTSV4RRFFQ69G5CN2", state: "pending", node: DESK, session: A, by: "app", createdAt: NOW, sent: 0, received: 0 },
      ],
    } as never);
    apply(state, {
      type: "teammates",
      teammates: [
        teammate(1, {
          user: "bob",
          connections: [
            { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC2", state: "asked", session: A, agent: { session: S2, name: "notes", harness: "claude", workspace: "api" }, by: "them", createdAt: NOW, expiresAt: NOW + 86_400_000 },
            { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC1", state: "active", session: A, agent: { session: S1, name: "api", harness: "claude", workspace: "api" }, by: "us", createdAt: NOW },
            { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC3", state: "declined", session: A, agent: { session: S1, name: "deploy" }, by: "us", createdAt: NOW, reason: "bob declined" },
            { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC4", state: "active", session: B, agent: { session: S1, name: "web" }, by: "us", createdAt: NOW },
          ],
        }),
        teammate(2, { user: "carol", connections: [{ id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC5", state: "asked", session: A, agent: { session: S1, name: "ui-kit" }, by: "us", createdAt: NOW }] }),
      ],
    });
    const rows = connectedRows(state, { id: A });
    expect(rows.map((r) => [r.kind, r.who, r.words, r.kind === "teammate" ? r.buttons : []])).toEqual([
      ["code", "zoe/cli", "Codex · connected with a code", []],
      ["teammate", "bob/api", "Claude · api · connected both ways", ["end"]],
      ["teammate", "bob/notes", "bob asks to connect their agent notes to this one (Claude · api)", ["connect", "decline"]],
      ["teammate", "carol/ui-kit", "asked carol · waiting for their answer", ["cancel"]],
      ["teammate", "bob/deploy", "bob declined", ["dismiss"]],
    ]);
    // a yes on their ask names the two agents
    expect(rows[2]).toMatchObject({ teammate: TM(1), session: A, agent: S2 });
    expect(sessionLinks(state, A)).toEqual(["zoe/cli", "bob/api"]);
    expect(sessionLinks(state, B)).toEqual(["bob/web"]);
  });

  test("the teammates' blocks: by login, their agents only where this agent is shared, with words while they come or when none are", () => {
    const state = connected();
    apply(state, {
      type: "teammates",
      teammates: [
        teammate(1, { user: "carol", theirs: { open: "always", workspaces: ["web"] } }),
        teammate(2, { user: "bob", share: { mode: "include", folders: [{ node: DESK, path: "C:\\work\\web" }], open: "chosen" }, theirs: { open: "chosen", workspaces: ["api", "infra"] } }),
        teammate(3, { user: "dave", share: { mode: "include", folders: [{ node: DESK, path: "C:\\other" }], open: "chosen" } }),
        teammate(4, { state: "pending", user: undefined }),
      ],
    });
    const s = session(A);
    const seen = new Map([
      [TM(2), { at: NOW, agents: [{ session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FC1", name: "api", status: "idle" as const }], closed: [] }],
      [TM(1), { at: NOW, agents: [], closed: [] }],
    ]);
    const blocks = connectTeamBlocks(state, s, seen);
    expect(blocks.map((b) => [b.login, b.theirs, b.standing.kind])).toEqual([
      ["bob", "shares api, infra · opens agents by hand", "closed"],
      ["carol", "shares web · every agent open", "always"],
      ["dave", "", "outside"],
    ]);
    expect(blocks[0]!.agents).toMatchObject({ total: 1, filter: false });
    expect(blocks[0]!.agents!.words).toBeUndefined();
    expect(blocks[1]!.agents).toMatchObject({ rows: [], words: "None of carol's agents is in what they share now." });
    // outside what is shared with them: no list at all
    expect(blocks[2]!.agents).toBeUndefined();
    // not asked yet, or their side could not be reached
    expect(connectTeamBlocks(state, s, new Map())[0]!.agents!.words).toBe("Asking bob's Cophyla…");
    expect(connectTeamBlocks(state, s, new Map([[TM(2), { agents: [], closed: [], error: "bob's Cophyla can't be reached now." }]]))[0]!.agents!.words).toBe("bob's Cophyla can't be reached now.");
    // what came before stands while a later ask fails
    expect(connectTeamBlocks(state, s, new Map([[TM(2), { ...seen.get(TM(2))!, error: "x" }]]))[0]!.agents!.rows.map((r) => r.name)).toEqual(["api"]);
    // past eight agents, a filter
    const many = new Map([[TM(2), { at: NOW, agents: Array.from({ length: 9 }, (_, i) => ({ session: `sess_01ARZ3NDEKTSV4RRFFQ69G5FD${i}`, name: `a${i}` })), closed: [] }]]);
    expect(connectTeamBlocks(state, s, many)[0]!.agents!.filter).toBe(true);
    expect(connectTeamBlocks(state, s, many, new Map([[TM(2), "a3"]]))[0]!.agents).toMatchObject({ total: 9, rows: [{ name: "a3" }] });
  });

  test("with no teammate, a line says what teammates are; Someone else is folded while there is one", () => {
    const state = connected();
    expect(connectNoTeam(state)).toBe("Teammates need a Cophyla account.");
    apply(state, { type: "account.state", params: { plan: "pro", limits: {}, subject: "usr_alice" } });
    expect(connectNoTeam(state)).toBe("Teammates connect agents without a code.");
    expect(connectElseFolded(state, {})).toBe(false);
    apply(state, { type: "teammates", teammates: [teammate(1), teammate(2, { state: "pending", user: undefined })] });
    expect(connectNoTeam(state)).toBeUndefined();
    expect(connectElseFolded(state, {})).toBe(true);
    // opened by the user, or showing a code or why one failed
    expect(connectElseFolded(state, { others: true })).toBe(false);
    expect(connectElseFolded(state, { made: "con_01ARZ3NDEKTSV4RRFFQ69G5CN1" })).toBe(false);
    expect(connectElseFolded(state, { error: "no" })).toBe(false);
  });

  test("the Teammates page lists a teammate's connections by the user's agent and theirs", () => {
    const state = connected();
    apply(state, { type: "session.state", params: session(A, { title: "Login page" }) });
    apply(state, {
      type: "teammates",
      teammates: [
        teammate(1, {
          connections: [
            { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC2", state: "asked", session: A, agent: { session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FC2", name: "notes" }, by: "them", createdAt: NOW },
            { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC1", state: "active", session: A, agent: { session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FC1", name: "api" }, by: "us", createdAt: NOW },
            { id: "tc_01ARZ3NDEKTSV4RRFFQ69G5TC3", state: "asked", session: B, agent: { session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FC1", name: "api" }, by: "us", createdAt: NOW + 1 },
          ],
        }),
      ],
    });
    expect(teamConnectionRows(state, TM(1)).map((r) => [r.words, r.buttons])).toEqual([
      ["Login page ⇄ bob/api", ["end"]],
      ["Login page ⇄ bob/notes · bob asks you", ["connect", "decline"]],
      ["an agent of yours ⇄ bob/api · asked, waiting for bob", ["cancel"]],
    ]);
    expect(teamConnectionRows(state, TM(9))).toEqual([]);
  });

  test("what a share holds: under a folder an include names, or under none an exclude names", () => {
    const include: TeammateShare = { mode: "include", folders: [{ node: DESK, path: "C:\\work" }], open: "always" };
    expect(inShare(include, { node: DESK, path: "C:\\work\\web" }, "windows")).toBe(true);
    expect(inShare(include, { node: DESK, path: "C:\\workshop" }, "windows")).toBe(false);
    expect(inShare(include, { node: LAPTOP, path: "C:\\work" }, "windows")).toBe(false);
    expect(inShare({ ...include, mode: "exclude" }, { node: DESK, path: "C:\\work\\web" }, "windows")).toBe(false);
    expect(inShare({ ...include, mode: "exclude" }, { node: DESK, path: "D:\\x" }, "windows")).toBe(true);
  });

  test("the share a form makes: each folder once, the agents opened by hand kept, the closed ones it now excludes dropped", () => {
    const keep: TeammateShare = { mode: "exclude", folders: [], open: "always", opened: [A], closed: [{ node: DESK, path: "C:\\work\\new" }, { node: DESK, path: "C:\\work\\old" }] };
    expect(buildShare("include", [{ node: DESK, path: "C:\\work" }, { node: DESK, path: "c:\\work\\" }, { node: LAPTOP, path: "/srv" }], "chosen")).toEqual({ mode: "include", folders: [{ node: DESK, path: "C:\\work" }, { node: LAPTOP, path: "/srv" }], open: "chosen" });
    expect(buildShare("exclude", [{ node: DESK, path: "C:\\work\\old" }], "always", keep)).toEqual({ mode: "exclude", folders: [{ node: DESK, path: "C:\\work\\old" }], open: "always", opened: [A], closed: [{ node: DESK, path: "C:\\work\\new" }] });
    expect(buildShare("include", [], "always", keep)).toEqual({ mode: "include", folders: [], open: "always", opened: [A] });
  });

  test("a share of a whole home folder or a drive is asked about first; one of the folders in it, or an exclude, is not", () => {
    const platformOf = (n: string): Platform => (n === DESK ? "windows" : "linux");
    const homes = new Map([[DESK, { home: "C:\\Users\\alice", roots: ["C:\\", "D:\\"] }]]);
    const share: TeammateShare = {
      mode: "include",
      folders: [
        { node: DESK, path: "C:\\Users\\Alice\\" },
        { node: DESK, path: "D:\\" },
        { node: DESK, path: "C:\\Users\\alice\\code" },
        { node: LAPTOP, path: "/home/bob" },
        { node: LAPTOP, path: "/home/bob/proj" },
        { node: LAPTOP, path: "/" },
      ],
      open: "always",
    };
    expect(broadShares(share, homes, platformOf)).toEqual([
      { node: DESK, path: "C:\\Users\\Alice\\", kind: "home" },
      { node: DESK, path: "D:\\", kind: "root" },
      { node: LAPTOP, path: "/home/bob", kind: "home" },
      { node: LAPTOP, path: "/", kind: "root" },
    ]);
    expect(broadShares({ ...share, mode: "exclude" }, homes, platformOf)).toEqual([]);
    // a machine whose listing named its home: that one, not the usual
    const moved = new Map([[DESK, { home: "E:\\me", roots: [] }]]);
    expect(broadShares({ mode: "include", folders: [{ node: DESK, path: "C:\\Users\\alice" }, { node: DESK, path: "E:\\me" }] }, moved, platformOf)).toEqual([{ node: DESK, path: "E:\\me", kind: "home" }]);
  });

  test("the question, naming whom it is shared with", () => {
    const home = { node: DESK, path: "C:\\Users\\alice", kind: "home" as const };
    const drive = { node: DESK, path: "D:\\", kind: "root" as const };
    expect(broadWords([home], "bob")).toBe("Share your whole home folder with bob? Every project under it is open to them.");
    expect(broadWords([drive], undefined)).toBe("Share all of D:\\ with whoever uses the code? Every project on it is open to them.");
    expect(broadWords([home, drive], "bob", true, () => "Desk")).toBe("Share your whole home folder on Desk and all of D:\\ on Desk with bob? Every project under them is open to them.");
  });

  test("teammates need the right to manage devices, and an account", () => {
    const state = connected();
    expect(teamBlock(state)).toBe("Teammates need a Cophyla account: sign in under Devices → Account, then invite someone or enter their code.");
    apply(state, { type: "account.state", params: { plan: "pro", limits: {}, subject: "usr_alice" } });
    expect(teamBlock(state)).toBeUndefined();
    expect(teamBlock({ ...state, scopes: ["sessions:read"] })).toBe("This device may not manage teammates.");
  });
});
