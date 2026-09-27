// The default view: a rail of tabs on the left, the chat first and then one per open
// session, grouped by the folder it works in, and the selected one's pane beside it. The chat is the conversation
// with the orchestrator, every prompt, the open tasks (a scheduled one paused, resumed or
// marked done from its row) and the audit trail; a session's pane is its timeline. The
// input under the pane sends to whichever is selected, `chat.send` or `session.send`, and
// none shows under a terminal; `ask.answer` is
// by hand. A session that runs in a terminal the node holds shows that terminal, its
// timeline a click away, and a bare terminal (New terminal, in a recent workspace the user picks)
// has a tab and a pane of its own; one terminal shows at a time (terminal.ts). Notifications from the host become actions on the
// model; clicks and inputs become requests on the host's connection; every change renders,
// and the terminal screen moves to the pane that shows it. Under the tabs, one card
// per node of the user shows what its machine is doing, from the metrics it is subscribed
// to, and its desktop: Connect opens a viewer (a window from the desktop app, a stream page
// the host shows on a phone), and a PIN or a phone code pairs one. At a phone's width the
// rail is put away and slides in over the pane, from the menu button on the host's bar
// (`host.menu`) or, on a host with none, the view's own. The ⋮ beside the chat's tab has
// Change view, which opens the host's view picker over the frame (`host.chooseView`), and
// Settings, which opens the host's settings there (`host.settings`). While an agent's tab is
// selected the rail's lower half shows its folder's files (`session.files`, a level at a time as
// folders open) or, a tab away, the status cards; a file or a folder dragged from there onto the
// chat or the terminal drops its path, and so does one dragged in from the desktop where the
// shell can say where it is (`filePaths` in `host.ready`, dropped.ts), and the repository's
// line under the files (`session.git`) is read again as the agent works and every few
// seconds, since nothing says a push or a fetch happened. The divider between the sessions
// and that lower half moves, the same under every tab, and where the user left it is kept on
// the device (`host.savePrefs`, back in `host.ready`). Runs in a sandboxed frame with no
// network: the host is its whole world, but for where dropped files are in WebView2, which
// it asks the shell past the host (dropped.ts).
//
// The view pulls only what it shows. The node streams a session's events only while its
// tab is open (`session.watch`, sent again on every connect), and leaving a tab drops its
// timeline. The desktop app loads a tab's newest page as it opens and the chat's newest
// thread on connect; a phone or the web app loads neither unasked, and every page, the
// first included, is a press. A node's readings come summed per owner, and the spend is
// the node's own totals for the day with each live sample added. The grants come from
// `grant.list`, asked again after anything that changes them and every few seconds while an
// invite is on show or still open, since no notification says one was used.

import type { ClientResult, ContentBlock, Controller, GitState, Grant, GrantRole, HarnessProfile, InviteOffer, Message, MetricsSample, Node as CophylaNode, RemoteState, ClientSession as Session, SessionEvent, SpendTotals, Task, Terminal, ClientThread as Thread, VoiceState, ClientWorkspace as Workspace } from "@cophyla/protocol";
import { answerParams, apply, connectWords, dropText, dropTexts, explorerKey, filesErrorWords, HISTORY_PAGE, initialState, joinPaths, loadsHistory, nodeGrant, nodeInviteParams, openFolders, paneMode, parseComposer, phoneInviteParams, recentWorkspaces, sessionTerminal, SPEND_WINDOW_MS, stepScale, THREAD_PAGE, watchParams } from "./model.ts";
import type { AccountState, Action, DirectState, GrantEnd, HostReady, LoginOffer, PairingOffer, PhonePreset, RemoteInvite, TerminalOutput, ViewState, VoiceSetup } from "./model.ts";
import { activePane, draftOf, explorerSession, HOME_PLACE, RAIL_SPLIT, railSplit, refreshAskForm, render } from "./render.ts";
import type { RenderOptions, Roots, TerminalMenu, UiState } from "./render.ts";
import { DroppedPaths, webView2 } from "./dropped.ts";
import { HostRpc, ViewRpcError } from "./rpc.ts";
import { TerminalView } from "./terminal.ts";

const rpc = new HostRpc();
const dropped = new DroppedPaths(webView2(window), (names) => rpc.request("host.filePaths", { names }));
const state: ViewState = initialState();
const ui: UiState = { expanded: new Set(), pinnedFocus: false, opening: new Set(), modes: new Map(), fit: false, scale: 100, folded: new Set(), directBusy: new Set(), railTab: "files", railSplit: RAIL_SPLIT.usual, openDirs: new Map(), picked: new Map() };
const roots: Roots = {
  app: document.getElementById("app")!,
  railbar: document.getElementById("railbar")!,
  pinned: document.getElementById("pinned")!,
  tabs: document.getElementById("tabs")!,
  stream: document.getElementById("stream")!,
  sessions: document.getElementById("sessions")!,
  terminal: document.getElementById("terminal")!,
  composer: document.getElementById("composer")!,
};
const terminal = new TerminalView(rpc, () => draw());
/** The width at which the rail is put away until asked for (view.css has the same). */
const phone = matchMedia("(max-width: 640px)");

/** Renders, then puts the terminal screen where the selected tab shows one. */
function draw(opts: RenderOptions = {}): void {
  render(roots, state, ui, { ...opts, railShown: railShown() });
  syncTerminal();
}

/** Whether the rail shows: as the user left it, else beside the pane on a desk and away on a phone. */
function railShown(): boolean {
  return ui.rail !== undefined ? ui.rail === "open" : !phone.matches;
}

/** The menu button, the host's or the view's own: the rail shows, or goes away. */
function toggleRail(): void {
  ui.rail = railShown() ? "closed" : "open";
  if (ui.rail === "closed") {
    ui.newTerminal = undefined;
    ui.railMenu = undefined;
  }
  draw();
  refreshExplorer();
}

/** On a phone the rail lies over the pane: it goes once the user picked what the pane shows. */
function putRailAway(): void {
  if (phone.matches) ui.rail = undefined;
}

// Each width starts from its own: a turned phone, or a window narrowed, shows what it would at that width.
phone.addEventListener("change", () => {
  ui.rail = undefined;
  draw();
});

/** The terminal to show and where: a bare terminal's pane, or a session's pane showing its terminal; else none. */
function syncTerminal(): void {
  if (state.connected && state.scopes.includes("terminal")) {
    const bare = ui.terminal !== undefined ? state.terminals.get(ui.terminal) : undefined;
    if (bare) {
      terminal.show(bare.id, roots.terminal, { drive: ui.fit, scale: ui.scale, input: true });
      terminal.update(bare, true, ui.fit, ui.end?.terminal === bare.id ? ui.end.phase : undefined);
      return;
    }
    const card = ui.selected !== undefined ? state.sessions.get(ui.selected) : undefined;
    const own = card ? sessionTerminal(state, card.session) : undefined;
    const pane = card ? roots.sessions.querySelector<HTMLElement>(`.session[data-session="${card.session.id}"]`) : null;
    if (card && own && pane && paneMode(ui.modes.get(card.session.id), true) === "terminal") {
      terminal.show(own.id, pane, { drive: ui.fit, scale: ui.scale, input: true });
      terminal.update(own, false, ui.fit);
      return;
    }
  }
  terminal.hide();
}

let scheduled = false;
let anchorNext = false;

function dispatch(action: Action, opts: { anchor?: boolean } = {}): void {
  apply(state, action);
  if (opts.anchor) anchorNext = true;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const anchor = anchorNext;
    anchorNext = false;
    draw({ anchor });
  });
}

function fail(prefix: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  dispatch({ type: "error", message: `${prefix}: ${message}` });
}

// --- from the host ------------------------------------------------------------------------------

