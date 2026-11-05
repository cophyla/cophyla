// Teams in the default view (milestone 35): their own category in the rail, the Teams page, a
// page for each team, and Waiting for you under Status. Drawn as the rest of the view is: keyed
// rows built once and updated in place, clicks carried by `data-action` to teamctl.ts.
//
// Teams in the rail: the heading, with one button that opens the Teams page, and each team folded
// like a folder, holding its own chat first, any of its groups no folder holds, and People and
// agents, which opens its page. Every other group stands in its workspace, as before teams.
//
// The Teams page: Make a team, Invite a teammate and Join with a code, the one picked open below
// them; then the user's teams, and the teammates made with a code that are in no team.
//
// A team's page: who is in it with their roles and what each shares, the invites still open,
// Add a person (a GitHub name, then the code to send them), the other people's agents with
// Connect one of mine, what this user shares with the team with Change, and the workspaces new in
// it waiting closed; Rename, Leave and End asked in place.
//
// Waiting for you, under Status, is everything that wants the user's answer: an invite into a
// team (Look opens the join page), and a workspace new in what they share, with Open or Keep
// closed. It shows only while something waits.

import type { Group, Team, TeamOffer } from "@cophyla/protocol";
import { closedPlaces, groupHeading, holdWords, railTeams, sessionLabel, teamPeople, teamShareWords, waitingItems } from "./model.ts";
import type { RailTeam, TeamAgentsSeen, TeamPersonRow, ViewState, WaitingItem } from "./model.ts";
import { actionButton, clock, el, reconcile, sectionHead, setData, setHidden, setText } from "./render.ts";
import type { UiState } from "./render.ts";
import { updateGroupTab, createGroupTab } from "./teamview.ts";

/** The fold key of the Teams heading, and of each team: none a folder's, which all hold a newline. */
export const TEAMS_GROUP = "teams";
export const teamFoldKey = (id: string) => `team:${id}`;

// --- what the user has open -------------------------------------------------------------------------

/** A team's page, as open: the team, and what is being asked or typed on it. */
export interface TeamPageUi {
  team: string;
  /** Add a person: the GitHub name typed, on its way, or why it failed. */
  adding?: { busy?: boolean; error?: string };
  /** Asked in place about one person: take out, make admin or member, hand over. */
  asking?: { user: string; what: "remove" | "admin" | "member" | "owner" };
  /** Leave or End, asked in place. */
  leaving?: "leave" | "end";
  /** The name and purpose being changed. */
  renaming?: boolean;
  /** One of the others' agents to connect one of the user's to: the picker of the user's own. */
  connecting?: { teammate: string; agent: string; name: string };
  /** A request on its way from the page: its buttons wait. */
  busy?: boolean;
  /** The others' agents as last asked of each side, by teammate. */
  seen: Map<string, TeamAgentsSeen>;
}

/** Joining: the code pasted and looked at, the offer it led to. */
export interface JoinUi {
  offer?: string;
  busy?: boolean;
  error?: string;
}

/** New team: on its way, or why it failed (the share form below says the rest). */
export interface NewTeamUi {
  busy?: boolean;
  error?: string;
}

// --- the rail --------------------------------------------------------------------------------------------

export function createTeamsSection(): HTMLElement {
  const node = el("div", "tab-group teams-group");
  const head = el("div", "teams-head");
  const name = actionButton("tab-group-name", "Teams", "group-fold");
  name.dataset["group"] = TEAMS_GROUP;
  name.title = "The people you work with: each team's chat and its people and their agents";
  const open = actionButton("teams-open", "", "team-open");
  open.title = "Teams: make one, invite a teammate, join with a code";
  open.setAttribute("aria-label", "Teams");
  head.append(name, open);
  node.append(head, el("div", "teams-list"));
  return node;
}

/** `byTeam` is where the rail placed each team's groups: its chat, and those no folder holds. */
export function renderTeamsSection(node: HTMLElement, state: ViewState, ui: UiState, byTeam?: Map<string, Group[]>): void {
  const can = state.scopes.includes("controllers");
  setHidden(node, !can);
  if (!can) return;
  const teams = railTeams(state, byTeam);
  const folded = ui.folded.has(TEAMS_GROUP);
  const name = node.querySelector<HTMLElement>(".teams-head .tab-group-name")!;
  setText(name, groupHeading("Teams", teams.length, folded));
  name.setAttribute("aria-expanded", folded ? "false" : "true");
  node.querySelector<HTMLElement>(".teams-open")!.setAttribute("aria-pressed", ui.team.page !== undefined ? "true" : "false");
  const list = node.querySelector<HTMLElement>(".teams-list")!;
  setHidden(list, folded || teams.length === 0);
  reconcile(list, folded ? [] : teams, (t) => t.id, createRailTeam, (n, t) => updateRailTeam(n, t, ui));
}

