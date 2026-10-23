// The default view's leaders, pure: the leaders as the node says them (`lead.list`, `lead.state`,
// what `lead.set` and `lead.remove` answer), a node older than leaders, the line lost; which
// sessions may lead and be led and which are there but cannot be typed into, the list Lead
// opens under the rail's folder headings and what it sends; the chips that say what leads what,
// the words a refusal is said in, and a leader's message drawn as the user's turn.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Leader, Node, SessionEvent, ClientSession as Session, ClientWorkspace as Workspace } from "@cophyla/protocol";
import {
  apply,
  canLead,
  chatDraw,
  initialState,
  LEAD_TARGETS_MAX,
  leadable,
  leadDraft,
  leaderChip,
  leadFailure,
  leadNote,
  leadOffered,
  leadSetParams,
  leadsSession,
  leadTargets,
  leadUnchanged,
  ledByChip,
  selectTimeline,
  untypeable,
} from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const LENT = "node_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const WEB = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const API = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const PIPE = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const DOCS = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB4";
const CHAT = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB5";
const BORROWED = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB6";
const ACP = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB7";
const GONE = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB9";
const TERM = { host: "tether_1", id: "t1" };

function node(id: string, name: string, over: Partial<Node> = {}): Node {
  return { id, name, role: "secondary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: false, harnesses: ["claude", "codex"], voice: { wake: false, stt: false, tts: false }, remote: false, lead: true }, versions: { platform: "0.19.0", protocol: 1 }, lastSeen: 0, ...over } as Node;
}

function connected(scopes: string[] = [...ACCESS_PRESETS.full.scopes]): ViewState {
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FC7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.19.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes: scopes as HostReady["scopes"] };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  apply(state, { type: "nodes", nodes: [node(DESK, "Desk", { role: "primary" }), node(LAPTOP, "Laptop"), node(LENT, "Bob's box", { hands: true, scope: { kind: "workspaces", paths: ["C:\\shared"] } })] });
  return state;
}

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, node: DESK, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FC8", native: { id: id + "-n", transport: "pipe", terminal: TERM }, origin: "user", cwd: "C:\\work\\web", status: "idle", startedAt: 1, lastActivity: 1, ...over }) as Session;
const workspace = (id: string, path: string, name: string, n = DESK): Workspace => ({ id, node: n, path, name, origin: "user", lastActivity: 1 }) as Workspace;
const leader = (speaker: string, targets: Leader["targets"], since = 10): Leader => ({ speaker, targets, since });
const event = (s: string, seq: number, kind: SessionEvent["kind"], payload: unknown): SessionEvent => ({ session: s, seq, at: 1000 + seq, kind, payload });

