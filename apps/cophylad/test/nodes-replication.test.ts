// A backup's replica: the snapshot at the join makes its threads, messages, tasks,
// workspaces and kv (minus the profiles and update namespaces) equal the primary's, and
// drops the backup's own thread; each later write arrives as `replicate.write` in order; a
// prompt file and a tool file arrive as `replicate.file` and land in the editable layer; a
// hook with an `on.start` marker never runs on the backup; the backup's own client hears no
// `task.ready` and no `chat.message` for the primary's work.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Thread } from "@cophyla/protocol";
import { isMethod, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let backup: Started | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(backup, primary?.d);
  primary = undefined;
  backup = undefined;
});

const HOOK = `export default {
  name: "marker",
  on: {
    start: () => { require("node:fs").writeFileSync(process.env.MARKER_FILE, String(Date.now())); },
    "session.discovered": () => {},
  },
};
`;

describe("replication to a backup", () => {
  test("the snapshot at the join, then each write in order; the backup's own thread goes", async () => {
    primary = await startPrimary({ brain: { script: { on: [{ event: "user.message", requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "noted" }] } }, { method: "task.create", params: { title: "from the brain" } }] }] } } });
    await waitFor(() => primary!.d.brain?.state === "up");
    // Some state before the backup joins: a thread with a message, a task, a workspace, kv rows.
    const pc = await client(primary.d);
    clients.push(pc);
    await pc.request("chat.send", { text: "first" });
    await pc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"));
    await waitFor(() => primary!.d.tasks.list().length === 1);
    primary.d.store.kv.put("wake", "rules", { a: 1 });
    primary.d.store.kv.put("profiles", "secret", { x: 1 });
    writeFileSync(join(primary.d.paths.prompts, "review.md"), "# review\n\nLook twice.\n");
    await primary.d.editable.rescan();

    backup = await startSecondary(primary, { backup: true });
    // The backup's own thread: dropped at the snapshot.
    backup.chat.startThread({ topic: "mine" });
    expect(backup.store.threads.dump().length).toBe(1);
    await linked(backup);
    await waitFor(() => backup!.nodes.replicaState?.snapshots === 1, 10_000);
    expect(backup.store.threads.dump()).toEqual(primary.d.store.threads.dump());
    expect(backup.store.messages.dump()).toEqual(primary.d.store.messages.dump());
    expect(backup.store.tasks.dump()).toEqual(primary.d.store.tasks.dump());
    expect(backup.store.kv.get("wake", "rules")).toEqual({ a: 1 });
    expect(backup.store.kv.get("profiles", "secret")).toBeUndefined();
    expect(backup.workspaces.list().some((w) => w.node === primary!.d.identity.id && w.name === "cophyla")).toBe(true);
    expect(readFileSync(join(backup.paths.prompts, "review.md"), "utf8")).toBe("# review\n\nLook twice.\n");
    // Live writes: a new thread and message, a task, a kv row, and a deletion, each applied in order.
    const before = backup.nodes.replicaState!.position.seq;
    await pc.request("chat.send", { text: "second" });
    await pc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator" && (p as { message: Message }).message.content.some((b) => b.type === "text" && b.text === "noted")), 10_000);
    await waitFor(() => primary!.d.tasks.list().length === 2);
    primary.d.store.kv.put("wake", "rules", { a: 2 });
    primary.d.store.kv.delete("wake", "rules");
    await waitFor(() => backup!.store.kv.get("wake", "rules") === undefined && backup!.store.tasks.dump().length === 2, 10_000);
    expect(backup.nodes.replicaState!.position.seq).toBeGreaterThan(before);
    expect(backup.nodes.replicaState!.snapshots).toBe(1);
    expect(backup.store.messages.dump()).toEqual(primary.d.store.messages.dump());
    expect(backup.store.tasks.dump()).toEqual(primary.d.store.tasks.dump());
    // The chat as a backup client would load it, for the day it takes over.
    const loaded = backup.chat.load({});
    expect(loaded.threads.map((t: Thread) => t.id)).toEqual(primary.d.chat.load({}).threads.map((t: Thread) => t.id));
  }, 30_000);

  test("editable files replicate and hooks stay inactive on the backup; the backup's client hears nothing of the primary's work", async () => {
    primary = await startPrimary({ brain: { script: { on: [{ event: "user.message", requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "noted" }] } }, { method: "task.create", params: { title: "t", trigger: { kind: "at", at: 1 } } }] }] } } });
    await waitFor(() => primary!.d.brain?.state === "up");
    const marker = join(process.env["TEMP"] ?? "/tmp", `cophyla-marker-${Date.now()}`);
    process.env["MARKER_FILE"] = marker;
    backup = await startSecondary(primary, { backup: true });
    await linked(backup);
    await waitFor(() => backup!.nodes.replicaState?.snapshots === 1, 10_000);
    // The backup's own bus: a replicated row raises nothing here (its client, relayed, hears the primary's, which is right).
    const heard: string[] = [];
    backup.bus.on("chat.message", () => heard.push("chat.message"));
    backup.bus.on("task.state", () => heard.push("task.state"));
    backup.bus.on("task.ready", () => heard.push("task.ready"));
    backup.bus.on("thread.state", () => heard.push("thread.state"));
    // A tool and a hook written on the primary arrive as files and are loaded (the tool) or held (the hook).
    mkdirSync(primary.d.paths.tools, { recursive: true });
    writeFileSync(join(primary.d.paths.tools, "shout.ts"), `export default { name: "my.shout", description: "shouts", risk: "read", schema: { type: "object" }, run: (a) => String(a.text ?? "").toUpperCase() };\n`);
    writeFileSync(join(primary.d.paths.hooks, "marker.ts"), HOOK);
    await primary.d.editable.rescan();
    await waitFor(() => existsSync(join(backup!.paths.tools, "shout.ts")) && existsSync(join(backup!.paths.hooks, "marker.ts")), 10_000);
    await waitFor(() => backup!.tools.list().some((t) => t.name === "my.shout"), 10_000);
    // The hook ran on the primary (its start wrote the marker) and is held on the backup, whose start never runs.
    expect(primary.d.hooks.list().map((h) => h.name)).toEqual(["marker"]);
    expect(existsSync(marker)).toBe(true);
    const { rmSync: rm } = await import("node:fs");
    rm(marker, { force: true });
    expect(backup.hooks.list()).toEqual([]);
    await Bun.sleep(200);
    expect(existsSync(marker)).toBe(false);
    // The primary's work: a message and a task with a trigger. The backup's store has both; its client hears neither, and its scheduler leaves the task alone.
    const pc = await client(primary.d);
    clients.push(pc);
    await pc.request("chat.send", { text: "go" });
    await pc.next(isMethod("chat.message", (p) => (p as { message: Message }).message.role === "orchestrator"), 10_000);
    await waitFor(() => backup!.store.messages.dump().length === primary!.d.store.messages.dump().length && backup!.store.tasks.dump().length === 1, 10_000);
    await Bun.sleep(300);
    expect(heard).toEqual([]);
    expect(backup.store.tasks.dump()[0]!.status).toBe(primary.d.store.tasks.dump()[0]!.status);
    // A file removed on the primary goes on the backup too.
    const { rmSync } = await import("node:fs");
    rmSync(join(primary.d.paths.tools, "shout.ts"));
    await primary.d.editable.rescan();
    await waitFor(() => !existsSync(join(backup!.paths.tools, "shout.ts")), 10_000);
  }, 30_000);
});