rpc.onNotification((n) => {
  switch (n.method) {
    case "host.ready": {
      const ready = n.params as HostReady;
      // The link moved with no gap (a phone onto its data channel, or back to the LAN): the node
      // knows this view as a new client now, so what the old one subscribed to is asked again.
      if (state.connected && state.client !== undefined && state.client.id !== ready.client.id) watched.clear();
      if (ready.prefs) {
        prefs = ready.prefs;
        if (!splitDrag) ui.railSplit = railSplit(prefs["railSplit"]);
      }
      dispatch({ type: "host.ready", params: ready });
      return;
    }
    case "host.menu":
      toggleRail();
      return;
    case "host.state": {
      const p = n.params as { connected: boolean };
      // The line is back: a restart asked for is done. Gone, the node let go of the button itself.
      if (p.connected) ui.restart = undefined;
      else ui.talking = false;
      dispatch({ type: "host.state", params: p });
      if (p.connected) {
        void loadProfiles();
        if (loadsHistory(state)) void loadChat();
        void loadControllers();
        void loadGrants();
        void loadNodes();
        void loadTerminals();
        // The node forgot the watch with the line, or holds one from a view this frame
        // replaced: the tab shown opens afresh, and the watch is said again.
        openTab();
      } else {
        typing(false);
        stopPairingClock();
        stopLoginClock();
        stopInviteClock();
        stopGrantClock();
        watched.clear();
        ui.opening.clear();
        ui.newTerminal = undefined;
      }
      return;
    }
    case "remote.state":
      dispatch({ type: "remote.state", params: n.params as RemoteState });
      return;
    case "account.state":
      dispatch({ type: "account.state", params: n.params as AccountState });
      if ((n.params as AccountState).subject !== undefined) stopLoginClock();
      return;
    case "direct.state":
      dispatch({ type: "direct.state", params: n.params as DirectState });
      return;
    case "node.state": {
      const node = n.params as CophylaNode;
      const harnesses = state.nodes.get(node.id)?.capabilities.harnesses.join(",");
      dispatch({ type: "node.state", params: node });
      // A harness signed in or out there: its profiles, and the usage rows they give, again.
      if (harnesses !== undefined && harnesses !== node.capabilities.harnesses.join(",")) void loadProfiles();
      // A node that went away takes its subscription with it; it is watched again when it is back.
      if (node.status === "online") void watchNode(node);
      else watched.delete(node.id);
      // a machine that joined used its invite; one that went may have been removed
      if (!nodeGrant(state, node.id)) grantsSoon();
      return;
    }
    case "metrics.sample":
      dispatch({ type: "metrics.sample", params: n.params as MetricsSample });
      return;
    case "chat.message":
      dispatch({ type: "chat.message", params: n.params as { message: Message } });
      return;
    case "chat.delta":
      dispatch({ type: "chat.delta", params: n.params as { message: string; block: number; delta: ContentBlock } });
      return;
    case "chat.retract":
      dispatch({ type: "chat.retract", params: n.params as { message: string } });
      return;
    case "task.state":
      dispatch({ type: "task.state", params: n.params as Task });
      return;
    case "voice.state":
      dispatch({ type: "voice.state", params: n.params as { state: VoiceState; client?: string } });
      return;
    case "voice.setup":
      dispatch({ type: "voice.setup", params: n.params as VoiceSetup });
      return;
    case "thread.state":
      dispatch({ type: "thread.state", params: n.params as Thread });
      return;
    case "session.state": {
      const s = n.params as Session;
      dispatch({ type: "session.state", params: s });
      if (s.status === "ended" && ui.kill?.session === s.id) ui.kill = undefined;
      // The session shown ended and left the rail: the chat shows, and the node hears the tab closed.
      if (s.status === "ended" && ui.selected === s.id) {
        ui.selected = undefined;
        openTab();
      }
      return;
    }
    case "terminal.state": {
      const t = n.params as Terminal;
      dispatch({ type: "terminal.state", params: t });
      terminal.state(t);
      // A terminal ended from its bar went: its tab leaves with it and the chat shows, as after Kill session.
      if (t.status === "exited" && ui.end?.terminal === t.id) {
        ui.end = undefined;
        if (ui.terminal === t.id) {
          ui.terminal = undefined;
          openTab();
        }
      }
      return;
    }
    case "terminal.output":
      terminal.output(n.params as TerminalOutput);
      return;
    case "session.event": {
      const e = n.params as SessionEvent;
      dispatch({ type: "session.event", params: e });
      // A tool the agent ran may have written, moved or committed something: its folder is read again once it settles.
      if (e.kind === "tool_result" && e.session === ui.selected) explorerSoon();
      return;
    }
    case "workspace.state":
    case "ask.state":
    case "audit.entry":
      dispatch({ type: n.method, params: n.params } as Action);
      return;
    default:
      return;
  }
});

// --- to the host ----------------------------------------------------------------------------------

/** The node's terminals; a node without tether has none, and says so quietly. */
async function loadTerminals(): Promise<void> {
  if (!state.scopes.includes("sessions:read")) return;
  try {
    const { terminals } = await rpc.request<{ terminals: Terminal[] }>("terminal.list", {});
    dispatch({ type: "terminals", terminals });
  } catch {
    dispatch({ type: "terminals", terminals: [] });
  }
}

/**
 * Opens New terminal's menu, or closes it on a second press. The workspaces are asked of the
 * node as it opens: the rows the view holds carry the activity they had when it connected,
 * since a row that moved only that is not sent again, and the menu's order is the activity's.
 */
async function toggleNewTerminal(): Promise<void> {
  if (!state.scopes.includes("terminal")) return;
  if (ui.newTerminal) return closeNewTerminal();
  const menu: TerminalMenu = {};
  ui.newTerminal = menu;
  draw();
  let workspaces: Iterable<Workspace>;
  try {
    workspaces = state.scopes.includes("sessions:read") ? (await rpc.request<{ workspaces: Workspace[] }>("workspace.list", {})).workspaces : [];
  } catch {
    // The rows from the connect still name the places, in an older order.
    workspaces = state.workspaces.values();
  }
  if (ui.newTerminal !== menu) return;
  menu.workspaces = recentWorkspaces(workspaces, state.node);
  draw();
  // The menu grows the rail's list under the button, which may need scrolling to.
  roots.tabs.querySelector<HTMLElement>(".new-terminal-menu")?.scrollIntoView({ block: "nearest" });
}

function closeNewTerminal(): void {
  ui.newTerminal = undefined;
  draw();
}

/**
 * Change view, from the ⋮ menu: the host lays its view picker over the frame, and what is
 * picked there replaces this view. An older host has no picker, and the menu says so.
 */
async function changeView(): Promise<void> {
  ui.railMenu = undefined;
  draw();
  try {
    await rpc.request("host.chooseView", {});
  } catch (e) {
    const unsupported = e instanceof ViewRpcError && e.code === "unsupported";
    ui.railMenu = { note: unsupported ? "This app cannot change views yet: update it." : `Change view: ${e instanceof Error ? e.message : String(e)}` };
    draw();
  }
}

/**
 * Settings, from the ⋮ menu: the host lays its settings over the frame — which account agents
 * start under, and with what. An older host has none, and the menu says so.
 */
async function openSettings(): Promise<void> {
  ui.railMenu = undefined;
  draw();
  try {
    await rpc.request("host.settings", {});
  } catch (e) {
    const unsupported = e instanceof ViewRpcError && e.code === "unsupported";
    ui.railMenu = { note: unsupported ? "This app can't show settings yet: update it." : `Settings: ${e instanceof Error ? e.message : String(e)}` };
    draw();
  }
}

/** Starts a shell in a workspace's folder, or the user's home, from New terminal's menu, and shows it. */
async function newTerminal(place: string): Promise<void> {
  const menu = ui.newTerminal;
  if (!state.scopes.includes("terminal") || !menu || menu.starting !== undefined) return;
  menu.starting = place;
  draw();
  try {
    const { terminal: t } = await rpc.request<{ terminal: Terminal }>("terminal.spawn", place === HOME_PLACE ? {} : { workspace: place });
    if (ui.newTerminal === menu) ui.newTerminal = undefined;
    dispatch({ type: "terminal.state", params: t });
    selectTerminal(t.id);
  } catch (e) {
    if (ui.newTerminal === menu) menu.starting = undefined;
    fail("terminal", e);
  }
}

/**
 * Ends a bare terminal's program once the user confirmed: Ending… shows until its
 * `terminal.state` says it exited and takes the tab away; a refusal puts End back and says why.
 */
async function endTerminal(id: string): Promise<void> {
  ui.end = { terminal: id, phase: "ending" };
  draw();
  try {
    await rpc.request("terminal.close", { terminal: id, end: true });
  } catch (e) {
    if (ui.end?.terminal === id) ui.end = undefined;
    fail("end", e);
  }
  draw();
}

/** The phones paired with this node, for the rail. */
async function loadControllers(): Promise<void> {
  if (!state.scopes.includes("controllers")) return;
  try {
    const { controllers } = await rpc.request<{ controllers: Controller[] }>("controller.list", {});
    dispatch({ type: "controllers", controllers });
  } catch (e) {
    fail("controllers", e);
  }
}

/**
 * Opens a pairing window and shows its code. The panel counts down, so it is re-rendered
 * every second until the code is spent or runs out.
 */
async function pair(): Promise<void> {
  if (!state.scopes.includes("controllers")) return;
  try {
    const offer = await rpc.request<PairingOffer>("pair.start", {});
    dispatch({ type: "pairing", offer });
    startPairingClock();
  } catch (e) {
    fail("pair", e);
  }
}

