// The default view's connections, pure: the rows Devices shows (this user's end and the other
// person's, the live ones first, a code not used yet with the time it has left), a row going
// when the node says it ended, the code on show until it is used or cancelled, the sessions a
// connection may be made for, what a session's pane says it is connected to, and how another
// person's message is labelled in a timeline.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Connection, Controller, Node, ClientSession as Session } from "@cophyla/protocol";
import { agentLabel, apply, connectableSessions, connectionBlock, connectionFailure, headConnectOffered, headConnectView, initialState, selectConnections, sessionConnections } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = 1_758_196_800_000;
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB4";

function connected(): ViewState {
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", scopes: [...ACCESS_PRESETS.full.scopes], via: "direct", audio: { in: false, out: false }, connectedAt: 1 };
  const ready: HostReady = { client, node: NODE, protocolVersion: 1, platformVersion: "0.16.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes: client.scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  const desk: Node = { id: NODE, name: "Desk", role: "primary", status: "online", via: "direct", platform: "windows", scope: { kind: "machine" }, capabilities: { brain: true, harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false }, versions: { platform: "0.16.0", protocol: 1 }, lastSeen: 0 } as Node;
  apply(state, { type: "nodes", nodes: [desk] });
  return state;
}

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, node: NODE, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: id + "-n", transport: "pipe" }, origin: "user", cwd: "C:\\work\\web", status: "idle", startedAt: 1, lastActivity: 1, ...over }) as Session;

const live: Connection = { id: "con_01ARZ3NDEKTSV4RRFFQ69G5FE1", state: "active", node: NODE, session: A, name: "web", peer: { user: "bob", name: "api-codex", harness: "codex", live: true }, by: "app", createdAt: NOW - 3_600_000, lastAt: NOW - 120_000, sent: 3, received: 2 };
const pending: Connection = { id: "con_01ARZ3NDEKTSV4RRFFQ69G5FE2", state: "pending", node: NODE, session: B, by: "agent", createdAt: NOW - 60_000, expiresAt: NOW + 14 * 60_000, sent: 0, received: 0 };

