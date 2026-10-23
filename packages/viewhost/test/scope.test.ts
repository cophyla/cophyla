// Which sessions each machine connects to, without a DOM: the machines the Sessions page and the
// first-run screen show (the one the host is on first, its accounts in harness order, each
// ticked unless left off, the folders its sessions worked in to pick from), what the first-run
// button says it will do, a folder that is not a whole path refused beside its field, what a
// change sends with autosave and without, an answer that comes after a newer send dropped, a
// refusal said beside the machine, a machine too old to say, and the pages of the settings.

import { describe, expect, test } from "bun:test";
import type { HarnessProfile, Node, SessionScope, SessionScopeState, Workspace } from "@cophyla/protocol";
import { continueLabel, isWholePath, OPEN_SCOPE, ScopeModel, scopeMachines } from "../src/scope.ts";
import { settingsPages } from "../src/settings.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const node = (id: string, name: string, platform: Node["platform"] = "windows"): Node => ({
  id,
  name,
  role: "primary",
  status: "online",
  via: "direct",
  platform,
  scope: { kind: "machine" },
  capabilities: { harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false },
  versions: { platform: "0.17.0", protocol: 1 },
  lastSeen: 1,
});

const profile = (id: string, over: Partial<HarnessProfile> = {}): HarnessProfile => ({ id, node: DESK, harness: "claude", name: id, configDir: `C:\\${id}`, env: {}, origin: "user", status: "ok", ...over });

const PROFILES = [
  profile("prof_muse", { harness: "muse", name: "default", status: "unauthenticated" }),
  profile("prof_work", { name: "work" }),
  profile("prof_codex", { harness: "codex", name: "default" }),
  profile("prof_home", { name: "home" }),
  profile("prof_far", { node: LAPTOP, name: "far", configDir: "/Users/me/.claude" }),
];

const ws = (path: string, at: number, n = DESK): Workspace => ({ id: `ws_${at}`, node: n, path, name: path, origin: "discovered", tags: [], lastActivity: at });

const scope = (over: Partial<SessionScope> = {}): SessionScope => ({ ...OPEN_SCOPE, ...over });

describe("the machines", () => {
  test("the one the host is on first; accounts by harness then name, each ticked unless left off; the folders worked in to pick from, the listed ones left out", () => {
    const machines = scopeMachines({
      here: LAPTOP,
      nodes: [node(DESK, "Desk"), node(LAPTOP, "Air", "macos")],
      profiles: PROFILES,
      workspaces: [ws("C:\\old", 1), ws("C:\\new", 3), ws("C:\\hidden", 2)],
      scopes: new Map([
        [DESK, scope({ profilesOff: ["prof_work"], hiddenFolders: ["c:\\HIDDEN"] })],
        [LAPTOP, OPEN_SCOPE],
      ]),
    });
    expect(machines.map((m) => [m.name, m.here, m.windows])).toEqual([
      ["Air", true, false],
      ["Desk", false, true],
    ]);
    const desk = machines[1]!;
    expect(desk.profiles.map((p) => [p.label, p.on, p.signedIn])).toEqual([
      ["Claude Code · home", true, true],
      ["Claude Code · work", false, true],
      ["Codex · default", true, true],
      ["Muse · default", true, false],
    ]);
    expect(desk.suggestions).toEqual(["C:\\new", "C:\\old"]);
    expect(desk.hiddenFolders).toEqual(["c:\\HIDDEN"]);
  });

  test("a machine that cannot say is listed with why, and the first-run button counts only the ones that can", () => {
    const machines = scopeMachines({ here: DESK, nodes: [node(DESK, "Desk"), node(LAPTOP, "Air")], profiles: PROFILES, workspaces: [], scopes: new Map([[DESK, OPEN_SCOPE]]), unavailable: new Map([[LAPTOP, "Not available: too old."]]) });
    expect(machines[1]).toMatchObject({ name: "Air", unavailable: "Not available: too old." });
    expect(continueLabel(machines)).toBe("Connect all sessions");
  });

  test("the first-run button says what it does: all, the ones picked, or none", () => {
    const at = (s: SessionScope) => scopeMachines({ here: DESK, nodes: [node(DESK, "Desk")], profiles: PROFILES.filter((p) => p.node === DESK), workspaces: [], scopes: new Map([[DESK, s]]) });
    expect(continueLabel(at(OPEN_SCOPE))).toBe("Connect all sessions");
    expect(continueLabel(at(scope({ tetherOnly: true })))).toBe("Connect selected sessions");
    expect(continueLabel(at(scope({ profilesOff: ["prof_work"] })))).toBe("Connect selected sessions");
    expect(continueLabel(at(scope({ profilesOff: ["prof_home", "prof_work", "prof_codex", "prof_muse"] })))).toBe("Continue without sessions");
  });

  test("a folder is whole from a drive, a share, the root or the home", () => {
    for (const f of ["C:\\Code", "c:/code", "\\\\server\\share", "/home/me", "~", "~/code", " D:\\x "]) expect(isWholePath(f)).toBe(true);
    for (const f of ["code", "./code", "..\\x", "~me", "C:code", ""]) expect(isWholePath(f)).toBe(false);
  });
});