function createRailTeam(): HTMLElement {
  const node = el("div", "tab-group team-group");
  const name = actionButton("tab-group-name", "", "group-fold");
  const chats = el("div", "tab-group-chats");
  const people = actionButton("tab team-people", "", "team-page");
  people.append(el("span", "team-people-mark"), el("span", "tab-title", "People and agents"));
  node.append(name, chats, people);
  return node;
}

function updateRailTeam(node: HTMLElement, t: RailTeam, ui: UiState): void {
  setData(node, "team", t.id);
  const key = teamFoldKey(t.id);
  const folded = ui.folded.has(key);
  const name = node.querySelector<HTMLElement>(":scope > .tab-group-name")!;
  setData(name, "group", key);
  setText(name, groupHeading(t.name, t.unread, folded));
  name.title = `${t.name} · ${t.people} ${t.people === 1 ? "person" : "people"}${t.ended ? " · ended" : ""}`;
  name.setAttribute("aria-expanded", folded ? "false" : "true");
  const chats = node.querySelector<HTMLElement>(".tab-group-chats")!;
  setHidden(chats, folded || t.chats.length === 0);
  reconcile(chats, folded ? [] : t.chats, (g) => g.id, createGroupTab, (tab, g) => updateGroupTab(tab, g, ui));
  const people = node.querySelector<HTMLButtonElement>(".team-people")!;
  setHidden(people, folded);
  setData(people, "team", t.id);
  people.title = `${t.name}: its people, their agents, and what you share with it`;
  people.setAttribute("aria-current", ui.team.teamPage?.team === t.id ? "true" : "false");
}

// --- Waiting for you, under Status ------------------------------------------------------------------------

export function createWaiting(): HTMLElement {
  const section = el("section", "status-section status-waiting");
  section.setAttribute("aria-label", "Waiting for you");
  section.append(el("h3", "status-heading", "Waiting for you"), el("div", "waiting-rows"));
  return section;
}

export function renderWaiting(section: HTMLElement, state: ViewState, ui: UiState): void {
  const items = waitingItems(state);
  setHidden(section, items.length === 0);
  setText(section.querySelector(".status-heading")!, items.length > 1 ? `Waiting for you · ${items.length}` : "Waiting for you");
  reconcile(section.querySelector<HTMLElement>(".waiting-rows")!, items, (i) => i.key, createWaitingRow, (n, i) => updateWaitingRow(n, i, state, ui));
}

function createWaitingRow(): HTMLElement {
  const row = el("div", "waiting-row");
  const buttons = el("div", "waiting-buttons");
  buttons.append(actionButton("waiting-look", "Look", "team-offer-look"), actionButton("waiting-open", "", "team-place-open"), actionButton("waiting-keep", "", "team-place-exclude"));
  row.append(el("p", "waiting-words"), buttons);
  return row;
}

function updateWaitingRow(row: HTMLElement, i: WaitingItem, state: ViewState, ui: UiState): void {
  setData(row, "kind", i.kind);
  setText(row.querySelector(".waiting-words")!, i.words);
  const look = row.querySelector<HTMLButtonElement>(".waiting-look")!;
  const open = row.querySelector<HTMLButtonElement>(".waiting-open")!;
  const keep = row.querySelector<HTMLButtonElement>(".waiting-keep")!;
  setHidden(look, i.kind !== "offer");
  setHidden(open, i.kind !== "closed");
  setHidden(keep, i.kind !== "closed");
  const busy = !state.connected;
  if (i.kind === "offer") {
    row.title = i.title;
    setData(look, "offer", i.offer);
    look.disabled = busy;
  } else {
    row.title = "";
    setText(open, i.open);
    setText(keep, i.keep);
    setData(open, "key", i.key);
    setData(keep, "key", i.key);
    open.disabled = busy || ui.team.busy.has(`place:${i.key}`);
    keep.disabled = open.disabled;
  }
}

// --- over the panes: Teams' Make a team and Join with a code, and a team's page --------------------------------

