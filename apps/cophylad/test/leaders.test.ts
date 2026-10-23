// Leaders: the store the primary keeps (the daemon's own namespace, replicated to the backups and
// never in the cloud backup, changed by clients alone, told on every change, the retired
// `brain_sends = "typed"` read once as the chat leading every agent, a grant whose sessions
// ended a week ago pruned); the router's lead path over a real gate (typed as the user's words,
// past focus and the parity ask, the limits kept; a non-leader, a session that cannot take the
// user's words, an older machine and a teammate's agent as ever, the leader told why);
// `answer_ask` and each refusal; and what a led session does next, reported to its leader.

import { describe, expect, test } from "bun:test";
import { actionDefinition, AGENT_TOOLS, capabilityRequests, clientRequests, newId } from "@cophyla/protocol";
import type { Access, Ask, Leader, NodeRecord, Session, SessionEvent } from "@cophyla/protocol";
import { Focuses } from "../src/agentmsg/focus.ts";
import { AgentMessages } from "../src/agentmsg/index.ts";
import type { AgentCluster, AgentSessions, AgentTeammates } from "../src/agentmsg/index.ts";
import { Bus } from "../src/bus.ts";
import { BACKUP_EXCLUDED_KV_NS } from "../src/cloud/backup.ts";
import { Config } from "../src/config/schema.ts";
import { Asks } from "../src/gate/asks.ts";
import { Audit } from "../src/gate/audit.ts";
import { Gate } from "../src/gate/index.ts";
import { BUILTIN_RULES, Policy } from "../src/gate/policy.ts";
import { LEADERS_KV_NS, RESERVED_KV_NS } from "../src/grants/namespaces.ts";
import { Leaders, MIGRATED_KEY, PRUNE_MS } from "../src/leaders/index.ts";
import type { LeadNode } from "../src/leaders/index.ts";
import { leaderMethods } from "../src/leaders/methods.ts";
import { askNotice, Reports } from "../src/leaders/reports.ts";
import { silentLogger } from "../src/log.ts";
import { EXCLUDED_KV_NS } from "../src/nodes/replication.ts";
import type { SendOptions } from "../src/sessions/index.ts";
import { Store } from "../src/store/index.ts";
import { sleep, waitFor } from "./helpers.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OLD = "node_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const LENT = "node_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const SHARES = "node_01ARZ3NDEKTSV4RRFFQ69G5FAZ";

let started = 1_000;
/** A session; a Claude one runs in a tether terminal unless `native` says otherwise. */
function sess(harness: Session["harness"], cwd: string, extra: Partial<Session> = {}): Session {
  return {
    id: newId("session"),
    node: DESK,
    harness,
    profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
    native: harness === "codex" ? { id: crypto.randomUUID(), transport: "app-server" } : { id: crypto.randomUUID(), transport: "pipe", terminal: { host: "h1", id: `t${started}` } },
    origin: "user",
    cwd,
    tags: [],
    status: "idle",
    startedAt: started++,
    lastActivity: 0,
    ...extra,
  };
}

function nodeRow(id: string, name: string, extra: Partial<NodeRecord> = {}, caps: Partial<NodeRecord["capabilities"]> = { lead: true }): NodeRecord {
  return {
    id,
    name,
    role: "secondary",
    status: "online",
    via: "direct",
    platform: "windows",
    scope: { kind: "machine" },
    capabilities: { harnesses: ["claude", "codex"], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false, agents: { acceptInBypass: false }, ...caps },
    versions: { platform: "0.19.0", protocol: 1 },
    lastSeen: 0,
    endpoints: [],
    ...extra,
  } as NodeRecord;
}

const SELF: LeadNode = { name: "Desk", scope: { kind: "machine" }, capabilities: { lead: true } };

function store(): Store {
  const s = new Store(":memory:");
  s.migrate();
  return s;
}

// --- the store ---------------------------------------------------------------------------------

