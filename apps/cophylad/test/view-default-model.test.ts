// The default view's reducer and selectors, pure: what the tab rail (the open sessions,
// grouped by the folder they work in), the stream and a
// timeline look like after the daemon's snapshot, live events, history pages, sends, asks,
// audit rows, the conversation's threads and messages (loaded and streamed) and the open
// tasks, with what a scheduled task offers to the user and how its trigger reads; which
// session the view watches, what a tab drops when it closes, whether this client loads
// history unasked and the buttons that load it when it does not; the nodes' cards, from the
// registry and the samples, with the spend per profile built on the node's totals and each
// live sample counted once, beside each login's plan limits from the latest sample; and each
// node's desktop, with what this client may do with it.
// The node's terminals: a bare one's tab, a session's own reached from its pane, a send typed
// into a terminal joined to its turn, and how a followed screen picks its font. Which
// sessions the user can kill from their pane, and the workspaces New terminal offers. The
// prompts pinned over the pane, less a session's own while its terminal shows.
// The explorer: its folders as listed, its rows, the paths they drag, and the repository's line;
// which agent's Files panel shows a file a chip names, and what a chip calls a session.

import { describe, expect, test } from "bun:test";
import type { Ask, AuditEntry, Client, ClientSession as Session, ClientThread as Thread, Controller, Message, MetricsSample, Node, RemoteState, Scope, SessionEvent, Task, Terminal, ClientWorkspace as Workspace } from "@cophyla/protocol";
import { agoWords, answerParams, answerWords, apply, askEventText, AUDIT_KEEP, bytesWords, chatButton, controllerWords, costWords, countWords, earlierButton, initialState, inTether, inviteWords, keyOf, linkWords, loadsHistory, loginWords, messageText, namedController, pairingWords, paneMode, parseComposer, percentWords, pinnedAsks, remoteWords, restartable, restartWords, selectAccount, selectBackup, selectControllers, selectNodes, selectRemote, selectSpend, selectStream, selectGroups, groupHeading, placeKey, limitWords, limitLevel, spendTitle, durationWords, FONT_DRIVE, FONT_MIN, followFont, fontScale, pastRepaint, SCALES, scaleFont, stepScale, clipboardWrite, repeatsTracking, SHIFT_ENTER, RECENT_WORKSPACES, recentWorkspaces, selectTerminalTabs, selectTimeline, sessionLabel, sessionTerminal, stoppable, tabTone, taskActions, terminalLabel, terminalMark, terminalPlace, terminalTabLabel, triggerWords, unheardWords, viewerWords, voiceBusy, voiceCancellable, voiceDot, voiceWords, micOff, watchParams, connectWords, directWords, selectDirect, dropText, dropTexts, explorerKey, explorerNote, fileHome, filesErrorWords, FOLDERS_PER_ASK, gitLine, joinPath, openFolders, selectFileRows, sessionWho, heardText, timeLeft, stoppedWords, countdownFrom } from "../views/default/model.ts";
import type { HostReady, SessionGroup, ViewState } from "../views/default/model.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLIENT: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", scopes: ["sessions:read", "sessions:write", "asks:answer", "audit:read", "chat", "tasks:read"], via: "direct", audio: { in: false, out: false }, connectedAt: 1 };
const READY: HostReady = {
  client: CLIENT,
  node: NODE,
  protocolVersion: 1,
  platformVersion: "0.1.0",
  view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" },
  scopes: CLIENT.scopes,
};

function session(id: string, startedAt: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    node: NODE,
    harness: "claude",
    profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
    native: { id: `n-${id}`, transport: "pipe" },
    origin: "user",
    cwd: "C:\\src",
    status: "idle",
    startedAt,
    lastActivity: startedAt,
    ...extra,
  };
}

function event(sessionId: string, seq: number, kind: SessionEvent["kind"], payload: unknown, at = 1000 + seq): SessionEvent {
  return { session: sessionId, seq, at, kind, payload };
}

function audit(id: string, at: number, action: string, extra: Partial<AuditEntry> = {}): AuditEntry {
  return { id, node: NODE, at, principal: { kind: "user", client: CLIENT.id }, via: CLIENT.id, action, args: {}, decision: "allow", ...extra };
}

