// The default view's transfers, pure: the rows Transfers shows (the ones under way first, how
// far each is, its speed and the time left, why it waits or failed, `via relay`, and what may be
// done with it), a row going once it is dismissed and every row with the line, the machines a
// file can be sent to, and where Send to…'s picker starts.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Node, Transfer } from "@cophyla/protocol";
import { apply, downloadsIn, etaWords, initialState, selectTransfers, sendBlocked, sendTargets, transferRoute } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const AGHA = "node_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OLD = "node_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const LENT = "node_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const HANDS = "node_01ARZ3NDEKTSV4RRFFQ69G5FB0";

function node(id: string, name: string, over: Partial<Node> = {}, files = true): Node {
  return { id, name, role: "secondary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: false, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false, ...(files ? { files: true } : {}) }, versions: { platform: "0.17.0", protocol: 1 }, lastSeen: 0, ...over } as Node;
}

function connected(opts: { filePaths?: boolean; scopes?: Client["scopes"] } = {}): ViewState {
  const scopes = opts.scopes ?? [...ACCESS_PRESETS.full.scopes];
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.17.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes, ...(opts.filePaths ? { filePaths: true } : {}) };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  apply(state, {
    type: "nodes",
    nodes: [node(DESK, "Desk", { role: "primary" }), node(LAPTOP, "Laptop"), node(AGHA, "Agha", { status: "offline" }), node(OLD, "Studio", {}, false), node(LENT, "Lent", { scope: { kind: "workspaces", paths: ["C:\\shared"] } }), node(HANDS, "Ansar", { hands: true })],
  });
  return state;
}

