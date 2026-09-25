// Failover and handover. The primary stops: within `failover_ms` the backup promotes itself
// at the next epoch and starts its brain; a plain secondary that was linked re-links to it
// through the registry's endpoints; `chat.load` on the new primary shows the replicated
// thread. The old home starts again and runs as a backup of the new primary. `node.promote`
// from a client of the new primary hands the role back: the epoch rises again, the other
// steps down and links.

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Node, Thread } from "@cophyla/protocol";
import { brainFrames, isMethod, tomlString, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
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

describe("failover", () => {
  test("the backup promotes when the primary dies; the old primary comes back as a backup; promote hands the role back", async () => {
    const primary: Primary = await startPrimary({ brain: { script } });
    daemons.push(primary.d);
    await waitFor(() => primary.d.brain?.state === "up");
    // The backup runs the same fake brain once it is the primary: its config names the brain command too.
    const brainToml = `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[gate.rules]\n"brain:ui.say" = "allow"\n"brain:thread.start" = "allow"\n`;
    const backup = await startSecondary(primary, { backup: true, failoverMs: 300, toml: brainToml, daemon: { brain: true, env: { ...process.env, FAKE_BRAIN_SCRIPT: primary.scriptPath!, FAKE_BRAIN_LOG: join(primary.scratch, "brain-backup.log") } } });
    daemons.push(backup);
    const plain = await startSecondary(primary, { failoverMs: 300 });
    daemons.push(plain);
    await linked(backup);
    await linked(plain);
    await waitFor(() => backup.nodes.replicaState?.snapshots === 1, 10_000);
    expect(backup.brain).toBeUndefined();
    // A thread on the primary, replicated.
    const pc = await client(primary.d);
    clients.push(pc);
    await pc.request("chat.send", { text: "before the failover" });
    await pc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    await waitFor(() => backup.store.messages.dump().length === primary.d.store.messages.dump().length, 10_000);
    const threadId = primary.d.chat.peek()!.id;
    const oldEpoch = primary.d.nodes.epoch();

    // The primary goes; its home stays for the return.
    const oldHome = primary.d.home;
    await primary.d.stop();
    daemons.splice(daemons.indexOf(primary.d), 1);
    await waitFor(() => backup.nodes.roleOf() === "primary", 10_000);
    expect(backup.nodes.epoch()).toBe(oldEpoch + 1);
    await waitFor(() => backup.brain?.state === "up", 10_000);
    expect(backup.brain!.spawnCount).toBe(1);
    expect(backup.node()).toMatchObject({ role: "primary", capabilities: { brain: true } });
    // The plain secondary re-links to the new primary through the registry.
    await waitFor(() => plain.nodes.linked() && plain.nodes.primaryId() === backup.identity.id, 10_000);
    // The thread continues on the new primary: loaded from the replica, and the brain answers on it.
    const bc = await client(backup);
    clients.push(bc);
    const loaded = await bc.request<{ threads: Thread[]; messages: Message[] }>("chat.load", {});
    expect(loaded.threads.map((t) => t.id)).toContain(threadId);
    expect(loaded.messages.some((m) => m.content.some((b) => b.type === "text" && b.text === "heard: before the failover"))).toBe(true);
    await bc.request("chat.send", { text: "after the failover" });
    const reply = await bc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator" && (p as { message: Message }).message.content.some((b) => b.type === "text" && b.text === "heard: after the failover")), 10_000);
    expect((reply.params as { message: Message }).message.thread).toBe(threadId);

    // The old primary's home starts again: it hears the live primary of a higher epoch and joins it as a backup.
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    writeFileSync(join(oldHome, "config.toml"), (await Bun.file(join(oldHome, "config.toml")).text()).replace("claim_wait_ms = 300", "claim_wait_ms = 2000"));
    const returned = Object.assign(await startDaemon({ home: oldHome, port: 0, log: silentLogger, brain: true, embedder: null, env: { ...process.env, FAKE_BRAIN_SCRIPT: primary.scriptPath!, FAKE_BRAIN_LOG: join(primary.scratch, "brain-returned.log") } }), { home: oldHome });
    daemons.push(returned);
    expect(returned.nodes.roleOf()).toBe("secondary");
    expect(returned.brain).toBeUndefined();
    await linked(returned, 10_000);
    const list = await bc.request<{ nodes: Node[] }>("node.list");
    expect(list.nodes.find((n) => n.id === returned.identity.id)).toMatchObject({ role: "secondary", backup: true, status: "online" });
    expect(list.nodes.find((n) => n.id === backup.identity.id)).toMatchObject({ role: "primary" });

    // The user hands the role back: the returned node takes the next epoch and its brain; the other steps down and links to it.
    await bc.request("node.promote", { id: returned.identity.id });
    await waitFor(() => returned.nodes.roleOf() === "primary" && returned.brain?.state === "up", 10_000);
    expect(returned.nodes.epoch()).toBe(oldEpoch + 2);
    await waitFor(() => backup.nodes.roleOf() === "secondary" && backup.nodes.linked() && backup.nodes.primaryId() === returned.identity.id, 10_000);
    expect(backup.brain).toBeUndefined();
    await waitFor(() => plain.nodes.linked() && plain.nodes.primaryId() === returned.identity.id, 10_000);
    // The brain on the returned primary heard the two nodes join.
    await waitFor(() => brainFrames(join(primary.scratch, "brain-returned.log")).filter((f) => f.dir === "in" && f.frame["method"] === "node.joined").length >= 2, 10_000);
  }, 60_000);
});