function leadersRig(opts: { sessions: Session[]; nodes?: NodeRecord[]; legacy?: boolean; routes?: boolean; now?: () => number }) {
  const st = store();
  const bus = new Bus();
  const states: Leader[][] = [];
  bus.on("lead.state", (s) => states.push(s.leaders));
  const leaders = new Leaders({
    store: st,
    bus,
    log: silentLogger,
    routes: () => opts.routes ?? true,
    sessions: () => opts.sessions,
    node: (id) => (id === DESK ? SELF : opts.nodes?.find((n) => n.id === id)),
    legacyTyped: () => opts.legacy ?? false,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { store: st, bus, leaders, states };
}

const failure = (f: () => unknown) => {
  try {
    f();
    return undefined;
  } catch (e) {
    return e;
  }
};

describe("the leaders the primary keeps", () => {
  test("are the daemon's own: never the brain's to read or write, replicated to the backups, never in the cloud backup", () => {
    expect(LEADERS_KV_NS).toBe("leaders");
    expect(RESERVED_KV_NS).toContain(LEADERS_KV_NS);
    expect(EXCLUDED_KV_NS).not.toContain(LEADERS_KV_NS);
    expect(BACKUP_EXCLUDED_KV_NS).toContain(LEADERS_KV_NS);
  });

  test("only a client changes them: the brain reads them, and no agent tool reaches them", () => {
    for (const name of ["lead.list", "lead.set", "lead.remove"]) expect(Object.keys(clientRequests)).toContain(name);
    expect(Object.keys(capabilityRequests)).toContain("lead.list");
    expect(Object.keys(capabilityRequests)).not.toContain("lead.set");
    expect(Object.keys(capabilityRequests)).not.toContain("lead.remove");
    expect(AGENT_TOOLS.map((t) => t.name).filter((n) => n.includes("lead"))).toEqual([]);
    expect(actionDefinition("lead.set")?.risk).toBe("write");
    expect(actionDefinition("agent.lead")?.risk).toBe("exec");
    expect(actionDefinition("agent.answer")?.risk).toBe("exec");
    // the user's promotion is the consent: a leader's message and its answer are allowed as built in
    expect(BUILTIN_RULES["harness:agent.lead"]).toBe("allow");
    expect(BUILTIN_RULES["harness:agent.answer"]).toBe("allow");
  });

  test("a client makes a leader, changes its group and ends it; every change is told, the chat first in the list", () => {
    const a = sess("claude", "C:/code/api");
    const b = sess("codex", "C:/code/web");
    const c = sess("claude", "C:/code/docs");
    const r = leadersRig({ sessions: [a, b, c] });
    const methods = leaderMethods({ leaders: () => r.leaders }) as Record<string, { handler: (p: unknown) => unknown }>;
    const made = methods["lead.set"]!.handler({ speaker: a.id, targets: [b.id, c.id, b.id] }) as { leader: Leader };
    expect(made.leader).toMatchObject({ speaker: a.id, targets: [b.id, c.id] });
    methods["lead.set"]!.handler({ speaker: "chat", targets: "all" });
    expect((methods["lead.list"]!.handler({}) as { leaders: Leader[] }).leaders.map((l) => l.speaker)).toEqual(["chat", a.id]);
    // a new group keeps when it became a leader
    const since = made.leader.since;
    expect(r.leaders.set(a.id, [c.id]).since).toBe(since);
    expect(r.leaders.leads(a.id, b.id)).toBe(false);
    expect(r.leaders.leads(a.id, c.id)).toBe(true);
    methods["lead.remove"]!.handler({ speaker: a.id });
    expect(r.leaders.list().map((l) => l.speaker)).toEqual(["chat"]);
    expect(r.states).toHaveLength(4);
    expect(r.states.at(-1)!.map((l) => l.speaker)).toEqual(["chat"]);
    // on a node that does not keep them, nothing is listed and nothing is changed
    const off = leaderMethods({ leaders: () => undefined }) as Record<string, { handler: (p: unknown) => unknown }>;
    expect(off["lead.list"]!.handler({})).toEqual({ leaders: [] });
    expect(failure(() => off["lead.set"]!.handler({ speaker: "chat", targets: "all" }))).toMatchObject({ code: "unavailable" });
  });

  test("only the user's own live sessions lead or are led: never the chat's own, a workspace node's, an ended one, itself, or one cophylad cannot type into", () => {
    const a = sess("claude", "C:/code/api");
    const own = sess("claude", "C:/code/x", { role: "assistant" });
    const lent = sess("claude", "C:/them/shared", { node: LENT });
    const ended = sess("codex", "C:/code/old", { status: "ended", endedAt: 5 });
    const windowed = sess("claude", "C:/code/win", { native: { id: "n", transport: "pipe" } });
    const r = leadersRig({ sessions: [a, own, lent, ended, windowed], nodes: [nodeRow(LENT, "Bob's laptop", { hands: true, scope: { kind: "workspaces", paths: ["C:/them/shared"] } })] });
    expect(failure(() => r.leaders.set("sess_01ARZ3NDEKTSV4RRFFQ69G5FC9", "all"))).toMatchObject({ code: "invalid", message: expect.stringContaining("no session") });
    expect(failure(() => r.leaders.set(own.id, "all"))).toMatchObject({ code: "invalid", message: expect.stringContaining("not one of your own") });
    expect(failure(() => r.leaders.set(lent.id, "all"))).toMatchObject({ code: "invalid", message: expect.stringContaining("not one of your own") });
    expect(failure(() => r.leaders.set(ended.id, "all"))).toMatchObject({ code: "invalid", message: expect.stringContaining("has ended") });
    expect(failure(() => r.leaders.set(a.id, [a.id]))).toMatchObject({ code: "invalid", message: expect.stringContaining("does not lead itself") });
    expect(failure(() => r.leaders.set(a.id, [windowed.id]))).toMatchObject({ code: "invalid", message: expect.stringContaining("outside a Cophyla terminal") });
    expect(failure(() => r.leaders.set("chat", [lent.id]))).toMatchObject({ code: "invalid" });
    expect(failure(() => r.leaders.set("chat", []))).toMatchObject({ code: "invalid" });
    // `all`: every one of the user's own but the leader itself and the chat's own; a workspace node's never
    r.leaders.set(a.id, "all");
    expect(r.leaders.leads(a.id, a.id)).toBe(false);
    expect(r.leaders.leads(a.id, own.id)).toBe(false);
    expect(r.leaders.leads(a.id, lent.id)).toBe(false);
    expect(r.leaders.leads(a.id, windowed.id)).toBe(true);
    expect(r.leaders.leads(a.id, "chat")).toBe(false);
    expect(r.leaders.leadersOf(windowed.id)).toEqual([a.id]);
    expect(r.states).toHaveLength(1);
  });

  test("a led session that cannot take the user's words says why: no terminal to type into, an older Cophyla, a machine that shares some folders alone", () => {
    const a = sess("codex", "C:/code/api");
    const windowed = sess("claude", "C:/code/win", { native: { id: "n", transport: "pipe" } });
    const acp = sess("claude", "C:/code/acp", { native: { id: "n2", transport: "acp" } });
    const old = sess("claude", "C:/code/old", { node: OLD });
    const shares = sess("codex", "C:/code/shared", { node: SHARES });
    const fine = sess("claude", "C:/code/web", { node: LAPTOP });
    const r = leadersRig({ sessions: [a, windowed, acp, old, shares, fine], nodes: [nodeRow(OLD, "Studio", {}, {}), nodeRow(SHARES, "Work", { scope: { kind: "workspaces", paths: ["C:/code/shared"] } }), nodeRow(LAPTOP, "Laptop")] });
    r.leaders.set(a.id, "all");
    expect(r.leaders.route(a.id, windowed)).toEqual({ fallback: expect.stringContaining("outside a Cophyla terminal") });
    expect(r.leaders.route(a.id, acp)).toEqual({ lead: true });
    expect(r.leaders.route(a.id, old)).toEqual({ fallback: "Studio runs an older Cophyla" });
    expect(r.leaders.route(a.id, shares)).toEqual({ fallback: expect.stringContaining("shares some folders alone") });
    expect(r.leaders.route(a.id, fine)).toEqual({ lead: true });
    expect(r.leaders.route("chat", fine)).toBeUndefined();
  });

  test("brain_sends = typed becomes the chat leading every agent, once, on the primary", () => {
    const a = sess("claude", "C:/code/api");
    const sec = leadersRig({ sessions: [a], legacy: true, routes: false });
    sec.leaders.migrate();
    expect(sec.store.kv.list(LEADERS_KV_NS)).toEqual([]);
    const r = leadersRig({ sessions: [a], legacy: true });
    r.leaders.start();
    r.leaders.stop();
    expect(r.leaders.list()).toMatchObject([{ speaker: "chat", targets: "all" }]);
    expect(r.store.kv.get(LEADERS_KV_NS, MIGRATED_KEY)).toMatchObject({ from: "brain_sends" });
    expect(r.states).toHaveLength(1);
    // the user stops it: it stays stopped
    r.leaders.remove("chat");
    r.leaders.migrate();
    r.leaders.sweep();
    expect(r.leaders.list()).toEqual([]);
    // a config that says pipe migrates nothing, and leaves no marker
    const p = leadersRig({ sessions: [a] });
    p.leaders.migrate();
    expect(p.store.kv.list(LEADERS_KV_NS)).toEqual([]);
  });

  test("a grant whose sessions ended lies dormant, comes back with a reopen, and goes a week after the end", () => {
    let now = 1_000_000;
    const a = sess("claude", "C:/code/api");
    const b = sess("codex", "C:/code/web");
    const c = sess("codex", "C:/code/docs");
    const list = [a, b, c];
    const r = leadersRig({ sessions: list, now: () => now });
    r.leaders.set(a.id, [b.id, c.id]);
    r.states.length = 0;
    // b ends: still in the group, a week from its end
    b.status = "ended";
    b.endedAt = now;
    r.leaders.sweep();
    expect(r.leaders.get(a.id)!.targets).toEqual([b.id, c.id]);
    // c ends, then is reopened before its week is up
    c.status = "ended";
    c.endedAt = now;
    now += PRUNE_MS / 2;
    r.leaders.sweep();
    c.status = "idle";
    delete c.endedAt;
    r.leaders.sweep();
    now += PRUNE_MS / 2 + 1;
    r.leaders.sweep();
    expect(r.leaders.get(a.id)!.targets).toEqual([c.id]);
    expect(r.states).toHaveLength(1);
    // the leader's own end takes its row a week later; a session no one knows any more counts from when it was missed
    a.status = "ended";
    a.endedAt = now;
    list.splice(list.indexOf(c), 1);
    r.leaders.sweep();
    expect(r.leaders.get(a.id)).toBeDefined();
    now += PRUNE_MS;
    r.leaders.sweep();
    expect(r.leaders.get(a.id)).toBeUndefined();
    expect(r.states).toHaveLength(2);
  });

  test("a group left empty goes with its last session; the chat's own row never ends with it", () => {
    let now = 1_000_000;
    const b = sess("codex", "C:/code/web");
    const r = leadersRig({ sessions: [b], now: () => now });
    r.leaders.set("chat", [b.id]);
    b.status = "ended";
    b.endedAt = now;
    r.leaders.sweep();
    now += PRUNE_MS;
    r.leaders.sweep();
    expect(r.leaders.list()).toEqual([]);
  });
});

// --- the router's lead path -------------------------------------------------------------------

interface Sent {
  id: string;
  text: string;
  opts: SendOptions;
}

function routerRig(opts: { local: Session[]; mirror?: Session[]; nodes?: NodeRecord[]; bypass?: Record<string, boolean>; linked?: Set<string>; toml?: string; teammates?: AgentTeammates; grants?: Record<string, Access> }) {
  const config = Config.parse(Bun.TOML.parse(opts.toml ?? ""));
  const st = store();
  const bus = new Bus();
  const asks = new Asks(st, DESK, bus);
  const audit = new Audit(st, DESK, config.gate.audit_result_cap, bus);
  const policy = new Policy(config.gate, st);
  const gate = new Gate({ config: config.gate, policy, asks, audit, log: silentLogger });
  const sent: Sent[] = [];
  const forwarded: { node: string; method: string; params: Record<string, unknown> }[] = [];
  const all = () => [...opts.local, ...(opts.mirror ?? [])];
  const mirrorAsks = new Map<string, Ask>();
  const sessions: AgentSessions = {
    list: () => opts.local.filter((s) => s.status !== "ended"),
    get: (id) => opts.local.find((s) => s.id === id),
    send: async (id, text, o) => {
      sent.push({ id, text, opts: o });
      return { status: "queued", ref: `cophylad-${sent.length}` };
    },
    codexThread: (id) => opts.local.find((s) => s.native.id === id),
    claudeSession: (id) => opts.local.find((s) => s.native.id === id),
    byPipe: () => undefined,
    byPid: (pid) => opts.local.find((s) => s.native.pid === pid),
    byNonce: () => undefined,
    byTerminal: () => undefined,
    bypasses: (id) => opts.bypass?.[id],
    acceptsInbound: () => false,
  };
  const cluster: AgentCluster = {
    routes: () => true,
    primaryName: () => "Desk",
    primaryLinked: () => true,
    mirrorSessions: () => opts.mirror ?? [],
    ownerOfSession: (id) => (opts.mirror ?? []).find((s) => s.id === id)?.node,
    nodes: () => opts.nodes ?? [],
    linked: (n) => opts.linked?.has(n) ?? false,
    forward: async (node, method, params) => {
      forwarded.push({ node, method, params: params as Record<string, unknown> });
      return method === "session.send" ? { status: "queued", ref: `cophylad-f${forwarded.length}` } : {};
    },
    requestPrimary: async () => {
      throw new Error("no primary in this rig");
    },
    grant: (id) => (opts.grants?.[id] ? { access: opts.grants[id]! } : undefined),
    mirrorAsk: (id) => mirrorAsks.get(id),
  };
  const leaders = new Leaders({ store: st, bus, log: silentLogger, routes: () => true, sessions: all, node: (id) => (id === DESK ? SELF : opts.nodes?.find((n) => n.id === id)) });
  const focus = new Focuses({ store: st, bus, log: silentLogger, routes: () => true, sessions: all, deliver: async (s, text, info) => router.deliverHere(s.id, text, info), linked: () => true });
  const reports: Reports = new Reports({
    bus,
    log: silentLogger,
    routes: () => true,
    linked: (n) => n === DESK || (opts.linked?.has(n) ?? false),
    leads: (l, t) => leaders.leads(l, t),
    alias: (id) => router.agentNames().get(id)?.alias ?? id,
    tell: (l, text, from) => router.report(l, text, from),
    settleMs: 30,
  });
  reports.start();
  const router: AgentMessages = new AgentMessages({
    config: () => config.agent_messages,
    self: () => ({ id: DESK, name: "Desk" }),
    sessions,
    cluster,
    gate,
    log: silentLogger,
    version: "test",
    leaders: () => leaders,
    reports: () => reports,
    focus: () => focus,
    asks,
    ...(opts.teammates ? { teammates: () => opts.teammates } : {}),
  });
  const call = async (caller: Session, tool: string, args: Record<string, unknown>) => {
    const answer = (await router.mcp({ harness: caller.harness, ...(caller.native.pid ? { ppid: caller.native.pid } : {}) }, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: tool, arguments: args, ...(caller.harness === "codex" ? { _meta: { threadId: caller.native.id } } : {}) } })) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: answer.result.content[0]!.text, ...(answer.result.isError ? { isError: true } : {}) };
  };
  let seq = 0;
  const event = (session: string, kind: SessionEvent["kind"], payload: Record<string, unknown>) => bus.emit("session.event", { session, seq: seq++, at: 0, kind, payload });
  return { router, asks, store: st, bus, leaders, focus, reports, sent, forwarded, mirrorAsks, call, event };
}

