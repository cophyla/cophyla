// What a workspace node owns on the machine, stamped when it is made and kept apart after: a
// session discovered in the lent folder is the workspace node's, one started into a workspace
// is that workspace's node's; neither the session, its workspace, its asks nor its events
// reach any of the machine's default ways in (a list, a read by id, a message, a stop, an
// annotation, an answer, `on`), and what is refused there is refused as if it did not exist.
// The workspace node's own view answers its own and nothing of the machine's; its ask,
// answered through that view, releases the held hook. A job never merges across the two,
// and nothing of the machine's starts in the lent folder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId, RpcError } from "@cophyla/protocol";
import type { Ask, ClaudeHookEvent, Session, SessionEvent, Workspace } from "@cophyla/protocol";
import { Gate } from "../src/gate/index.ts";
import { Audit } from "../src/gate/audit.ts";
import { Policy } from "../src/gate/policy.ts";
import { silentLogger } from "../src/log.ts";
import { Owners } from "../src/nodes/owners.ts";
import type { HarnessAdapter, HookInstallSpec, NormalisedHook, SessionRecord } from "../src/sessions/model.ts";
import { TerminalRows } from "../src/sessions/tether/streams.ts";
import type { Tether } from "../src/sessions/tether/index.ts";
import { miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const FAKE_AGENT = join(import.meta.dir, "fakes", "acp-agent.ts");
const G = newId("node");
const P2 = newId("node");
const CLIENT = "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7";

class NullAdapter implements HarnessAdapter {
  readonly harness = "claude" as const;
  async start(_p: unknown, _h: HookInstallSpec | undefined): Promise<void> {}
  async stop(): Promise<void> {}
  async tick(): Promise<void> {}
  async send(): Promise<{ status: "queued" }> {
    return { status: "queued" };
  }
  onHook(_hook: NormalisedHook, rec: SessionRecord | undefined): SessionRecord | undefined {
    return rec;
  }
}

let mini: Mini;
let owners: Owners;
let lent: string;
let mine: string;
let scratch: string;
let profile: string;
const asks: Ask[] = [];
const machineHeard: { name: string; id: string }[] = [];
const guestHeard: { name: string; id: string }[] = [];

beforeAll(async () => {
  scratch = tempHome();
  lent = join(scratch, "work", "lent");
  mine = join(scratch, "work", "mine");
  const configDir = join(scratch, "claude-home");
  for (const dir of [join(lent, "src"), mine, configDir]) mkdirSync(dir, { recursive: true });
  owners = new Owners({ guests: [{ id: G, folder: lent }], cophylaHome: join(scratch, ".cophyla"), home: join(scratch, "home") });
  const toml = `[sessions]\ndiscover = false\ninstall_hooks = false\nlaunch = "acp"\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n[acp]\nspawn_timeout_ms = 10000\n[acp.claude]\ncommand = ${tomlString(FAKE_AGENT)}\n`;
  mini = await miniSessions(toml, () => [new NullAdapter()], { acp: (config) => ({ config: config.acp, env: { ...process.env } }), owners });
  profile = mini.profiles.defaultFor("claude")!.id;
  mini.bus.onAll("ask.state", (a) => asks.push(a));
  for (const name of ["session.state", "session.event", "workspace.state", "ask.state"] as const) {
    mini.bus.on(name, (p) => machineHeard.push({ name, id: (p as { id?: string; session?: string }).id ?? (p as { session: string }).session }));
    mini.bus.for(G).on(name, (p) => guestHeard.push({ name, id: (p as { id?: string; session?: string }).id ?? (p as { session: string }).session }));
  }
}, 30_000);

afterAll(async () => {
  await mini.stop();
});

function attached(nativeId: string, cwd: string, pid: number): Session {
  return mini.sessions.ensure({ harness: "claude", nativeId, profile, cwd, transport: "pipe", pid, status: "busy", title: nativeId, transcriptPath: join(cwd, `${nativeId}.jsonl`) }).session;
}

function hook(nativeId: string, cwd: string, event: ClaudeHookEvent["hook_event_name"], extra: Record<string, unknown> = {}): ClaudeHookEvent {
  return { session_id: nativeId, transcript_path: join(cwd, `${nativeId}.jsonl`), cwd, hook_event_name: event, ...extra } as ClaudeHookEvent;
}

const refusal = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return "ok";
  } catch (e) {
    return e instanceof RpcError ? `${e.code}: ${e.message}` : String(e);
  }
};