let pairingClock: ReturnType<typeof setInterval> | undefined;

function startPairingClock(): void {
  stopPairingClock();
  pairingClock = setInterval(() => {
    if (!state.pairing || state.pairing.expiresAt <= Date.now()) {
      stopPairingClock();
      // A window that ran out closes itself, and whatever paired shows up in the list.
      if (state.pairing && state.pairing.expiresAt <= Date.now()) dispatch({ type: "pairing" });
      void loadControllers();
      return;
    }
    draw();
  }, 1000);
}

function stopPairingClock(): void {
  if (pairingClock !== undefined) clearInterval(pairingClock);
  pairingClock = undefined;
}

/**
 * Starts the device-code login and shows its code. The daemon opens the browser for the
 * desktop app; on a phone the card offers the address. The card counts down until the
 * code is used (the node then says who signed in) or runs out.
 */
async function login(): Promise<void> {
  if (!state.scopes.includes("account")) return;
  try {
    const offer = await rpc.request<LoginOffer>("account.login", {});
    dispatch({ type: "login", offer });
    startLoginClock();
  } catch (e) {
    fail("login", e);
  }
}

let loginClock: ReturnType<typeof setInterval> | undefined;

function startLoginClock(): void {
  stopLoginClock();
  loginClock = setInterval(() => {
    if (!state.login || state.login.expiresAt <= Date.now()) {
      stopLoginClock();
      if (state.login && state.login.expiresAt <= Date.now()) dispatch({ type: "login" });
      return;
    }
    draw();
  }, 1000);
}

function stopLoginClock(): void {
  if (loginClock !== undefined) clearInterval(loginClock);
  loginClock = undefined;
}

async function logout(): Promise<void> {
  if (!state.scopes.includes("account")) return;
  try {
    await rpc.request("account.logout", {});
  } catch (e) {
    fail("logout", e);
  }
}

// --- the cloud backup -------------------------------------------------------------------------

/**
 * The passphrase form's submit: turning the backup on (carrying an existing one on, or
 * starting over with `replace`), or restoring the server's backup onto this node. A restore
 * and a start-over each ask once more here, since either replaces data. The passphrase
 * never touches the view's state: it goes straight from the form to the request.
 */
async function submitBackup(form: HTMLFormElement): Promise<void> {
  if (!state.scopes.includes("account") || ui.backupBusy) return;
  const mode = ui.backupForm;
  if (!mode) return;
  const pass = form.querySelector<HTMLInputElement>(".backup-pass")!;
  const again = form.querySelector<HTMLInputElement>(".backup-pass-again")!;
  const passphrase = pass.value;
  if (!passphrase) return;
  if (mode !== "restore" && passphrase !== again.value) {
    again.setCustomValidity("the two do not match");
    again.reportValidity();
    again.setCustomValidity("");
    return;
  }
  if (mode === "restore" && !window.confirm("Replace the memory, prompts, chat, tasks and editable files on this computer with the backup?")) return;
  if (mode === "replace" && !window.confirm("Drop the backup on the server and make a new one from this computer?")) return;
  ui.backupBusy = true;
  draw();
  try {
    if (mode === "restore") await rpc.request("backup.restore", { passphrase });
    else await rpc.request("backup.enable", { passphrase, ...(mode === "replace" ? { replace: true } : {}) });
    pass.value = "";
    again.value = "";
    ui.backupForm = undefined;
  } catch (e) {
    fail(mode === "restore" ? "restore" : "backup", e);
  } finally {
    ui.backupBusy = false;
    draw();
  }
}

/** A node's direct connections switched on or off; its `direct.state` says how it went. */
async function directSwitch(node: string, on: boolean): Promise<void> {
  if (!state.scopes.includes("account") || ui.directBusy!.has(node)) return;
  ui.directBusy!.add(node);
  draw();
  try {
    await rpc.request(on ? "direct.enable" : "direct.disable", { node });
  } catch (e) {
    fail("direct connections", e);
  } finally {
    ui.directBusy!.delete(node);
    draw();
  }
}

async function backupOff(): Promise<void> {
  if (!state.scopes.includes("account") || ui.backupBusy) return;
  const forget = window.confirm("Also drop the backup on the server? OK drops it; Cancel keeps it there, in case this computer turns it on again.");
  ui.backupBusy = true;
  draw();
  try {
    await rpc.request("backup.disable", forget ? { forget: true } : {});
  } catch (e) {
    fail("backup", e);
  } finally {
    ui.backupBusy = false;
    draw();
  }
}

/** Forgets a phone: shown at once, then confirmed by the platform's list. */
async function revokeController(id: string): Promise<void> {
  dispatch({ type: "controller.removed", id });
  try {
    await rpc.request("controller.revoke", { id });
  } catch (e) {
    fail("revoke", e);
  }
  void loadControllers();
}

// --- grants: invites for machines and phones, joining and leaving ------------------------------

/** Every grant this node keeps: the machines' roles and ends, the phones' access, the invites still open. */
async function loadGrants(): Promise<void> {
  if (!state.scopes.includes("controllers")) return;
  try {
    const { grants } = await rpc.request<{ grants: Grant[] }>("grant.list", {});
    dispatch({ type: "grants", grants });
    // an invite on show or still open counts down, and is asked after until it is used
    if (state.invite || [...state.grants.values()].some((g) => g.status === "pending")) startGrantClock();
    else stopGrantClock();
  } catch (e) {
    fail("grants", e);
  }
}

let grantsTimer: ReturnType<typeof setTimeout> | undefined;

/** The grants again in a moment: several node rows at once ask once. */
function grantsSoon(): void {
  if (grantsTimer !== undefined || !state.scopes.includes("controllers")) return;
  grantsTimer = setTimeout(() => {
    grantsTimer = undefined;
    void loadGrants();
  }, 500);
}

let grantClock: ReturnType<typeof setInterval> | undefined;
let grantTicks = 0;

/** While an invite shows or is open, its countdown moves every second, and the grants are asked again every five: nothing says one was used. */
function startGrantClock(): void {
  if (grantClock !== undefined) return;
  grantTicks = 0;
  grantClock = setInterval(() => {
    if (!state.connected) return;
    if (++grantTicks % 5 === 0) void loadGrants();
    draw();
  }, 1000);
}

function stopGrantClock(): void {
  if (grantClock !== undefined) clearInterval(grantClock);
  grantClock = undefined;
}

function openGrantForm(kind: "node" | "join" | "phone", from: HTMLElement): void {
  ui.grantForm = kind;
  draw();
  const form = from.closest(".node-tools, .rail-foot")?.querySelector(kind === "phone" ? ".phone-invite-form" : kind === "node" ? ".node-invite-form" : ".node-join-form");
  form?.querySelector<HTMLElement>("input, textarea")?.focus();
}

const field = (form: HTMLFormElement, name: string): string => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? "";

/** Mints an invite and shows it where it was asked for, until Done or until it is used. */
async function mintInvite(params: Record<string, unknown>): Promise<void> {
  ui.grantBusy = true;
  draw();
  try {
    const r = await rpc.request<{ grant: Grant; invite: InviteOffer }>("grant.invite", params);
    ui.grantForm = undefined;
    ui.copied = undefined;
    dispatch({ type: "invite", invite: { grant: r.grant.id, kind: r.grant.kind, name: r.grant.name, text: r.invite.text, link: r.invite.link, expiresAt: r.invite.expiresAt } });
    startGrantClock();
    void loadGrants();
  } catch (e) {
    fail("invite", e);
  } finally {
    ui.grantBusy = false;
    draw();
  }
}

function submitNodeInvite(form: HTMLFormElement): void {
  const params = nodeInviteParams({ name: field(form, "name"), role: field(form, "role") as GrantRole, end: field(form, "end") as GrantEnd });
  if ("error" in params) fail("invite", new Error(params.error));
  else void mintInvite(params);
}

function submitPhoneInvite(form: HTMLFormElement): void {
  const limit = field(form, "limit");
  const params = phoneInviteParams({ name: field(form, "name"), preset: field(form, "preset") as PhonePreset, ...(limit ? { limit } : {}), end: field(form, "end") as GrantEnd });
  if ("error" in params) fail("invite", new Error(params.error));
  else void mintInvite(params);
}

/** Copy puts the invite's text on the clipboard where the frame may, and otherwise selects it for the user to copy. */
async function copyInvite(): Promise<void> {
  const invite = state.invite;
  if (!invite) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(invite.text);
    ok = true;
  } catch {
    const box = document.querySelector<HTMLTextAreaElement>(".invite-panel .invite-text");
    if (box) {
      box.focus();
      box.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
  }
  ui.copied = { grant: invite.grant, ok };
  draw();
}