/** Make a team, on the Teams page: the name, the purpose, and the share form below them. */
export function createNewTeam(): HTMLElement {
  const section = el("section", "devices-section team-new");
  const name = el("input", "team-new-name");
  name.maxLength = 80;
  name.autocomplete = "off";
  name.placeholder = "Studio, the 1.0 release, …";
  const purpose = el("input", "team-new-purpose");
  purpose.maxLength = 300;
  purpose.autocomplete = "off";
  purpose.placeholder = "One line on what it is for (optional)";
  const nameLabel = el("label", "team-field");
  nameLabel.append(el("span", "team-field-label", "Name"), name);
  const purposeLabel = el("label", "team-field");
  purposeLabel.append(el("span", "team-field-label", "Purpose"), purpose);
  const error = el("p", "group-form-error team-new-error");
  error.setAttribute("role", "alert");
  section.append(nameLabel, purposeLabel, el("p", "team-field-label", "What you share with the team"), el("div", "team-share-slot"), error);
  return section;
}

export function renderNewTeam(column: HTMLElement, state: ViewState, ui: UiState): void {
  const f = ui.team.newTeam ?? {};
  const error = column.querySelector<HTMLElement>(".team-new-error")!;
  setText(error, f.error ?? "");
  setHidden(error, f.error === undefined);
  for (const input of Array.from(column.querySelectorAll<HTMLInputElement>("input"))) input.disabled = f.busy === true || !state.connected;
}

/**
 * Join with a code, on the Teams page: a team's invite is looked at first, the team and who is in
 * it shown before the share form; a teammate's code goes straight to the share form.
 */
export function createJoinTeam(): HTMLElement {
  const column = el("div", "team-join");
  const look = el("section", "devices-section team-join-look");
  const code = el("textarea", "team-join-code");
  code.rows = 3;
  code.spellcheck = false;
  code.placeholder = "Paste the invite or code they sent you";
  code.setAttribute("aria-label", "The invite or code");
  const error = el("p", "group-form-error team-join-error");
  error.setAttribute("role", "alert");
  const buttons = el("div", "group-form-buttons");
  buttons.append(actionButton("team-submit team-join-look-go", "Look", "team-join-look"), actionButton("team-cancel-button", "Cancel", "team-hub-back"));
  look.append(code, error, buttons);
  const mate = el("section", "devices-section team-join-teammate");
  mate.append(el("p", "team-field-label", "What you share with them"), el("div", "team-share-slot"));
  const offer = el("section", "devices-section team-join-offer");
  const people = el("ul", "team-join-people");
  offer.append(el("h3", "devices-heading team-join-name"), el("p", "devices-lede team-join-words"), people, el("p", "team-field-label", "What you share with the team"), el("div", "team-share-slot"));
  const decline = el("div", "group-form-buttons team-join-decline");
  decline.append(actionButton("team-cancel-button", "Decline", "team-join-decline"));
  offer.append(decline);
  column.append(look, mate, offer);
  return column;
}

export function renderJoinTeam(column: HTMLElement, state: ViewState, ui: UiState): void {
  const j = ui.team.join ?? {};
  const offer: TeamOffer | undefined = j.offer !== undefined ? state.teamOffers.get(j.offer) : undefined;
  const teammate = ui.team.share?.kind === "accept";
  const look = column.querySelector<HTMLElement>(".team-join-look")!;
  setHidden(look, offer !== undefined || teammate);
  setHidden(column.querySelector<HTMLElement>(".team-join-teammate")!, !teammate);
  const error = column.querySelector<HTMLElement>(".team-join-error")!;
  setText(error, j.error ?? "");
  setHidden(error, j.error === undefined || offer !== undefined);
  const go = column.querySelector<HTMLButtonElement>(".team-join-look-go")!;
  go.disabled = j.busy === true || !state.connected;
  setText(go, j.busy && !offer ? "Looking…" : "Look");
  const section = column.querySelector<HTMLElement>(".team-join-offer")!;
  setHidden(section, offer === undefined);
  if (!offer) return;
  setText(section.querySelector(".team-join-name")!, `Join ${offer.name}?`);
  const left = holdWords(offer.expiresAt, Date.now());
  setText(section.querySelector(".team-join-words")!, [offer.purpose ? `${offer.purpose.replace(/[.!?]?$/, (m) => m || ".")}` : "", `${offer.by} invited you${offer.via === "teammate" ? ", from their Cophyla" : ""}.`, `Once in, everyone here can reach the agents in the folders you pick, and you talk in ${offer.name}'s chat.`, left.expired ? "The invite ran out." : `The invite holds, ${left.words}.`].filter(Boolean).join(" "));
  reconcile(section.querySelector<HTMLElement>(".team-join-people")!, offer.people, (p) => p.user, () => el("li", "team-join-person"), (n, p) => setText(n, p.role === "member" ? p.user : `${p.user} · ${p.role}`));
  for (const b of Array.from(section.querySelectorAll<HTMLButtonElement>(".team-join-decline button"))) {
    setData(b, "offer", offer.id);
    b.disabled = j.busy === true || !state.connected;
  }
}

