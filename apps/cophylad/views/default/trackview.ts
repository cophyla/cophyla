// A followed session's asks, as a strip at the foot of its header: the header stays on top
// while the timeline scrolls and over its terminal or Messages, so the strip is always in
// sight. One line per ask: its mark (an empty circle while open, a yellow dot answered in
// part, a green tick answered; a press marks it answered, or open again), what was asked, a
// button per message that answers it, and × to dismiss it. Over them a line with the count,
// which folds the list away, and Dismiss answered. A press on an answer opens it under the
// list, read out of the session's history, with Show in chat when the timeline holds it.
// A line says so when the asks cannot be checked (a usage limit, no account).
//
// The header carries the session's switch: Track, pressed while the tracker follows it. The
// clicks go by `data-action` to trackctl.ts.

import type { Tracked } from "@cophyla/protocol";
import { renderText } from "./markdown.ts";
import type { ViewState } from "./model.ts";
import { actionButton, clock, el, reconcile, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";
import { answerWords, follows, nextMark, statusWords, trackedOf, trackedSummary, trackerTrouble } from "./trackmodel.ts";

/** An answer open in a session's strip: which, and its words once read. */
export interface TrackReader {
  session: string;
  id: string;
  seq: number;
  n: number;
  of: number;
  status: "partial" | "answered";
  at: number;
  text?: string;
  failed?: string;
}

/** The strips' part of the view's own state. */
export interface TrackUi {
  /** Sessions whose strip is folded to its line. */
  folded: Set<string>;
  reader?: TrackReader;
  /** The newest answer this device showed, per session, by seq: one past it is still to read, and its tab has the green dot. */
  seen: Map<string, number>;
}

export function newTrackUi(): TrackUi {
  return { folded: new Set(), seen: new Map() };
}

/** Track, among the header's controls: pressed while the tracker follows the session. */
export function createTrackToggle(): HTMLButtonElement {
  const b = actionButton("tracked-toggle", "", "tracked-follow");
  b.append(el("span", "tracked-toggle-mark"), el("span", "tracked-toggle-word", "Track"));
  return b;
}

export function updateTrackToggle(b: HTMLButtonElement, session: string, state: ViewState): void {
  const offered = state.trackOn === true && state.tracker !== undefined && state.scopes.includes("sessions:write");
  setHidden(b, !offered);
  if (!offered) return;
  const on = follows(state, session);
  setData(b, "session", session);
  b.setAttribute("aria-pressed", String(on));
  const why = on ? "Cophyla follows what you ask this agent, and marks each ask answered when the agent answers it. Press to stop" : "Follow what you ask this agent: each ask shows over its chat, and is marked answered when the agent answers it";
  b.title = why;
  b.setAttribute("aria-label", on ? "Stop tracking this agent's asks" : "Track this agent's asks");
}

export function createTrackStrip(): HTMLElement {
  const strip = el("section", "tracked");
  strip.setAttribute("aria-label", "Asks");
  const bar = el("div", "tracked-bar");
  const fold = actionButton("tracked-fold", "", "tracked-fold");
  fold.append(el("span", "tracked-fold-glyph"), el("span", "tracked-summary"));
  bar.append(fold, actionButton("tracked-clear", "Dismiss answered", "tracked-dismiss-answered"));
  const trouble = el("p", "tracked-trouble");
  trouble.setAttribute("role", "status");
  const list = el("ol", "tracked-list");
  const reader = el("div", "tracked-reader");
  const head = el("div", "tracked-reader-head");
  head.append(el("span", "tracked-reader-what"), actionButton("tracked-reader-show", "Show in chat", "tracked-show"), actionButton("tracked-reader-close", "×", "tracked-reader-close"));
  head.querySelector<HTMLElement>(".tracked-reader-close")!.setAttribute("aria-label", "Close the answer");
  const text = el("div", "tracked-reader-text");
  reader.append(head, text);
  strip.append(bar, trouble, list, reader);
  return strip;
}

/** A session's strip: shown while the tracker follows it and it has asks, or a line to say why they are not checked. */
export function updateTrackStrip(strip: HTMLElement, session: string, state: ViewState, ui: UiState, inChat: (seq: number) => boolean): void {
  const on = state.trackOn === true && follows(state, session);
  const list = on ? trackedOf(state, session) : [];
  const trouble = on ? trackerTrouble(state) : undefined;
  setHidden(strip, list.length === 0 && trouble === undefined);
  // nothing to show: no rows left behind either, and no answer open
  if (list.length === 0) strip.querySelector<HTMLElement>(".tracked-list")!.replaceChildren();
  if (list.length === 0 && trouble === undefined) return;
  const folded = ui.track.folded.has(session);
  setData(strip, "folded", String(folded));
  const fold = strip.querySelector<HTMLButtonElement>(".tracked-fold")!;
  setData(fold, "session", session);
  fold.setAttribute("aria-expanded", String(!folded));
  fold.title = folded ? "Show the asks" : "Fold the asks away";
  setText(fold.querySelector(".tracked-summary")!, list.length === 0 ? "Asks" : trackedSummary(list));
  const clear = strip.querySelector<HTMLButtonElement>(".tracked-clear")!;
  setData(clear, "session", session);
  const answered = list.filter((t) => t.status === "answered").length;
  setHidden(clear, answered === 0 || !state.scopes.includes("sessions:write"));
  clear.title = `Take the ${answered === 1 ? "answered ask" : `${answered} answered asks`} off this list`;
  const troubleEl = strip.querySelector<HTMLElement>(".tracked-trouble")!;
  setHidden(troubleEl, trouble === undefined);
  setText(troubleEl, trouble ?? "");
  const ol = strip.querySelector<HTMLElement>(".tracked-list")!;
  setHidden(ol, folded || list.length === 0);
  const write = state.scopes.includes("sessions:write");
  const reading = ui.track.reader?.session === session ? ui.track.reader : undefined;
  if (!folded) reconcile(ol, list, (t) => t.id, createRow, (li, t) => updateRow(li, t, write, reading));
  const reader = strip.querySelector<HTMLElement>(".tracked-reader")!;
  const shown = reading && !folded && list.some((t) => t.id === reading.id) ? reading : undefined;
  setHidden(reader, shown === undefined);
  if (shown) updateReader(reader, shown, list.find((t) => t.id === shown.id)!, inChat(shown.seq));
}

function createRow(): HTMLElement {
  const li = el("li", "tracked-item");
  const mark = actionButton("tracked-mark", "", "tracked-mark");
  const title = el("span", "tracked-title");
  const answers = el("span", "tracked-answers");
  const dismiss = actionButton("tracked-dismiss", "×", "tracked-dismiss");
  li.append(mark, title, answers, dismiss);
  return li;
}

function updateRow(li: HTMLElement, t: Tracked, write: boolean, reading: TrackReader | undefined): void {
  setData(li, "status", t.status);
  setData(li, "marked", t.marked ? "1" : "");
  const mark = li.querySelector<HTMLButtonElement>(".tracked-mark")!;
  setData(mark, "id", t.id);
  setData(mark, "to", nextMark(t.status));
  mark.disabled = !write;
  const words = statusWords(t.status, t.marked);
  mark.setAttribute("aria-label", `${words}. ${write ? (t.status === "answered" ? "Mark it not answered" : "Mark it answered") : ""}`.trim());
  mark.title = `${words}${write ? (t.status === "answered" ? ". Press to mark it not answered" : ". Press to mark it answered") : ""}`;
  const title = li.querySelector<HTMLElement>(".tracked-title")!;
  setText(title, t.title);
  title.title = `${t.title}\nAsked ${clock(t.createdAt)}`;
  const answers = li.querySelector<HTMLElement>(".tracked-answers")!;
  reconcile(
    answers,
    t.answers.map((a, i) => ({ ...a, n: i + 1 })),
    (a) => String(a.seq),
    () => actionButton("tracked-answer", "", "tracked-answer"),
    (b, a) => {
      setText(b, String(a.n));
      setData(b, "id", t.id);
      setData(b, "session", t.session);
      setData(b, "seq", String(a.seq));
      setData(b, "n", String(a.n));
      setData(b, "of", String(t.answers.length));
      setData(b, "status", a.status);
      setData(b, "at", String(a.at));
      const label = `${answerWords(a.n, t.answers.length, a.status)}, ${clock(a.at)}`;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(reading?.id === t.id && reading.seq === a.seq));
    },
  );
  const dismiss = li.querySelector<HTMLButtonElement>(".tracked-dismiss")!;
  setData(dismiss, "id", t.id);
  setHidden(dismiss, !write);
  dismiss.title = "Dismiss this ask";
  dismiss.setAttribute("aria-label", `Dismiss: ${t.title}`);
}

function updateReader(reader: HTMLElement, r: TrackReader, t: Tracked, inChat: boolean): void {
  setText(reader.querySelector(".tracked-reader-what")!, `${answerWords(r.n, r.of, r.status)} · ${clock(r.at)} · ${t.title}`);
  const show = reader.querySelector<HTMLButtonElement>(".tracked-reader-show")!;
  setHidden(show, !inChat);
  setData(show, "session", r.session);
  setData(show, "seq", String(r.seq));
  show.title = "Show this answer where it is in the session's chat";
  const text = reader.querySelector<HTMLElement>(".tracked-reader-text")!;
  const phase = r.text !== undefined ? "ok" : r.failed !== undefined ? "failed" : "loading";
  setData(text, "state", phase);
  // drawn afresh only when another answer, or its words, came: a fresh body each time, since markdown keeps what it drew per element
  const key = `${r.id}:${r.seq}:${phase}`;
  if (text.dataset["shown"] === key) return;
  text.dataset["shown"] = key;
  const body = el("div", "tracked-reader-body");
  if (r.text !== undefined) renderText(body, r.text, true);
  else setText(body, r.failed ?? "Reading the answer…");
  text.replaceChildren(body);
}
