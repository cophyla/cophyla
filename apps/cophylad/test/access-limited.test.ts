// A phone whose grant limits it. Its hello gives it the grant's scopes and access; the
// welcome, the broadcasts, the lists and the requests stop at its limits; a node-wide request
// is refused whatever its scopes, and so is an answer remembered for always; a refusal is
// audited. Relayed through a full secondary, the primary holds the client to its own row of
// the grant when it keeps one, and to the access the secondary reports when it does not.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FULL, SESSIONS } from "@cophyla/protocol";
import type { Access, Ask, Client, RpcNotification, Session, Workspace } from "@cophyla/protocol";
import { isMethod, TestClient, waitFor } from "./helpers.ts";
import { rogueLink, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Rogue, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
const started: Started[] = [];
const clients: TestClient[] = [];
const rogues: Rogue[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const r of rogues.splice(0)) r.close();
  await stopAll(...started.splice(0), primary?.d);
  primary = undefined;
});

async function spawnIn(d: Started, dir: string, name: string): Promise<{ ws: Workspace; session: Session }> {
  mkdirSync(dir, { recursive: true });
  const ws = d.workspaces.put({ node: d.identity.id, path: dir, name });
  const session = await d.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "hello" }, { profiles: d.profiles });
  return { ws, session };
}

async function phoneOn(d: Started, token: string): Promise<{ c: TestClient; client: Client }> {
  const c = await TestClient.connect(`wss://127.0.0.1:${d.controller!.port}/ws/client`, { insecure: true });
  clients.push(c);
  const hello = await c.request<{ client: Client }>("hello", { token, kind: "controller", audio: { in: false, out: false } });
  return { c, client: hello.client };
}

const code = async (c: TestClient, method: string, params: unknown) => {
  const r = await c.call(method, params);
  return "error" in r ? (r.error.data as { code: string }).code : "ok";
};

const about = (n: RpcNotification) => JSON.stringify(n.params);