export function createTeamHome(): HTMLElement {
  const column = el("div", "devices-column team-home");
  const warning = el("p", "devices-note team-warning");
  warning.setAttribute("role", "alert");
  // the name and purpose, changed in place
  const rename = el("section", "devices-section team-rename");
  const name = el("input", "team-rename-name");
  name.maxLength = 80;
  const purpose = el("input", "team-rename-purpose");
  purpose.maxLength = 300;
  purpose.placeholder = "One line on what it is for";
  const nameLabel = el("label", "team-field");
  nameLabel.append(el("span", "team-field-label", "Name"), name);
  const purposeLabel = el("label", "team-field");
  purposeLabel.append(el("span", "team-field-label", "Purpose"), purpose);
  const renameButtons = el("div", "group-form-buttons");
  renameButtons.append(actionButton("team-submit", "Save", "team-rename-save"), actionButton("team-cancel-button", "Cancel", "team-rename-cancel"));
  rename.append(nameLabel, purposeLabel, renameButtons);

  const people = el("section", "devices-section team-people-section");
  const peopleHead = el("div", "team-section-head");
  peopleHead.append(el("h3", "devices-heading", "People"), actionButton("team-start team-add-start", "Add a person", "team-add"));
  const add = el("div", "team-add-form");
  const login = el("input", "team-add-login");
  login.placeholder = "their GitHub name";
  login.autocomplete = "off";
  login.spellcheck = false;
  login.maxLength = 40;
  login.setAttribute("aria-label", "Their GitHub name");
  const addButtons = el("div", "group-form-buttons");
  addButtons.append(actionButton("team-submit team-add-go", "Invite", "team-add-go"), actionButton("team-cancel-button", "Cancel", "team-add-cancel"));
  const addError = el("p", "group-form-error team-add-error");
  addError.setAttribute("role", "alert");
  add.append(el("p", "devices-lede", "Only that GitHub account can take the invite, once, within seven days."), login, addError, addButtons);
  const code = el("div", "invite-panel team-invite-code");
  const text = el("textarea", "invite-text");
  text.readOnly = true;
  text.rows = 3;
  text.spellcheck = false;
  text.setAttribute("aria-label", "The invite");
  const codeButtons = el("div", "invite-buttons");
  codeButtons.append(actionButton("invite-copy", "Copy", "team-invite-copy"), actionButton("invite-done", "Done", "team-invite-done"));
  code.append(el("p", "invite-head"), el("p", "invite-hint"), text, el("p", "invite-left"), codeButtons);
  people.append(peopleHead, add, code, el("div", "team-person-rows"), el("div", "team-invite-rows"));

  const agents = el("section", "devices-section team-agents-section");
  agents.append(sectionHead("Their agents", "What the others share with this team. An open agent can be connected to one of yours; a closed one, its person decides."), el("div", "team-agent-people"), el("p", "devices-empty team-agents-empty"));

  const share = el("section", "devices-section team-share-section");
  const shareHead = el("div", "team-section-head");
  shareHead.append(el("h3", "devices-heading team-share-heading"), actionButton("team-start team-share-change", "Change", "team-share-edit"));
  share.append(shareHead, el("p", "devices-lede team-share-words"), el("div", "team-share-slot"), el("div", "team-closed-rows"));

  const footer = el("section", "devices-section team-footer");
  const footButtons = el("div", "invite-buttons");
  footButtons.append(actionButton("team-rename-start", "Rename", "team-rename"), actionButton("team-leave", "Leave", "team-leave"), actionButton("team-end-team", "End the team", "team-end-team"));
  const ask = el("div", "team-end-ask team-leave-ask");
  ask.setAttribute("role", "alert");
  ask.append(el("span", "team-end-words"), actionButton("team-end-confirm", "", "team-leave-confirm"), actionButton("team-end-cancel", "Stay", "team-leave-cancel"));
  footer.append(footButtons, ask);

  column.append(warning, rename, people, agents, share, footer);
  return column;
}

