// Listening to a message instead of reading it: a Listen button on each of an agent's turns in
// its chat, on a note it left, on each of Cophyla Chat's replies, and on an agent's voice
// message (`voice_reply`), which is a card of its own. A press asks the node to read that
// message out on this device (`voice.preview {read}`), said for the ear and in the voice set in
// Settings; the button is Stop while it plays, which ends it (`voice.preview {stop}`), and is
// Listen again once it is over (`voice.state` idle for this client). Pressed again, it plays
// again, from the audio the node kept. Another message's Listen takes the place of the one
// playing. Nothing plays unless pressed.
//
// The buttons show only where this device can hear: an app that plays audio (its hello's
// `audio.out`) and a view with the voice scope. Each is drawn with its message; what it says,
// Listen or Stop, is painted over all of them after every draw (`paintListens`), since a chat
// reply already drawn is not drawn again.

import type { TimelineStep, ViewState } from "./model.ts";
import { canListen, READ_MAX, voiceText } from "./listenmodel.ts";
import type { HostRpc } from "./rpc.ts";
import { actionButton, el, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";

/** What this device reads out now. */
export interface ListenUi {
  /** The message, by its button's key. */
  key?: string;
  /** Asked for and not answered yet, or playing. */
  phase?: "starting" | "playing";
}

export function newListenUi(): ListenUi {
  return {};
}

/** How many messages' words are kept for their buttons. */
const KEPT = 400;

// The words each button reads, by its key, kept as the buttons are drawn: the newest last.
const texts = new Map<string, string>();

function remember(key: string, text: string): void {
  texts.delete(key);
  texts.set(key, text);
  if (texts.size > KEPT) texts.delete(texts.keys().next().value!);
}

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

/** Shown or not, and Listen or Stop, as things stand now. */
function paintListen(b: HTMLButtonElement, state: ViewState, ui: UiState): void {
  const shown = canListen(state) && b.dataset["empty"] !== "1" && b.dataset["key"] !== undefined;
  setHidden(b, !shown);
  if (!shown) return;
  const phase = ui.listen.key === b.dataset["key"] ? ui.listen.phase : undefined;
  setData(b, "phase", phase ?? "");
  setText(b.querySelector(".listen-word")!, phase ? "Stop" : "Listen");
  const words = phase ? "Stop reading it out" : "Listen to it, read out here";
  b.title = words;
  b.setAttribute("aria-label", words);
  b.setAttribute("aria-pressed", String(phase !== undefined));
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

// --- the presses ---------------------------------------------------------------------------------

export interface ListenDeps {
  rpc: HostRpc;
  state: ViewState;
  ui: UiState;
  draw: () => void;
  fail: (what: string, e: unknown) => void;
}

export class ListenControl {
  private d: ListenDeps;

  constructor(deps: ListenDeps) {
    this.d = deps;
  }

  /** A press on a Listen button; false for any other. */
  click(target: HTMLElement): boolean {
    if (target.dataset["action"] !== "listen") return false;
    const key = target.dataset["key"];
    if (!key) return true;
    const l = this.d.ui.listen;
    if (l.key === key && l.phase !== undefined) void this.stop();
    else void this.play(key);
    return true;
  }

  /** What this device hears changed: once what it was reading is over, its button is Listen again. */
  voiceState(p: { state: string; client?: string }): void {
    const l = this.d.ui.listen;
    if (l.phase !== "playing") return;
    if (p.client !== undefined && p.client !== this.d.state.client?.id) return;
    if (p.state === "speaking") return;
    this.done();
    this.d.draw();
  }

  /** The line went: whatever was playing on it is over. */
  disconnected(): void {
    this.done();
  }

  private async play(key: string): Promise<void> {
    const text = texts.get(key);
    if (!text) return;
    const l = this.d.ui.listen;
    l.key = key;
    l.phase = "starting";
    this.d.draw();
    try {
      await this.d.rpc.request("voice.preview", { text: text.slice(0, READ_MAX), read: true });
      // Asked: it plays, in place of what played before, until the node says this device is idle.
      if (l.key === key && l.phase === "starting") {
        l.phase = "playing";
        this.d.draw();
      }
    } catch (e) {
      if (l.key === key) this.done();
      this.d.fail("listen", e);
      this.d.draw();
    }
  }

  private async stop(): Promise<void> {
    this.done();
    this.d.draw();
    try {
      await this.d.rpc.request("voice.preview", { stop: true });
    } catch (e) {
      this.d.fail("stop", e);
    }
  }

  private done(): void {
    const l = this.d.ui.listen;
    delete l.key;
    delete l.phase;
  }
}