describe("a limited phone", () => {
  test("hears, lists and reaches only its workspace; node-wide requests are refused and audited", async () => {
    primary = await startPrimary();
    const d = primary.d;
    const one = await spawnIn(d, join(primary.scratch, "one"), "one");
    const two = await spawnIn(d, join(primary.scratch, "two"), "two");
    const access: Access = { ...SESSIONS, workspaces: [one.ws.id] };
    const { token } = d.grants.createController("Work phone", { access });
    const { c, client } = await phoneOn(d, token);
    expect(client.scopes).toEqual(SESSIONS.scopes);
    expect(client.access).toEqual(access);

    // The welcome: its workspace's session and row, nothing of the other, nothing node-wide.
    await c.next(isMethod("session.state", (p) => (p as Session).id === one.session.id));
    await c.next(isMethod("workspace.state", (p) => (p as Workspace).id === one.ws.id));
    await Bun.sleep(200);
    expect(c.notifications.filter((n) => about(n).includes(two.session.id) || about(n).includes(two.ws.id))).toEqual([]);
    expect(c.notifications.filter((n) => ["node.state", "task.state", "account.state", "update.state", "voice.state", "chat.message"].includes(n.method))).toEqual([]);

    // Lists come back cut to it.
    expect((await c.request<{ sessions: Session[] }>("session.list", {})).sessions.map((s) => s.id)).toEqual([one.session.id]);
    expect((await c.request<{ workspaces: Workspace[] }>("workspace.list", {})).workspaces.map((w) => w.id)).toEqual([one.ws.id]);

    // Requests past it are refused; within it they are served.
    expect(await code(c, "session.history", { id: two.session.id })).toBe("denied");
    expect(await code(c, "session.history", { id: one.session.id })).toBe("ok");
    expect(await code(c, "session.send", { id: two.session.id, text: "hi" })).toBe("denied");
    expect(await code(c, "session.watch", { ids: [one.session.id, two.session.id] })).toBe("denied");
    expect(await code(c, "session.watch", { ids: [one.session.id] })).toBe("ok");
    expect(await code(c, "session.files", { id: two.session.id })).toBe("denied");
    expect(await code(c, "session.git", { id: two.session.id })).toBe("denied");
    expect(await code(c, "session.file", { id: two.session.id, path: "README.md" })).toBe("denied");
    expect(await code(c, "session.files", { id: one.session.id })).toBe("ok");
    expect(await code(c, "workspace.put", { node: d.identity.id, path: join(primary.scratch, "elsewhere"), name: "x" })).toBe("denied");
    // Node-wide, whatever the scopes say.
    expect(await code(c, "view.setDefault", { id: "default" })).toBe("denied");
    expect(await code(c, "chat.send", { text: "hi" })).toBe("denied");
    expect(await code(c, "controller.list", {})).toBe("denied");
    expect(await code(c, "view.list", {})).toBe("ok");
    // The refusal is in the audit, under this phone's client.
    const refused = d.store.audit.list({ limit: 100 }).find((e) => e.action === "session.send" && e.via === client.id);
    expect(refused?.outcome).toBe("error");

    // Asks: its session's reaches it and may be answered, but not for always; the other's does not.
    const mine = d.asks.open({ type: "permission", source: { kind: "harness", session: one.session.id }, title: "mine", options: [{ id: "allow", label: "Allow" }], answerableBy: ["user"] });
    const theirs = d.asks.open({ type: "permission", source: { kind: "harness", session: two.session.id }, title: "theirs", options: [{ id: "allow", label: "Allow" }], answerableBy: ["user"] });
    await c.next(isMethod("ask.state", (p) => (p as Ask).id === mine.id));
    expect(await code(c, "ask.answer", { id: mine.id, option: "allow", remember: "always" })).toBe("denied");
    expect(await code(c, "ask.answer", { id: theirs.id, option: "allow" })).toBe("denied");
    expect(await code(c, "ask.answer", { id: mine.id, option: "allow" })).toBe("ok");
    expect(c.notifications.some((n) => n.method === "ask.state" && (n.params as Ask).id === theirs.id)).toBe(false);

    // A new session is told to it only in its workspace.
    const later = await d.sessions.spawn({ harness: "claude", workspace: two.ws.id, prompt: "again" }, { profiles: d.profiles });
    const inside = await d.sessions.spawn({ harness: "claude", workspace: one.ws.id, prompt: "again" }, { profiles: d.profiles });
    await c.next(isMethod("session.state", (p) => (p as Session).id === inside.id));
    expect(c.notifications.some((n) => about(n).includes(later.id))).toBe(false);
  }, 40_000);

  test("relayed through a full secondary: the primary's own row of the grant decides, else what the secondary reports", async () => {
    primary = await startPrimary();
    const d = primary.d;
    const one = await spawnIn(d, join(primary.scratch, "one"), "one");
    const two = await spawnIn(d, join(primary.scratch, "two"), "two");
    // A phone paired on a secondary, limited there to the primary's first workspace.
    const secondary = await startSecondary(primary, { controller: true });
    started.push(secondary);
    await waitFor(() => secondary.nodes.linked(), 8000);
    const { token } = secondary.grants.createController("Work phone", { access: { ...SESSIONS, workspaces: [one.ws.id] } });
    const { c, client } = await phoneOn(secondary, token);
    expect(client.access?.workspaces).toEqual([one.ws.id]);
    expect((await c.request<{ sessions: Session[] }>("session.list", {})).sessions.map((s) => s.id)).toEqual([one.session.id]);
    expect(await code(c, "session.send", { id: two.session.id, text: "hi" })).toBe("denied");

    // What a linked node reports is not believed over the primary's own row of the grant.
    const known = d.grants.createController("Known", { access: { ...SESSIONS, workspaces: [one.ws.id] } });
    const rogue = await rogueLink(primary);
    rogues.push(rogue);
    const hello = (await rogue.rpc.request("relay.open", { peer: "p1", client: { kind: "controller", audio: { in: false, out: false } }, grant: known.controller.id, access: FULL, origin: "https://x" })) as { client: Client };
    expect(hello.client.access?.workspaces).toEqual([one.ws.id]);
    // Unknown here: the reported access holds. Neither: FULL, a desktop on that node.
    const reported = (await rogue.rpc.request("relay.open", { peer: "p2", client: { kind: "controller", audio: { in: false, out: false } }, access: { ...SESSIONS, nodes: [d.identity.id] }, origin: "https://x" })) as { client: Client };
    expect(reported.client.access?.nodes).toEqual([d.identity.id]);
    const desktop = (await rogue.rpc.request("relay.open", { peer: "p3", client: { kind: "ui", audio: { in: false, out: false } }, origin: "https://x" })) as { client: Client };
    expect(desktop.client.access).toEqual(FULL);
    // Reported access that is not valid is refused outright.
    const invalid = await rogue.rpc.request("relay.open", { peer: "p4", client: { kind: "controller", audio: { in: false, out: false } }, access: { scopes: ["chat"], nodes: [d.identity.id], messages: "none" }, origin: "https://x" }).then(
      () => "opened",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(invalid).toContain("cannot hold chat");
  }, 40_000);
});
