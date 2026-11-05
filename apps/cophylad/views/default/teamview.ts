// Group chats, focus and teammates in the default view, drawn as render.ts draws the rest:
// keyed rows, built once and updated in place, the clicks carried by `data-action` to
// teamctl.ts.
//
// A group chat is a tab in the rail, under the folder its home names or under Groups: two
// heads, its name, its unread count, and a dot while the user is tagged. Its pane: a head with
// the name and purpose (Edit changes them), ⋮ with Delete, and End group for its maker; the
// members as chips (busy or idle, in focus, gone struck through, notices held, unread), the
// user's own agents with Every post | Tags only and Remove, and Add; then the posts, each with
// its writer and time, the post it answers quoted, its tags lit (the user's own brighter), a
// mark while it waits for a reply, its thumbs up, Reply, and the agents it tags that have not
// read it; and a composer that completes tags. An ended group is read only.
//
// A team's own chat is the team: its head has the team's gear, which opens the team's page (its
// settings), in place of Edit and an empty ⋮; its members end with the people invited into the
// team; and its Add offers the agents of the people in the team, and, to the team's owner or an
// admin, each teammate not in it by themselves, whom picking invites into the team, with
// Someone else, by GitHub name… for anyone who is no teammate yet.
//
// ⋮ → New group lays a form over the panes: name, purpose, how agents added are told, and the
// agents to put in, the user's own by machine and folder and teammates' under their login.
// ⋮ → Teammates lays a page over them, as Devices does: each teammate with what each side
// shares, Edit and End, and the agents of the user's joined to theirs, with End and the asks;
// the codes not used yet; Invite a teammate and Enter a code, each with the share form, which
// asks before it shares a whole home folder or drive.
//
// A session in focus has a mark on its tab and a line under its pane's head, with End focus.
// Its Connect panel, "Connect this agent", has what it is joined to (Connected), a block per
// teammate saying in words how it stands with them and what changes it, with their agents to
// Connect or to ask for, and Someone else, the code for a person who is not a teammate. Under
// the rail's Status, a workspace shared closed with a teammate is a line with Open and Exclude.

import type { Group, GroupCandidate, GroupNotify, ClientSession as Session, TeammatePlace, ClientWorkspace as Workspace } from "@cophyla/protocol";
import { createAttach, createPostMedia, newMediaUi, renderAttach, renderPostMedia, renderViewer } from "./groupmedia.ts";
import type { MediaUi } from "./groupmedia.ts";
import { renderText } from "./markdown.ts";
import {
  addWords,
  broadWords,
  canEndGroup,
  candidateGroups,
  closedPlaces,
  focusWords,
  groupMe,
  groupMemberWords,
  groupTabWords,
  machineName,
  memberChips,
  placeKey,
  postExcerpt,
  postView,
  postWriter,
  selectTeammates,
  sessionFocus,
  teamBlock,
  teamChatPick,
  teamConnectionRows,
  teamEndWords,
  connectNoTeam,
  connectTeamBlocks,
  connectedRows,
} from "./model.ts";
import type { BroadPlace, CandidateGroup, CandidateItem, ClosedPlace, ConnectAgentRow, ConnectedRow, ConnectTeamBlock, MemberChip, PostView, TeamAgentsSeen, TeamConnectionRow, TeammateRow, ViewState } from "./model.ts";
import { actionButton, clock, createFolderPicker, el, fitField, messageField, reconcile, renderFolderPicker, renderTalk, sectionHead, setData, setHidden, setText, talkButton } from "./render.ts";
import type { FolderBrowse, UiState } from "./render.ts";
import { createHubTeamRow, createJoinTeam, createNewTeam, createTeamHome, renderJoinTeam, renderNewTeam, renderTeamHome, teamOverlayTitle, updateHubTeamRow } from "./teamsview.ts";
import type { JoinUi, NewTeamUi, TeamPageUi } from "./teamsview.ts";

// --- what the user has open ---------------------------------------------------------------------

/** A picker of agents for a group: the candidates once listed, the ones ticked by `candidateKey`, why none could be listed, a request on its way and why it failed. */
export interface AgentPick {
  candidates?: GroupCandidate[];
  picked: Set<string>;
  loadError?: string;
  busy?: boolean;
  error?: string;
}

/** New group's form: its picker, and how the agents added are told, Tags only until the user picks. */
export interface NewGroupForm extends AgentPick {
  notify: GroupNotify;
}

/**
 * The share form, open to invite, to use a code or to change a teammate's share: Include or
 * Exclude, the folders ticked (by `folderKey`), how open, the picker while Other folder… shows
 * it, the broad folders it is asked about in place, and a request on its way or why it failed.
 */
export interface ShareForm {
  /** A teammate's code made or used, or a teammate's share changed; a team made, joined, or its share changed. */
  kind: "invite" | "accept" | "edit" | "create" | "join" | "team";
  teammate?: string;
  /** The team whose share it changes. */
  team?: string;
  /** The invite it joins with. */
  offer?: string;
  mode: "include" | "exclude";
  picked: Map<string, TeammatePlace>;
  open: "always" | "chosen";
  browse?: FolderBrowse;
  broad?: BroadPlace[];
  /** The user said Share it to the question: the share goes as it is. */
  broadOk?: boolean;
  busy?: boolean;
  error?: string;
}

/** Group chats' and teammates' part of the view's own state: what is open, and what is on its way. */
export interface TeamUi {
  newGroup?: NewGroupForm;
  /** Add, under a group's head. */
  addMembers?: AgentPick & { group: string };
  /** A group's name and purpose being changed in its head. */
  editGroup?: { group: string; busy?: boolean; error?: string };
  /** A group's ⋮, with Delete or End asked in place, and on its way. */
  groupMenu?: { group: string; asking?: "delete" | "end"; busy?: boolean; error?: string };
  /** The user opened a group's head to its purpose and members; until then it is folded to one line. The same for every group. */
  headOpen?: boolean;
  /** The post the composer answers. */
  replyTo?: { group: string; post: string };
  /** Why the last post was refused, in the composer of its group. */
  postError?: { group: string; text: string };
  /** The group a post is on its way to. */
  posting?: string;
  /** Each group's composer text, kept as the tab changes. */
  drafts: Map<string, string>;
  /** The tags offered for the `@` being typed, and the one the arrow keys are on. */
  complete?: { group: string; start: number; caret: number; options: string[]; active: number };
  /** Members whose setting or removal, and posts whose thumbs up, are on their way. */
  busy: Set<string>;
  /** Teammates, over the panes, with the error count as it opened (it says the ones since). */
  page?: { errorsAt: number };
  /** The error count as a team's column opened: it says the ones since. */
  teamErrorsAt?: number;
  share?: ShareForm;
  /** A teammate being ended from its row: asked in place. */
  ending?: string;
  /** A teammate request on its way from the page: its buttons wait (what fails is said in the page's note). */
  pageBusy?: boolean;
  copied?: { id: string; ok: boolean };
  /** Each machine's home folder and roots, from its folder listing: a share of one is asked about. */
  homes: Map<string, { home: string; roots: string[] }>;
  /** The workspaces as the page last listed them. */
  workspaces?: Workspace[];
  /** The last `group.read` sent, per group. */
  readSent: Map<string, number>;
  /** Photos and files: what each composer attaches, the photos drawn, a file being saved. */
  media: MediaUi;
  /**
   * The Connect panel's teammates, while it is open: the session it is open for, each
   * teammate's agents as last asked of their side, when each was last asked, and the filters typed.
   */
  connect?: { session: string; seen: Map<string, TeamAgentsSeen>; asked: Map<string, number>; filters: Map<string, string> };
  /** A teammate connection being ended: asked in place, in the Connect panel or on the Teammates page. */
  connEnding?: string;
  /** New team, over the panes. */
  newTeam?: NewTeamUi;
  /** A team's page, over the panes. */
  teamPage?: TeamPageUi;
  /** Join a team: the code looked at, then the offer it led to. */
  join?: JoinUi;
}

export function newTeamUi(): TeamUi {
  return { drafts: new Map(), busy: new Set(), homes: new Map(), readSent: new Map(), media: newMediaUi() };
}

/** A folder as the share form keys it: its machine and its path as that machine compares paths. */
export function folderKey(state: Pick<ViewState, "nodes">, place: TeammatePlace): string {
  return `${place.node}\n${placeKey(place.path, state.nodes.get(place.node)?.platform)}`;
}

/** The fold key of the Groups heading: no folder group's, which all hold a newline. */
export const GROUPS_GROUP = "groups";

// --- the rail ----------------------------------------------------------------------------------------

/** A group chat's tab: two heads, its name, its unread count, and a dot while the user is tagged. */
export function createGroupTab(): HTMLElement {
  const tab = el("button", "tab group-tab");
  tab.type = "button";
  tab.dataset["action"] = "select-group";
  const mark = el("span", "group-mark");
  mark.setAttribute("role", "img");
  const tagged = el("span", "group-tagged");
  tagged.title = "You are tagged";
  tab.append(mark, el("span", "tab-title"), el("span", "group-unread"), tagged);
  return tab;
}

export function updateGroupTab(tab: HTMLElement, g: Group, ui: UiState): void {
  setData(tab, "chat", g.id);
  setData(tab, "ended", String(g.ended !== undefined));
  tab.setAttribute("aria-current", ui.group === g.id ? "true" : "false");
  const words = groupTabWords(g);
  tab.title = words.title;
  tab.querySelector(".group-mark")!.setAttribute("aria-label", words.label);
  setText(tab.querySelector(".tab-title")!, g.name);
  const unread = tab.querySelector<HTMLElement>(".group-unread")!;
  setText(unread, g.unread > 99 ? "99+" : String(g.unread));
  setHidden(unread, g.unread === 0);
  setHidden(tab.querySelector<HTMLElement>(".group-tagged")!, g.tagged === 0);
}

/** The group chats a folder group holds, after its sessions' tabs. */
export function renderGroupChats(list: HTMLElement, chats: Group[], folded: boolean, ui: UiState): void {
  setHidden(list, folded || chats.length === 0);
  reconcile(list, chats, (g) => g.id, createGroupTab, (tab, g) => updateGroupTab(tab, g, ui));
}

/** Groups: the group chats no folder group or team holds, under a heading folded as a folder's. */
export function createGroupsHeading(): HTMLElement {
  const node = el("div", "tab-group groups-group");
  const name = actionButton("tab-group-name", "Groups", "group-fold");
  name.dataset["group"] = GROUPS_GROUP;
  name.title = "Group chats whose folder has no session open here now";
  node.append(name, el("div", "tab-group-chats"));
  return node;
}