/** A session with a pid, so a tool call is known to come from it. */
let pid = 4000;
const withPid = (s: Session): Session => ({ ...s, native: { ...s.native, pid: pid++ } });

describe("a leader's message", () => {
  test("to a session it leads goes as the user's words, gated as agent.lead, and the leader is told so", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    r.leaders.set(lead.id, [web.id]);
    const a = await r.call(lead, "send_message", { to: "web-codex", text: "Run the login tests and fix what fails." });
    expect(a.isError).toBeUndefined();
    expect(a.text).toContain("as your user's own words");
    const last = r.sent.at(-1)!;
    expect(last.id).toBe(web.id);
    expect(last.text).toBe("Run the login tests and fix what fails.");
    expect(last.opts).toEqual({ from: "lead", lead: { by: expect.objectContaining({ session: lead.id, alias: "api-claude", harness: "claude", nodeName: "Desk" }) } });
    const row = r.store.audit.list({ limit: 10 }).find((e) => e.action === "agent.lead")!;
    expect(row.principal).toEqual({ kind: "harness", session: lead.id });
    expect(row.target).toBe(web.id);
    expect(r.reports.list()).toEqual([{ leader: lead.id, target: web.id, refs: ["cophylad-1"] }]);
  });

  test("skips the focus hold and the parity ask, and still counts against the limits", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web], bypass: { [web.id]: true } });
    r.leaders.set(lead.id, "all");
    r.focus.take(web, 60, "the migration");
    const a = await r.call(lead, "send_message", { to: "web-codex", text: "Stop and commit what you have." });
    expect(a.text).toContain("as your user's own words");
    expect(r.sent.at(-1)!.opts.from).toBe("lead");
    expect(r.asks.listOpen()).toEqual([]);
    // the same words again within the window are refused, as any message's are
    const again = await r.call(lead, "send_message", { to: "web-codex", text: "Stop and commit what you have." });
    expect(again.isError).toBe(true);
    expect(r.sent).toHaveLength(1);
  });

  test("from a session that leads no one, or to one it does not lead, goes as ever, in the envelope", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const other = withPid(sess("claude", "C:/code/docs"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, other, web] });
    r.leaders.set(lead.id, [other.id]);
    await r.call(other, "send_message", { to: "web-codex", text: "the schema is merged" });
    expect(r.sent.at(-1)!.opts).toMatchObject({ from: "agent", agent: { from: { session: other.id } } });
    const a = await r.call(lead, "send_message", { to: "web-codex", text: "and the docs" });
    expect(r.sent.at(-1)!.opts.from).toBe("agent");
    expect(a.text).not.toContain("You lead");
    expect(r.reports.list()).toEqual([]);
  });

  test("to a led session that cannot take the user's words goes as another agent's, and the leader is told why", async () => {
    const lead = withPid(sess("codex", "C:/code/api"));
    const windowed = sess("claude", "C:/code/win", { native: { id: "n", transport: "pipe" } });
    const r = routerRig({ local: [lead, windowed] });
    r.leaders.set(lead.id, "all");
    const a = await r.call(lead, "send_message", { to: "win-claude", text: "status?" });
    expect(r.sent.at(-1)!.opts.from).toBe("agent");
    expect(a.text).toContain("You lead win-claude, but this went as another agent's message");
    expect(a.text).toContain("outside a Cophyla terminal");
  });

  test("to a led session on another machine is forwarded as lead; one with an older Cophyla as an agent's, with why", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("claude", "C:/code/web", { node: LAPTOP });
    const old = sess("codex", "C:/code/old", { node: OLD });
    const r = routerRig({ local: [lead], mirror: [web, old], nodes: [nodeRow(LAPTOP, "Laptop"), nodeRow(OLD, "Studio", {}, {})], linked: new Set([LAPTOP, OLD]) });
    r.leaders.set(lead.id, "all");
    const a = await r.call(lead, "send_message", { to: "web-claude", text: "go on" });
    expect(a.text).toContain("as your user's own words");
    expect(r.forwarded.at(-1)).toEqual({ node: LAPTOP, method: "session.send", params: { id: web.id, text: "go on", as: "lead", lead: { by: expect.objectContaining({ session: lead.id }) } } });
    const b = await r.call(lead, "send_message", { to: "old-codex", text: "go on too" });
    expect(r.forwarded.at(-1)!.params).toMatchObject({ id: old.id, as: "agent" });
    expect(b.text).toContain("Studio runs an older Cophyla");
  });

  test("to a teammate's agent is never the user's words", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const got: string[] = [];
    const teammates: AgentTeammates = { listing: async () => [], names: (to) => to.startsWith("bob/"), send: async (_c, _m, p) => (got.push(p.to), { status: "sent", id: "pmsg_01ARZ3NDEKTSV4RRFFQ69G5FD1", teammate: "tm_01ARZ3NDEKTSV4RRFFQ69G5TM1", alias: p.to }) };
    const r = routerRig({ local: [lead], teammates });
    r.leaders.set(lead.id, "all");
    const a = await r.call(lead, "send_message", { to: "bob/web", text: "hello" });
    expect(got).toEqual(["bob/web"]);
    expect(a.text).not.toContain("your user's own words");
    expect(r.sent).toEqual([]);
  });

  test("that starts with / or ! is refused before anything is sent or counted", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    r.leaders.set(lead.id, [web.id]);
    const slash = await r.call(lead, "send_message", { to: "web-codex", text: "/clear" });
    expect(slash).toEqual({ text: expect.stringContaining("Not sent: a leader's message may not start with /"), isError: true });
    const bang = await r.call(lead, "send_message", { to: "web-codex", text: "\n  !git push --force" });
    expect(bang.text).toContain("shell command");
    expect(r.sent).toEqual([]);
    // the same text sent plainly is not taken for a duplicate of what was refused
    expect((await r.call(lead, "send_message", { to: "web-codex", text: "push when green" })).isError).toBeUndefined();
  });

  test("list_agents marks the sessions the caller leads, with the ask open in each", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web", { status: "needs_permission", ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    const docs = sess("claude", "C:/code/docs");
    const r = routerRig({ local: [lead, web, docs] });
    r.leaders.set(lead.id, [web.id]);
    const rows = await r.router.list(lead);
    expect(rows.find((x) => x.session === web.id)).toMatchObject({ led: true, ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    expect(rows.find((x) => x.session === docs.id)?.led).toBeUndefined();
    const text = (await r.call(lead, "list_agents", {})).text;
    expect(text).toContain("web-codex: Codex on Desk, in web, needs permission, led by you, asking (ask_01ARZ3NDEKTSV4RRFFQ69G5FB7)");
    expect(text).toContain("reach it as your user's own words");
    expect((await r.call(withPid(docs), "list_agents", {})).text).not.toContain("led by you");
  });
});

