// Access: the tables cover every request and notification, every request that needs a global
// scope is global in the table too, limited access holds no global scope, minted access is no
// more than the minter's, targets are judged by node, workspace and path, lists and samples
// are cut to what a limited credential reaches, and the messaging rule.

import { describe, expect, test } from "bun:test";
import {
  ACCESS_PRESETS,
  allows,
  allowsNotification,
  clientNotifications,
  clientRequests,
  filterResult,
  FULL,
  GLOBAL_REQUESTS,
  GLOBAL_SCOPES,
  isFull,
  isLimited,
  mayMessage,
  normalPath,
  notificationFilters,
  notificationScopes,
  pathWithin,
  refuseRequest,
  requestFilters,
  requestScopes,
  SESSIONS,
  trimSample,
  validateAccess,
  VIEW,
} from "../src/index.ts";
import type { Access, Ask, ClientSession, MetricsSample, TargetLookup } from "../src/index.ts";

const N1 = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const N2 = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const W1 = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const W2 = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const S1 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB0";
const S2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const A1 = "ask_01ARZ3NDEKTSV4RRFFQ69G5FB2";

const look: TargetLookup = {
  self: N1,
  session: (id) => (id === S1 ? { node: N1, workspace: W1, path: "/src/app/sub" } : id === S2 ? { node: N2, path: "/elsewhere" } : undefined),
  ask: (id) => (id === A1 ? { node: N1, session: S1 } : undefined),
  workspace: (id) => (id === W1 ? { node: N1, path: "/src/app" } : id === W2 ? { node: N2, path: "C:\\Work\\Other" } : undefined),
};

const limited = (over: Partial<Access>): Access => ({ ...SESSIONS, ...over });

describe("the tables", () => {
  test("name every request and every notification, and nothing else", () => {
    expect(Object.keys(requestFilters).sort()).toEqual(Object.keys(clientRequests).sort());
    expect(Object.keys(notificationFilters).sort()).toEqual(Object.keys(clientNotifications).sort());
  });

  test("a request or notification that needs a global scope is global in the table", () => {
    const global = GLOBAL_SCOPES as readonly string[];
    const reqs = Object.entries(requestScopes).filter(([, s]) => s !== null && global.includes(s)).map(([n]) => n);
    for (const n of reqs) expect({ n, names: requestFilters[n as keyof typeof requestFilters].names }).toEqual({ n, names: "global" });
    const notes = Object.entries(notificationScopes).filter(([, s]) => s !== null && global.includes(s)).map(([n]) => n);
    for (const n of notes) expect({ n, filter: notificationFilters[n as keyof typeof notificationFilters] }).toEqual({ n, filter: "global" });
  });

  test("the node-wide requests are refused to limited access whatever its scopes", () => {
    expect(GLOBAL_REQUESTS).toContain("view.setDefault");
    expect(GLOBAL_REQUESTS).toContain("grant.invite");
    expect(GLOBAL_REQUESTS).toContain("node.join");
    expect(GLOBAL_REQUESTS).not.toContain("session.send");
    expect(GLOBAL_REQUESTS).not.toContain("view.stage");
  });
});

describe("validateAccess", () => {
  test("the presets are valid; FULL is full and unlimited; the others hold no global scope", () => {
    for (const a of Object.values(ACCESS_PRESETS)) expect(validateAccess(a)).toBeUndefined();
    expect(isFull(FULL)).toBe(true);
    expect(isFull(SESSIONS)).toBe(false);
    for (const a of [SESSIONS, VIEW]) expect(a.scopes.some((s) => (GLOBAL_SCOPES as readonly string[]).includes(s))).toBe(false);
  });

  test("limited access cannot hold a global scope, and a limit must name something", () => {
    expect(validateAccess({ scopes: ["sessions:read", "chat"], nodes: [N1], messages: "none" })).toContain("chat");
    expect(validateAccess({ scopes: ["terminal"], workspaces: [W1], messages: "none" })).toContain("terminal");
    expect(validateAccess({ scopes: ["sessions:read"], nodes: [], messages: "none" })).toContain("nodes");
    expect(validateAccess({ scopes: [], messages: "none" })).toBeDefined();
    expect(validateAccess({ scopes: ["chat", "nodes"], messages: "send" })).toBeUndefined();
    expect(isLimited({ scopes: ["views"], paths: ["/x"], messages: "none" })).toBe(true);
  });

  test("what is minted is no more than the minter holds", () => {
    const minter = limited({ nodes: [N1, N2], paths: ["/src"], messages: "reply" });
    expect(validateAccess(limited({ nodes: [N1], paths: ["/src/app"], messages: "none" }), minter)).toBeUndefined();
    expect(validateAccess(limited({ nodes: [N1], paths: ["/src/app"], messages: "send" }), minter)).toContain("messages");
    expect(validateAccess(limited({ paths: ["/src/app"] }), minter)).toContain("nodes");
    expect(validateAccess(limited({ nodes: [N1], paths: ["/etc"] }), minter)).toContain("paths");
    expect(validateAccess(limited({ nodes: [N1], paths: ["/src"], scopes: ["sessions:read", "remote"] }), minter)).toContain("remote");
    expect(validateAccess(FULL, SESSIONS)).toBeDefined();
    expect(validateAccess(SESSIONS, FULL)).toBeUndefined();
  });

  test("the messaging rule", () => {
    expect(mayMessage({ messages: "none" }, "reply")).toBe(false);
    expect(mayMessage({ messages: "reply" }, "reply")).toBe(true);
    expect(mayMessage({ messages: "reply" }, "initiate")).toBe(false);
    expect(mayMessage({ messages: "send" }, "initiate")).toBe(true);
  });
});