export function renderGroupsHeading(node: HTMLElement, loose: Group[], ui: UiState, heading: (name: string, count: number, folded: boolean) => string): void {
  setHidden(node, loose.length === 0);
  const name = node.querySelector<HTMLElement>(":scope > .tab-group-name")!;
  const folded = ui.folded.has(GROUPS_GROUP);
  setText(name, heading("Groups", loose.length, folded));
  name.setAttribute("aria-expanded", folded ? "false" : "true");
  renderGroupChats(node.querySelector<HTMLElement>(":scope > .tab-group-chats")!, loose, folded, ui);
}

/** The ⋮ menu's item: New group, with the right to change sessions. Teams and teammates are under Teams in the rail. */
export function createMenuItems(): HTMLElement[] {
  const group = actionButton("rail-menu-item group-new-item", "New group", "group-new");
  group.setAttribute("role", "menuitem");
  group.title = "A group chat of agents, yours and your teammates', and you";
  return [group];
}

export function renderMenuItems(menu: HTMLElement, state: ViewState): void {
  setHidden(menu.querySelector<HTMLElement>(".group-new-item")!, !state.scopes.includes("sessions:write"));
}

/** A tab's focus mark: shown while its session is in focus, its words in the tab's hover. */
export function updateTabFocus(tab: HTMLElement, state: ViewState, session: string): string | undefined {
  const f = sessionFocus(state, session, Date.now());
  const mark = tab.querySelector<HTMLElement>(".tab-focus");
  if (mark) {
    setHidden(mark, f === undefined);
    mark.title = f ? focusWords(f) : "";
  }
  return f ? focusWords(f) : undefined;
}

// --- the rail's Status: folders shared closed --------------------------------------------------------

export function createStatusTeam(): HTMLElement {
  const section = el("section", "status-section status-team");
  section.setAttribute("aria-label", "Teammates");
  section.append(el("h3", "status-heading", "Teammates"), el("div", "status-team-rows"));
  return section;
}

export function renderStatusTeam(section: HTMLElement, state: ViewState, ui: UiState): void {
  const rows = state.scopes.includes("controllers") ? closedPlaces(state) : [];
  setHidden(section, rows.length === 0);
  reconcile(section.querySelector<HTMLElement>(".status-team-rows")!, rows, (r) => r.key, createClosedRow, (n, r) => updateClosedRow(n, r, state, ui));
}

function createClosedRow(): HTMLElement {
  const row = el("div", "status-team-row");
  const open = actionButton("status-team-button", "Open", "team-place-open");
  open.title = "Their agents reach yours in it, as in the rest you share";
  const exclude = actionButton("status-team-button", "Exclude", "team-place-exclude");
  exclude.title = "Keep it from them: it joins the folders you do not share";
  const buttons = el("div", "status-team-buttons");
  buttons.append(open, exclude);
  row.append(el("p", "status-team-words"), buttons);
  return row;
}

function updateClosedRow(row: HTMLElement, r: ClosedPlace, state: ViewState, ui: UiState): void {
  setText(row.querySelector(".status-team-words")!, r.words);
  row.title = `${r.place.path}\nA workspace that appeared after you shared every workspace but some: ${r.login}'s agents reach none of yours in it until you open it or exclude it.`;
  const busy = !state.connected || ui.team.busy.has(`place:${r.key}`);
  for (const b of Array.from(row.querySelectorAll<HTMLButtonElement>("button"))) {
    setData(b, "key", r.key);
    b.disabled = busy;
  }
}

// --- a session's pane: its focus, and its Connect panel's teammates ---------------------------------

/** Under a session's head while it is in focus: until when and why, and End focus. */
export function createSessionFocus(): HTMLElement {
  const line = el("p", "session-focus");
  line.setAttribute("role", "status");
  const end = actionButton("session-focus-end", "End focus", "focus-end");
  end.title = "End its focus: what was held for it reaches it now";
  line.append(el("span", "session-focus-mark"), el("span", "session-focus-words"), end);
  return line;
}

export function updateSessionFocus(line: HTMLElement, s: Session, state: ViewState, ui: UiState): void {
  const f = s.status === "ended" ? undefined : sessionFocus(state, s.id, Date.now());
  setHidden(line, f === undefined);
  if (!f) return;
  setText(line.querySelector(".session-focus-words")!, focusWords(f));
  const end = line.querySelector<HTMLButtonElement>(".session-focus-end")!;
  setData(end, "session", s.id);
  setHidden(end, !state.scopes.includes("sessions:write"));
  end.disabled = !state.connected || ui.team.busy.has(`focus:${s.id}`);
}

/** The Connect panel's Connected part: what the session is joined to now, and the asks either way. */
export function createConnectConnected(): HTMLElement {
  const section = el("section", "connect-section connect-connected");
  section.append(el("h4", "connect-heading", "Connected"), el("div", "connect-rows"));
  return section;
}

export function updateConnectConnected(section: HTMLElement, s: Session, state: ViewState, ui: UiState): void {
  const rows = connectedRows(state, s);
  setHidden(section, rows.length === 0);
  reconcile(section.querySelector<HTMLElement>(".connect-rows")!, rows, (r) => `${r.kind}:${r.id}`, createConnectedRow, (n, r) => updateConnectedRow(n, r, state, ui));
}

function createConnectedRow(r: ConnectedRow): HTMLElement {
  const row = el("div", "connect-row connect-conn");
  const dot = el("span", "connect-dot");
  dot.setAttribute("aria-hidden", "true");
  row.append(dot, el("span", "connect-who"), el("span", "connect-words"));
  const acts = el("div", "connect-acts");
  const ask = el("div", "connect-ask");
  ask.setAttribute("role", "alert");
  if (r.kind === "code") {
    const end = actionButton("connect-btn connect-end", "End", "connection-end");
    end.title = "End the connection at both ends";
    acts.append(end);
    ask.append(el("span", "connect-ask-words", "End it at both ends?"), actionButton("connect-btn connect-danger", "End", "connection-end-confirm"), actionButton("connect-btn", "Keep", "connection-end-cancel"));
  } else {
    const connect = actionButton("connect-btn connect-go connect-yes", "Connect", "tc-connect");
    connect.title = "Let the two agents message each other, and no other";
    const decline = actionButton("connect-btn connect-decline", "Decline", "tc-decline");
    const cancel = actionButton("connect-btn connect-cancel", "Cancel", "tc-cancel");
    cancel.title = "Take the ask back";
    const end = actionButton("connect-btn connect-end", "End", "tc-end");
    end.title = "End it at both sides: both agents are told";
    const dismiss = actionButton("connect-btn connect-dismiss", "Dismiss", "tc-dismiss");
    acts.append(connect, decline, cancel, end, dismiss);
    ask.append(el("span", "connect-ask-words", "End it? Both agents are told."), actionButton("connect-btn connect-danger", "End", "tc-end-confirm"), actionButton("connect-btn", "Keep", "tc-end-cancel"));
  }
  row.append(acts, ask);
  return row;
}

function updateConnectedRow(row: HTMLElement, r: ConnectedRow, state: ViewState, ui: UiState): void {
  setText(row.querySelector(".connect-who")!, r.who);
  setText(row.querySelector(".connect-words")!, r.words);
  if (r.kind === "code") {
    setData(row.querySelector<HTMLElement>(".connect-dot")!, "tone", "live");
    const asking = ui.endingConnection === r.id;
    for (const b of Array.from(row.querySelectorAll<HTMLButtonElement>("button"))) {
      setData(b, "connection", r.id);
      b.disabled = !state.connected;
    }
    setHidden(row.querySelector<HTMLElement>(".connect-acts")!, asking);
    setHidden(row.querySelector<HTMLElement>(".connect-ask")!, !asking);
    return;
  }
  setData(row.querySelector<HTMLElement>(".connect-dot")!, "tone", r.state === "active" ? "live" : r.state === "asked" ? "wait" : "off");
  setData(row, "state", r.state);
  const asking = ui.team.connEnding === r.id;
  const busy = !state.connected || ui.team.busy.has(`tc:${r.id}`) || ui.team.busy.has(`connect:${r.teammate}\n${r.session}\n${r.agent}`);
  for (const b of Array.from(row.querySelectorAll<HTMLButtonElement>("button"))) {
    setData(b, "teammate", r.teammate);
    setData(b, "id", r.id);
    setData(b, "session", r.session);
    setData(b, "agent", r.agent);
    b.disabled = busy;
  }
  const shows = (cls: string, kind: (typeof r.buttons)[number]) => setHidden(row.querySelector<HTMLElement>(cls)!, !r.buttons.includes(kind));
  shows(".connect-yes", "connect");
  shows(".connect-decline", "decline");
  shows(".connect-cancel", "cancel");
  shows(".connect-end", "end");
  shows(".connect-dismiss", "dismiss");
  setHidden(row.querySelector<HTMLElement>(".connect-acts")!, asking);
  setHidden(row.querySelector<HTMLElement>(".connect-ask")!, !asking);
}

/** The Connect panel's Teammates part: a block per teammate, or a line on what teammates are. */
export function createConnectTeam(): HTMLElement {
  const section = el("section", "connect-section connect-teammates");
  const none = el("p", "connect-noteam");
  const add = actionButton("connect-link connect-noteam-add", "Make a team", "team-new");
  none.append(el("span", "connect-noteam-words"), add);
  section.append(el("h4", "connect-heading", "Teammates"), el("div", "connect-teams"), none);
  return section;
}

export function updateConnectTeam(section: HTMLElement, s: Session, state: ViewState, ui: UiState): void {
  const none = connectNoTeam(state);
  const line = section.querySelector<HTMLElement>(".connect-noteam")!;
  setHidden(line, none === undefined);
  if (none !== undefined) {
    setText(line.querySelector(".connect-noteam-words")!, none);
    // signed out, there is no adding one here: the line says so and no more
    setHidden(line.querySelector<HTMLElement>(".connect-noteam-add")!, state.account?.subject === undefined);
  }
  const c = ui.team.connect?.session === s.id ? ui.team.connect : undefined;
  const blocks = none !== undefined ? [] : connectTeamBlocks(state, s, c?.seen ?? new Map(), c?.filters ?? new Map());
  reconcile(section.querySelector<HTMLElement>(".connect-teams")!, blocks, (b) => b.teammate, createTeamBlock, (n, b) => updateTeamBlock(n, b, s, state, ui));
}

