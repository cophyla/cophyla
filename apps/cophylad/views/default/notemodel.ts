// The notes agents leave the user (`notify_user`), as the view keeps them: every note from
// `note.list` and `note.state` (a dismissed one goes), whether agents may leave them from
// `notes.get` and `notes.state`, and what the bell, a session's strip, its tab and its timeline
// card show of them. Kept apart from model.ts, which folds these in through `applyNote`.

import type { Note } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";

/** Folds a notes action in; false when the action is none of them. */
export function applyNote(state: ViewState, action: Action): boolean {
  switch (action.type) {
    case "notes":
      // refused (an older node or app, or no primary yet): no bell, strip or card state shows
      state.notesOn = action.notes !== undefined;
      state.notes = new Map((action.notes ?? []).map((n) => [n.id, n]));
      return true;
    case "note.state": {
      const n = action.params;
      if (n.dismissed) state.notes.delete(n.id);
      else state.notes.set(n.id, n);
      return true;
    }
    case "notes.setting":
      if (action.setting) state.notesSetting = action.setting;
      else delete state.notesSetting;
      return true;
    case "notes.state":
      state.notesSetting = action.params;
      return true;
    default:
      return false;
  }
}

/** Whether a note is open: waiting for an answer not given yet, or else not read, and not dismissed. */
export function noteIsOpen(n: Pick<Note, "needsAnswer" | "read" | "answered" | "dismissed">): boolean {
  if (n.dismissed) return false;
  return n.needsAnswer ? !n.answered : n.read === undefined;
}

/** Whether a note still waits for the user's answer. */
export function noteWaits(n: Pick<Note, "needsAnswer" | "answered" | "dismissed">): boolean {
  return n.needsAnswer && !n.answered && !n.dismissed;
}

/** Every note for the bell's list: the open ones on top, each part newest first. */
export function bellNotes(state: Pick<ViewState, "notes">): Note[] {
  const all = [...state.notes.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return [...all.filter(noteIsOpen), ...all.filter((n) => !noteIsOpen(n))];
}

/** How many notes are open: the bell's count. */
export function openNoteCount(state: Pick<ViewState, "notes" | "notesOn">): number {
  if (state.notesOn !== true) return 0;
  let n = 0;
  for (const note of state.notes.values()) if (noteIsOpen(note)) n++;
  return n;
}

/** A session's open notes, oldest first: the dot on its tab. */
export function openNotesOf(state: Pick<ViewState, "notes" | "notesOn">, session: string): Note[] {
  if (state.notesOn !== true) return [];
  return [...state.notes.values()].filter((n) => n.session === session && noteIsOpen(n)).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/**
 * A session's notes for its strip, read ones too until dismissed, so each stays one press away at
 * the top of its chat: the open ones first, each part newest first.
 */
export function notesOf(state: Pick<ViewState, "notes" | "notesOn">, session: string): Note[] {
  if (state.notesOn !== true) return [];
  return bellNotes({ notes: new Map([...state.notes].filter(([, n]) => n.session === session)) });
}

/** A session's notes not read yet, which its chat shown to someone at it reads. */
export function unreadNotesOf(state: Pick<ViewState, "notes" | "notesOn">, session: string): Note[] {
  if (state.notesOn !== true) return [];
  return [...state.notes.values()].filter((n) => n.session === session && n.read === undefined && !n.dismissed);
}

/** The notes that are finished (read, or answered), which "Dismiss finished" takes off the list: every session's, or one's. */
export function finishedNotes(state: Pick<ViewState, "notes">, session?: string): Note[] {
  return [...state.notes.values()].filter((n) => !noteIsOpen(n) && (session === undefined || n.session === session));
}

/** The note a `notify_user` call in a session's timeline carries: by the call's id, else at its seq. */
export function noteAtCall(state: Pick<ViewState, "notes">, session: string, call: { id?: string; seq: number }): Note | undefined {
  let bySeq: Note | undefined;
  for (const n of state.notes.values()) {
    if (n.session !== session) continue;
    if (call.id !== undefined && n.call === call.id) return n;
    if (n.seq === call.seq) bySeq = n;
  }
  return bySeq;
}

/** Whether a call in a session's log is `notify_user`: Claude names it `mcp__cophyla-agents__notify_user`. */
export function isNotifyCall(tool: string): boolean {
  return /(^|__)notify_user$/.test(tool);
}

/** Where a note stands, in a few words: for its badge in the bell's list and its card. */
export function noteStateWords(n: Pick<Note, "needsAnswer" | "read" | "answered">): string {
  if (n.needsAnswer) return n.answered ? "answered" : "waiting for you";
  return n.read !== undefined ? "read" : "new";
}

/** What a session's strip of notes says on its line: "2 notes · 1 waiting for you". */
export function notesSummary(list: readonly Pick<Note, "needsAnswer" | "answered">[]): string {
  const waiting = list.filter((n) => n.needsAnswer && !n.answered).length;
  const parts = [`${list.length} note${list.length === 1 ? "" : "s"}`];
  if (waiting > 0) parts.push(`${waiting} waiting for you`);
  return parts.join(" · ");
}

/** The bell's words, for its title and label. */
export function bellWords(state: Pick<ViewState, "notes" | "notesOn">): string {
  const open = openNoteCount(state);
  const waiting = [...state.notes.values()].filter(noteWaits).length;
  if (open === 0) return "Notes: none new";
  return `Notes: ${open} new${waiting > 0 ? `, ${waiting} waiting for your answer` : ""}`;
}

/** A note's fields read from a `notify_user` call's arguments, for a card whose note is not known here (another device dismissed it, an older node). */
export function callNote(args: Record<string, unknown>): { title: string; detail?: string; needsAnswer: boolean; urgent: boolean } {
  const title = typeof args["title"] === "string" ? args["title"] : "A note";
  const detail = typeof args["detail"] === "string" && args["detail"].trim() !== "" ? args["detail"] : undefined;
  return { title, ...(detail !== undefined ? { detail } : {}), needsAnswer: args["needs_answer"] === true, urgent: args["urgent"] === true };
}