function createPersonRow(): HTMLElement {
  const row = el("div", "team-person");
  const head = el("div", "team-row-head");
  head.append(el("span", "dot"), el("span", "team-who"), el("span", "team-role"), el("span", "team-words"));
  const acts = el("div", "invite-buttons team-person-acts");
  acts.append(actionButton("team-person-btn", "Make admin", "team-person-admin"), actionButton("team-person-btn", "Make member", "team-person-member"), actionButton("team-person-btn", "Hand over", "team-person-owner"), actionButton("team-person-btn team-person-remove", "Take out", "team-person-remove"));
  const ask = el("div", "team-end-ask");
  ask.setAttribute("role", "alert");
  ask.append(el("span", "team-end-words"), actionButton("team-end-confirm", "", "team-person-confirm"), actionButton("team-end-cancel", "Cancel", "team-person-cancel"));
  row.append(head, acts, ask);
  return row;
}

function personAskWords(r: TeamPersonRow, team: Team, what: "remove" | "admin" | "member" | "owner"): { words: string; yes: string } {
  if (what === "remove") return { words: `Take ${r.user} out of ${team.name}? Their link with everyone in it ends, and they leave its chats.`, yes: "Take out" };
  if (what === "admin") return { words: `Make ${r.user} an admin? They can add people and take members out.`, yes: "Make admin" };
  if (what === "member") return { words: `Make ${r.user} a member again?`, yes: "Make member" };
  return { words: `Hand ${team.name} to ${r.user}? They become its owner, and you an admin.`, yes: "Hand over" };
}

function updatePersonRow(row: HTMLElement, r: TeamPersonRow, team: Team, state: ViewState, ui: UiState): void {
  setData(row, "user", r.user);
  setData(row.querySelector<HTMLElement>(".dot")!, "status", r.you || r.linked ? "connected" : "pending");
  setText(row.querySelector(".team-who")!, r.you ? `${r.user} (you)` : r.user);
  setText(row.querySelector(".team-role")!, r.role);
  setData(row.querySelector<HTMLElement>(".team-role")!, "role", r.role);
  setText(row.querySelector(".team-words")!, r.words);
  const page = ui.team.teamPage;
  const asking = page?.asking?.user === r.user ? page.asking : undefined;
  const busy = !state.connected || page?.busy === true;
  const show = (cls: string, what: TeamPersonRow["can"][number]) => {
    const b = row.querySelector<HTMLButtonElement>(`[data-action="${cls}"]`)!;
    setHidden(b, !r.can.includes(what));
    setData(b, "user", r.user);
    b.disabled = busy;
  };
  show("team-person-admin", "admin");
  show("team-person-member", "member");
  show("team-person-owner", "owner");
  show("team-person-remove", "remove");
  setHidden(row.querySelector<HTMLElement>(".team-person-acts")!, asking !== undefined || r.can.length === 0);
  const ask = row.querySelector<HTMLElement>(".team-end-ask")!;
  setHidden(ask, !asking);
  if (asking) {
    const w = personAskWords(r, team, asking.what);
    setText(ask.querySelector(".team-end-words")!, w.words);
    const yes = ask.querySelector<HTMLButtonElement>(".team-end-confirm")!;
    setText(yes, page?.busy ? "…" : w.yes);
    yes.disabled = busy;
  }
}

/** The others' agents on a team's page: per person, the agents their side says this team's share holds. */
interface AgentPerson {
  user: string;
  teammate: string;
  words?: string;
  agents: { key: string; session?: string; name: string; doing: string; tone: string; open: boolean }[];
}