function createTeamBlock(): HTMLElement {
  const block = el("div", "connect-team");
  const head = el("div", "connect-team-head");
  const sharing = actionButton("connect-link connect-sharing", "Sharing", "team-sharing");
  sharing.title = "What you share with them, and what they share with you";
  head.append(el("span", "connect-login"), el("span", "connect-theirs"), sharing);
  const stand = el("div", "connect-stand");
  const words = el("p", "connect-stand-words");
  words.append(el("strong", "connect-stand-lead"), el("span", "connect-stand-rest"));
  const acts = el("div", "connect-stand-acts");
  const main = actionButton("connect-btn connect-stand-main", "", "teammate-open");
  const open = actionButton("connect-btn", "Open", "team-place-open");
  open.title = "Their agents reach yours in it, as in the rest you share";
  const exclude = actionButton("connect-btn", "Exclude", "team-place-exclude");
  exclude.title = "Keep it from them: it joins the folders you do not share";
  acts.append(main, open, exclude);
  stand.append(words, acts);
  const filter = el("input", "connect-filter");
  filter.type = "search";
  filter.autocomplete = "off";
  filter.spellcheck = false;
  block.append(head, stand, filter, el("div", "connect-agents"), el("p", "connect-agents-note"));
  return block;
}

function updateTeamBlock(block: HTMLElement, b: ConnectTeamBlock, s: Session, state: ViewState, ui: UiState): void {
  setData(block, "teammate", b.teammate);
  setData(block, "standing", b.standing.kind);
  const sharingBtn = block.querySelector<HTMLElement>(".connect-sharing");
  if (sharingBtn) {
    setData(sharingBtn, "teammate", b.teammate);
    setData(sharingBtn, "team", b.standing.team ?? "");
  }
  setText(block.querySelector(".connect-login")!, b.login);
  const theirs = block.querySelector<HTMLElement>(".connect-theirs")!;
  setText(theirs, b.theirs);
  setHidden(theirs, b.theirs === "");
  setText(block.querySelector(".connect-stand-lead")!, b.standing.lead);
  setText(block.querySelector(".connect-stand-rest")!, ` ${b.standing.rest}`);
  const busy = !state.connected || ui.team.busy.has(`open:${b.teammate}\n${s.id}`) || (b.standing.placeKey !== undefined && ui.team.busy.has(`place:${b.standing.placeKey}`));
  const main = block.querySelector<HTMLButtonElement>(".connect-stand-main")!;
  const k = b.standing.kind;
  setHidden(main, b.standing.label === undefined);
  setText(main, b.standing.label ?? "");
  setData(main, "action", k === "outside" ? "team-share-folder" : "teammate-open");
  setData(main, "teammate", b.teammate);
  setData(main, "session", s.id);
  setData(main, "on", String(k === "closed"));
  setData(main, "team", b.standing.team ?? "");
  main.title = k === "outside" ? `Opens what you share with ${b.login}, with this folder added: you save it` : k === "opened" ? `Close it to ${b.login}'s agents: only the ones you connect can reach it` : k === "closed" ? `Any of ${b.login}'s agents may message this one, not only the ones you connect` : "";
  main.disabled = busy;
  for (const btn of Array.from(block.querySelectorAll<HTMLButtonElement>(".connect-stand-acts [data-action^='team-place']"))) {
    setHidden(btn, k !== "shared-closed");
    setData(btn, "key", b.standing.placeKey ?? "");
    btn.disabled = busy;
  }
  const acts = block.querySelector<HTMLElement>(".connect-stand-acts")!;
  setHidden(acts, b.standing.label === undefined && k !== "shared-closed");
  const filter = block.querySelector<HTMLInputElement>(".connect-filter")!;
  setHidden(filter, !b.agents?.filter);
  setData(filter, "teammate", b.teammate);
  filter.placeholder = `Filter ${b.login}'s agents`;
  filter.setAttribute("aria-label", `Filter ${b.login}'s agents`);
  const list = block.querySelector<HTMLElement>(".connect-agents")!;
  setHidden(list, b.agents === undefined || b.agents.rows.length === 0);
  reconcile(list, b.agents?.rows ?? [], (r) => r.key, createAgentRow, (n, r) => updateAgentRow(n, r, b, s, state, ui));
  const note = block.querySelector<HTMLElement>(".connect-agents-note")!;
  setText(note, b.agents?.words ?? "");
  setHidden(note, b.agents?.words === undefined);
}

function createAgentRow(): HTMLElement {
  const row = el("div", "connect-row connect-agent");
  const dot = el("span", "connect-dot");
  dot.setAttribute("aria-hidden", "true");
  const doing = el("span", "connect-doing");
  doing.append(el("span", "connect-doing-state"), el("span", "connect-doing-intent"));
  const act = el("div", "connect-acts");
  act.append(actionButton("connect-btn connect-agent-go", "", "tc-connect-agent"), el("span", "connect-state"));
  row.append(dot, el("span", "connect-name"), el("span", "connect-meta"), doing, act);
  return row;
}

function updateAgentRow(row: HTMLElement, r: ConnectAgentRow, b: ConnectTeamBlock, s: Session, state: ViewState, ui: UiState): void {
  setData(row.querySelector<HTMLElement>(".connect-dot")!, "tone", r.tone);
  setData(row, "open", String(r.open));
  setText(row.querySelector(".connect-name")!, r.name);
  setText(row.querySelector(".connect-meta")!, r.meta);
  setText(row.querySelector(".connect-doing-state")!, r.doing);
  const intent = row.querySelector<HTMLElement>(".connect-doing-intent")!;
  setText(intent, r.intent ? `${r.doing ? " · " : ""}${r.intent}` : "");
  row.title = r.intent ? `${r.name}: ${r.intent}` : r.name;
  const go = row.querySelector<HTMLButtonElement>(".connect-agent-go")!;
  const state2 = row.querySelector<HTMLElement>(".connect-state")!;
  const a = r.action;
  const pressable = a !== undefined && a.kind !== "state";
  setHidden(go, !pressable);
  setHidden(state2, a === undefined || a.kind !== "state");
  if (a && a.kind !== "state") {
    setText(go, a.label);
    setData(go, "kind", a.kind);
    go.title = a.kind === "connect" ? `${r.name} and this agent may message each other, and no other agent of either of you` : `${b.login} is asked first: ${r.name} is closed to you`;
  }
  if (a && a.kind === "state") {
    setText(state2, a.words);
    setData(state2, "tone", a.tone);
  }
  setData(go, "teammate", b.teammate);
  setData(go, "session", s.id);
  setData(go, "agent", r.session ?? "");
  go.disabled = !state.connected || r.session === undefined || ui.team.busy.has(`connect:${b.teammate}\n${s.id}\n${r.session}`);
}

// --- the group's pane --------------------------------------------------------------------------------

/**
 * The group's pane, built once into `root`: its head, its posts, its composer. The head is
 * folded to one line until opened: the name, who is in it in a few words, Edit and ⋮.
 */
function createGroupPane(root: HTMLElement): void {
  const head = el("header", "group-head");
  const top = el("div", "group-head-top");
  const fold = actionButton("fold group-fold", "", "group-fold");
  fold.setAttribute("aria-label", "Group details");
  const titles = el("div", "group-titles");
  titles.append(el("h2", "group-name"), el("span", "group-summary"), el("p", "group-purpose"));
  const edit = actionButton("group-tool group-edit", "Edit", "group-edit");
  edit.title = "Change the name and the purpose";
  // a team's own chat: the team's page, its people, invites and what the user shares, is behind this
  const settings = actionButton("group-tool group-team-settings", "", "team-page");
  settings.append(el("span", "group-team-settings-mark"));
  const more = actionButton("group-tool group-more", "", "group-menu");
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-label", "More");
  more.title = "More";
  more.append(el("span", "dots-mark"));
  const menu = el("div", "rail-menu group-menu");
  menu.setAttribute("role", "menu");
  const del = actionButton("rail-menu-item group-delete", "Delete", "group-delete-ask");
  del.setAttribute("role", "menuitem");
  del.title = "Drop it here: you and your agents leave it, and the others keep it";
  const end = actionButton("rail-menu-item group-end", "End group", "group-end-ask");
  end.setAttribute("role", "menuitem");
  end.title = "End it for everyone in it: read only from then on";
  menu.append(del, end);
  const mark = el("span", "group-mark group-head-mark");
  mark.setAttribute("aria-hidden", "true");
  top.append(fold, mark, titles, edit, settings, more, menu);
  // Delete or End, asked in place under the line.
  const ask = el("div", "group-ask");
  ask.setAttribute("role", "alert");
  const confirm = actionButton("group-ask-confirm", "", "group-ask-confirm");
  ask.append(el("span", "group-ask-words"), confirm, actionButton("group-ask-cancel", "Cancel", "group-ask-cancel"));
  const form = el("form", "group-edit-form");
  const name = el("input", "group-edit-name");
  name.name = "name";
  name.maxLength = 80;
  name.autocomplete = "off";
  name.setAttribute("aria-label", "Name");
  const purpose = el("input", "group-edit-purpose");
  purpose.name = "purpose";
  purpose.maxLength = 300;
  purpose.autocomplete = "off";
  purpose.placeholder = "What it is for (optional)";
  purpose.setAttribute("aria-label", "Purpose");
  const save = el("button", "group-edit-save", "Save");
  save.type = "submit";
  const buttons = el("div", "group-form-buttons");
  buttons.append(save, actionButton("group-edit-cancel", "Cancel", "group-edit-cancel"));
  const editError = el("p", "group-form-error");
  editError.setAttribute("role", "alert");
  form.append(name, purpose, buttons, editError);
  const members = el("div", "group-members");
  members.setAttribute("aria-label", "Members");
  const add = actionButton("group-add-start", "+ Add", "group-add");
  add.title = "Put more agents or people in it: your agents, a teammate, or a teammate's agents in what they share with you";
  const add2 = el("div", "group-add");
  const addButtons = el("div", "group-form-buttons");
  addButtons.append(actionButton("group-add-confirm", "Add", "group-add-confirm"), actionButton("group-add-cancel", "Cancel", "group-add-cancel"));
  const addError = el("p", "group-form-error");
  addError.setAttribute("role", "alert");
  // a team's own chat: someone who is no teammate yet is invited by their GitHub name on the team's page
  const byName = actionButton("connect-link group-add-by-name", "Someone else, by GitHub name…", "team-add-by-name");
  add2.append(createAgentPick("add"), byName, addButtons, addError);
  const ended = el("p", "group-ended");
  head.append(top, ask, form, el("div", "group-member-row"), add2, ended);
  head.querySelector(".group-member-row")!.append(members, add);
  const stream = el("div", "group-stream");
  stream.setAttribute("aria-label", "Posts");
  stream.tabIndex = -1;
  const earlier = actionButton("earlier group-earlier", "Show earlier", "group-earlier");
  stream.append(earlier, el("p", "group-empty"), el("ol", "group-posts"));
  root.append(head, stream, createGroupComposer());
}

