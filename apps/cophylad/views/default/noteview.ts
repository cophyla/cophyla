// The notes agents leave the user, drawn: the bell in the rail's top row (and in the phone's
// bar) with how many are open, and the list it drops across every session, open notes on top,
// each newest first: the session it is from, its title, its detail in markdown, when, and
// whether it waits for the user. Open goes to it in the session's chat (and marks it read),
// Dismiss takes it off; one that waits has a reply box, whose words go to the session as the
// user's next message, which answers it. "Dismiss finished" at the foot.
//
// A session with open notes has them in a strip under its header, folded to a line; and each
// note is a card of its own in the timeline, where the agent left it. The clicks go by
// `data-action` to notectl.ts.

import type { Note } from "@cophyla/protocol";
import { renderText } from "./markdown.ts";
import type { TimelineStep, ViewState } from "./model.ts";
import { callArgs, sessionLabel } from "./model.ts";
import { bellNotes, bellWords, callNote, finishedNotes, noteAtCall, noteIsOpen, notesSummary, noteStateWords, noteWaits, openNoteCount, openNotesOf } from "./notemodel.ts";
import { actionButton, clock, el, reconcile, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";

/** The notes' part of the view's own state. */
export interface NoteUi {
  /** The bell's list is down. */
  open: boolean;
  /** Sessions whose strip is folded to its line. */
  folded: Set<string>;
  /** Replies on their way, by note. */
  sending: Set<string>;
  /** Why a reply did not go, by note. */
  failed: Map<string, string>;
}

export function newNoteUi(): NoteUi {
  return { open: false, folded: new Set(), sending: new Set(), failed: new Map() };
}

// --- the bell ----------------------------------------------------------------------------------

/** The bell: a press drops the list; the count of open notes on it. */
export function createBell(className: string): HTMLButtonElement {
  const b = actionButton(`notes-bell ${className}`, "", "notes-bell");
  b.setAttribute("aria-haspopup", "dialog");
  b.append(bellIcon(), el("span", "notes-bell-count"));
  return b;
}

export function updateBell(b: HTMLButtonElement, state: ViewState, ui: UiState): void {
  setHidden(b, state.notesOn !== true);
  if (state.notesOn !== true) return;
  const open = openNoteCount(state);
  const waits = [...state.notes.values()].some(noteWaits);
  const count = b.querySelector<HTMLElement>(".notes-bell-count")!;
  setText(count, open > 99 ? "99+" : String(open));
  setHidden(count, open === 0);
  setData(b, "open", open > 0 ? "1" : "");
  setData(b, "waits", waits ? "1" : "");
  b.setAttribute("aria-expanded", String(ui.notes.open));
  const words = bellWords(state);
  b.title = words;
  b.setAttribute("aria-label", words);
}

function bellIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("notes-bell-icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M8 1.75a4.25 4.25 0 0 0-4.25 4.25v2.6L2.5 11.1v.9h11v-.9l-1.25-2.5V6A4.25 4.25 0 0 0 8 1.75ZM6.25 13a1.75 1.75 0 0 0 3.5 0");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

// --- the list the bell drops -------------------------------------------------------------------

export function createNotesPanel(): HTMLElement {
  const panel = el("section", "notes-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Notes");
  panel.hidden = true;
  const head = el("header", "notes-panel-head");
  head.append(el("h2", "notes-panel-title", "Notes"), actionButton("notes-panel-close", "×", "notes-bell"));
  head.querySelector<HTMLElement>(".notes-panel-close")!.setAttribute("aria-label", "Close the notes");
  const off = el("p", "notes-panel-off");
  const empty = el("p", "notes-empty", "No notes. An agent leaves you one when it has something you should read, or a question for you.");
  const foot = el("footer", "notes-panel-foot");
  foot.append(actionButton("notes-clear", "Dismiss finished", "notes-dismiss-finished"));
  panel.append(head, off, el("ol", "notes-list"), empty, foot);
  return panel;
}

export function updateNotesPanel(panel: HTMLElement, state: ViewState, ui: UiState): void {
  const shown = ui.notes.open && state.notesOn === true;
  setHidden(panel, !shown);
  if (!shown) return;
  const list = bellNotes(state);
  const write = state.scopes.includes("sessions:write");
  const off = panel.querySelector<HTMLElement>(".notes-panel-off")!;
  setText(off, state.notesSetting?.on === false ? "Agents cannot leave you notes now: it is switched off in Settings › Sessions." : "");
  setHidden(off, state.notesSetting?.on !== false);
  setHidden(panel.querySelector<HTMLElement>(".notes-empty")!, list.length > 0);
  reconcile(panel.querySelector<HTMLElement>(".notes-list")!, list, (n) => n.id, createNoteRow, (li, n) => updateNoteRow(li, n, state, ui, write));
  const finished = finishedNotes(state).length;
  const clear = panel.querySelector<HTMLButtonElement>(".notes-clear")!;
  setHidden(panel.querySelector<HTMLElement>(".notes-panel-foot")!, finished === 0 || !write);
  clear.title = `Take the ${finished === 1 ? "note you read or answered" : `${finished} notes you read or answered`} off the list`;
}

function createNoteRow(): HTMLElement {
  const li = el("li", "note-row");
  const head = el("div", "note-row-head");
  const who = el("span", "note-session");
  who.append(el("span", "note-session-name"));
  head.append(who, el("span", "note-badge"), el("time", "note-time"));
  const title = actionButton("note-title", "", "note-open");
  const detail = el("div", "note-detail");
  const answer = el("p", "note-answer");
  const reply = el("form", "note-reply");
  const text = el("textarea", "note-reply-text");
  text.rows = 2;
  text.placeholder = "Answer…";
  text.setAttribute("aria-label", "Your answer, sent to the agent as your next message");
  const send = el("button", "note-reply-send", "Send");
  send.type = "submit";
  reply.append(text, send, el("p", "note-reply-failed"));
  const actions = el("div", "note-actions");
  actions.append(actionButton("note-go", "Open", "note-open"), actionButton("note-reopen", "Not answered", "note-reopen"), actionButton("note-dismiss", "Dismiss", "note-dismiss"));
  li.append(head, title, detail, answer, reply, actions);
  return li;
}

function updateNoteRow(li: HTMLElement, n: Note, state: ViewState, ui: UiState, write: boolean): void {
  const open = noteIsOpen(n);
  setData(li, "open", open ? "1" : "0");
  setData(li, "waits", noteWaits(n) ? "1" : "");
  setData(li, "urgent", n.urgent ? "1" : "");
  const card = state.sessions.get(n.session);
  const name = card ? sessionLabel(card.session) : "an ended session";
  const who = li.querySelector<HTMLElement>(".note-session")!;
  setText(who.querySelector(".note-session-name")!, name);
  setData(who, "harness", card?.session.harness ?? "");
  who.title = card ? `${card.session.harness} · ${card.session.cwd}` : "Its session has ended";
  const badge = li.querySelector<HTMLElement>(".note-badge")!;
  const words = noteStateWords(n);
  setText(badge, n.urgent && open ? `urgent · ${words}` : words);
  setData(badge, "state", n.needsAnswer ? (n.answered ? "answered" : "waiting") : n.read !== undefined ? "read" : "new");
  const time = li.querySelector<HTMLElement>(".note-time")!;
  setText(time, clock(n.at));
  time.setAttribute("datetime", new Date(n.at).toISOString());
  for (const b of Array.from(li.querySelectorAll<HTMLButtonElement>("button[data-action]"))) {
    setData(b, "id", n.id);
    setData(b, "session", n.session);
    setData(b, "seq", String(n.seq));
  }
  const title = li.querySelector<HTMLButtonElement>(".note-title")!;
  setText(title, n.title);
  title.title = card ? "Open it where it was left in the session's chat" : "Its session has ended";
  title.disabled = !card;
  const go = li.querySelector<HTMLButtonElement>(".note-go")!;
  go.disabled = !card;
  go.title = title.title;
  const detail = li.querySelector<HTMLElement>(".note-detail")!;
  setHidden(detail, n.detail === undefined);
  if (n.detail !== undefined) renderText(detail, n.detail, true);
  const answer = li.querySelector<HTMLElement>(".note-answer")!;
  setHidden(answer, !n.answered);
  setText(answer, n.answered ? (n.answered.text ? `You answered: ${n.answered.text}` : "Marked answered") : "");
  const reopen = li.querySelector<HTMLButtonElement>(".note-reopen")!;
  setHidden(reopen, !n.answered || !write);
  reopen.title = "Open it again: your next message to the agent answers it";
  const reply = li.querySelector<HTMLFormElement>(".note-reply")!;
  const replies = noteWaits(n) && write && card !== undefined && card.session.status !== "ended";
  setHidden(reply, !replies);
  setData(reply, "id", n.id);
  setData(reply, "session", n.session);
  const sending = ui.notes.sending.has(n.id);
  reply.querySelector<HTMLButtonElement>(".note-reply-send")!.disabled = sending || !state.connected;
  reply.querySelector<HTMLTextAreaElement>(".note-reply-text")!.disabled = sending;
  const failed = reply.querySelector<HTMLElement>(".note-reply-failed")!;
  const why = ui.notes.failed.get(n.id);
  setText(failed, why ?? "");
  setHidden(failed, why === undefined);
  setHidden(li.querySelector<HTMLButtonElement>(".note-dismiss")!, !write);
}

// --- a session's strip ---------------------------------------------------------------------------

export function createNotesStrip(): HTMLElement {
  const strip = el("section", "notes-strip");
  strip.setAttribute("aria-label", "Notes from this agent");
  strip.hidden = true;
  const fold = actionButton("notes-strip-fold", "", "notes-fold");
  fold.append(el("span", "notes-strip-glyph"), el("span", "notes-strip-summary"));
  strip.append(fold, el("ol", "notes-strip-list"));
  return strip;
}

/** A session's open notes under its header: a line with how many, which folds the list of them away. */
export function updateNotesStrip(strip: HTMLElement, session: string, state: ViewState, ui: UiState): void {
  const list = openNotesOf(state, session);
  setHidden(strip, list.length === 0);
  const ol = strip.querySelector<HTMLElement>(".notes-strip-list")!;
  if (list.length === 0) {
    ol.replaceChildren();
    return;
  }
  const folded = ui.notes.folded.has(session);
  setData(strip, "folded", String(folded));
  setData(strip, "waits", list.some(noteWaits) ? "1" : "");
  const fold = strip.querySelector<HTMLButtonElement>(".notes-strip-fold")!;
  setData(fold, "session", session);
  fold.setAttribute("aria-expanded", String(!folded));
  fold.title = folded ? "Show the notes" : "Fold the notes away";
  setText(fold.querySelector(".notes-strip-summary")!, notesSummary(list));
  setHidden(ol, folded);
  if (folded) return;
  const write = state.scopes.includes("sessions:write");
  reconcile(ol, list, (n) => n.id, createStripRow, (li, n) => {
    setData(li, "waits", noteWaits(n) ? "1" : "");
    const b = li.querySelector<HTMLButtonElement>(".notes-strip-title")!;
    setText(b, n.title);
    setData(b, "id", n.id);
    setData(b, "session", n.session);
    setData(b, "seq", String(n.seq));
    b.title = `${noteStateWords(n)} · ${clock(n.at)}\nOpen it where it was left`;
    setText(li.querySelector(".notes-strip-badge")!, noteWaits(n) ? "waiting for you" : "");
    const x = li.querySelector<HTMLButtonElement>(".notes-strip-dismiss")!;
    setData(x, "id", n.id);
    setHidden(x, !write);
    x.setAttribute("aria-label", `Dismiss: ${n.title}`);
    x.title = "Dismiss this note";
  });
}

function createStripRow(): HTMLElement {
  const li = el("li", "notes-strip-item");
  li.append(actionButton("notes-strip-title", "", "note-open"), el("span", "notes-strip-badge"), actionButton("notes-strip-dismiss", "×", "note-dismiss"));
  return li;
}

// --- the card in the timeline --------------------------------------------------------------------

export function createNotifyCard(): HTMLElement {
  const root = el("section", "tl-notify");
  const head = el("div", "tl-notify-head");
  head.append(bellIcon(), el("span", "tl-notify-word", "Note for you"), el("span", "tl-notify-state"));
  root.append(head, el("div", "tl-notify-title"), el("div", "tl-notify-detail"), el("p", "tl-notify-answer"));
  return root;
}

/** A `notify_user` call, drawn as the note it left: from the note as the node keeps it, else from the call's own words. */
export function updateNotifyCard(node: HTMLElement, step: TimelineStep, seq: number, session: string, state: Pick<ViewState, "notes">): void {
  const note = noteAtCall(state, session, { ...(step.id !== undefined ? { id: step.id } : {}), seq });
  const from = note ?? callNote(callArgs(step.args));
  setData(node, "id", note?.id ?? "");
  const refused = step.result?.error === true;
  const phase = refused ? "refused" : note ? (note.needsAnswer ? (note.answered ? "answered" : "waiting") : note.read !== undefined ? "read" : "new") : from.needsAnswer ? "asked" : "left";
  setData(node, "state", phase);
  setData(node, "urgent", from.urgent ? "1" : "");
  const words = refused ? "not left" : note ? noteStateWords(note) : from.needsAnswer ? "asked for your answer" : "";
  setText(node.querySelector(".tl-notify-state")!, words);
  setText(node.querySelector(".tl-notify-title")!, from.title);
  const detail = node.querySelector<HTMLElement>(".tl-notify-detail")!;
  setHidden(detail, from.detail === undefined);
  if (from.detail !== undefined) renderText(detail, from.detail, true);
  const answer = node.querySelector<HTMLElement>(".tl-notify-answer")!;
  const answered = note?.answered;
  const said = refused ? resultWords(step.result?.value) : answered ? (answered.text ? `You answered: ${answered.text}` : "Marked answered") : "";
  setText(answer, said);
  setHidden(answer, said === "");
}

/** Why the node refused a note, as the agent was told. */
function resultWords(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((v): v is { text: string } => typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string");
    if (first) return first.text;
  }
  return "";
}