describe("stamped when made", () => {
  test("a session discovered in the lent folder is the workspace node's, with its workspace; one outside is the machine's", () => {
    const g = attached("in-lent", join(lent, "src"), 7001);
    const m = attached("in-mine", mine, 7002);
    expect(g.node).toBe(G);
    expect(m.node).toBe(mini.sessions.nodeId);
    const gws = mini.workspaces.getAny(g.workspace!)!;
    expect(gws.node).toBe(G);
    expect(gws.path.toLowerCase()).toContain("lent");
    expect(mini.workspaces.getAny(m.workspace!)!.node).toBe(mini.sessions.nodeId);
  });

  test("a session started into a workspace is its workspace's node's, and headless", async () => {
    const gws = mini.workspaces.view(G).put({ node: G, path: lent, name: "lent" });
    expect(gws.node).toBe(G);
    const spawned = await mini.sessions.view(G).spawn({ harness: "claude", workspace: gws.id, prompt: "hello from the other cluster" }, { profiles: mini.profiles });
    expect(spawned.node).toBe(G);
    expect(spawned.native.transport).toBe("acp");
    await waitFor(() => mini.sessions.view(G).get(spawned.id)?.status === "idle", 10_000);
    const mws = mini.workspaces.put({ node: mini.sessions.nodeId, path: mine, name: "mine" });
    const own = await mini.sessions.spawn({ harness: "claude", workspace: mws.id, prompt: "mine" }, { profiles: mini.profiles });
    expect(own.node).toBe(mini.sessions.nodeId);
    // each view's spawn knows its own workspaces alone
    expect(await refusal(() => mini.sessions.spawn({ harness: "claude", workspace: gws.id, prompt: "x" }, { profiles: mini.profiles }))).toBe(`not_found: no workspace ${gws.id}`);
    expect(await refusal(() => mini.sessions.view(G).spawn({ harness: "claude", workspace: mws.id, prompt: "x" }, { profiles: mini.profiles }))).toBe(`not_found: no workspace ${mws.id}`);
  }, 30_000);
});

describe("kept apart", () => {
  test("the machine's ways in see nothing of the workspace node's; its view sees nothing of the machine's", async () => {
    const g = mini.sessions.view(G).list().find((s) => s.native.id === "in-lent")!;
    const m = mini.sessions.list().find((s) => s.native.id === "in-mine")!;
    expect(g).toBeDefined();
    expect(m).toBeDefined();
    expect(mini.sessions.list().some((s) => s.node === G)).toBe(false);
    expect(mini.sessions.view(G).list().every((s) => s.node === G)).toBe(true);
    expect(mini.sessions.get(g.id)).toBeUndefined();
    expect(mini.sessions.getAny(g.id)?.id).toBe(g.id);
    expect(mini.sessions.view(G).get(m.id)).toBeUndefined();
    const none = `not_found: no session ${g.id}`;
    expect(await refusal(() => mini.sessions.history(g.id))).toBe(none);
    expect(await refusal(() => mini.sessions.annotate(g.id, { intent: "peek" }))).toBe(none);
    expect(await refusal(() => mini.sessions.send(g.id, "hi"))).toBe(none);
    expect(await refusal(() => mini.sessions.stopSession(g.id, { as: "user" }))).toBe(none);
    expect(await refusal(() => mini.sessions.view(G).history(m.id))).toBe(`not_found: no session ${m.id}`);
    expect(mini.sessions.view(G).history(g.id).length).toBeGreaterThan(0);
    // its pids are its own
    expect([...mini.sessions.pids().values()]).not.toContain(g.id);
    expect([...mini.sessions.view(G).pids().values()]).toContain(g.id);
    expect([...mini.sessions.view(G).pids().values()].every((id) => mini.sessions.getAny(id)?.node === G)).toBe(true);
    expect([...mini.sessions.pidsAll().values()]).toContain(g.id);
    // workspaces
    const gws = mini.workspaces.getAny(g.workspace!)!;
    expect(mini.workspaces.list().some((w) => w.node === G)).toBe(false);
    expect(mini.workspaces.get(gws.id)).toBeUndefined();
    expect(mini.workspaces.view(G).list().map((w) => w.id)).toContain(gws.id);
    expect(await refusal(() => mini.workspaces.annotate(gws.id, { summary: "peek" }))).toBe(`not_found: no workspace ${gws.id}`);
    // what the bus told the machine: its own alone
    const guestIds = new Set([g.id, gws.id, ...mini.sessions.view(G).list().map((s) => s.id), ...mini.workspaces.view(G).list().map((w) => w.id)]);
    expect(machineHeard.filter((h) => guestIds.has(h.id))).toEqual([]);
    expect(guestHeard.some((h) => h.id === g.id)).toBe(true);
    expect(guestHeard.filter((h) => h.id === m.id)).toEqual([]);
  });

  test("a workspace node's ask is its own; answered through its view, it releases the held hook", async () => {
    const g = mini.sessions.view(G).list().find((s) => s.native.id === "in-lent")!;
    const cwd = join(lent, "src");
    const decision = mini.sessions.onHook("claude", hook("in-lent", cwd, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }), { via: "http" });
    const ask = await waitFor(() => asks.find((a) => a.status === "open" && a.source.kind === "harness" && a.source.session === g.id), 5000);
    expect(ask.node).toBe(G);
    expect(mini.asks.get(ask.id)).toBeUndefined();
    expect(mini.asks.listOpen().some((a) => a.id === ask.id)).toBe(false);
    expect(mini.asks.listOpenAll().some((a) => a.id === ask.id)).toBe(true);
    expect(mini.asks.view(G).listOpen().map((a) => a.id)).toEqual([ask.id]);
    expect(await refusal(() => mini.asks.answer(ask.id, { option: "allow" }, { kind: "user", client: CLIENT }))).toBe(`not_found: no ask ${ask.id}`);
    mini.asks.view(G).answer(ask.id, { option: "allow" }, { kind: "node", id: P2 });
    const out = (await decision) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(machineHeard.filter((h) => h.id === ask.id)).toEqual([]);
    expect(guestHeard.filter((h) => h.id === ask.id).length).toBeGreaterThan(0);
  });

  test("a gate built for the workspace node stamps its asks and audit rows with it", async () => {
    const audit = new Audit(mini.store, mini.sessions.nodeId, 1024, mini.bus);
    const gate = new Gate({ config: mini.config.gate, policy: new Policy(mini.config.gate, mini.store), asks: mini.asks, audit, log: silentLogger, node: G });
    const entries: string[] = [];
    const offMachine = mini.bus.on("audit.entry", (e) => entries.push(`machine ${e.node}`));
    const offGuest = mini.bus.for(G).on("audit.entry", (e) => entries.push(`guest ${e.node === G}`));
    await gate.run({ principal: { kind: "node", id: P2 }, action: "session.list", args: {} }, () => ({ sessions: [] }));
    offMachine();
    offGuest();
    expect(entries).toEqual(["guest true", "guest true"]);
    expect(mini.store.audit.list({ limit: 5 })[0]!.node).toBe(G);
  });

  test("a job never merges across the two", () => {
    const m = attached("merge-m", mine, 7101);
    const g = attached("merge-g", join(lent, "src"), 7102);
    const from = mini.sessions.find("claude", "merge-m")!;
    const into = mini.sessions.find("claude", "merge-g")!;
    mini.sessions.merge(from, into);
    expect(mini.sessions.get(m.id)?.status).not.toBe("ended");
    expect(mini.sessions.view(G).get(g.id)?.status).not.toBe("ended");
    const events: SessionEvent[] = mini.store.sessionEvents.history(g.id, { limit: 100 });
    expect(events.some((e) => (e.payload as { type?: string } | null)?.type === "backgrounded")).toBe(false);
  });
});