/** The group's composer: the post it answers, why the last was refused, the tags offered, the field and Send. */
function createGroupComposer(): HTMLElement {
  const form = el("form", "group-composer");
  const reply = el("div", "group-reply");
  const cancel = actionButton("group-reply-cancel", "×", "group-reply-cancel");
  cancel.setAttribute("aria-label", "Not as a reply");
  cancel.title = "Not as a reply";
  reply.append(el("span", "group-reply-words"), cancel);
  const error = el("p", "group-post-error");
  error.setAttribute("role", "alert");
  const complete = el("div", "group-complete");
  complete.setAttribute("role", "listbox");
  complete.setAttribute("aria-label", "Tags");
  const row = el("div", "group-composer-row");
  const send = el("button", "group-send", "Send");
  send.type = "submit";
  const attach = createAttach();
  // Held, what the user says is typed into the post, to send when they are ready.
  row.append(attach.buttons, messageField("group-text", "Post"), talkButton(), send);
  form.append(reply, error, complete, attach.strip, row, el("p", "group-closed"));
  return form;
}

/** A picker of agents: each heading, the user's own by machine and folder and teammates' under their login, with a checkbox per agent. */
function createAgentPick(kind: "new" | "add"): HTMLElement {
  const pick = el("div", "agent-pick");
  pick.dataset["for"] = kind;
  pick.append(el("p", "agent-pick-status"), el("div", "agent-pick-groups"));
  return pick;
}

function renderAgentPick(pick: HTMLElement, p: AgentPick, groups: CandidateGroup[], none: string): void {
  const status = pick.querySelector<HTMLElement>(".agent-pick-status")!;
  const words = p.loadError ?? (p.candidates === undefined ? "Listing the agents…" : groups.length === 0 ? none : "");
  setText(status, words);
  setHidden(status, words === "");
  setData(status, "error", String(p.loadError !== undefined));
  reconcile(pick.querySelector<HTMLElement>(".agent-pick-groups")!, groups, (g) => g.key, createPickGroup, (n, g) => updatePickGroup(n, g, p));
}

function createPickGroup(): HTMLElement {
  const group = el("fieldset", "agent-pick-group");
  group.append(el("legend", "agent-pick-title"), el("p", "agent-pick-blocked"), el("div", "agent-pick-items"));
  return group;
}

function updatePickGroup(node: HTMLElement, g: CandidateGroup, p: AgentPick): void {
  setText(node.querySelector(".agent-pick-title")!, g.title);
  setData(node, "own", String(g.own));
  setData(node, "blocked", String(g.blocked !== undefined));
  const blocked = node.querySelector<HTMLElement>(".agent-pick-blocked")!;
  setText(blocked, g.blocked ?? "");
  setHidden(blocked, g.blocked === undefined);
  reconcile(node.querySelector<HTMLElement>(".agent-pick-items")!, g.items, (i) => i.key, createPickItem, (n, i) => updatePickItem(n, i, p, g.blocked !== undefined));
}

function createPickItem(): HTMLElement {
  const label = el("label", "agent-pick-item");
  const box = el("input", "agent-pick-check");
  box.type = "checkbox";
  const icon = el("span", "agent-icon");
  icon.append(el("span", "agent-mark"));
  const text = el("span", "agent-pick-text");
  text.append(el("span", "agent-pick-handle"), el("span", "agent-pick-words"));
  label.append(box, icon, text);
  return label;
}

function updatePickItem(label: HTMLElement, i: CandidateItem, p: AgentPick, blocked: boolean): void {
  const box = label.querySelector<HTMLInputElement>(".agent-pick-check")!;
  setData(box, "key", i.key);
  box.checked = p.picked.has(i.key);
  // one ticked before it was blocked may still be unticked
  box.disabled = p.busy === true || (blocked && !box.checked);
  const icon = label.querySelector<HTMLElement>(".agent-icon")!;
  setHidden(icon, i.person === true);
  setData(icon, "harness", i.harness ?? "terminal");
  setData(icon, "tone", "active");
  setText(label.querySelector(".agent-pick-handle")!, i.handle);
  setText(label.querySelector(".agent-pick-words")!, i.words);
  label.title = `${i.handle}${i.words ? `: ${i.words}` : ""}`;
}

/** The group's pane, while its tab is selected; the head, the posts and the composer as the group stands. */
export function renderGroupPane(root: HTMLElement, state: ViewState, ui: UiState): void {
  const g = ui.group !== undefined ? state.groups.get(ui.group) : undefined;
  setHidden(root, g === undefined);
  if (!g) return;
  if (!root.firstChild) createGroupPane(root);
  setData(root, "group", g.id);
  const ended = g.ended !== undefined;
  setData(root, "ended", String(ended));
  const canWrite = state.connected && state.scopes.includes("sessions:write");
  renderGroupHead(root.querySelector<HTMLElement>(".group-head")!, g, state, ui, canWrite);
  renderGroupStream(root.querySelector<HTMLElement>(".group-stream")!, g, state, ui);
  renderGroupComposer(root.querySelector<HTMLFormElement>(".group-composer")!, g, state, ui, canWrite);
  renderViewer(root, ui.team.media, g.id);
}

function renderGroupHead(head: HTMLElement, g: Group, state: ViewState, ui: UiState, canWrite: boolean): void {
  const ended = g.ended !== undefined;
  const open = ui.team.headOpen === true;
  setData(head, "open", String(open));
  const fold = head.querySelector<HTMLButtonElement>(".group-fold")!;
  fold.setAttribute("aria-expanded", String(open));
  fold.title = open ? "Fold the purpose and the members away" : "Show the purpose and the members";
  setText(head.querySelector(".group-name")!, g.name);
  setText(head.querySelector(".group-summary")!, groupMemberWords(g));
  const purpose = head.querySelector<HTMLElement>(".group-purpose")!;
  setText(purpose, g.purpose ?? "");
  setHidden(purpose, !g.purpose);
  // a team's own chat is named for the team: its page renames it, and holds the rest of the team's settings
  const team = g.teamChat && g.team !== undefined ? state.teams.get(g.team) : undefined;
  const settings = head.querySelector<HTMLButtonElement>(".group-team-settings")!;
  setHidden(settings, team === undefined || !state.scopes.includes("controllers"));
  if (team) {
    setData(settings, "team", team.id);
    settings.title = `${team.name}'s settings: its people, invites, and what you share with it`;
    settings.setAttribute("aria-label", `${team.name}'s settings`);
    settings.setAttribute("aria-pressed", String(ui.team.teamPage?.team === team.id));
    settings.disabled = !state.connected;
  }
  const editing = ui.team.editGroup?.group === g.id ? ui.team.editGroup : undefined;
  const edit = head.querySelector<HTMLButtonElement>(".group-edit")!;
  setHidden(edit, ended || team !== undefined || groupMe(g) === undefined || !state.scopes.includes("sessions:write") || editing !== undefined);
  edit.disabled = !canWrite;
  const form = head.querySelector<HTMLFormElement>(".group-edit-form")!;
  setHidden(form, editing === undefined);
  if (editing) {
    // filled as it opens; the fields are the user's from then on
    if (form.dataset["for"] !== g.id) {
      form.dataset["for"] = g.id;
      form.querySelector<HTMLInputElement>(".group-edit-name")!.value = g.name;
      form.querySelector<HTMLInputElement>(".group-edit-purpose")!.value = g.purpose ?? "";
    }
    for (const b of Array.from(form.querySelectorAll<HTMLButtonElement>("button"))) b.disabled = editing.busy === true || !canWrite;
    const error = form.querySelector<HTMLElement>(".group-form-error")!;
    setText(error, editing.error ?? "");
    setHidden(error, editing.error === undefined);
  } else delete form.dataset["for"];
  const menuOpen = ui.team.groupMenu?.group === g.id ? ui.team.groupMenu : undefined;
  const more = head.querySelector<HTMLButtonElement>(".group-more")!;
  // a running team's chat is neither left nor ended by itself, but with the team: its ⋮ would be empty
  setHidden(more, !state.scopes.includes("sessions:write") || (g.teamChat === true && !ended));
  more.disabled = !canWrite;
  more.setAttribute("aria-expanded", String(menuOpen !== undefined && menuOpen.asking === undefined));
  const menu = head.querySelector<HTMLElement>(".group-menu")!;
  setHidden(menu, menuOpen === undefined || menuOpen.asking !== undefined);
  setHidden(menu.querySelector<HTMLElement>(".group-end")!, !canEndGroup(g) || g.teamChat === true);
  // with other people in it, the user leaves it and the others keep it; a team's chat is left with the team
  const othersIn = g.members.some((m) => m.kind === "person" && !m.me);
  const del = menu.querySelector<HTMLElement>(".group-delete")!;
  setText(del, othersIn ? "Leave" : "Delete");
  del.title = othersIn ? "Leave it: you and your agents go, and the others keep it" : "Delete it: no one else is in it";
  setHidden(del, g.teamChat === true && g.ended === undefined);
  const ask = head.querySelector<HTMLElement>(".group-ask")!;
  const asking = menuOpen?.asking;
  setHidden(ask, asking === undefined);
  if (asking) {
    const others = g.members.some((m) => m.kind === "person" && !m.me);
    const words =
      menuOpen?.error ??
      (asking === "delete"
        ? others
          ? `Leave ${g.name}? You and your agents go from it; the others keep it.`
          : `Delete ${g.name}? You and your agents leave it.`
        : `End ${g.name} for everyone in it? It stays, read only.`);
    setText(ask.querySelector(".group-ask-words")!, words);
    const confirm = ask.querySelector<HTMLButtonElement>(".group-ask-confirm")!;
    setText(confirm, menuOpen?.busy ? (asking === "delete" ? (others ? "Leaving…" : "Deleting…") : "Ending…") : asking === "delete" ? (others ? "Leave" : "Delete") : "End group");
    setData(confirm, "asking", asking);
    confirm.disabled = !canWrite || menuOpen?.busy === true;
  }
  const chips = memberChips(state, g, Date.now());
  reconcile(head.querySelector<HTMLElement>(".group-members")!, chips, (c) => c.key, createMemberChip, (n, c) => updateMemberChip(n, c, g, state, ui, canWrite));
  const adding = ui.team.addMembers?.group === g.id ? ui.team.addMembers : undefined;
  const add = head.querySelector<HTMLButtonElement>(".group-add-start")!;
  setHidden(add, ended || groupMe(g) === undefined || !state.scopes.includes("sessions:write") || adding !== undefined);
  add.disabled = !canWrite;
  const panel = head.querySelector<HTMLElement>(".group-add")!;
  setHidden(panel, adding === undefined);
  if (adding) {
    const pick = teamChatPick(state, g);
    const groups = candidateGroups(adding.candidates ?? [], g, adding.picked, pick);
    renderAgentPick(panel.querySelector<HTMLElement>(".agent-pick")!, adding, groups, pick ? `No other agent of yours or ${pick.name}'s${pick.canInvite ? ", and no teammate to invite," : ""} is there to add now.` : "No other agent of yours, teammate or teammate's agent is there to add now.");
    const byName = panel.querySelector<HTMLButtonElement>(".group-add-by-name")!;
    setHidden(byName, !pick?.canInvite || !state.scopes.includes("controllers"));
    if (team) setData(byName, "team", team.id);
    byName.disabled = !state.connected || adding.busy === true;
    const items = groups.flatMap((x) => x.items).filter((i) => adding.picked.has(i.key));
    const invites = items.filter((i) => i.invite);
    const agents = items.length - invites.length;
    const confirm = panel.querySelector<HTMLButtonElement>(".group-add-confirm")!;
    setText(confirm, addWords(agents, invites.map((i) => i.handle), adding.busy === true));
    confirm.disabled = !canWrite || adding.busy === true || items.length === 0;
    const error = panel.querySelector<HTMLElement>(".group-form-error")!;
    setText(error, adding.error ?? "");
    setHidden(error, adding.error === undefined);
  }
  const endedLine = head.querySelector<HTMLElement>(".group-ended")!;
  setHidden(endedLine, !ended);
  if (g.ended) setText(endedLine, `${g.ended.by} ended this group at ${clock(g.ended.at)}: it is read only.`);
}