/** Cancels an invite still open, or takes a phone's or a machine's grant away: shown at once, then confirmed by the list. */
async function revokeGrant(id: string): Promise<void> {
  dispatch({ type: "grant.removed", id });
  try {
    await rpc.request("grant.revoke", { id });
  } catch (e) {
    fail("revoke", e);
  }
  void loadGrants();
  void loadControllers();
}

/** Removes a machine once the user confirmed on its card: its grant goes, and with it its link. */
async function removeNode(node: string): Promise<void> {
  const grant = nodeGrant(state, node);
  if (!grant) return;
  ui.removing = { node, phase: "removing" };
  draw();
  try {
    await rpc.request("grant.revoke", { id: grant.id });
    dispatch({ type: "grant.removed", id: grant.id });
  } catch (e) {
    fail("remove", e);
  } finally {
    ui.removing = undefined;
    draw();
  }
  void loadGrants();
  void loadNodes();
}

/** Joins the computer that made the invite, sharing the folders named and keeping the prompts here when asked. */
async function submitJoin(form: HTMLFormElement): Promise<void> {
  const invite = field(form, "invite").trim();
  if (!invite) return;
  const paths = joinPaths(field(form, "paths"));
  const answerHere = (form.elements.namedItem("answerHere") as HTMLInputElement | null)?.checked === true;
  ui.grantBusy = true;
  draw();
  try {
    await rpc.request("node.join", { invite, ...(paths.length > 0 ? { paths } : {}), ...(answerHere ? { answerHere: true } : {}) });
    ui.grantForm = undefined;
    form.reset();
  } catch (e) {
    fail("join", e);
  } finally {
    ui.grantBusy = false;
    draw();
  }
  void loadNodes();
  void loadGrants();
}

/** Leaves the primary once the user confirmed on this node's card. */
async function leavePrimary(): Promise<void> {
  ui.leaving = "leaving";
  draw();
  try {
    await rpc.request("node.leave", {});
  } catch (e) {
    fail("leave", e);
  } finally {
    ui.leaving = undefined;
    draw();
  }
  void loadNodes();
  void loadGrants();
}

/**
 * Opens a node's desktop. The desktop app's node starts a viewer window and answers `{}`; a
 * phone gets a stream page, a URL or (the app, which forwards it) a path, and the host shows
 * it; the node it came from goes along. A first viewer pairs on the way, which can wait on
 * the host's ask, so the button says so meanwhile.
 */