/** A fake node: answers by method, records what was sent, and can hold an answer back. */
function fakeNode(opts: { scopes?: Record<string, SessionScopeState>; nodes?: Node[]; refuse?: (method: string, params: Record<string, unknown>) => string | undefined } = {}) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const held: (() => void)[] = [];
  let holding = false;
  const scopes: Record<string, SessionScopeState> = opts.scopes ?? { [DESK]: { node: DESK, scope: OPEN_SCOPE } };
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const p = (params ?? {}) as Record<string, unknown>;
    sent.push({ method, params: p });
    const refused = opts.refuse?.(method, p);
    if (refused) throw new Error(refused);
    const answer = (): unknown => {
      switch (method) {
        case "session.scope": {
          const s = scopes[(p["node"] as string) ?? DESK];
          if (!s) throw new Error("unknown method session.scope");
          return s;
        }
        case "session.setScope": {
          const n = (p["node"] as string) ?? DESK;
          return (scopes[n] = { node: n, scope: p["scope"] as SessionScope, setupAt: 5 });
        }
        case "profile.list":
          return { profiles: PROFILES };
        case "node.list":
          return { nodes: opts.nodes ?? [node(DESK, "Desk"), node(LAPTOP, "Air")] };
        case "agents.accept":
          return {};
        case "workspace.list":
          return { workspaces: [] };
        default:
          throw new Error(`unknown method ${method}`);
      }
    };
    if (holding && method === "session.setScope") return new Promise<T>((resolve) => held.push(() => resolve(answer() as T)));
    return answer() as T;
  };
  return { request, sent, held, hold: (on: boolean) => (holding = on) };
}