function createMemberChip(): HTMLElement {
  const chip = el("div", "group-member");
  const icon = el("span", "agent-icon");
  icon.append(el("span", "agent-mark"));
  const notify = el("div", "group-member-notify");
  notify.setAttribute("role", "group");
  notify.setAttribute("aria-label", "Tell it of");
  for (const [value, label, title] of [
    ["all", "Every post", "Told of every post, gathered while it works"],
    ["tags", "Tags only", "Told only of the posts that tag it"],
  ] as const) {
    const b = actionButton("group-member-notify-option", label, "group-member-notify");
    b.dataset["notify"] = value;
    b.title = title;
    notify.append(b);
  }
  const remove = actionButton("group-member-remove", "×", "group-member-remove");
  chip.append(el("span", "dot"), icon, el("span", "group-member-name"), el("span", "group-member-focus"), el("span", "group-member-held", "held"), el("span", "group-member-unread"), notify, remove);
  return chip;
}

function updateMemberChip(chip: HTMLElement, c: MemberChip, g: Group, state: ViewState, ui: UiState, canWrite: boolean): void {
  setData(chip, "kind", c.kind);
  setData(chip, "status", c.status);
  setData(chip, "me", String(c.me));
  setData(chip, "mine", String(c.mine));
  chip.title = c.title;
  const dot = chip.querySelector<HTMLElement>(".dot")!;
  setData(dot, "status", c.status === "busy" ? "busy" : c.status === "idle" ? "idle" : c.status === "gone" ? "ended" : c.status === "person" ? "connected" : "pending");
  const icon = chip.querySelector<HTMLElement>(".agent-icon")!;
  setHidden(icon, c.kind !== "agent");
  setData(icon, "harness", c.harness ?? "terminal");
  setData(icon, "tone", c.status === "busy" ? "active" : "quiet");
  setText(chip.querySelector(".group-member-name")!, c.me ? `${c.name} (you)` : c.status === "invited" ? `${c.name} · invited` : c.name);
  const focus = chip.querySelector<HTMLElement>(".group-member-focus")!;
  setText(focus, c.focus ? c.focus.replace(/^Focus until /, "focus until ").replace(/ — .*$/, "") : "");
  focus.title = c.focus ?? "";
  setHidden(focus, c.focus === undefined);
  const held = chip.querySelector<HTMLElement>(".group-member-held")!;
  setHidden(held, !c.held);
  held.title = "Its notices wait in its terminal until it lets messages in";
  const unread = chip.querySelector<HTMLElement>(".group-member-unread")!;
  setText(unread, String(c.unread));
  unread.title = `${c.unread} unread`;
  setHidden(unread, c.unread === 0 || c.status === "gone");
  const busy = !canWrite || ui.team.busy.has(`member:${g.id}\n${c.key}`);
  const notify = chip.querySelector<HTMLElement>(".group-member-notify")!;
  setHidden(notify, !c.mine || c.status === "gone" || g.ended !== undefined || !state.scopes.includes("sessions:write"));
  for (const b of Array.from(notify.querySelectorAll<HTMLButtonElement>("button"))) {
    setData(b, "member", c.key);
    b.setAttribute("aria-pressed", String(b.dataset["notify"] === c.notify));
    b.disabled = busy;
  }
  const remove = chip.querySelector<HTMLButtonElement>(".group-member-remove")!;
  setHidden(remove, !c.removable || !state.scopes.includes("sessions:write"));
  setData(remove, "member", c.key);
  remove.setAttribute("aria-label", `Take ${c.name} out of the group`);
  remove.title = `Take ${c.name} out of the group`;
  remove.disabled = busy;
}

function renderGroupStream(stream: HTMLElement, g: Group, state: ViewState, ui: UiState): void {
  const page = state.groupPosts.get(g.id);
  const posts = page?.posts ?? [];
  const earlier = stream.querySelector<HTMLButtonElement>(".group-earlier")!;
  setHidden(earlier, !page?.loaded || !page.more);
  earlier.disabled = page?.loading === true || !state.connected;
  setText(earlier, page?.loading && page.loaded ? "Loading…" : "Show earlier");
  const empty = stream.querySelector<HTMLElement>(".group-empty")!;
  const emptyWords = !page?.loaded ? (page?.loading || state.connected ? "Loading the posts…" : "The posts load once cophylad is back.") : posts.length === 0 ? "No posts yet. Tag an agent with @ to ask it something." : "";
  setText(empty, emptyWords);
  setHidden(empty, emptyWords === "");
  const views = posts.map((p) => postView(g, p, page));
  reconcile(stream.querySelector<HTMLElement>(".group-posts")!, views, (v) => v.id, createPost, (n, v) => updatePost(n, v, g, state, ui));
}

function createPost(): HTMLElement {
  const li = el("li", "group-post");
  const head = el("div", "group-post-head");
  const icon = el("span", "agent-icon");
  icon.append(el("span", "agent-mark"));
  const awaiting = el("span", "group-post-awaiting", "awaiting reply");
  awaiting.title = "It asked for a reply, and none came yet";
  head.append(icon, el("span", "group-post-who"), el("time", "group-post-time"), awaiting);
  const quote = el("blockquote", "group-post-quote");
  quote.append(el("span", "group-post-quote-who"), el("span", "group-post-quote-text"));
  const foot = el("div", "group-post-foot");
  const ack = actionButton("group-post-ack", "", "group-react");
  ack.append(el("span", "group-post-ack-mark", "👍"), el("span", "group-post-ack-count"));
  const reply = actionButton("group-post-reply", "Reply", "group-reply");
  reply.title = "Answer this post";
  foot.append(ack, reply, el("span", "group-post-unread"));
  li.append(head, quote, el("div", "group-post-text"), ...createPostMedia(), foot);
  return li;
}

function updatePost(li: HTMLElement, v: PostView, g: Group, state: ViewState, ui: UiState): void {
  setData(li, "post", v.id);
  setData(li, "kind", v.writer.kind);
  setData(li, "mine", String(v.mine));
  setData(li, "awaiting", String(v.awaiting));
  setData(li, "replying", String(ui.team.replyTo?.post === v.id));
  const icon = li.querySelector<HTMLElement>(".agent-icon")!;
  setHidden(icon, v.writer.kind !== "agent");
  setData(icon, "harness", v.writer.harness ?? "terminal");
  setData(icon, "tone", "active");
  const who = li.querySelector<HTMLElement>(".group-post-who")!;
  setText(who, v.mine ? `${v.writer.name} (you)` : v.writer.name);
  who.title = v.writer.title;
  const time = li.querySelector<HTMLElement>(".group-post-time")!;
  setText(time, clock(v.at));
  time.setAttribute("datetime", new Date(v.at).toISOString());
  time.title = new Date(v.at).toLocaleString();
  setHidden(li.querySelector<HTMLElement>(".group-post-awaiting")!, !v.awaiting);
  const quote = li.querySelector<HTMLElement>(".group-post-quote")!;
  setHidden(quote, v.quote === undefined);
  if (v.quote) {
    const qWho = quote.querySelector<HTMLElement>(".group-post-quote-who")!;
    setText(qWho, v.quote.name ?? "");
    setHidden(qWho, v.quote.name === undefined);
    setText(quote.querySelector(".group-post-quote-text")!, v.quote.excerpt);
  }
  const text = li.querySelector<HTMLElement>(".group-post-text")!;
  setHidden(text, v.text === "" && v.tags.length === 0);
  renderText(text, v.text, v.writer.kind !== "cophyla");
  v.tags.forEach((tag, i) => {
    let holder = text.querySelector<HTMLElement>(`.slot[data-slot="${i}"]`);
    if (!holder) {
      holder = el("span", "slot");
      holder.dataset["slot"] = String(i);
      text.append(holder);
    }
    let span = holder.firstElementChild as HTMLElement | null;
    if (!span) {
      span = el("span", "group-tag");
      holder.append(span);
    }
    setText(span, tag.label);
    setData(span, "own", String(tag.own));
  });
  const foot = li.querySelector<HTMLElement>(".group-post-foot")!;
  setHidden(foot, v.writer.kind === "cophyla");
  const canWrite = state.connected && state.scopes.includes("sessions:write");
  const ack = foot.querySelector<HTMLButtonElement>(".group-post-ack")!;
  setData(ack, "post", v.id);
  setData(ack, "on", String(!v.acked));
  ack.setAttribute("aria-pressed", String(v.acked));
  ack.setAttribute("aria-label", `${v.ackTitle}${v.acked ? "; press to take yours back" : "; press to give one"}`);
  ack.title = v.ackTitle;
  setText(ack.querySelector(".group-post-ack-count")!, v.acks > 0 ? String(v.acks) : "");
  ack.disabled = !canWrite || g.ended !== undefined || ui.team.busy.has(`react:${v.id}`);
  const reply = foot.querySelector<HTMLButtonElement>(".group-post-reply")!;
  setData(reply, "post", v.id);
  setHidden(reply, g.ended !== undefined || !state.scopes.includes("sessions:write"));
  const unread = foot.querySelector<HTMLElement>(".group-post-unread")!;
  setText(unread, v.unreadBy.length > 0 ? `not read yet by ${v.unreadBy.join(", ")}` : "");
  setHidden(unread, v.unreadBy.length === 0);
  renderPostMedia(li, g.id, v.id, v.photos, v.files, state, ui.team.media);
}