describe("paths", () => {
  test("compare as text: separators, dots, trailing slashes, and case on Windows only", () => {
    expect(normalPath("C:\\Src\\App\\")).toBe("c:/src/app");
    expect(normalPath("C:\\src\\app\\..\\..\\..\\x")).toBe("c:/x");
    expect(normalPath("/src/./app/../lib")).toBe("/src/lib");
    expect(normalPath("\\\\Server\\Share\\Dir")).toBe("//server/share/dir");
    expect(pathWithin("C:\\SRC\\app\\x.ts", "c:/src/app")).toBe(true);
    expect(pathWithin("c:/src/apple", "c:/src/app")).toBe(false);
    expect(pathWithin("/src/App", "/src/app")).toBe(false);
    expect(pathWithin("/src/app/../other", "/src/app")).toBe(false);
    expect(pathWithin("/src/app", "/src/app/")).toBe(true);
    expect(pathWithin("/anything", "/")).toBe(true);
  });
});

describe("targets", () => {
  test("unlimited access reaches everything, even what the lookup does not know", () => {
    expect(allows(FULL, { session: "sess_unknown" }, look)).toBe(true);
  });

  test("a node limit, a workspace limit by id or by path, a path limit; several limits all apply", () => {
    expect(allows(limited({ nodes: [N1] }), { session: S1 }, look)).toBe(true);
    expect(allows(limited({ nodes: [N1] }), { session: S2 }, look)).toBe(false);
    expect(allows(limited({ workspaces: [W1] }), { session: S1 }, look)).toBe(true);
    // A session with no workspace but inside the workspace's folder, on its node.
    expect(allows(limited({ workspaces: [W1] }), { node: N1, path: "/src/app/deep" }, look)).toBe(true);
    expect(allows(limited({ workspaces: [W1] }), { node: N2, path: "/src/app/deep" }, look)).toBe(false);
    expect(allows(limited({ workspaces: [W2] }), { node: N2, path: "c:/work/other/x" }, look)).toBe(true);
    expect(allows(limited({ paths: ["/src"] }), { session: S1 }, look)).toBe(true);
    expect(allows(limited({ paths: ["/src"] }), { session: S2 }, look)).toBe(false);
    expect(allows(limited({ paths: ["/src"], nodes: [N2] }), { session: S1 }, look)).toBe(false);
    // A session or an ask the lookup does not know is out of reach.
    expect(allows(limited({ nodes: [N1] }), { session: "sess_unknown" }, look)).toBe(false);
    expect(allows(limited({ nodes: [N1] }), { ask: A1 }, look)).toBe(true);
  });

  test("a node's load is in reach of a limit that reaches anything on it; its desktop only of a node limit", () => {
    // Metrics name no workspace: a workspace limit reaches the load of the node its workspace is on.
    expect(refuseRequest(limited({ workspaces: [W1] }), "metrics.subscribe", { intervalMs: 5000 }, look)).toBeUndefined();
    expect(refuseRequest(limited({ workspaces: [W1] }), "metrics.subscribe", { node: N2, intervalMs: 5000 }, look)).toBeDefined();
    expect(refuseRequest(limited({ nodes: [N2] }), "metrics.subscribe", { intervalMs: 5000 }, look)).toBeDefined();
    expect(allowsNotification(limited({ workspaces: [W2] }), "metrics.sample", { node: N2 } as MetricsSample, look)).toBe(true);
    // The desktop is the whole machine: out of reach of a workspace or path limit, in reach of a node limit.
    expect(refuseRequest(limited({ workspaces: [W1], scopes: ["remote"] }), "remote.open", { node: N1 }, look)).toBeDefined();
    expect(refuseRequest(limited({ paths: ["/"], scopes: ["remote"] }), "remote.open", { node: N1 }, look)).toBeDefined();
    expect(refuseRequest(limited({ nodes: [N1], scopes: ["remote"] }), "remote.open", { node: N1 }, look)).toBeUndefined();
    expect(allowsNotification(limited({ workspaces: [W1] }), "remote.state", { node: N1 } as never, look)).toBe(false);
  });

  test("a limited request is refused when global, out of reach, or remembered for always", () => {
    const a = limited({ workspaces: [W1] });
    expect(refuseRequest(a, "view.setDefault", { id: "default" }, look)).toContain("not for limited");
    expect(refuseRequest(a, "session.send", { id: S2, text: "x" }, look)).toContain("reaches past");
    expect(refuseRequest(a, "session.send", { id: S1, text: "x" }, look)).toBeUndefined();
    expect(refuseRequest(a, "ask.answer", { id: A1, option: "allow", remember: "always" }, look)).toContain("always");
    expect(refuseRequest(a, "ask.answer", { id: A1, option: "allow", remember: "session" }, look)).toBeUndefined();
    expect(refuseRequest(a, "workspace.put", { node: N1, path: "/src/app/new", name: "new" }, look)).toBeUndefined();
    expect(refuseRequest(a, "workspace.put", { node: N1, path: "/etc", name: "etc" }, look)).toBeDefined();
    expect(refuseRequest(a, "session.watch", { ids: [S1, S2] }, look)).toBeDefined();
    expect(refuseRequest(a, "view.stage", { id: "default" }, look)).toBeUndefined();
    expect(refuseRequest(FULL, "view.setDefault", { id: "default" }, look)).toBeUndefined();
    // Silencing what is read out is the whole node's: a limited phone may not, and never hears whether anything will be.
    expect(refuseRequest(a, "voice.hush", { on: true }, look)).toContain("not for limited");
    expect(allowsNotification(a, "voice.next", { speak: true }, look)).toBe(false);
    expect(allowsNotification(FULL, "voice.next", { speak: true }, look)).toBe(true);
  });

  test("a list comes back without what is out of reach; a row is sent only where it reaches", () => {
    const row = (id: string, node: string, cwd: string, workspace?: string) => ({ id, node, cwd, workspace }) as unknown as ClientSession;
    const r = filterResult(limited({ nodes: [N1] }), "session.list", { sessions: [row(S1, N1, "/a"), row(S2, N2, "/b")] }, look);
    expect(r.sessions.map((s) => s.id)).toEqual([S1]);
    const gateAsk = { id: A1, node: N1, source: { kind: "gate", action: "x", principal: { kind: "brain" } } } as unknown as Ask;
    expect(allowsNotification(limited({ nodes: [N1] }), "ask.state", gateAsk, look)).toBe(true);
    // A gate's ask is about no workspace: a workspace-limited phone does not see it.
    expect(allowsNotification(limited({ workspaces: [W1] }), "ask.state", gateAsk, look)).toBe(false);
    expect(allowsNotification(limited({ workspaces: [W1] }), "ask.state", { ...gateAsk, source: { kind: "harness", session: S1 } } as Ask, look)).toBe(true);
    expect(allowsNotification(limited({ nodes: [N1] }), "chat.message", {} as never, look)).toBe(false);
    expect(allowsNotification(limited({ nodes: [N1] }), "view.changed", { id: "default" }, look)).toBe(true);
    expect(allowsNotification(FULL, "chat.message", {} as never, look)).toBe(true);
  });

  test("a trimmed sample keeps the load whole and names only the sessions in reach", () => {
    const sample: MetricsSample = {
      node: N1,
      at: 1,
      cpu: 0.5,
      memory: { used: 1, total: 2 },
      processes: [
        { pid: 1, parent: 0, name: "claude", cpu: 0.1, memory: 10, owner: { kind: "session", session: S1 } },
        { pid: 2, parent: 0, name: "claude", cpu: 0.2, memory: 20, owner: { kind: "session", session: S2 } },
        { pid: 3, parent: 0, name: "chrome", cpu: 0.3, memory: 30, owner: { kind: "other" } },
        { pid: 4, parent: 0, name: "cophylad", cpu: 0.05, memory: 5, owner: { kind: "platform" } },
      ],
      llm: {},
    };
    const t = trimSample(sample, (s) => s === S1);
    expect(t.processes.map((p) => p.pid)).toEqual([1, 4, 0]);
    expect(t.processes.at(-1)).toMatchObject({ name: "other", owner: { kind: "other" }, memory: 50 });
    expect(t.processes.reduce((n, p) => n + p.cpu, 0)).toBeCloseTo(0.65);
  });
});
