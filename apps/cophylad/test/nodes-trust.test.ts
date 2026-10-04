// Whether a machine lets its primary work there without asking, answered at the join. By
// default it does: what `[gate.policy.node]` would ask of the primary is allowed, while a
// rule's deny still holds and the audit row is there as before. A join that answered no
// (`askPrimary`, `cophylad join --ask`) keeps it in link.json, and the primary's writes are
// asked there again. A folder the machine lends to another person's cluster never lets that
// primary in so, whatever the machine answered for its own.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask, AuditEntry } from "@cophyla/protocol";
import { readLinkFile } from "../src/grants/link-file.ts";
import { isMethod, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, inviteOn, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const primaries: Primary[] = [];
const secondaries: Started[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(...secondaries.splice(0), ...primaries.splice(0).map((p) => p.d));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function up(): Promise<Primary> {
  const p = await startPrimary({});
  primaries.push(p);
  return p;
}

async function joined(primary: Primary, opts: Parameters<typeof startSecondary>[1] = {}): Promise<Started> {
  const s = await startSecondary(primary, opts);
  secondaries.push(s);
  await linked(s);
  return s;
}

async function connect(p: Primary): Promise<TestClient> {
  const c = await client(p.d);
  clients.push(c);
  return c;
}

const rows = (d: Started, action: string): AuditEntry[] => d.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === action);

describe("the primary working on a machine unasked", () => {
  test("by default the primary's writes are allowed where the class default would ask; a rule's deny still holds", async () => {
    const primary = await up();
    const secondary = await joined(primary, { gateRules: { "node:node.rename": "deny" } });
    expect(readLinkFile(secondary.paths.linkFile)?.askPrimary).toBeUndefined();
    const c = await connect(primary);
    const node = secondary.identity.id;
    const theirs = secondary.profiles.byHarness("claude")[0]!;
    const { profile } = await c.request<{ profile: { id: string } }>("profile.update", { node, id: theirs.id, patch: { usual: true } });
    expect(profile.id).toBe(theirs.id);
    expect(secondary.asks.listOpenAll()).toEqual([]);
    expect(rows(secondary, "profile.update")[0]).toMatchObject({ principal: { kind: "node", id: primary.d.identity.id }, decision: "allow", outcome: "ok" });
    const renamed = await c.call("node.rename", { id: node, name: "study" });
    expect("error" in renamed && renamed.error.data?.code).toBe("denied");
  }, 30_000);

  test("a join that answered no keeps the asks, and link.json says so", async () => {
    const primary = await up();
    const secondary = await joined(primary, { askPrimary: true });
    expect(readLinkFile(secondary.paths.linkFile)?.askPrimary).toBe(true);
    const c = await connect(primary);
    const theirs = secondary.profiles.byHarness("claude")[0]!;
    const updating = c.request("profile.update", { node: secondary.identity.id, id: theirs.id, patch: { usual: true } });
    const asked = (await c.next(isMethod("ask.state", (p) => (p as Ask).node === secondary.identity.id && (p as Ask).status === "open"), 10_000)).params as Ask;
    expect(asked.source).toMatchObject({ kind: "gate", action: "profile.update", principal: { kind: "node", id: primary.d.identity.id } });
    await c.request("ask.answer", { id: asked.id, option: "allow" });
    await updating;
    expect(rows(secondary, "profile.update")[0]).toMatchObject({ decision: "ask", outcome: "ok" });
  }, 30_000);

  test("a folder the machine lends to another cluster still asks that cluster's primary", async () => {
    const mine = await up();
    const theirs = await up();
    const machine = await joined(mine, { agent: true });
    const root = mkdtempSync(join(tmpdir(), "cophyla-lent-"));
    dirs.push(root);
    const lent = join(root, "friend");
    mkdirSync(lent);
    const g = await machine.guests.add({ folder: lent, invite: await inviteOn(theirs, { role: "hands", name: "friend's folder" }) });
    await waitFor(() => theirs.d.nodes.linkedNodes().includes(g.id), 10_000);
    const c = await connect(theirs);
    const ws = await waitFor(async () => (await c.request<{ workspaces: { id: string; node: string }[] }>("workspace.list")).workspaces.find((w) => w.node === g.id), 5000);
    const inbound = (theirs.d.nodes as unknown as { inbound: { forward(node: string, method: string, params: unknown): Promise<unknown> } }).inbound;
    const spawning = inbound.forward(g.id, "session.spawn", { harness: "claude", workspace: ws.id, prompt: "hello from the other cluster" }).then(() => "ok", (e: unknown) => (e as Error).message);
    const asked = (await c.next(isMethod("ask.state", (p) => (p as Ask).node === g.id && (p as Ask).status === "open"), 10_000)).params as Ask;
    expect(asked.source).toMatchObject({ kind: "gate", action: "session.spawn" });
    await c.request("ask.answer", { id: asked.id, option: "deny" });
    expect(await spawning).toMatch(/^denied by /);
  }, 30_000);
});