async function openRemote(node: string): Promise<void> {
  if (!state.scopes.includes("remote") || ui.opening.has(node)) return;
  ui.opening.add(node);
  draw();
  try {
    const result = await rpc.request<{ url?: string; path?: string; node?: string }>("remote.open", { node });
    if (result.url || result.path) await rpc.request("host.open", { node, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    dispatch({ type: "error", message: `connect: ${connectWords(e instanceof ViewRpcError ? e.code : undefined, message)}` });
  } finally {
    ui.opening.delete(node);
    draw();
  }
}

/** A viewer's PIN, typed on the node's card: the host takes it once the ask is answered. */
async function pairRemote(form: HTMLFormElement): Promise<void> {
  const node = form.dataset["node"];
  const pin = form.querySelector<HTMLInputElement>(".remote-pin-code");
  const name = form.querySelector<HTMLInputElement>(".remote-pin-name");
  if (!node || !pin || !/^\d{4}$/.test(pin.value.trim())) return;
  const params: { node: string; pin: string; name?: string } = { node, pin: pin.value.trim() };
  if (name?.value.trim()) params.name = name.value.trim();
  try {
    await rpc.request("remote.pair", params);
    pin.value = "";
    if (name) name.value = "";
    dispatch({ type: "remote.pin" });
  } catch (e) {
    fail("pair", e);
  }
}

/** A code for a phone from the node's host, shown on its card and counted down. */
async function inviteRemote(node: string): Promise<void> {
  try {
    const r = await rpc.request<Omit<RemoteInvite, "node">>("remote.invite", { node });
    dispatch({ type: "remote.invite", invite: { node, ...r } });
    startInviteClock();
  } catch (e) {
    fail("invite", e);
  }
}

/** Restarts the daemon this app is connected to; a busy one says what it would cut off, and the user may go ahead. */
async function restartNode(force: boolean): Promise<void> {
  ui.restart = { phase: "asking" };
  draw();
  try {
    await rpc.request("node.restart", force ? { force: true } : {});
    ui.restart = { phase: "restarting" };
  } catch (e) {
    const reasons = e instanceof ViewRpcError && e.code === "conflict" ? (e.data as { reasons?: string[] } | undefined)?.reasons : undefined;
    ui.restart = reasons ? { phase: "busy", reasons } : undefined;
    if (!reasons) fail("restart", e);
  }
  draw();
}

/** Ends a browser's session on a node, or unpairs an app from its host; the node's next `remote.state` shows it. */
async function revokeViewer(node: string, viewer: string): Promise<void> {
  try {
    await rpc.request("remote.revoke", { node, viewer });
  } catch (e) {
    fail("forget", e);
  }
}

let inviteClock: ReturnType<typeof setInterval> | undefined;

/** The phone code counts down; once it has run out it says so until Done. */
function startInviteClock(): void {
  stopInviteClock();
  inviteClock = setInterval(() => {
    const invite = state.remoteInvite;
    if (!invite || invite.expiresAt === undefined) {
      stopInviteClock();
      return;
    }
    draw();
    if (invite.expiresAt <= Date.now()) stopInviteClock();
  }, 1000);
}

function stopInviteClock(): void {
  if (inviteClock !== undefined) clearInterval(inviteClock);
  inviteClock = undefined;
}

/** The nodes, then each one's readings: a subscription for what comes, and the day's spend so far. */
async function loadNodes(): Promise<void> {
  if (!state.scopes.includes("nodes")) return;
  try {
    const { nodes } = await rpc.request<{ nodes: CophylaNode[] }>("node.list", {});
    dispatch({ type: "nodes", nodes });
    for (const node of nodes) void watchNode(node);
  } catch (e) {
    fail("nodes", e);
  }
}

/** The nodes whose metrics this connection is subscribed to; a node that comes online is watched once. */
const watched = new Set<string>();
const METRICS_INTERVAL_MS = 2000;
/** Each node's latest subscription: an answer to an earlier one, overtaken by a reconnect, is dropped. */
const watchGeneration = new Map<string, number>();

/**
 * Subscribes to a node's samples, their processes summed per owner (all its card shows),
 * with its spend over the day summed as the subscription starts: every token before the
 * totals is in them, every one after in the samples. The samples that land before the
 * answer are held, and counted once it arrives if the totals do not already hold them.
 */
async function watchNode(node: CophylaNode): Promise<void> {
  if (!state.connected || !state.scopes.includes("metrics:read") || node.status !== "online" || watched.has(node.id)) return;
  watched.add(node.id);
  const generation = (watchGeneration.get(node.id) ?? 0) + 1;
  watchGeneration.set(node.id, generation);
  dispatch({ type: "spend.loading", node: node.id });
  try {
    const { spend } = await rpc.request<{ spend?: SpendTotals }>("metrics.subscribe", { node: node.id, intervalMs: METRICS_INTERVAL_MS, processes: "owners", spend: { from: Date.now() - SPEND_WINDOW_MS } });
    if (watchGeneration.get(node.id) !== generation) return;
    dispatch({ type: "metrics.spend", node: node.id, ...(spend ? { totals: spend } : {}) });
  } catch (e) {
    if (watchGeneration.get(node.id) !== generation) return;
    watched.delete(node.id);
    // Without the totals the samples count on from what the panel shows.
    dispatch({ type: "metrics.spend", node: node.id });
    fail("metrics", e);
  }
}

async function loadProfiles(): Promise<void> {
  if (!state.scopes.includes("nodes")) return;
  try {
    const { profiles } = await rpc.request<{ profiles: HarnessProfile[] }>("profile.list", {});
    dispatch({ type: "profiles", profiles });
  } catch (e) {
    fail("profiles", e);
  }
}

/**
 * The newest thread with its messages, on connect on the desktop and on Load history on a
 * phone or the web app; `before` pages one earlier thread at a time. A page the user asked
 * for keeps the viewport on what it showed.
 */
async function loadChat(before?: string): Promise<void> {
  if (!state.scopes.includes("chat") || state.chatLoading) return;
  if (before === undefined && state.chatLoaded) return;
  const asked = before !== undefined || !loadsHistory(state);
  dispatch({ type: "chat.loading" });
  try {
    const params: { limit: number; before?: string } = { limit: THREAD_PAGE };
    if (before !== undefined) params.before = before;
    const { threads, messages } = await rpc.request<{ threads: Thread[]; messages: Message[] }>("chat.load", params);
    dispatch({ type: "chat.loaded", threads, messages, limit: THREAD_PAGE }, { anchor: asked });
  } catch (e) {
    dispatch({ type: "chat.failed" });
    fail("chat", e);
  }
}

async function chat(text: string): Promise<void> {
  const params = parseComposer(text, state.quick);
  if (!params) return;
  typing(false);
  try {
    await rpc.request<{ message: string }>("chat.send", params);
    dispatch({ type: "quick.toggle", quick: false });
  } catch (e) {
    fail("chat", e);
  }
}

// `chat.typing` at most every TYPING_MS while the composer changes; `active: false` on send, empty input or blur.
const TYPING_MS = 2000;
let typingActive = false;
let typingSentAt = 0;

function typing(active: boolean): void {
  if (!state.connected || !state.scopes.includes("chat")) return;
  const now = Date.now();
  if (active) {
    if (typingActive && now - typingSentAt < TYPING_MS) return;
    typingActive = true;
    typingSentAt = now;
    rpc.signal("chat.typing", { active: true });
    return;
  }
  if (!typingActive) return;
  typingActive = false;
  rpc.signal("chat.typing", { active: false });
}

/** The last `session.watch` sent, settled once the node has it. */
let watching: Promise<void> = Promise.resolve();

/** Tells the node which session's events to stream: the tab shown, none for the chat. The list replaces the one before. */
function watch(): void {
  const params = watchParams(state, ui.selected);
  if (!params) return;
  watching = rpc.request("session.watch", params).then(
    () => undefined,
    (e: unknown) => fail("watch", e),
  );
}

/**
 * A page of an open tab's history: the newest when nothing is shown, else the one before the
 * oldest event shown. The page is read once the watch has landed, so every event is either
 * in it or streamed after it; a page that comes back after its tab closed is dropped.
 */
async function loadEarlier(session: string): Promise<void> {
  const card = state.sessions.get(session);
  if (!card || !card.open || card.loading || card.exhausted) return;
  const opened = card.opened;
  dispatch({ type: "history.loading", session });
  try {
    await watching;
    if (!card.open || card.opened !== opened) return;
    const params: { id: string; limit: number; before?: number } = { id: session, limit: HISTORY_PAGE };
    if (card.oldestSeq !== undefined) params.before = card.oldestSeq;
    const { events } = await rpc.request<{ events: SessionEvent[] }>("session.history", params);
    dispatch({ type: "history", session, opened, events, limit: HISTORY_PAGE }, { anchor: true });
  } catch (e) {
    dispatch({ type: "history", session, opened, events: [], limit: 0 });
    fail("earlier", e);
  }
}

/**
 * The talk button, held and let go: `voice.ptt` on the host's own connection. The host streams
 * its microphone while the node listens to it, and what was said comes back as a message.
 */
function talk(held: boolean): void {
  if ((ui.talking === true) === held) return;
  ui.talking = held;
  draw();
  rpc.request("voice.ptt", { active: held }).catch((e: unknown) => {
    if (held) ui.talking = false;
    fail("talk", e);
  });
}

async function send(session: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const r = await rpc.request<{ status: "queued" | "held"; ref: string }>("session.send", { id: session, text: trimmed });
    dispatch({ type: "send.result", session, ref: r.ref, text: trimmed, at: Date.now(), status: r.status });
  } catch (e) {
    fail("send", e);
  }
}

/** Answers an ask from its form: the clicked option, else what is ticked and typed. */
async function answer(askId: string, form: HTMLFormElement, clicked?: string): Promise<void> {
  const ask = state.asks.get(askId);
  if (!ask) return;
  const params = answerParams(ask, draftOf(form, clicked));
  if (!params) return;
  try {
    await rpc.request("ask.answer", params);
  } catch (e) {
    fail("answer", e);
  }
}

/**
 * Kills a session once the user confirmed: Killing… shows until its `session.state` says it
 * ended and takes the tab away; a refusal puts Kill session back and says why.
 */
async function killSession(session: string): Promise<void> {
  ui.kill = { session, phase: "killing" };
  draw();
  try {
    await rpc.request("session.stop", { id: session });
  } catch (e) {
    if (ui.kill?.session === session) ui.kill = undefined;
    fail("kill", e);
  }
  draw();
}

async function focus(session: string): Promise<void> {
  try {
    await rpc.request("session.focus", { id: session });
  } catch (e) {
    fail("focus", e);
  }
}

/** Pause, resume or complete a task from its row: a `task.update` the platform confirms with `task.state`. */
async function taskAction(id: string, action: "pause" | "resume" | "complete"): Promise<void> {
  const task = state.tasks.get(id);
  if (!task) return;
  const patch = action === "pause" ? { status: "paused" } : action === "resume" ? { status: task.trigger ? "pending" : "ready" } : { status: "done" };
  try {
    await rpc.request("task.update", { id, patch });
  } catch (e) {
    fail(action, e);
  }
}

// --- the explorer ------------------------------------------------------------------------------

/** How often the repository is read again while the files show: nothing says a push or a fetch happened. */
const GIT_POLL_MS = 15_000;
/** How long after an agent's tool result its folder is read again, so a burst of them reads it once. */
const FILES_SETTLE_MS = 700;

/** The agent whose files show: its tab is selected, Files is picked, and the rail is out. */
function shownExplorer(): Session | undefined {
  if (!state.connected || ui.railTab !== "files" || !railShown()) return undefined;
  return explorerSession(state, ui);
}

/** Lists folders of a session's explorer: the ones named, else the folder itself and every one open in it. */
async function loadFiles(s: Session, dirs?: string[]): Promise<void> {
  const place = explorerKey(state, s);
  const asked = dirs ?? openFolders(ui.openDirs.get(place) ?? new Set());
  dispatch({ type: "files.loading", place, dirs: asked });
  try {
    const r = await rpc.request<ClientResult<"session.files">>("session.files", { id: s.id, dirs: asked });
    dispatch({ type: "files", place, asked, root: r.root, dirs: r.dirs });
  } catch (e) {
    const code = e instanceof ViewRpcError ? e.code : undefined;
    dispatch({ type: "files", place, asked, error: filesErrorWords(code, e instanceof Error ? e.message : String(e)) });
  }
}

/** The repository the session's folder is in; its line goes when there is none, or it could not be read. */
async function loadGit(s: Session): Promise<void> {
  const place = explorerKey(state, s);
  try {
    const r = await rpc.request<{ git?: GitState }>("session.git", { id: s.id });
    dispatch({ type: "git", place, ...(r.git ? { git: r.git } : {}) });
  } catch {
    dispatch({ type: "git", place });
  }
}

/** The files shown, read again: every open folder, and the repository. */
function refreshExplorer(): void {
  const s = shownExplorer();
  if (!s) return;
  void loadFiles(s);
  void loadGit(s);
}

let explorerTimer: ReturnType<typeof setTimeout> | undefined;

function explorerSoon(): void {
  clearTimeout(explorerTimer);
  explorerTimer = setTimeout(refreshExplorer, FILES_SETTLE_MS);
}

setInterval(() => {
  const s = shownExplorer();
  if (s && document.visibilityState === "visible") void loadGit(s);
}, GIT_POLL_MS);

// The user was elsewhere, in an editor or a terminal of their own: what they changed shows as they come back.
window.addEventListener("focus", () => refreshExplorer());

/** Opens a folder of the explorer or closes it; an opened one is listed, what was listed before showing meanwhile. */
function toggleFolder(rel: string, open?: boolean): void {
  const s = shownExplorer();
  if (!s) return;
  const place = explorerKey(state, s);
  let dirs = ui.openDirs.get(place);
  if (!dirs) {
    dirs = new Set();
    ui.openDirs.set(place, dirs);
  }
  const opening = open ?? !dirs.has(rel);
  if (opening === dirs.has(rel)) return;
  if (opening) dirs.add(rel);
  else dirs.delete(rel);
  draw();
  if (opening) void loadFiles(s, [rel]);
}

/** Picks an explorer row: a folder opens or closes, a file is only marked. */
function pickFile(row: HTMLElement): void {
  const s = shownExplorer();
  const rel = row.dataset["rel"];
  if (!s || rel === undefined) return;
  ui.picked.set(explorerKey(state, s), rel);
  if (row.dataset["kind"] === "dir") toggleFolder(rel);
  else draw();
}

/** The explorer's rows the arrows move through: folders and files, in order. */
function fileRows(): HTMLElement[] {
  return Array.from(roots.tabs.querySelectorAll<HTMLElement>(".explorer-tree .file-row[data-action=file]"));
}

/** Moves the focus to an explorer row, and marks it picked. */
function focusFile(row: HTMLElement | undefined): void {
  const s = shownExplorer();
  const rel = row?.dataset["rel"];
  if (!s || !row || rel === undefined) return;
  ui.picked.set(explorerKey(state, s), rel);
  draw();
  roots.tabs.querySelector<HTMLElement>(`.explorer-tree .file-row[data-rel="${CSS.escape(rel)}"]`)?.focus();
}

// The tree as VS Code's is walked: the arrows up and down, right to open a folder or step into
// it, left to close it or step out to its folder, Enter or Space to open or close.
document.addEventListener("keydown", (ev) => {
  const row = (ev.target as Element | null)?.closest?.<HTMLElement>(".explorer-tree .file-row[data-action=file]");
  const rel = row?.dataset["rel"];
  if (!row || rel === undefined || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const rows = fileRows();
  const i = rows.indexOf(row);
  const dir = row.dataset["kind"] === "dir";
  const open = row.getAttribute("aria-expanded") === "true";
  switch (ev.key) {
    case "ArrowDown":
      focusFile(rows[i + 1]);
      break;
    case "ArrowUp":
      focusFile(rows[i - 1]);
      break;
    case "Home":
      focusFile(rows[0]);
      break;
    case "End":
      focusFile(rows[rows.length - 1]);
      break;
    case "ArrowRight":
      if (dir && !open) toggleFolder(rel, true);
      else if (dir) focusFile(rows[i + 1]?.dataset["rel"]?.startsWith(`${rel}/`) ? rows[i + 1] : undefined);
      break;
    case "ArrowLeft": {
      if (dir && open) {
        toggleFolder(rel, false);
        break;
      }
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : undefined;
      if (parent !== undefined) focusFile(rows.find((r) => r.dataset["rel"] === parent));
      break;
    }
    case "Enter":
    case " ":
      pickFile(row);
      break;
    default:
      return;
  }
  ev.preventDefault();
});

/** What an explorer row carries when dragged: its path, beside the text any other drop takes. */
const PATH_TYPE = "application/x-cophyla-path";

/**
 * What a drag brings that lands as paths: an explorer row, or files and folders from the
 * desktop (Explorer, the Finder, a file manager) when the host can say where they are, since a
 * page learns only their names (dropped.ts).
 */
function dragKind(data: DataTransfer | null): "row" | "files" | undefined {
  if (!data) return undefined;
  if (data.types.includes(PATH_TYPE)) return "row";
  if (state.hostFilePaths && data.types.includes("Files")) return "files";
  return undefined;
}

document.addEventListener("dragstart", (ev) => {
  const row = (ev.target as Element | null)?.closest?.<HTMLElement>(".file-row[draggable=true]");
  const path = row?.dataset["path"];
  if (!row || !path || !ev.dataTransfer) return;
  ev.dataTransfer.setData(PATH_TYPE, path);
  ev.dataTransfer.setData("text/plain", dropText(path));
  ev.dataTransfer.effectAllowed = "copy";
});

/** The input under the pane that shows, the chat's or the session's, where the user may type. */
function composerInput(): HTMLInputElement | null {
  if (roots.composer.hidden) return null;
  return roots.composer.querySelector<HTMLInputElement>("form:not([hidden]) input[type=text]:not(:disabled)");
}

/**
 * Where a dragged path would land: the terminal on show, typed into as a paste; a text field,
 * which takes a row's text itself where it is dropped and files' paths at its caret; the pane
 * or its input's row, which puts it in the input at its caret; or nowhere.
 */
function dropTarget(target: EventTarget | null): "terminal" | "field" | "pane" | undefined {
  const node = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!node) return undefined;
  if (terminal.el.contains(node)) return terminal.droppable ? "terminal" : undefined;
  if (node.matches("input[type=text], textarea")) return (node as HTMLInputElement).disabled ? undefined : "field";
  if (node.closest("#panes") && composerInput()) return "pane";
  return undefined;
}

document.addEventListener("dragover", (ev) => {
  const kind = dragKind(ev.dataTransfer);
  if (!kind) return;
  const where = dropTarget(ev.target);
  // A text field takes a row's text itself; files it would not.
  if (where === undefined || (where === "field" && kind === "row")) return;
  ev.preventDefault();
  ev.dataTransfer!.dropEffect = "copy";
});

document.addEventListener("drop", (ev) => {
  const kind = dragKind(ev.dataTransfer);
  if (!kind) return;
  const where = dropTarget(ev.target);
  if (where === undefined || (where === "field" && kind === "row")) return;
  ev.preventDefault();
  if (kind === "row") {
    land(where, dropText(ev.dataTransfer!.getData(PATH_TYPE)));
    return;
  }
  const field = where === "field" ? (ev.target as HTMLInputElement) : undefined;
  const files = Array.from(ev.dataTransfer!.files);
  if (files.length === 0) return;
  dropped.paths(files).then(
    (paths) => land(where, dropTexts(paths), field),
    (e: unknown) => console.warn(`the dropped files did not land: ${e instanceof Error ? e.message : String(e)}`),
  );
});

/** Dropped paths, landing where they were dropped: typed into the terminal, or put in a field at its caret (the pane's is its input's). */
function land(where: "terminal" | "field" | "pane", text: string, field?: HTMLInputElement): void {
  if (where === "terminal") {
    // With a space after it, as macOS's terminals drop a file, so the next one dropped is a word of its own.
    terminal.paste(`${text} `);
    return;
  }
  const input = field ?? composerInput();
  if (!input) return;
  input.focus();
  // After what is there, never over it: a field leaves what was dropped on it selected. A
  // word right before it is kept apart by a space.
  const at = input.selectionEnd ?? input.value.length;
  const spaced = at > 0 && !/\s/.test(input.value[at - 1]!) ? ` ${text}` : text;
  input.setRangeText(spaced, at, at, "end");
  // As if typed: the session's draft keeps it.
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// --- the user --------------------------------------------------------------------------------------

/**
 * Opens the selected tab afresh, or the chat: every other tab drops its timeline, the node is
 * told which session's events to stream, and the desktop loads the tab's newest page. A
 * phone or the web app shows what streams from here, with history a press away.
 */
function openTab(): void {
  // A Kill or End left unconfirmed on the tab before is dropped; one on its way carries on.
  if (ui.kill?.phase === "asking") ui.kill = undefined;
  if (ui.end?.phase === "asking") ui.end = undefined;
  dispatch({ type: "tab.open", session: ui.selected });
  watch();
  if (ui.selected !== undefined && state.connected && loadsHistory(state)) void loadEarlier(ui.selected);
  // An agent's files show as its tab opens, read afresh.
  refreshExplorer();
}

/** Shows a session's tab, or the chat when `session` is undefined, and puts the cursor in its input. */
function select(session: string | undefined): void {
  if (session !== undefined && !state.sessions.has(session)) return;
  const changed = session !== ui.selected || ui.terminal !== undefined;
  ui.selected = session;
  ui.terminal = undefined;
  putRailAway();
  if (changed) openTab();
  draw();
  roots.composer.querySelector<HTMLInputElement>("form:not([hidden]) input[type=text]")?.focus();
}

/** Shows a bare terminal's tab: no session's events stream meanwhile. */
function selectTerminal(id: string): void {
  if (!state.terminals.has(id)) return;
  const changed = ui.terminal !== id || ui.selected !== undefined;
  ui.selected = undefined;
  ui.terminal = id;
  putRailAway();
  if (changed) openTab();
  draw();
  terminal.focus();
}

document.addEventListener("click", (ev) => {
  // New terminal's menu, and the ⋮ menu, close on a click anywhere but in them or on their buttons.
  if (ui.newTerminal && !(ev.target as Element | null)?.closest(".new-terminal-menu, .tab-new-terminal")) closeNewTerminal();
  if (ui.railMenu && !(ev.target as Element | null)?.closest(".rail-menu, .rail-more")) {
    ui.railMenu = undefined;
    draw();
  }
  const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
  if (!target || (target as HTMLButtonElement).disabled) return;
  switch (target.dataset["action"]) {
    case "answer": {
      const form = target.closest<HTMLFormElement>("form.ask-form");
      if (form && target.dataset["ask"] && target.dataset["option"]) void answer(target.dataset["ask"], form, target.dataset["option"]);
      return;
    }
    case "focus":
      if (target.dataset["session"]) void focus(target.dataset["session"]);
      return;
    case "session-kill":
      if (target.dataset["session"]) ui.kill = { session: target.dataset["session"], phase: "asking" };
      draw();
      return;
    case "session-kill-confirm":
      if (target.dataset["session"] && ui.kill?.phase === "asking") void killSession(target.dataset["session"]);
      return;
    case "session-kill-cancel":
      ui.kill = undefined;
      draw();
      return;
    case "task-pause":
    case "task-resume":
    case "task-complete":
      if (target.dataset["task"]) void taskAction(target.dataset["task"], target.dataset["action"].slice("task-".length) as "pause" | "resume" | "complete");
      return;
    case "select":
      select(target.dataset["session"]);
      return;
    case "select-terminal":
      if (target.dataset["terminal"]) selectTerminal(target.dataset["terminal"]);
      return;
    case "new-terminal":
      void toggleNewTerminal();
      return;
    case "rail-more":
      ui.railMenu = ui.railMenu ? undefined : {};
      draw();
      if (ui.railMenu) roots.tabs.querySelector<HTMLButtonElement>(".rail-menu-item:not(:disabled)")?.focus();
      return;
    case "change-view":
      void changeView();
      return;
    case "settings":
      void openSettings();
      return;
    case "new-terminal-in":
      if (target.dataset["place"]) void newTerminal(target.dataset["place"]);
      return;
    case "pane-mode": {
      const session = target.dataset["session"];
      const mode = target.dataset["mode"];
      if (!session || (mode !== "timeline" && mode !== "terminal")) return;
      ui.modes.set(session, mode);
      draw();
      if (mode === "terminal") terminal.focus();
      return;
    }
    case "term-fit":
      ui.fit = !ui.fit;
      draw();
      return;
    case "term-smaller":
    case "term-larger": {
      // A step from what it is drawn at, followed or driven, and fitted to the pane at it.
      const from = terminal.scale;
      const to = from !== undefined ? stepScale(from, target.dataset["action"] === "term-larger" ? 1 : -1) : undefined;
      if (to === undefined) return;
      ui.scale = to;
      ui.fit = true;
      draw();
      terminal.focus();
      return;
    }
    case "term-end":
      if (target.dataset["terminal"]) ui.end = { terminal: target.dataset["terminal"], phase: "asking" };
      draw();
      return;
    case "term-end-confirm":
      if (target.dataset["terminal"] && ui.end?.phase === "asking") void endTerminal(target.dataset["terminal"]);
      return;
    case "term-end-cancel":
      ui.end = undefined;
      draw();
      terminal.focus();
      return;
    case "pinned-fold":
      ui.pinnedFolded = !ui.pinnedFolded;
      draw();
      return;
    case "group-fold": {
      const group = target.dataset["group"];
      if (group === undefined) return;
      if (ui.folded.has(group)) ui.folded.delete(group);
      else ui.folded.add(group);
      draw();
      return;
    }
    case "rail-tab": {
      const tab = target.dataset["tab"];
      if (tab !== "files" && tab !== "status") return;
      ui.railTab = tab;
      draw();
      if (tab === "files") refreshExplorer();
      return;
    }
    case "files-refresh":
      refreshExplorer();
      return;
    case "files-collapse": {
      const s = shownExplorer();
      if (s) ui.openDirs.delete(explorerKey(state, s));
      draw();
      return;
    }
    case "file":
      pickFile(target);
      return;
    case "rail-toggle":
      toggleRail();
      return;
    case "rail-close":
      putRailAway();
      draw();
      return;
    case "earlier":
      if (target.dataset["session"]) void loadEarlier(target.dataset["session"]);
      return;
    case "chat-history":
      void loadChat();
      return;
    case "threads-earlier":
      if (state.oldestThread) void loadChat(state.oldestThread);
      return;
    case "quick":
      dispatch({ type: "quick.toggle" });
      return;
    case "pair":
      void pair();
      return;
    case "pair-close":
      stopPairingClock();
      dispatch({ type: "pairing" });
      void loadControllers();
      return;
    case "account-login":
      void login();
      return;
    case "account-logout":
      void logout();
      return;
    case "account-open":
      // The daemon opened the browser for the desktop app; a phone opens the page through its host.
      if (state.login) void rpc.request("host.open", { url: state.login.verificationUrl }).catch((e: unknown) => fail("open", e));
      return;
    case "account-login-close":
      stopLoginClock();
      dispatch({ type: "login" });
      return;
    case "backup-on":
      // with a backup on the server under another passphrase, the form offers to start over instead
      ui.backupForm = target.classList.contains("backup-replace") ? "replace" : "enable";
      draw();
      target.closest(".backup-row")?.querySelector<HTMLInputElement>(".backup-pass")?.focus();
      return;
    case "backup-restore":
      ui.backupForm = "restore";
      draw();
      target.closest(".backup-row")?.querySelector<HTMLInputElement>(".backup-pass")?.focus();
      return;
    case "backup-replace":
      ui.backupForm = "replace";
      draw();
      return;
    case "backup-cancel":
      ui.backupForm = undefined;
      draw();
      return;
    case "backup-off":
      void backupOff();
      return;
    case "direct-switch":
      if (target.dataset["node"]) void directSwitch(target.dataset["node"], target.dataset["on"] !== "1");
      return;
    case "controller-revoke":
      if (target.dataset["controller"]) void revokeController(target.dataset["controller"]);
      return;
    case "grant-form-node":
    case "grant-form-join":
    case "grant-form-phone":
      openGrantForm(target.dataset["action"].slice("grant-form-".length) as "node" | "join" | "phone", target);
      return;
    case "grant-form-close":
      ui.grantForm = undefined;
      draw();
      return;
    case "invite-copy":
      void copyInvite();
      return;
    case "invite-qr-zoom":
      ui.qrZoom = !ui.qrZoom;
      draw();
      return;
    case "invite-done":
      ui.copied = undefined;
      ui.qrZoom = false;
      dispatch({ type: "invite" });
      void loadGrants();
      void loadControllers();
      return;
    case "grant-cancel":
      if (target.dataset["grant"]) void revokeGrant(target.dataset["grant"]);
      return;
    case "node-remove":
      if (target.dataset["node"]) ui.removing = { node: target.dataset["node"], phase: "asking" };
      ui.leaving = undefined;
      draw();
      return;
    case "node-remove-confirm":
      if (target.dataset["node"]) void removeNode(target.dataset["node"]);
      return;
    case "node-leave":
      ui.leaving = "asking";
      ui.removing = undefined;
      draw();
      return;
    case "node-leave-confirm":
      void leavePrimary();
      return;
    case "node-grant-cancel":
      ui.removing = undefined;
      ui.leaving = undefined;
      draw();
      return;
    case "remote-open":
      if (target.dataset["node"]) void openRemote(target.dataset["node"]);
      return;
    case "remote-pin": {
      const node = target.dataset["node"];
      if (!node) return;
      apply(state, { type: "remote.pin", node });
      draw();
      target.closest(".node-remote")?.querySelector<HTMLInputElement>(".remote-pin-code")?.focus();
      return;
    }
    case "remote-pin-cancel":
      dispatch({ type: "remote.pin" });
      return;
    case "remote-invite":
      if (target.dataset["node"]) void inviteRemote(target.dataset["node"]);
      return;
    case "remote-invite-open":
      if (state.remoteInvite?.link) void rpc.request("host.open", { url: state.remoteInvite.link }).catch((e: unknown) => fail("open", e));
      return;
    case "remote-invite-close":
      stopInviteClock();
      dispatch({ type: "remote.invite" });
      return;
    case "remote-revoke":
      if (target.dataset["node"] && target.dataset["viewer"]) void revokeViewer(target.dataset["node"], target.dataset["viewer"]);
      return;
    case "node-restart":
      void restartNode(false);
      return;
    case "node-restart-force":
      void restartNode(true);
      return;
    case "node-restart-cancel":
      ui.restart = undefined;
      draw();
      return;
    case "toggle": {
      const key = target.dataset["target"];
      if (!key) return;
      if (ui.expanded.has(key)) ui.expanded.delete(key);
      else ui.expanded.add(key);
      draw();
      return;
    }
    default:
      return;
  }
});

document.addEventListener("submit", (ev) => {
  const form = ev.target as HTMLFormElement;
  if (form.classList.contains("ask-form")) {
    // Enter in the text box, or the Answer button: what is ticked and typed.
    ev.preventDefault();
    if (form.dataset["ask"]) void answer(form.dataset["ask"], form);
    return;
  }
  if (form.classList.contains("remote-pin-form")) {
    ev.preventDefault();
    void pairRemote(form);
    return;
  }
  if (form.classList.contains("backup-form")) {
    ev.preventDefault();
    void submitBackup(form);
    return;
  }
  if (form.classList.contains("node-invite-form")) {
    ev.preventDefault();
    submitNodeInvite(form);
    return;
  }
  if (form.classList.contains("phone-invite-form")) {
    ev.preventDefault();
    submitPhoneInvite(form);
    return;
  }
  if (form.classList.contains("node-join-form")) {
    ev.preventDefault();
    void submitJoin(form);
    return;
  }
  if (form.classList.contains("composer-form")) {
    ev.preventDefault();
    const input = form.querySelector<HTMLInputElement>(".composer-text");
    if (input && !input.disabled && input.value.trim()) {
      const text = input.value;
      input.value = "";
      void chat(text);
    }
    return;
  }
  if (!form.classList.contains("send")) return;
  ev.preventDefault();
  const session = form.dataset["session"];
  const input = form.querySelector<HTMLInputElement>(".send-text");
  if (session && input && !input.disabled) void send(session, input.value);
});

document.addEventListener("input", (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.classList.contains("composer-text")) {
    typing(input.value.trim() !== "");
    return;
  }
  const askForm = input.closest<HTMLFormElement>("form.ask-form");
  if (askForm) {
    refreshAskForm(askForm, state);
    return;
  }
  if (!input.classList.contains("send-text")) return;
  const session = input.closest<HTMLElement>(".send")?.dataset["session"];
  if (session) apply(state, { type: "draft", session, text: input.value });
});

document.addEventListener("change", (ev) => {
  const askForm = (ev.target as HTMLElement | null)?.closest<HTMLFormElement>("form.ask-form");
  if (askForm) refreshAskForm(askForm, state);
});

// The focus follows a sequence of asks only while the user stays in the pinned prompts.
document.addEventListener("focusin", (ev) => {
  ui.pinnedFocus = roots.pinned.contains(ev.target as Node);
});
document.addEventListener("mousedown", (ev) => {
  if (!roots.pinned.contains(ev.target as Node)) ui.pinnedFocus = false;
});

// Escape shrinks an invite's QR code shown large, closes New terminal's menu or the ⋮ menu,
// and the focus goes back to its button; with none open, it puts away the rail lying over a
// phone's pane.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (ui.qrZoom) {
    ui.qrZoom = false;
    draw();
  } else if (ui.newTerminal) {
    closeNewTerminal();
    roots.tabs.querySelector<HTMLButtonElement>(".tab-new-terminal")?.focus();
  } else if (ui.railMenu) {
    ui.railMenu = undefined;
    draw();
    roots.tabs.querySelector<HTMLButtonElement>(".rail-more")?.focus();
  } else if (phone.matches && ui.rail === "open") {
    putRailAway();
    draw();
  }
});

