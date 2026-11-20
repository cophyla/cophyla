// Listening to a message: a voice_reply call is its own card, never folded into the steps; a
// turn's Listen reads its words without its tools; the buttons show only where the device can
// hear.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Session, SessionEvent } from "@cophyla/protocol";
import { canListen, isVoiceCall, turnText, voiceText } from "../views/default/listenmodel.ts";
import { apply, initialState, selectTimeline, timelinePosts } from "../views/default/model.ts";
import type { HostReady, TimelinePost, ViewState } from "../views/default/model.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";

function connected(out: boolean, scopes = [...ACCESS_PRESETS.full.scopes]): ViewState {
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: out, out }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.28.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  return state;
}

function session(id: string): Session {
  return { id, node: DESK, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: `n-${id}`, transport: "pipe" }, origin: "user", cwd: "C:\\src", status: "idle", startedAt: 1, lastActivity: 1 } as Session;
}

const ev = (seq: number, kind: SessionEvent["kind"], payload: unknown): SessionEvent => ({ session: A, seq, at: 1000 + seq, kind, payload });

describe("listening to a message", () => {
  test("a voice_reply call is its own card, never folded into the steps; the turn's Listen reads its words alone", () => {
    const s = connected(true);
    apply(s, { type: "session.state", params: session(A) });
    apply(s, { type: "tab.open", session: A });
    const tool = "mcp__cophyla-agents__voice_reply";
    const events = [
      ev(1, "assistant_text", { text: "## Done\n\nThe migration ran." }),
      ev(2, "tool_call", { tool: "Bash", id: "b1", args: { command: "bun test" } }),
      ev(3, "tool_call", { tool, id: "toolu_V", args: { text: "  The migration is done, and every test passes.  " } }),
      ev(4, "tool_result", { tool, id: "toolu_V", result: "Your user has your voice message: they play it in Cophyla when they want." }),
      ev(5, "tool_call", { tool: "Read", id: "r1", args: { file_path: "a.ts" } }),
      ev(6, "assistant_text", { text: "Three tables moved." }),
    ];
    apply(s, { type: "history", session: A, opened: s.sessions.get(A)!.opened, events, limit: 50 });
    const posts = timelinePosts(selectTimeline(s, s.sessions.get(A)!));
    const turn = posts.find((p): p is Extract<TimelinePost, { kind: "turn" }> => p.kind === "turn")!;
    expect(turn.parts.map((p) => p.kind)).toEqual(["text", "steps", "voice", "steps", "text"]);
    const card = turn.parts[2]!;
    if (card.kind !== "voice") throw new Error("not a voice part");
    expect(card).toMatchObject({ key: "e3", step: { id: "toolu_V", tool } });
    expect(card.step.result).toMatchObject({ error: false });
    expect(voiceText(card.step)).toBe("The migration is done, and every test passes.");
    expect(turnText(turn)).toBe("## Done\n\nThe migration ran.\n\nThree tables moved.");
  });

  test("a voice_reply is known by its name under any harness's prefix, and a call cut short still gives its words", () => {
    expect(isVoiceCall("voice_reply")).toBe(true);
    expect(isVoiceCall("mcp__cophyla-agents__voice_reply")).toBe(true);
    expect(isVoiceCall("cophyla-agents__voice_reply")).toBe(true);
    expect(isVoiceCall("voice_reply_x")).toBe(false);
    expect(isVoiceCall("my_voice_reply")).toBe(false);
    expect(voiceText({ args: '{"text":"Half of what I said' })).toBe("Half of what I said");
    expect(voiceText({ args: {} })).toBe("");
  });

  test("the buttons show where the app plays audio and the view may use voice, while connected", () => {
    expect(canListen(connected(true))).toBe(true);
    expect(canListen(connected(false))).toBe(false);
    expect(canListen(connected(true, ACCESS_PRESETS.full.scopes.filter((x) => x !== "voice")))).toBe(false);
    const away = connected(true);
    apply(away, { type: "host.state", params: { connected: false } });
    expect(canListen(away)).toBe(false);
  });
});