function ask(id: string, createdAt: number, extra: Partial<Ask> = {}): Ask {
  return {
    id,
    node: NODE,
    type: "permission",
    source: { kind: "harness", session: "sess_a" },
    title: "Write in x",
    options: [
      { id: "allow", label: "Allow", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    answerableBy: ["user", "brain"],
    status: "open",
    createdAt,
    ...extra,
  };
}

function thread(id: string, startedAt: number, extra: Partial<Thread> = {}): Thread {
  return { id, startedAt, sessions: [], ...extra };
}

function message(id: string, thread: string, at: number, role: Message["role"], text: string, extra: Partial<Message> = {}): Message {
  return { id, thread, at, role, source: role === "user" ? "ui" : "brain", content: [{ type: "text", text }], ...extra };
}

function task(id: string, createdAt: number, extra: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, createdBy: { kind: "brain" }, status: "ready", priority: "normal", sessions: [], createdAt, updatedAt: createdAt, ...extra };
}

function ready(client: Partial<Client> = {}): ViewState {
  const s = initialState();
  apply(s, { type: "host.ready", params: { ...READY, client: { ...CLIENT, ...client } } });
  apply(s, { type: "host.state", params: { connected: true } });
  return s;
}

/** A workspace the node registered, as `workspace.state` streams it. */
function putWorkspace(s: ViewState, id: string, path: string, name: string, node = NODE): void {
  apply(s, { type: "workspace.state", params: { id, node, path, name, origin: "discovered", lastActivity: 1 } });
}

/** Another machine, online, named laptop. */
function addLaptop(s: ViewState, id: string): void {
  apply(s, { type: "nodes", nodes: [{ id, name: "laptop", role: "secondary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: false, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false }, versions: { platform: "0.3.0", protocol: 1 }, lastSeen: 1 }] });
}

/** A rail group as [name, its sessions, the groups inside], the last left off where there are none. */
type GroupShape = [string, string[]] | [string, string[], GroupShape[]];

function shape(groups: SessionGroup[]): GroupShape[] {
  return groups.map((g) => {
    const ids = g.sessions.map((c) => c.session.id);
    return g.groups.length > 0 ? [g.name, ids, shape(g.groups)] : [g.name, ids];
  });
}

/** Opens a session's tab, as selecting it does, and returns the opening a history page is asked for under. */
function open(s: ViewState, id: string): number {
  apply(s, { type: "tab.open", session: id });
  return s.sessions.get(id)!.opened;
}

describe("default view model", () => {
  test("the snapshot makes one tab per open session, in the order they started; one that ends leaves, card and all", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_b", 200) });
    apply(s, { type: "session.state", params: session("sess_a", 100, { lastActivity: 300 }) });
    apply(s, { type: "session.state", params: session("sess_gone", 50, { status: "ended" }) });
    expect([...s.sessions.keys()]).toEqual(["sess_b", "sess_a"]);
    const ids = () => selectGroups(s).flatMap((g) => g.sessions.map((c) => c.session.id));
    expect(ids()).toEqual(["sess_a", "sess_b"]);
    // Sessions live on their tabs, not in the stream.
    expect(selectStream(s).items).toEqual([]);
    // Activity moves nothing.
    apply(s, { type: "session.state", params: session("sess_b", 200, { lastActivity: 400 }) });
    expect(ids()).toEqual(["sess_a", "sess_b"]);
    // Its process closed: the tab goes, with whatever it held.
    open(s, "sess_a");
    apply(s, { type: "session.state", params: session("sess_a", 100, { status: "ended", lastActivity: 500 }) });
    expect(s.sessions.has("sess_a")).toBe(false);
    expect(ids()).toEqual(["sess_b"]);
    apply(s, { type: "session.state", params: session("sess_b", 200, { status: "ended", lastActivity: 400 }) });
    expect(selectGroups(s)).toEqual([]);
    // One revived on evidence is a tab again.
    apply(s, { type: "session.state", params: session("sess_a", 100, { lastActivity: 600 }) });
    expect(ids()).toEqual(["sess_a"]);
  });

  test("tabs group under the folder their sessions work in, the groups by name; a workspace inside another where a session is open is a group under it", () => {
    const s = ready();
    const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    putWorkspace(s, "wks_cophyla", "C:\\D\\orchestrator", "orchestrator");
    putWorkspace(s, "wks_m15", "C:\\D\\orchestrator\\.claude\\worktrees\\m15", "m15");
    putWorkspace(s, "wks_old", "C:\\D\\orchestrator-old", "orchestrator-old");
    putWorkspace(s, "wks_site", "C:\\D\\site", "site");
    putWorkspace(s, "wks_far", "C:\\D\\orchestrator", "orchestrator", OTHER);
    const groups = () => shape(selectGroups(s));
    // A worktree's session alone is a group of its own.
    apply(s, { type: "session.state", params: session("sess_1", 50, { workspace: "wks_m15", cwd: "C:\\D\\orchestrator\\.claude\\worktrees\\m15", lastActivity: 500 }) });
    expect(groups()).toEqual([["m15", ["sess_1"]]]);
    // Once a session is open in the repository, the worktree's group goes under the repository's.
    apply(s, { type: "session.state", params: session("sess_2", 20, { workspace: "wks_cophyla", cwd: "C:\\D\\orchestrator", lastActivity: 100 }) });
    expect(groups()).toEqual([["orchestrator", ["sess_2"], [["m15", ["sess_1"]]]]]);
    expect(selectGroups(s)[0]!.path).toBe("C:\\D\\orchestrator");
    expect(selectGroups(s)[0]!.groups[0]!.path).toBe("C:\\D\\orchestrator\\.claude\\worktrees\\m15");
    // A name that only starts the same is another folder; a session without a workspace is
    // placed by its cwd, compared case-folded on Windows, and joins the group its folder is in.
    apply(s, { type: "session.state", params: session("sess_3", 30, { workspace: "wks_old", cwd: "C:\\D\\orchestrator-old", lastActivity: 300 }) });
    apply(s, { type: "session.state", params: session("sess_4", 60, { cwd: "c:\\d\\site\\docs", lastActivity: 50 }) });
    apply(s, { type: "session.state", params: session("sess_5", 40, { workspace: "wks_site", cwd: "C:\\D\\site", lastActivity: 40 }) });
    const all: GroupShape[] = [
      ["orchestrator", ["sess_2"], [["m15", ["sess_1"]]]],
      ["orchestrator-old", ["sess_3"]],
      ["site", ["sess_5", "sess_4"]],
    ];
    expect(groups()).toEqual(all);
    // Work in a session moves neither its tab nor its group.
    apply(s, { type: "session.state", params: session("sess_4", 60, { cwd: "c:\\d\\site\\docs", status: "busy", lastActivity: 9000 }) });
    expect(groups()).toEqual(all);
    // The same folder on another machine is another group, named with the machine.
    addLaptop(s, OTHER);
    apply(s, { type: "session.state", params: session("sess_6", 10, { node: OTHER, workspace: "wks_far", cwd: "C:\\D\\orchestrator", lastActivity: 200 }) });
    expect(groups()).toEqual([
      ["orchestrator", ["sess_2"], [["m15", ["sess_1"]]]],
      ["orchestrator · laptop", ["sess_6"]],
      ["orchestrator-old", ["sess_3"]],
      ["site", ["sess_5", "sess_4"]],
    ]);
    // The repository's session ends: the worktree's is a group of its own again.
    apply(s, { type: "session.state", params: session("sess_2", 20, { workspace: "wks_cophyla", status: "ended" }) });
    expect(groups().map(([name]) => name)).toEqual(["m15", "orchestrator · laptop", "orchestrator-old", "site"]);
  });

  test("groups nest as deep as the workspaces do, under the innermost one open, each counting every tab under it", () => {
    const s = ready();
    const STUDIO = "C:\\D\\FarEastStudios";
    const PORTAL = `${STUDIO}\\far-east-client-portal`;
    const BILLING = `${PORTAL}\\.claude\\worktrees\\billing`;
    const SITE = `${STUDIO}\\far-east-studios-website`;
    putWorkspace(s, "wks_studio", STUDIO, "FarEastStudios");
    putWorkspace(s, "wks_portal", PORTAL, "far-east-client-portal");
    putWorkspace(s, "wks_billing", BILLING, "billing");
    putWorkspace(s, "wks_site", SITE, "far-east-studios-website");
    const put = (id: string, startedAt: number, cwd: string, extra: Partial<Session> = {}) => apply(s, { type: "session.state", params: session(id, startedAt, { cwd, ...extra }) });
    put("sess_a", 10, STUDIO, { workspace: "wks_studio" });
    put("sess_b", 20, PORTAL, { workspace: "wks_portal" });
    put("sess_c", 30, BILLING, { workspace: "wks_billing" });
    put("sess_d", 5, BILLING, { workspace: "wks_billing" });
    put("sess_e", 40, SITE, { workspace: "wks_site" });
    // No workspace, in a folder of the portal's, cased otherwise: a tab of the portal's group, not a group of its own.
    put("sess_f", 50, "c:\\d\\fareaststudios\\far-east-client-portal\\apps\\web");
    expect(shape(selectGroups(s))).toEqual([
      [
        "FarEastStudios",
        ["sess_a"],
        [
          ["far-east-client-portal", ["sess_b", "sess_f"], [["billing", ["sess_d", "sess_c"]]]],
          ["far-east-studios-website", ["sess_e"]],
        ],
      ],
    ]);
    const counts = (groups: SessionGroup[]): unknown[] => groups.map((g) => (g.groups.length > 0 ? [g.name, g.count, counts(g.groups)] : [g.name, g.count]));
    expect(counts(selectGroups(s))).toEqual([["FarEastStudios", 6, [["far-east-client-portal", 4, [["billing", 2]]], ["far-east-studios-website", 1]]]]);
    // The portal's own session ends: the worktree goes up to the innermost group still open
    // around it, and the portal's bare folder joins that one too.
    put("sess_b", 20, PORTAL, { workspace: "wks_portal", status: "ended" });
    expect(shape(selectGroups(s))).toEqual([["FarEastStudios", ["sess_a", "sess_f"], [["billing", ["sess_d", "sess_c"]], ["far-east-studios-website", ["sess_e"]]]]]);
    expect(selectGroups(s)[0]!.count).toBe(5);
    // Then the studio's: each is outermost now, the bare folder a group of its own, named by it.
    put("sess_a", 10, STUDIO, { workspace: "wks_studio", status: "ended" });
    expect(shape(selectGroups(s))).toEqual([
      ["billing", ["sess_d", "sess_c"]],
      ["far-east-studios-website", ["sess_e"]],
      ["web", ["sess_f"]],
    ]);
  });

  test("a folder only a session's cwd is heads a group when it is inside no other folder, and a workspace at the same folder names it", () => {
    const s = ready();
    putWorkspace(s, "wks_site", "C:\\D\\site", "Website");
    const groups = () => shape(selectGroups(s));
    // In the site's folder before its workspace is known, then one in the workspace: one group, the workspace's name.
    apply(s, { type: "session.state", params: session("sess_x", 10, { cwd: "C:\\D\\site" }) });
    expect(groups()).toEqual([["site", ["sess_x"]]]);
    apply(s, { type: "session.state", params: session("sess_y", 20, { workspace: "wks_site", cwd: "C:\\D\\site" }) });
    expect(groups()).toEqual([["Website", ["sess_x", "sess_y"]]]);
    // A session with no workspace in the folder around it heads the outermost group, the workspace's under it.
    apply(s, { type: "session.state", params: session("sess_z", 30, { cwd: "C:\\D" }) });
    expect(groups()).toEqual([["D", ["sess_z"], [["Website", ["sess_x", "sess_y"]]]]]);
    expect(selectGroups(s)[0]!.count).toBe(3);
  });

  test("another machine's groups nest on that machine alone, its name on the outermost only", () => {
    const s = ready();
    const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    addLaptop(s, OTHER);
    putWorkspace(s, "wks_here", "C:\\D\\orchestrator", "orchestrator");
    putWorkspace(s, "wks_far", "C:\\D\\orchestrator", "orchestrator", OTHER);
    putWorkspace(s, "wks_far_wt", "C:\\D\\orchestrator\\wt", "wt", OTHER);
    apply(s, { type: "session.state", params: session("sess_a", 10, { workspace: "wks_here", cwd: "C:\\D\\orchestrator" }) });
    apply(s, { type: "session.state", params: session("sess_b", 20, { node: OTHER, workspace: "wks_far_wt", cwd: "C:\\D\\orchestrator\\wt" }) });
    // The laptop's worktree is not under this machine's repository at the same path.
    expect(shape(selectGroups(s))).toEqual([
      ["orchestrator", ["sess_a"]],
      ["wt · laptop", ["sess_b"]],
    ]);
    apply(s, { type: "session.state", params: session("sess_c", 30, { node: OTHER, workspace: "wks_far", cwd: "C:\\D\\orchestrator" }) });
    expect(shape(selectGroups(s))).toEqual([
      ["orchestrator", ["sess_a"]],
      ["orchestrator · laptop", ["sess_c"], [["wt", ["sess_b"]]]],
    ]);
  });

  test("a folded heading says how many tabs it holds; an open one is its name alone", () => {
    expect(groupHeading("orchestrator", 3, true)).toBe("orchestrator (3)");
    expect(groupHeading("orchestrator", 3, false)).toBe("orchestrator");
    expect(groupHeading("Terminals", 1, true)).toBe("Terminals (1)");
  });

  test("a tab's mark: its colours at work, yellow on an ask, green once done until its tab is opened, grey otherwise", () => {
    const s = ready();
    const tone = (id: string) => tabTone(s.sessions.get(id)!);
    // Met idle, nothing is known to have finished: grey.
    apply(s, { type: "session.state", params: session("sess_a", 1) });
    expect(tone("sess_a")).toBe("quiet");
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "busy" }) });
    expect(tone("sess_a")).toBe("active");
    // A permission prompt or a question, or an ask the row names, is the user's turn.
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "needs_permission" }) });
    expect(tone("sess_a")).toBe("ask");
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "busy", ask: "ask_1" }) });
    expect(tone("sess_a")).toBe("ask");
    // Done while its tab is closed: green until the tab is opened, then grey.
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "idle" }) });
    expect(tone("sess_a")).toBe("done");
    // Another row while still idle keeps it waiting.
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "idle", title: "renamed" }) });
    expect(tone("sess_a")).toBe("done");
    open(s, "sess_a");
    expect(tone("sess_a")).toBe("quiet");
    // Done with its tab open: looked at as it happens.
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "busy" }) });
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "idle" }) });
    expect(tone("sess_a")).toBe("quiet");
    // Back at work, it is no longer waiting to be looked at.
    apply(s, { type: "tab.open" });
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "busy" }) });
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "idle" }) });
    expect(tone("sess_a")).toBe("done");
    apply(s, { type: "session.state", params: session("sess_a", 1, { status: "busy" }) });
    expect(tone("sess_a")).toBe("active");
    // A session in a tether terminal is framed as one.
    expect(inTether(session("sess_b", 1))).toBe(false);
    expect(inTether(session("sess_b", 1, { native: { id: "n", transport: "pipe", terminal: { host: "h1", id: "t1" } } }))).toBe(true);
  });

  test("idle while its shells run is still at work: its colours and a ring, and no green dot until it is plain idle", () => {
    const s = ready();
    const tone = (id: string) => tabTone(s.sessions.get(id)!);
    apply(s, { type: "session.state", params: session("sess_w", 1, { status: "busy" }) });
    apply(s, { type: "session.state", params: session("sess_w", 1, { status: "idle", waiting: { on: "shell" } }) });
    expect(tone("sess_w")).toBe("shell");
    expect(s.sessions.get("sess_w")!.unseen).toBe(false);
    // Its shell wakes it: at work, then done for real, and waiting to be looked at.
    apply(s, { type: "session.state", params: session("sess_w", 1, { status: "busy" }) });
    expect(tone("sess_w")).toBe("active");
    apply(s, { type: "session.state", params: session("sess_w", 1, { status: "idle", waiting: { on: "shell" } }) });
    apply(s, { type: "session.state", params: session("sess_w", 1, { status: "idle" }) });
    expect(tone("sess_w")).toBe("done");
    // A dialog open in its terminal is the user's turn, whatever its status says.
    apply(s, { type: "session.state", params: session("sess_w", 1, { status: "idle", waiting: { on: "user", detail: "dialog open" } }) });
    expect(tone("sess_w")).toBe("ask");
    expect(s.sessions.get("sess_w")!.unseen).toBe(false);
    apply(s, { type: "session.state", params: session("sess_w", 1, { status: "idle" }) });
    expect(tone("sess_w")).toBe("done");
  });

  test("a folder compares as its node's filesystem does", () => {
    expect(placeKey("C:\\D\\Orchestrator\\", "windows")).toBe("c:/d/orchestrator");
    expect(placeKey("/Users/Me/app", "macos")).toBe("/users/me/app");
    expect(placeKey("/home/Me/app/", "linux")).toBe("/home/Me/app");
    // Before the node is known, a drive letter says Windows.
    expect(placeKey("D:\\Work")).toBe("d:/work");
    expect(placeKey("/home/Me")).toBe("/home/Me");
  });

  test("a tab is named by the session's title, then its intent, then the last part of its cwd", () => {
    expect(sessionLabel(session("sess_a", 1, { intent: "fix the build", title: "Build fix" }))).toBe("Build fix");
    expect(sessionLabel(session("sess_a", 1, { intent: "fix the build" }))).toBe("fix the build");
    expect(sessionLabel(session("sess_a", 1, { cwd: "C:\\src\\app\\" }))).toBe("app");
    expect(sessionLabel(session("sess_a", 1, { cwd: "/home/me/app" }))).toBe("app");
    expect(sessionLabel(session("sess_a", 1, { cwd: "/" }))).toBe("/");
  });

  test("session.event merges by seq whatever the order, and a later state keeps the events", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    open(s, "sess_a");
    apply(s, { type: "session.event", params: event("sess_a", 3, "assistant_text", { text: "three" }) });
    apply(s, { type: "session.event", params: event("sess_a", 1, "user_turn", { text: "one" }) });
    apply(s, { type: "session.event", params: event("sess_a", 2, "tool_call", { tool: "Bash", id: "t1", args: { command: "ls" } }) });
    apply(s, { type: "session.event", params: event("sess_a", 2, "tool_call", { tool: "Bash", id: "t1", args: { command: "ls -la" } }) });
    apply(s, { type: "session.state", params: session("sess_a", 100, { status: "busy" }) });
    const card = s.sessions.get("sess_a")!;
    expect(card.session.status).toBe("busy");
    expect(card.oldestSeq).toBe(1);
    const rows = selectTimeline(s, card);
    expect(rows.map((r) => r.key)).toEqual(["e1", "e2", "e3"]);
    expect((rows[1] as { event: SessionEvent }).event.payload).toEqual({ tool: "Bash", id: "t1", args: { command: "ls -la" } });
    // An event for a session the view does not know is ignored, not an error.
    apply(s, { type: "session.event", params: event("sess_x", 1, "status", { status: "idle" }) });
    expect(s.sessions.has("sess_x")).toBe(false);
  });

  test("two history pages prepend without duplicates; a short page sets exhausted", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    const opened = open(s, "sess_a");
    apply(s, { type: "session.event", params: event("sess_a", 10, "status", { status: "busy" }) });
    apply(s, { type: "history.loading", session: "sess_a" });
    expect(s.sessions.get("sess_a")!.loading).toBe(true);
    apply(s, { type: "history", session: "sess_a", opened, events: [event("sess_a", 8, "user_turn", { text: "a" }), event("sess_a", 9, "assistant_text", { text: "b" }), event("sess_a", 10, "status", { status: "busy" })], limit: 3 });
    let card = s.sessions.get("sess_a")!;
    expect(card.loading).toBe(false);
    expect(card.exhausted).toBe(false);
    expect(card.oldestSeq).toBe(8);
    expect(selectTimeline(s, card).map((r) => r.key)).toEqual(["e8", "e9", "e10"]);
    apply(s, { type: "history", session: "sess_a", opened, events: [event("sess_a", 7, "status", { status: "idle" })], limit: 3 });
    card = s.sessions.get("sess_a")!;
    expect(card.exhausted).toBe(true);
    expect(card.oldestSeq).toBe(7);
    expect(selectTimeline(s, card).map((r) => r.key)).toEqual(["e7", "e8", "e9", "e10"]);
  });

  test("a send waits at the end of the timeline until its receipt event, then rides the event with its state", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    open(s, "sess_a");
    apply(s, { type: "session.event", params: event("sess_a", 1, "status", { status: "idle" }) });
    apply(s, { type: "draft", session: "sess_a", text: "run the tests" });
    expect(s.sessions.get("sess_a")!.draft).toBe("run the tests");
    apply(s, { type: "send.result", session: "sess_a", ref: "cophylad-1", text: "run the tests", at: 5000, status: "queued" });
    const card = s.sessions.get("sess_a")!;
    expect(card.draft).toBe("");
    let rows = selectTimeline(s, card);
    expect(rows.map((r) => r.key)).toEqual(["e1", "scophylad-1"]);
    expect((rows[1] as { send: { state: string } }).send.state).toBe("queued");
    apply(s, { type: "session.event", params: event("sess_a", 2, "notification", { type: "message", ref: "cophylad-1", state: "delivered" }) });
    rows = selectTimeline(s, card);
    expect(rows.map((r) => r.key)).toEqual(["e1", "e2"]);
    const receipt = rows[1] as { send?: { state: string; text: string } };
    expect(receipt.send?.state).toBe("delivered");
    expect(receipt.send?.text).toBe("run the tests");
    expect(card.sends.get("cophylad-1")!.state).toBe("delivered");
  });

  test("an open ask is pinned; once answered it leaves the pinned list and stays joined to its timeline event", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    open(s, "sess_a");
    apply(s, { type: "ask.state", params: ask("ask_1", 300) });
    apply(s, { type: "session.event", params: event("sess_a", 1, "ask", { ask: "ask_1", phase: "opened", tool: "Write" }) });
    let stream = selectStream(s);
    expect(stream.pinned.map((a) => a.id)).toEqual(["ask_1"]);
    expect(stream.items.some((i) => i.kind === "ask")).toBe(false);
    let rows = selectTimeline(s, s.sessions.get("sess_a")!);
    expect((rows[0] as { ask?: Ask }).ask?.status).toBe("open");
    apply(s, { type: "ask.state", params: ask("ask_1", 300, { status: "answered", answer: { option: "allow", by: { kind: "user", client: CLIENT.id }, at: 400 } }) });
    apply(s, { type: "session.event", params: event("sess_a", 2, "ask", { ask: "ask_1", phase: "answered", answer: { option: "allow" } }) });
    stream = selectStream(s);
    expect(stream.pinned).toEqual([]);
    rows = selectTimeline(s, s.sessions.get("sess_a")!);
    expect((rows[1] as { ask?: Ask }).ask?.status).toBe("answered");
  });

  test("a session's own asks leave the pinned list while its terminal is on screen; the others stay", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    apply(s, { type: "session.state", params: session("sess_b", 110) });
    apply(s, { type: "ask.state", params: ask("ask_a", 300) });
    apply(s, { type: "ask.state", params: ask("ask_b", 310, { source: { kind: "harness", session: "sess_b" } }) });
    apply(s, { type: "ask.state", params: ask("ask_gate", 320, { source: { kind: "gate", action: "session.send", principal: { kind: "brain" } } }) });
    apply(s, { type: "ask.state", params: ask("ask_brain", 330, { source: { kind: "brain" } }) });
    expect(selectStream(s).pinned.map((a) => a.id)).toEqual(["ask_a", "ask_b", "ask_gate", "ask_brain"]);
    expect(selectStream(s, "sess_a").pinned.map((a) => a.id)).toEqual(["ask_b", "ask_gate", "ask_brain"]);
    expect(pinnedAsks(s, "sess_b").map((a) => a.id)).toEqual(["ask_a", "ask_gate", "ask_brain"]);
    expect(pinnedAsks(s, "sess_other").map((a) => a.id)).toEqual(["ask_a", "ask_b", "ask_gate", "ask_brain"]);
  });

  test("audit open and complete upsert one row, every row the node streams is shown, and the newest 200 are kept", () => {
    const s = ready();
    apply(s, { type: "audit.entry", params: audit("aud_1", 100, "session.send", { target: "sess_a" }) });
    apply(s, { type: "audit.entry", params: audit("aud_1", 100, "session.send", { target: "sess_a", outcome: "ok", durationMs: 12 }) });
    apply(s, { type: "audit.entry", params: audit("aud_2", 101, "chat.send", { via: "cli_other", principal: { kind: "user", client: "cli_other" } }) });
    const items = selectStream(s).items;
    expect(items.map((i) => (i.kind === "audit" ? i.entry.id : i.kind))).toEqual(["aud_1", "aud_2"]);
    expect(s.audit.get("aud_1")!.outcome).toBe("ok");
    for (let i = 0; i < AUDIT_KEEP + 20; i++) apply(s, { type: "audit.entry", params: audit(`aud_bulk_${i}`, 1000 + i, "session.send") });
    expect(s.audit.size).toBe(AUDIT_KEEP);
    expect(s.audit.has("aud_1")).toBe(false);
    expect(s.audit.has(`aud_bulk_${AUDIT_KEEP + 19}`)).toBe(true);
  });

  test("host.state false keeps the data and stops any loading; host.ready records who the client is", () => {
    const s = ready();
    expect(s.client?.id).toBe(CLIENT.id);
    expect(s.node).toBe(NODE);
    expect(s.scopes).toEqual(CLIENT.scopes);
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    open(s, "sess_a");
    apply(s, { type: "history.loading", session: "sess_a" });
    apply(s, { type: "host.state", params: { connected: false } });
    expect(s.connected).toBe(false);
    expect(s.sessions.size).toBe(1);
    expect(s.sessions.get("sess_a")!.loading).toBe(false);
    apply(s, { type: "error", message: "send: unavailable" });
    expect(s.errors).toEqual(["send: unavailable"]);
  });

  test("a host with a microphone and no talk button of its own gets one in the composer", () => {
    const s = ready();
    expect(s.hostTalk).toBe(false);
    apply(s, { type: "host.ready", params: { ...READY, talk: true } });
    expect(s.hostTalk).toBe(true);
    // The phone's bar has its own: its host says nothing of talk.
    apply(s, { type: "host.ready", params: { ...READY, menu: true } });
    expect(s.hostTalk).toBe(false);
  });

  test("files dragged in from the desktop are taken only from a host that says where they are", () => {
    const s = ready();
    expect(s.hostFilePaths).toBe(false);
    apply(s, { type: "host.ready", params: { ...READY, filePaths: true } });
    expect(s.hostFilePaths).toBe(true);
    apply(s, { type: "host.ready", params: READY });
    expect(s.hostFilePaths).toBe(false);
  });

  test("loaded threads and messages take their place among audit rows, oldest first; a session is a tab, not an item", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 150) });
    apply(s, { type: "audit.entry", params: audit("aud_1", 250, "session.send") });
    apply(s, { type: "chat.loaded", threads: [thread("thr_1", 100, { topic: "the build" })], messages: [message("msg_1", "thr_1", 100, "user", "fix it"), message("msg_2", "thr_1", 200, "orchestrator", "on it", { content: [{ type: "text", text: "on it" }, { type: "quote", text: "tests pass", source: { kind: "session", session: "sess_a", seq: [3, 3] } }, { type: "ref", session: "sess_a" }] })], limit: 1 });
    expect(s.chatLoaded).toBe(true);
    expect(s.chatLoading).toBe(false);
    expect(s.oldestThread).toBe("thr_1");
    expect(s.threadsExhausted).toBe(false);
    const items = selectStream(s).items;
    expect(items.map((i) => i.kind)).toEqual(["thread", "message", "message", "audit"]);
    expect(selectGroups(s).flatMap((g) => g.sessions.map((c) => c.session.id))).toEqual(["sess_a"]);
    expect(messageText(s.messages.get("msg_2")!.content)).toBe("on it tests pass");
    // A live message lands in its thread; one for an unknown thread makes a bare divider.
    apply(s, { type: "chat.message", params: { message: message("msg_3", "thr_2", 300, "user", "and now?") } });
    expect(s.threads.get("thr_2")).toEqual({ id: "thr_2", startedAt: 300, sessions: [] });
    expect(selectStream(s).items.map((i) => i.kind)).toEqual(["thread", "message", "message", "audit", "thread", "message"]);
  });

  test("a chat.delta placeholder grows in place and is replaced by the chat.message with the same id", () => {
    const s = ready();
    apply(s, { type: "chat.delta", params: { message: "msg_9", block: 0, delta: { type: "text", text: "Hel" } } });
    apply(s, { type: "chat.delta", params: { message: "msg_9", block: 0, delta: { type: "text", text: "lo" } } });
    expect(s.streaming.get("msg_9")!.blocks).toEqual([{ type: "text", text: "Hello" }]);
    let items = selectStream(s).items;
    expect(items.map((i) => i.kind)).toEqual(["streaming"]);
    apply(s, { type: "chat.message", params: { message: message("msg_9", "thr_1", 500, "orchestrator", "Hello there.") } });
    expect(s.streaming.size).toBe(0);
    items = selectStream(s).items;
    expect(items.map((i) => i.kind)).toEqual(["thread", "message"]);
    // A late delta for a stored message is ignored.
    apply(s, { type: "chat.delta", params: { message: "msg_9", block: 0, delta: { type: "text", text: "!" } } });
    expect(s.streaming.size).toBe(0);
    // Disconnecting drops any placeholder and forgets the load.
    apply(s, { type: "chat.delta", params: { message: "msg_10", block: 0, delta: { type: "text", text: "x" } } });
    apply(s, { type: "host.state", params: { connected: false } });
    expect(s.streaming.size).toBe(0);
    expect(s.chatLoaded).toBe(false);
    expect(s.messages.size).toBe(1);
  });

  test("a chat.retract drops the placeholder and leaves stored messages alone", () => {
    const s = ready();
    apply(s, { type: "chat.message", params: { message: message("msg_1", "thr_1", 100, "orchestrator", "Stored.") } });
    apply(s, { type: "chat.delta", params: { message: "msg_2", block: 0, delta: { type: "text", text: "Let me check." } } });
    expect(selectStream(s).items.map((i) => i.kind)).toEqual(["thread", "message", "streaming"]);
    apply(s, { type: "chat.retract", params: { message: "msg_2" } });
    expect(s.streaming.size).toBe(0);
    expect(selectStream(s).items.map((i) => i.kind)).toEqual(["thread", "message"]);
    // A retract for a stored message or an unknown id changes nothing.
    apply(s, { type: "chat.retract", params: { message: "msg_1" } });
    apply(s, { type: "chat.retract", params: { message: "msg_x" } });
    expect(s.messages.size).toBe(1);
  });

  test("the orchestrator's turn shows last while it works, gives way to its streaming reply, and goes when it ends or the node does", () => {
    const s = ready();
    apply(s, { type: "chat.message", params: { message: message("msg_1", "thr_1", 100, "user", "What's the plan?") } });
    const turn = { steps: [{ text: "Checked agent sessions", status: "done" as const }], thinking: true };
    apply(s, { type: "chat.progress", params: { turn } });
    const items = selectStream(s).items;
    expect(items.map((i) => i.kind)).toEqual(["thread", "message", "progress"]);
    expect(keyOf(items[2]!)).toBe("progress");
    // A later message still comes before it: it is always what is happening now.
    apply(s, { type: "chat.message", params: { message: message("msg_2", "thr_1", 9e15, "user", "and the tests?") } });
    expect(selectStream(s).items.map((i) => i.kind).at(-1)).toBe("progress");
    // While the reply streams, the reply is what it is doing, and it carries the steps folded above it.
    apply(s, { type: "chat.progress", params: { turn: { steps: [...turn.steps, { text: "Reading plan.md", status: "running" }], thinking: true } } });
    apply(s, { type: "chat.delta", params: { message: "msg_3", block: 0, delta: { type: "text", text: "The plan" } } });
    expect(selectStream(s).items.map((i) => i.kind)).not.toContain("progress");
    expect(s.streaming.get("msg_3")!.steps).toEqual(turn.steps);
    apply(s, { type: "chat.retract", params: { message: "msg_3" } });
    expect(selectStream(s).items.map((i) => i.kind).at(-1)).toBe("progress");
    // A turn with nothing to show yet shows nothing.
    apply(s, { type: "chat.progress", params: { turn: { steps: [], thinking: false } } });
    expect(selectStream(s).items.map((i) => i.kind)).not.toContain("progress");
    apply(s, { type: "chat.progress", params: {} });
    expect(s.progress).toBeUndefined();
    expect(selectStream(s).items.map((i) => i.kind)).not.toContain("progress");
    apply(s, { type: "chat.progress", params: { turn } });
    apply(s, { type: "host.state", params: { connected: false } });
    expect(s.progress).toBeUndefined();
  });

  test("a second chat.load prepends an earlier thread with its divider; a short page sets exhausted", () => {
    const s = ready();
    apply(s, { type: "chat.loaded", threads: [thread("thr_2", 200, { topic: "later" })], messages: [message("msg_2", "thr_2", 210, "user", "b")], limit: 1 });
    apply(s, { type: "chat.loading" });
    expect(s.chatLoading).toBe(true);
    apply(s, { type: "chat.loaded", threads: [thread("thr_1", 100, { topic: "earlier" })], messages: [message("msg_1", "thr_1", 110, "user", "a")], limit: 1 });
    expect(s.oldestThread).toBe("thr_1");
    expect(s.threadsExhausted).toBe(false);
    const items = selectStream(s).items;
    expect(items.map((i) => (i.kind === "thread" ? i.thread.topic : i.kind === "message" ? i.message.id : i.kind))).toEqual(["earlier", "msg_1", "later", "msg_2"]);
    apply(s, { type: "chat.loaded", threads: [], messages: [], limit: 1 });
    expect(s.threadsExhausted).toBe(true);
    expect(s.oldestThread).toBe("thr_1");
  });

  test("task rows follow task.state and leave when done, among the audit rows by time", () => {
    const s = ready();
    apply(s, { type: "task.state", params: task("task_1", 100, { status: "blocked", blocker: { kind: "user" } }) });
    apply(s, { type: "task.state", params: task("task_1", 100, { status: "active", updatedAt: 120 }) });
    apply(s, { type: "task.state", params: task("task_2", 130) });
    expect(s.tasks.get("task_1")!.status).toBe("active");
    expect(selectStream(s).items.map((i) => (i.kind === "task" ? i.task.id : i.kind))).toEqual(["task_1", "task_2"]);
    apply(s, { type: "task.state", params: task("task_2", 130, { status: "done", completedAt: 140 }) });
    expect(s.tasks.has("task_2")).toBe(false);
    apply(s, { type: "audit.entry", params: audit("aud_3", 202, "chat.send") });
    expect(selectStream(s).items.map((i) => (i.kind === "audit" ? i.entry.id : i.kind))).toEqual(["task", "aud_3"]);
  });

  test("the composer's text becomes chat.send params; /quick and the toggle set the mode", () => {
    expect(parseComposer("  what is running  ", false)).toEqual({ text: "what is running" });
    expect(parseComposer("what is running", true)).toEqual({ text: "what is running", mode: "quick" });
    expect(parseComposer("/quick is it done", false)).toEqual({ text: "is it done", mode: "quick" });
    expect(parseComposer("/QUICK   is it done", false)).toEqual({ text: "is it done", mode: "quick" });
    expect(parseComposer("/quickly now", false)).toEqual({ text: "/quickly now" });
    expect(parseComposer("   ", false)).toBeUndefined();
    expect(parseComposer("/quick", true)).toBeUndefined();
    const s = ready();
    apply(s, { type: "quick.toggle" });
    expect(s.quick).toBe(true);
    apply(s, { type: "quick.toggle", quick: false });
    expect(s.quick).toBe(false);
  });

  test("workspaces and profiles are looked up by id", () => {
    const s = ready();
    apply(s, { type: "workspace.state", params: { id: "ws_1", node: NODE, path: "C:\\src", name: "src", origin: "discovered", lastActivity: 1 } });
    apply(s, { type: "profiles", profiles: [{ id: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", node: NODE, harness: "claude", name: "work", configDir: "C:\\x", env: {}, origin: "user", status: "ok" }] });
    expect(s.workspaces.get("ws_1")!.name).toBe("src");
    expect(s.profiles.get("prof_01ARZ3NDEKTSV4RRFFQ69G5FB8")!.name).toBe("work");
  });

  test("thread.state upserts the divider and keeps the messages", () => {
    const s = ready();
    apply(s, { type: "chat.loaded", threads: [thread("thr_1", 100, { topic: "the gate" })], messages: [message("msg_1", "thr_1", 110, "user", "fix it"), message("msg_2", "thr_1", 120, "orchestrator", "Done.")], limit: 1 });
    apply(s, { type: "thread.state", params: thread("thr_1", 100, { topic: "the gate tests", endedAt: 130 }) });
    expect(s.messages.size).toBe(2);
    const items = selectStream(s).items;
    const divider = items[0]!;
    expect(divider.kind).toBe("thread");
    if (divider.kind === "thread") expect(divider.thread).toMatchObject({ topic: "the gate tests", endedAt: 130 });
    expect(items.map((i) => (i.kind === "message" ? i.message.id : i.kind))).toEqual(["thread", "msg_1", "msg_2"]);
    // A thread not yet seen is added by its state alone; a later chat.message does not reset it.
    apply(s, { type: "thread.state", params: thread("thr_2", 200, { topic: "next" }) });
    apply(s, { type: "chat.message", params: { message: message("msg_3", "thr_2", 210, "user", "hi") } });
    expect(s.threads.get("thr_2")!.topic).toBe("next");
  });

  test("a multiple choice ask is pinned like any other and keeps its options and answer", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    open(s, "sess_a");
    const q = ask("ask_q", 300, { type: "choice", title: "Which tools?", detail: "Tools · 2 of 2", options: [{ id: "ESLint", label: "ESLint", description: "the linter" }, { id: "Prettier", label: "Prettier" }], multiple: true, allowsText: true });
    apply(s, { type: "ask.state", params: q });
    expect(selectStream(s).pinned[0]).toMatchObject({ id: "ask_q", multiple: true, options: [{ id: "ESLint", description: "the linter" }, { id: "Prettier" }] });
    apply(s, { type: "session.event", params: event("sess_a", 1, "ask", { ask: "ask_q", phase: "opened", tool: "AskUserQuestion", question: 2, of: 2 }) });
    const answer = { option: "ESLint", options: ["ESLint", "Prettier"], text: "Biome", by: { kind: "user" as const, client: CLIENT.id }, at: 400 };
    apply(s, { type: "ask.state", params: { ...q, status: "answered", answer } });
    expect(selectStream(s).pinned).toEqual([]);
    const rows = selectTimeline(s, s.sessions.get("sess_a")!);
    expect((rows[0] as { ask?: Ask }).ask?.answer?.options).toEqual(["ESLint", "Prettier"]);
  });
});

describe("default view: what streams and what loads", () => {
  test("a closed tab takes no events; leaving a tab drops its timeline and pending sends and keeps the draft; a page asked for before it closed is dropped", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    apply(s, { type: "session.state", params: session("sess_b", 200) });
    const a = s.sessions.get("sess_a")!;
    // A card starts closed: an event still on its way from before a watch lands nowhere.
    apply(s, { type: "session.event", params: event("sess_a", 1, "status", { status: "busy" }) });
    expect(a.open).toBe(false);
    expect(a.events.size).toBe(0);

    const first = open(s, "sess_a");
    expect(a.open).toBe(true);
    apply(s, { type: "session.event", params: event("sess_a", 5, "assistant_text", { text: "hi" }) });
    apply(s, { type: "history.loading", session: "sess_a" });
    apply(s, { type: "history", session: "sess_a", opened: first, events: [event("sess_a", 3, "user_turn", { text: "go" }), event("sess_a", 4, "status", { status: "busy" })], limit: 2 });
    apply(s, { type: "send.result", session: "sess_a", ref: "cophylad-1", text: "first", at: 2000, status: "queued" });
    apply(s, { type: "draft", session: "sess_a", text: "run the tests" });
    expect(selectTimeline(s, a).map((r) => r.key)).toEqual(["e3", "e4", "e5", "scophylad-1"]);
    apply(s, { type: "history.loading", session: "sess_a" });

    // Another tab: the first drops what it showed, and keeps what was typed.
    open(s, "sess_b");
    expect(a).toMatchObject({ open: false, exhausted: false, loading: false, draft: "run the tests" });
    expect(a.events.size).toBe(0);
    expect(a.sends.size).toBe(0);
    expect(a.oldestSeq).toBeUndefined();
    expect(s.sessions.get("sess_b")!.open).toBe(true);
    // The page that was on its way, a late event and a late send land nowhere, and a closed tab
    // never loads; the send's draft is spent all the same.
    apply(s, { type: "history", session: "sess_a", opened: first, events: [event("sess_a", 2, "user_turn", { text: "x" })], limit: 50 });
    apply(s, { type: "session.event", params: event("sess_a", 6, "status", { status: "idle" }) });
    apply(s, { type: "send.result", session: "sess_a", ref: "cophylad-2", text: "run the tests", at: 3000, status: "queued" });
    apply(s, { type: "history.loading", session: "sess_a" });
    expect(a.events.size).toBe(0);
    expect(a.sends.size).toBe(0);
    expect(a.loading).toBe(false);
    expect(a.draft).toBe("");

    // Opened again it starts afresh: a page asked for under the earlier opening is still dropped.
    const second = open(s, "sess_a");
    expect(second).toBe(first + 1);
    expect(s.sessions.get("sess_b")!.open).toBe(false);
    apply(s, { type: "history", session: "sess_a", opened: first, events: [event("sess_a", 2, "user_turn", { text: "x" })], limit: 50 });
    expect(a.events.size).toBe(0);
    apply(s, { type: "session.event", params: event("sess_a", 7, "status", { status: "busy" }) });
    apply(s, { type: "history", session: "sess_a", opened: second, events: [event("sess_a", 6, "status", { status: "idle" })], limit: 50 });
    expect(selectTimeline(s, a).map((r) => r.key)).toEqual(["e6", "e7"]);
    expect(a.exhausted).toBe(true);
    // The open tab opened again, as on a reconnect: it drops what it had and starts over.
    const third = open(s, "sess_a");
    expect(third).toBe(second + 1);
    expect(a).toMatchObject({ open: true, exhausted: false });
    expect(a.events.size).toBe(0);
    // The chat closes every tab.
    apply(s, { type: "session.event", params: event("sess_a", 8, "status", { status: "idle" }) });
    apply(s, { type: "tab.open" });
    expect([...s.sessions.values()].map((c) => c.open)).toEqual([false, false]);
    expect(a.events.size).toBe(0);
  });

  test("the tab shown is watched, none for the chat, and nothing is said offline or without sessions:read", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    expect(watchParams(s, "sess_a")).toEqual({ ids: ["sess_a"] });
    expect(watchParams(s, undefined)).toEqual({ ids: [] });
    expect(watchParams(s, "sess_gone")).toEqual({ ids: [] });
    apply(s, { type: "host.state", params: { connected: false } });
    expect(watchParams(s, "sess_a")).toBeUndefined();
    const narrow = ready();
    narrow.scopes = narrow.scopes.filter((scope) => scope !== "sessions:read");
    expect(watchParams(narrow, undefined)).toBeUndefined();
  });

  test("the desktop loads history unasked; a phone or the web app, a controller, does not", () => {
    expect(loadsHistory(ready())).toBe(true);
    expect(loadsHistory(ready({ kind: "controller" }))).toBe(false);
    // Until the host says who the client is, it is taken for the desktop.
    expect(loadsHistory(initialState())).toBe(true);
  });

  test("the button above a timeline: Load history while nothing is loaded, Show earlier once something is, none at the start", () => {
    const s = ready({ kind: "controller" });
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    const opened = open(s, "sess_a");
    const card = s.sessions.get("sess_a")!;
    expect(earlierButton(s, card)).toEqual({ label: "Load history", disabled: false });
    apply(s, { type: "history.loading", session: "sess_a" });
    expect(earlierButton(s, card)).toEqual({ label: "Loading…", disabled: true });
    apply(s, { type: "history", session: "sess_a", opened, events: [event("sess_a", 60, "status", { status: "idle" })], limit: 1 });
    expect(earlierButton(s, card)).toEqual({ label: "Show earlier", disabled: false });
    apply(s, { type: "history", session: "sess_a", opened, events: [], limit: 1 });
    expect(earlierButton(s, card)).toBeUndefined();
    // A live event alone is something to page back from; offline the button waits.
    open(s, "sess_a");
    apply(s, { type: "session.event", params: event("sess_a", 61, "status", { status: "busy" }) });
    expect(earlierButton(s, card)).toEqual({ label: "Show earlier", disabled: false });
    apply(s, { type: "host.state", params: { connected: false } });
    expect(earlierButton(s, card)?.disabled).toBe(true);
  });

  test("the chat's top button: Load history on a phone until a thread is loaded, nothing on the desktop meanwhile; then Earlier while there is an earlier thread", () => {
    const desk = ready();
    expect(chatButton(desk)).toBeUndefined();
    apply(desk, { type: "chat.loading" });
    expect(chatButton(desk)).toBeUndefined();
    apply(desk, { type: "chat.loaded", threads: [thread("thr_2", 200)], messages: [], limit: 1 });
    expect(chatButton(desk)).toEqual({ action: "threads-earlier", label: "Earlier", disabled: false });

    const phone = ready({ kind: "controller" });
    expect(chatButton(phone)).toEqual({ action: "chat-history", label: "Load history", disabled: false });
    apply(phone, { type: "chat.loading" });
    expect(chatButton(phone)).toEqual({ action: "chat-history", label: "Loading…", disabled: true });
    // A load that failed leaves the button to ask again.
    apply(phone, { type: "chat.failed" });
    expect(chatButton(phone)).toEqual({ action: "chat-history", label: "Load history", disabled: false });
    apply(phone, { type: "chat.loading" });
    apply(phone, { type: "chat.loaded", threads: [thread("thr_2", 200)], messages: [], limit: 1 });
    expect(chatButton(phone)).toEqual({ action: "threads-earlier", label: "Earlier", disabled: false });
    apply(phone, { type: "chat.loading" });
    expect(chatButton(phone)).toEqual({ action: "threads-earlier", label: "Loading…", disabled: true });
    apply(phone, { type: "chat.loaded", threads: [], messages: [], limit: 1 });
    expect(chatButton(phone)).toBeUndefined();
    // A disconnect forgets the load: back on the line, Load history fetches what was missed.
    apply(phone, { type: "host.state", params: { connected: false } });
    expect(chatButton(phone)).toEqual({ action: "chat-history", label: "Load history", disabled: true });
    // Without the chat scope there is nothing to load.
    phone.scopes = phone.scopes.filter((scope) => scope !== "chat");
    expect(chatButton(phone)).toBeUndefined();
  });

  test("a load merges with the live messages that came before it: each message once, the thread's row over its bare divider, a finished reply no longer streaming", () => {
    const s = ready({ kind: "controller" });
    apply(s, { type: "chat.message", params: { message: message("msg_3", "thr_2", 300, "user", "and now?") } });
    apply(s, { type: "chat.delta", params: { message: "msg_4", block: 0, delta: { type: "text", text: "Work" } } });
    expect(s.threads.get("thr_2")).toEqual({ id: "thr_2", startedAt: 300, sessions: [] });
    expect(selectStream(s).items.map(keyOf)).toEqual(["thread:thr_2", "message:msg_3", "message:msg_4"]);
    apply(s, {
      type: "chat.loaded",
      threads: [thread("thr_2", 250, { topic: "the build" })],
      messages: [message("msg_2", "thr_2", 260, "user", "fix it"), message("msg_3", "thr_2", 300, "user", "and now?"), message("msg_4", "thr_2", 310, "orchestrator", "Working on it.")],
      limit: 1,
    });
    expect(s.streaming.size).toBe(0);
    expect(s.threads.get("thr_2")!.topic).toBe("the build");
    expect(s.oldestThread).toBe("thr_2");
    expect(selectStream(s).items.map(keyOf)).toEqual(["thread:thr_2", "message:msg_2", "message:msg_3", "message:msg_4"]);
    // A late delta for the loaded reply is ignored, and a live message after the load lands in its place.
    apply(s, { type: "chat.delta", params: { message: "msg_4", block: 0, delta: { type: "text", text: "!" } } });
    apply(s, { type: "chat.message", params: { message: message("msg_5", "thr_2", 320, "user", "thanks") } });
    expect(s.streaming.size).toBe(0);
    expect(selectStream(s).items.map(keyOf)).toEqual(["thread:thr_2", "message:msg_2", "message:msg_3", "message:msg_4", "message:msg_5"]);
  });

  test("a thread known only from its state, closed while nothing was loaded, is paged through, not started behind", () => {
    const s = ready({ kind: "controller" });
    // The archive closes the thread before, then the user starts a new one: both reach the phone live.
    apply(s, { type: "thread.state", params: thread("thr_4", 400, { endedAt: 450, topic: "the gate" }) });
    apply(s, { type: "chat.message", params: { message: message("msg_9", "thr_5", 500, "user", "next") } });
    apply(s, { type: "chat.loaded", threads: [thread("thr_5", 500)], messages: [message("msg_9", "thr_5", 500, "user", "next")], limit: 1 });
    expect(s.oldestThread).toBe("thr_5");
    // Earlier asks for the page before thr_5, which is thr_4 with its messages.
    apply(s, { type: "chat.loaded", threads: [thread("thr_4", 400, { endedAt: 450, topic: "the gate" })], messages: [message("msg_8", "thr_4", 410, "user", "fix it")], limit: 1 });
    expect(s.oldestThread).toBe("thr_4");
    expect(selectStream(s).items.map(keyOf)).toEqual(["thread:thr_4", "message:msg_8", "thread:thr_5", "message:msg_9"]);
  });
});