const base = (over: Partial<Transfer>): Transfer => ({ id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", from: { node: LAPTOP, path: "/home/me/build.zip" }, to: { node: DESK, dir: "C:\\Users\\me\\Downloads" }, kind: "file", name: "build.zip", total: 100 * 1024 * 1024, bytes: 0, state: "queued", by: { kind: "user" }, startedAt: 1000, ...over });

describe("transfers in the view", () => {
  test("the ones under way first, with how far, the speed and the time left; then the ended ones, the latest first", () => {
    const state = connected({ filePaths: true });
    const running = base({ id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX2", state: "running", bytes: 25 * 1024 * 1024, rate: 5 * 1024 * 1024, via: "relay" });
    const done = base({ id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX3", state: "done", bytes: 100 * 1024 * 1024, to: { node: DESK, dir: "C:\\in", path: "C:\\in\\build (1).zip" }, endedAt: 5000 });
    const older = base({ id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX4", state: "cancelled", endedAt: 2000, from: { node: DESK, path: "C:\\x\\notes" }, to: { node: LAPTOP, dir: "/tmp" }, name: "notes", kind: "folder", files: { done: 1, total: 4 } });
    const waiting = base({ id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX5", state: "waiting", error: "waiting for Laptop", bytes: 50 * 1024 * 1024 });
    apply(state, { type: "transfers", transfers: [older, done, waiting, running] });
    const rows = selectTransfers(state);
    expect(rows.map((r) => r.state)).toEqual(["running", "waiting", "done", "cancelled"]);
    expect(rows[0]).toMatchObject({ name: "build.zip", route: "Laptop → Desk", done: 0.25, relay: true, words: "25 MB of 100 MB · 5 MB/s · 15 s left", cancel: true, retry: false, dismiss: false, reveal: false });
    expect(rows[1]).toMatchObject({ words: "Waiting for Laptop · 50 MB of 100 MB", cancel: true });
    expect(rows[2]).toMatchObject({ done: 1, words: "100 MB · done", dismiss: true, reveal: true, title: "/home/me/build.zip\n→ C:\\in\\build (1).zip" });
    expect(rows[3]).toMatchObject({ route: "Desk → Laptop", words: "Cancelled", reveal: false, dismiss: true });
  });

  test("a failed one says why and offers Retry and Dismiss; a folder counts its files", () => {
    const state = connected();
    apply(state, { type: "transfer.state", params: base({ state: "failed", error: "the disk is full", kind: "folder", name: "dist", files: { done: 2, total: 9 }, bytes: 10 }) });
    expect(selectTransfers(state)[0]).toMatchObject({ words: "Failed: the disk is full", retry: true, dismiss: true, cancel: false });
    apply(state, { type: "transfer.state", params: base({ state: "running", kind: "folder", name: "dist", files: { done: 2, total: 9 }, bytes: 1024 * 1024 }) });
    expect(selectTransfers(state)[0]!.words).toBe("1 MB of 100 MB, 2 of 9 files");
  });

  test("Show is for what landed on this computer, in the desktop app alone", () => {
    const landed = base({ state: "done", to: { node: DESK, dir: "C:\\in", path: "C:\\in\\build.zip" } });
    const phone = connected();
    apply(phone, { type: "transfer.state", params: landed });
    expect(selectTransfers(phone)[0]!.reveal).toBe(false);
    const desk = connected({ filePaths: true });
    apply(desk, { type: "transfer.state", params: landed });
    expect(selectTransfers(desk)[0]!.reveal).toBe(true);
    apply(desk, { type: "transfer.state", params: { ...landed, to: { node: LAPTOP, dir: "/in", path: "/in/build.zip" } } });
    expect(selectTransfers(desk)[0]!.reveal).toBe(false);
  });

  test("a dismissed one goes, and every row goes with the line, to come again with the list", () => {
    const state = connected();
    const t = base({ state: "done" });
    apply(state, { type: "transfer.state", params: t });
    apply(state, { type: "transfer.state", params: { ...t, dismissed: true } });
    expect(state.transfers.size).toBe(0);
    apply(state, { type: "transfers", transfers: [t, { ...base({ id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX9" }), dismissed: true }] });
    expect([...state.transfers.keys()]).toEqual([t.id]);
    apply(state, { type: "host.state", params: { connected: false } });
    expect(state.transfers.size).toBe(0);
  });

  test("a copy on one machine is named once; the time left reads as a person says it", () => {
    const state = connected();
    expect(transferRoute(state, { from: { node: DESK, path: "x" }, to: { node: DESK, dir: "y" } })).toBe("Desk");
    expect(etaWords(0.2)).toBe("1 s left");
    expect(etaWords(125)).toBe("2 min left");
    expect(etaWords(3 * 3600 + 20 * 60)).toBe("3 h 20 min left");
    expect(etaWords(7200)).toBe("2 h left");
    expect(etaWords(Number.POSITIVE_INFINITY)).toBe("");
  });

  test("Send to… offers the other computers there now that take files, this one first, hands ones too; never a lent one", () => {
    const state = connected();
    expect(sendTargets(state, LAPTOP)).toEqual([
      { node: DESK, name: "Desk", here: true },
      { node: HANDS, name: "Ansar", here: false },
    ]);
    apply(state, { type: "node.state", params: node(AGHA, "Agha") });
    expect(sendTargets(state, LAPTOP).map((t) => t.name)).toEqual(["Desk", "Agha", "Ansar"]);
    expect(sendTargets(state, DESK).map((t) => t.name)).toEqual(["Agha", "Ansar", "Laptop"]);
    expect(sendBlocked(state, DESK)).toBeUndefined();
    expect(sendBlocked(state, OLD)).toBe("Studio runs an older Cophyla, which sends no files: update it");
    expect(sendBlocked(connected({ scopes: ["sessions:read", "views"] }), DESK)).toBe("This app may not send files");
  });

  test("Send to…'s picker starts in the Downloads folder when the home has one", () => {
    expect(downloadsIn({ folders: [{ name: "Desktop", path: "C:\\Users\\me\\Desktop" }, { name: "Downloads", path: "C:\\Users\\me\\Downloads" }] })).toBe("C:\\Users\\me\\Downloads");
    expect(downloadsIn({ folders: [{ name: "downloads", path: "/home/me/downloads" }] })).toBe("/home/me/downloads");
    expect(downloadsIn({ folders: [{ name: "src", path: "/home/me/src" }] })).toBeUndefined();
  });
});
