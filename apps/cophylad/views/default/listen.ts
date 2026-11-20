// Listening to a message instead of reading it: a Listen button on each of an agent's turns in
// its chat, on a note it left, on each of Cophyla Chat's replies, and on an agent's voice
// message (`voice_reply`), which is a card of its own. A press asks the node to read that
// message out on this device (`voice.preview {read}`), said for the ear and in the voice set in
// Settings. The button says it is getting it ready until the node says the first audio has left
// (`voice.state` speaking, `sounding`): an online voice takes seconds to answer. Then it is Stop,
// which ends it (`voice.preview {stop}`), and Listen again once it is over (`voice.state` idle for
// this client). When the voice could not read it, the idle says why (`failed`), and the words
// show beside the button for a while. Pressed again, it plays again, from the audio the node
// kept. Another message's Listen takes the place of the one playing. Nothing plays unless pressed.
//
// The buttons show only where this device can hear: an app that plays audio (its hello's
// `audio.out`) and a view with the voice scope. Each is drawn with its message; what it says,
// Listen or Stop, is painted over all of them after every draw (`paintListens`), since a chat
// reply already drawn is not drawn again.

import type { TimelineStep, ViewState } from "./model.ts";
import { canListen, voiceText } from "./listenmodel.ts";
import { remember } from "./listenctl.ts";
import { actionButton, el, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";

// --- the button ----------------------------------------------------------------------------------

export function createListen(): HTMLButtonElement {
  const b = actionButton("listen", "", "listen");
  b.append(el("span", "listen-mark"), el("span", "listen-word", "Listen"));
  b.hidden = true;
  return b;
}

/** The Listen in `parent`, made at its end when it has none (a reply that streamed is drawn without one). */
export function listenIn(parent: HTMLElement): HTMLButtonElement {
  return parent.querySelector<HTMLButtonElement>(":scope > .listen") ?? parent.appendChild(createListen());
}

/** A message's Listen, drawn with it: the words it reads, under the message's key; none for no words. */
export function updateListen(b: HTMLButtonElement, key: string, text: string, state: ViewState, ui: UiState): void {
  const words = text.trim();
  setData(b, "key", key);
  setData(b, "empty", words === "" ? "1" : "");
  if (words !== "") remember(key, words);
  paintListen(b, state, ui);
}

/** Shown or not; Listen, getting it ready, Stop, or not read out; as things stand now. */
function paintListen(b: HTMLButtonElement, state: ViewState, ui: UiState): void {
  const shown = canListen(state) && b.dataset["empty"] !== "1" && b.dataset["key"] !== undefined;
  setHidden(b, !shown);
  const key = b.dataset["key"];
  const failed = shown && ui.listen.failed !== undefined && ui.listen.failed.key === key ? ui.listen.failed.words : undefined;
  paintNote(b, failed);
  if (!shown) return;
  const phase = ui.listen.key === key ? ui.listen.phase : undefined;
  setData(b, "phase", phase ?? (failed !== undefined ? "failed" : ""));
  setText(b.querySelector(".listen-word")!, phase === "playing" ? "Stop" : phase === "starting" ? "Getting it ready…" : failed !== undefined ? "Not read out" : "Listen");
  const words = phase === "playing" ? "Stop reading it out" : phase === "starting" ? "Getting it ready: press to stop" : failed ?? "Listen to it, read out here";
  b.title = words;
  b.setAttribute("aria-label", words);
  b.setAttribute("aria-pressed", String(phase !== undefined));
}

/** Why the message was not read out, just before its button; none when it was. */
function paintNote(b: HTMLButtonElement, words: string | undefined): void {
  let note = b.previousElementSibling as HTMLElement | null;
  if (!note?.classList.contains("listen-note")) {
    if (words === undefined) return;
    note = el("span", "listen-note");
    note.setAttribute("role", "status");
    b.before(note);
  }
  setHidden(note, words === undefined);
  setText(note, words ?? "");
}

/** Every Listen on the page, painted as things stand now: after each draw. */
export function paintListens(root: ParentNode, state: ViewState, ui: UiState): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.listen")) paintListen(b, state, ui);
}

// --- an agent's voice message --------------------------------------------------------------------

/** A `voice_reply` call: what the agent said to the user, written out, and its Listen. */
export function createVoiceCard(): HTMLElement {
  const root = el("section", "tl-voice");
  const head = el("div", "tl-voice-head");
  head.append(el("span", "tl-voice-mark"), el("span", "tl-voice-word", "Voice message"), el("span", "tl-voice-state"), createListen());
  root.append(head, el("p", "tl-voice-text"));
  return root;
}

export function updateVoiceCard(node: HTMLElement, step: TimelineStep, key: string, state: ViewState, ui: UiState): void {
  const text = voiceText(step);
  const refused = step.result?.error === true;
  setData(node, "state", refused ? "refused" : "");
  setText(node.querySelector(".tl-voice-state")!, refused ? "not sent" : "");
  setText(node.querySelector(".tl-voice-text")!, text);
  updateListen(node.querySelector<HTMLButtonElement>(".tl-voice-head > .listen")!, key, refused ? "" : text, state, ui);
}
