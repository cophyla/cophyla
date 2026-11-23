// A machine's Web pages, on its card in Devices under its desktop: its localhost opened from
// here, as if this device sat at that machine. First what this client has open of it, a line
// each (`localhost:3000`, where it is reached here and how its bytes go, with Open where this
// computer's browser opens it and Close), and while one is reached on this computer's loopback
// the plain word that any program here can use it until it closes; then what listens there, a
// port and its program a line with Open, Refresh in the block's head; then a field to type a
// port into and Open it; and under it all why the last Open did not go, in the node's words.
// The clicks and the form go by `data-action` and class to portctl.ts.

import type { ViewState } from "./model.ts";
import { openingKey, selectPorts } from "./portmodel.ts";
import type { ForwardRow, ListenRow, PortsCard } from "./portmodel.ts";
import type { Node } from "@cophyla/protocol";
import { actionButton, el, reconcile, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";

export function createPorts(): HTMLElement {
  const block = el("section", "node-ports");
  const head = el("div", "ports-head");
  const refresh = actionButton("ports-refresh", "Refresh", "ports-refresh");
  refresh.classList.add("link");
  refresh.title = "Read again what listens on this machine";
  head.append(el("h4", "ports-label", "Web pages"), el("span", "ports-words"), refresh);
  const form = el("form", "ports-form");
  const port = el("input", "ports-port");
  port.type = "text";
  port.inputMode = "numeric";
  port.autocomplete = "off";
  port.maxLength = 5;
  port.pattern = "\\d{1,5}";
  port.required = true;
  port.placeholder = "port";
  port.setAttribute("aria-label", "a port to open");
  const submit = el("button", "ports-submit", "Open");
  submit.type = "submit";
  form.append(port, submit);
  block.append(head, el("div", "ports-open"), el("p", "ports-note"), el("div", "ports-list"), form, el("p", "ports-error"));
  return block;
}

/** The block of a machine's card: hidden where there is none to show. */
export function updatePorts(block: HTMLElement, node: Node, state: ViewState, ui: UiState): void {
  const card = selectPorts(state, node);
  setHidden(block, card === undefined);
  if (!card) return;
  setData(block, "node", card.node);
  const words = block.querySelector<HTMLElement>(".ports-words")!;
  setText(words, card.loading ? "reading what listens…" : card.error !== undefined ? `what listens could not be read: ${card.error}` : card.none ? "nothing listens that can be opened" : "");
  setData(words, "error", card.error !== undefined && !card.loading ? "1" : "0");
  const refresh = block.querySelector<HTMLButtonElement>(".ports-refresh")!;
  refresh.dataset["node"] = card.node;
  refresh.disabled = !state.connected || card.loading;
  reconcile(block.querySelector<HTMLElement>(".ports-open")!, card.open, (r) => r.key, createForward, (e, r) => updateForward(e, r, card, state, ui));
  const note = block.querySelector<HTMLElement>(".ports-note")!;
  setText(note, card.note ?? "");
  setHidden(note, card.note === undefined);
  reconcile(block.querySelector<HTMLElement>(".ports-list")!, card.listening, (r) => r.key, createListening, (e, r) => updateListening(e, r, card, state, ui));
  const form = block.querySelector<HTMLFormElement>(".ports-form")!;
  form.dataset["node"] = card.node;
  form.querySelector<HTMLButtonElement>(".ports-submit")!.disabled = !state.connected;
  const error = block.querySelector<HTMLElement>(".ports-error")!;
  const failed = ui.ports.errors.get(card.node);
  setText(error, failed ?? "");
  setHidden(error, failed === undefined);
}

/** One port this client has open: its address, where it is reached and how, what its number being taken breaks, Open and Close. */
function createForward(): HTMLElement {
  const row = el("div", "ports-forward");
  const main = el("div", "ports-forward-main");
  main.append(el("span", "ports-address"), el("span", "ports-forward-words"), el("span", "ports-moved"));
  row.append(main, actionButton("ports-forward-open", "Open", "port-link"), actionButton("ports-close", "Close", "port-close"));
  return row;
}

function updateForward(row: HTMLElement, r: ForwardRow, card: PortsCard, state: ViewState, ui: UiState): void {
  row.title = r.title;
  setText(row.querySelector(".ports-address")!, r.address);
  setText(row.querySelector(".ports-forward-words")!, r.words);
  const moved = row.querySelector<HTMLElement>(".ports-moved")!;
  setText(moved, r.note ?? "");
  setHidden(moved, r.note === undefined);
  const open = row.querySelector<HTMLButtonElement>(".ports-forward-open")!;
  setHidden(open, r.url === undefined);
  if (r.url !== undefined) open.dataset["url"] = r.url;
  open.title = `Open ${r.address} of ${card.name}'s in this computer's browser`;
  open.disabled = !state.connected;
  const close = row.querySelector<HTMLButtonElement>(".ports-close")!;
  const closing = ui.ports.closing.has(r.id);
  setText(close, closing ? "Closing…" : "Close");
  close.dataset["id"] = r.id;
  close.disabled = !state.connected || closing;
}

/** One port that listens on the machine: its number, its program, Open. */
function createListening(): HTMLElement {
  const row = el("div", "ports-row");
  row.append(el("span", "ports-number"), el("span", "ports-program"), actionButton("ports-row-open", "Open", "port-open"));
  return row;
}

function updateListening(row: HTMLElement, r: ListenRow, card: PortsCard, state: ViewState, ui: UiState): void {
  row.title = r.title;
  setData(row, "open", r.open ? "1" : "0");
  setText(row.querySelector(".ports-number")!, String(r.port));
  setText(row.querySelector(".ports-program")!, r.program);
  const open = row.querySelector<HTMLButtonElement>(".ports-row-open")!;
  const opening = ui.ports.opening.has(openingKey(card.node, r.port));
  setText(open, opening ? "Opening…" : "Open");
  open.title = `Open localhost:${r.port} of ${card.name}'s here`;
  open.dataset["node"] = card.node;
  open.dataset["port"] = String(r.port);
  open.disabled = !state.connected || opening;
}
