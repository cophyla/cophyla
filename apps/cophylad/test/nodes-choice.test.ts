// The primary is the user's choice. The primary stops: the backup and the plain secondary
// seek it and take nothing, however long it is gone, and link back when it returns. It stops
// again, and the user makes the backup the primary from the backup's own app: it takes the
// next epoch and its brain, the plain secondary follows it, and `chat.load` there shows the
// replicated thread. The old primary's home starts again: it was chosen at the earlier
// epoch, hears the later choice and links as a secondary. `node.promote` from a client of
// the new primary hands the role back.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Node, Thread } from "@cophyla/protocol";
import { brainFrames, isMethod, sleep, TestClient, tomlString, waitFor } from "./helpers.ts";
import { client, FAKE_BRAIN, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const daemons: (Started | undefined)[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(...daemons.reverse());
  daemons.length = 0;
});

const script = { on: [{ event: "user.message", requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "heard: $event.text" }] } }] }] };

/** The old primary's home started again, with the fake brain; its LAN listener on `port` when given, so the secondaries' `[nodes] primary` finds it. */
async function restart(primary: Primary, home: string, log: string, opts: { port?: number; claimWaitMs?: number } = {}): Promise<Started> {
  let toml = readFileSync(join(home, "config.toml"), "utf8");
  if (opts.port !== undefined) toml = toml.replace("[controller]\nenabled = false\nport = 0", `[controller]\nenabled = false\nport = ${opts.port}`);
  if (opts.claimWaitMs !== undefined) toml = toml.replace(/claim_wait_ms = \d+/, `claim_wait_ms = ${opts.claimWaitMs}`);
  writeFileSync(join(home, "config.toml"), toml);
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  return Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: true, embedder: null, env: { ...process.env, FAKE_BRAIN_SCRIPT: primary.scriptPath!, FAKE_BRAIN_LOG: join(primary.scratch, log) } }), { home });
}