describe("default view: answering an ask", () => {
  const single = ask("ask_s", 1, { type: "choice", title: "Which cache?", options: [{ id: "Redis", label: "Redis" }, { id: "Memcached", label: "Memcached" }], allowsText: true });
  const multi = { ...single, id: "ask_m", multiple: true, options: [{ id: "ESLint", label: "ESLint" }, { id: "Prettier", label: "Prettier" }] };
  const permission = ask("ask_p", 1);
  const gate = ask("ask_g", 1, { source: { kind: "gate", action: "session.send", principal: { kind: "brain" } } });

  test("answerParams: a click, a click with a note, text alone, ticks, ticks with text, nothing", () => {
    expect(answerParams(single, { selected: ["Redis"], text: "" })).toEqual({ id: "ask_s", option: "Redis" });
    expect(answerParams(single, { selected: ["Redis"], text: " managed " })).toEqual({ id: "ask_s", option: "Redis", text: "managed" });
    expect(answerParams(single, { selected: [], text: "Valkey" })).toEqual({ id: "ask_s", option: "text", text: "Valkey" });
    expect(answerParams(single, { selected: [], text: "   " })).toBeUndefined();
    expect(answerParams(single, { selected: ["nope"], text: "" })).toBeUndefined();
    expect(answerParams(multi, { selected: ["Prettier", "ESLint", "Prettier"], text: "" })).toEqual({ id: "ask_m", option: "Prettier", options: ["Prettier", "ESLint"] });
    expect(answerParams(multi, { selected: ["ESLint"], text: "Biome" })).toEqual({ id: "ask_m", option: "ESLint", options: ["ESLint"], text: "Biome" });
    expect(answerParams(multi, { selected: [], text: "Biome" })).toEqual({ id: "ask_m", option: "text", text: "Biome" });
    expect(answerParams(multi, { selected: [], text: "" })).toBeUndefined();
    // Text alone needs the ask to allow it; remember only for the lasting kinds.
    expect(answerParams(permission, { selected: [], text: "no" })).toBeUndefined();
    expect(answerParams(gate, { selected: ["allow"], text: "", remember: "once" })).toEqual({ id: "ask_g", option: "allow" });
    expect(answerParams(gate, { selected: ["allow"], text: "", remember: "always" })).toEqual({ id: "ask_g", option: "allow", remember: "always" });
    expect(answerParams(gate, { selected: ["deny"], text: "", remember: "session" })).toEqual({ id: "ask_g", option: "deny", remember: "session" });
  });

  test("answerWords: labels, a note, the text quoted, and a declared option literally named text", () => {
    const by = { kind: "user" as const, client: CLIENT.id };
    expect(answerWords(single, { option: "Redis", by, at: 1 })).toBe("Redis");
    expect(answerWords(single, { option: "Redis", text: "managed", by, at: 1 })).toBe("Redis: managed");
    expect(answerWords(single, { option: "text", text: "Valkey", by, at: 1 })).toBe("“Valkey”");
    expect(answerWords(multi, { option: "ESLint", options: ["ESLint", "Prettier"], text: "Biome", by, at: 1 })).toBe("ESLint, Prettier: Biome");
    expect(answerWords(permission, { option: "allow", by, at: 1 })).toBe("Allow");
    expect(answerWords(permission, { option: "gone", by, at: 1 })).toBe("gone");
    const literal = { ...single, options: [{ id: "text", label: "Plain text" }] };
    expect(answerWords(literal, { option: "text", by, at: 1 })).toBe("Plain text");
  });

  test("askEventText: a question or a prompt, with what became of it", () => {
    const by = { kind: "user" as const, client: CLIENT.id };
    expect(askEventText({ ask: "ask_s", phase: "opened", tool: "AskUserQuestion", question: 1, of: 2 }, single)).toEqual({ label: "question", text: "Which cache?: waiting" });
    expect(askEventText({ ask: "ask_s", phase: "opened", tool: "AskUserQuestion" }, undefined)).toEqual({ label: "question", text: "a question: waiting" });
    expect(askEventText({ ask: "ask_p", phase: "opened", tool: "Write" }, undefined)).toEqual({ label: "prompt", text: "Write permission: waiting" });
    expect(askEventText({ ask: "ask_p", phase: "opened" }, undefined)).toEqual({ label: "prompt", text: "a prompt: waiting" });
    expect(askEventText({ ask: "ask_s", phase: "answered", answer: { option: "text", text: "Valkey", by, at: 2 } }, single)).toEqual({ label: "question", text: "Which cache?: “Valkey”" });
    // An answered event names no tool: without its ask it reads as a prompt, with the answer's own words.
    expect(askEventText({ ask: "ask_s", phase: "answered", answer: { option: "text", text: "Valkey", by, at: 2 } }, undefined)).toEqual({ label: "prompt", text: "a prompt: “Valkey”" });
    expect(askEventText({ ask: "ask_m", phase: "answered", answer: { option: "ESLint", options: ["ESLint", "Prettier"], by, at: 2 } }, undefined)).toEqual({ label: "prompt", text: "a prompt: ESLint, Prettier" });
    expect(askEventText({ ask: "ask_p", phase: "answered", answer: { option: "allow", by, at: 2 } }, permission)).toEqual({ label: "prompt", text: "Write in x: Allow" });
    expect(askEventText({ ask: "ask_p", phase: "answered" }, undefined)).toEqual({ label: "prompt", text: "a prompt: answered" });
    expect(askEventText({ ask: "ask_s", phase: "closed", reason: "terminal" }, single)).toEqual({ label: "question", text: "Which cache?: closed (terminal)" });
  });
});

