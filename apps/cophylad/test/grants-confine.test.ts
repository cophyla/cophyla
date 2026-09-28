// A node whose owner shared some folders alone. A path is judged once the file system has
// resolved it: `..`, a junction or a link planted inside, a short 8.3 name, another case, a
// folder that does not exist yet. The primary's requests there are refused past the folders
// (a spawn in a workspace outside, a workspace put outside, a file read outside or through a
// junction, the desktop, an editable or a network tool, the node's profiles); its lists, its
// searches and its samples answer what is inside; what goes up the link is what is inside.
// A node that answers its own asks answers them alone. The node's own apps see everything.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import type { Hit, MetricsSample, Session, Workspace } from "@cophyla/protocol";
import { Confinement } from "../src/nodes/confine.ts";
import { NodeServer } from "../src/nodes/served.ts";
import { silentLogger } from "../src/log.ts";
import { waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const WIN = process.platform === "win32";
const NODE = newId("node");
const dirs: string[] = [];
const primaries: Primary[] = [];
const started: Started[] = [];

afterEach(async () => {
  await stopAll(...started, ...primaries.map((p) => p.d));
  started.length = 0;
  primaries.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch tree: `shared/` the folder shared, `secret/` beside it, and a junction inside the one to the other. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), "cophyla-confine-"));
  dirs.push(root);
  const shared = join(root, "shared");
  const secret = join(root, "secret");
  mkdirSync(join(shared, "src"), { recursive: true });
  mkdirSync(secret, { recursive: true });
  writeFileSync(join(shared, "src", "notes.md"), "# inside\n");
  writeFileSync(join(secret, "keys.txt"), "not yours\n");
  const junction = join(shared, "way-out");
  symlinkSync(secret, junction, WIN ? "junction" : "dir");
  return { root, shared, secret, junction };
}

