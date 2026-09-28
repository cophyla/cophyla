// The cloud backup through the daemon against the fake server: enabling uploads the replica
// set as ciphertext under opaque names; each kind of write lands as one put and a removal as
// one delete; nothing unchanged is sent again (the startup file burst and a workspace touch
// included); a change while the link is down is caught up at the next link-up; the server's
// refusals (another owner, a full plan, the free plan) pause the sender in the right state;
// a secondary never sends; disable keeps or forgets the server's copy; a restore onto a
// second, empty home reproduces the tables and the files with the brain restarted and the
// clients closed, and refuses a wrong passphrase, a non-primary and a linked backup.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackupState, ClientNotificationParams, Message, Workspace } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { FakeServer } from "./fakes/server.ts";
import { brainFrames, isMethod, removeHome, sleep, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";
import { FAKE_BRAIN } from "./nodes-helpers.ts";

type AccountState = ClientNotificationParams<"account.state">;

interface StartOptions {
  fake: FakeServer;
  /** A home to start in; a fresh temp one otherwise. */
  home?: string;
  brain?: boolean;
  /** `[node] role`, primary by default. */
  role?: "primary" | "secondary";
  /** A LAN listener with `[nodes] accept`, so a backup node may link. */
  accept?: boolean;
  /** `[nodes] relay = false`: the node takes the primary role without asking the registry, as a fresh install would once the old one is gone. */
  noRelay?: boolean;
  signedIn?: boolean;
  toml?: string;
}

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  brainLog: string;
  scriptPath: string;
}

const running: Started[] = [];
const fakes: FakeServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) {
    try {
      s.c.close();
    } catch {
      // closed by the daemon
    }
    await s.d.stop();
    removeHome(s.d.home);
  }
  for (const f of fakes.splice(0)) await f.stop();
});

function newFake(): FakeServer {
  const f = new FakeServer();
  fakes.push(f);
  return f;
}

async function start(opts: StartOptions): Promise<Started> {
  const home = opts.home ?? tempHome();
  mkdirSync(home, { recursive: true });
  const brainLog = join(home, "brain.log");
  const scriptPath = join(home, "brain-script.json");
  writeFileSync(scriptPath, JSON.stringify({ on: [{ event: "user.message", requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "noted" }] } }] }] }));
  const brain = opts.brain ? `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n"brain:ui.say" = "allow"\n\n` : "";
  const node = opts.role === "secondary" ? `[node]\nrole = "secondary"\n\n` : "";
  const relay = opts.noRelay ? "relay = false\n" : "";
  const lan = opts.accept ? `[controller]\nenabled = false\nport = 0\n\n[nodes]\naccept = true\ndiscovery = false\nheartbeat_ms = 200\n${relay}\n` : `[nodes]\ndiscovery = false\n${relay}\n`;
  const toml = `${node}${lan}[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n${brain}[cloud]\nenabled = true\nurl = "${opts.fake.url}"\nallow_insecure = true\nrefresh_interval_ms = 60000\nreconnect_ms = 20\nreconnect_max_ms = 100\n${opts.toml ?? ""}`;
  writeFileSync(join(home, "config.toml"), toml);
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  if (opts.signedIn ?? true) writeFileSync(p.accountToken, opts.fake.mintToken("test") + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  const d = Object.assign(
    await startDaemon({
      home,
      port: 0,
      log: silentLogger,
      brain: Boolean(opts.brain),
      embedder: null,
      voice: { affinity: null },
      cloud: { keys: [opts.fake.publicKey] },
      backup: { debounceMs: 30, workspaceDebounceMs: 60 },
      env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: brainLog, GEMINI_API_KEY: undefined },
    }),
    { home },
  );
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "desktop" });
  const s = { d, c, brainLog, scriptPath };
  running.push(s);
  if (opts.signedIn ?? true) await waitFor(() => d.cloud.linkState === "up" && d.cloud.entitlement().plan === opts.fake.plan, 5000);
  return s;
}

/** The protocol error code a request is refused with, or undefined when it was answered. */
async function refused(c: TestClient, method: string, params: unknown): Promise<string | undefined> {
  const r = await c.call(method, params);
  return "error" in r ? r.error.data?.code : undefined;
}

