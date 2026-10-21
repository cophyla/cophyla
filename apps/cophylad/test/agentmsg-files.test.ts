// An agent's `send_file`, on the router, over a real gate with fake sessions, a fake cluster
// and a fake way to start transfers. A session that runs without prompts sends unasked; one
// that prompts is asked about first, as the built-in rule says, unless the user's rule allows
// it; a big one over the relay asks the user too, whatever the session. It goes to an agent
// session (told where it landed) or a machine by its name, from a path under the caller's
// folder or an absolute one, into the Downloads folder or the folder named; what lands soon
// is answered, what takes longer is told later. A machine on an older Cophyla, one that is
// away, and a relative folder for a machine are refused. `list_agents` names the machines.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { Access, NodeRecord, Session, Transfer } from "@cophyla/protocol";
import { AgentMessages } from "../src/agentmsg/index.ts";
import type { AgentCluster, AgentFiles, AgentSessions } from "../src/agentmsg/index.ts";
import { Bus } from "../src/bus.ts";
import { Config } from "../src/config/schema.ts";
import { Asks } from "../src/gate/asks.ts";
import { Audit } from "../src/gate/audit.ts";
import { Gate } from "../src/gate/index.ts";
import { Policy } from "../src/gate/policy.ts";
import { silentLogger } from "../src/log.ts";
import type { SendOptions } from "../src/sessions/index.ts";
import { Store } from "../src/store/index.ts";
import { sleep, waitFor } from "./helpers.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OLD = "node_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const USER = { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" } as const;

let started = 1_000;
function sess(harness: Session["harness"], cwd: string, extra: Partial<Session> = {}): Session {
  return {
    id: newId("session"),
    node: DESK,
    harness,
    profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
    native: { id: crypto.randomUUID(), transport: harness === "codex" ? "app-server" : "pipe" },
    origin: "user",
    cwd,
    tags: [],
    status: "idle",
    startedAt: started++,
    lastActivity: 0,
    ...extra,
  };
}

function node(id: string, name: string, extra: Partial<NodeRecord> = {}, files = true): NodeRecord {
  return { id, name, role: "secondary", status: "online", via: "direct", platform: "linux", scope: { kind: "machine" }, capabilities: { harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false, agents: { acceptInBypass: false }, ...(files ? { files: true } : {}) }, versions: { platform: "0.17.0", protocol: 1 }, lastSeen: 0, endpoints: [], ...extra } as NodeRecord;
}

interface FakeFiles extends AgentFiles {
  peeked: { node: string; path: string }[];
  started: Parameters<AgentFiles["start"]>[0][];
  /** The first start of a big one is answered `confirm`. */
  confirm: boolean;
  /** How long a transfer takes to land. */
  takesMs: number;
  outcome: Partial<Transfer>;
}

function fakeFiles(): FakeFiles {
  const f: FakeFiles = {
    peeked: [],
    started: [],
    confirm: false,
    takesMs: 0,
    outcome: {},
    peek: async (n, path) => {
      f.peeked.push({ node: n, path });
      if (path.endsWith("missing.zip")) throw Object.assign(new Error(`${path}: no such file or folder`), { code: "not_found" });
      return { kind: "file", name: path.split(/[\\/]/).at(-1)!, total: 48 * 1024 * 1024, files: 1 };
    },
    start: async (p) => {
      f.started.push(p);
      if (f.confirm && !p.relayOk) return { confirm: { bytes: 3_200_000_000, relayHops: [LAPTOP] } };
      return { transfer: { id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", from: p.from, to: { node: p.to.node, dir: p.to.dir ?? "/home/me/Downloads" }, kind: "file", name: "build.zip", total: 48 * 1024 * 1024, bytes: 0, state: "queued", by: p.by, startedAt: 1 } };
    },
    ended: async (id) => {
      await sleep(f.takesMs);
      const dir = f.started.at(-1)?.to.dir ?? "/home/me/Downloads";
      return { id, from: { node: DESK, path: "x" }, to: { node: LAPTOP, dir, path: `${dir}/build.zip` }, kind: "file", name: "build.zip", total: 48 * 1024 * 1024, bytes: 48 * 1024 * 1024, state: "done", by: { kind: "user" }, startedAt: 1, ...f.outcome } as Transfer;
    },
  };
  return f;
}

interface Rig {
  router: AgentMessages;
  asks: Asks;
  store: Store;
  files: FakeFiles;
  sent: { id: string; text: string; opts: SendOptions }[];
  forwarded: { node: string; params: Record<string, unknown> }[];
  call(caller: Session, tool: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

function rig(opts: { toml?: string; local: Session[]; mirror?: Session[]; nodes?: NodeRecord[]; bypass?: Record<string, boolean>; linked?: Set<string>; grants?: Record<string, Access>; toolWaitMs?: number }): Rig {
  const config = Config.parse(Bun.TOML.parse(opts.toml ?? ""));
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const asks = new Asks(store, DESK, bus);
  const audit = new Audit(store, DESK, config.gate.audit_result_cap, bus);
  const policy = new Policy(config.gate, store);
  const gate = new Gate({ config: config.gate, policy, asks, audit, log: silentLogger });
  const sent: Rig["sent"] = [];
  const forwarded: Rig["forwarded"] = [];
  const sessions: AgentSessions = {
    list: () => opts.local.filter((s) => s.status !== "ended"),
    get: (id) => opts.local.find((s) => s.id === id),
    send: async (id, text, o) => {
      sent.push({ id, text, opts: o });
      return { status: "queued", ref: "cophylad-1" };
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
    forward: async (n, _method, params) => {
      forwarded.push({ node: n, params: params as Record<string, unknown> });
      return { status: "queued", ref: "cophylad-2" };
    },
    requestPrimary: async () => {
      throw new Error("no primary in this rig");
    },
    grant: (id) => (opts.grants?.[id] ? { access: opts.grants[id]! } : undefined),
  };
  const files = fakeFiles();
  const router = new AgentMessages({ config: () => config.agent_messages, self: () => ({ id: DESK, name: "Desk" }), sessions, cluster, gate, log: silentLogger, version: "test", files: () => files, asks, ...(opts.toolWaitMs !== undefined ? { toolWaitMs: opts.toolWaitMs } : {}) });
  const call: Rig["call"] = async (caller, tool, args, meta) => {
    const answer = (await router.mcp({ harness: caller.harness, ...(caller.native.pid ? { ppid: caller.native.pid } : {}) }, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) } })) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: answer.result.content[0]!.text, ...(answer.result.isError ? { isError: true } : {}) };
  };
  return { router, asks, store, files, sent, forwarded, call };
}

describe("send_file", () => {
  test("list_agents names the machines a file can go to: this one, one away, one on an older Cophyla", async () => {
    const me = sess("claude", "C:/work/web", { native: { id: "c-me", pid: 4100, transport: "pipe" }, name: "web" });
    const r = rig({ local: [me], nodes: [node(DESK, "Desk"), node(LAPTOP, "Laptop", { status: "offline" }), node(OLD, "Studio", {}, false)], linked: new Set([OLD]) });
    const text = (await r.call(me, "list_agents", {})).text;
    expect(text).toContain("Machines (send_file with to set to the name): Desk (yours), Laptop (offline), Studio (runs an older Cophyla, which takes no files).");
  });

  test("a session that runs without prompts sends to an agent unasked, from under its folder; the agent is named to be told", async () => {
    const me = sess("claude", "C:\\work\\web", { native: { id: "c-me", pid: 4100, transport: "pipe" }, name: "web" });
    const remote = sess("codex", "/home/me/api", { node: LAPTOP });
    const r = rig({ local: [me], mirror: [remote], nodes: [node(DESK, "Desk", { role: "primary", platform: "windows" }), node(LAPTOP, "Laptop")], linked: new Set([LAPTOP]), bypass: { [me.id]: true } });
    const answer = await r.call(me, "send_file", { path: "dist\\build.zip", to: "api-codex" });
    expect(answer.isError).toBeUndefined();
    expect(answer.text).toBe("Sent build.zip (48 MB) to api-codex on Laptop: it landed at /home/me/Downloads/build.zip. api-codex was told where it landed.");
    expect(r.asks.listOpen()).toEqual([]);
    expect(r.files.peeked).toEqual([{ node: DESK, path: "C:\\work\\web\\dist\\build.zip" }]);
    expect(r.files.started).toEqual([{ from: { node: DESK, path: "C:\\work\\web\\dist\\build.zip" }, to: { node: LAPTOP }, by: { kind: "agent", alias: "web", session: me.id }, notify: remote.id }]);
    const row = r.store.audit.list({ limit: 10 }).find((e) => e.action === "transfer.send")!;
    expect(row).toMatchObject({ principal: { kind: "harness", session: me.id }, decision: "allow", target: LAPTOP, outcome: "ok" });
  });

  test("a session that prompts is asked about first; a relative folder is under the receiving agent's", async () => {
    const me = sess("claude", "C:/work/web", { native: { id: "c-me", pid: 4100, transport: "pipe" }, name: "web" });
    const remote = sess("codex", "/home/me/api", { node: LAPTOP });
    const r = rig({ local: [me], mirror: [remote], nodes: [node(DESK, "Desk", { role: "primary", platform: "windows" }), node(LAPTOP, "Laptop")], linked: new Set([LAPTOP]), bypass: { [me.id]: false } });
    const pending = r.call(me, "send_file", { path: "C:/work/web/build.zip", to: "api-codex", dir: "incoming" });
    const ask = await waitFor(() => r.asks.listOpen()[0]);
    expect(ask.title).toBe("Let web send build.zip (48 MB) to api-codex on Laptop?");
    expect(ask.detail).toBe("C:/work/web/build.zip on Desk, into /home/me/api/incoming on Laptop.");
    expect(r.files.started).toEqual([]);
    r.asks.answer(ask.id, { option: "allow" }, USER);
    const answer = await pending;
    expect(answer.text).toBe("Sent build.zip (48 MB) to api-codex on Laptop: it landed at /home/me/api/incoming/build.zip. api-codex was told where it landed.");
    expect(r.files.started[0]!.to).toEqual({ node: LAPTOP, dir: "/home/me/api/incoming" });
  });

  test("denied, nothing is sent; the user's own rule may let a prompting session send unasked", async () => {
    const me = sess("claude", "C:/work/web", { native: { id: "c-me", pid: 4100, transport: "pipe" }, name: "web" });
    const r = rig({ local: [me], nodes: [node(LAPTOP, "Laptop")], linked: new Set([LAPTOP]) });
    const pending = r.call(me, "send_file", { path: "C:/work/web/build.zip", to: "Laptop" });
    const ask = await waitFor(() => r.asks.listOpen()[0]);
    r.asks.answer(ask.id, { option: "deny" }, USER);
    const refused = await pending;
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Not sent: denied/);
    expect(r.files.started).toEqual([]);
    const allowed = rig({ local: [me], nodes: [node(LAPTOP, "Laptop")], linked: new Set([LAPTOP]), toml: `[gate.rules]\n"harness:transfer.send" = "allow"\n` });
    expect((await allowed.call(me, "send_file", { path: "C:/work/web/build.zip", to: "laptop", dir: "/srv/in" })).text).toBe("Sent build.zip (48 MB) to Laptop: it landed at /srv/in/build.zip.");
    expect(allowed.files.started[0]).toMatchObject({ to: { node: LAPTOP, dir: "/srv/in" } });
    expect(allowed.files.started[0]!.notify).toBeUndefined();
  });

  test("a big one through the relay asks the user even for a session that runs without prompts", async () => {
    const me = sess("claude", "C:/work/web", { native: { id: "c-me", pid: 4100, transport: "pipe" }, name: "web" });
    const r = rig({ local: [me], nodes: [node(LAPTOP, "Laptop")], linked: new Set([LAPTOP]), bypass: { [me.id]: true } });
    r.files.confirm = true;
    const pending = r.call(me, "send_file", { path: "C:/work/web/movie.mkv", to: "Laptop" });
    const ask = await waitFor(() => r.asks.listOpen()[0]);
    expect(ask.title).toBe("Send movie.mkv (48 MB) through the relay?");
    expect(ask.answerableBy).toEqual(["user"]);
    r.asks.answer(ask.id, { option: "allow" }, USER);
    expect((await pending).text).toContain("Sent movie.mkv");
    expect(r.files.started.map((p) => p.relayOk === true)).toEqual([false, true]);
  });

  test("what takes longer is answered at once, and how it went is told later", async () => {
    const me = sess("claude", "C:/work/web", { native: { id: "c-me", pid: 4100, transport: "pipe" }, name: "web" });
    const r = rig({ local: [me], nodes: [node(LAPTOP, "Laptop")], linked: new Set([LAPTOP]), bypass: { [me.id]: true }, toolWaitMs: 30 });
    r.files.takesMs = 150;
    r.files.outcome = { state: "failed", error: "the disk is full" };
    const answer = await r.call(me, "send_file", { path: "C:/work/web/build.zip", to: "Laptop" });
    expect(answer.text).toBe("Sending build.zip (48 MB) to Laptop. You will be told by a message from cophyla when it lands.");
    const notice = await waitFor(() => r.sent.find((s) => s.id === me.id));
    expect(notice.text).toBe("Not sent: build.zip (48 MB) did not reach Laptop: the disk is full. What came of it is kept there until the user retries or dismisses it in Cophyla.");
  });

  test("an older machine, one away, a relative folder for a machine, a missing file and no one are refused", async () => {
    const me = sess("claude", "C:/work/web", { native: { id: "c-me", pid: 4100, transport: "pipe" }, name: "web" });
    const r = rig({ local: [me], nodes: [node(LAPTOP, "Laptop"), node(OLD, "Studio", {}, false)], linked: new Set([OLD]), bypass: { [me.id]: true } });
    expect(await r.call(me, "send_file", { path: "a.zip", to: "Studio" })).toEqual({ text: "Not sent: Studio runs an older Cophyla: update it to receive files.", isError: true });
    expect((await r.call(me, "send_file", { path: "a.zip", to: "Laptop" })).text).toContain("Laptop is offline; not sent.");
    const linked = rig({ local: [me], nodes: [node(LAPTOP, "Laptop")], linked: new Set([LAPTOP]), bypass: { [me.id]: true } });
    expect((await linked.call(me, "send_file", { path: "a.zip", to: "Laptop", dir: "in" })).text).toBe("Not sent: dir is an absolute path on Laptop when to is a machine.");
    expect((await linked.call(me, "send_file", { path: "missing.zip", to: "Laptop" })).text).toContain("no such file");
    expect((await linked.call(me, "send_file", { path: "a.zip", to: "nobody" })).text).toContain('no agent session or machine is called "nobody"');
    expect((await linked.call(me, "send_file", { path: "a.zip", to: "web" })).text).toContain("that is this session");
    expect((await linked.call(me, "send_file", { to: "Laptop" })).text).toBe("send_file needs path: the file or folder on this machine.");
    expect(linked.files.started).toEqual([]);
  });

  test("a secondary's session sends through the primary, as itself, as far as the node's grant goes", async () => {
    const remote = sess("claude", "/home/me/app", { node: LAPTOP, name: "app" });
    const r = rig({ local: [], mirror: [remote], nodes: [node(DESK, "Desk", { role: "primary", platform: "windows" }), node(LAPTOP, "Laptop", { platform: "linux" })], linked: new Set([LAPTOP]), grants: { grt_01ARZ3NDEKTSV4RRFFQ69G5FC1: { scopes: ["sessions:read"], messages: "send" } } });
    const answer = (await r.router.upwardRequest({ id: LAPTOP, grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FC1" }, "file.send", { caller: remote.id, mode: "bypass", path: "out/report.pdf", to: "Desk", dir: "C:\\Users\\me\\Desktop" })) as { text: string; isError?: boolean };
    expect(answer.isError).toBeUndefined();
    expect(r.files.started[0]).toMatchObject({ from: { node: LAPTOP, path: "/home/me/app/out/report.pdf" }, to: { node: DESK, dir: "C:\\Users\\me\\Desktop" }, by: { kind: "agent", alias: "app", session: remote.id } });
    // a session the node does not hold, or a node with no grant here, is refused
    await expect(r.router.upwardRequest({ id: OLD, grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FC1" }, "file.send", { caller: remote.id, mode: "bypass", path: "x", to: "Desk" })).rejects.toThrow("not a live session of the asking node");
    await expect(r.router.upwardRequest({ id: LAPTOP }, "file.send", { caller: remote.id, mode: "bypass", path: "x", to: "Desk" })).rejects.toThrow("grant is not known");
  });
});