// --- the rail's divider --------------------------------------------------------------------------

/** What this view keeps on the device, as the host last handed it back: saved whole, each change on top. */
let prefs: Record<string, unknown> = {};
/** The divider is held: where in it the pointer took it, from its top. */
let splitDrag: { pointer: number; grab: number } | undefined;

/** The divider moved: the rail shows it at once, and the device keeps it. A host that keeps nothing forgets it with the frame. */
function setRailSplit(value: number, save: boolean): void {
  ui.railSplit = railSplit(value);
  roots.tabs.style.setProperty("--rail-split", String(ui.railSplit));
  roots.tabs.querySelector(".rail-split")?.setAttribute("aria-valuenow", String(ui.railSplit));
  if (!save) return;
  prefs = { ...prefs, railSplit: ui.railSplit };
  void rpc.request("host.savePrefs", { prefs }).catch(() => {});
}

/** The share the divider's top at `y` gives the sessions, of the height they and the lower half share. */
function splitAt(y: number): number | undefined {
  const list = roots.tabs.querySelector<HTMLElement>(".tab-sessions");
  const panel = roots.tabs.querySelector<HTMLElement>(".rail-panel");
  const split = roots.tabs.querySelector<HTMLElement>(".rail-split");
  if (!list || !panel || !split) return undefined;
  const top = list.getBoundingClientRect().top;
  const room = panel.getBoundingClientRect().bottom - top - split.offsetHeight;
  return room > 0 ? ((y - top) / room) * 100 : undefined;
}