const backupOf = (c: TestClient): BackupState | undefined => {
  const n = [...c.notifications].reverse().find((x) => x.method === "account.state");
  return (n?.params as AccountState | undefined)?.backup;
};

/** Waits until the sender has nothing pending and the last state says idle. */
async function synced(s: Started, timeoutMs = 8000): Promise<BackupState> {
  return waitFor(() => {
    const st = s.d.backup.state();
    return st.state === "idle" && (st.pending ?? 0) === 0 ? st : undefined;
  }, timeoutMs);
}

const puts = (fake: FakeServer, kind?: string) => fake.backupLog.filter((e) => e.method === "backup.put" && (kind === undefined || e.kind === kind));
const deletes = (fake: FakeServer, kind?: string) => fake.backupLog.filter((e) => e.method === "backup.delete" && (kind === undefined || e.kind === kind));

/** The whole backup as ciphertext: no plaintext fragment of any row or file may appear in it. */
function everything(fake: FakeServer): string {
  return [...fake.backups.values()].map((o) => `${o.key} ${o.ciphertext} ${Buffer.from(o.ciphertext, "base64").toString("latin1")}`).join("\n");
}

async function seed(s: Started): Promise<{ thread: string; task: string; workspace: string }> {
  const { d, c } = s;
  await c.request("chat.send", { text: "the first message, about apples" });
  const thread = d.chat.load({}).threads[0]!.id;
  const task = (await c.request<{ id: string }>("task.create", { title: "water the plants", detail: "the ones on the sill" })).id;
  mkdirSync(join(d.home, "proj"), { recursive: true });
  mkdirSync(join(d.home, "other"), { recursive: true });
  const workspace = (await c.request<{ id: string }>("workspace.put", { node: d.identity.id, path: join(d.home, "proj"), name: "proj" })).id;
  d.store.kv.put("wake", "rules", { a: 1 });
  d.store.kv.put("profiles", "secret", { x: 1 });
  d.store.kv.put("controllers", "ctl_x", { tokenHash: "h" });
  writeFileSync(join(d.paths.memory, "user-likes-apples.md"), "# user likes apples\n\nRemember it.\n");
  writeFileSync(join(d.paths.prompts, "review.md"), "# review\n\nLook twice.\n");
  writeFileSync(join(d.paths.tools, "shout.ts"), `export default { name: "my.shout", description: "shouts", risk: "read", schema: { type: "object" }, run: (a) => String(a.text ?? "").toUpperCase() };\n`);
  mkdirSync(join(d.paths.views, "mine"), { recursive: true });
  writeFileSync(join(d.paths.views, "mine", "view.json"), JSON.stringify({ id: "mine", name: "Mine", version: "1", entry: "index.html" }));
  writeFileSync(join(d.paths.views, "mine", "index.html"), "<h1>mine</h1>");
  await d.editable.rescan();
  return { thread, task, workspace };
}