describe("the scope model", () => {
  test("loads the host's machine first, then every other machine's; one too old to say is listed as such", async () => {
    const node = fakeNode();
    const model = new ScopeModel(node.request, () => {}, { autosave: true });
    await model.load();
    expect(model.note).toBe("");
    expect(model.here).toBe(DESK);
    expect(node.sent.filter((s) => s.method === "session.scope").map((s) => s.params)).toEqual([{}, { node: LAPTOP }]);
    const machines = model.machines();
    expect(machines.map((m) => m.name)).toEqual(["Desk", "Air"]);
    expect(machines[1]!.unavailable).toContain("Update Cophyla there");
  });

  test("with autosave each change goes out whole at once, and the machine keeps what came back", async () => {
    const node = fakeNode();
    const model = new ScopeModel(node.request, () => {}, { autosave: true });
    await model.load();
    model.setProfile(DESK, "prof_work", false);
    model.setTetherOnly(DESK, true);
    expect(model.addFolder(DESK, "hiddenFolders", " C:\\private ")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const sets = node.sent.filter((s) => s.method === "session.setScope").map((s) => s.params);
    expect(sets).toEqual([
      { node: DESK, scope: scope({ profilesOff: ["prof_work"] }) },
      { node: DESK, scope: scope({ profilesOff: ["prof_work"], tetherOnly: true }) },
      { node: DESK, scope: scope({ profilesOff: ["prof_work"], tetherOnly: true, hiddenFolders: ["C:\\private"] }) },
    ]);
    expect(model.kept.get(DESK)?.scope).toEqual(scope({ profilesOff: ["prof_work"], tetherOnly: true, hiddenFolders: ["C:\\private"] }));
    expect(model.drafts.size).toBe(0);
    model.removeFolder(DESK, "hiddenFolders", "C:\\private");
    model.setProfile(DESK, "prof_work", true);
    await new Promise((r) => setTimeout(r, 0));
    expect(model.scope(DESK)).toEqual(scope({ tetherOnly: true }));
  });

  test("an answer that comes after a newer send is dropped: what shows is the latest change", async () => {
    const node = fakeNode();
    const model = new ScopeModel(node.request, () => {}, { autosave: true });
    await model.load();
    node.hold(true);
    model.setTetherOnly(DESK, true);
    model.setTetherOnly(DESK, false);
    expect(model.busy.has(DESK)).toBe(true);
    // the newer answers first, then the older one
    node.held[1]!();
    await new Promise((r) => setTimeout(r, 0));
    node.held[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(model.scope(DESK).tetherOnly).toBe(false);
    expect(model.busy.has(DESK)).toBe(false);
  });

  test("a folder that is not a whole path, or is listed already, is refused beside its field and sends nothing", async () => {
    const node = fakeNode();
    const model = new ScopeModel(node.request, () => {}, { autosave: true });
    await model.load();
    expect(model.addFolder(DESK, "allowedFolders", "code\\app")).toBe(false);
    expect(model.fieldNotes.get(`${DESK}:allowedFolders`)).toContain("whole path");
    expect(model.addFolder(DESK, "allowedFolders", "C:\\code")).toBe(true);
    expect(model.addFolder(DESK, "allowedFolders", "c:\\CODE")).toBe(false);
    expect(model.fieldNotes.get(`${DESK}:allowedFolders`)).toBe("It is listed already.");
    expect(model.addFolder(DESK, "allowedFolders", "   ")).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(node.sent.filter((s) => s.method === "session.setScope")).toHaveLength(1);
  });

  test("a refusal says why beside the machine, and with autosave what the machine keeps shows again", async () => {
    const node = fakeNode({ refuse: (m) => (m === "session.setScope" ? "invalid: no" : undefined) });
    const model = new ScopeModel(node.request, () => {}, { autosave: true });
    await model.load();
    model.setTetherOnly(DESK, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(model.notes.get(DESK)).toBe("Not saved: no");
    expect(model.scope(DESK).tetherOnly).toBe(false);
  });

  test("without autosave nothing goes until every machine is saved together, each marked set", async () => {
    const node = fakeNode({ scopes: { [DESK]: { node: DESK, scope: OPEN_SCOPE }, [LAPTOP]: { node: LAPTOP, scope: OPEN_SCOPE } } });
    const model = new ScopeModel(node.request, () => {}, { autosave: false });
    await model.load();
    model.setProfile(DESK, "prof_home", false);
    expect(node.sent.some((s) => s.method === "session.setScope")).toBe(false);
    expect(await model.saveAll()).toBe(true);
    const sets = node.sent.filter((s) => s.method === "session.setScope").map((s) => s.params);
    expect(sets).toEqual([
      { node: DESK, scope: scope({ profilesOff: ["prof_home"] }) },
      { node: LAPTOP, scope: OPEN_SCOPE },
    ]);
    expect([...model.kept.values()].every((s) => s.setupAt === 5)).toBe(true);
  });

  test("the bypass switch as each machine has it, none on one lent as hands; the first-run screen sends it with Continue, and only where it changed", async () => {
    const agents = (n: Node, acceptInBypass: boolean, over: Partial<Node> = {}): Node => ({ ...n, capabilities: { ...n.capabilities, agents: { acceptInBypass } }, ...over });
    const fake = fakeNode({
      scopes: { [DESK]: { node: DESK, scope: OPEN_SCOPE }, [LAPTOP]: { node: LAPTOP, scope: OPEN_SCOPE } },
      nodes: [agents(node(DESK, "Desk"), false), agents(node(LAPTOP, "Air"), true), agents(node("node_01ARZ3NDEKTSV4RRFFQ69G5FAX", "Lent"), false, { hands: true })],
    });
    const model = new ScopeModel(fake.request, () => {}, { autosave: false });
    await model.load();
    expect(model.machines().map((m) => [m.name, m.accept])).toEqual([
      ["Desk", false],
      ["Air", true],
    ]);
    model.setAccept(DESK, true);
    // ticked and back again: nothing to send there
    model.setAccept(LAPTOP, false);
    model.setAccept(LAPTOP, true);
    expect(model.machines()[0]!.accept).toBe(true);
    expect(fake.sent.some((s) => s.method === "agents.accept")).toBe(false);
    expect(await model.saveAll()).toBe(true);
    expect(fake.sent.filter((s) => s.method === "agents.accept").map((s) => s.params)).toEqual([{ node: DESK, on: true }]);
    expect(model.acceptKept.get(DESK)).toBe(true);
    expect(model.acceptDrafts.size).toBe(0);
  });

  test("in the settings the bypass switch goes at once; a refusal says why beside the machine and the switch shows what it keeps", async () => {
    const withAgents = (n: Node): Node => ({ ...n, capabilities: { ...n.capabilities, agents: { acceptInBypass: false } } });
    const fake = fakeNode({ nodes: [withAgents(node(DESK, "Desk"))], refuse: (m, p) => (m === "agents.accept" && p["on"] === false ? "denied: not now" : undefined) });
    const model = new ScopeModel(fake.request, () => {}, { autosave: true });
    await model.load();
    model.setAccept(DESK, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.sent.filter((s) => s.method === "agents.accept").map((s) => s.params)).toEqual([{ node: DESK, on: true }]);
    expect(model.accept(DESK)).toBe(true);
    model.setAccept(DESK, false);
    await new Promise((r) => setTimeout(r, 0));
    expect(model.notes.get(DESK)).toBe("Not saved: not now");
    expect(model.accept(DESK)).toBe(true);
  });

  test("nothing read says why where the machines would be", async () => {
    const node = fakeNode({ refuse: (m) => (m === "session.scope" ? "the node did not answer" : undefined) });
    const model = new ScopeModel(node.request, () => {}, { autosave: false });
    await model.load();
    expect(model.note).toBe("Which sessions Cophyla connects to could not be read: the node did not answer");
    expect(model.machines()).toEqual([]);
  });
});

describe("the settings' pages", () => {
  test("Sessions first; the paired device's page only on a host that is one; Voice says what it holds", () => {
    expect(settingsPages({ device: false, microphone: true }).map((p) => p.id)).toEqual(["sessions", "accounts", "usage", "chat", "voice", "listeners"]);
    expect(settingsPages({ device: true, microphone: false }).map((p) => p.label)).toEqual(["Sessions", "Accounts", "Usage", "Chat", "Voice", "Listeners", "This browser"]);
    expect(settingsPages({ device: false, microphone: true }).find((p) => p.id === "voice")!.lead).toContain("talk key");
    expect(settingsPages({ device: false, microphone: false }).find((p) => p.id === "voice")!.lead).not.toContain("talk key");
  });
});