document.addEventListener("pointerdown", (ev) => {
  const split = (ev.target as Element | null)?.closest<HTMLElement>(".rail-split");
  if (!split || ev.button !== 0) return;
  ev.preventDefault();
  split.setPointerCapture(ev.pointerId);
  splitDrag = { pointer: ev.pointerId, grab: ev.clientY - split.getBoundingClientRect().top };
  split.dataset["dragging"] = "true";
});
document.addEventListener("pointermove", (ev) => {
  if (!splitDrag || ev.pointerId !== splitDrag.pointer) return;
  const at = splitAt(ev.clientY - splitDrag.grab);
  if (at !== undefined) setRailSplit(at, false);
});
for (const type of ["pointerup", "pointercancel"] as const) {
  document.addEventListener(type, (ev) => {
    if (!splitDrag || ev.pointerId !== splitDrag.pointer) return;
    splitDrag = undefined;
    const split = roots.tabs.querySelector<HTMLElement>(".rail-split");
    if (split) delete split.dataset["dragging"];
    setRailSplit(ui.railSplit, true);
  });
}
document.addEventListener("dblclick", (ev) => {
  if ((ev.target as Element | null)?.closest(".rail-split")) setRailSplit(RAIL_SPLIT.usual, true);
});
document.addEventListener("keydown", (ev) => {
  if (!(ev.target as Element | null)?.classList.contains("rail-split")) return;
  const step = ev.shiftKey ? 10 : 2;
  const to = ev.key === "ArrowUp" ? ui.railSplit - step : ev.key === "ArrowDown" ? ui.railSplit + step : ev.key === "Home" ? RAIL_SPLIT.min : ev.key === "End" ? RAIL_SPLIT.max : undefined;
  if (to === undefined) return;
  ev.preventDefault();
  setRailSplit(to, true);
});