describe("default view: scheduled tasks", () => {
  const cron = { kind: "cron", expr: "0 9 * * *" } as const;
  const write: Scope[] = ["tasks:read", "tasks:write"];

  test("taskActions: pause for a scheduled task that waits or is ready, resume for a paused one, done for any open one; nothing without tasks:write", () => {
    expect(taskActions(task("t", 1, { status: "pending", trigger: cron }), write)).toEqual(["pause", "complete"]);
    expect(taskActions(task("t", 1, { status: "ready", trigger: cron }), write)).toEqual(["pause", "complete"]);
    expect(taskActions(task("t", 1, { status: "ready" }), write)).toEqual(["complete"]);
    expect(taskActions(task("t", 1, { status: "paused", trigger: cron }), write)).toEqual(["resume", "complete"]);
    expect(taskActions(task("t", 1, { status: "active", trigger: cron }), write)).toEqual(["complete"]);
    expect(taskActions(task("t", 1, { status: "blocked", blocker: { kind: "user" } }), write)).toEqual(["complete"]);
    expect(taskActions(task("t", 1, { status: "done", trigger: cron }), write)).toEqual([]);
    expect(taskActions(task("t", 1, { status: "cancelled" }), write)).toEqual([]);
    expect(taskActions(task("t", 1, { status: "pending", trigger: cron }), ["tasks:read"])).toEqual([]);
  });

  test("triggerWords: a daily, weekday or minutely cron in words, any other as cron, an event by name, a time by weekday and clock", () => {
    expect(triggerWords(task("t", 1))).toBe("");
    expect(triggerWords(task("t", 1, { trigger: cron, recurring: true }))).toBe("daily 09:00");
    expect(triggerWords(task("t", 1, { trigger: cron }))).toBe("at 09:00");
    expect(triggerWords(task("t", 1, { trigger: { kind: "cron", expr: "30 18 * * 1-5", tz: "Europe/Istanbul" }, recurring: true }))).toBe("weekdays 18:30 (Europe/Istanbul)");
    expect(triggerWords(task("t", 1, { trigger: { kind: "cron", expr: "* * * * *" }, recurring: true }))).toBe("every minute");
    expect(triggerWords(task("t", 1, { trigger: { kind: "cron", expr: "0 0 29 2 *" }, recurring: true }))).toBe("cron 0 0 29 2 *");
    expect(triggerWords(task("t", 1, { trigger: { kind: "cron", expr: "*/5 9 * * *" } }))).toBe("cron */5 9 * * *");
    expect(triggerWords(task("t", 1, { trigger: { kind: "event", name: "inbox.file", match: { x: 1 } }, recurring: true }))).toBe("on inbox.file");
    const at = new Date(2026, 2, 10, 14, 5).getTime();
    expect(triggerWords(task("t", 1, { trigger: { kind: "at", at } }))).toBe("at Tue 14:05");
  });
});