describe("nothing of the machine's starts in the lent folder", () => {
  test("no workspace, session or terminal there; a workspace node's own stay inside its folder", async () => {
    const M = mini.sessions.nodeId;
    expect(await refusal(() => mini.workspaces.put({ node: M, path: join(lent, "src"), name: "grab" }))).toMatch(/^conflict: .*lent to a workspace node/);
    expect(await refusal(() => mini.workspaces.put({ node: G, path: mine, name: "grab" }))).toBe(`not_found: no node ${G}`);
    expect(await refusal(() => mini.workspaces.view(G).put({ node: G, path: mine, name: "out" }))).toMatch(/^denied: .*outside the folder/);
    expect(await refusal(() => mini.workspaces.view(G).put({ node: M, path: lent, name: "x" }))).toBe(`not_found: no node ${M}`);
    // a machine workspace made before the folder was lent starts nothing there now
    const late = join(scratch, "work", "late");
    mkdirSync(late, { recursive: true });
    const before: Workspace = mini.workspaces.put({ node: M, path: late, name: "late" });
    const H = newId("node");
    owners.add(H, late);
    try {
      expect(await refusal(() => mini.sessions.spawn({ harness: "claude", workspace: before.id, prompt: "x" }, { profiles: mini.profiles }))).toMatch(/^conflict: .*lent to a workspace node/);
    } finally {
      owners.retire(H);
    }
    // terminals: one started in the lent folder is none of the machine's
    const entries = [
      { ref: { host: "h", id: "t-lent" }, info: { cwd: join(lent, "src"), argv: ["pwsh"], cols: 80, rows: 24, status: "running", clients: [], startedAt: 1 } },
      { ref: { host: "h", id: "t-mine" }, info: { cwd: mine, argv: ["pwsh"], cols: 80, rows: 24, status: "running", clients: [], startedAt: 1 } },
    ];
    const tether = {
      available: true,
      onChange: () => () => undefined,
      list: () => entries,
      get: (ref: { id: string }) => entries.find((e) => e.ref.id === ref.id),
      toTerminal: (e: (typeof entries)[number], session?: string, _a?: unknown, _h?: unknown, node?: string) => ({ id: e.ref.id, node: node ?? M, cwd: e.info.cwd, ...(session ? { session } : {}) }),
      spawn: async () => {
        throw new Error("not to be started");
      },
    } as unknown as Tether;
    const rows = new TerminalRows({ tether, bus: mini.bus, nodeId: M, workspaces: mini.workspaces, env: {}, sessionOf: () => undefined, owners, log: silentLogger });
    expect(rows.list().map((t) => t.id)).toEqual(["t-mine"]);
    expect(rows.visible(entries[0] as never)).toBe(false);
    expect(rows.row(entries[0] as never).node).toBe(G);
    expect(await refusal(() => rows.spawn({ cwd: join(lent, "src") }))).toMatch(/^conflict: .*lent to a workspace node/);
    rows.stop();
  });
});