function renderGroupComposer(form: HTMLFormElement, g: Group, state: ViewState, ui: UiState, canWrite: boolean): void {
  const ended = g.ended !== undefined;
  const switched = form.dataset["group"] !== g.id;
  setData(form, "group", g.id);
  const input = form.querySelector<HTMLTextAreaElement>(".group-text")!;
  const draft = ui.team.drafts.get(g.id) ?? "";
  if (switched || (document.activeElement !== input && input.value !== draft)) input.value = draft;
  fitField(input);
  const mayPost = canWrite && !ended && groupMe(g) !== undefined;
  input.disabled = !mayPost;
  input.placeholder = ended ? "This group ended" : !state.connected ? "Waiting for cophylad" : !state.scopes.includes("sessions:write") ? "This view may not post" : `Post in ${g.name}: @ tags an agent`;
  form.querySelector<HTMLButtonElement>(".group-send")!.disabled = !mayPost || ui.team.posting === g.id;
  renderTalk(form.querySelector<HTMLButtonElement>(".talk")!, state, ui, mayPost);
  renderAttach(form, ui.team.media.attached.get(g.id) ?? [], mayPost);
  setText(form.querySelector(".group-send")!, ui.team.posting === g.id ? "Sending…" : "Send");
  // left, or taken out: this side's copy stays, read only
  const out = !ended && groupMe(g) === undefined;
  const closed = form.querySelector<HTMLElement>(".group-closed")!;
  setText(closed, ended ? "This group ended: it is read only." : out ? "You are no longer in this group: what was posted stays here to read." : "");
  setHidden(closed, !ended && !out);
  setHidden(form.querySelector<HTMLElement>(".group-composer-row")!, ended || out);
  const replyTo = ui.team.replyTo?.group === g.id ? ui.team.replyTo : undefined;
  const answered = replyTo ? state.groupPosts.get(g.id)?.posts.find((p) => p.id === replyTo.post) : undefined;
  const reply = form.querySelector<HTMLElement>(".group-reply")!;
  setHidden(reply, replyTo === undefined || ended);
  if (replyTo) setText(reply.querySelector(".group-reply-words")!, answered ? `Replying to ${postWriter(answered.from).name}: ${postExcerpt(answered.text, 90)}` : "Replying to an earlier post");
  const error = form.querySelector<HTMLElement>(".group-post-error")!;
  const refused = ui.team.postError?.group === g.id ? ui.team.postError.text : undefined;
  setText(error, refused ?? "");
  setHidden(error, refused === undefined);
  const complete = ui.team.complete?.group === g.id ? ui.team.complete : undefined;
  const list = form.querySelector<HTMLElement>(".group-complete")!;
  setHidden(list, complete === undefined);
  reconcile(list, complete?.options ?? [], (o) => o, (o) => {
    const b = actionButton("group-complete-option", `@${o}`, "group-complete-pick");
    b.setAttribute("role", "option");
    b.tabIndex = -1;
    return b;
  }, (b, o) => {
    const i = complete?.options.indexOf(o) ?? -1;
    setData(b, "index", String(i));
    b.setAttribute("aria-selected", String(i === complete?.active));
  });
}

// --- New group and Teammates, over the panes -------------------------------------------------------

/** What lies over the panes: New group's form, or the Teammates page; built once into `root`. */
function createTeamOverlay(root: HTMLElement): void {
  const head = el("header", "devices-head");
  const close = actionButton("devices-close viewer-tool viewer-close team-close", "", "team-close");
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close");
  const mark = el("span", "group-mark team-head-mark");
  mark.setAttribute("aria-hidden", "true");
  head.append(mark, el("h2", "devices-title team-title"), el("span", "devices-meta team-meta"), close);
  const note = el("p", "devices-note");
  note.setAttribute("role", "alert");
  const body = el("div", "devices-body");
  body.tabIndex = -1;
  body.append(createNewGroup(), createTeamsHub(), createTeamHome());
  root.append(head, note, body);
}

function createNewGroup(): HTMLElement {
  const column = el("div", "devices-column group-new");
  const form = el("form", "group-new-form devices-section");
  const name = el("input", "group-new-name");
  name.name = "name";
  name.maxLength = 80;
  name.autocomplete = "off";
  name.placeholder = "release, auth refactor, …";
  const purpose = el("input", "group-new-purpose");
  purpose.name = "purpose";
  purpose.maxLength = 300;
  purpose.autocomplete = "off";
  purpose.placeholder = "One line on what it is for (optional)";
  const nameLabel = el("label", "team-field");
  nameLabel.append(el("span", "team-field-label", "Name"), name);
  const purposeLabel = el("label", "team-field");
  purposeLabel.append(el("span", "team-field-label", "Purpose"), purpose);
  const notify = el("div", "team-choice group-new-notify");
  notify.setAttribute("role", "group");
  notify.setAttribute("aria-label", "Agents added are told of");
  for (const [value, label, title] of [
    ["tags", "Tags only", "An agent is told of the posts that tag it"],
    ["all", "Every post", "An agent is told of every post, gathered while it works"],
  ] as const) {
    const b = actionButton("team-choice-option", label, "group-new-notify");
    b.dataset["notify"] = value;
    b.title = title;
    notify.append(b);
  }
  const notifyRow = el("div", "team-field");
  notifyRow.append(el("span", "team-field-label", "Agents are told of"), notify);
  const create = el("button", "team-submit", "Make the group");
  create.type = "submit";
  const buttons = el("div", "group-form-buttons");
  buttons.append(create, actionButton("team-cancel-button", "Cancel", "team-close"));
  const error = el("p", "group-form-error");
  error.setAttribute("role", "alert");
  form.append(
    sectionHead("New group", "A chat of agents and people: your agents on any machine, your teammates, and their agents in what they share with you. Everyone in it must be teammates. Tag one with @ to ask it something; it reads the group when it chooses."),
    nameLabel,
    purposeLabel,
    notifyRow,
    el("p", "team-field-label", "Agents and people"),
    createAgentPick("new"),
    error,
    buttons,
  );
  column.append(form);
  return column;
}

/**
 * Teams, over the panes: Make a team, Invite a teammate and Join with a code, the one picked open
 * below them; then the user's teams, each opening its page, and Teammates, the people linked by a
 * code who are in no team, with the codes not used yet.
 */
function createTeamsHub(): HTMLElement {
  const column = el("div", "devices-column team-page");
  const blocked = el("p", "devices-empty team-blocked");
  const ways = el("div", "teams-hub-ways");
  for (const [label, action, title] of [
    ["Make a team", "team-new", "People who work together: everyone's Cophyla links to everyone else's, and the team has its own chat"],
    ["Invite a teammate", "team-share-invite", "One person, with a code you send them: good for a day, once"],
    ["Join with a code", "team-join", "Paste the invite or the code someone sent you"],
  ] as const) {
    const b = actionButton("team-start teams-hub-way", label, action);
    b.title = title;
    b.setAttribute("aria-pressed", "false");
    ways.append(b);
  }
  const invite = el("section", "devices-section team-invite");
  invite.append(el("p", "team-field-label", "What you share with them"), el("div", "team-share-slot"), createCodePanel());
  const teams = el("section", "devices-section teams-hub-teams");
  teams.append(el("h3", "devices-heading", "Your teams"), el("div", "teams-hub-rows"));
  const list = el("section", "devices-section team-list");
  list.append(el("h3", "devices-heading", "Teammates"), el("div", "team-rows"));
  column.append(blocked, ways, createNewTeam(), invite, createJoinTeam(), teams, list);
  return column;
}

function createCodePanel(): HTMLElement {
  const panel = el("div", "invite-panel team-code");
  const text = el("textarea", "invite-text");
  text.readOnly = true;
  text.rows = 3;
  text.spellcheck = false;
  text.setAttribute("aria-label", "The code");
  const buttons = el("div", "invite-buttons");
  buttons.append(actionButton("invite-copy", "Copy", "team-code-copy"), actionButton("invite-done", "Done", "team-code-done"));
  panel.append(el("p", "invite-head", "A teammate's code"), el("p", "invite-hint", "Send it to the other person: they paste it in Cophyla, Teams → Join with a code. It works once."), text, el("p", "invite-left"), buttons);
  return panel;
}