describe("cloud backup", () => {
  test("enable uploads the replica set as ciphertext under opaque names; each write is one put, a removal one delete; nothing unchanged is sent again", async () => {
    const fake = newFake();
    const s = await start({ fake });
    const { d, c } = s;
    await c.next(isMethod("account.state", (p) => (p as AccountState).plan === "pro"));
    expect(backupOf(c)).toMatchObject({ enabled: false, state: "idle", limit: 256 * 1024 * 1024 });
    const ids = await seed(s);
    expect(puts(fake).length).toBe(0);

    await c.request("backup.enable", { passphrase: "correct horse battery staple" });
    let st = await synced(s);
    expect(st.enabled).toBe(true);
    expect(st.keyId).toBeDefined();
    expect(fake.backupHeader?.node).toBe(d.identity.id);
    expect(fake.backupHeader?.header.keyId).toBe(st.keyId);
    // one object per row and per file: a thread, a message, a task, the workspaces, one kv row, four files
    const kinds = new Map<string, number>();
    for (const o of fake.backups.values()) kinds.set(o.kind, (kinds.get(o.kind) ?? 0) + 1);
    expect(kinds.get("chat")).toBe(2);
    expect(kinds.get("tasks")).toBe(1);
    expect(kinds.get("workspaces")).toBe(d.workspaces.list().length);
    expect(kinds.get("state")).toBe(1);
    expect(kinds.get("memory")).toBe(1);
    expect(kinds.get("prompts")).toBe(1);
    expect(kinds.get("tools")).toBe(1);
    expect(kinds.get("views")).toBe(2);
    expect(kinds.get("hooks")).toBeUndefined();
    // opaque names, and nothing readable in the ciphertext
    for (const o of fake.backups.values()) expect(o.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const all = everything(fake);
    for (const fragment of ["apples", "water the plants", "proj", "wake", "rules", "review", "Look twice", "my.shout", ids.thread, ids.task, ids.workspace, "user-likes", "<h1>"]) expect(all).not.toContain(fragment);
    expect(fake.backupBytes).toBeGreaterThan(0);
    expect(st.bytes).toBe(fake.backupBytes);
    expect(st.lastSyncAt).toBeDefined();
    // the state reached the clients, and the usage bar the gauge
    await waitFor(() => backupOf(c)?.enabled === true && backupOf(c)?.state === "idle");
    // the excluded namespaces never went
    expect(kinds.get("state")).toBe(1);

    // a memory write, a task update, a chat.send, a workspace.put, a kv put and a view file edit: one put each
    const before = puts(fake).length;
    writeFileSync(join(d.paths.memory, "user-likes-apples.md"), "# user likes apples\n\nRemember it well.\n");
    await d.editable.rescan();
    await waitFor(() => puts(fake, "memory").length === 2);
    await c.request("task.update", { id: ids.task, patch: { status: "done" } });
    await waitFor(() => puts(fake, "tasks").length === 2);
    await c.request("chat.send", { text: "the second message, about pears" });
    await waitFor(() => puts(fake, "chat").length === 3);
    await c.request("workspace.put", { node: d.identity.id, path: join(d.home, "other"), name: "other" });
    await waitFor(() => puts(fake, "workspaces").length === kinds.get("workspaces")! + 1);
    d.store.kv.put("wake", "more", { b: 2 });
    await waitFor(() => puts(fake, "state").length === 2);
    writeFileSync(join(d.paths.views, "mine", "index.html"), "<h1>mine, edited</h1>");
    await d.editable.rescan();
    await waitFor(() => puts(fake, "views").length === 3);
    await synced(s);
    expect(puts(fake).length).toBe(before + 6);
    expect(everything(fake)).not.toContain("pears");

    // versions count up per key: the memory file's second put is version 2 under the same key
    const memoryPuts = puts(fake, "memory");
    expect(memoryPuts[0]!.key).toBe(memoryPuts[1]!.key);
    expect(memoryPuts[1]!.version).toBe((memoryPuts[0]!.version ?? 0) + 1);

    // a removed file and a deleted kv row: one delete each; a second identical write sends nothing
    const beforeDeletes = deletes(fake).length;
    require("node:fs").rmSync(join(d.paths.prompts, "review.md"));
    await d.editable.rescan();
    d.store.kv.delete("wake", "more");
    await waitFor(() => deletes(fake).length === beforeDeletes + 2);
    const afterDeletes = puts(fake).length;
    writeFileSync(join(d.paths.memory, "user-likes-apples.md"), "# user likes apples\n\nRemember it well.\n");
    await d.editable.rescan();
    await d.editable.rescan();
    d.store.kv.put("wake", "rules", { a: 1 });
    await sleep(300);
    await synced(s);
    expect(puts(fake).length).toBe(afterDeletes);
    // a workspace touch that only moves lastActivity sends nothing either
    const ws = d.store.workspaces.get(ids.workspace)!;
    d.store.workspaces.upsert({ ...ws, lastActivity: ws.lastActivity + 1000 });
    await sleep(300);
    expect(puts(fake).length).toBe(afterDeletes);
    // the audit row keeps the passphrase out
    const audit = d.store.audit.list({ limit: 50 }).find((e) => e.action === "backup.enable");
    expect(JSON.stringify(audit)).not.toContain("correct horse");
  }, 30_000);

  test("a workspace node's workspace is never backed up, at enable or after", async () => {
    const fake = newFake();
    const s = await start({ fake });
    const { d, c } = s;
    const GUEST = "node_01ARZ3NDEKTSV4RRFFQ69G5FC0";
    d.store.privateNodes = () => [GUEST];
    const lent = (n: number) => ({ id: `ws_01ARZ3NDEKTSV4RRFFQ69G5FC${n}`, node: GUEST, path: `/lent-${n}`, name: `lent ${n}`, origin: "discovered" as const, tags: [], lastActivity: 1 });
    d.store.workspaces.upsert(lent(1));
    await c.request("backup.enable", { passphrase: "pp" });
    await synced(s);
    const mine = d.store.workspaces.list().filter((w) => w.node !== GUEST).length;
    expect(puts(fake, "workspaces").length).toBe(mine);
    d.store.workspaces.upsert(lent(2));
    d.store.workspaces.delete(lent(1).id);
    await sleep(400);
    await synced(s);
    expect(puts(fake, "workspaces").length).toBe(mine);
    expect(deletes(fake, "workspaces").length).toBe(0);
  }, 30_000);

  test("a change while the link is down is caught up at the next link-up; a restart of the daemon sends nothing unchanged", async () => {
    const fake = newFake();
    let s = await start({ fake });
    const { d, c } = s;
    await seed(s);
    await c.request("backup.enable", { passphrase: "pp" });
    await synced(s);
    const before = puts(fake).length;
    // the server refuses the token for a while: the link stays down and retries
    fake.acceptTokens = false;
    fake.restart();
    await waitFor(() => d.cloud.linkState !== "up");
    d.store.kv.put("wake", "offline", { c: 3 });
    writeFileSync(join(d.paths.prompts, "offline.md"), "# offline\n\nWritten with the link down.\n");
    await d.editable.rescan();
    await sleep(300);
    expect(puts(fake).length).toBe(before);
    expect(d.backup.state().pending).toBeGreaterThan(0);
    expect(d.backup.state().state).toBe("paused");
    fake.acceptTokens = true;
    await waitFor(() => d.cloud.linkState === "up", 5000);
    await waitFor(() => puts(fake).length === before + 2, 5000);
    await synced(s);
    // the daemon restarted on the same home: the ledger says everything is there, so the startup burst sends nothing
    const home = d.home;
    running.splice(running.indexOf(s), 1);
    c.close();
    await d.stop();
    const after = puts(fake).length;
    s = await start({ fake, home });
    await sleep(500);
    await synced(s);
    expect(puts(fake).length).toBe(after);
    expect(fake.backupLog.filter((e) => e.method === "backup.begin").length).toBe(1);
  }, 30_000);

  test("the server's refusals: another owner pauses in conflict, a full plan in full, the free plan is denied; a secondary never sends", async () => {
    const fake = newFake();
    const s = await start({ fake });
    const { d, c } = s;
    await seed(s);
    fake.plan = "free";
    fake.setPlan("free");
    await waitFor(() => d.cloud.entitlement().plan === "free");
    expect(await refused(c, "backup.enable", { passphrase: "pp" })).toBe("denied");
    fake.setPlan("pro");
    await waitFor(() => d.cloud.entitlement().plan === "pro");
    await c.request("backup.enable", { passphrase: "pp" });
    await synced(s);
    // another node took the backup over: the next put is a conflict and the sender pauses
    fake.backupHeader!.node = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    fake.backupHeader!.header.node = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    d.store.kv.put("wake", "x", { d: 4 });
    await waitFor(() => d.backup.state().state === "conflict");
    await waitFor(() => backupOf(c)?.state === "conflict");
    const n = puts(fake).length;
    d.store.kv.put("wake", "y", { d: 5 });
    await sleep(200);
    expect(puts(fake).length).toBe(n);
    // the owner again: a link-up clears the conflict and catches up
    fake.backupHeader!.node = d.identity.id;
    fake.backupHeader!.header.node = d.identity.id;
    fake.restart();
    await waitFor(() => d.cloud.linkState === "up", 5000);
    await waitFor(() => puts(fake).length === n + 2, 5000);
    await synced(s);
    // the plan's bytes: full pauses the sender
    fake.backupBytesCap = fake.backupBytes + 10;
    d.store.kv.put("wake", "z", { big: "x".repeat(2000) });
    await waitFor(() => d.backup.state().state === "full");
    await waitFor(() => backupOf(c)?.state === "full");
    fake.backupBytesCap = 256 * 1024 * 1024;
    // a plan without backup pauses; the key stays
    fake.setPlan("free");
    await waitFor(() => d.backup.state().state === "paused");
    expect(d.backup.state().enabled).toBe(true);
    expect(existsSync(d.paths.backupKey)).toBe(true);
    fake.setPlan("pro");
    await waitFor(() => d.cloud.entitlement().plan === "pro");
    await synced(s);
    // a secondary with a key on disk sends nothing and says so
    const sec = await start({ fake: newFake(), role: "secondary" });
    writeFileSync(sec.d.paths.backupKey, readFileSync(d.paths.backupKey));
    expect(await refused(sec.c, "backup.enable", { passphrase: "pp" })).toBe("conflict");
    sec.d.store.kv.put("wake", "s", { e: 1 });
    await sleep(200);
    expect(fakes[1]!.backupLog.length).toBe(0);
  }, 40_000);

  test("disable keeps the server's copy; forget clears it; enabling again with the wrong passphrase is refused unless replace", async () => {
    const fake = newFake();
    const s = await start({ fake });
    const { d, c } = s;
    await seed(s);
    await c.request("backup.enable", { passphrase: "one" });
    await synced(s);
    const objects = fake.backups.size;
    await c.request("backup.disable", {});
    expect(d.backup.state()).toMatchObject({ enabled: false, state: "idle" });
    expect(existsSync(d.paths.backupKey)).toBe(false);
    expect(fake.backups.size).toBe(objects);
    expect(d.store.backupSync.list().length).toBe(0);
    d.store.kv.put("wake", "after", { f: 1 });
    await sleep(200);
    expect(fake.backups.size).toBe(objects);
    // the wrong passphrase is refused and the server untouched; the right one carries the backup on
    expect(await refused(c, "backup.enable", { passphrase: "two" })).toBe("denied");
    expect(fake.backups.size).toBe(objects);
    const beginsBefore = fake.backupLog.filter((e) => e.method === "backup.begin").length;
    await c.request("backup.enable", { passphrase: "one" });
    await synced(s);
    expect(fake.backupLog.filter((e) => e.method === "backup.begin").length).toBe(beginsBefore + 1);
    // the same key id: the objects were put again at versions above the server's, never below
    for (const e of puts(fake)) expect(e.version).toBeGreaterThan(0);
    expect(fake.backups.size).toBe(objects + 1);
    // replace with another passphrase starts over: the header changes and the old objects go
    const oldKeyId = fake.backupHeader!.header.keyId;
    await c.request("backup.enable", { passphrase: "two", replace: true });
    await synced(s);
    expect(fake.backupHeader!.header.keyId).not.toBe(oldKeyId);
    expect(fake.backups.size).toBe(objects + 1);
    for (const o of fake.backups.values()) expect(o.version).toBe(1);
    await c.request("backup.disable", { forget: true });
    expect(fake.backups.size).toBe(0);
    expect(fake.backupHeader).toBeUndefined();
    expect(d.backup.state().remote).toBeUndefined();
  }, 30_000);

  test("restore onto a fresh home reproduces the tables and the files, re-homes the workspaces, restarts the brain and closes the clients; then the new home sends and the old one conflicts", async () => {
    const fake = newFake();
    const alpha = await start({ fake, brain: true });
    await waitFor(() => alpha.d.brain?.state === "up", 10_000);
    const ids = await seed(alpha);
    await alpha.c.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"), 10_000);
    // a task parked on an ask of this install, which the restored install cannot answer
    const parked = (await alpha.c.request<{ id: string }>("task.create", { title: "parked", blocker: { kind: "ask", ask: "ask_01ARZ3NDEKTSV4RRFFQ69G5FB5" } })).id;
    await alpha.c.request("backup.enable", { passphrase: "restore me" });
    await synced(alpha);
    const alphaThreads = alpha.d.store.threads.dump();
    const alphaMessages = alpha.d.store.messages.dump();
    const alphaTasks = alpha.d.store.tasks.dump();
    const alphaWorkspaces = alpha.d.store.workspaces.list();
    expect(alphaMessages.length).toBe(2);

    // beta: an empty home on the same account, with a brain of its own; the registry left out,
    // else it would seek alpha as its primary (the milestone's fresh install starts once the old one is gone)
    const beta = await start({ fake, brain: true, noRelay: true });
    await waitFor(() => beta.d.brain?.state === "up", 10_000);
    await beta.c.request("chat.send", { text: "beta's own message, to be replaced" });
    beta.d.store.kv.put("wake", "rules", { beta: true });
    beta.d.store.kv.put("profiles", "mine", { keep: true });
    writeFileSync(join(beta.d.paths.prompts, "beta-only.md"), "# beta only\n\nGoes.\n");
    await beta.d.editable.rescan();
    await waitFor(() => backupOf(beta.c)?.remote !== undefined);
    expect(backupOf(beta.c)?.remote).toMatchObject({ objects: fake.backups.size, node: alpha.d.identity.id });
    expect(backupOf(beta.c)?.enabled).toBe(false);
    // a wrong passphrase changes nothing
    expect(await refused(beta.c, "backup.restore", { passphrase: "wrong" })).toBe("denied");
    expect(beta.d.store.messages.dump().length).toBe(2);
    expect(existsSync(join(beta.d.paths.prompts, "beta-only.md"))).toBe(true);
    const betaBrainPid = beta.d.brain?.pid;
    const closed = beta.c.closed;
    const seenBefore = fake.backupLog.length;
    await beta.c.request("backup.restore", { passphrase: "restore me" });
    // the client was closed after the answer, with the restore's reason
    expect((await closed).reason).toBe("restored");
    await waitFor(() => beta.d.brain?.state === "up" && beta.d.brain.pid !== betaBrainPid, 10_000);
    // the tables equal alpha's; the workspaces are re-homed to beta with their ids kept
    expect(beta.d.store.threads.dump()).toEqual(alphaThreads);
    expect(beta.d.store.messages.dump()).toEqual(alphaMessages);
    expect(beta.d.store.tasks.dump().map((t) => t.id).sort()).toEqual(alphaTasks.map((t) => t.id).sort());
    expect(beta.d.store.kv.get("wake", "rules")).toEqual({ a: 1 });
    expect(beta.d.store.kv.get("profiles", "mine")).toEqual({ keep: true });
    expect(beta.d.store.kv.get("profiles", "secret")).toBeUndefined();
    expect(beta.d.store.kv.get("controllers", "ctl_x")).toBeUndefined();
    const restoredWorkspaces = beta.d.store.workspaces.list();
    const proj = restoredWorkspaces.find((w) => w.id === ids.workspace)!;
    expect(proj).toBeDefined();
    expect(proj.node).toBe(beta.d.identity.id);
    expect(proj.name).toBe("proj");
    expect(restoredWorkspaces.every((w: Workspace) => w.node === beta.d.identity.id)).toBe(true);
    // every one of alpha's rows is here under its own id; beta's own home row stays beside them, since
    // the two temp homes have different paths (a reinstall on one machine shares the path and merges)
    for (const w of alphaWorkspaces) expect(restoredWorkspaces.find((r) => r.id === w.id)).toMatchObject({ path: w.path, name: w.name, node: beta.d.identity.id });
    expect(restoredWorkspaces.length).toBe(alphaWorkspaces.length + 1);
    expect(restoredWorkspaces.filter((w) => w.path === beta.d.home).length).toBe(1);
    // the parked task was released: the ask is not open here
    expect(beta.d.store.tasks.get(parked)?.status).toBe("ready");
    // the files: alpha's are here, beta's own are gone
    expect(readFileSync(join(beta.d.paths.memory, "user-likes-apples.md"), "utf8")).toBe("# user likes apples\n\nRemember it.\n");
    expect(readFileSync(join(beta.d.paths.prompts, "review.md"), "utf8")).toBe("# review\n\nLook twice.\n");
    expect(readFileSync(join(beta.d.paths.views, "mine", "index.html"), "utf8")).toBe("<h1>mine</h1>");
    expect(existsSync(join(beta.d.paths.tools, "shout.ts"))).toBe(true);
    expect(existsSync(join(beta.d.paths.prompts, "beta-only.md"))).toBe(false);
    await waitFor(() => beta.d.tools.list().some((t) => t.name === "my.shout"));
    // the server saw only status, pulls and a begin from beta, then the re-homed workspaces
    const betaLog = fake.backupLog.slice(seenBefore);
    expect(betaLog[0]).toMatchObject({ method: "backup.begin", node: beta.d.identity.id });
    expect(fake.backupHeader?.node).toBe(beta.d.identity.id);
    expect(fake.seen.filter((m) => m === "backup.pull").length).toBeGreaterThan(0);
    await synced(beta);
    // what beta sent after the restore: the re-homed workspaces (and its own home row), and the task it released; nothing else moved
    const betaPuts = fake.backupLog.slice(seenBefore).filter((e) => e.method === "backup.put");
    expect(betaPuts.filter((e) => e.kind === "workspaces").length).toBe(restoredWorkspaces.length);
    expect(betaPuts.filter((e) => e.kind !== "workspaces").map((e) => beta.d.store.backupSync.get(e.kind, e.key)?.id)).toEqual([`task:${parked}`]);
    expect(beta.d.backup.state()).toMatchObject({ enabled: true, state: "idle" });
    expect(existsSync(beta.d.paths.backupKey)).toBe(true);
    // the ledger matches the server; a later change on beta is a single put
    const n = puts(fake).length;
    beta.d.store.kv.put("wake", "after-restore", { g: 1 });
    await waitFor(() => puts(fake).length === n + 1);
    await synced(beta);
    expect(beta.d.store.backupSync.list().filter((r) => !r.synced).length).toBe(0);
    expect(beta.d.store.backupSync.list().length).toBe(fake.backups.size);
    // alpha's sender: its next put is a conflict, and it pauses
    alpha.d.store.kv.put("wake", "alpha-after", { h: 1 });
    await waitFor(() => alpha.d.backup.state().state === "conflict");
    // the brain on beta answers a message about the restored stream
    const bc = await TestClient.connect(beta.d.api.url);
    await bc.hello(beta.d.token, { name: "again" });
    await bc.request("chat.send", { text: "after the restore" });
    await bc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"), 10_000);
    bc.close();
    expect(brainFrames(beta.brainLog).some((f) => f.dir === "in" && f.frame["method"] === "hello")).toBe(true);
  }, 60_000);

  test("restore is refused on a non-primary, with a backup node linked, and with no backup on the server", async () => {
    const fake = newFake();
    const alone = await start({ fake });
    expect(await refused(alone.c, "backup.restore", { passphrase: "x" })).toBe("not_found");
    const sec = await start({ fake: newFake(), role: "secondary" });
    expect(await refused(sec.c, "backup.restore", { passphrase: "x" })).toBe("conflict");
    // a primary with a backup node linked
    const { startSecondary, linked } = await import("./nodes-helpers.ts");
    const fake2 = newFake();
    const primary = await start({ fake: fake2, accept: true });
    await seed(primary);
    await primary.c.request("backup.enable", { passphrase: "x" });
    await synced(primary);
    const backupNode = await startSecondary({ d: primary.d, endpoint: `127.0.0.1:${primary.d.controller!.port}` }, { backup: true });
    try {
      await linked(backupNode);
      await waitFor(() => primary.d.nodes.attachedBackups() === 1, 10_000);
      expect(await refused(primary.c, "backup.restore", { passphrase: "x" })).toBe("conflict");
    } finally {
      await backupNode.stop();
      removeHome(backupNode.home);
    }
  }, 40_000);
});