/** The 8.3 name Windows gives a folder, when the volume keeps them. */
function shortName(path: string): string | undefined {
  if (!WIN) return undefined;
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${path.replace(/'/g, "''")}').ShortPath`]);
  const out = r.stdout.toString().trim();
  return out && out.toLowerCase() !== path.toLowerCase() && out.includes("~") ? out : undefined;
}

describe("where a path is", () => {
  test("inside once resolved: `..`, a junction planted inside, another case, a short name, a folder not there yet", () => {
    const t = tree();
    const c = new Confinement([t.shared]);
    expect(c.active).toBe(true);
    expect(c.contains(join(t.shared, "src", "notes.md"))).toBe(true);
    expect(c.contains(t.shared)).toBe(true);
    expect(c.contains(join(t.secret, "keys.txt"))).toBe(false);
    expect(c.contains(join(t.shared, "..", "secret", "keys.txt"))).toBe(false);
    expect(c.contains(join(t.junction, "keys.txt"))).toBe(false);
    expect(c.contains(join(t.junction, "not-there-yet", "x.md"))).toBe(false);
    expect(c.contains(join(t.shared, "not-there-yet", "x.md"))).toBe(true);
    expect(c.contains("relative/path")).toBe(false);
    expect(c.contains(`${t.shared}-sibling`)).toBe(false);
    if (WIN) {
      expect(c.contains(join(t.shared.toUpperCase(), "src"))).toBe(true);
      // a long folder name has an 8.3 one on a volume that keeps them: it is the same folder
      const long = join(t.root, "a folder with a long name");
      mkdirSync(long);
      const withLong = new Confinement([long]);
      const short = shortName(long);
      if (short) {
        expect(withLong.contains(join(short, "x.md"))).toBe(true);
        expect(new Confinement([short]).contains(join(long, "x.md"))).toBe(true);
      }
      const secretShort = shortName(t.secret);
      if (secretShort) expect(c.contains(secretShort)).toBe(false);
      // `\\?\` is the same path; an admin share names the folder in a way that is refused, inside or not
      expect(c.contains(`\\\\?\\${join(t.shared, "src")}`)).toBe(true);
      expect(c.contains(`\\\\?\\${join(t.secret, "keys.txt")}`)).toBe(false);
      const share = (p: string) => `\\\\localhost\\${p[0]!.toLowerCase()}$${p.slice(2)}`;
      expect(c.contains(share(join(t.secret, "keys.txt")))).toBe(false);
      expect(c.contains(share(join(t.shared, "src")))).toBe(false);
    }
    // a root given by a short name, or through a junction, is resolved too
    const viaJunction = new Confinement([t.junction]);
    expect(viaJunction.contains(join(t.secret, "keys.txt"))).toBe(true);
    expect(viaJunction.contains(join(t.shared, "src"))).toBe(false);
    // no folders named: the machine
    expect(new Confinement(undefined).contains(t.secret)).toBe(true);
    expect(() => c.require(join(t.junction, "keys.txt"), "that file")).toThrow(/outside the folders/);
  });

  test("a request checks afresh: a link swapped in after the first look leads nowhere", () => {
    const t = tree();
    const c = new Confinement([t.shared]);
    const later = join(t.shared, "later");
    mkdirSync(later);
    expect(c.contains(later)).toBe(true);
    rmSync(later, { recursive: true });
    symlinkSync(t.secret, later, WIN ? "junction" : "dir");
    expect(() => c.require(join(later, "keys.txt"), "that file")).toThrow(/outside/);
  });

  test("a workspace's repository root above the folder is clamped to the folder", () => {
    const t = tree();
    const c = new Confinement([t.shared]);
    expect(c.clamp(t.root, join(t.shared, "src"))).toBe(c.roots[0]!);
    expect(c.clamp(t.shared, join(t.shared, "src"))).toBe(t.shared);
    expect(new Confinement(undefined).clamp(t.root, t.shared)).toBe(t.root);
  });
});

describe("what a confined node serves", () => {
  function server(t: ReturnType<typeof tree>, answerHere = false) {
    const inside: Session = { id: newId("session"), node: NODE, harness: "claude", profile: newId("profile"), native: { id: "n", transport: "acp" }, origin: "user", cwd: join(t.shared, "src"), tags: [], status: "idle", startedAt: 1, lastActivity: 1 };
    const outside: Session = { ...inside, id: newId("session"), cwd: t.secret };
    const wsIn: Workspace = { id: newId("workspace"), node: NODE, path: t.shared, name: "shared", origin: "user", tags: [], lastActivity: 1 };
    const wsOut: Workspace = { ...wsIn, id: newId("workspace"), path: t.secret, name: "secret" };
    const sessions = new Map([inside, outside].map((s) => [s.id, s]));
    const workspaces = new Map([wsIn, wsOut].map((w) => [w.id, w]));
    const ran: string[] = [];
    const answer = () => ({});
    const table = {
      "session.list": { handler: () => ({ sessions: [inside, outside] }) },
      "workspace.list": { handler: () => ({ workspaces: [wsIn, wsOut] }) },
      "session.spawn": { handler: (p: { workspace: string }) => (ran.push(`spawn ${p.workspace}`), { id: newId("session") }) },
      "workspace.put": { handler: (p: { path: string }) => (ran.push(`put ${p.path}`), { id: newId("workspace") }) },
      recall: {
        handler: (): { hits: Hit[] } => ({
          hits: [
            { corpus: "sessions", source: { kind: "session", session: inside.id }, at: 1, snippet: "in", tags: [], score: 1 },
            { corpus: "sessions", source: { kind: "session", session: outside.id }, at: 1, snippet: "out", tags: [], score: 1 },
            { corpus: "memory", source: { kind: "memory", name: "m" }, at: 1, snippet: "mem", tags: [], score: 1 },
          ] as Hit[],
        }),
      },
      "event.history": { handler: () => ({ events: [{ name: "a", node: NODE, at: 1, payload: { session: inside.id } }, { name: "b", node: NODE, at: 1, payload: { session: outside.id } }, { name: "c", node: NODE, at: 1, payload: {} }] }) },
      "metrics.query": {
        handler: (): { samples: MetricsSample[] } => ({
          samples: [{ node: NODE, at: 1, cpu: 50, memory: { used: 1, total: 2 }, processes: [{ pid: 1, parent: 0, name: "a", cpu: 10, memory: 1, owner: { kind: "session", session: inside.id } }, { pid: 2, parent: 0, name: "b", cpu: 20, memory: 2, owner: { kind: "session", session: outside.id } }] } as unknown as MetricsSample],
        }),
      },
      "tool.list": { handler: () => ({ tools: [{ name: "fs.read", source: "builtin", risk: "read" }, { name: "mine", source: "editable", risk: "exec" }, { name: "http.get", source: "builtin", risk: "network" }] }) },
      "tool.run": { handler: (p: { name: string }) => (ran.push(`tool ${p.name}`), { result: {} }), risk: () => "read" },
      "remote.screenshot": { handler: () => (ran.push("screenshot"), {}) },
      "ask.answer": { handler: answer },
    };
    const localAsk = { id: newId("ask"), node: NODE, type: "permission", source: { kind: "gate", action: "x", principal: { kind: "node", id: "node_p" } }, title: "t", options: [], answerableBy: ["user"], status: "open", createdAt: 1 };
    // a harness's ask about the session outside: not the primary's to know of
    const outsideAsk = { ...localAsk, id: newId("ask"), source: { kind: "harness", session: outside.id } };
    const asks = new Map([localAsk, outsideAsk].map((a) => [a.id, a]));
    const confinement = new Confinement([t.shared]);
    /** What the gate's audit row keeps of each result: what the handler inside it returned. */
    const audited: { action: string; result: unknown }[] = [];
    const s = new NodeServer({
      gate: {
        run: async (req: { action: string }, fn: (ctx: unknown) => unknown) => {
          const result = await fn({ audit: {} });
          audited.push({ action: req.action, result });
          return result;
        },
      } as never,
      table: table as never,
      principal: { kind: "node", id: "node_p" },
      sessionKey: "link-1",
      log: silentLogger,
      onPending: () => undefined,
      metricsSubscriber: "link:link-1",
      confine: () => confinement,
      answerHere: () => answerHere,
      local: { session: (id) => sessions.get(id), workspace: (id) => workspaces.get(id), ask: (id) => asks.get(id) as never },
      tools: { source: (name) => (name === "mine" ? "editable" : "builtin"), risk: (name) => (name === "http.get" ? "network" : "read") },
      files: {
        list: async (id) => (ran.push(`files ${id}`), { root: "", dirs: [] }),
        git: async (id) => (ran.push(`git ${id}`), undefined),
        read: async (id, path) => (ran.push(`read ${id} ${path}`), { path, size: 0, modified: 0, text: "" }),
      },
    });
    return { s, inside, outside, wsIn, wsOut, ran, localAsk, outsideAsk, audited };
  }

  const refused = (p: Promise<unknown>) => p.then(() => "served", (e: unknown) => (e instanceof Error ? e.message : String(e)));

  test("refused past the folders; lists, searches and samples answer what is inside", async () => {
    const t = tree();
    const { s, inside, outside, wsIn, wsOut, ran } = server(t);
    let n = 0;
    const call = (method: string, params: unknown) => s.serve(method, params, ++n);
    expect(await refused(call("session.spawn", { harness: "claude", workspace: wsOut.id, prompt: "x" }))).toMatch(/outside the folders/);
    expect(await refused(call("session.spawn", { harness: "claude", workspace: wsIn.id, prompt: "x" }))).toBe("served");
    expect(await refused(call("workspace.put", { node: NODE, path: join(t.junction, "deeper"), name: "x" }))).toMatch(/outside/);
    expect(await refused(call("workspace.put", { node: NODE, path: join(t.shared, "src"), name: "x" }))).toBe("served");
    expect(await refused(call("tool.run", { name: "mine", args: {} }))).toMatch(/editable tools/);
    expect(await refused(call("tool.run", { name: "http.get", args: {} }))).toMatch(/network/);
    expect(await refused(call("remote.screenshot", { node: NODE }))).toMatch(/not its desktop/);
    expect(await refused(call("remote.invite", { node: NODE }))).toMatch(/not its desktop/);
    expect(await refused(call("profile.update", { id: newId("profile"), patch: {} }))).toMatch(/profiles are its own/);
    expect(ran).toEqual([`spawn ${wsIn.id}`, `put ${join(t.shared, "src")}`]);
    // an explorer looks into a session inside alone
    expect(await refused(call("session.files", { id: outside.id }))).toMatch(/outside the folders/);
    expect(await refused(call("session.git", { id: outside.id }))).toMatch(/outside the folders/);
    expect(await refused(call("session.files", { id: inside.id, dirs: ["src"] }))).toBe("served");
    expect(await refused(call("session.git", { id: inside.id }))).toBe("served");
    expect(await refused(call("session.file", { id: outside.id, path: "a.md" }))).toMatch(/outside the folders/);
    expect(await refused(call("session.file", { id: inside.id, path: "a.md" }))).toBe("served");
    expect(ran.slice(2)).toEqual([`files ${inside.id}`, `git ${inside.id}`, `read ${inside.id} a.md`]);
    expect(((await call("session.list", {})) as { sessions: Session[] }).sessions.map((x) => x.id)).toEqual([inside.id]);
    expect(((await call("workspace.list", {})) as { workspaces: Workspace[] }).workspaces.map((x) => x.id)).toEqual([wsIn.id]);
    expect(((await call("recall", { query: "x" })) as { hits: Hit[] }).hits.map((h) => h.snippet)).toEqual(["in"]);
    expect(((await call("event.history", {})) as { events: { name: string }[] }).events.map((e) => e.name)).toEqual(["a"]);
    const sample = ((await call("metrics.query", { node: NODE })) as { samples: MetricsSample[] }).samples[0]!;
    expect(JSON.stringify(sample)).not.toContain(outside.id);
    expect(((await call("tool.list", {})) as { tools: { name: string }[] }).tools.map((x) => x.name)).toEqual(["fs.read"]);
  });

  test("the audit row keeps the answer the primary got, not the whole list", async () => {
    const t = tree();
    const { s, outside, wsOut, audited } = server(t);
    let n = 0;
    for (const method of ["session.list", "workspace.list", "recall", "event.history", "metrics.query", "tool.list"]) await s.serve(method, method === "recall" ? { query: "x" } : method === "metrics.query" ? { node: NODE } : {}, ++n);
    expect(audited.map((a) => a.action)).toEqual(["session.list", "workspace.list", "recall", "event.history", "metrics.query", "tool.list"]);
    const kept = JSON.stringify(audited);
    for (const leak of [outside.id, wsOut.id, '"out"', '"mem"', '"b"', "http.get", "mine"]) expect(kept).not.toContain(leak);
  });

  test("an ask this node does not hold, or one about something outside, is not found", async () => {
    const t = tree();
    const { s, localAsk, outsideAsk } = server(t);
    expect(await refused(s.serve("ask.answer", { id: newId("ask"), option: "a" }, 1))).toMatch(/^no ask/);
    expect(await refused(s.serve("ask.answer", { id: outsideAsk.id, option: "a" }, 2))).toBe(`no ask ${outsideAsk.id}`);
    expect(await refused(s.serve("ask.answer", { id: localAsk.id, option: "a" }, 3))).toBe("served");
  });

  test("a repository whose root is above the folder shows no state", async () => {
    const t = tree();
    mkdirSync(join(t.root, ".git"));
    const { s, inside } = server(t);
    expect(await refused(s.serve("session.git", { id: inside.id }, 1))).toMatch(/repository reaches above/);
    // one of the folder's own is shown
    mkdirSync(join(t.shared, ".git"));
    expect(await refused(s.serve("session.git", { id: inside.id }, 2))).toBe("served");
  });

  test("a node that answers its own asks answers them alone", async () => {
    const t = tree();
    const { s, localAsk } = server(t, true);
    expect(await refused(s.serve("ask.answer", { id: localAsk.id, option: "a" }, 1))).toMatch(/answers its own asks/);
  });
});

describe("a confined guest, end to end", () => {
  test("the primary sees the shared folder alone, spawns there, and reads nothing outside, not through a junction either", async () => {
    const t = tree();
    // a repository above the shared folder: its remote is not the primary's to see
    mkdirSync(join(t.root, ".git"));
    writeFileSync(join(t.root, ".git", "config"), '[remote "origin"]\n\turl = https://example.invalid/the-secret-repo.git\n');
    // Heartbeats at a second: a slow runner's stall during the spawn must not drop the link.
    const p = await startPrimary({ heartbeatMs: 1000 });
    primaries.push(p);
    const guest = await startSecondary(p, { heartbeatMs: 1000, hands: true, agent: true, paths: [t.shared], gateRules: { "node:session.spawn": "allow", "node:workspace.put": "allow", "node:tool.run": "allow", "node:session.list": "allow" } });
    started.push(guest);
    await linked(guest);
    // the guest's own apps see its every workspace, the cophyla home among them; the primary, the shared folder alone
    const own = guest.workspaces.list({ node: guest.identity.id });
    expect(own.some((w) => w.path.toLowerCase() === guest.home.toLowerCase())).toBe(true);
    const outsideWs = guest.workspaces.put({ node: guest.identity.id, path: t.secret, name: "secret" });
    const c = await client(p.d);
    const seen = async () => (await c.request<{ workspaces: Workspace[] }>("workspace.list")).workspaces.filter((w) => w.node === guest.identity.id);
    await waitFor(async () => (await seen()).length > 0);
    await Bun.sleep(300);
    const theirs = await seen();
    expect(theirs.map((w) => w.name)).toEqual(["shared"]);
    expect(theirs.map((w) => w.id)).not.toContain(outsideWs.id);
    expect(JSON.stringify(theirs)).not.toContain("the-secret-repo");
    // forwarded as the primary would: a spawn in the shared folder runs; one in the other is refused
    const inbound = (p.d.nodes as unknown as { inbound: { forward(node: string, method: string, params: unknown): Promise<unknown> } }).inbound;
    const outcome = (x: Promise<unknown>) => x.then(() => "ok", (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(await outcome(inbound.forward(guest.identity.id, "session.spawn", { harness: "claude", workspace: theirs[0]!.id, prompt: "hello" }))).toBe("ok");
    expect(await outcome(inbound.forward(guest.identity.id, "session.spawn", { harness: "claude", workspace: outsideWs.id, prompt: "hello" }))).toMatch(/outside the folders/);
    expect(await outcome(inbound.forward(guest.identity.id, "tool.run", { name: "fs.read", args: { path: join(t.shared, "src", "notes.md") } }))).toBe("ok");
    expect(await outcome(inbound.forward(guest.identity.id, "tool.run", { name: "fs.read", args: { path: join(t.secret, "keys.txt") } }))).toMatch(/outside the folders/);
    expect(await outcome(inbound.forward(guest.identity.id, "tool.run", { name: "fs.read", args: { path: join(t.junction, "keys.txt") } }))).toMatch(/outside the folders/);
    expect(await outcome(inbound.forward(guest.identity.id, "workspace.put", { node: guest.identity.id, path: t.secret, name: "grab" }))).toMatch(/outside the folders/);
    // a session the guest's own user starts outside never shows on the primary
    const local = await guest.sessions.spawn({ harness: "claude", workspace: outsideWs.id, prompt: "mine" }, { profiles: guest.profiles });
    await Bun.sleep(400);
    expect(p.d.nodes.mirrorSession(local.id)).toBeUndefined();
    c.close();
  }, 40_000);
});