describe("default view: voice and the phones", () => {
  const controller = (id: string, name: string, over: Partial<Controller> = {}): Controller => ({ id, name, pairedAt: 1000, connected: false, ...over });

  function paired(...controllers: Controller[]): ViewState {
    const state = initialState();
    apply(state, { type: "host.ready", params: { ...READY, scopes: [...CLIENT.scopes, "voice", "controllers"] as Scope[] } });
    apply(state, { type: "host.state", params: { connected: true } });
    apply(state, { type: "controllers", controllers });
    return state;
  }

  test("a conversation is kept with the phone it is on, and cleared when it goes idle", () => {
    const state = paired(controller("ctl_1", "Pixel", { connected: true }));
    apply(state, { type: "voice.state", params: { state: "listening", client: "cli_1" } });
    expect(state.voice).toMatchObject({ state: "listening", client: "cli_1" });
    expect(voiceBusy(state)).toBe(true);
    expect(voiceWords(state)).toBe("listening · Pixel");

    apply(state, { type: "voice.state", params: { state: "thinking", client: "cli_1" } });
    expect(voiceWords(state)).toBe("thinking · Pixel");
    apply(state, { type: "voice.state", params: { state: "idle", client: "cli_1" } });
    expect(state.voice).toBeUndefined();
    expect(voiceBusy(state)).toBe(false);
    expect(voiceWords(state)).toBe("");
  });

  test("Escape can take back this view's own utterance while it is heard or transcribed, and nothing else", () => {
    const state = paired();
    expect(voiceCancellable(state)).toBe(false);
    // Begun by the talk button or the wake word, the node says only whose it is.
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    expect(voiceCancellable(state)).toBe(true);
    apply(state, { type: "voice.state", params: { state: "transcribing", client: CLIENT.id } });
    expect(voiceCancellable(state)).toBe(true);
    // Sent: the brain has it, and the reply is not an utterance.
    apply(state, { type: "voice.state", params: { state: "thinking", client: CLIENT.id } });
    expect(voiceCancellable(state)).toBe(false);
    apply(state, { type: "voice.state", params: { state: "speaking", client: CLIENT.id } });
    expect(voiceCancellable(state)).toBe(false);
    // A phone's is the phone's.
    apply(state, { type: "voice.state", params: { state: "listening", client: "cli_phone" } });
    expect(voiceCancellable(state)).toBe(false);
    // A view that may not use voice asks nothing.
    const mute = initialState();
    apply(mute, { type: "host.ready", params: READY });
    apply(mute, { type: "host.state", params: { connected: true } });
    apply(mute, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    expect(voiceCancellable(mute)).toBe(false);
  });

  test("a press of this view's that came to nothing says why for a while; a phone's is not this view's to explain", () => {
    const state = paired(controller("ctl_1", "Pixel", { connected: true }));
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    apply(state, { type: "voice.state", params: { state: "idle", client: CLIENT.id, unheard: "no-speech" } });
    expect(voiceWords(state)).toBe("No speech was heard");
    expect(voiceDot(state)).toBe("idle");
    // A newer note is not cleared by an older one's time running out.
    const at = state.voiceNote!.at;
    apply(state, { type: "voice.note.expired", at: at - 1 });
    expect(state.voiceNote).toBeDefined();
    apply(state, { type: "voice.note.expired", at });
    expect(voiceWords(state)).toBe("");
    // No sound at all is trouble, and the next utterance takes the note away.
    apply(state, { type: "voice.state", params: { state: "idle", client: CLIENT.id, unheard: "silence" } });
    expect(voiceWords(state)).toContain("the microphone sent only silence");
    expect(voiceDot(state)).toBe("trouble");
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    expect(state.voiceNote).toBeUndefined();
    // A phone's.
    apply(state, { type: "voice.state", params: { state: "idle", client: "cli_phone", unheard: "no-audio" } });
    expect(state.voiceNote).toBeUndefined();
  });

  test("the host's microphone off is said in the voice row, beside a press that came to nothing, and only where the view draws the talk button", () => {
    const state = paired();
    state.hostTalk = true;
    apply(state, { type: "host.mic", params: { error: "Microphone (USB Advanced Audio Device) went away: unplugged, or turned off" } });
    expect(micOff(state)).toContain("went away");
    expect(voiceWords(state)).toBe("The microphone is off: Microphone (USB Advanced Audio Device) went away: unplugged, or turned off");
    expect(voiceDot(state)).toBe("trouble");
    apply(state, { type: "voice.state", params: { state: "idle", client: CLIENT.id, unheard: "no-audio" } });
    expect(voiceWords(state)).toBe("Nothing was heard: the microphone is off (Microphone (USB Advanced Audio Device) went away: unplugged, or turned off)");
    apply(state, { type: "host.mic", params: {} });
    expect(micOff(state)).toBeUndefined();
    expect(voiceWords(state)).toBe("Nothing was heard: no sound came from the microphone");
    // A host with a talk button of its own (the phone) is not the view's to speak for.
    const phone = paired();
    apply(phone, { type: "host.mic", params: { error: "off" } });
    expect(micOff(phone)).toBeUndefined();
    expect(voiceWords(phone)).toBe("");
  });

  test("each reason a press came to nothing has its words", () => {
    expect(unheardWords("no-audio")).toBe("Nothing was heard: no sound came from the microphone");
    expect(unheardWords("silence")).toBe("Nothing was heard: the microphone sent only silence. Is it unplugged or muted?");
    expect(unheardWords("no-speech")).toBe("No speech was heard");
    expect(unheardWords("no-words")).toBe("Nothing could be made out of what was said");
    expect(unheardWords("silence", "none could be had")).toBe("Nothing was heard: the microphone is off (none could be had)");
  });

  test("this view's utterance shows at the chat's end as it is heard, growing by what follows the part kept, until its message lands", () => {
    const state = paired();
    apply(state, { type: "chat.message", params: { message: message("msg_1", "thr_1", 100, "orchestrator", "Hello.") } });
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id, limit: 570 } });
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "What is the" } });
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: " status of the build?", from: 11 } });
    expect(heardText(state)).toBe("What is the status of the build?");
    // A correction: the node keeps less than it had and sends the rest again.
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "state of the build?", from: 12 } });
    expect(heardText(state)).toBe("What is the state of the build?");
    const items = () => selectStream(state).items;
    expect(items().map((i) => i.kind)).toEqual(["thread", "message", "heard"]);
    expect(keyOf(items().at(-1)!)).toBe("heard");
    // Transcribing, the words stay; the last partial names the message, and the message ends it.
    apply(state, { type: "voice.state", params: { state: "transcribing", client: CLIENT.id } });
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "", from: 31, message: "msg_2" } });
    expect(heardText(state)).toBe("What is the state of the build?");
    apply(state, { type: "chat.message", params: { message: message("msg_2", "thr_1", 200, "user", "What is the state of the build?", { source: "voice" }) } });
    expect(state.heard).toBeUndefined();
    expect(items().map((i) => i.kind)).toEqual(["thread", "message", "message"]);
    // The message first, then the partial that names it: nothing comes back.
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "Next one" } });
    apply(state, { type: "chat.message", params: { message: message("msg_3", "thr_1", 300, "user", "Next one.", { source: "voice" }) } });
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "", from: 8, message: "msg_3" } });
    expect(state.heard).toBeUndefined();
  });

  test("the words heard go with an utterance taken back or come to nothing, with the line, and are never another client's", () => {
    const state = paired();
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "never mind" } });
    apply(state, { type: "voice.state", params: { state: "idle", client: CLIENT.id } });
    expect(state.heard).toBeUndefined();
    // A new utterance starts afresh, whatever an earlier one left.
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "left over" } });
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    expect(state.heard).toBeUndefined();
    apply(state, { type: "voice.partial", params: { client: "cli_phone", text: "the phone's" } });
    expect(state.heard).toBeUndefined();
    // Another's states leave this view's words alone.
    apply(state, { type: "voice.partial", params: { client: CLIENT.id, text: "mine" } });
    apply(state, { type: "voice.state", params: { state: "idle", client: "cli_phone" } });
    expect(heardText(state)).toBe("mine");
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.heard).toBeUndefined();
    // Nothing heard yet shows nothing.
    const quiet = paired();
    apply(quiet, { type: "voice.partial", params: { client: CLIENT.id, text: "  " } });
    expect(selectStream(quiet).items.map((i) => i.kind)).toEqual([]);
  });

  test("near its limit the voice row counts down the time left: the last 30 s of a long utterance, the last 10 s of a short one", () => {
    expect(countdownFrom(570)).toBe(30);
    expect(countdownFrom(120)).toBe(30);
    expect(countdownFrom(30)).toBe(10);
    const row = { state: "listening" as const, limit: 570, at: 0 };
    expect(timeLeft(row, 539_000)).toBeUndefined();
    expect(timeLeft(row, 540_000)).toBe("0:30");
    expect(timeLeft(row, 544_500)).toBe("0:26");
    expect(timeLeft(row, 600_000)).toBe("0:00");
    expect(timeLeft({ state: "listening", limit: 30, at: 0 }, 19_000)).toBeUndefined();
    expect(timeLeft({ state: "listening", limit: 30, at: 0 }, 20_000)).toBe("0:10");
    expect(timeLeft({ state: "transcribing", limit: 30, at: 0 }, 29_000)).toBeUndefined();
    expect(timeLeft({ state: "listening", at: 0 }, 1e9)).toBeUndefined();
    const state = paired(controller("ctl_1", "Pixel", { connected: true }));
    apply(state, { type: "voice.state", params: { state: "listening", client: "cli_1", limit: 570 } });
    const at = state.voice!.at;
    expect(voiceWords(state, at + 1000)).toBe("listening · Pixel");
    expect(voiceWords(state, at + 545_000)).toBe("listening · Pixel · 0:25 left");
    // The limit is the listening's alone.
    apply(state, { type: "voice.state", params: { state: "transcribing", client: "cli_1", limit: 570 } });
    expect(state.voice!.limit).toBeUndefined();
  });

  test("an utterance the node stopped hearing says so until this view's next one, beside the states between", () => {
    const state = paired();
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id, limit: 570 } });
    apply(state, { type: "voice.state", params: { state: "transcribing", client: CLIENT.id, stopped: "limit" } });
    expect(state.voiceNote).toMatchObject({ stopped: "limit", limit: 570 });
    expect(voiceWords(state)).toBe("transcribing · Stopped at the 9½-minute limit — what came after wasn't recorded");
    apply(state, { type: "voice.state", params: { state: "thinking", client: CLIENT.id } });
    apply(state, { type: "voice.state", params: { state: "speaking", client: CLIENT.id } });
    apply(state, { type: "voice.state", params: { state: "idle", client: CLIENT.id } });
    // A press's time running out is not a stop's.
    apply(state, { type: "voice.note.expired", at: Date.now() + 1e6 });
    expect(voiceWords(state)).toBe("Stopped at the 9½-minute limit — what came after wasn't recorded");
    expect(voiceDot(state)).toBe("trouble");
    // Another client's utterance leaves it; this view's next takes it away.
    apply(state, { type: "voice.state", params: { state: "listening", client: "cli_phone" } });
    expect(state.voiceNote).toBeDefined();
    apply(state, { type: "voice.state", params: { state: "listening", client: CLIENT.id } });
    expect(state.voiceNote).toBeUndefined();
    // The allowance used up.
    apply(state, { type: "voice.state", params: { state: "transcribing", client: CLIENT.id, stopped: "quota" } });
    apply(state, { type: "voice.state", params: { state: "idle", client: CLIENT.id } });
    expect(voiceWords(state)).toBe("Stopped: this month's transcription allowance is used up — what came after wasn't recorded");
  });

  test("a stop's words give the limit it came at", () => {
    expect(stoppedWords("limit", 570)).toBe("Stopped at the 9½-minute limit — what came after wasn't recorded");
    expect(stoppedWords("limit", 30)).toBe("Stopped at the 30-second limit — what came after wasn't recorded");
    expect(stoppedWords("limit", 600)).toBe("Stopped at the 10-minute limit — what came after wasn't recorded");
    expect(stoppedWords("limit")).toBe("Stopped at the limit — what came after wasn't recorded");
    expect(stoppedWords("quota", 570)).toBe("Stopped: this month's transcription allowance is used up — what came after wasn't recorded");
  });

  test("with two phones connected the state is shown without guessing whose it is", () => {
    const state = paired(controller("ctl_1", "Pixel", { connected: true }), controller("ctl_2", "iPad", { connected: true }));
    apply(state, { type: "voice.state", params: { state: "speaking", client: "cli_1" } });
    expect(namedController(state)).toBeUndefined();
    expect(voiceWords(state)).toBe("speaking");
  });

  test("an engine being set up takes the row, and stops when it is ready or failed", () => {
    const state = paired();
    apply(state, { type: "voice.setup", params: { stage: "tts", engine: "chatterbox", step: "deps", progress: 0.42 } });
    expect(voiceWords(state)).toBe("chatterbox: installing 42%");
    expect(voiceBusy(state)).toBe(true);
    apply(state, { type: "voice.setup", params: { stage: "tts", engine: "chatterbox", step: "weights" } });
    expect(voiceWords(state)).toBe("chatterbox: fetching the weights");
    apply(state, { type: "voice.setup", params: { stage: "tts", engine: "chatterbox", step: "ready" } });
    expect(state.setup).toBeUndefined();
    expect(voiceBusy(state)).toBe(false);
  });

  test("losing the node clears the conversation, the code and every phone's presence", () => {
    const state = paired(controller("ctl_1", "Pixel", { connected: true }));
    apply(state, { type: "voice.state", params: { state: "speaking", client: "cli_1" } });
    apply(state, { type: "pairing", offer: { code: "482913", url: "https://192.168.1.44:4818/?code=482913", expiresAt: 9e12 } });
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.voice).toBeUndefined();
    expect(state.pairing).toBeUndefined();
    // The phones are still paired; they are simply not here.
    expect(state.controllers.get("ctl_1")).toMatchObject({ name: "Pixel", connected: false });
  });

  test("the code is shown in two groups and counts down, then says it has run out", () => {
    const offer = { code: "482913", url: "https://192.168.1.44:4818/?code=482913", expiresAt: 300_000 };
    expect(pairingWords(offer, 0)).toEqual({ code: "482 913", left: "5:00", expired: false });
    expect(pairingWords(offer, 28_000)).toMatchObject({ left: "4:32" });
    expect(pairingWords(offer, 299_000)).toMatchObject({ left: "0:01", expired: false });
    expect(pairingWords(offer, 300_000)).toMatchObject({ left: "0:00", expired: true });
    expect(pairingWords(offer, 400_000).expired).toBe(true);
  });

  test("the list replaces what was there, connected phones first, and a revoke shows at once", () => {
    const state = paired(controller("ctl_1", "Pixel", { pairedAt: 1000 }), controller("ctl_2", "iPad", { pairedAt: 2000, connected: true }));
    expect(selectControllers(state).map((c) => c.name)).toEqual(["iPad", "Pixel"]);
    apply(state, { type: "controller.removed", id: "ctl_2" });
    expect(selectControllers(state).map((c) => c.name)).toEqual(["Pixel"]);
    // The platform's next list is the truth, whatever the view showed.
    apply(state, { type: "controllers", controllers: [controller("ctl_3", "Phone", { connected: true })] });
    expect(selectControllers(state).map((c) => c.name)).toEqual(["Phone"]);
  });

  test("a phone's second line says whether it is here and when it last was", () => {
    const now = 10 * 3600_000;
    expect(controllerWords(controller("ctl_1", "Pixel", { connected: true }), now)).toBe("connected");
    expect(controllerWords(controller("ctl_1", "Pixel"), now)).toBe("never connected");
    expect(controllerWords(controller("ctl_1", "Pixel", { lastSeen: now - 30_000 }), now)).toBe("last seen just now");
    expect(controllerWords(controller("ctl_1", "Pixel", { lastSeen: now - 5 * 60_000 }), now)).toBe("last seen 5m ago");
    expect(controllerWords(controller("ctl_1", "Pixel", { lastSeen: now - 3 * 3600_000 }), now)).toBe("last seen 3h ago");
    // what it can do from elsewhere, and how it was paired when the account did it
    expect(controllerWords(controller("ctl_1", "Pixel", { connected: true, relay: true, push: { platform: "android", registeredAt: 1 } }), now)).toBe("connected · relay · push (android)");
    expect(controllerWords(controller("ctl_1", "Pixel", { connected: true, relay: true, account: "octocat" }), now)).toBe("connected · relay · paired through octocat");
  });
});

