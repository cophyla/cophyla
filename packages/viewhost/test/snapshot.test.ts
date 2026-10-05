// The snapshot cache: the latest picture per session, workspace, node, open task and open
// ask, replayed in the daemon's post-hello order, idempotent.

import { describe, expect, test } from "bun:test";
import type { RpcNotification } from "@cophyla/protocol";
import { SnapshotCache } from "../src/snapshot.ts";

const n = (method: string, params: unknown): RpcNotification => ({ jsonrpc: "2.0", method, params });

describe("snapshot cache", () => {
  test("keeps the latest session.state per id and drops ended ones", () => {
    const c = new SnapshotCache();
    c.upsert(n("session.state", { id: "sess_1", status: "idle" }));
    c.upsert(n("session.state", { id: "sess_1", status: "busy" }));
    c.upsert(n("session.state", { id: "sess_2", status: "idle" }));
    expect(c.sessions.get("sess_1")).toEqual({ id: "sess_1", status: "busy" } as never);
    c.upsert(n("session.state", { id: "sess_2", status: "ended" }));
    expect(c.sessions.has("sess_2")).toBe(false);
  });

  test("keeps open asks only, and every workspace", () => {
    const c = new SnapshotCache();
    c.upsert(n("ask.state", { id: "ask_1", status: "open" }));
    c.upsert(n("ask.state", { id: "ask_2", status: "open" }));
    c.upsert(n("ask.state", { id: "ask_1", status: "answered" }));
    c.upsert(n("workspace.state", { id: "ws_1", name: "a" }));
    c.upsert(n("workspace.state", { id: "ws_1", name: "b" }));
    expect([...c.asks.keys()]).toEqual(["ask_2"]);
    expect(c.workspaces.get("ws_1")).toEqual({ id: "ws_1", name: "b" } as never);
  });

  test("ignores other notifications and malformed params", () => {
    const c = new SnapshotCache();
    c.upsert(n("audit.entry", { id: "aud_1" }));
    c.upsert(n("session.event", { session: "sess_1", seq: 1 }));
    c.upsert(n("session.state", "nope"));
    c.upsert(n("session.state", { status: "idle" }));
    expect(c.replay()).toEqual([]);
  });

  test("keeps open tasks only", () => {
    const c = new SnapshotCache();
    c.upsert(n("task.state", { id: "task_1", status: "ready" }));
    c.upsert(n("task.state", { id: "task_2", status: "blocked" }));
    c.upsert(n("task.state", { id: "task_1", status: "done" }));
    expect([...c.tasks.keys()]).toEqual(["task_2"]);
  });

  test("keeps the latest node.state per id", () => {
    const c = new SnapshotCache();
    c.upsert(n("node.state", { id: "node_1", name: "desk", status: "online" }));
    c.upsert(n("node.state", { id: "node_1", name: "desk", status: "offline" }));
    c.upsert(n("node.state", { id: "node_2", name: "laptop", status: "online" }));
    expect([...c.nodes.keys()]).toEqual(["node_1", "node_2"]);
    expect(c.nodes.get("node_1")).toEqual({ id: "node_1", name: "desk", status: "offline" } as never);
  });

  test("replays asks, then sessions, workspaces, nodes and tasks; a replay is idempotent; clear empties it", () => {
    const c = new SnapshotCache();
    c.upsert(n("task.state", { id: "task_1", status: "ready" }));
    c.upsert(n("node.state", { id: "node_1", status: "online" }));
    c.upsert(n("workspace.state", { id: "ws_1" }));
    c.upsert(n("session.state", { id: "sess_1", status: "idle" }));
    c.upsert(n("ask.state", { id: "ask_1", status: "open" }));
    const first = c.replay();
    expect(first.map((x) => x.method)).toEqual(["ask.state", "session.state", "workspace.state", "node.state", "task.state"]);
    for (const x of first) c.upsert(x);
    expect(c.replay()).toEqual(first);
    c.clear();
    expect(c.replay()).toEqual([]);
  });

  test("keeps the latest remote.state per node, replayed after the nodes, and drops it on clear", () => {
    const c = new SnapshotCache();
    const host = { kind: "apollo", status: "ready" };
    c.upsert(n("remote.state", { node: "node_1", host: { kind: "apollo", status: "starting" }, viewers: [], streaming: false }));
    c.upsert(n("remote.state", { node: "node_1", host, viewers: [], streaming: true }));
    c.upsert(n("remote.state", { node: "node_2", host, viewers: [], streaming: false }));
    c.upsert(n("remote.state", { host }));
    c.upsert(n("node.state", { id: "node_1", status: "online" }));
    c.upsert(n("task.state", { id: "task_1", status: "ready" }));
    expect(c.remote.get("node_1")).toEqual({ node: "node_1", host, viewers: [], streaming: true } as never);
    expect(c.replay().map((x) => x.method)).toEqual(["node.state", "remote.state", "remote.state", "task.state"]);
    c.clear();
    expect(c.remote.size).toBe(0);
  });

  test("keeps the latest voice.state, replayed last, and drops it on clear", () => {
    const c = new SnapshotCache();
    c.upsert(n("voice.state", { state: "listening", client: "cli_1" }));
    c.upsert(n("ask.state", { id: "ask_1", status: "open" }));
    c.upsert(n("voice.state", { state: "thinking", client: "cli_1" }));
    expect(c.replay().map((x) => x.method)).toEqual(["ask.state", "voice.state"]);
    expect(c.replay()[1]!.params).toEqual({ state: "thinking", client: "cli_1" });
    c.upsert(n("voice.state", "nope"));
    expect(c.voice).toEqual({ state: "thinking", client: "cli_1" });
    c.clear();
    expect(c.voice).toBeUndefined();
  });

  test("keeps this client's words heard so far whole, replayed after the voice state, until the utterance ends or its message is named", () => {
    const c = new SnapshotCache();
    c.upsert(n("voice.state", { state: "listening", client: "cli_1", limit: 570 }));
    c.upsert(n("voice.partial", { client: "cli_1", text: "What is the" }));
    c.upsert(n("voice.partial", { client: "cli_1", text: " status?", from: 11 }));
    expect(c.replay().map((x) => x.method)).toEqual(["voice.state", "voice.partial"]);
    // The whole text, with nothing to keep from before: a late view has seen none of it.
    expect(c.replay()[1]!.params).toEqual({ client: "cli_1", text: "What is the status?" });
    // Another client's state leaves it; the partial naming the message ends it.
    c.upsert(n("voice.state", { state: "idle", client: "cli_2" }));
    expect(c.heard).toBeDefined();
    c.upsert(n("voice.partial", { client: "cli_1", text: "", from: 19, message: "msg_1" }));
    expect(c.heard).toBeUndefined();
    // So do the utterance's end and a new one's start, and a clear.
    c.upsert(n("voice.partial", { client: "cli_1", text: "never mind" }));
    c.upsert(n("voice.state", { state: "idle", client: "cli_1" }));
    expect(c.heard).toBeUndefined();
    c.upsert(n("voice.partial", { client: "cli_1", text: "again" }));
    c.upsert(n("voice.state", { state: "listening", client: "cli_1" }));
    expect(c.heard).toBeUndefined();
    c.upsert(n("voice.partial", { client: "cli_1", text: "again" }));
    c.clear();
    expect(c.heard).toBeUndefined();
  });

  test("keeps the account and a voice setup in progress, replayed after the voice state, so a late view is not signed out", () => {
    const c = new SnapshotCache();
    c.upsert(n("account.state", { plan: "free", limits: {} }));
    c.upsert(n("account.state", { plan: "pro", limits: {}, subject: "usr_1", connected: true }));
    c.upsert(n("voice.setup", { stage: "stt", engine: "nemotron", step: "download", progress: 0.4 }));
    c.upsert(n("voice.state", { state: "idle" }));
    c.upsert(n("account.state", "nope"));
    expect(c.replay().map((x) => x.method)).toEqual(["voice.state", "voice.setup", "account.state"]);
    expect(c.replay()[2]!.params).toEqual({ plan: "pro", limits: {}, subject: "usr_1", connected: true });
    // a setup that ended has nothing left to show
    c.upsert(n("voice.setup", { stage: "stt", engine: "nemotron", step: "ready" }));
    expect(c.voiceSetup).toBeUndefined();
    c.clear();
    expect(c.account).toBeUndefined();
  });

  test("keeps the latest voice.next, replayed after the setup, so a late view shows the speaker as it is", () => {
    const c = new SnapshotCache();
    c.upsert(n("voice.next", { speak: true, target: "cli_1", name: "Pixel" }));
    c.upsert(n("voice.next", { speak: false, hushed: true }));
    c.upsert(n("voice.next", { speak: "yes" }));
    c.upsert(n("voice.setup", { stage: "stt", engine: "nemotron", step: "download", progress: 0.4 }));
    c.upsert(n("account.state", { plan: "free", limits: {} }));
    expect(c.replay().map((x) => x.method)).toEqual(["voice.setup", "voice.next", "account.state"]);
    expect(c.replay()[1]!.params).toEqual({ speak: false, hushed: true });
    c.clear();
    expect(c.voiceNext).toBeUndefined();
  });

  test("keeps each node's direct.state, replayed after the account, so a late view shows the switch as it is", () => {
    const c = new SnapshotCache();
    c.upsert(n("direct.state", { node: "node_1", state: "starting", peers: [] }));
    c.upsert(n("direct.state", { node: "node_1", state: "ready", port: 51820, peers: [] }));
    c.upsert(n("direct.state", { node: "node_2", state: "off", peers: [] }));
    c.upsert(n("direct.state", { state: "ready" }));
    c.upsert(n("account.state", { plan: "pro", limits: {} }));
    const replay = c.replay();
    expect(replay.map((x) => x.method)).toEqual(["account.state", "direct.state", "direct.state"]);
    expect(replay[1]!.params).toEqual({ node: "node_1", state: "ready", port: 51820, peers: [] });
    c.clear();
    expect(c.direct.size).toBe(0);
  });

  test("keeps the brain's turn while it runs, replayed last, and forgets it when the turn ends", () => {
    const c = new SnapshotCache();
    const turn = { steps: [{ text: "Checked agent sessions", status: "done" }], thinking: true };
    c.upsert(n("chat.progress", { turn }));
    c.upsert(n("account.state", { plan: "pro", limits: {} }));
    expect(c.replay().map((x) => x.method)).toEqual(["account.state", "chat.progress"]);
    expect(c.replay()[1]!.params).toEqual({ turn });
    c.upsert(n("chat.progress", {}));
    expect(c.progress).toBeUndefined();
    expect(c.replay().map((x) => x.method)).toEqual(["account.state"]);
    c.upsert(n("chat.progress", { turn }));
    c.clear();
    expect(c.progress).toBeUndefined();
  });

  test("keeps where the chat's session stands, the latest alone, replayed after the brain's turn", () => {
    const c = new SnapshotCache();
    c.upsert(n("assistant.state", { status: "starting", harness: "claude" }));
    c.upsert(n("chat.progress", { turn: { steps: [], thinking: true } }));
    c.upsert(n("assistant.state", { status: "idle", harness: "claude", model: "sonnet", context: { used: 41_000, limit: 300_000 } }));
    // Something that is no state of it changes nothing.
    c.upsert(n("assistant.state", { harness: "codex" }));
    const replay = c.replay();
    expect(replay.map((x) => x.method)).toEqual(["chat.progress", "assistant.state"]);
    expect(replay[1]!.params).toEqual({ status: "idle", harness: "claude", model: "sonnet", context: { used: 41_000, limit: 300_000 } });
    c.clear();
    expect(c.assistant).toBeUndefined();
    expect(c.replay()).toEqual([]);
  });
});
