// A leader's message: an agent session, or the chat, that the user made a leader of a group of
// their sessions, so its words reach them as the user's own (see `leaders/`). Here: who it is
// from, as a send carries it, and the turn its delivery is recorded as.

import type { AgentRef } from "@cophyla/protocol";
import { capText } from "./model.ts";

/** Who leads the session a message goes to: the chat, or one of the user's agents. */
export interface LeadInfo {
  by: "chat" | AgentRef;
}

/** The user's turn a leader's message is recorded as: the user's words, sent by the leader. */
export function leadTurn(lead: LeadInfo, text: string, ref?: string, promptId?: string): Record<string, unknown> {
  return { text: capText(text), source: "lead", by: lead.by, ...(ref !== undefined ? { ref } : {}), ...(promptId !== undefined ? { promptId } : {}) };
}

/** Why an agent leader's text is refused before anything is typed: a slash command or a shell command would run there. */
export function leadCommand(text: string): string | undefined {
  const first = text.trimStart().charAt(0);
  if (first === "/") return "a leader's message may not start with /, which would run a slash command in the session";
  if (first === "!") return "a leader's message may not start with !, which would run a shell command in the session";
  return undefined;
}