describe("connections in the view", () => {
  test("Devices shows the live ones first, mine ⇄ theirs, then a code not used yet with the time it holds", () => {
    const state = connected();
    apply(state, { type: "session.state", params: session(A, { title: "Login page" }) });
    apply(state, { type: "session.state", params: session(B, { harness: "codex", title: "API" }) });
    apply(state, { type: "connections", connections: [pending, live] });
    const rows = selectConnections(state, NOW);
    expect(rows.map((r) => r.id)).toEqual([live.id, pending.id]);
    expect(rows[0]).toMatchObject({ pending: false, mine: "web (Claude) on Desk", theirs: "bob/api-codex", tone: "live", words: "Codex at bob's · 3 sent, 2 received · last 2 min ago" });
    expect(rows[1]).toMatchObject({ pending: true, mine: "API (Codex) on Desk", theirs: "invited by its agent", tone: "pending", words: "the code holds 14:00 · not used yet" });
  });

  test("their terminal with no agent, and what waits, are said", () => {
    const state = connected();
    apply(state, { type: "connections", connections: [{ ...live, peer: { user: "bob", name: "terminal", live: false }, queued: 2, session: undefined, name: "web" } as Connection] });
    expect(selectConnections(state, NOW)[0]).toMatchObject({ mine: "web on Desk", tone: "idle", words: "no agent there now · 3 sent, 2 received · last 2 min ago · 2 waiting" });
  });

  test("an ended one goes; the code on show goes once it is used or cancelled", () => {
    const state = connected();
    apply(state, { type: "connections", connections: [pending] });
    apply(state, { type: "connection.code", code: { id: pending.id, code: "cophyla-connect:x", expiresAt: NOW + 900_000 } });
    expect(state.connectionCode?.id).toBe(pending.id);
    expect(selectConnections(state, NOW)[0]!.words).toBe("the code holds 14:00");
    apply(state, { type: "connection.state", params: { ...pending, state: "active", peer: { user: "bob", name: "api" } } });
    expect(state.connectionCode).toBeUndefined();
    apply(state, { type: "connection.state", params: { ...pending, state: "ended", reason: "its terminal closed" } });
    expect(state.connections.size).toBe(0);
  });

  test("a session's pane names who it is connected to; the chat's own and ended sessions are offered for none", () => {
    const state = connected();
    apply(state, { type: "session.state", params: session(A, { title: "Login page" }) });
    apply(state, { type: "session.state", params: session(B, { role: "assistant" }) });
    apply(state, { type: "connections", connections: [live, pending] });
    expect(sessionConnections(state, A)).toEqual(["bob/api-codex"]);
    expect(sessionConnections(state, B)).toEqual([]);
    expect(connectableSessions(state)).toEqual([{ id: A, label: "Login page (Claude on Desk)" }]);
  });

  test("a browser or phone whose access ends, or a shared computer's session, is told it makes no connection; the desktop app is not", () => {
    const state = connected();
    expect(connectionBlock(state)).toBeUndefined();
    const ctl = "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1";
    state.client = { ...state.client!, controller: ctl };
    const row = { id: ctl, name: "laptop browser", connected: true, pairedAt: 1, access: ACCESS_PRESETS.full, form: "browser" } as unknown as Controller;
    apply(state, { type: "controllers", controllers: [row] });
    expect(connectionBlock(state)).toBeUndefined();
    apply(state, { type: "controllers", controllers: [{ ...row, expiresAt: NOW + 3_600_000 }] });
    expect(connectionBlock(state)).toMatch(/^This browser's access ends/);
    apply(state, { type: "controllers", controllers: [{ ...row, session: true }] });
    expect(connectionBlock(state)).toMatch(/^A shared computer's session makes no connection/);
  });

  test("a session's header offers Connect for a live agent session of the user's, not for an ended one, the chat's own, or a client without the scope", () => {
    const state = connected();
    expect(headConnectOffered(state, session(A))).toBe(true);
    expect(headConnectOffered(state, session(A, { status: "ended" }))).toBe(false);
    expect(headConnectOffered(state, session(A, { role: "assistant" }))).toBe(false);
    state.scopes = state.scopes.filter((s) => s !== "controllers");
    expect(headConnectOffered(state, session(A))).toBe(false);
  });

  test("the Connect panel shows the form, then the code it made with the time it holds, then who it connected to; a cancelled code gives the form back", () => {
    const state = connected();
    const s = session(A, { mode: "bypassPermissions" });
    apply(state, { type: "session.state", params: s });
    const form = headConnectView(state, s, { mode: "invite" }, NOW);
    expect(form).toMatchObject({ kind: "form", mode: "invite" });
    expect(form.kind === "form" && form.note).toMatch(/fifteen minutes.*runs without permission prompts/);
    expect(headConnectView(state, s, { mode: "accept" }, NOW)).toMatchObject({ kind: "form", mode: "accept" });

    // made here: the code, until it is used
    const made: Connection = { ...pending, session: A, by: "app" };
    apply(state, { type: "connections", connections: [made] });
    apply(state, { type: "connection.code", code: { id: made.id, code: "cophyla-connect:x", expiresAt: NOW + 900_000 } });
    expect(headConnectView(state, s, { mode: "invite", made: made.id }, NOW)).toMatchObject({ kind: "code", left: "15:00", expired: false });
    // a code shown for another session's panel is not this one's
    expect(headConnectView(state, s, { mode: "invite" }, NOW).kind).toBe("form");

    // used: who it connected to
    apply(state, { type: "connection.state", params: { ...made, state: "active", peer: { user: "bob", name: "api-codex" } } });
    expect(headConnectView(state, s, { mode: "invite", made: made.id }, NOW)).toEqual({ kind: "connected", peer: "bob/api-codex" });

    // cancelled from Devices instead: the form again
    apply(state, { type: "connection.state", params: { ...made, state: "ended" } });
    expect(headConnectView(state, s, { mode: "invite", made: made.id }, NOW).kind).toBe("form");
  });

  test("a failed try is said in the panel, an app or a Cophyla older than connections as a reason to update", () => {
    const state = connected();
    const s = session(A);
    expect(headConnectView(state, s, { mode: "invite", error: "that code is for carol" }, NOW)).toMatchObject({ kind: "form", error: "that code is for carol" });
    expect(connectionFailure("unsupported", "unknown method connection.invite")).toMatch(/^This Cophyla app is older than connections: update it/);
    expect(connectionFailure("unsupported", "unsupported: connection.invite")).toMatch(/^Cophyla on this computer is older than connections/);
    expect(connectionFailure("denied", "the code is for carol")).toBe("the code is for carol");
  });

  test("a browser whose access ends sees why in the panel, not the forms", () => {
    const state = connected();
    const ctl = "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1";
    state.client = { ...state.client!, controller: ctl };
    apply(state, { type: "controllers", controllers: [{ id: ctl, name: "laptop browser", connected: true, pairedAt: 1, access: ACCESS_PRESETS.full, form: "browser", expiresAt: NOW + 3_600_000 } as unknown as Controller] });
    const v = headConnectView(state, session(A), { mode: "accept" }, NOW);
    expect(v.kind).toBe("blocked");
    expect(v.kind === "blocked" && v.why).toMatch(/^This browser's access ends/);
  });

  test("another person's message is labelled with their login, never as one of the user's own", () => {
    const state = connected();
    expect(agentLabel({ source: "agent", peer: { connection: live.id, user: "bob", name: "api-codex", harness: "codex" } }, { node: NODE }, state)).toBe("@bob/api-codex · Codex · bob's");
    expect(agentLabel({ source: "agent" }, { node: NODE }, state)).toBe("cophyla");
  });
});