describe("default view: nodes and metrics", () => {
  const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const PROFILE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
  const PROFILE_B = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB9";
  const node = (id: string, name: string, over: Partial<Node> = {}): Node => ({
    id,
    name,
    role: id === NODE ? "primary" : "secondary",
    status: "online",
    via: "direct",
    platform: "windows",
    scope: { kind: "machine" },
    capabilities: { brain: id === NODE, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false },
    versions: { platform: "0.3.0", protocol: 1 },
    lastSeen: 1000,
    ...over,
  });
  const GB = 1024 ** 3;
  const sample = (at: number, over: Partial<MetricsSample> = {}): MetricsSample => ({
    node: NODE,
    at,
    cpu: 23.4,
    memory: { used: 17.2 * GB, total: 64 * GB },
    gpu: [{ name: "RTX 5080", util: 12, vramUsed: 3 * GB, vramTotal: 16 * GB }],
    processes: [
      { pid: 20, parent: 10, name: "bun", cpu: 1.5, memory: 200 * 1024 ** 2, owner: { kind: "platform" } },
      { pid: 21, parent: 20, name: "bun", cpu: 0.5, memory: 100 * 1024 ** 2, owner: { kind: "brain" } },
      { pid: 30, parent: 10, name: "claude", cpu: 4, memory: 300 * 1024 ** 2, owner: { kind: "session", session: "sess_a" } },
      { pid: 31, parent: 30, name: "sh", cpu: 6, memory: 50 * 1024 ** 2, owner: { kind: "session", session: "sess_a" } },
      { pid: 22, parent: 20, name: "python", cpu: 0.2, memory: 400 * 1024 ** 2, owner: { kind: "sidecar", name: "tts-py" } },
      { pid: 50, parent: 1, name: "chrome", cpu: 9, memory: 900 * 1024 ** 2, owner: { kind: "other" } },
    ],
    llm: {},
    profiles: { [PROFILE]: { in: 1000, out: 200, cached: 50, cost: 0.02 } },
    ...over,
  });

  function withNodes(): ViewState {
    const state = initialState();
    apply(state, { type: "host.ready", params: { ...READY, scopes: [...CLIENT.scopes, "nodes", "metrics:read"] as Scope[] } });
    apply(state, { type: "host.state", params: { connected: true } });
    apply(state, { type: "nodes", nodes: [node(OTHER, "laptop", { backup: true }), node(NODE, "desk")] });
    apply(state, { type: "session.state", params: session("sess_a", 1, { intent: "fix the tests" }) });
    return state;
  }

  test("Restart is offered on this node's card, from the desktop app alone, and a refusal says what it would cut off", () => {
    const state = withNodes();
    expect(restartable(state, node(NODE, "desk"))).toBe(true);
    expect(restartable(state, node(OTHER, "laptop"))).toBe(false);
    // A phone's host does not know the request.
    const phone = initialState();
    apply(phone, { type: "host.ready", params: { ...READY, client: { ...CLIENT, kind: "controller" }, scopes: [...CLIENT.scopes, "nodes"] as Scope[] } });
    expect(restartable(phone, node(NODE, "desk"))).toBe(false);
    // Without the nodes scope, no restart either.
    expect(restartable(ready(), node(NODE, "desk"))).toBe(false);
    expect(restartWords(["1 open ask"])).toBe("Busy: 1 open ask. Restarting now cuts it off.");
    expect(restartWords(["1 open ask", "2 held hook responses"])).toBe("Busy: 1 open ask, 2 held hook responses. Restarting now cuts them off.");
  });

  test("the rail's dot is green while connected, with the node's name and platform, a ring while not, and absent on a phone", () => {
    const state = withNodes();
    expect(linkWords(state)).toEqual({ status: "connected", title: "Connected to cophylad — desk · platform 0.1.0" });
    // Before the registry names the node, its id stands in.
    expect(linkWords(ready())?.title).toBe(`Connected to cophylad — ${NODE} · platform 0.1.0`);
    apply(state, { type: "host.state", params: { connected: false } });
    expect(linkWords(state)).toEqual({ status: "gone", title: "Not connected to cophylad" });
    expect(linkWords(initialState())?.status).toBe("gone");
    // The phone's chrome shows the line itself.
    expect(linkWords(ready({ kind: "controller" }))).toBeUndefined();
  });

  test("node.list fills the cards, this node first; node.state upserts; a card without a sample shows dashes", () => {
    const state = withNodes();
    let cards = selectNodes(state);
    expect(cards.map((c) => c.node.name)).toEqual(["desk", "laptop"]);
    expect(cards[0]!.sub).toBe("primary");
    expect(cards[1]!.sub).toBe("secondary · backup");
    expect(cards[0]!.bars.map((b) => b.words)).toEqual(["—", "—"]);
    apply(state, { type: "node.state", params: node(OTHER, "laptop", { backup: true, status: "offline" }) });
    cards = selectNodes(state);
    expect(cards[1]!.sub).toBe("secondary · backup · offline");
    expect(cards[1]!.node.status).toBe("offline");
  });

  test("a sample makes the bars and sums the processes by owner, sessions named as their tabs, busiest first", () => {
    const state = withNodes();
    apply(state, { type: "metrics.sample", params: sample(5000) });
    const card = selectNodes(state)[0]!;
    expect(card.bars.map((b) => [b.label, b.words])).toEqual([
      ["cpu", "23%"],
      ["memory", "17.2/64.0 GB"],
      ["RTX 5080", "12% · 3.0/16.0 GB"],
    ]);
    expect(card.bars.map((b) => Math.round(b.percent!))).toEqual([23, 27, 12]);
    expect(card.owners.map((o) => [o.label, o.kind, o.cpu])).toEqual([
      ["fix the tests", "session", 10],
      ["everything else", "other", 9],
      ["cophylad", "platform", 1.5],
      ["brain", "brain", 0.5],
      ["tts-py", "sidecar", 0.2],
    ]);
    expect(card.owners[0]!.memory).toBe(350 * 1024 ** 2);
    // A session the view has no card for is named by a short form of its id.
    apply(state, { type: "metrics.sample", params: sample(6000, { processes: [{ pid: 40, parent: 1, name: "claude", cpu: 1, memory: 1, owner: { kind: "session", session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB0" } }] }) });
    expect(selectNodes(state)[0]!.owners[0]!.label).toBe("01ARZ3");
  });

  test("an older sample never replaces a newer one; a disconnect drops the readings and keeps the spend", () => {
    const state = withNodes();
    apply(state, { type: "metrics.sample", params: sample(5000, { cpu: 50 }) });
    apply(state, { type: "metrics.sample", params: sample(4000, { cpu: 10 }) });
    expect(state.metrics.get(NODE)!.cpu).toBe(50);
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.metrics.size).toBe(0);
    expect(selectNodes(state)[0]!.bars[0]!.words).toBe("—");
    expect(selectSpend(state)[0]!.spend.in).toBe(1000);
  });

  test("spend: the node's totals are the base; samples that land before them are held and counted once after, those the totals hold skipped", () => {
    const state = withNodes();
    apply(state, { type: "profiles", profiles: [{ id: PROFILE, harness: "claude", name: "main", node: NODE, status: "ready" } as never] });
    apply(state, { type: "spend.loading", node: NODE });
    // The sample sent at once on subscribing and the one after it both land before the totals:
    // the card reads them, and the spend waits.
    apply(state, { type: "metrics.sample", params: sample(2000) });
    apply(state, { type: "metrics.sample", params: sample(3000, { profiles: { [PROFILE_B]: { in: 10, out: 5, cached: 0 } } }) });
    expect(state.metrics.get(NODE)!.at).toBe(3000);
    expect(selectSpend(state)).toEqual([]);
    // The totals reach the sample at 2000, which is theirs; the one at 3000 is counted on top, once.
    apply(state, { type: "metrics.spend", node: NODE, totals: { at: 2000, profiles: { [PROFILE]: { in: 5000, out: 1000, cached: 250, cost: 0.5 } } } });
    expect(state.spend.get(NODE)!.held).toBeUndefined();
    expect(selectSpend(state).map((r) => [r.name, r.spend])).toEqual([
      ["main", { in: 5000, out: 1000, cached: 250, cost: 0.5 }],
      ["01ARZ3", { in: 10, out: 5, cached: 0, cost: 0 }],
    ]);
    // After the base each sample adds once: a replayed frame does not count again.
    apply(state, { type: "metrics.sample", params: sample(4000) });
    apply(state, { type: "metrics.sample", params: sample(4000) });
    expect(selectSpend(state)[0]!.spend).toEqual({ in: 6000, out: 1200, cached: 300, cost: 0.52 });
    // Another node's sessions add to the same profiles; a total without a cost counts none.
    apply(state, { type: "spend.loading", node: OTHER });
    apply(state, { type: "metrics.spend", node: OTHER, totals: { at: 3000, profiles: { [PROFILE]: { in: 1000, out: 0, cached: 0 } } } });
    const rows = selectSpend(state);
    expect(rows[0]!.spend).toEqual({ in: 7000, out: 1200, cached: 300, cost: 0.52 });
  });

  test("limits: each login's session and weekly share comes from its node's latest sample, with a row even with nothing spent", () => {
    const state = withNodes();
    apply(state, { type: "profiles", profiles: [{ id: PROFILE, harness: "claude", name: "main", node: NODE, status: "ready" } as never, { id: PROFILE_B, harness: "codex", name: "codex", node: NODE, status: "ready" } as never] });
    const H = 3_600_000;
    apply(state, {
      type: "metrics.sample",
      params: sample(2000, {
        limits: {
          [PROFILE]: { at: 1900, session: { percent: 4.4, resetsAt: 2000 + 2 * H + 40 * 60_000 }, weekly: { percent: 82, resetsAt: 2000 + 76 * H } },
          [PROFILE_B]: { at: 1500, weekly: { percent: 1 } },
        },
      }),
    });
    let rows = selectSpend(state);
    // The costliest first; the Codex login has spent nothing today and still has its row.
    expect(rows.map((r) => [r.name, limitWords(r.limits?.session), limitWords(r.limits?.weekly), r.spend.cost])).toEqual([
      ["main", "4%", "82%", 0.02],
      ["codex", "—", "1%", 0],
    ]);
    expect([limitLevel(rows[0]!.limits?.session), limitLevel(rows[0]!.limits?.weekly), limitLevel(rows[1]!.limits?.session), limitLevel({ percent: 95 })]).toEqual(["normal", "warn", "none", "critical"]);
    expect(spendTitle(rows[0]!, 2000)).toBe("main\nSession limit: 4% used, starts over in 2 h 40 min\nWeekly limit: 82% used, starts over in 3 d 4 h\nToday: $0.02, 1.0k in, 200 out, 50 cached");
    expect(spendTitle(rows[1]!, 2000)).toBe("codex\nSession limit: not known\nWeekly limit: 1% used\nToday: $0, 0 in, 0 out, 0 cached");
    // The next sample's limits replace the last: one the node no longer reads, with nothing spent, has no row.
    apply(state, { type: "metrics.sample", params: sample(3000, { limits: { [PROFILE]: { at: 2900, session: { percent: 5 } } } }) });
    rows = selectSpend(state);
    expect(rows.map((r) => [r.name, limitWords(r.limits?.session), limitWords(r.limits?.weekly)])).toEqual([["main", "5%", "—"]]);
  });

  test("a span until a limit starts over, in words", () => {
    expect(durationWords(10_000)).toBe("1 min");
    expect(durationWords(12 * 60_000)).toBe("12 min");
    expect(durationWords(2 * 3_600_000)).toBe("2 h");
    expect(durationWords(2 * 3_600_000 + 40 * 60_000)).toBe("2 h 40 min");
    expect(durationWords(24 * 3_600_000)).toBe("1 d");
    expect(durationWords(76 * 3_600_000)).toBe("3 d 4 h");
  });

  test("spend: after a reconnect the panel shows what it did until the new totals replace it, the samples meanwhile counted once", () => {
    const state = withNodes();
    apply(state, { type: "spend.loading", node: NODE });
    apply(state, { type: "metrics.spend", node: NODE, totals: { at: 2000, profiles: { [PROFILE]: { in: 5000, out: 1000, cached: 0, cost: 0.5 } } } });
    apply(state, { type: "host.state", params: { connected: false } });
    expect(selectSpend(state)[0]!.spend.in).toBe(5000);
    apply(state, { type: "host.state", params: { connected: true } });
    apply(state, { type: "spend.loading", node: NODE });
    apply(state, { type: "metrics.sample", params: sample(9000) });
    // Nothing flashes empty and nothing is counted on the old base.
    expect(selectSpend(state)[0]!.spend.in).toBe(5000);
    apply(state, { type: "metrics.spend", node: NODE, totals: { at: 10_000, profiles: { [PROFILE]: { in: 8000, out: 1600, cached: 0, cost: 0.75 } } } });
    expect(selectSpend(state)[0]!.spend.in).toBe(8000);
    // A sample the totals already reach counts nothing when it lands after them; the next one counts.
    apply(state, { type: "metrics.sample", params: sample(10_000) });
    expect(state.metrics.get(NODE)!.at).toBe(10_000);
    expect(selectSpend(state)[0]!.spend.in).toBe(8000);
    apply(state, { type: "metrics.sample", params: sample(11_000) });
    expect(selectSpend(state)[0]!.spend).toEqual({ in: 9000, out: 1800, cached: 50, cost: 0.77 });
  });

  test("spend: totals that could not be had let the held samples count on from what is shown", () => {
    const state = withNodes();
    apply(state, { type: "spend.loading", node: NODE });
    apply(state, { type: "metrics.sample", params: sample(2000) });
    apply(state, { type: "metrics.spend", node: NODE });
    expect(state.spend.get(NODE)!.held).toBeUndefined();
    expect(selectSpend(state)[0]!.spend.in).toBe(1000);
    apply(state, { type: "metrics.sample", params: sample(3000) });
    expect(selectSpend(state)[0]!.spend.in).toBe(2000);
  });

  test("bytes, percentages, costs and counts in words", () => {
    expect(bytesWords(512)).toBe("512 B");
    expect(bytesWords(3 * 1024)).toBe("3 KB");
    expect(bytesWords(200 * 1024 ** 2)).toBe("200 MB");
    expect(bytesWords(17.25 * 1024 ** 3)).toBe("17.3 GB");
    expect(percentWords(0)).toBe("0%");
    expect(percentWords(1.234)).toBe("1.2%");
    expect(percentWords(23.6)).toBe("24%");
    expect(costWords(0)).toBe("$0");
    expect(costWords(0.004)).toBe("<$0.01");
    expect(costWords(12.3)).toBe("$12.30");
    expect(countWords(999)).toBe("999");
    expect(countWords(1234)).toBe("1.2k");
    expect(countWords(34_567)).toBe("35k");
    expect(countWords(1_500_000)).toBe("1.5M");
  });
});

describe("default view: remote desktop", () => {
  const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const node = (id: string, name: string, over: Partial<Node> = {}): Node => ({
    id,
    name,
    role: id === NODE ? "primary" : "secondary",
    status: "online",
    via: "direct",
    platform: "windows",
    scope: { kind: "machine" },
    capabilities: { brain: id === NODE, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: true },
    versions: { platform: "0.4.0", protocol: 1 },
    lastSeen: 1000,
    ...over,
  });
  const remote = (id: string, over: Partial<RemoteState> = {}): RemoteState => ({ node: id, host: { kind: "apollo", status: "ready" }, viewers: [], streaming: false, ...over });

  /** A client on the desk node (the desktop app), or a phone, with both nodes known. */
  function viewing(client: Partial<Client> = { node: NODE }): ViewState {
    const state = initialState();
    apply(state, { type: "host.ready", params: { ...READY, client: { ...CLIENT, ...client }, scopes: [...CLIENT.scopes, "nodes", "metrics:read", "remote"] as Scope[] } });
    apply(state, { type: "host.state", params: { connected: true } });
    apply(state, { type: "nodes", nodes: [node(NODE, "desk"), node(OTHER, "laptop")] });
    return state;
  }

  test("remote.state keeps the latest per node; the desktop app connects to the other node, never its own", () => {
    const state = viewing();
    apply(state, { type: "remote.state", params: remote(NODE, { host: { kind: "apollo", status: "starting", step: "configuring" } }) });
    apply(state, { type: "remote.state", params: remote(NODE) });
    apply(state, { type: "remote.state", params: remote(OTHER) });
    expect(state.remote.size).toBe(2);
    const own = selectRemote(state, state.nodes.get(NODE)!)!;
    const other = selectRemote(state, state.nodes.get(OTHER)!)!;
    expect(own).toMatchObject({ words: "ready", connect: false, pair: true, invite: true });
    expect(other).toMatchObject({ words: "ready", connect: true, pair: true, invite: true });
  });

  test("a phone connects to every node, its own included; a browser ui with no node of its own connects to none", () => {
    const phone = viewing({ kind: "controller" });
    for (const id of [NODE, OTHER]) apply(phone, { type: "remote.state", params: remote(id) });
    expect([NODE, OTHER].map((id) => selectRemote(phone, phone.nodes.get(id)!)!.connect)).toEqual([true, true]);
    const browser = viewing({});
    apply(browser, { type: "remote.state", params: remote(OTHER) });
    expect(selectRemote(browser, browser.nodes.get(OTHER)!)!.connect).toBe(false);
  });

  test("no block without the scope, for an offline node, or a host that is off; only a ready host offers anything, and codes only Apollo's", () => {
    const state = viewing();
    apply(state, { type: "remote.state", params: remote(OTHER, { host: { kind: "none", status: "off" } }) });
    expect(selectRemote(state, state.nodes.get(OTHER)!)).toBeUndefined();
    expect(selectRemote(state, state.nodes.get(NODE)!)).toBeUndefined();
    apply(state, { type: "remote.state", params: remote(OTHER, { host: { kind: "sunshine", status: "ready" } }) });
    expect(selectRemote(state, state.nodes.get(OTHER)!)).toMatchObject({ connect: true, pair: true, invite: false });
    apply(state, { type: "remote.state", params: remote(OTHER, { host: { kind: "apollo", status: "unavailable", reason: "the service is stopped" } }) });
    expect(selectRemote(state, state.nodes.get(OTHER)!)).toMatchObject({ words: "unavailable: the service is stopped", connect: false, pair: false, invite: false });
    apply(state, { type: "node.state", params: node(OTHER, "laptop", { status: "offline" }) });
    expect(selectRemote(state, state.nodes.get(OTHER)!)).toBeUndefined();
    const narrow = viewing();
    narrow.scopes = narrow.scopes.filter((s) => s !== "remote");
    apply(narrow, { type: "remote.state", params: remote(OTHER) });
    expect(selectRemote(narrow, narrow.nodes.get(OTHER)!)).toBeUndefined();
  });

  test("the host's state in words", () => {
    expect(remoteWords({ kind: "apollo", status: "installing", step: "installing apollo", progress: 0.3 }, false)).toBe("installing apollo 30%");
    expect(remoteWords({ kind: "apollo", status: "starting" }, false)).toBe("starting");
    expect(remoteWords({ kind: "apollo", status: "starting", step: "waiting for the host" }, false)).toBe("waiting for the host");
    expect(remoteWords({ kind: "apollo", status: "ready" }, true)).toBe("being viewed");
    expect(remoteWords({ kind: "apollo", status: "unavailable" }, false)).toBe("unavailable");
  });

  test("Connect's refusals in words to act on", () => {
    expect(connectWords("unsupported", "remote.open is not served over the relay")).toContain("from anywhere once Direct connections is on");
    expect(connectWords("unavailable", "the host has no direct connections")).toBe("the host has no direct connections: turn Direct connections on in the host's account card");
    expect(connectWords("unsupported", "this host has no host.open")).toBe("this app cannot show a desktop it has no route to: update the app");
    expect(connectWords("unsupported", "this node serves no web viewer: [remote] web is off")).toBe("this node serves no web viewer: [remote] web is off");
    expect(connectWords(undefined, "timed out")).toBe("timed out");
  });

  test("viewers: watching first, then the newest; each says what it is and since when", () => {
    const now = 10 * 3600_000;
    const state = viewing();
    const viewers = [
      { id: "v-old", name: "tablet", kind: "native" as const, since: now - 3 * 3600_000 },
      { id: "v-new", name: "laptop", kind: "native" as const, since: now - 60_000 },
      { id: "web_1", name: "Pixel", kind: "web" as const, since: now - 30_000, connected: true },
    ];
    apply(state, { type: "remote.state", params: remote(OTHER, { viewers, streaming: true }) });
    const card = selectRemote(state, state.nodes.get(OTHER)!)!;
    expect(card.viewers.map((v) => v.id)).toEqual(["web_1", "v-new", "v-old"]);
    expect(card.viewers.map((v) => viewerWords(v, now))).toEqual(["watching in a browser", "paired 1m ago", "paired 3h ago"]);
    expect(viewerWords({ id: "web_2", kind: "web", since: now - 5 * 60_000 }, now)).toBe("browser, opened 5m ago");
    expect(viewerWords({ id: "x", kind: "native", since: now, connected: true }, now)).toBe("watching");
  });

  test("the PIN form and the phone code open on one node; a host that stops serving and a disconnect close them", () => {
    const state = viewing();
    apply(state, { type: "remote.state", params: remote(OTHER) });
    apply(state, { type: "remote.pin", node: OTHER });
    apply(state, { type: "remote.invite", invite: { node: OTHER, otp: "4829", passphrase: "cophyla-a1b2c3", link: "art://192.168.1.44:47989?pin=4829", expiresAt: 180_000 } });
    expect(state.remotePin).toBe(OTHER);
    expect(inviteWords(state.remoteInvite!, 0)).toEqual({ code: "4829", passphrase: "cophyla-a1b2c3", left: "3:00", expired: false });
    expect(inviteWords(state.remoteInvite!, 200_000)).toMatchObject({ left: "0:00", expired: true });
    expect(inviteWords({ node: OTHER, otp: "1111" }, 0)).toEqual({ code: "1111", passphrase: "", left: "", expired: false });
    // Another node's state leaves them be; this node's host going away closes them.
    apply(state, { type: "remote.state", params: remote(NODE, { host: { kind: "apollo", status: "unavailable" } }) });
    expect(state.remotePin).toBe(OTHER);
    apply(state, { type: "remote.state", params: remote(OTHER, { host: { kind: "apollo", status: "starting" } }) });
    expect(state.remotePin).toBeUndefined();
    expect(state.remoteInvite).toBeUndefined();
    // Closed by hand, and on a disconnect with every host's state.
    apply(state, { type: "remote.pin", node: NODE });
    apply(state, { type: "remote.pin" });
    expect(state.remotePin).toBeUndefined();
    apply(state, { type: "remote.pin", node: NODE });
    apply(state, { type: "remote.invite", invite: { node: NODE, otp: "1234" } });
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.remote.size).toBe(0);
    expect(state.remotePin).toBeUndefined();
    expect(state.remoteInvite).toBeUndefined();
  });
});

describe("the account card", () => {
  const FREE = { plan: "free", limits: { sessions: 2, nodes: 0, memoryTier: "recent", planning: [], hosted: { llm: false, voice: false }, brainChannel: "stable" } };
  const PRO = { plan: "pro", limits: { sessions: 8, nodes: 5, memoryTier: "full", planning: [], hosted: { llm: true, voice: true }, brainChannel: "beta" }, subject: "usr_1", connected: true, usage: { period: "2026-09", metrics: { llm_tokens_in: { used: 12_500, cap: 2_000_000 }, llm_tokens_out: { used: 0, cap: 500_000 }, stt_seconds: { used: 590, cap: 600 }, tts_chars: { used: 0, cap: 0 } } } };

  test("signed out until the node says otherwise; the free state without a subject is signed out too", () => {
    const state = initialState();
    expect(selectAccount(state)).toMatchObject({ kind: "out", title: "Not signed in", bars: [] });
    apply(state, { type: "account.state", params: FREE });
    expect(selectAccount(state).kind).toBe("out");
  });

  test("a login shows its code and address until the plan arrives with a subject, or the panel closes", () => {
    const state = initialState();
    apply(state, { type: "login", offer: { userCode: "BCDF-GHJK", verificationUrl: "https://orc.example/login?code=BCDF-GHJK", expiresAt: 900_000 } });
    expect(selectAccount(state).kind).toBe("login");
    expect(loginWords(state.login!, 0)).toEqual({ code: "BCDF-GHJK", left: "15:00", expired: false });
    expect(loginWords(state.login!, 900_000)).toMatchObject({ left: "0:00", expired: true });
    apply(state, { type: "account.state", params: FREE });
    expect(state.login).toBeDefined();
    apply(state, { type: "account.state", params: PRO });
    expect(state.login).toBeUndefined();
    apply(state, { type: "login", offer: { userCode: "AAAA-BBBB", verificationUrl: "https://orc.example/login?code=AAAA-BBBB", expiresAt: 1 } });
    apply(state, { type: "login" });
    expect(state.login).toBeUndefined();
  });

  test("signed in: the subject, the plan line, the link and a bar per metric with a cap", () => {
    const state = initialState();
    apply(state, { type: "account.state", params: PRO });
    const card = selectAccount(state);
    expect(card).toMatchObject({ kind: "in", title: "usr_1", sub: "pro · hosted model, hosted voice · 8 agents · memory full", connected: true });
    expect(card.bars).toEqual([
      { label: "tokens in", percent: 1, words: "12.5k / 2M" },
      { label: "tokens out", percent: 0, words: "0 / 500k" },
      { label: "speech in", percent: 98, words: "590 / 600" },
    ]);
    apply(state, { type: "account.state", params: { ...PRO, connected: false, usage: undefined } });
    expect(selectAccount(state)).toMatchObject({ kind: "in", connected: false, bars: [] });
    // a forged or stale row: the node says free, with the subject still named
    apply(state, { type: "account.state", params: { ...FREE, subject: "usr_1", connected: true } });
    expect(selectAccount(state)).toMatchObject({ kind: "in", title: "usr_1", sub: "free · 2 agents · memory recent" });
  });

  test("the backup row: absent until the node reports one; the plan without it; off; a backup to restore; on in each of its states; restoring", () => {
    const NOW = Date.UTC(2026, 8, 22, 12);
    const withBackup = { ...PRO, limits: { ...PRO.limits, hosted: { ...PRO.limits.hosted, backup: true }, backupBytes: 268435456 } };
    const state = initialState();
    apply(state, { type: "account.state", params: PRO });
    expect(selectAccount(state, NOW).backup).toBeUndefined();
    // the plan has no backup: said so, nothing offered
    apply(state, { type: "account.state", params: { ...PRO, backup: { enabled: false, state: "idle" } } });
    expect(selectAccount(state, NOW).backup).toEqual({ kind: "plan", words: "Not on this plan.", canReplace: false });
    // off, nothing on the server
    apply(state, { type: "account.state", params: { ...withBackup, backup: { enabled: false, state: "idle" } } });
    expect(selectAccount(state, NOW).backup).toMatchObject({ kind: "off", canReplace: false });
    // a fresh install: the server holds a backup, said with its date, count and size
    const remote = { objects: 412, bytes: 1834902, updatedAt: NOW - 86400_000, node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV" };
    apply(state, { type: "account.state", params: { ...withBackup, backup: { enabled: false, state: "idle", remote } } });
    const available = selectAccount(state, NOW).backup!;
    expect(available.kind).toBe("available");
    expect(available.canReplace).toBe(true);
    expect(available.remote).toBe(`a backup from ${new Date(remote.updatedAt).toLocaleDateString()}, 412 items, 2 MB`);
    expect(available.words).toBe(`The server holds ${available.remote}.`);
    // on: synced, syncing, paused, conflict, full
    const on = (backup: object) => selectBackup({ ...withBackup, backup } as never, NOW)!;
    expect(on({ enabled: true, keyId: "k", state: "idle", bytes: 1834902, lastSyncAt: NOW - 200_000 })).toMatchObject({ kind: "on", state: "idle", words: "Synced, 2 MB, 3 min ago", canReplace: true });
    expect(on({ enabled: true, keyId: "k", state: "syncing", pending: 12 })).toMatchObject({ kind: "on", state: "syncing", words: "Syncing, 12 to go" });
    expect(on({ enabled: true, keyId: "k", state: "paused", error: "the server link is down" })).toMatchObject({ kind: "on", state: "paused", words: "Paused: the server link is down" });
    expect(on({ enabled: true, keyId: "k", state: "conflict" })).toMatchObject({ kind: "on", state: "conflict", words: "Another computer keeps the backup now." });
    expect(on({ enabled: true, keyId: "k", state: "full" })).toMatchObject({ kind: "on", state: "full", words: "The plan's backup space is full." });
    // restoring: the progress, whatever the plan says now
    expect(on({ enabled: false, state: "restoring", progress: { done: 103, total: 412 } })).toEqual({ kind: "restoring", words: "Restoring, 103 of 412", state: "restoring", canReplace: false, progress: 25 });
    expect(on({ enabled: false, state: "restoring" })).toMatchObject({ kind: "restoring", words: "Restoring…", progress: 0 });
    // the new metrics have labels
    apply(state, { type: "account.state", params: { ...withBackup, usage: { period: "2026-09", metrics: { embed_tokens: { used: 48211, cap: 10_000_000 }, backup_bytes: { used: 1834902, cap: 268435456 } } } } });
    expect(selectAccount(state, NOW).bars.map((b) => b.label)).toEqual(["embeddings", "backup"]);
    expect(agoWords(NOW - 10_000, NOW)).toBe("just now");
    expect(agoWords(NOW - 2 * 3600_000, NOW)).toBe("2 h ago");
    expect(agoWords(NOW - 3 * 86400_000, NOW)).toBe("3 d ago");
  });

  test("the direct row: absent signed out; the plan without it; a line per node, this one first, named only when several; each state in words", () => {
    const withDirect = { ...PRO, limits: { ...PRO.limits, hosted: { ...PRO.limits.hosted, direct: true } } };
    const state = initialState();
    state.node = NODE;
    expect(selectDirect(state)).toBeUndefined();
    apply(state, { type: "account.state", params: PRO });
    expect(selectAccount(state).direct).toEqual({ kind: "plan", words: "Not on this plan.", lines: [] });
    apply(state, { type: "account.state", params: withDirect });
    expect(selectDirect(state)).toMatchObject({ kind: "nodes", lines: [] });
    apply(state, { type: "direct.state", params: { node: NODE, state: "off", peers: [] } });
    expect(selectDirect(state)!.lines).toEqual([{ node: NODE, name: NODE, on: false, state: "off", words: "Off: away from home, phones and other computers go through the relay." }]);
    const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    apply(state, { type: "node.state", params: { id: OTHER, name: "attic", role: "secondary", status: "online", via: "relay" } as never });
    state.controllers.set("controller_1", { id: "controller_1", name: "Pixel", pairedAt: 1, connected: true } as never);
    apply(state, {
      type: "direct.state",
      params: {
        node: OTHER,
        state: "ready",
        port: 50000,
        mapping: { status: "mapped", protocols: ["upnp", "nat-pmp"] },
        peers: [
          { kind: "controller", id: "controller_1", path: "srflx", rttMs: 14.4, since: 1 },
          { kind: "node", id: NODE, path: "relay", since: 2 },
        ],
      },
    });
    const lines = selectDirect(state)!.lines;
    expect(lines.map((l) => l.node)).toEqual([NODE, OTHER]);
    expect(lines[1]).toMatchObject({ name: "attic", on: true, state: "ready", words: `On · the router maps its port (UPnP, NAT-PMP) · Pixel direct, 14 ms · a computer through TURN` });
    const words = (s: object) => directWords({ node: OTHER, peers: [], ...s } as never, state);
    expect(words({ state: "starting" })).toBe("Starting…");
    expect(words({ state: "starting", reason: "the helper exited (1); starting it again" })).toBe("Starting: the helper exited (1); starting it again");
    expect(words({ state: "unavailable", reason: "the plan has no direct connections" })).toBe("Unavailable: the plan has no direct connections");
    expect(words({ state: "ready", mapping: { status: "probing" } })).toBe("On · asking the router for a port");
    // a disconnect forgets them until the next hello
    apply(state, { type: "host.state", params: { connected: false } } as never);
    expect(state.direct.size).toBe(0);
  });
});

describe("default view: terminals", () => {
  const HOST = "a1b2c3d4e5f60718";
  const term = (id: string, startedAt: number, extra: Partial<Terminal> = {}): Terminal => ({ id, node: NODE, host: HOST, argv0: "pwsh.exe", cwd: "C:\\src\\app", cols: 120, rows: 32, status: "running", windows: 0, startedAt, ...extra });
  const withTerminals = () => ready({ scopes: [...CLIENT.scopes, "terminal"] });
  const scoped = (s: ViewState) => {
    s.scopes = [...s.scopes, "terminal"];
    return s;
  };

  test("the bare terminals get tabs, newest first; one that ended drops out unless it is shown", () => {
    const s = scoped(withTerminals());
    apply(s, { type: "session.state", params: session("sess_a", 100, { native: { id: "n", transport: "pipe", terminal: { host: HOST, id: "t-claude" } } }) });
    apply(s, { type: "terminals", terminals: [term("t-old", 1), term("t-claude", 2, { session: "sess_a", argv0: "claude.exe" }), term("t-new", 3, { name: "build" })] });
    expect(selectTerminalTabs(s).map((t) => t.id)).toEqual(["t-new", "t-old"]);
    expect(terminalLabel(s.terminals.get("t-new")!)).toBe("build");
    // One showing Claude's agents screen says so, over the title its program set; a name still wins.
    expect(terminalLabel(term("t-agents", 5, { agents: "claude", title: "claude agents" }))).toBe("Claude agents");
    expect(terminalLabel(term("t-agents", 5, { agents: "claude", name: "jobs" }))).toBe("jobs");
    // Its mark: the agents screen's harness, a CLI no session stands for yet, or a prompt.
    expect(terminalMark(term("t-agents", 5, { agents: "claude" }))).toEqual({ harness: "claude", kind: "claude agents" });
    expect(terminalMark(term("t-codex", 6, { harness: "codex", title: "app" }))).toEqual({ harness: "codex", kind: "codex in a terminal" });
    expect(terminalLabel(term("t-codex", 6, { harness: "codex", title: "app" }))).toBe("app");
    expect(terminalMark(term("t-new", 3))).toEqual({ harness: "terminal", kind: "terminal" });
    apply(s, { type: "terminal.state", params: term("t-old", 1, { status: "exited", exitCode: 0 }) });
    expect(selectTerminalTabs(s).map((t) => t.id)).toEqual(["t-new"]);
    expect(selectTerminalTabs(s, "t-old").map((t) => t.id)).toEqual(["t-new", "t-old"]);
    // A terminal whose session the view does not know is a bare one.
    apply(s, { type: "terminal.state", params: term("t-gone", 4, { session: "sess_unknown" }) });
    expect(selectTerminalTabs(s).map((t) => t.id)).toEqual(["t-gone", "t-new"]);
    // They go with the line, and come again with the next list.
    apply(s, { type: "host.state", params: { connected: false } });
    expect(s.terminals.size).toBe(0);
  });

  test("a bare terminal's tab says where it works: its workspace's name or its folder's, then its own name when that says more than its program", () => {
    const s = scoped(withTerminals());
    const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FC1";
    apply(s, { type: "workspace.state", params: { id: "wks_app", node: NODE, path: "C:\\src\\app", name: "My App", origin: "discovered", lastActivity: 1 } });
    // A shell's title is its program's own path: the place alone.
    expect(terminalTabLabel(s, term("t1", 1, { cwd: "c:\\src\\app\\", title: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }))).toBe("My App");
    expect(terminalTabLabel(s, term("t2", 1, { cwd: "C:\\src\\app\\web" }))).toBe("web");
    expect(terminalTabLabel(s, term("t3", 1, { name: "build" }))).toBe("My App · build");
    expect(terminalTabLabel(s, term("t4", 1, { cwd: "C:\\src\\lib", agents: "claude" }))).toBe("lib · Claude agents");
    expect(terminalTabLabel(s, term("t5", 1, { argv0: "bash", cwd: "/home/me/site", title: "vim notes.md" }))).toBe("site · vim notes.md");
    // Another machine's, with its name; its workspace there is not this one's.
    apply(s, { type: "nodes", nodes: [{ id: OTHER, name: "laptop", role: "secondary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: false, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false }, versions: { platform: "0.3.0", protocol: 1 }, lastSeen: 1 }] });
    expect(terminalPlace(s, term("t6", 1, { node: OTHER }))).toBe("app · laptop");
  });

  test("New terminal offers this node's workspaces, the one worked in last first, at most eight", () => {
    const ws = (id: string, lastActivity: number, name = id, node = NODE): Workspace => ({ id, node, path: `C:\\src\\${name}`, name, origin: "discovered", lastActivity });
    const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FC0";
    const list = [ws("ws_old", 1), ws("ws_new", 30), ws("ws_b", 20, "b"), ws("ws_a", 20, "a"), ws("ws_far", 99, "far", OTHER)];
    expect(recentWorkspaces(list, NODE).map((w) => w.id)).toEqual(["ws_new", "ws_a", "ws_b", "ws_old"]);
    expect(recentWorkspaces(list, OTHER).map((w) => w.id)).toEqual(["ws_far"]);
    // Before the view knows its node, it offers none.
    expect(recentWorkspaces(list, undefined)).toEqual([]);
    const many = Array.from({ length: RECENT_WORKSPACES + 3 }, (_, i) => ws(`ws_${i}`, i));
    expect(recentWorkspaces(many, NODE).map((w) => w.id)).toEqual(Array.from({ length: RECENT_WORKSPACES }, (_, i) => `ws_${RECENT_WORKSPACES + 2 - i}`));
  });

  test("a session's own terminal is reached from its pane only with the terminal scope and on its host", () => {
    const s = ready();
    const a = session("sess_a", 100, { native: { id: "n", transport: "pipe", terminal: { host: HOST, id: "t1" } } });
    apply(s, { type: "session.state", params: a });
    apply(s, { type: "terminals", terminals: [term("t1", 1, { session: "sess_a" })] });
    expect(sessionTerminal(s, a)).toBeUndefined();
    scoped(s);
    expect(sessionTerminal(s, a)?.id).toBe("t1");
    expect(sessionTerminal(s, { ...a, native: { ...a.native, terminal: { host: "another", id: "t1" } } })).toBeUndefined();
    expect(sessionTerminal(s, session("sess_b", 100))).toBeUndefined();
  });

  test("a session can be killed from its pane while it runs and the node can end it, with the scope to write to sessions", () => {
    const s = ready();
    // The user's own with a known process, one cophylad spawned or started in a terminal: yes.
    expect(stoppable(s, session("sess_a", 100, { native: { id: "n", transport: "pipe", pid: 4120 } }))).toBe(true);
    expect(stoppable(s, session("sess_a", 100, { origin: "orchestrator", native: { id: "n", transport: "acp" } }))).toBe(true);
    expect(stoppable(s, session("sess_a", 100, { origin: "orchestrator", native: { id: "n", transport: "pipe", terminal: { host: HOST, id: "t1" } } }))).toBe(true);
    // The user's own in a terminal with no process known: the terminal is their shell's, so no.
    expect(stoppable(s, session("sess_a", 100, { native: { id: "n", transport: "pipe", terminal: { host: HOST, id: "t1" } } }))).toBe(false);
    expect(stoppable(s, session("sess_a", 100))).toBe(false);
    expect(stoppable(s, session("sess_a", 100, { status: "ended", native: { id: "n", transport: "pipe", pid: 4120 } }))).toBe(false);
    const readOnly = initialState();
    apply(readOnly, { type: "host.ready", params: { ...READY, scopes: ["sessions:read"] } });
    expect(stoppable(readOnly, session("sess_a", 100, { native: { id: "n", transport: "pipe", pid: 4120 } }))).toBe(false);
  });

  test("a session's pane shows its terminal until the user picks the timeline, and the timeline when it has none", () => {
    expect(paneMode(undefined, true)).toBe("terminal");
    expect(paneMode("timeline", true)).toBe("timeline");
    expect(paneMode("terminal", true)).toBe("terminal");
    expect(paneMode(undefined, false)).toBe("timeline");
    expect(paneMode("terminal", false)).toBe("timeline");
  });

  test("a send typed into a terminal lands as the user's turn under its ref; one over the pipe reached it as another agent's", () => {
    const s = ready();
    apply(s, { type: "session.state", params: session("sess_a", 100) });
    open(s, "sess_a");
    apply(s, { type: "send.result", session: "sess_a", ref: "cophylad-typed", text: "run the tests", at: 5000, status: "queued" });
    apply(s, { type: "send.result", session: "sess_a", ref: "cophylad-piped", text: "and the docs", at: 5001, status: "queued" });
    apply(s, { type: "session.event", params: event("sess_a", 1, "user_turn", { text: "run the tests", source: "typed", ref: "cophylad-typed", promptId: "p1" }) });
    apply(s, { type: "session.event", params: event("sess_a", 2, "notification", { type: "message", ref: "cophylad-piped", state: "delivered" }) });
    const card = s.sessions.get("sess_a")!;
    const rows = selectTimeline(s, card);
    expect(rows.map((r) => r.key)).toEqual(["e1", "e2"]);
    expect(card.sends.get("cophylad-typed")!.state).toBe("delivered");
    expect((rows[0] as { send?: { ref: string } }).send?.ref).toBe("cophylad-typed");
    expect((rows[0] as { asPeer?: boolean }).asPeer).toBeUndefined();
    expect((rows[1] as { asPeer?: boolean }).asPeer).toBe(true);
    // An ACP session's messages are its own turns: no such note.
    apply(s, { type: "session.state", params: session("sess_c", 100, { native: { id: "c", transport: "acp" } }) });
    open(s, "sess_c");
    apply(s, { type: "session.event", params: event("sess_c", 1, "notification", { type: "message", state: "delivered", text: "hi" }) });
    expect((selectTimeline(s, s.sessions.get("sess_c")!)[0] as { asPeer?: boolean }).asPeer).toBeUndefined();
  });

  test("a followed screen's font scales it to fill the pane, keeping its shape, down to a floor", () => {
    // 120×30 drawn 1000×480 at 14: a wide pane is filled to its height, a tall one to its width.
    const drawn = { width: 1000, height: 480 };
    expect(followFont({ width: 2400, height: 960 }, drawn, 14)).toBe(28);
    expect(followFont({ width: 1500, height: 2000 }, drawn, 14)).toBe(21);
    expect(followFont({ width: 800, height: 900 }, drawn, 14)).toBe(11);
    expect(followFont({ width: 300, height: 900 }, drawn, 14)).toBe(FONT_MIN);
    // Unmeasured, a hidden pane, keeps the font it has.
    expect(followFont({ width: 0, height: 0 }, drawn, 14)).toBe(14);
    expect(followFont({ width: 800, height: 900 }, { width: 0, height: 0 }, 14)).toBe(14);
  });

  test("− and + step the scale from what the terminal is drawn at, and stop at either end", () => {
    // A driven terminal's scale is one of the steps; a followed one's may sit between two.
    expect(stepScale(100, 1)).toBe(110);
    expect(stepScale(100, -1)).toBe(90);
    expect(stepScale(137, 1)).toBe(150);
    expect(stepScale(137, -1)).toBe(125);
    expect(stepScale(SCALES[SCALES.length - 1]!, 1)).toBeUndefined();
    expect(stepScale(SCALES[0]!, -1)).toBeUndefined();
    expect(stepScale(69, -1)).toBeUndefined();
    expect(stepScale(400, -1)).toBe(300);
    // The shown percentage is the drawn font's, and a step's font reads back as that step.
    expect(fontScale(FONT_DRIVE)).toBe(100);
    expect(fontScale(18)).toBe(138);
    for (const s of SCALES) expect(fontScale(scaleFont(s))).toBe(s);
    expect(scaleFont(SCALES[0]!)).toBeGreaterThanOrEqual(FONT_MIN);
  });

  test("output that came before the open's answer is kept only past its repaint", () => {
    const out = (seq: number, reset?: boolean) => ({ terminal: "t1", seq, data: String(seq), ...(reset ? { reset } : {}) });
    expect(pastRepaint(100, [out(90), out(100), out(110), out(95, true)]).map((o) => o.seq)).toEqual([110, 95]);
  });

  test("a mouse tracking mode asked for again, no wider than the one on, is dropped; anything else goes through", () => {
    // Claude re-sends 1000, 1002 and 1003 as a drag starts, with 1003 on: the drag keeps reporting.
    for (const mode of [9, 1000, 1002, 1003]) expect(repeatsTracking([mode], "any")).toBe(true);
    expect(repeatsTracking([1000, 1002], "drag")).toBe(true);
    // Wider than what is on, or first set, it is the program's to have.
    expect(repeatsTracking([1003], "drag")).toBe(false);
    expect(repeatsTracking([1000], "none")).toBe(false);
    // Any other mode in the same set, or none, is not a repeat.
    expect(repeatsTracking([1000, 1006], "any")).toBe(false);
    expect(repeatsTracking([2004], "any")).toBe(false);
    expect(repeatsTracking([], "any")).toBe(false);
    expect(repeatsTracking([[1000]], "any")).toBe(false);
  });

  test("an OSC 52 puts its text on the clipboard; a query, a clear or only X11's own selections do not", () => {
    const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    expect(clipboardWrite(`c;${b64("https://example.com")}`)).toBe("https://example.com");
    expect(clipboardWrite(`;${b64("plain")}`)).toBe("plain");
    expect(clipboardWrite(`pc;${b64("both")}`)).toBe("both");
    expect(clipboardWrite(`c;${b64("naïve — ✓")}`)).toBe("naïve — ✓");
    expect(clipboardWrite("c;?")).toBeUndefined();
    expect(clipboardWrite("c;")).toBeUndefined();
    expect(clipboardWrite(`p;${b64("primary")}`)).toBeUndefined();
    expect(clipboardWrite("c;not base64!")).toBeUndefined();
    expect(clipboardWrite("nonsense")).toBeUndefined();
  });

  test("Shift+Enter sends ESC CR, which a Claude prompt takes as a new line", () => {
    expect(SHIFT_ENTER).toBe("\x1b\r");
  });
});

describe("default view: the explorer", () => {
  const place = (s: ViewState, sess: Session) => explorerKey(s, sess);

  test("sessions in one folder of one node share an explorer, whatever the case or the slashes", () => {
    const s = ready();
    const a = session("sess_a", 1, { cwd: "C:\\D\\orchestrator" });
    const b = session("sess_b", 2, { cwd: "c:/d/orchestrator/" });
    const c = session("sess_c", 3, { cwd: "C:\\D\\orchestrator\\apps" });
    expect(place(s, a)).toBe(place(s, b));
    expect(place(s, a)).not.toBe(place(s, c));
    expect(place(s, a)).not.toBe(place(s, { ...a, node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW" }));
  });

  test("listings fold in; the rows go folders then files, open folders' contents under them; a failed folder and a long one say so", () => {
    const s = ready();
    const p = "k";
    apply(s, { type: "files.loading", place: p, dirs: ["", "src"] });
    expect(s.explorers.get(p)!.loading).toEqual(new Set(["", "src"]));
    expect(explorerNote(s.explorers.get(p))).toBe("Loading…");
    apply(s, {
      type: "files",
      place: p,
      asked: [""],
      root: "C:\\D\\site",
      dirs: [{ dir: "", entries: [{ name: "src", kind: "dir" }, { name: "gone", kind: "dir" }, { name: "README.md", kind: "file" }] }],
    });
    const ex = s.explorers.get(p)!;
    expect(ex.loading).toEqual(new Set(["src"]));
    expect(explorerNote(ex)).toBe("");
    // Closed folders show their row alone; one open and still loading says so on its row.
    expect(selectFileRows(ex, new Set()).map((r) => [r.key, r.kind, r.depth, r.open])).toEqual([
      ["src", "dir", 0, false],
      ["gone", "dir", 0, false],
      ["README.md", "file", 0, false],
    ]);
    expect(selectFileRows(ex, new Set(["src"]))[0]).toMatchObject({ key: "src", open: true, loading: true, path: "C:\\D\\site\\src" });
    apply(s, {
      type: "files",
      place: p,
      asked: ["src", "gone", "src/lib"],
      root: "C:\\D\\site",
      dirs: [
        { dir: "src", entries: [{ name: "lib", kind: "dir" }, { name: "a b.ts", kind: "file" }] },
        { dir: "gone", error: "no such folder" },
        { dir: "src/lib", entries: [{ name: "x.ts", kind: "file" }], truncated: true },
      ],
    });
    const rows = selectFileRows(ex, new Set(["src", "src/lib", "gone"]));
    expect(rows.map((r) => [r.key, r.kind, r.depth, r.name])).toEqual([
      ["src", "dir", 0, "src"],
      ["src/lib", "dir", 1, "lib"],
      ["src/lib/x.ts", "file", 2, "x.ts"],
      ["src/lib\n+", "more", 2, "More not shown"],
      ["src/a b.ts", "file", 1, "a b.ts"],
      ["gone", "dir", 0, "gone"],
      ["gone\n!", "note", 1, "no such folder"],
      ["README.md", "file", 0, "README.md"],
    ]);
    expect(rows.find((r) => r.key === "src/a b.ts")!.path).toBe("C:\\D\\site\\src\\a b.ts");
    // A folder open inside a closed one stays open for later, but shows nothing now.
    expect(selectFileRows(ex, new Set(["src/lib"])).map((r) => r.key)).toEqual(["src", "gone", "README.md"]);
    // A listing that failed keeps what was listed, and says why.
    apply(s, { type: "files", place: p, asked: [""], error: "That computer is not connected." });
    expect(selectFileRows(ex, new Set()).length).toBe(3);
    expect(explorerNote(ex)).toBe("That computer is not connected.");
    apply(s, { type: "files", place: p, asked: [""], root: "C:\\D\\site", dirs: [{ dir: "", entries: [] }] });
    expect(explorerNote(ex)).toBe("This folder is empty.");
    apply(s, { type: "files", place: p, asked: [""], root: "C:\\D\\site", dirs: [{ dir: "", error: "not allowed to read it" }] });
    expect(explorerNote(ex)).toBe("This folder cannot be read: not allowed to read it.");
  });

  test("what is listed again: the folder and each open one whose parents are open, shallowest first, as many as one ask takes", () => {
    expect(openFolders(new Set())).toEqual([""]);
    expect(openFolders(new Set(["src/lib", "src", "docs", "old/deep"]))).toEqual(["", "docs", "src", "src/lib"]);
    const many = new Set(Array.from({ length: 100 }, (_, i) => `d${i}`));
    expect(openFolders(many).length).toBe(FOLDERS_PER_ASK);
  });

  test("paths are spelled as their node spells them, and dropped as one word", () => {
    expect(joinPath("C:\\D\\site", "src/a.ts")).toBe("C:\\D\\site\\src\\a.ts");
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
    expect(joinPath("\\\\server\\share\\", "x/y")).toBe("\\\\server\\share\\x\\y");
    expect(joinPath("/home/me/site", "src/a.ts")).toBe("/home/me/site/src/a.ts");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/home/me", "")).toBe("/home/me");
    expect(dropText("C:\\D\\site\\a.ts")).toBe("C:\\D\\site\\a.ts");
    expect(dropText("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(dropTexts(["C:\\D\\a.ts", "C:\\Program Files\\x", "C:\\D\\docs"])).toBe('C:\\D\\a.ts "C:\\Program Files\\x" C:\\D\\docs');
    expect(dropTexts(["/home/me/a b"])).toBe('"/home/me/a b"');
  });

  test("the repository's line reads as VS Code's status bar", () => {
    expect(gitLine({ branch: "master", commit: "1e0d3291", upstream: "origin/master", ahead: 2, behind: 1, changes: 3 })).toEqual({
      branch: "master*",
      sync: "1↓ 2↑",
      title: "On master; 1 commit to pull and 2 commits to push, against origin/master as of the last fetch; 3 changed files",
    });
    expect(gitLine({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, changes: 0 })).toMatchObject({ branch: "main", sync: "" });
    expect(gitLine({ branch: "feat", changes: 1 })).toEqual({ branch: "feat*", sync: "not published", title: "On feat; tracking nothing: not published; 1 changed file" });
    expect(gitLine({ commit: "a8d9def0", changes: 0 })).toEqual({ branch: "a8d9def0", sync: "", title: "Detached at a8d9def0; no changes" });
    expect(gitLine({ branch: "feat", upstream: "origin/feat", changes: 0 }).title).toBe("On feat; tracking origin/feat, which is gone; no changes");
    const s = ready();
    apply(s, { type: "git", place: "k", git: { branch: "main", changes: 0 } });
    expect(s.explorers.get("k")!.git?.branch).toBe("main");
    apply(s, { type: "git", place: "k" });
    expect(s.explorers.get("k")!.git).toBeUndefined();
  });

  test("a failed listing in the explorer's words", () => {
    expect(filesErrorWords("unsupported", "unknown method session.files")).toBe("This app cannot show files yet: update it.");
    expect(filesErrorWords("unsupported", "session.files is not served over the node link")).toBe("That computer cannot show its files yet: update Cophyla there.");
    expect(filesErrorWords("denied", "session.files reaches past this access")).toBe("This view may not list these files.");
    expect(filesErrorWords("not_found", "C:\\x: no such folder")).toBe("C:\\x: no such folder");
  });

  test("a file chip's home: the live agent whose folder holds the file, the innermost first, then the one worked in last", () => {
    const s = ready();
    const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    apply(s, { type: "session.state", params: session("sess_repo", 1, { cwd: "C:\\D\\site", lastActivity: 5 }) });
    apply(s, { type: "session.state", params: session("sess_repo2", 2, { cwd: "c:/d/site/", lastActivity: 9 }) });
    apply(s, { type: "session.state", params: session("sess_app", 3, { cwd: "C:\\D\\site\\apps\\web", lastActivity: 1 }) });
    apply(s, { type: "session.state", params: session("sess_far", 4, { cwd: "C:\\D\\site", node: OTHER, lastActivity: 99 }) });
    // The rest of the path is spelled as it was written, the folder matched whatever the case or the slashes.
    expect(fileHome(s, NODE, "C:\\D\\Site\\src\\main.ts")).toEqual({ session: s.sessions.get("sess_repo2")!.session, rel: "src/main.ts" });
    expect(fileHome(s, NODE, "C:/D/site/apps/web/index.html")?.session.id).toBe("sess_app");
    expect(fileHome(s, NODE, "C:\\D\\site")?.rel).toBe("");
    expect(fileHome(s, OTHER, "C:\\D\\site\\README.md")?.session.id).toBe("sess_far");
    // The agent whose terminal wrote the path comes first where its folder holds it, and only there.
    expect(fileHome(s, NODE, "C:/D/site/apps/web/index.html", "sess_repo")).toEqual({ session: s.sessions.get("sess_repo")!.session, rel: "apps/web/index.html" });
    expect(fileHome(s, NODE, "C:/D/site/apps/web/index.html", "sess_far")?.session.id).toBe("sess_app");
    // Beside a folder, not in it; relative; or no agent there at all.
    expect(fileHome(s, NODE, "C:\\D\\sites\\x.ts")).toBeUndefined();
    expect(fileHome(s, NODE, "src\\main.ts")).toBeUndefined();
    expect(fileHome(s, "node_01ARZ3NDEKTSV4RRFFQ69G5FAX", "C:\\D\\site\\x.ts")).toBeUndefined();
    apply(s, { type: "session.state", params: session("sess_app", 3, { cwd: "C:\\D\\site\\apps\\web", status: "ended" }) });
    expect(fileHome(s, NODE, "C:/D/site/apps/web/index.html")).toEqual({ session: s.sessions.get("sess_repo2")!.session, rel: "apps/web/index.html" });
    // A POSIX node's folder, case kept.
    apply(s, { type: "session.state", params: session("sess_nix", 5, { cwd: "/home/me/Code", node: OTHER }) });
    expect(fileHome(s, OTHER, "/home/me/Code/a/b.rs")?.rel).toBe("a/b.rs");
  });

  test("a chip names a session by its harness, and its title or intent when it has one", () => {
    expect(sessionWho(session("sess_a", 1, { title: "Tidy the build", intent: "fix it" }))).toBe("claude: Tidy the build");
    expect(sessionWho(session("sess_a", 1, { intent: "fix it" }))).toBe("claude: fix it");
    expect(sessionWho(session("sess_a", 1, { harness: "codex" }))).toBe("codex");
  });
});