/** The desk's web and docs (a Claude in tether, a Claude outside any), the laptop's api (Codex), an ACP agent, the chat's own, and one on a machine lending another person's folders. */
function sessions(state: ViewState): ViewState {
  apply(state, { type: "workspace.state", params: workspace("ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", "C:\\work\\web", "web") });
  apply(state, { type: "workspace.state", params: workspace("ws_01ARZ3NDEKTSV4RRFFQ69G5FD2", "C:\\work\\web\\docs", "docs") });
  apply(state, { type: "workspace.state", params: workspace("ws_01ARZ3NDEKTSV4RRFFQ69G5FD3", "/home/me/api", "api", LAPTOP) });
  apply(state, { type: "session.state", params: session(WEB, { workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", title: "web", startedAt: 1 }) });
  apply(state, { type: "session.state", params: session(PIPE, { workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD1", title: "web-review", native: { id: "p", transport: "pipe" }, startedAt: 2 }) });
  apply(state, { type: "session.state", params: session(DOCS, { workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD2", cwd: "C:\\work\\web\\docs", title: "docs", status: "busy", startedAt: 3 }) });
  apply(state, { type: "session.state", params: session(API, { node: LAPTOP, harness: "codex", workspace: "ws_01ARZ3NDEKTSV4RRFFQ69G5FD3", cwd: "/home/me/api", title: "api", native: { id: "a", transport: "app-server" }, startedAt: 4 }) });
  apply(state, { type: "session.state", params: session(ACP, { harness: "acp", cwd: "C:\\work\\web", title: "gemini", native: { id: "g", transport: "acp" }, startedAt: 5 }) });
  apply(state, { type: "session.state", params: session(CHAT, { role: "assistant", cwd: "C:\\Users\\me\\.cophyla\\chat", startedAt: 6 }) });
  apply(state, { type: "session.state", params: session(BORROWED, { node: LENT, cwd: "C:\\shared", title: "bobs", startedAt: 7 }) });
  return state;
}

const card = (state: ViewState, id: string) => state.sessions.get(id)!.session;

describe("leaders in the view", () => {
  test("the list, the notice, what lead.set and lead.remove answer, each folded in", () => {
    const state = connected();
    expect(state.leadOn).toBeUndefined();
    apply(state, { type: "leaders", leaders: [leader(WEB, [API, DOCS]), leader("chat", "all")] });
    expect(state.leadOn).toBe(true);
    expect([...state.leaders.keys()]).toEqual([WEB, "chat"]);
    // the notice is every leader: one gone from it is gone here
    apply(state, { type: "lead.state", params: { leaders: [leader(WEB, [API])] } });
    expect([...state.leaders.values()]).toEqual([leader(WEB, [API])]);
    apply(state, { type: "leader", leader: leader(DOCS, "all", 20) });
    expect(state.leaders.get(DOCS)?.targets).toBe("all");
    apply(state, { type: "leader.removed", speaker: WEB });
    expect([...state.leaders.keys()]).toEqual([DOCS]);
  });

  test("a node or an app older than leaders: no leaders, and no Lead", () => {
    const state = connected();
    apply(state, { type: "leaders", leaders: [leader(WEB, "all")] });
    apply(state, { type: "leaders" });
    expect(state.leadOn).toBe(false);
    expect(state.leaders.size).toBe(0);
    expect(leadOffered(state)).toBe(false);
    // a notice says the node keeps them after all
    apply(state, { type: "lead.state", params: { leaders: [] } });
    expect(leadOffered(state)).toBe(true);
  });

  test("the line lost takes the leaders, which come again with lead.list; Lead stays", () => {
    const state = connected();
    apply(state, { type: "leaders", leaders: [leader(WEB, [API])] });
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.leaders.size).toBe(0);
    expect(state.leadOn).toBe(true);
    apply(state, { type: "host.state", params: { connected: true } });
    apply(state, { type: "leaders", leaders: [leader(WEB, [API, DOCS])] });
    expect(state.leaders.get(WEB)?.targets).toEqual([API, DOCS]);
  });

  test("none of it redraws the chat's items", () => {
    for (const type of ["leaders", "lead.state", "leader", "leader.removed"] as const) {
      expect(chatDraw({ type } as Parameters<typeof chatDraw>[0])).toBe("none");
    }
  });

  test("who may lead and be led: the user's own live agents, not the chat's own, not on a machine lending another person's folders", () => {
    const state = sessions(connected());
    expect(leadable(state, card(state, WEB))).toBe(true);
    expect(leadable(state, card(state, API))).toBe(true);
    expect(leadable(state, card(state, PIPE))).toBe(true);
    expect(leadable(state, card(state, CHAT))).toBe(false);
    expect(leadable(state, card(state, BORROWED))).toBe(false);
    expect(leadable(state, { ...card(state, WEB), status: "ended" })).toBe(false);
    // hands on a whole machine of the user's lend no one's folders
    apply(state, { type: "node.state", params: node(LENT, "Bob's box", { hands: true }) });
    expect(leadable(state, card(state, BORROWED))).toBe(true);
  });

  test("a Claude session outside a Cophyla terminal cannot be typed into; in tether, over ACP, Codex, Muse and ACP agents can", () => {
    const why = "outside a Cophyla terminal: Reopen it here to include it";
    expect(untypeable({ harness: "claude", native: { id: "x", transport: "pipe" } })).toBe(why);
    expect(untypeable({ harness: "claude", native: { id: "x", transport: "pipe", job: "j1" } })).toBe(why);
    expect(untypeable({ harness: "claude", native: { id: "x", transport: "pipe", terminal: TERM } })).toBeUndefined();
    expect(untypeable({ harness: "claude", native: { id: "x", transport: "acp" } })).toBeUndefined();
    expect(untypeable({ harness: "codex", native: { id: "x", transport: "app-server" } })).toBeUndefined();
    expect(untypeable({ harness: "muse", native: { id: "x", transport: "msp" } })).toBeUndefined();
    expect(untypeable({ harness: "acp", native: { id: "x", transport: "acp" } })).toBeUndefined();
  });

  test("Lead shows where the node keeps leaders and this view may change them: on the chat, and on a session that may lead", () => {
    const state = sessions(connected());
    expect(canLead(state, "chat")).toBe(false);
    apply(state, { type: "leaders", leaders: [] });
    expect(canLead(state, "chat")).toBe(true);
    expect(canLead(state, WEB)).toBe(true);
    // one nothing can type into may still lead: it only speaks
    expect(canLead(state, PIPE)).toBe(true);
    expect(canLead(state, CHAT)).toBe(false);
    expect(canLead(state, BORROWED)).toBe(false);
    expect(canLead(state, GONE)).toBe(false);
    const readOnly = sessions(connected(["sessions:read"]));
    apply(readOnly, { type: "leaders", leaders: [] });
    expect(canLead(readOnly, "chat")).toBe(false);
  });

  test("the list: the rail's folder headings, a folder inside another under it, never the speaker, the chat's own or a lent machine's; outside a terminal, there but blocked", () => {
    const state = sessions(connected());
    const groups = leadTargets(state, WEB);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([
      ["api · Laptop", ["api"]],
      ["web", ["web-review", "gemini"]],
      ["web › docs", ["docs"]],
    ]);
    const review = groups[1]!.items[0]!;
    expect(review).toMatchObject({ id: PIPE, blocked: "outside a Cophyla terminal: Reopen it here to include it", words: "outside a Cophyla terminal: Reopen it here to include it" });
    expect(groups[0]!.items[0]).toEqual({ id: API, label: "api", harness: "codex", words: "Codex · idle" });
    expect(groups[2]!.items[0]!.words).toBe("Claude · working");
    // the chat's list holds every one, web too
    expect(leadTargets(state, "chat").flatMap((g) => g.items.map((i) => i.id))).toEqual([API, WEB, PIPE, ACP, DOCS]);
  });

  test("the list opens with the speaker's group as it stands, and sends every agent or the open ones picked", () => {
    const state = sessions(connected());
    apply(state, { type: "leaders", leaders: [leader(WEB, [API, GONE]), leader("chat", "all")] });
    expect(leadDraft(state, WEB)).toEqual({ all: false, picked: new Set([API, GONE]) });
    expect(leadDraft(state, "chat")).toEqual({ all: true, picked: new Set() });
    expect(leadDraft(state, DOCS)).toEqual({ all: false, picked: new Set() });
    expect(leadSetParams(state, { speaker: "chat", all: true, picked: [API] })).toEqual({ params: { speaker: "chat", targets: "all" } });
    // one gone, one blocked and the speaker itself are left out
    expect(leadSetParams(state, { speaker: WEB, all: false, picked: [API, GONE, PIPE, WEB, DOCS] })).toEqual({ params: { speaker: WEB, targets: [API, DOCS] } });
    expect(leadSetParams(state, { speaker: WEB, all: false, picked: [PIPE] })).toEqual({ error: "Pick the agents it leads, or Every agent." });
    // Save sends nothing new until the group changes: one gone from it, dropped, is a change
    expect(leadUnchanged(state, { speaker: "chat", all: true, picked: [] })).toBe(true);
    expect(leadUnchanged(state, { speaker: "chat", all: false, picked: [API] })).toBe(false);
    expect(leadUnchanged(state, { speaker: WEB, all: false, picked: [API, GONE] })).toBe(false);
    apply(state, { type: "leader", leader: leader(WEB, [API, DOCS]) });
    expect(leadUnchanged(state, { speaker: WEB, all: false, picked: [DOCS, API] })).toBe(true);
    expect(leadUnchanged(state, { speaker: DOCS, all: true, picked: [] })).toBe(false);
    for (let i = 0; i < LEAD_TARGETS_MAX; i++) apply(state, { type: "session.state", params: session(`sess_01ARZ3NDEKTSV4RRFFQ69G${String(i).padStart(4, "0")}`, { startedAt: 100 + i }) });
    const many = [...state.sessions.keys()].filter((id) => id.startsWith("sess_01ARZ3NDEKTSV4RRFFQ69G0"));
    expect(leadSetParams(state, { speaker: WEB, all: false, picked: [API, ...many] })).toEqual({ error: "A leader names at most 64 agents: pick Every agent instead." });
  });

  test("a leader's chip: how many it leads, or every agent, and their names in its hover", () => {
    const state = sessions(connected());
    expect(leaderChip(state, WEB)).toBeUndefined();
    apply(state, { type: "leaders", leaders: [leader(WEB, [API, DOCS, GONE]), leader("chat", "all")] });
    expect(leaderChip(state, WEB)).toEqual({
      text: "Leads 3",
      title: "Leads api, docs, 1 not open now: its messages reach them as your own words, and it may answer their questions as you.",
    });
    expect(leaderChip(state, "chat")?.text).toBe("Leads every agent");
  });

  test("a led session's chip: every leader that speaks to it, all-leaders but itself, the agents first and Cophyla last", () => {
    const state = sessions(connected());
    expect(ledByChip(state, card(state, API))).toBeUndefined();
    apply(state, { type: "leaders", leaders: [leader("chat", "all", 5), leader(WEB, [API], 10), leader(DOCS, "all", 20)] });
    expect(ledByChip(state, card(state, API))?.text).toBe("Led by web, docs, Cophyla");
    // an all-leader never leads itself, the chat's own session, or one on a machine lending another person's folders
    expect(ledByChip(state, card(state, DOCS))?.text).toBe("Led by Cophyla");
    expect(ledByChip(state, card(state, CHAT))).toBeUndefined();
    expect(ledByChip(state, card(state, BORROWED))).toBeUndefined();
    expect(leadsSession(state, leader(WEB, [API]), card(state, WEB))).toBe(false);
    expect(ledByChip(state, card(state, WEB))?.title).toBe("Led by docs, Cophyla: their messages reach this session as your own words, and they may answer its questions as you.");
    // one nothing can type into is led still, as the node has it: its questions are answered as the user, its messages come as another agent's
    expect(ledByChip(state, card(state, PIPE))).toEqual({
      text: "Led by docs, Cophyla",
      title: "Led by docs, Cophyla: their messages reach this session as another agent's (outside a Cophyla terminal: Reopen it here to include it), and they may answer its questions as you.",
    });
  });

  test("a machine older than leaders, or sharing some folders alone, takes a leader's words as another agent's: said, and still picked", () => {
    const state = sessions(connected());
    apply(state, { type: "node.state", params: node(LAPTOP, "Laptop", { capabilities: { brain: false, harnesses: ["codex"], voice: { wake: false, stt: false, tts: false }, remote: false } }) });
    const api = leadTargets(state, WEB)[0]!.items[0]!;
    expect(api).toMatchObject({ id: API, note: "Laptop runs an older Cophyla: it reads them as another agent's", words: "Laptop runs an older Cophyla: it reads them as another agent's" });
    expect(api.blocked).toBeUndefined();
    expect(leadSetParams(state, { speaker: WEB, all: false, picked: [API] })).toEqual({ params: { speaker: WEB, targets: [API] } });
    apply(state, { type: "leaders", leaders: [leader(WEB, [API])] });
    expect(ledByChip(state, card(state, API))?.title).toContain("as another agent's (Laptop runs an older Cophyla)");
    apply(state, { type: "node.state", params: node(LAPTOP, "Laptop", { scope: { kind: "workspaces", paths: ["/home/me/api"] } }) });
    expect(leadTargets(state, WEB)[0]!.items[0]!.note).toBe("Laptop shares some folders alone: it reads them as another agent's");
  });

  test("a refusal in words: an app or a node older than leaders says to update", () => {
    expect(leadFailure("unsupported", "unknown method lead.set")).toBe("This Cophyla app is older than leaders: update it, or open it again after an update, then try again.");
    expect(leadFailure("unsupported", "lead.set is not served")).toBe("Cophyla on this computer is older than leaders: update it, then try again.");
    expect(leadFailure("denied", "only your own live sessions may be led")).toBe("only your own live sessions may be led");
  });

  test("a leader's message typed into a session is the user's turn, and says who sent it", () => {
    const state = sessions(connected());
    apply(state, { type: "tab.open", session: API });
    const by = { session: WEB, alias: "web", harness: "claude", node: DESK, nodeName: "Desk", folder: "web" };
    apply(state, { type: "session.event", params: event(API, 1, "user_turn", { text: "run the **migrations**", source: "lead", by: "chat", ref: "lead-1" }) });
    apply(state, { type: "session.event", params: event(API, 2, "user_turn", { text: "now the tests", source: "lead", by, ref: "lead-2", promptId: "p2" }) });
    apply(state, { type: "session.event", params: event(API, 3, "user_turn", { text: "mine", source: "typed" }) });
    const rows = selectTimeline(state, state.sessions.get(API)!) as { lead?: string; from?: string }[];
    expect(rows.map((r) => r.lead)).toEqual(["sent by Cophyla as you", "sent by web as you", undefined]);
    expect(rows.every((r) => r.from === undefined)).toBe(true);
    expect(leadNote({ source: "lead" })).toBe("sent by a leader as you");
  });
});