describe("the primary is the user's choice", () => {
  test("nothing takes the role when the primary stops; the user's choice does; the old primary returns as a secondary; promote hands it back", async () => {
    const primary: Primary = await startPrimary({ brain: { script } });
    daemons.push(primary.d);
    await waitFor(() => primary.d.brain?.state === "up");
    // The backup runs the same fake brain once it is the primary: its config names the brain command too.
    const brainToml = `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n"brain:ui.say" = "allow"\n"brain:thread.start" = "allow"\n`;
    const backup = await startSecondary(primary, { backup: true, toml: brainToml, daemon: { brain: true, env: { ...process.env, FAKE_BRAIN_SCRIPT: primary.scriptPath!, FAKE_BRAIN_LOG: join(primary.scratch, "brain-backup.log") } } });
    daemons.push(backup);
    const plain = await startSecondary(primary);
    daemons.push(plain);
    await linked(backup);
    await linked(plain);
    await waitFor(() => backup.nodes.replicaState?.snapshots === 1, 10_000);
    expect(backup.brain).toBeUndefined();
    expect(backup.nodes.chosen()).toBe(primary.d.identity.id);
    // A thread on the primary, replicated.
    const pc = await client(primary.d);
    clients.push(pc);
    await pc.request("chat.send", { text: "before the choice" });
    await pc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    await waitFor(() => backup.store.messages.dump().length === primary.d.store.messages.dump().length, 10_000);
    const threadId = primary.d.chat.peek()!.id;
    const oldEpoch = primary.d.nodes.epoch();
    const oldHome = primary.d.home;
    const oldPort = primary.d.controller!.port;

    // The primary stops: both seek it, and neither takes the role, however long it is gone.
    await primary.d.stop();
    daemons.splice(daemons.indexOf(primary.d), 1);
    await waitFor(() => !backup.nodes.linked() && !plain.nodes.linked(), 5000);
    await sleep(1500);
    for (const n of [backup, plain]) {
      expect(n.nodes.roleOf()).toBe("secondary");
      expect(n.nodes.state()).toBe("seeking");
      expect(n.nodes.epoch()).toBe(oldEpoch);
      expect(n.nodes.transitions.some((t) => t.to === "promoting")).toBe(false);
    }
    expect(backup.brain).toBeUndefined();

    // It comes back where it was: chosen, it claims, and both link to it again.
    const back = await restart(primary, oldHome, "brain-back.log", { port: oldPort });
    daemons.push(back);
    expect(back.nodes.roleOf()).toBe("primary");
    expect(back.nodes.epoch()).toBe(oldEpoch);
    await waitFor(() => backup.nodes.linked() && backup.nodes.primaryId() === back.identity.id, 10_000);
    await waitFor(() => plain.nodes.linked() && plain.nodes.primaryId() === back.identity.id, 10_000);

    // It stops again, and the user makes the backup the primary from the backup's own app.
    await back.stop();
    daemons.splice(daemons.indexOf(back), 1);
    await waitFor(() => !backup.nodes.linked(), 5000);
    const own = await client(backup);
    clients.push(own);
    // a machine that reaches no primary can name only itself
    const other = await own.call("node.promote", { id: plain.identity.id });
    expect("error" in other ? other.error.data?.code : "answered").toBe("conflict");
    const chose = await own.call("node.promote", { id: backup.identity.id });
    expect("error" in chose ? chose.error : chose.result).toEqual({});
    await waitFor(() => backup.nodes.roleOf() === "primary" && backup.brain?.state === "up", 10_000);
    expect(backup.nodes.epoch()).toBe(oldEpoch + 1);
    expect(backup.nodes.chosen()).toBe(backup.identity.id);
    expect(backup.node()).toMatchObject({ role: "primary", capabilities: { brain: true } });
    // the old primary's row says what it is now: no second primary on the cards
    expect(backup.nodes.registry.get(back.identity.id)).toMatchObject({ role: "secondary", status: "offline", capabilities: { brain: false } });
    expect(backup.nodes.registry.list().filter((n) => n.role === "primary").map((n) => n.id)).toEqual([backup.identity.id]);
    // The plain secondary follows it through the registry's endpoints.
    await waitFor(() => plain.nodes.linked() && plain.nodes.primaryId() === backup.identity.id, 10_000);
    // The thread continues on the new primary: loaded from the replica, and the brain answers on it.
    const bc = await client(backup);
    clients.push(bc);
    const loaded = await bc.request<{ threads: Thread[]; messages: Message[] }>("chat.load", {});
    expect(loaded.threads.map((t) => t.id)).toContain(threadId);
    expect(loaded.messages.some((m) => m.content.some((b) => b.type === "text" && b.text === "heard: before the choice"))).toBe(true);
    await bc.request("chat.send", { text: "after the choice" });
    const reply = await bc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator" && (p as { message: Message }).message.content.some((b) => b.type === "text" && b.text === "heard: after the choice")), 10_000);
    expect((reply.params as { message: Message }).message.thread).toBe(threadId);

    // The old primary's home starts again: chosen at the earlier epoch, it hears the later choice and links as a secondary.
    const returned = await restart(primary, oldHome, "brain-returned.log", { claimWaitMs: 2000 });
    daemons.push(returned);
    expect(returned.nodes.roleOf()).toBe("secondary");
    expect(returned.brain).toBeUndefined();
    await linked(returned, 10_000);
    expect(returned.nodes.chosen()).toBe(backup.identity.id);
    const list = await bc.request<{ nodes: Node[] }>("node.list");
    expect(list.nodes.find((n) => n.id === returned.identity.id)).toMatchObject({ role: "secondary", backup: true, status: "online" });
    expect(list.nodes.find((n) => n.id === backup.identity.id)).toMatchObject({ role: "primary" });

    // The user hands the role back: the returned node takes the next epoch and its brain; the other steps down and links to it.
    await bc.request("node.promote", { id: returned.identity.id });
    await waitFor(() => returned.nodes.roleOf() === "primary" && returned.brain?.state === "up", 10_000);
    expect(returned.nodes.epoch()).toBe(oldEpoch + 2);
    await waitFor(() => backup.nodes.roleOf() === "secondary" && backup.nodes.linked() && backup.nodes.primaryId() === returned.identity.id, 10_000);
    expect(backup.brain).toBeUndefined();
    expect(backup.nodes.chosen()).toBe(returned.identity.id);
    await waitFor(() => plain.nodes.linked() && plain.nodes.primaryId() === returned.identity.id, 10_000);
    // The brain on the returned primary heard the two nodes join.
    await waitFor(() => brainFrames(join(primary.scratch, "brain-returned.log")).filter((f) => f.dir === "in" && f.frame["method"] === "node.joined").length >= 2, 10_000);
  }, 90_000);
});