// The talk button listens while it is held: by the pointer, which it captures so a release
// outside it still counts, or by Space or Enter while it has the focus.
document.addEventListener("pointerdown", (ev) => {
  const button = (ev.target as Element | null)?.closest<HTMLButtonElement>(".talk");
  if (!button || button.disabled || ev.button !== 0) return;
  ev.preventDefault();
  button.setPointerCapture(ev.pointerId);
  talk(true);
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
  document.addEventListener(type, (ev) => {
    if (ui.talking && (ev.target as Element | null)?.closest(".talk")) talk(false);
  });
}
document.addEventListener("keydown", (ev) => {
  if ((ev.key === " " || ev.key === "Enter") && (ev.target as Element | null)?.classList.contains("talk")) {
    ev.preventDefault();
    if (!ev.repeat && !(ev.target as HTMLButtonElement).disabled) talk(true);
  }
});
document.addEventListener("keyup", (ev) => {
  if ((ev.key === " " || ev.key === "Enter") && ui.talking && (ev.target as Element | null)?.classList.contains("talk")) talk(false);
});
// A window that loses the focus mid-hold never sees the key come up.
window.addEventListener("blur", () => {
  if (ui.talking) talk(false);
});

document.addEventListener("focusout", (ev) => {
  if ((ev.target as HTMLElement | null)?.classList.contains("composer-text")) typing(false);
});

// On the desktop the chat pages back as the user scrolls to its top; a phone or the web app
// pages back only on the button.
roots.stream.addEventListener("scroll", () => {
  if (roots.stream.scrollTop < 40 && loadsHistory(state) && state.chatLoaded && !state.threadsExhausted && state.oldestThread) void loadChat(state.oldestThread);
});

// A pane showing its newest keeps showing it when its box changes size: the frame shown after
// the phone's Start (a render into a hidden frame cannot scroll), the keyboard opening. Each
// pane remembers where the user last left it; one never scrolled opens at its newest.
const atEnd = new WeakMap<Element, boolean>();
document.addEventListener(
  "scroll",
  (ev) => {
    const pane = ev.target;
    if (pane instanceof HTMLElement && (pane === roots.stream || pane.classList.contains("session"))) {
      atEnd.set(pane, pane.scrollHeight - pane.scrollTop - pane.clientHeight < 8);
    }
  },
  true,
);
const keepEnd = new ResizeObserver(() => {
  const pane = activePane(roots);
  if (pane && pane.clientHeight > 0 && (atEnd.get(pane) ?? true)) pane.scrollTop = pane.scrollHeight;
});
keepEnd.observe(document.getElementById("panes")!);
// The input shares the pane column: when it grows, shrinks or hides, the pane above it resizes.
keepEnd.observe(roots.composer);

draw();
