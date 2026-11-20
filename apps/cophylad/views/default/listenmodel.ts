// What a Listen button reads, and whether this device can hear it: kept apart from the buttons
// (listen.ts) so the tests can read them with no page.

import type { TimelinePost, TimelineStep, ViewState } from "./model.ts";
import { callArgs } from "./model.ts";

/** The longest message the node reads out (`VOICE_READ_MAX` in the protocol). */
export const READ_MAX = 100_000;

/** A call of the agents' `voice_reply`, however its harness names an MCP tool. */
export function isVoiceCall(tool: string): boolean {
  return /(^|__)voice_reply$/.test(tool);
}

/** What a voice message says: the call's text. */
export function voiceText(step: Pick<TimelineStep, "args">): string {
  const text = callArgs(step.args)["text"];
  return typeof text === "string" ? text.trim() : "";
}

/** What one of an agent's turns wrote: its words, in order, without its tools' calls. */
export function turnText(post: Extract<TimelinePost, { kind: "turn" }>): string {
  return post.parts
    .filter((p): p is Extract<typeof p, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text.trim())
    .filter((t) => t !== "")
    .join("\n\n");
}

/** Whether this device can hear a message read out: the app plays audio, and the view may use voice. */
export function canListen(state: Pick<ViewState, "connected" | "scopes" | "client">): boolean {
  return state.connected && state.scopes.includes("voice") && state.client?.audio?.out === true;
}