describe("a chosen primary that restarts", () => {
  test("takes its role back however the ids compare: its own backup's answer is not a rival's", async () => {
    // The backup's id is made first, so it is the smaller one, as the desk's was beside the laptop's.
    const placeholder: Primary = await startPrimary();
    daemons.push(placeholder.d);
    const backup = await startSecondary(placeholder, { backup: true, unjoined: true });
    daemons.push(backup);
    await placeholder.d.stop();
    daemons.splice(daemons.indexOf(placeholder.d), 1);
    const primary: Primary = await startPrimary();
    daemons.push(primary.d);
    expect(backup.identity.id < primary.d.identity.id).toBe(true);
    const { inviteOn } = await import("./nodes-helpers.ts");
    await backup.nodes.join(await inviteOn(primary));
    await linked(backup);
    expect(primary.d.nodes.registry.get(backup.identity.id)?.endpoints.length).toBeGreaterThan(0);
    const epoch = primary.d.nodes.epoch();
    const home = primary.d.home;
    const port = primary.d.controller!.port;
    await primary.d.stop();
    daemons.splice(daemons.indexOf(primary.d), 1);
    await waitFor(() => !backup.nodes.linked(), 5000);
    // back where it was: it probes the backup, which answers as a secondary at the same epoch, and claims all the same
    const back = await restart(primary, home, "brain-back.log", { port, claimWaitMs: 1500 });
    daemons.push(back);
    expect(back.nodes.roleOf()).toBe("primary");
    expect(back.nodes.epoch()).toBe(epoch);
    expect(back.nodes.transitions.some((t) => t.from === "claiming" && t.to === "seeking")).toBe(false);
    await waitFor(() => backup.nodes.linked() && backup.nodes.primaryId() === back.identity.id, 10_000);
  }, 40_000);
});

describe("a link that drops for a moment", () => {
  test("the secondary's own app waits for it and is relayed to the primary again, never served alone in between", async () => {
    const primary: Primary = await startPrimary();
    daemons.push(primary.d);
    const secondary = await startSecondary(primary, { relinkGraceMs: 6000 });
    daemons.push(secondary);
    await linked(secondary);
    const home = primary.d.home;
    const port = primary.d.controller!.port;
    const primaryId = primary.d.identity.id;
    await primary.d.stop();
    daemons.splice(daemons.indexOf(primary.d), 1);
    await waitFor(() => !secondary.nodes.linked(), 5000);
    // The app reconnects while the link is down: its hello is held, not answered by the secondary alone.
    const app = await TestClient.connect(secondary.api.url);
    clients.push(app);
    let answered = false;
    const hello = app.hello(secondary.token, { name: "app" }).then((r) => {
      answered = true;
      return r;
    });
    await sleep(500);
    expect(answered).toBe(false);
    // The primary is back where it was: the link returns, and the held hello is relayed to it.
    const back = await restart(primary, home, "brain-back.log", { port });
    daemons.push(back);
    const r = await hello;
    expect("result" in r ? (r.result as { node: string }).node : r).toBe(primaryId);
    await linked(secondary, 10_000);
    // relayed from the start, so the link's return closes nothing
    await sleep(300);
    expect(await Promise.race([app.closed.then(() => "closed"), sleep(50).then(() => "open")])).toBe("open");
  }, 30_000);

  test("past the grace, the app is served by the secondary alone", async () => {
    const primary: Primary = await startPrimary();
    daemons.push(primary.d);
    const secondary = await startSecondary(primary, { relinkGraceMs: 300 });
    daemons.push(secondary);
    await linked(secondary);
    await primary.d.stop();
    daemons.splice(daemons.indexOf(primary.d), 1);
    await waitFor(() => !secondary.nodes.linked(), 5000);
    await sleep(400);
    const app = await TestClient.connect(secondary.api.url);
    clients.push(app);
    const r = await app.hello(secondary.token, { name: "again" });
    expect("result" in r ? (r.result as { node: string }).node : r).toBe(secondary.identity.id);
  }, 30_000);
});
