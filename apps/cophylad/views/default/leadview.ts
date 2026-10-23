// Leaders in the default view, drawn as render.ts draws the rest: built once, updated in place,
// the clicks carried by `data-action` to leadctl.ts.
//
// Lead, beside a session's Kill and at the end of the chat's head, opens a list over the pane:
// Every agent, or the user's other sessions ticked one by one under the rail's folder headings
// (a Claude session no one can type into there, but not to be ticked; one on a machine that
// takes no leader's words as its user's saying so); Lead them, or Save once
// the speaker leads; and under them Stop leading. On a phone's width the list rises from the
// bottom of the frame. A leader's tab has a mark beside its focus crescent, and the heads say
// what leads what: Leads 3 or Leads every agent on a leader, Led by on a session it speaks to.

import type { ClientSession as Session } from "@cophyla/protocol";
import { canLead, leaderChip, leadSetParams, leadUnchanged, ledByChip, leadTargets, speakerName } from "./model.ts";
import type { LeadChip, LeadGroup, LeadItem, ViewState } from "./model.ts";
import { actionButton, el, reconcile, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";

/** The list open over a pane: whose it is, Every agent or the sessions ticked, a request on its way, and why the last one failed. */
export interface LeadPop {
  speaker: string;
  all: boolean;
  picked: Set<string>;
  busy?: "set" | "remove";
  error?: string;
}

// --- Lead, and its list --------------------------------------------------------------------------

/** Lead, and the list it opens under it. */
export function createLeadControl(): HTMLElement {
  const wrap = el("div", "lead-control");
  const start = actionButton("lead-start", "", "lead-open");
  start.setAttribute("aria-haspopup", "dialog");
  const glyph = el("span", "lead-glyph");
  glyph.setAttribute("aria-hidden", "true");
  start.append(glyph, el("span", "lead-word", "Lead"));
  wrap.append(start, createLeadPop());
  return wrap;
}

function createLeadPop(): HTMLElement {
  const pop = el("div", "lead-pop");
  pop.setAttribute("role", "dialog");
  pop.hidden = true;
  const every = el("label", "agent-pick-item lead-every");
  const all = el("input", "lead-every-check");
  all.type = "checkbox";
  const text = el("span", "agent-pick-text");
  text.append(el("span", "agent-pick-handle", "Every agent"), el("span", "agent-pick-words"));
  every.append(all, text);
  const pick = el("div", "agent-pick lead-pick");
  pick.append(el("p", "agent-pick-status"), el("div", "agent-pick-groups"));
  const error = el("p", "lead-pop-error");
  error.setAttribute("role", "alert");
  const buttons = el("div", "lead-pop-buttons");
  buttons.append(actionButton("lead-save", "Lead them", "lead-save"), actionButton("lead-cancel", "Cancel", "lead-cancel"));
  // Under the rest, once the speaker leads: it leads no one.
  const stop = actionButton("lead-stop", "Stop leading", "lead-stop");
  stop.title = "It leads no one: its messages reach the agents as another agent's again";
  pop.append(el("p", "lead-pop-title"), el("p", "lead-pop-lede"), every, pick, error, buttons, stop);
  return pop;
}

/** A speaker's Lead: shown where it may lead and this view may change leaders; its list while open. */
export function updateLeadControl(wrap: HTMLElement, speaker: string, state: ViewState, ui: UiState): void {
  const shown = canLead(state, speaker);
  setHidden(wrap, !shown);
  if (!shown) return;
  const open = ui.lead?.speaker === speaker ? ui.lead : undefined;
  const leads = state.leaders.has(speaker);
  const name = speakerName(state, speaker) ?? "this agent";
  const start = wrap.querySelector<HTMLButtonElement>(".lead-start")!;
  setData(start, "speaker", speaker);
  setData(start, "leads", String(leads));
  start.setAttribute("aria-expanded", String(open !== undefined));
  start.disabled = !state.connected;
  const words = leads ? `Change whom ${name} leads, or stop it leading` : `Make ${name} a leader: it speaks to the agents you pick as you`;
  if (start.title !== words) {
    start.title = words;
    start.setAttribute("aria-label", words);
  }
  const pop = wrap.querySelector<HTMLElement>(".lead-pop")!;
  setHidden(pop, open === undefined);
  if (open) renderLeadPop(pop, open, state, name);
}

function renderLeadPop(pop: HTMLElement, p: LeadPop, state: ViewState, name: string): void {
  const chat = p.speaker === "chat";
  const leads = state.leaders.has(p.speaker);
  const busy = p.busy !== undefined || !state.connected;
  pop.setAttribute("aria-label", `Whom ${name} leads`);
  setText(pop.querySelector(".lead-pop-title")!, `${name} leads`);
  setText(pop.querySelector(".lead-pop-lede")!, "Its messages reach the agents you pick as your own words, and it may answer their questions as you.");
  const all = pop.querySelector<HTMLInputElement>(".lead-every-check")!;
  setData(all, "speaker", p.speaker);
  all.checked = p.all;
  all.disabled = busy;
  setText(pop.querySelector(".lead-every .agent-pick-words")!, chat ? "Yours now and later" : "Yours now and later, but this one");
  const groups = leadTargets(state, p.speaker);
  const pick = pop.querySelector<HTMLElement>(".lead-pick")!;
  setData(pick, "all", String(p.all));
  const status = pick.querySelector<HTMLElement>(".agent-pick-status")!;
  const none = groups.length === 0 ? "No other agent of yours is open now." : "";
  setText(status, none);
  setHidden(status, none === "");
  reconcile(pick.querySelector<HTMLElement>(".agent-pick-groups")!, groups, (g) => g.key, createLeadGroup, (n, g) => updateLeadGroup(n, g, p, busy));
  const error = pop.querySelector<HTMLElement>(".lead-pop-error")!;
  setText(error, p.error ?? "");
  setHidden(error, p.error === undefined);
  const save = pop.querySelector<HTMLButtonElement>(".lead-save")!;
  setText(save, p.busy === "set" ? "Saving…" : leads ? "Save" : "Lead them");
  // Nothing to send until the list names a group, and, once it leads, another one.
  save.disabled = busy || "error" in leadSetParams(state, p) || leadUnchanged(state, p);
  pop.querySelector<HTMLButtonElement>(".lead-cancel")!.disabled = p.busy !== undefined;
  const stop = pop.querySelector<HTMLButtonElement>(".lead-stop")!;
  setHidden(stop, !leads);
  setText(stop, p.busy === "remove" ? "Stopping…" : "Stop leading");
  stop.disabled = busy;
}

function createLeadGroup(): HTMLElement {
  const group = el("fieldset", "agent-pick-group");
  group.append(el("legend", "agent-pick-title"), el("div", "agent-pick-items"));
  return group;
}

function updateLeadGroup(node: HTMLElement, g: LeadGroup, p: LeadPop, busy: boolean): void {
  setText(node.querySelector(".agent-pick-title")!, g.title);
  reconcile(node.querySelector<HTMLElement>(".agent-pick-items")!, g.items, (i) => i.id, createLeadItem, (n, i) => updateLeadItem(n, i, p, busy));
}

function createLeadItem(): HTMLElement {
  const label = el("label", "agent-pick-item lead-item");
  const box = el("input", "lead-check");
  box.type = "checkbox";
  const icon = el("span", "agent-icon");
  icon.append(el("span", "agent-mark"));
  const text = el("span", "agent-pick-text");
  text.append(el("span", "agent-pick-handle"), el("span", "agent-pick-words"));
  label.append(box, icon, text);
  return label;
}

function updateLeadItem(label: HTMLElement, i: LeadItem, p: LeadPop, busy: boolean): void {
  const blocked = i.blocked !== undefined;
  setData(label, "blocked", String(blocked));
  setData(label, "note", String(i.note !== undefined));
  const box = label.querySelector<HTMLInputElement>(".lead-check")!;
  setData(box, "session", i.id);
  // Every agent holds every one it can type into: shown ticked, and left as the user ticked them underneath.
  box.checked = !blocked && (p.all || p.picked.has(i.id));
  box.disabled = busy || blocked || p.all;
  const icon = label.querySelector<HTMLElement>(".agent-icon")!;
  setData(icon, "harness", i.harness);
  setData(icon, "tone", blocked ? "quiet" : "active");
  setText(label.querySelector(".agent-pick-handle")!, i.label);
  setText(label.querySelector(".agent-pick-words")!, i.words);
  label.title = `${i.label}: ${i.words}`;
}

// --- the marks -------------------------------------------------------------------------------------

/** A leader's mark on its tab, beside the focus crescent. */
export function createTabLead(): HTMLElement {
  const mark = el("span", "tab-lead");
  mark.setAttribute("role", "img");
  mark.hidden = true;
  return mark;
}

/** A tab's leader mark: shown while its speaker leads, what it leads in its hover, which the tab's hover says too. */
export function updateTabLead(tab: HTMLElement, state: ViewState, speaker: string): string | undefined {
  const chip = leaderChip(state, speaker);
  const mark = tab.querySelector<HTMLElement>(".tab-lead");
  if (mark) {
    setHidden(mark, chip === undefined);
    mark.setAttribute("aria-label", chip ? `a leader: ${chip.text.toLowerCase()}` : "");
    mark.title = chip?.title ?? "";
  }
  return chip?.text;
}

/** A head's chip of what its speaker leads, with the leader's mark. */
export function createLeaderChip(): HTMLElement {
  const chip = el("span", "lead-chip lead-leads");
  const glyph = el("span", "lead-glyph");
  glyph.setAttribute("aria-hidden", "true");
  chip.append(glyph, el("span", "lead-chip-words"));
  chip.hidden = true;
  return chip;
}

/** A session pane's chip of the leaders that speak to it. */
export function createLedChip(): HTMLElement {
  const chip = el("span", "lead-chip lead-led");
  chip.append(el("span", "lead-chip-words"));
  chip.hidden = true;
  return chip;
}

function updateChip(chip: HTMLElement, c: LeadChip | undefined): void {
  setHidden(chip, c === undefined);
  if (!c) return;
  setText(chip.querySelector(".lead-chip-words")!, c.text);
  chip.title = c.title;
}

/** A session pane's chips: Leads while it leads, Led by while a leader speaks to it. */
export function updateLeadChips(head: HTMLElement, s: Session, state: ViewState): void {
  updateChip(head.querySelector<HTMLElement>(":scope > .lead-leads")!, leaderChip(state, s.id));
  updateChip(head.querySelector<HTMLElement>(":scope > .lead-led")!, ledByChip(state, s));
}

/** The chat head's chip: what Cophyla leads, while it does. */
export function updateChatLeadChip(chip: HTMLElement, state: ViewState): void {
  updateChip(chip, leaderChip(state, "chat"));
}