function agentPeople(team: Team, page: TeamPageUi): AgentPerson[] {
  const out: AgentPerson[] = [];
  for (const m of team.members) {
    if (m.you || !m.teammate) continue;
    const seen = page.seen.get(m.teammate);
    const inTeam = <T extends { teams?: string[] }>(a: T) => a.teams === undefined || a.teams.includes(team.id);
    const doing = (status?: string, focus?: unknown) => (focus ? "in focus" : status === "busy" ? "working" : status === "idle" ? "idle" : status === "needs_permission" || status === "needs_input" ? "waiting on its user" : "");
    const agents: AgentPerson["agents"] = [];
    for (const a of (seen?.agents ?? []).filter(inTeam)) agents.push({ key: a.session ?? a.name, ...(a.session ? { session: a.session } : {}), name: `${m.user}/${a.name}`, doing: [doing(a.status, a.focus), a.intent ?? ""].filter(Boolean).join(": "), tone: a.status ?? "unknown", open: true });
    for (const a of (seen?.closed ?? []).filter(inTeam)) if (!agents.some((x) => x.session === a.session)) agents.push({ key: a.session, session: a.session, name: `${m.user}/${a.name}`, doing: a.connected ? "connected to one of yours" : `closed: ${m.user} decides`, tone: "closed", open: false });
    const words = !m.linked ? `${m.user}'s Cophyla is not linked yet.` : seen === undefined || (seen.loading && seen.at === undefined) ? `Asking ${m.user}'s Cophyla…` : seen.error && seen.at === undefined ? seen.error : agents.length === 0 ? `${m.user} shares no agent with this team now.` : undefined;
    out.push({ user: m.user, teammate: m.teammate, ...(words ? { words } : {}), agents: agents.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return out;
}

function createAgentPerson(): HTMLElement {
  const block = el("div", "team-agent-person");
  block.append(el("p", "team-agent-who"), el("p", "devices-empty team-agent-words"), el("div", "team-agent-rows"));
  return block;
}

function createTeamAgentRow(): HTMLElement {
  const row = el("div", "team-agent");
  row.append(el("span", "dot"), el("span", "team-agent-name"), el("span", "team-agent-doing"), actionButton("connect-btn connect-go", "Connect one of mine…", "team-agent-connect"));
  return row;
}

function updateAgentPerson(block: HTMLElement, p: AgentPerson, state: ViewState, ui: UiState): void {
  setText(block.querySelector(".team-agent-who")!, p.user);
  const words = block.querySelector<HTMLElement>(".team-agent-words")!;
  setText(words, p.words ?? "");
  setHidden(words, p.words === undefined);
  const connecting = ui.team.teamPage?.connecting;
  reconcile(block.querySelector<HTMLElement>(".team-agent-rows")!, p.agents, (a) => a.key, createTeamAgentRow, (row, a) => {
    setData(row.querySelector<HTMLElement>(".dot")!, "status", a.open ? (a.tone === "busy" ? "busy" : "connected") : "pending");
    setText(row.querySelector(".team-agent-name")!, a.name);
    setText(row.querySelector(".team-agent-doing")!, a.doing);
    const b = row.querySelector<HTMLButtonElement>(".connect-go")!;
    setHidden(b, !a.session);
    setData(b, "teammate", p.teammate);
    setData(b, "agent", a.session ?? "");
    setData(b, "name", a.name);
    setText(b, a.open ? "Connect one of mine…" : `Ask ${p.user}…`);
    b.setAttribute("aria-pressed", String(connecting?.agent === a.session));
    b.disabled = !state.connected;
  });
}

/** The user's own live agents, to connect one to another person's: from the picker under the team's agents. */
function mineToConnect(state: ViewState): { id: string; name: string }[] {
  return [...state.sessions.values()]
    .map((c) => c.session)
    .filter((s) => s.status !== "ended" && s.role !== "assistant")
    .map((s) => ({ id: s.id, name: sessionLabel(s) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function renderTeamHome(column: HTMLElement, state: ViewState, ui: UiState): void {
  const page = ui.team.teamPage;
  const team = page ? state.teams.get(page.team) : undefined;
  if (!page || !team) return;
  const manager = team.role === "owner" || team.role === "admin";
  const busy = !state.connected || page.busy === true;
  const warning = column.querySelector<HTMLElement>(".team-warning")!;
  setText(warning, team.warning ?? (team.ended ? `${team.name} ended: its chats are kept, read only.` : ""));
  setHidden(warning, team.warning === undefined && team.ended === undefined);

  // the name and purpose, changed in place
  const rename = column.querySelector<HTMLElement>(".team-rename")!;
  setHidden(rename, page.renaming !== true);
  if (page.renaming) {
    const n = rename.querySelector<HTMLInputElement>(".team-rename-name")!;
    const p = rename.querySelector<HTMLInputElement>(".team-rename-purpose")!;
    if (!rename.dataset["filled"]) {
      n.value = team.name;
      p.value = team.purpose ?? "";
      rename.dataset["filled"] = "1";
    }
    for (const b of Array.from(rename.querySelectorAll<HTMLButtonElement>("button"))) b.disabled = busy;
  } else delete rename.dataset["filled"];

  // people, invites, add
  const add = column.querySelector<HTMLElement>(".team-add-form")!;
  const start = column.querySelector<HTMLButtonElement>(".team-add-start")!;
  setHidden(start, !manager || page.adding !== undefined || team.ended !== undefined);
  start.disabled = busy;
  setHidden(add, page.adding === undefined);
  const addError = add.querySelector<HTMLElement>(".team-add-error")!;
  setText(addError, page.adding?.error ?? "");
  setHidden(addError, page.adding?.error === undefined);
  for (const b of Array.from(add.querySelectorAll<HTMLButtonElement>("button"))) b.disabled = busy || page.adding?.busy === true;
  setText(add.querySelector(".team-add-go")!, page.adding?.busy ? "Inviting…" : "Invite");
  const code = column.querySelector<HTMLElement>(".team-invite-code")!;
  const shown = state.teamCode && state.teamCode.team === team.id ? state.teamCode : undefined;
  setHidden(code, shown === undefined);
  // a teammate's Cophyla was handed the invite: it was sent, and there is no code to pass on
  const sent = shown?.offered === true;
  for (const part of Array.from(code.querySelectorAll<HTMLElement>(".invite-hint, .invite-text, .invite-left, .invite-copy"))) setHidden(part, sent);
  if (shown && sent) setText(code.querySelector(".invite-head")!, `Invitation sent to ${shown.user}.`);
  if (shown && !sent) {
    setText(code.querySelector(".invite-head")!, `An invite for ${shown.user}`);
    setText(code.querySelector(".invite-hint")!, `Send it to ${shown.user} yourself: the secret in it never reaches the server. They paste it in Cophyla: Teams → Join with a code.`);
    const text = code.querySelector<HTMLTextAreaElement>(".invite-text")!;
    if (text.value !== shown.code) text.value = shown.code;
    const left = holdWords(shown.expiresAt, Date.now());
    const copied = ui.team.copied?.id === shown.invite ? ui.team.copied : undefined;
    setText(code.querySelector(".invite-left")!, [left.expired ? "it ran out" : `good until ${clock(shown.expiresAt)}`, copied ? (copied.ok ? "copied" : "select the text and copy it") : ""].filter(Boolean).join(" · "));
  }
  reconcile(column.querySelector<HTMLElement>(".team-person-rows")!, teamPeople(team), (r) => r.user, createPersonRow, (n, r) => updatePersonRow(n, r, team, state, ui));
  const now = Date.now();
  reconcile(
    column.querySelector<HTMLElement>(".team-invite-rows")!,
    team.invites,
    (i) => i.id,
    () => {
      const row = el("div", "team-person team-invite-row");
      const head = el("div", "team-row-head");
      head.append(el("span", "dot"), el("span", "team-who"), el("span", "team-role", "invited"), el("span", "team-words"));
      row.append(head, actionButton("team-person-btn", "Cancel", "team-invite-cancel"));
      return row;
    },
    (row, i) => {
      setData(row.querySelector<HTMLElement>(".dot")!, "status", "pending");
      setText(row.querySelector(".team-who")!, i.user);
      setText(row.querySelector(".team-words")!, `by ${i.by} · ${holdWords(i.expiresAt, now).words}`);
      const b = row.querySelector<HTMLButtonElement>("button")!;
      setData(b, "invite", i.id);
      setHidden(b, !manager);
      b.disabled = busy;
    },
  );

  // the others' agents
  const people = agentPeople(team, page);
  reconcile(column.querySelector<HTMLElement>(".team-agent-people")!, people, (p) => p.teammate, createAgentPerson, (n, p) => updateAgentPerson(n, p, state, ui));
  const agentsEmpty = column.querySelector<HTMLElement>(".team-agents-empty")!;
  setText(agentsEmpty, people.length === 0 ? (manager ? "No one else is in the team yet: add a person." : "No one else is in the team now.") : "");
  setHidden(agentsEmpty, people.length > 0);
  // the picker of the user's own, under the agents while one is being connected
  let picker = column.querySelector<HTMLElement>(".team-mine-picker");
  if (!picker) {
    picker = el("div", "team-mine-picker");
    picker.append(el("p", "devices-lede team-mine-words"), el("div", "team-mine-rows"), actionButton("team-cancel-button", "Cancel", "team-agent-connect-cancel"));
    column.querySelector<HTMLElement>(".team-agents-section")!.append(picker);
  }
  setHidden(picker, page.connecting === undefined);
  if (page.connecting) {
    const c = page.connecting;
    setText(picker.querySelector(".team-mine-words")!, `Which of your agents should ${c.name} work with? The two message each other both ways, and no other agent is let in.`);
    reconcile(picker.querySelector<HTMLElement>(".team-mine-rows")!, mineToConnect(state), (s) => s.id, () => actionButton("team-mine", "", "team-agent-connect-go"), (b, s) => {
      setText(b, s.name);
      setData(b, "session", s.id);
      setData(b, "teammate", c.teammate);
      setData(b, "agent", c.agent);
      (b as HTMLButtonElement).disabled = !state.connected || ui.team.busy.has(`connect:${c.teammate}\n${s.id}\n${c.agent}`);
    });
  }

  // what the user shares
  setText(column.querySelector(".team-share-heading")!, `What you share with ${team.name}`);
  setText(column.querySelector(".team-share-words")!, teamShareWords(state, team.share));
  const change = column.querySelector<HTMLButtonElement>(".team-share-change")!;
  setHidden(change, ui.team.share?.kind === "team" || team.ended !== undefined);
  change.disabled = busy;
  const closed = closedPlaces({ ...state, teams: new Map([[team.id, team]]), teammates: new Map() });
  reconcile(
    column.querySelector<HTMLElement>(".team-closed-rows")!,
    closed,
    (r) => r.key,
    () => {
      const row = el("div", "waiting-row");
      const buttons = el("div", "waiting-buttons");
      buttons.append(actionButton("waiting-open", "", "team-place-open"), actionButton("waiting-keep", "Keep closed", "team-place-exclude"));
      row.append(el("p", "waiting-words"), buttons);
      return row;
    },
    (row, r) => {
      setText(row.querySelector(".waiting-words")!, `${r.words}: it waits closed`);
      const open = row.querySelector<HTMLButtonElement>(".waiting-open")!;
      setText(open, `Open to ${team.name}`);
      for (const b of Array.from(row.querySelectorAll<HTMLButtonElement>("button"))) {
        setData(b, "key", r.key);
        b.disabled = busy || ui.team.busy.has(`place:${r.key}`);
      }
    },
  );

  // Rename, Leave, End
  const footer = column.querySelector<HTMLElement>(".team-footer")!;
  setHidden(footer.querySelector<HTMLElement>(".team-rename-start")!, !manager || page.renaming === true || team.ended !== undefined);
  setHidden(footer.querySelector<HTMLElement>(".team-leave")!, team.role === "owner" || page.leaving !== undefined);
  setHidden(footer.querySelector<HTMLElement>(".team-end-team")!, team.role !== "owner" || page.leaving !== undefined || team.ended !== undefined);
  for (const b of Array.from(footer.querySelectorAll<HTMLButtonElement>(".invite-buttons button"))) b.disabled = busy;
  const ask = footer.querySelector<HTMLElement>(".team-leave-ask")!;
  setHidden(ask, page.leaving === undefined);
  if (page.leaving) {
    const others = team.members.filter((m) => !m.you).length;
    setText(ask.querySelector(".team-end-words")!, page.leaving === "leave" ? `Leave ${team.name}? Your links with the people in it end, unless another team holds you together, and you leave its chats.` : `End ${team.name} for everyone? ${others === 0 ? "Its" : `The ${others} other${others === 1 ? "" : "s"} lose their links through it, and its`} chats are kept read only.`);
    const yes = ask.querySelector<HTMLButtonElement>(".team-end-confirm")!;
    setText(yes, page.busy ? "…" : page.leaving === "leave" ? "Leave" : "End it");
    yes.disabled = busy;
  }
}

/** A team on the Teams page: its name, how many people, the user's role; it opens the team's page. */
export function createHubTeamRow(): HTMLElement {
  const row = actionButton("teams-hub-row", "", "team-page");
  const mark = el("span", "group-mark");
  mark.setAttribute("aria-hidden", "true");
  row.append(mark, el("span", "teams-hub-name"), el("span", "teams-hub-words"));
  return row;
}

export function updateHubTeamRow(row: HTMLElement, t: Team, state: ViewState): void {
  setData(row, "team", t.id);
  setText(row.querySelector(".teams-hub-name")!, t.name);
  const people = `${t.members.length} ${t.members.length === 1 ? "person" : "people"}`;
  const role = t.role === "owner" ? "you own it" : t.role === "admin" ? "you're an admin" : "";
  const invited = t.invites.length > 0 ? `${t.invites.length} invited` : "";
  setText(row.querySelector(".teams-hub-words")!, [people, invited, role, t.ended ? "ended" : ""].filter(Boolean).join(" · "));
  row.title = t.purpose ? `${t.name}: ${t.purpose}` : t.name;
  (row as HTMLButtonElement).disabled = !state.connected;
}

/** The overlay's title and meta for a team's page. */
export function teamOverlayTitle(state: ViewState, ui: UiState): { title: string; meta: string } | undefined {
  const page = ui.team.teamPage;
  const team = page ? state.teams.get(page.team) : undefined;
  if (!team) return undefined;
  const role = team.role === "owner" ? "you own it" : team.role === "admin" ? "you're an admin" : "";
  return { title: team.name, meta: [team.purpose ?? "", `${team.members.length} ${team.members.length === 1 ? "person" : "people"}`, role].filter(Boolean).join(" · ") };
}
