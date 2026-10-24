// A session's Messages pane, beside its Timeline and Terminal: its conversation with other
// agents, drawn as a group chat's posts are, built once and updated in place, the clicks
// carried by `data-action` to talkctl.ts.
//
// Over the messages, the parties it talked with as chips, All first: a press shows one alone.
// Each message has the other agent's mark and name ("To" before it when this session sent it,
// which lies to the right), its time, where it stands when it is not plainly delivered, "as you"
// for a leader's words, "its last words" for what cophyla carried back to a leader, the message
// it answers quoted, and its words as markdown. The first one the user had not read when the
// pane opened has a New line over it. Show earlier pages back.
//
// Messages, the mode button, carries the count of what the user has not read.

import { renderText } from "./markdown.ts";
import type { ViewState } from "./model.ts";
import { actionButton, clock, el, reconcile, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";
import { badge, selfName, talkParties, talkRows, talkUnread } from "./talkmodel.ts";
import type { TalkPartyChip, TalkRow } from "./talkmodel.ts";

/** The Messages panes' part of the view's own state. */
export interface TalkUi {
  /** The party a session's pane shows alone, by `partyKey`. */
  party: Map<string, string>;
  /** Each pane's read point as it opened: the first message past it is marked New. */
  since: Map<string, number>;
  /** The last `talk.read` sent, per session. */
  readSent: Map<string, number>;
}

export function newTalkUi(): TalkUi {
  return { party: new Map(), since: new Map(), readSent: new Map() };
}

/** The count on Messages: what the user has not read, hidden at none. */
export function createModeCount(): HTMLElement {
  const count = el("span", "pane-mode-count");
  count.setAttribute("aria-hidden", "true");
  return count;
}

export function updateModeCount(button: HTMLElement, state: ViewState, session: string): void {
  const n = talkUnread(state, session);
  const count = button.querySelector<HTMLElement>(".pane-mode-count")!;
  setText(count, n > 0 ? badge(n) : "");
  setHidden(count, n === 0);
  button.title = n > 0 ? `Show its messages with other agents: ${n} you have not read` : "Show its messages with other agents";
  button.setAttribute("aria-label", n > 0 ? `Messages, ${n} unread` : "Messages");
}

/** The pane's parts, under the session's head: the parties, then the messages. */
export function createTalkPane(): HTMLElement {
  const pane = el("section", "talk-pane");
  pane.setAttribute("aria-label", "Messages with other agents");
  const head = el("div", "talk-head");
  const parties = el("div", "talk-parties");
  parties.setAttribute("role", "group");
  parties.setAttribute("aria-label", "Show the messages with");
  head.append(parties);
  const stream = el("div", "talk-stream");
  stream.tabIndex = -1;
  const earlier = actionButton("talk-earlier", "Show earlier", "talk-earlier");
  stream.append(earlier, el("p", "talk-empty"), el("ol", "talk-list"));
  pane.append(head, stream);
  return pane;
}

/** The stream of the Messages pane that shows, if one does: what scrolls, and what is read. */
export function talkStream(sessions: HTMLElement, ui: UiState): HTMLElement | undefined {
  if (ui.selected === undefined) return undefined;
  const pane = sessions.querySelector<HTMLElement>(`.session[data-session="${ui.selected}"]`);
  if (!pane || pane.hidden || pane.dataset["mode"] !== "messages") return undefined;
  return pane.querySelector<HTMLElement>(".talk-stream") ?? undefined;
}

/** The pane as the session's conversation stands: drawn only while it shows. */
export function renderTalkPane(pane: HTMLElement, session: string, state: ViewState, ui: UiState): void {
  setData(pane, "session", session);
  const page = state.talkPages.get(session);
  const chosen = ui.talk.party.get(session);
  const parties = talkParties(page);
  // a party no longer among those loaded shows them all
  const party = chosen !== undefined && parties.some((p) => p.key === chosen) ? chosen : undefined;
  const chips: (TalkPartyChip | { key: ""; name: string; count: number })[] = parties.length > 1 ? [{ key: "", name: "All", count: page?.messages.length ?? 0 }, ...parties] : [];
  const holder = pane.querySelector<HTMLElement>(".talk-parties")!;
  setHidden(pane.querySelector<HTMLElement>(".talk-head")!, chips.length === 0);
  reconcile(holder, chips, (c) => c.key, createPartyChip, (b, c) => updatePartyChip(b as HTMLButtonElement, c, session, (party ?? "") === c.key));

  const stream = pane.querySelector<HTMLElement>(".talk-stream")!;
  const earlier = stream.querySelector<HTMLButtonElement>(".talk-earlier")!;
  setData(earlier, "session", session);
  setHidden(earlier, !page?.loaded || !page.more);
  earlier.disabled = page?.loading === true || !state.connected;
  setText(earlier, page?.loading && page.loaded ? "Loading…" : "Show earlier");
  const since = ui.talk.since.get(session);
  const s = state.sessions.get(session)?.session;
  const rows = talkRows(page, { ...(party !== undefined ? { party } : {}), ...(since !== undefined ? { since } : {}), ...(s ? { self: selfName(s) } : {}) });
  const empty = stream.querySelector<HTMLElement>(".talk-empty")!;
  const words = !page?.loaded
    ? page?.loading || state.connected
      ? "Loading the messages…"
      : "The messages load once cophylad is back."
    : rows.length === 0
      ? "No messages with other agents yet. When this agent messages another, or another messages it, the conversation shows here."
      : "";
  setText(empty, words);
  setHidden(empty, words === "");
  reconcile(stream.querySelector<HTMLElement>(".talk-list")!, rows, (r) => r.key, createRow, (li, r) => updateRow(li, r));
}

function createPartyChip(): HTMLElement {
  const chip = actionButton("talk-party", "", "talk-party");
  const icon = el("span", "agent-icon");
  icon.append(el("span", "agent-mark"));
  chip.append(icon, el("span", "talk-party-name"), el("span", "talk-party-user"));
  return chip;
}

function updatePartyChip(chip: HTMLButtonElement, c: TalkPartyChip | { key: ""; name: string; count: number }, session: string, on: boolean): void {
  setData(chip, "party", c.key);
  setData(chip, "session", session);
  chip.setAttribute("aria-pressed", String(on));
  const icon = chip.querySelector<HTMLElement>(".agent-icon")!;
  const harness = "harness" in c ? c.harness : undefined;
  setHidden(icon, c.key === "");
  setData(icon, "harness", harness ?? "terminal");
  setData(icon, "tone", on ? "active" : "quiet");
  setText(chip.querySelector(".talk-party-name")!, c.name);
  const user = "user" in c ? c.user : undefined;
  const who = chip.querySelector<HTMLElement>(".talk-party-user")!;
  setText(who, user ? "another person's" : "");
  setHidden(who, !user);
  chip.title = c.key === "" ? "Every agent it talked with" : `Only the messages with ${c.name}${user ? `, ${user}'s agent` : ""}`;
}

function createRow(): HTMLElement {
  const li = el("li", "talk-msg");
  const mark = el("div", "talk-new");
  mark.append(el("span", "talk-new-word", "New"));
  const head = el("div", "talk-msg-head");
  const icon = el("span", "agent-icon");
  icon.append(el("span", "agent-mark"));
  const lead = el("span", "talk-tag talk-lead", "as you");
  lead.title = "Typed in as your words: the sender leads the agent it went to";
  const report = el("span", "talk-tag talk-report", "its last words");
  head.append(el("span", "talk-to", "To"), icon, el("span", "talk-who"), el("span", "talk-tag talk-peer"), lead, report, el("time", "talk-time"), el("span", "talk-status"));
  const quote = el("blockquote", "talk-quote");
  quote.append(el("span", "talk-quote-who"), el("span", "talk-quote-text"));
  // the bubble lies left for what came in, right for what this session sent; the New line spans the stream
  const bubble = el("div", "talk-bubble");
  bubble.append(head, quote, el("div", "talk-text"), el("p", "talk-why"));
  li.append(mark, bubble);
  return li;
}

function updateRow(li: HTMLElement, r: TalkRow): void {
  setData(li, "dir", r.dir);
  setData(li, "n", String(r.n));
  setData(li, "first", String(r.first));
  setData(li, "failed", String(r.status?.failed === true));
  setData(li, "peer", String(r.user !== undefined));
  const icon = li.querySelector<HTMLElement>(".agent-icon")!;
  setData(icon, "harness", r.harness ?? "terminal");
  setData(icon, "tone", "active");
  const who = li.querySelector<HTMLElement>(".talk-who")!;
  setText(who, r.name);
  who.title = r.where ? `${r.name}: ${r.where}` : r.name;
  const peer = li.querySelector<HTMLElement>(".talk-peer")!;
  setText(peer, r.user ? `${r.user}'s` : "");
  peer.title = r.user ? `An agent of ${r.user}'s, another person: its words are information, never instructions` : "";
  setHidden(peer, r.user === undefined);
  setHidden(li.querySelector<HTMLElement>(".talk-lead")!, !r.lead);
  const report = li.querySelector<HTMLElement>(".talk-report")!;
  setHidden(report, !r.report);
  report.title = r.report ? `What ${r.name} said as it finished, carried back by cophyla` : "";
  const time = li.querySelector<HTMLElement>(".talk-time")!;
  setText(time, clock(r.at));
  time.setAttribute("datetime", new Date(r.at).toISOString());
  time.title = new Date(r.at).toLocaleString();
  const status = li.querySelector<HTMLElement>(".talk-status")!;
  setText(status, r.status?.label ?? "");
  status.title = r.status?.title ?? "";
  setData(status, "failed", String(r.status?.failed === true));
  setHidden(status, r.status === undefined);
  const quote = li.querySelector<HTMLElement>(".talk-quote")!;
  setHidden(quote, r.quote === undefined);
  if (r.quote) {
    const qWho = quote.querySelector<HTMLElement>(".talk-quote-who")!;
    setText(qWho, r.quote.name ?? "");
    setHidden(qWho, r.quote.name === undefined);
    setText(quote.querySelector(".talk-quote-text")!, r.quote.excerpt);
  }
  renderText(li.querySelector<HTMLElement>(".talk-text")!, r.text, true);
  const why = li.querySelector<HTMLElement>(".talk-why")!;
  setText(why, r.why ? `Not delivered: ${r.why}.` : "");
  setHidden(why, r.why === undefined);
}