// --- answer_ask --------------------------------------------------------------------------------

describe("answer_ask", () => {
  const options = [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ];

  test("answers an ask of a session the caller leads as the user, here or where the ask is", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const far = sess("claude", "C:/code/far", { node: LAPTOP });
    const r = routerRig({ local: [lead, web], mirror: [far], nodes: [nodeRow(LAPTOP, "Laptop")], linked: new Set([LAPTOP]) });
    r.leaders.set(lead.id, "all");
    const ask = r.asks.open({ type: "permission", source: { kind: "harness", session: web.id }, title: "Run npm test?", options, answerableBy: ["user", "brain"] }, 1, DESK);
    const a = await r.call(lead, "answer_ask", { ask: ask.id, option: "allow" });
    expect(a).toEqual({ text: `Answered ${ask.id} in web-codex as your user: Allow.` });
    expect(r.asks.get(ask.id)).toMatchObject({ status: "answered", answer: { option: "allow", by: { kind: "harness", session: lead.id } } });
    expect(r.store.audit.list({ limit: 10 }).some((e) => e.action === "agent.answer" && e.target === ask.id)).toBe(true);
    // one on another machine is answered there, as the brain's answers are
    const away = { ...ask, id: "ask_01ARZ3NDEKTSV4RRFFQ69G5FC1", node: LAPTOP, source: { kind: "harness" as const, session: far.id }, status: "open" as const };
    delete (away as { answer?: unknown }).answer;
    r.mirrorAsks.set(away.id, away);
    expect((await r.call(lead, "answer_ask", { ask: away.id, option: "deny" })).isError).toBeUndefined();
    expect(r.forwarded.at(-1)).toEqual({ node: LAPTOP, method: "ask.answer", params: { id: away.id, option: "deny" } });
  });

  test("is refused unless the caller leads the session, the ask is its harness's, open, and one the user answers", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const other = withPid(sess("claude", "C:/code/docs"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, other, web] });
    r.leaders.set(lead.id, [web.id]);
    const harness = r.asks.open({ type: "permission", source: { kind: "harness", session: web.id }, title: "Run npm test?", options, answerableBy: ["user"] }, 1, DESK);
    expect(await r.call(other, "answer_ask", { ask: harness.id, option: "allow" })).toEqual({ text: "Not answered: you do not lead web-codex, so its asks are your user's alone.", isError: true });
    const gateAsk = r.asks.open({ type: "permission", source: { kind: "gate", action: "session.spawn", principal: { kind: "brain" } }, title: "Start?", options, answerableBy: ["user"] }, 1, DESK);
    expect((await r.call(lead, "answer_ask", { ask: gateAsk.id, option: "allow" })).text).toContain("not an agent session's ask");
    const brainOnly = r.asks.open({ type: "permission", source: { kind: "harness", session: web.id }, title: "x", options, answerableBy: ["brain"] }, 1, DESK);
    expect((await r.call(lead, "answer_ask", { ask: brainOnly.id, option: "allow" })).text).toContain("not one your user answers");
    expect((await r.call(lead, "answer_ask", { ask: harness.id, option: "maybe" })).text).toContain("has no option maybe: its options are allow (Allow), deny (Deny)");
    expect((await r.call(lead, "answer_ask", { ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FC9", option: "allow" })).text).toContain("no ask ask_01ARZ3NDEKTSV4RRFFQ69G5FC9");
    expect((await r.call(lead, "answer_ask", { ask: "nope", option: "allow" })).text).toContain("answer_ask needs ask");
    r.asks.answer(harness.id, { option: "deny" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
    expect((await r.call(lead, "answer_ask", { ask: harness.id, option: "allow" })).text).toContain("is answered already");
    expect(r.asks.get(harness.id)!.answer!.option).toBe("deny");
  });

  test("from a secondary's leader comes up the link, checked against the node that asked", async () => {
    const lead = sess("claude", "C:/code/api", { node: LAPTOP });
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [web], mirror: [lead], nodes: [nodeRow(LAPTOP, "Laptop")], linked: new Set([LAPTOP]), grants: { grt_1: { scopes: [], messages: "send" } } });
    r.leaders.set(lead.id, "all");
    const ask = r.asks.open({ type: "permission", source: { kind: "harness", session: web.id }, title: "Run npm test?", options, answerableBy: ["user"] }, 1, DESK);
    const answered = await r.router.upwardRequest({ id: LAPTOP, grant: "grt_1" }, "agent.answer", { caller: lead.id, ask: ask.id, option: "allow" });
    expect(answered).toEqual({ text: `Answered ${ask.id} in web-codex as your user: Allow.` });
    await expect(r.router.upwardRequest({ id: OLD, grant: "grt_1" }, "agent.answer", { caller: lead.id, ask: ask.id, option: "allow" })).rejects.toMatchObject({ code: "denied" });
  });
});

// --- reports -------------------------------------------------------------------------------------

describe("what a led session does next", () => {
  async function sentTo(r: ReturnType<typeof routerRig>, lead: Session, web: Session, text = "Run the tests.") {
    r.leaders.set(lead.id, [web.id]);
    await r.call(lead, "send_message", { to: "web-codex", text });
    const ref = r.reports.list()[0]!.refs.at(-1)!;
    const before = r.sent.length;
    return { ref, before, toLeader: () => r.sent.slice(before).filter((x) => x.id === lead.id) };
  }

  test("its last words reach the leader in its envelope once it settles after the message landed, and the watch closes", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    const { ref, toLeader } = await sentTo(r, lead, web);
    // an idle before the message landed is no settle
    r.event(web.id, "status", { status: "idle", lastAssistantMessage: "earlier work" });
    await sleep(60);
    expect(toLeader()).toEqual([]);
    r.event(web.id, "user_turn", { text: "Run the tests.", source: "lead", ref });
    r.event(web.id, "status", { status: "busy" });
    r.event(web.id, "status", { status: "idle", lastAssistantMessage: "14 passed, 0 failed." });
    // a second idle with no words keeps the first one's
    r.event(web.id, "status", { status: "idle" });
    await waitFor(() => toLeader().length > 0, 2000);
    const told = toLeader();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toBe("14 passed, 0 failed.");
    expect(told[0]!.opts).toMatchObject({ from: "agent", agent: { from: { session: web.id, alias: "web-codex" } } });
    expect((told[0]!.opts.agent as { replyTo?: string }).replyTo).toMatch(/^pmsg_/);
    expect(r.reports.list()).toEqual([]);
  });

  test("a busy period after an idle means it went on: only the idle that holds is heard", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    const { ref, toLeader } = await sentTo(r, lead, web);
    r.event(web.id, "notification", { type: "message", ref, state: "delivered" });
    r.event(web.id, "status", { status: "idle", lastAssistantMessage: "halfway" });
    r.event(web.id, "status", { status: "busy" });
    await sleep(80);
    expect(toLeader()).toEqual([]);
    // waiting on its own shells is no settle either
    r.event(web.id, "status", { status: "idle", waiting: { on: "shell" } });
    await sleep(80);
    expect(toLeader()).toEqual([]);
    r.event(web.id, "status", { status: "idle", lastAssistantMessage: "all done" });
    await waitFor(() => toLeader().length > 0, 2000);
    await sleep(60);
    expect(toLeader().map((x) => x.text)).toEqual(["all done"]);
  });

  test("an ask it raises reaches the leader as a notice with its id and options, once", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    const { toLeader } = await sentTo(r, lead, web);
    const ask = r.asks.open({ type: "permission", source: { kind: "harness", session: web.id }, title: "Run npm test?", detail: "npm test -- --watch=false", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }], answerableBy: ["user", "brain"] }, 1, DESK);
    await waitFor(() => toLeader().length > 0, 2000);
    r.bus.emit("ask.state", ask);
    await sleep(30);
    const told = toLeader();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toBe(askNotice("web-codex", ask));
    expect(told[0]!.text).toContain(`answer_ask (ask ${ask.id})`);
    expect(told[0]!.text).toContain("allow (Allow), deny (Deny)");
    // a notice from cophyla: no sender
    expect((told[0]!.opts.agent as { from?: unknown }).from).toBeUndefined();
  });

  test("a message withdrawn is told as not delivered; the session's end is told; the leader's end drops its watches", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    const first = await sentTo(r, lead, web);
    r.event(web.id, "notification", { type: "message", ref: first.ref, state: "withdrawn", message: "the session's prompt was never free to type into" });
    await waitFor(() => first.toLeader().length > 0, 2000);
    expect(first.toLeader()[0]!.text).toMatch(/^Your message pmsg_\w+ to web-codex was not delivered: the session's prompt was never free to type into\.$/);
    expect(r.reports.list()).toEqual([]);
    const second = await sentTo(r, lead, web, "Try again.");
    r.bus.emit("session.state", { ...web, status: "ended", endedAt: 9 });
    await waitFor(() => second.toLeader().length > 0, 2000);
    expect(second.toLeader()[0]!.text).toBe("web-codex ended.");
    expect(r.reports.list()).toEqual([]);
    await sentTo(r, lead, web, "Once more.");
    r.bus.emit("session.state", { ...lead, status: "ended", endedAt: 10 });
    expect(r.reports.list()).toEqual([]);
  });

  test("what the session does before its send is answered is heard once the ref is known", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    r.leaders.set(lead.id, [web.id]);
    const going = r.reports.begin(lead.id, web.id);
    r.event(web.id, "user_turn", { text: "go", source: "lead", ref: "cophylad-early" });
    r.event(web.id, "assistant_text", { text: "On it. Done." });
    r.event(web.id, "status", { status: "idle", stopReason: "end_turn" });
    await sleep(60);
    expect(r.sent).toEqual([]);
    going.sent("cophylad-early", "pmsg_01ARZ3NDEKTSV4RRFFQ69G5FD1");
    await waitFor(() => r.sent.length > 0, 2000);
    // a harness whose idle says no words: the last text it wrote
    expect(r.sent[0]).toMatchObject({ id: lead.id, text: "On it. Done.", opts: { agent: { from: { session: web.id }, replyTo: "pmsg_01ARZ3NDEKTSV4RRFFQ69G5FD1" } } });
    // a send that fails leaves no watch behind
    r.reports.begin(lead.id, web.id).failed();
    expect(r.reports.list()).toEqual([]);
  });

  test("a leader the user stops leading hears no more of it", async () => {
    const lead = withPid(sess("claude", "C:/code/api"));
    const web = sess("codex", "C:/code/web");
    const r = routerRig({ local: [lead, web] });
    await sentTo(r, lead, web);
    r.leaders.remove(lead.id);
    expect(r.reports.list()).toEqual([]);
  });
});