/** The share form: built once, and moved under whatever opened it. */
function createShareForm(): HTMLElement {
  const form = el("div", "team-share");
  const code = el("textarea", "team-code-input");
  code.rows = 3;
  code.spellcheck = false;
  code.placeholder = "their code: cophyla-team:…";
  code.setAttribute("aria-label", "Their code");
  const mode = el("div", "team-choice team-mode");
  mode.setAttribute("role", "group");
  mode.setAttribute("aria-label", "What to share");
  for (const [value, label] of [
    ["include", "Include"],
    ["exclude", "Exclude"],
  ] as const) {
    const b = actionButton("team-choice-option", label, "team-share-mode");
    b.dataset["mode"] = value;
    mode.append(b);
  }
  const open = el("div", "team-choice team-open");
  open.setAttribute("role", "group");
  open.setAttribute("aria-label", "Which agents");
  for (const [value, label, title] of [
    ["always", "Always open", "Every agent working in a shared folder can be reached"],
    ["chosen", "Chosen", "Only the agents you open to them, from a session's Connect"],
  ] as const) {
    const b = actionButton("team-choice-option", label, "team-share-open");
    b.dataset["open"] = value;
    b.title = title;
    open.append(b);
  }
  const broad = el("div", "team-broad");
  broad.setAttribute("role", "alert");
  const broadButtons = el("div", "group-form-buttons");
  broadButtons.append(actionButton("team-broad-ok", "Share it", "team-broad-ok"), actionButton("team-broad-back", "Pick folders", "team-broad-back"));
  broad.append(el("p", "team-broad-words"), broadButtons);
  const error = el("p", "group-form-error");
  error.setAttribute("role", "alert");
  const buttons = el("div", "group-form-buttons team-share-buttons");
  buttons.append(actionButton("team-submit", "", "team-share-submit"), actionButton("team-cancel-button", "Cancel", "team-share-close"));
  form.append(
    code,
    mode,
    el("p", "team-share-lede team-mode-lede"),
    el("div", "team-machines"),
    createFolderPicker("Share this folder", "team-folder-here"),
    open,
    el("p", "team-share-lede team-open-lede"),
    broad,
    error,
    buttons,
  );
  return form;
}

/** New group's form, Teams, or a team's page, over the panes while one is open. */
export function renderTeamOverlay(root: HTMLElement, state: ViewState, ui: UiState): void {
  const newGroup = ui.team.newGroup;
  const page = ui.team.page;
  const home = teamOverlayTitle(state, ui);
  const open = newGroup !== undefined || page !== undefined || home !== undefined;
  setHidden(root, !open);
  if (!open) return;
  if (!root.firstChild) createTeamOverlay(root);
  const show = newGroup ? "group" : page ? "team" : "team-home";
  setData(root, "show", show);
  setText(root.querySelector(".team-title")!, newGroup ? "New group" : page ? "Teams" : home!.title);
  setText(root.querySelector(".team-meta")!, newGroup || page ? "" : home!.meta);
  const since = page?.errorsAt ?? ui.team.teamErrorsAt;
  const error = since !== undefined && state.errorsSeen > since ? state.errors.at(-1) : undefined;
  const note = root.querySelector<HTMLElement>(".devices-note")!;
  setText(note, error ?? "");
  setHidden(note, error === undefined);
  const groupColumn = root.querySelector<HTMLElement>(".group-new")!;
  setHidden(groupColumn, show !== "group");
  if (newGroup) renderNewGroup(groupColumn, newGroup, state);
  const teamColumn = root.querySelector<HTMLElement>(".team-page")!;
  setHidden(teamColumn, show !== "team");
  if (show === "team") renderTeamsHub(teamColumn, state, ui);
  const homeColumn = root.querySelector<HTMLElement>(".team-home")!;
  setHidden(homeColumn, show !== "team-home");
  if (show === "team-home") renderTeamHome(homeColumn, state, ui);
  // The share form goes under what opened it: Make a team, Invite a teammate, Join with a code
  // (a team's invite or a teammate's code), a teammate's Edit, or a team's Change.
  const share = ui.team.share;
  let form = root.querySelector<HTMLElement>(".team-share");
  if (!share) {
    if (form) setHidden(form, true);
    return;
  }
  form ??= createShareForm();
  const where: Record<ShareForm["kind"], string> = {
    create: ".team-new .team-share-slot",
    invite: ".team-invite .team-share-slot",
    join: ".team-join-offer .team-share-slot",
    accept: ".team-join-teammate .team-share-slot",
    edit: `.team-row[data-id="${share.teammate ?? ""}"] .team-share-slot`,
    team: ".team-home .team-share-slot",
  };
  const slot = root.querySelector<HTMLElement>(where[share.kind]);
  if (slot && form.parentElement !== slot) slot.append(form);
  const offerShown = share.kind !== "join" || (ui.team.join?.offer !== undefined && state.teamOffers.has(ui.team.join.offer));
  setHidden(form, !slot || !offerShown);
  if (slot && offerShown) renderShareForm(form, share, state, ui);
}

function renderNewGroup(column: HTMLElement, f: NewGroupForm, state: ViewState): void {
  const form = column.querySelector<HTMLFormElement>(".group-new-form")!;
  for (const b of Array.from(form.querySelectorAll<HTMLButtonElement>(".group-new-notify button"))) b.setAttribute("aria-pressed", String(b.dataset["notify"] === f.notify));
  renderAgentPick(form.querySelector<HTMLElement>(".agent-pick")!, f, candidateGroups(f.candidates ?? [], undefined, f.picked), "No agent of yours, teammate or teammate's agent is there to add now: the group can be made without one, and others added later.");
  const submit = form.querySelector<HTMLButtonElement>(".team-submit")!;
  setText(submit, f.busy ? "Making…" : f.picked.size > 0 ? `Make the group with ${f.picked.size} agent${f.picked.size === 1 ? "" : "s"}` : "Make the group");
  submit.disabled = f.busy === true || !state.connected;
  const error = form.querySelector<HTMLElement>(".group-form-error")!;
  setText(error, f.error ?? "");
  setHidden(error, f.error === undefined);
}

/** Teammates on the Teams page: those linked by a code who are in no team, and the codes not used yet. */
function codeTeammates(state: ViewState): TeammateRow[] {
  return selectTeammates(state, Date.now()).filter((r) => r.state === "pending" || (state.teammates.get(r.id)?.teams?.length ?? 0) === 0);
}

function renderTeamsHub(column: HTMLElement, state: ViewState, ui: UiState): void {
  const t = ui.team;
  const blocked = teamBlock(state);
  const blockedLine = column.querySelector<HTMLElement>(".team-blocked")!;
  setText(blockedLine, blocked ?? "");
  setHidden(blockedLine, blocked === undefined);
  const share = t.share;
  const code = state.teammateCode;
  const inviting = share?.kind === "invite" || code !== undefined;
  // the three ways in: the one open pressed, and pressed again it closes
  for (const b of Array.from(column.querySelectorAll<HTMLButtonElement>(".teams-hub-way"))) {
    const action = b.dataset["action"];
    const on = action === "team-new" ? t.newTeam !== undefined : action === "team-join" ? t.join !== undefined : inviting;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.disabled = blocked !== undefined || !state.connected || share?.busy === true;
  }
  const make = column.querySelector<HTMLElement>(".team-new")!;
  setHidden(make, t.newTeam === undefined);
  if (t.newTeam) renderNewTeam(make, state, ui);
  const join = column.querySelector<HTMLElement>(".team-join")!;
  setHidden(join, t.join === undefined);
  if (t.join) renderJoinTeam(join, state, ui);
  // the user's teams, each opening its page
  const teams = [...state.teams.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const teamsSection = column.querySelector<HTMLElement>(".teams-hub-teams")!;
  setHidden(teamsSection, teams.length === 0);
  reconcile(teamsSection.querySelector<HTMLElement>(".teams-hub-rows")!, teams, (x) => x.id, createHubTeamRow, (n, x) => updateHubTeamRow(n, x, state));
  // Teammates: linked by a code, in no team
  const rows = codeTeammates(state);
  const list = column.querySelector<HTMLElement>(".team-list")!;
  setHidden(list, rows.length === 0);
  reconcile(list.querySelector<HTMLElement>(".team-rows")!, rows, (r) => r.id, createTeammateRow, (n, r) => updateTeammateRow(n, r, state, ui));
  const invite = column.querySelector<HTMLElement>(".team-invite")!;
  setHidden(invite, !inviting);
  setHidden(invite.querySelector<HTMLElement>(".team-field-label")!, share?.kind !== "invite");
  const panel = invite.querySelector<HTMLElement>(".team-code")!;
  setHidden(panel, code === undefined);
  if (code) {
    const text = panel.querySelector<HTMLTextAreaElement>(".invite-text")!;
    if (text.value !== code.code) text.value = code.code;
    const now = Date.now();
    const copied = ui.team.copied?.id === code.id ? ui.team.copied : undefined;
    setText(panel.querySelector(".invite-left")!, [code.expiresAt > now ? `good until ${clock(code.expiresAt)}` : "this code has run out", copied ? (copied.ok ? "copied" : "select the text and copy it") : ""].filter(Boolean).join(" · "));
  }
}

function createTeammateRow(): HTMLElement {
  const row = el("div", "team-row");
  const head = el("div", "team-row-head");
  head.append(el("span", "dot"), el("span", "team-who"), el("span", "team-words"));
  const actions = el("div", "invite-buttons team-row-actions");
  const edit = actionButton("team-edit", "Edit", "team-edit");
  edit.title = "Change what you share with them";
  const end = actionButton("team-end", "End", "team-end");
  end.title = "End it at both sides";
  const cancel = actionButton("team-cancel", "Cancel the code", "team-cancel");
  actions.append(edit, end, cancel);
  const ask = el("div", "team-end-ask");
  ask.setAttribute("role", "alert");
  ask.append(el("span", "team-end-words"), actionButton("team-end-confirm", "End", "team-end-confirm"), actionButton("team-end-cancel", "Keep", "team-end-cancel"));
  const conns = el("div", "team-conns");
  conns.append(el("p", "team-conns-head", "Connected agents"), el("div", "team-conn-rows"));
  row.append(head, el("p", "team-line team-mine"), el("p", "team-line team-theirs"), conns, actions, ask, el("div", "team-share-slot"));
  return row;
}

function createTeamConnRow(): HTMLElement {
  const row = el("div", "team-conn");
  const acts = el("div", "team-conn-acts");
  acts.append(
    actionButton("connect-btn connect-go connect-yes", "Connect", "tc-connect"),
    actionButton("connect-btn connect-decline", "Decline", "tc-decline"),
    actionButton("connect-btn connect-cancel", "Cancel", "tc-cancel"),
    actionButton("connect-btn connect-end", "End", "tc-end"),
    actionButton("connect-btn connect-dismiss", "Dismiss", "tc-dismiss"),
  );
  const ask = el("div", "connect-ask");
  ask.setAttribute("role", "alert");
  ask.append(el("span", "connect-ask-words", "End it? Both agents are told."), actionButton("connect-btn connect-danger", "End", "tc-end-confirm"), actionButton("connect-btn", "Keep", "tc-end-cancel"));
  row.append(el("span", "team-conn-words"), acts, ask);
  return row;
}

function updateTeamConnRow(row: HTMLElement, r: TeamConnectionRow, state: ViewState, ui: UiState): void {
  setData(row, "state", r.state);
  setText(row.querySelector(".team-conn-words")!, r.words);
  const asking = ui.team.connEnding === r.id;
  const busy = !state.connected || ui.team.busy.has(`tc:${r.id}`) || ui.team.busy.has(`connect:${r.teammate}\n${r.session}\n${r.agent}`);
  for (const b of Array.from(row.querySelectorAll<HTMLButtonElement>("button"))) {
    setData(b, "teammate", r.teammate);
    setData(b, "id", r.id);
    setData(b, "session", r.session);
    setData(b, "agent", r.agent);
    b.disabled = busy;
  }
  const shows = (cls: string, kind: TeamConnectionRow["buttons"][number]) => setHidden(row.querySelector<HTMLElement>(cls)!, !r.buttons.includes(kind));
  shows(".connect-yes", "connect");
  shows(".connect-decline", "decline");
  shows(".connect-cancel", "cancel");
  shows(".connect-end", "end");
  shows(".connect-dismiss", "dismiss");
  setHidden(row.querySelector<HTMLElement>(".team-conn-acts")!, asking);
  setHidden(row.querySelector<HTMLElement>(".connect-ask")!, !asking);
}

function updateTeammateRow(row: HTMLElement, r: TeammateRow, state: ViewState, ui: UiState): void {
  setData(row, "id", r.id);
  setData(row, "state", r.state);
  setData(row.querySelector<HTMLElement>(".dot")!, "status", r.state === "active" ? "connected" : "pending");
  setText(row.querySelector(".team-who")!, r.who);
  setText(row.querySelector(".team-words")!, r.words);
  setText(row.querySelector(".team-mine")!, `You share ${r.share}`);
  const theirs = row.querySelector<HTMLElement>(".team-theirs")!;
  setText(theirs, r.theirs !== undefined ? `They share ${r.theirs}` : "");
  setHidden(theirs, r.theirs === undefined);
  const conns = row.querySelector<HTMLElement>(".team-conns")!;
  const connRows = r.state === "active" ? teamConnectionRows(state, r.id) : [];
  setHidden(conns, connRows.length === 0);
  reconcile(conns.querySelector<HTMLElement>(".team-conn-rows")!, connRows, (c) => c.id, createTeamConnRow, (n, c) => updateTeamConnRow(n, c, state, ui));
  const busy = !state.connected || ui.team.pageBusy === true;
  const editing = ui.team.share?.kind === "edit" && ui.team.share.teammate === r.id;
  const asking = ui.team.ending === r.id;
  for (const b of Array.from(row.querySelectorAll<HTMLButtonElement>(".team-row-actions button, .team-end-ask button"))) {
    setData(b, "id", r.id);
    b.disabled = busy;
  }
  setHidden(row.querySelector<HTMLElement>(".team-row-actions")!, asking || editing);
  setHidden(row.querySelector<HTMLElement>(".team-edit")!, r.state !== "active");
  setHidden(row.querySelector<HTMLElement>(".team-end")!, r.state !== "active");
  setHidden(row.querySelector<HTMLElement>(".team-cancel")!, r.state !== "pending");
  const ask = row.querySelector<HTMLElement>(".team-end-ask")!;
  setHidden(ask, !asking);
  if (asking) setText(ask.querySelector(".team-end-words")!, teamEndWords(r.who, state.groups.values()));
}

function renderShareForm(form: HTMLElement, f: ShareForm, state: ViewState, ui: UiState): void {
  setData(form, "kind", f.kind);
  const code = form.querySelector<HTMLTextAreaElement>(".team-code-input")!;
  setHidden(code, f.kind !== "accept");
  if (f.kind !== "accept" && code.value !== "") code.value = "";
  for (const b of Array.from(form.querySelectorAll<HTMLButtonElement>(".team-mode button"))) b.setAttribute("aria-pressed", String(b.dataset["mode"] === f.mode));
  for (const b of Array.from(form.querySelectorAll<HTMLButtonElement>(".team-open button"))) b.setAttribute("aria-pressed", String(b.dataset["open"] === f.open));
  const theirs = f.kind === "create" || f.kind === "join" || f.kind === "team" ? "The team's agents" : "Their agents";
  setText(
    form.querySelector(".team-mode-lede")!,
    f.mode === "include"
      ? `${theirs} reach yours working in the folders ticked, and in every folder under them.`
      : `${theirs} reach yours in every workspace but the ones ticked; a workspace that appears later is shared closed until you open it or exclude it.`,
  );
  setText(form.querySelector(".team-open-lede")!, f.open === "always" ? "Every agent of yours working there can be reached." : f.kind === "team" || f.kind === "create" || f.kind === "join" ? "Only the agents you open to the team, from a session's Connect, can be reached." : "Only the agents you open to them, from a session's Connect, can be reached.");
  const browsing = f.browse !== undefined;
  const machines = form.querySelector<HTMLElement>(".team-machines")!;
  setHidden(machines, browsing);
  reconcile(machines, shareMachines(state, ui, f), (m) => m.node, createShareMachine, (n, m) => updateShareMachine(n, m, f));
  renderFolderPicker(form.querySelector<HTMLElement>(".folder-picker")!, f.browse, {
    title: (name) => `A folder on ${name}`,
    here: "Share this folder",
    hereTitle: (path) => `Tick ${path}, and every folder under it`,
    busy: f.busy === true,
  });
  const broad = form.querySelector<HTMLElement>(".team-broad")!;
  setHidden(broad, f.broad === undefined);
  if (f.broad) {
    const who =
      f.kind === "edit"
        ? (state.teammates.get(f.teammate ?? "")?.user ?? "them")
        : f.kind === "accept"
          ? "the person whose code it is"
          : f.kind === "team"
            ? `everyone in ${state.teams.get(f.team ?? "")?.name ?? "the team"}`
            : f.kind === "join"
              ? "everyone in the team"
              : f.kind === "create"
                ? "everyone you add to the team"
                : "whoever uses the code";
    setText(broad.querySelector(".team-broad-words")!, broadWords(f.broad, who, state.nodes.size > 1, (n) => machineName(state, n)));
  }
  const error = form.querySelector<HTMLElement>(".group-form-error")!;
  setText(error, f.error ?? "");
  setHidden(error, f.error === undefined);
  const submit = form.querySelector<HTMLButtonElement>(".team-submit")!;
  const joinName = f.kind === "join" ? (state.teamOffers.get(f.offer ?? "")?.name ?? "the team") : "";
  const words =
    f.kind === "invite"
      ? ["Make the code", "Making…"]
      : f.kind === "accept"
        ? ["Become teammates", "Connecting…"]
        : f.kind === "create"
          ? ["Make the team", "Making…"]
          : f.kind === "join"
            ? [`Join ${joinName}`, "Joining…"]
            : ["Save", "Saving…"];
  setText(submit, f.busy ? words[1]! : words[0]!);
  submit.disabled = f.busy === true || !state.connected || f.broad !== undefined;
  setHidden(form.querySelector<HTMLElement>(".team-share-buttons")!, browsing);
}

/** A machine in the share form: its workspaces and the folders ticked on it that are none. */
interface ShareMachine {
  node: string;
  name: string;
  folders: { key: string; place: TeammatePlace; name: string; hint: string }[];
}

function shareMachines(state: ViewState, ui: UiState, f: ShareForm): ShareMachine[] {
  const workspaces = ui.team.workspaces ?? [...state.workspaces.values()];
  const nodes = new Map<string, string>();
  const here = state.client?.node ?? state.node;
  if (here) nodes.set(here, machineName(state, here));
  for (const n of [...state.nodes.values()].sort((a, b) => a.name.localeCompare(b.name))) if (n.scope.kind !== "workspaces") nodes.set(n.id, n.name);
  for (const w of workspaces) if (!nodes.has(w.node)) nodes.set(w.node, machineName(state, w.node));
  for (const p of f.picked.values()) if (!nodes.has(p.node)) nodes.set(p.node, machineName(state, p.node));
  return [...nodes.entries()].map(([node, name]) => {
    const folders: ShareMachine["folders"] = [];
    const seen = new Set<string>();
    for (const w of [...workspaces].filter((w) => w.node === node).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = folderKey(state, w);
      if (seen.has(key)) continue;
      seen.add(key);
      folders.push({ key, place: { node, path: w.path }, name: w.name, hint: w.path });
    }
    for (const [key, p] of f.picked) {
      if (p.node !== node || seen.has(key)) continue;
      seen.add(key);
      folders.push({ key, place: p, name: p.path.split(/[\\/]/).filter(Boolean).pop() ?? p.path, hint: p.path });
    }
    return { node, name, folders };
  });
}

function createShareMachine(): HTMLElement {
  const block = el("fieldset", "team-machine");
  const more = actionButton("team-other", "Other folder…", "team-share-browse");
  block.append(el("legend", "team-machine-name"), el("div", "team-folders"), more);
  return block;
}

function updateShareMachine(block: HTMLElement, m: ShareMachine, f: ShareForm): void {
  setText(block.querySelector(".team-machine-name")!, m.name);
  const more = block.querySelector<HTMLButtonElement>(".team-other")!;
  setData(more, "node", m.node);
  setData(more, "name", m.name);
  more.title = `Pick a folder on ${m.name}`;
  more.disabled = f.busy === true;
  reconcile(block.querySelector<HTMLElement>(".team-folders")!, m.folders, (x) => x.key, createShareFolder, (n, x) => {
    const box = n.querySelector<HTMLInputElement>(".team-folder-check")!;
    setData(box, "key", x.key);
    setData(box, "node", x.place.node);
    setData(box, "path", x.place.path);
    box.checked = f.picked.has(x.key);
    box.disabled = f.busy === true;
    setText(n.querySelector(".team-folder-name")!, x.name);
    setText(n.querySelector(".team-folder-path bdi")!, x.hint);
    n.title = x.hint;
  });
}

function createShareFolder(): HTMLElement {
  const label = el("label", "team-folder");
  const box = el("input", "team-folder-check");
  box.type = "checkbox";
  // The path keeps its end, the part that tells folders apart, and drops its start (view.css).
  const path = el("span", "team-folder-path");
  path.append(el("bdi"));
  label.append(box, el("span", "team-folder-name"), path);
  return label;
}

/** The group's stream, while its pane shows: the scroller the view keeps in place and reads to its end. */
export function groupStream(root: HTMLElement): HTMLElement | undefined {
  if (root.hidden) return undefined;
  return root.querySelector<HTMLElement>(".group-stream") ?? undefined;
}
