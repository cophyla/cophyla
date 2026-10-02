// The default view's renderer: keyed DOM reconciliation over the model's selectors. Every
// element is created once and updated in place, keyed on `data-key`, so inputs keep focus
// and the frame does not flicker. The rail on the left holds, on the desktop, a dot for the
// line to cophylad at the very top, one tab for the chat, fixed, the speaker beside it that says
// whether the next reply is read out and silences it,
// and under it one tab per open session, the agent's mark and its name, grouped under the
// folder they work in, a workspace inside another's indented under it, a folded heading
// saying how many tabs it holds, the bare terminals under Terminals, each named by the folder it works
// in, then Status, a glance: a line per machine (its dot and name, what it is, its readings as
// meters, its desktop's mark while shared, what wants the user, and Connect and Beside where
// this app can open its desktop), each login's limits as meters with what it spent today, a
// line per phone, and at its foot the way into Devices. While an
// agent's tab is selected that lower half has two tabs: Status, which holds all of it, and
// Files, the default, an explorer of the folder the agent works in, its folders folding open
// a level at a time, a file opening in the viewer at a click (fileview.ts, the file it shows
// marked in the tree), and each row dragged onto the chat or the terminal to drop its path
// there, and at its foot the repository's branch and the commits to pull and to push. A
// right-click on a row, or on the folder's name over them, opens a menu where it was clicked
// that shows the file or the folder in the file manager of the computer it is on, which only
// the desktop app there can do. Which of the two shows is the same for every agent;
// the chat stream and every session pane stay in the DOM and only the selected one shows,
// so the chat keeps its place when the user comes back, and a session's pane holds rows
// only while its tab is open. Above a timeline, and at the top of the chat, a button loads
// history a page earlier per press, and reads Load history while none is loaded, as on a
// phone or the web app, which load nothing unasked. Under the sessions, a tab per bare
// terminal (a shell started here) and New terminal, which opens a menu of the node's recent
// workspaces and its home folder to start one in; a session that runs in a terminal the node
// holds shows it in its pane, its timeline a click away (the screen itself is terminal.ts's), and
// a pane's head ends with Kill session, which asks in place before it ends anything. The
// input sits under the pane, the chat's or a timeline's, and there is none under a terminal,
// which takes the typing itself. Over it all the prompts waiting for the user are pinned,
// floating over the top middle of the frame and taking no room from it, under a bar that
// folds them to one line; a session's own leave them while its pane shows its terminal,
// where the harness asks them itself. On a phone's width the rail is put
// away and slides in over the pane from a menu button: the host's, on the bar under the
// frame, or on a host with none the view's own, in a thin bar over the pane beside the name
// of what it shows. Text is set with
// `textContent` only: nothing from a session, a message, an ask or an audit row is ever
// parsed as HTML. What a model wrote, Cophyla's messages and a session's replies, is drawn as
// markdown by building its elements (markdown.ts); what the user typed shows as typed.
// Devices lies over the panes, from Status's foot or a machine's or phone's line there: a card
// per machine (its name the user sets, what it is, its facts, its readings and processes, its
// desktop with who can view it a device a line, and Make primary, Restart and Remove or Leave,
// each asked in place), a row per phone with Forget, and the account. Under the machines and
// the phones, the grants: Add a computer and Add a phone mint an invite and show it (its text
// to copy, its QR code, how long it holds) until Done or until it is used; the invites still
// open, each with Cancel; and on the desktop, for this node itself, Join another computer
// while it is alone and Leave once it joined one.

import type { Ask, AuditEntry, Controller, FolderPick, GrantKind, Message, NodeId, ClientSession as Session, SessionEvent, Task, Terminal, ClientThread as Thread, TurnProgress, TurnStep, ClientWorkspace as Workspace } from "@cophyla/protocol";
import { renderBlocks } from "./blocks.ts";
import { renderText } from "./markdown.ts";
import { qrModules, qrPath } from "./qr.ts";
import { accessWords, answerParams, answerWords, askEventText, bytesWords, chatButton, chipTitle, controllerWords, endWords, explorerKey, explorerNote, GRANT_ENDS, gitLine, groupHeading, issuedWords, limitChoices, membershipOffer, micOff, nodeGrantWords, PHONE_PRESETS, selectFileRows, selectPendingInvites, costWords, countWords, earlierButton, inTether, inviteWords, keyOf, linkWords, loginWords, pairingWords, paneMode, percentWords, profileName, promoteOffer, remoteHere, renamable, restartable, restartWords, selectAccount, selectControllers, selectGroups, selectNodes, selectRemote, selectSpend, selectStream, selectTerminalTabs, tabNode, terminalGroups, terminalMachines, recentWorkspaces, RECENT_WORKSPACES, RECENT_PER_MACHINE, homePlace, folderPlace, selectTimeline, sessionLabel, placeKey, viewingKey, joinPath, revealBlocked, revealLabel, sessionTerminal, sessionWho, speakerButton, spendTitle, stoppable, tabTone, taskActions, terminalMark, terminalTabLabel, triggerWords, viewerTab, voiceBusy, voiceDot, voiceWords, workspaceName, heardText } from "./model.ts";
import type { AccountBar, AskDraft, BackupRow, DirectLine, DirectRow, FileRow, NodeBar, NodeCard, OwnerRow, PendingSend, RemoteCard, RemoteView, SessionCard, SessionGroup, SpendRow, StreamItem, Streaming, TaskAction, TerminalGroup, TerminalMachine, TimelineRow, ViewerDock, ViewerFile, ViewState, HeardWords } from "./model.ts";
import { selectWaitingAgents, waitingAgent, waitingLabel } from "./model.ts";
import { desktopWords, devicesWords, HARNESS_NAMES, machineFacts, selectStatusMachines, selectStatusPhones, usageMeters, viewerRows } from "./model.ts";
import type { StatusMachine, StatusMeter, StatusPhone, ViewerRow } from "./model.ts";

/** The folds the user opened, in `expanded`: a machine's processes in Devices. */
export const processesKey = (node: string): string => `node:${node}/processes`;

/** The sessions' share of the rail under the chat's row, in percent: the usual, and the least and most the divider goes to. */
export const RAIL_SPLIT = { usual: 45, min: 12, max: 88 } as const;

/** A share for the divider: a number held to its bounds, anything else the usual. */
export function railSplit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RAIL_SPLIT.usual;
  return Math.round(Math.min(RAIL_SPLIT.max, Math.max(RAIL_SPLIT.min, value)) * 10) / 10;
}

export interface UiState {
  /** Collapsibles the user opened: `<card key>/<row key>`, and the rail's folds. */
  expanded: Set<string>;
  /** The session whose tab is selected; undefined is the chat, unless a bare terminal's is. */
  selected?: string;
  /** The bare terminal whose tab is selected. */
  terminal?: string;
  /** What the user chose a session's pane to show, when it runs in a terminal; the terminal until they choose (`paneMode`). */
  modes: Map<string, "timeline" | "terminal">;
  /** Terminals shown here are sized to the pane ("Fit to this window") rather than followed. */
  fit: boolean;
  /** The font they are sized at, in percent of the default: − and + step it, and drive them. */
  scale: number;
  /** The rail's folder groups the user folded away, by group key, and Terminals (`TERMINALS_GROUP`). */
  folded: Set<string>;
  /** What the rail's lower half shows while an agent's tab is selected: its folder's files (the default) or the status cards. The same for every agent. */
  railTab: RailTab;
  /** The sessions' share of the rail's height under the chat's row, in percent, the rest the lower half's: the divider between them sets it, the same under every tab. */
  railSplit: number;
  /** The folders the user opened in the explorer, by their path under the folder it shows, per folder (`explorerKey`). */
  openDirs: Map<string, Set<string>>;
  /** The explorer's row the user last picked, per folder it shows. */
  picked: Map<string, string>;
  /** A file or a folder the Files panel is to show: its row is scrolled to once it is listed, and focused when `focus` says (a chip's, a folder's). */
  reveal?: { place: string; rel: string; focus: boolean };
  /** The file open in each tab, over its pane or beside it (fileview.ts): an agent's by session, a bare terminal's by `terminal:<id>` (`viewerTab`). */
  viewers: Map<string, ViewerFile>;
  /** Where the viewer sits on a wide window and its share of the width beside the pane, whether long lines wrap, and whether markdown and SVG show as written: the same for every file, kept on the device. */
  viewerDock: ViewerDock;
  viewerWidth: number;
  viewerWrap: boolean;
  viewerSource: boolean;
  /** The tether command a session's chip copied, as no window showed it, and whether the clipboard took it: its pane says so a while. */
  attachCopied?: { session: string; command: string; ok: boolean };
  /** The user was working in the pinned prompts: when its ask is replaced by the next one, the focus follows. */
  pinnedFocus: boolean;
  /** The user folded the pinned prompts away to their bar's one line. */
  pinnedFolded?: boolean;
  /** A session being killed from its pane: the user is asked to confirm, then it is on its way until the session ends. */
  kill?: { session: string; phase: "asking" | "killing" };
  /** New terminal's menu is open. */
  newTerminal?: TerminalMenu;
  /** The folder New terminal's picker last showed on each machine: it opens there again. */
  folderAt: Map<NodeId, string>;
  /** The ⋮ menu beside the chat's tab is open, with what went wrong when Change view or Settings could not open the host's layer. */
  railMenu?: { note?: string };
  /** The node shows the brain's context (`[brain] show_context`): the Context button is there. */
  contextOn?: boolean;
  /** The Context overlay lies over the pane. */
  contextOpen?: boolean;
  /**
   * The Files panel's menu is open for a row (`rel`, `""` the folder itself), at the point it
   * was asked for; with what went wrong when the file manager could not show it, and while the
   * request is on its way.
   */
  fileMenu?: { place: string; rel: string; kind: "file" | "dir"; x: number; y: number; note?: string; busy?: boolean };
  /** A bare terminal being ended from its bar: the user is asked to confirm, then it is on its way until it exits. */
  end?: { terminal: string; phase: "asking" | "ending" };
  /** This node's restart: asked, refused while busy with the reasons, or under way until the line is back. */
  restart?: { phase: "asking" | "busy" | "restarting"; reasons?: string[] };
  /** Nodes whose Connect is on its way: a viewer pairing can wait on an ask. */
  opening: Set<string>;
  /** Nodes whose desktop is being shared or stopped: the button waits for the answer, which can wait on an ask there. */
  sharing: Map<string, "on" | "off">;
  /** Another node's desktop shown beside the view (or over the pane): one at a time, kept across tabs. */
  remoteView?: RemoteView;
  /** Where that desktop sits on a wide window, and its share of the width beside the pane: kept on the device. */
  remoteDock: ViewerDock;
  remoteWidth: number;
  /** The user showed or put away the rail; undefined is the width's own: beside the pane on a desk, away on a phone, where it slides in over the pane. */
  rail?: "open" | "closed";
  /** The backup's passphrase form is open, for turning it on (`replace` starting over) or restoring. */
  backupForm?: "enable" | "replace" | "restore";
  /** A backup request is on its way: the buttons wait for its answer. */
  backupBusy?: boolean;
  /** Nodes whose direct connections are being switched: their button waits for the answer. */
  directBusy?: Set<string>;
  /** The grant form open under the machines or the phones: Add a machine, Join another computer, Invite a phone. */
  grantForm?: "node" | "join" | "phone";
  /** The talk button is held: Cophyla listens until it is let go. */
  talking?: boolean;
  /** A grant request on its way: the forms' buttons wait for its answer. */
  grantBusy?: boolean;
  /** A machine being removed from its card: asked in place, then on its way. */
  removing?: { node: string; phase: "asking" | "removing" };
  /** A machine being made the primary from its card: asked in place, then on its way. */
  promoting?: { node: string; phase: "asking" | "promoting" };
  /** A machine being named from its card: a field in place of its buttons, and Save on its way. */
  renaming?: { node: string; busy?: boolean };
  /** This node leaving the primary it joined: asked in place, then on its way. */
  leaving?: "asking" | "leaving";
  /** Whether Copy put the invite's text on the clipboard, for the invite it was pressed on. */
  copied?: { grant: string; ok: boolean };
  /** The invite's QR code shows large, over the view, for a camera across the desk. */
  qrZoom?: boolean;
  /**
   * Devices lies over the pane: every machine and phone with all they can do, and the account.
   * Once more errors came than `errorsAt`, the count as it opened, it says the last of them,
   * since it covers the input that says them otherwise.
   */
  devices?: { errorsAt: number };
}

export type RailTab = "files" | "status";

/**
 * New terminal's menu: every node's workspaces once the node listed them, and the place a shell
 * is starting in (a workspace's id, `homePlace` or `folderPlace` of a machine); with the folder
 * picker, open on one machine in place of the places.
 */
export interface TerminalMenu {
  workspaces?: Workspace[];
  starting?: string;
  browse?: FolderBrowse;
}

/** New terminal's folder picker: the machine, the folder it shows once listed, one asked for and not answered yet, and why the last could not be listed. */
export interface FolderBrowse {
  node: NodeId;
  name: string;
  listing?: FolderPick;
  loading?: string;
  error?: string;
}

export interface RenderOptions {
  /** Keep the viewport anchored to what it showed: content was inserted above it. */
  anchor?: boolean;
  /** The rail shows at this width, as the user left it or by the width's own. */
  railShown?: boolean;
}

export interface Roots {
  /** The whole view: it carries whether the rail is shown and whether the host has the button for it. */
  app: HTMLElement;
  /** On a phone's width with no host button: the rail's own button and where the pane is. */
  railbar: HTMLElement;
  pinned: HTMLElement;
  tabs: HTMLElement;
  stream: HTMLElement;
  sessions: HTMLElement;
  /** The pane a bare terminal shows in. */
  terminal: HTMLElement;
  composer: HTMLElement;
  /** Devices, over the panes while it is open. */
  devices: HTMLElement;
}

// --- helpers ---------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function setData(node: HTMLElement, name: string, value: string): void {
  if (node.dataset[name] !== value) node.dataset[name] = value;
}

/** Keeps `container`'s children in step with `items`, keyed, creating and moving as needed. */
export function reconcile<T>(container: HTMLElement, items: T[], key: (t: T) => string, create: (t: T) => HTMLElement, update: (e: HTMLElement, t: T) => void): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const k = (child as HTMLElement).dataset["key"];
    if (k !== undefined) existing.set(k, child as HTMLElement);
  }
  let cursor: Element | null = container.firstElementChild;
  for (const item of items) {
    const k = key(item);
    let node = existing.get(k);
    if (node) {
      existing.delete(k);
    } else {
      node = create(item);
      node.dataset["key"] = k;
    }
    update(node, item);
    if (node !== cursor) container.insertBefore(node, cursor);
    else cursor = cursor.nextElementSibling;
  }
  for (const stale of existing.values()) stale.remove();
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function clock(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? timeFormat.format(d) : dateFormat.format(d);
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function firstLine(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value : pretty(value);
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

const STATUS_WORD: Record<Session["status"], string> = {
  idle: "idle",
  busy: "working",
  needs_input: "waiting for input",
  needs_permission: "waiting for permission",
  ended: "ended",
};

/** A status in words, with what an idle session waits on: its own shells, or a dialog in its terminal. */
function statusWord(s: { status: Session["status"]; waiting?: Session["waiting"] | undefined }): string {
  if (s.status === "idle" && s.waiting?.on === "shell") return "waiting on its shell";
  if (s.status === "idle" && s.waiting?.on === "user") return s.waiting.detail ? `waiting for you: ${s.waiting.detail}` : "waiting for you";
  return STATUS_WORD[s.status] ?? String(s.status);
}

/** The chip's dot: a status, or what an idle session waits on. */
function dotStatus(s: Session): string {
  if (s.status === "idle" && s.waiting) return s.waiting.on === "shell" ? "shell" : "waiting";
  return s.status;
}

// --- asks --------------------------------------------------------------------------------------

function askSource(ask: Ask, state: ViewState): string {
  switch (ask.source.kind) {
    case "harness": {
      const card = state.sessions.get(ask.source.session);
      return card ? `${card.session.harness} in ${card.session.title ?? card.session.intent ?? card.session.cwd}` : "a session";
    }
    case "gate":
      return `the gate, on ${ask.source.action}`;
    case "brain":
      return "the brain";
  }
}

/**
 * A chip naming a live session, as the chat's do: it opens the session's tab (`select`). Rows
 * that name one keep it beside their words, shown in their place while the session is live.
 */
function sessionChip(className: string): HTMLButtonElement {
  const chip = el("button", `chip ref ${className}`);
  chip.type = "button";
  chip.dataset["action"] = "select";
  return chip;
}

/** Shows `chip` for the session `card` in place of `words`, or `words` alone when there is no live session to go to. */
function updateSessionChip(chip: HTMLElement, words: HTMLElement, card: SessionCard | undefined, title = "Open its tab"): void {
  setHidden(chip, card === undefined);
  setHidden(words, card !== undefined);
  if (!card) return;
  const who = sessionWho(card.session);
  setText(chip, who);
  setData(chip, "session", card.session.id);
  chip.title = chipTitle(who, title);
}

/** An ask is a form: a single choice answers on the click, a multiple one or a bare field on Answer (or Enter). */
function createAsk(): HTMLElement {
  const root = el("article", "ask");
  const form = el("form", "ask-form");
  form.append(el("div", "ask-options"), el("div", "ask-extra"));
  root.append(el("div", "ask-head"), el("pre", "ask-detail"), form, el("p", "ask-note"));
  const head = root.querySelector(".ask-head")!;
  head.append(el("span", "ask-title"), el("span", "ask-source"), sessionChip("ask-session"));
  return root;
}

/** What the user has picked and typed on an ask's form; `clicked` stands in for the pick on a single choice. */
export function draftOf(form: HTMLFormElement, clicked?: string): AskDraft {
  const selected = clicked !== undefined ? [clicked] : Array.from(form.querySelectorAll<HTMLInputElement>("input.ask-check:checked")).map((i) => i.dataset["option"] ?? "");
  const text = form.querySelector<HTMLInputElement>("input.ask-text")?.value ?? "";
  const remember = form.querySelector<HTMLSelectElement>("select.ask-remember")?.value;
  return { selected, text, ...(remember !== undefined ? { remember } : {}) };
}

/** The Answer button follows the draft: enabled once it makes an answer. */
export function refreshAskForm(form: HTMLFormElement, state: ViewState): void {
  const ask = form.dataset["ask"] ? state.asks.get(form.dataset["ask"]) : undefined;
  const button = form.querySelector<HTMLButtonElement>("button.ask-answer");
  if (!ask || !button) return;
  const answerable = ask.status === "open" && ask.answerableBy.includes("user") && state.connected;
  button.disabled = !answerable || answerParams(ask, draftOf(form)) === undefined;
}

/**
 * The pinned prompts, floating over the frame: a bar saying how many wait, which folds them
 * away to that one line (then naming what they ask) and back, and the prompts under it.
 */
function renderPinned(root: HTMLElement, asks: Ask[], state: ViewState, ui: UiState): void {
  let bar = root.querySelector<HTMLButtonElement>(".pinned-fold");
  let list = root.querySelector<HTMLElement>(".pinned-list");
  if (!bar || !list) {
    bar = actionButton("fold pinned-fold", "", "pinned-fold");
    bar.append(el("span", "pinned-count"), el("span", "pinned-titles"));
    list = el("div", "pinned-list");
    root.append(bar, list);
  }
  setHidden(root, asks.length === 0);
  const folded = ui.pinnedFolded === true;
  bar.setAttribute("aria-expanded", folded ? "false" : "true");
  bar.title = folded ? "Show the prompts" : "Fold the prompts away";
  setText(bar.querySelector(".pinned-count")!, `${asks.length} ${asks.length === 1 ? "prompt" : "prompts"} waiting`);
  const titles = bar.querySelector<HTMLElement>(".pinned-titles")!;
  setText(titles, folded ? asks.map((a) => a.title).join(" · ") : "");
  setHidden(titles, !folded);
  setHidden(list, folded);
  reconcile(list, asks, (a) => `ask:${a.id}`, createAsk, (node, ask) => updateAsk(node, ask, state));
  // The ask the user was answering gave way to the next one of its sequence: the focus follows.
  if (!folded && ui.pinnedFocus && !root.contains(document.activeElement)) {
    list.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
  }
}

function textPlaceholder(ask: Ask): string {
  if (ask.type === "permission") return "Add a note with your answer";
  if (ask.type === "input") return "Type your answer";
  return "Or type another answer";
}

function updateAsk(node: HTMLElement, ask: Ask, state: ViewState): void {
  setData(node, "ask", ask.id);
  setData(node, "status", ask.status);
  setData(node, "type", ask.type);
  setData(node, "multiple", ask.multiple ? "1" : "0");
  setText(node.querySelector(".ask-title")!, ask.title);
  const source = node.querySelector<HTMLElement>(".ask-source")!;
  setText(source, askSource(ask, state));
  // The session that asks, a press away; one only its terminal answers opens on the terminal, where the view can show it.
  const card = ask.source.kind === "harness" ? state.sessions.get(ask.source.session) : undefined;
  const chip = node.querySelector<HTMLElement>(".ask-session")!;
  const inTerminal = card !== undefined && ask.status === "open" && ask.answerableBy.length === 0 && sessionTerminal(state, card.session) !== undefined;
  updateSessionChip(chip, source, card, inTerminal ? "Answer it in its terminal" : "Open its tab");
  if (inTerminal) setData(chip, "mode", "terminal");
  else delete chip.dataset["mode"];
  const detail = node.querySelector<HTMLElement>(".ask-detail")!;
  setText(detail, ask.detail ?? "");
  setHidden(detail, !ask.detail);

  const answerable = ask.status === "open" && ask.answerableBy.includes("user") && state.connected;
  const form = node.querySelector<HTMLFormElement>("form.ask-form")!;
  setData(form, "ask", ask.id);
  const options = node.querySelector<HTMLElement>(".ask-options")!;
  const described = ask.options.some((o) => o.description);
  setData(options, "layout", described || ask.multiple ? "column" : "row");
  if (ask.multiple) {
    // Ticks live in the DOM: the reconcile keeps them across renders.
    reconcile(
      options,
      ask.options,
      (o) => `check:${o.id}`,
      () => {
        const label = el("label", "ask-choice");
        const check = el("input", "ask-check");
        check.type = "checkbox";
        const text = el("span", "option-text");
        text.append(el("span", "option-label"), el("span", "option-desc"));
        label.append(check, text);
        return label;
      },
      (l, o) => {
        const check = l.querySelector<HTMLInputElement>("input.ask-check")!;
        setData(check, "option", o.id);
        check.disabled = !answerable;
        setText(l.querySelector(".option-label")!, o.label);
        const desc = l.querySelector<HTMLElement>(".option-desc")!;
        setText(desc, o.description ?? "");
        setHidden(desc, !o.description);
      },
    );
  } else {
    reconcile(
      options,
      ask.options,
      (o) => `button:${o.id}`,
      () => {
        const button = el("button", "option");
        button.type = "button";
        button.append(el("span", "option-label"), el("span", "option-desc"));
        return button;
      },
      (b, o) => {
        const button = b as HTMLButtonElement;
        setData(button, "action", "answer");
        setData(button, "ask", ask.id);
        setData(button, "option", o.id);
        setData(button, "style", o.style ?? "default");
        setText(button.querySelector(".option-label")!, o.label);
        const desc = button.querySelector<HTMLElement>(".option-desc")!;
        setText(desc, o.description ?? "");
        setHidden(desc, !o.description);
        button.disabled = !answerable;
      },
    );
  }

  const extra = node.querySelector<HTMLElement>(".ask-extra")!;
  const wantText = ask.allowsText === true && ask.status === "open";
  const wantRemember = ask.source.kind === "gate" && ask.status === "open";
  const wantAnswer = ask.status === "open" && (ask.multiple === true || ask.options.length === 0);
  let text = extra.querySelector<HTMLInputElement>("input.ask-text");
  if (wantText && !text) {
    text = el("input", "ask-text");
    text.type = "text";
    text.dataset["ask"] = ask.id;
    extra.prepend(text);
  } else if (!wantText && text) {
    text.remove();
    text = null;
  }
  if (text) {
    if (text.placeholder !== textPlaceholder(ask)) text.placeholder = textPlaceholder(ask);
    text.disabled = !answerable;
  }
  let remember = extra.querySelector<HTMLSelectElement>("select.ask-remember");
  if (wantRemember && !remember) {
    remember = el("select", "ask-remember");
    remember.dataset["ask"] = ask.id;
    for (const [value, label] of [
      ["once", "Just this once"],
      ["session", "For this session"],
      ["always", "Always"],
    ]) {
      const o = el("option", undefined, label);
      o.value = value!;
      remember.append(o);
    }
    extra.append(remember);
  } else if (!wantRemember && remember) {
    remember.remove();
  }
  let answer = extra.querySelector<HTMLButtonElement>("button.ask-answer");
  if (wantAnswer && !answer) {
    answer = el("button", "ask-answer", "Answer");
    answer.type = "submit";
    extra.append(answer);
  } else if (!wantAnswer && answer) {
    answer.remove();
    answer = null;
  }
  if (answer) refreshAskForm(form, state);
  setHidden(extra, !wantText && !wantRemember && !wantAnswer);

  const note = node.querySelector<HTMLElement>(".ask-note")!;
  let noteText = "";
  if (ask.status === "open" && ask.answerableBy.length === 0) noteText = "Answer this one in the terminal.";
  else if (ask.status === "open" && !state.connected) noteText = "Reconnecting to cophylad before this can be answered.";
  else if (ask.status === "answered" && ask.answer) noteText = `Answered ${answerWords(ask, ask.answer)}`;
  else if (ask.status === "expired") noteText = "Expired unanswered.";
  else if (ask.status === "cancelled") noteText = "Closed: answered in the terminal or no longer needed.";
  setText(note, noteText);
  setHidden(note, noteText === "");
}

// --- tabs ------------------------------------------------------------------------------------

const TONE_WORD: Record<ReturnType<typeof tabTone>, string> = { ask: "waiting for you", active: "working", shell: "waiting on its shell", done: "done, not looked at yet", quiet: "idle" };

/**
 * A tab is one line: the agent's mark and the name. The mark is in colour or grey, with a
 * dot or none, by what the session is doing (`tabTone`), and sits in a black terminal window
 * when the session runs in a terminal tether holds; a bare terminal is that window with a
 * prompt in it.
 */
function createTab(): HTMLElement {
  const tab = el("button", "tab");
  tab.type = "button";
  tab.dataset["action"] = "select";
  const icon = el("span", "agent-icon");
  icon.setAttribute("role", "img");
  icon.append(el("span", "agent-mark"));
  tab.append(icon, el("span", "tab-title"));
  return tab;
}

function updateTab(tab: HTMLElement, card: SessionCard, state: ViewState, ui: UiState): void {
  const s = card.session;
  setData(tab, "session", s.id);
  setData(tab, "status", s.status);
  tab.setAttribute("aria-current", ui.selected === s.id ? "true" : "false");
  const tone = tabTone(card);
  const icon = tab.querySelector<HTMLElement>(".agent-icon")!;
  setData(icon, "harness", s.harness);
  setData(icon, "tone", tone);
  setData(icon, "tether", inTether(s) ? "1" : "0");
  const where = s.native.job !== undefined ? " background job" : inTether(s) ? " in a terminal" : "";
  const toneWord = tone === "ask" && s.waiting?.on === "user" && s.waiting.detail ? `${TONE_WORD.ask}: ${s.waiting.detail}` : TONE_WORD[tone];
  const words = `${s.harness}${where}, ${toneWord}`;
  icon.setAttribute("aria-label", words);
  setText(tab.querySelector(".tab-title")!, sessionLabel(s));
  const ws = workspaceName(state, s);
  tab.title = `${words}\n${ws ? `${ws}: ` : ""}${s.cwd}`;
}

/**
 * A folder's heading, its sessions' tabs, the tabs of the agent CLIs waiting there for their
 * first prompt, and the workspaces inside it, each a group like this one.
 */
function createGroup(): HTMLElement {
  const group = el("div", "tab-group");
  // The name folds the group's tabs and the groups inside it away and back.
  group.append(actionButton("tab-group-name", "", "group-fold"), el("div", "tab-group-list"), el("div", "tab-group-list tab-group-waiting"), el("div", "tab-subgroups"));
  return group;
}

function updateGroup(node: HTMLElement, group: SessionGroup, state: ViewState, ui: UiState): void {
  // Its own parts only: the groups inside it hold the same ones.
  const name = node.querySelector<HTMLElement>(":scope > .tab-group-name")!;
  const folded = ui.folded.has(group.key);
  setText(name, groupHeading(group.name, group.count, folded));
  name.title = group.path;
  setData(name, "group", group.key);
  name.setAttribute("aria-expanded", folded ? "false" : "true");
  const list = node.querySelector<HTMLElement>(":scope > .tab-group-list:not(.tab-group-waiting)")!;
  setHidden(list, folded);
  reconcile(list, group.sessions, (c) => c.session.id, createTab, (tab, c) => updateTab(tab, c, state, ui));
  const waiting = node.querySelector<HTMLElement>(":scope > .tab-group-waiting")!;
  setHidden(waiting, folded || group.terminals.length === 0);
  reconcile(waiting, group.terminals, (t) => t.id, createTermTab, (tab, t) => updateTermTab(tab, t, state, ui, false, true));
  const inner = node.querySelector<HTMLElement>(":scope > .tab-subgroups")!;
  setHidden(inner, folded || group.groups.length === 0);
  reconcile(inner, group.groups, (g) => g.key, createGroup, (n, g) => updateGroup(n, g, state, ui));
}

function createTermTab(): HTMLElement {
  const tab = createTab();
  tab.classList.add("term-tab");
  tab.dataset["action"] = "select-terminal";
  return tab;
}

/**
 * Terminals: a heading like a folder's, which folds them away the same way, and the bare
 * terminals' tabs; with more than one machine, under each machine's name, which folds its own.
 */
function renderTerminals(node: HTMLElement, terminals: Terminal[], state: ViewState, ui: UiState): void {
  setHidden(node, terminals.length === 0);
  const name = node.querySelector<HTMLElement>(":scope > .tab-group-name")!;
  const folded = ui.folded.has(TERMINALS_GROUP);
  setText(name, groupHeading("Terminals", terminals.length, folded));
  name.setAttribute("aria-expanded", folded ? "false" : "true");
  const groups = terminalGroups(state, terminals);
  const list = node.querySelector<HTMLElement>(":scope > .tab-terminals")!;
  setHidden(list, folded || groups !== undefined);
  reconcile(list, groups ? [] : terminals, (t) => t.id, createTermTab, (tab, t) => updateTermTab(tab, t, state, ui, true));
  const machines = node.querySelector<HTMLElement>(":scope > .terminal-machines")!;
  setHidden(machines, folded || groups === undefined);
  reconcile(machines, groups ?? [], (g) => g.node, createMachineGroup, (n, g) => updateMachineGroup(n, g, state, ui));
}

/** The fold key of the Terminals heading: no folder group's, which all hold a newline. */
const TERMINALS_GROUP = "terminals";
/** A machine's under Terminals. */
const machineGroupKey = (node: string): string => `${TERMINALS_GROUP}:${node}`;

/** One machine's terminals, headed by its name, which folds them as a folder's name does. */
function createMachineGroup(): HTMLElement {
  const group = el("div", "tab-group machine-group");
  group.append(actionButton("tab-group-name", "", "group-fold"), el("div", "tab-terminals"));
  return group;
}

function updateMachineGroup(node: HTMLElement, g: TerminalGroup, state: ViewState, ui: UiState): void {
  const key = machineGroupKey(g.node);
  const name = node.querySelector<HTMLElement>(":scope > .tab-group-name")!;
  const folded = ui.folded.has(key);
  setText(name, groupHeading(g.name, g.terminals.length, folded));
  setData(name, "group", key);
  name.title = g.node === state.client?.node ? `Terminals on ${g.name}, this computer` : `Terminals on ${g.name}`;
  name.setAttribute("aria-expanded", folded ? "false" : "true");
  const list = node.querySelector<HTMLElement>(":scope > .tab-terminals")!;
  setHidden(list, folded);
  // Under the machine's name, a tab need not say it again.
  reconcile(list, g.terminals, (t) => t.id, createTermTab, (tab, t) => updateTermTab(tab, t, state, ui, false));
}

/** A bare terminal's tab: under Terminals, or (`waiting`) in its folder's group, an agent CLI waiting for its first prompt. */
function updateTermTab(tab: HTMLElement, t: Terminal, state: ViewState, ui: UiState, withMachine: boolean, waiting = false): void {
  setData(tab, "terminal", t.id);
  setData(tab, "status", t.status === "running" ? "idle" : "ended");
  tab.setAttribute("aria-current", ui.terminal === t.id ? "true" : "false");
  const icon = tab.querySelector<HTMLElement>(".agent-icon")!;
  const mark = terminalMark(t);
  setData(icon, "harness", mark.harness);
  setData(icon, "tone", "quiet");
  // The same black window a session in a terminal has its mark in, with a prompt for a plain program.
  setData(icon, "tether", "1");
  icon.setAttribute("aria-label", t.status !== "running" ? `${mark.kind}, ended` : waiting ? `${mark.kind}, waiting for its first prompt` : mark.kind);
  setText(tab.querySelector(".tab-title")!, waiting ? waitingLabel(t) : terminalTabLabel(state, t, withMachine));
  tab.title = `${t.argv0} in ${t.cwd}${t.status === "running" ? "" : ", ended"}${t.windows > 0 ? `, ${t.windows} window${t.windows === 1 ? "" : "s"} open` : ""}`;
}

/** One paired phone: its name, whether it is here, and the button that forgets it. */
function createController(): HTMLElement {
  const row = el("div", "controller");
  const main = el("span", "controller-main");
  main.append(el("span", "controller-name"), el("span", "controller-sub"));
  const revoke = el("button", "controller-revoke", "Forget");
  revoke.type = "button";
  revoke.dataset["action"] = "controller-revoke";
  row.append(el("span", "dot"), main, revoke);
  return row;
}

function updateController(node: HTMLElement, controller: Controller, state: ViewState): void {
  setData(node, "controller", controller.id);
  setData(node.querySelector<HTMLElement>(".dot")!, "status", controller.connected ? "connected" : "gone");
  setText(node.querySelector(".controller-name")!, controller.name);
  const now = Date.now();
  const access = accessWords(controller.access, state);
  setText(node.querySelector(".controller-sub")!, [controllerWords(controller, now), access === "everything" ? "" : access, endWords(controller.expiresAt, now) ?? ""].filter(Boolean).join(" · "));
  const revoke = node.querySelector<HTMLButtonElement>(".controller-revoke")!;
  revoke.dataset["controller"] = controller.id;
  revoke.disabled = !state.connected;
}

// --- nodes: one card per machine, and the spend ---------------------------------------------

function createOwner(): HTMLElement {
  const row = el("div", "node-session");
  row.append(el("span", "node-session-name"), el("span", "node-session-cpu"), el("span", "node-session-mem"));
  return row;
}

function updateOwner(node: HTMLElement, owner: OwnerRow): void {
  setData(node, "kind", owner.kind);
  setText(node.querySelector(".node-session-name")!, owner.label);
  setText(node.querySelector(".node-session-cpu")!, percentWords(owner.cpu));
  setText(node.querySelector(".node-session-mem")!, bytesWords(owner.memory));
}

/** A fold's switch: its label, and the arrow the stylesheet draws from `aria-expanded`. */
function createFold(className: string): HTMLButtonElement {
  const b = actionButton(`fold ${className}`, "", "toggle");
  b.append(el("span", "fold-label"));
  return b;
}

function updateFold(b: HTMLElement, key: string, label: string, open: boolean): void {
  setData(b, "target", key);
  setText(b.querySelector(".fold-label")!, label);
  b.setAttribute("aria-expanded", open ? "true" : "false");
}

/**
 * A machine's card in Devices: its name the user sets, with what it is beside it (this
 * computer, the primary, hands) and Rename; a line of facts; its readings, and its processes
 * folded until the user opens them; its desktop; and at its foot Make primary, Restart and
 * Remove or Leave, each asked in place.
 */
function createNodeCard(): HTMLElement {
  const card = el("article", "node-card");
  const head = el("header", "node-head");
  const title = el("div", "node-title");
  const line = el("div", "node-name-line");
  line.append(el("h3", "node-name"), el("span", "node-tags"));
  title.append(line, createRenameForm(), el("p", "node-facts"));
  head.append(el("span", "dot"), title, actionButton("node-rename", "Rename", "node-rename"));
  const foot = el("footer", "node-foot");
  foot.append(createNodePromote(), createRestart(), createNodeGrant());
  card.append(head, el("div", "node-bars"), createFold("node-processes"), el("div", "node-sessions"), createRemote(), foot);
  return card;
}

/** The name, the user's to set: a field in place of it, with Save and Cancel. */
function createRenameForm(): HTMLFormElement {
  const form = el("form", "node-rename-form");
  const input = el("input", "node-rename-input");
  input.type = "text";
  input.maxLength = 64;
  input.required = true;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "the machine's name");
  const save = el("button", "node-rename-save", "Save");
  save.type = "submit";
  form.append(input, save, actionButton("node-rename-cancel", "Cancel", "node-rename-cancel"));
  return form;
}

/** The role, the user's to choose: Make primary, asked in place. */
function createNodePromote(): HTMLElement {
  const block = el("div", "node-choose");
  const buttons = el("div", "node-choose-buttons");
  buttons.append(actionButton("node-promote", "Make primary", "node-promote"), actionButton("node-promote-confirm", "Make primary", "node-promote-confirm"), actionButton("node-promote-cancel", "Cancel", "node-promote-cancel"));
  block.append(el("p", "node-choose-ask"), buttons);
  return block;
}

/** The card's head: the name, or the field renaming it; what the machine is; its facts; and Rename. */
function updateNodeHead(node: HTMLElement, card: NodeCard, state: ViewState, ui: UiState): void {
  const renaming = ui.renaming?.node === card.node.id ? ui.renaming : undefined;
  const name = node.querySelector<HTMLElement>(".node-name")!;
  setText(name, card.node.name);
  setHidden(node.querySelector<HTMLElement>(".node-name-line")!, renaming !== undefined);
  const facts = machineFacts(state, card.node, Date.now());
  reconcile(
    node.querySelector<HTMLElement>(".node-tags")!,
    facts.tags,
    (t) => t.key,
    () => el("span", "node-tag"),
    (tag, t) => {
      setData(tag, "tag", t.key);
      setText(tag, t.label);
      tag.title = t.title;
    },
  );
  setText(node.querySelector(".node-facts")!, facts.line);
  const form = node.querySelector<HTMLFormElement>(".node-rename-form")!;
  setHidden(form, !renaming);
  form.dataset["node"] = card.node.id;
  const input = form.querySelector<HTMLInputElement>(".node-rename-input")!;
  // the field starts from the name once, as it opens, and is the user's after
  if (renaming && form.dataset["open"] !== card.node.id) {
    input.value = card.node.name;
    form.dataset["open"] = card.node.id;
  }
  if (!renaming) delete form.dataset["open"];
  input.disabled = renaming?.busy === true;
  const save = form.querySelector<HTMLButtonElement>(".node-rename-save")!;
  setText(save, renaming?.busy ? "Saving…" : "Save");
  save.disabled = !state.connected || renaming?.busy === true;
  const rename = node.querySelector<HTMLButtonElement>(".node-rename")!;
  setHidden(rename, !renamable(state, card.node) || renaming !== undefined);
  rename.dataset["node"] = card.node.id;
  rename.title = `Name ${card.node.name} as you call it`;
  rename.disabled = !state.connected;
}

function updateNodePromote(block: HTMLElement, card: NodeCard, state: ViewState, ui: UiState): void {
  const offer = promoteOffer(state, card.node);
  const promoting = ui.promoting?.node === card.node.id ? ui.promoting : undefined;
  setHidden(block, !offer && !promoting);
  setData(block, "asking", promoting ? "1" : "0");
  if (block.hidden) return;
  const ask = block.querySelector<HTMLElement>(".node-choose-ask")!;
  setText(ask, promoting?.phase === "asking" && offer ? offer.ask : "");
  setHidden(ask, promoting?.phase !== "asking");
  const start = block.querySelector<HTMLButtonElement>(".node-promote")!;
  setHidden(start, !offer || promoting !== undefined);
  start.dataset["node"] = card.node.id;
  start.title = offer?.title ?? "";
  start.disabled = !state.connected;
  const confirm = block.querySelector<HTMLButtonElement>(".node-promote-confirm")!;
  setHidden(confirm, promoting === undefined);
  confirm.dataset["node"] = card.node.id;
  setText(confirm, promoting?.phase === "promoting" ? "Making it the primary…" : "Make primary");
  confirm.disabled = !state.connected || promoting?.phase === "promoting";
  setHidden(block.querySelector<HTMLElement>(".node-promote-cancel")!, promoting?.phase !== "asking");
}

/** A machine's grant at its card's foot: Remove, asked in place; on this node, once it joined another, Leave. When it ends and whether to invite it again are in its head. */
function createNodeGrant(): HTMLElement {
  const block = el("div", "node-grant");
  const buttons = el("div", "node-grant-buttons");
  buttons.append(
    actionButton("node-remove", "Remove", "node-remove"),
    actionButton("node-remove-confirm", "Remove", "node-remove-confirm"),
    actionButton("node-leave", "Leave", "node-leave"),
    actionButton("node-leave-confirm", "Leave", "node-leave-confirm"),
    actionButton("node-grant-cancel", "Cancel", "node-grant-cancel"),
  );
  block.append(el("p", "node-grant-ask"), buttons);
  return block;
}

function updateNodeGrant(block: HTMLElement, card: NodeCard, state: ViewState, ui: UiState, words: ReturnType<typeof nodeGrantWords>): void {
  const self = card.node.id === state.node;
  const leaving = self && membershipOffer(state) === "leave";
  const removing = ui.removing?.node === card.node.id ? ui.removing : undefined;
  setHidden(block, !(words.removable || leaving));
  setData(block, "asking", removing !== undefined || (leaving && ui.leaving !== undefined) ? "1" : "0");
  if (block.hidden) return;
  const asking = removing?.phase === "asking" || (leaving && ui.leaving === "asking");
  const ask = block.querySelector<HTMLElement>(".node-grant-ask")!;
  const primary = [...state.nodes.values()].find((n) => n.role === "primary")?.name ?? "the primary";
  setText(ask, removing ? words.removeWords : leaving ? `Leave ${primary}? It can no longer see or use this computer, and this computer forgets it.` : "");
  setHidden(ask, !asking);
  const remove = block.querySelector<HTMLButtonElement>(".node-remove")!;
  setHidden(remove, !words.removable || removing !== undefined);
  remove.dataset["node"] = card.node.id;
  remove.title = `Take ${card.node.name}'s key away: it can no longer reach this node`;
  const confirm = block.querySelector<HTMLButtonElement>(".node-remove-confirm")!;
  setHidden(confirm, removing === undefined);
  confirm.dataset["node"] = card.node.id;
  setText(confirm, removing?.phase === "removing" ? "Removing…" : "Remove");
  confirm.disabled = !state.connected || removing?.phase === "removing";
  const leave = block.querySelector<HTMLButtonElement>(".node-leave")!;
  setHidden(leave, !leaving || ui.leaving !== undefined);
  leave.title = `Stop sharing this computer with ${primary}`;
  const leaveConfirm = block.querySelector<HTMLButtonElement>(".node-leave-confirm")!;
  setHidden(leaveConfirm, !leaving || ui.leaving === undefined);
  setText(leaveConfirm, ui.leaving === "leaving" ? "Leaving…" : "Leave");
  leaveConfirm.disabled = !state.connected || ui.leaving === "leaving";
  setHidden(block.querySelector<HTMLElement>(".node-grant-cancel")!, !asking);
  for (const b of [remove, leave]) b.disabled = !state.connected;
}

function updateNodeCard(node: HTMLElement, card: NodeCard, state: ViewState, ui: UiState): void {
  setData(node, "node", card.node.id);
  setData(node, "status", card.node.status);
  setData(node.querySelector<HTMLElement>(".dot")!, "status", card.node.status === "online" ? "connected" : "gone");
  updateNodeHead(node, card, state, ui);
  const grant = nodeGrantWords(state, card.node, Date.now());
  // An offline machine has no readings: its bars would only say so.
  const online = card.node.status === "online";
  const bars = node.querySelector<HTMLElement>(".node-bars")!;
  setHidden(bars, !online);
  reconcile(bars, online ? card.bars : [], (b) => b.label, createMeter, (meter, b) => updateMeter(meter, barMeter(b)));
  const key = processesKey(card.node.id);
  const open = ui.expanded.has(key);
  const fold = node.querySelector<HTMLElement>(".node-processes")!;
  updateFold(fold, key, `Running (${card.owners.length})`, open);
  setHidden(fold, card.owners.length === 0);
  const owners = node.querySelector<HTMLElement>(".node-sessions")!;
  setHidden(owners, !open);
  reconcile(owners, open ? card.owners : [], (o) => o.key, createOwner, updateOwner);
  updateRemote(node.querySelector<HTMLElement>(".node-remote")!, selectRemote(state, card.node), state, ui);
  const foot = node.querySelector<HTMLElement>(".node-foot")!;
  updateNodePromote(foot.querySelector<HTMLElement>(".node-choose")!, card, state, ui);
  updateRestart(foot.querySelector<HTMLElement>(".node-restart")!, card, state, ui);
  updateNodeGrant(foot.querySelector<HTMLElement>(".node-grant")!, card, state, ui, grant);
  setHidden(foot, [...foot.children].every((c) => (c as HTMLElement).hidden));
}

// --- restarting cophylad on this node ---------------------------------------------------------

function createRestart(): HTMLElement {
  const block = el("div", "node-restart");
  const buttons = el("div", "node-restart-buttons");
  buttons.append(actionButton("node-restart-start", "Restart cophylad", "node-restart"), actionButton("node-restart-force", "Restart anyway", "node-restart-force"), actionButton("node-restart-cancel", "Cancel", "node-restart-cancel"));
  block.append(el("p", "node-restart-busy"), buttons);
  return block;
}

/** The node this app is connected to: Restart, or, when the node is busy, what it would cut off and Restart anyway. */
function updateRestart(block: HTMLElement, card: NodeCard, state: ViewState, ui: UiState): void {
  const shown = restartable(state, card.node);
  setHidden(block, !shown);
  if (!shown) return;
  const r = ui.restart;
  const refused = r?.phase === "busy";
  setData(block, "asking", refused ? "1" : "0");
  const start = block.querySelector<HTMLButtonElement>(".node-restart-start")!;
  setHidden(start, refused);
  setText(start, r === undefined ? "Restart cophylad" : "Restarting…");
  start.title = "Stop the daemon on this machine and start it again";
  start.disabled = !state.connected || r !== undefined;
  const busy = block.querySelector<HTMLElement>(".node-restart-busy")!;
  setHidden(busy, !refused);
  setText(busy, refused ? restartWords(r.reasons ?? []) : "");
  const force = block.querySelector<HTMLButtonElement>(".node-restart-force")!;
  setHidden(force, !refused);
  force.disabled = !state.connected;
  setHidden(block.querySelector<HTMLElement>(".node-restart-cancel")!, !refused);
}

// --- a node's desktop: its host, who views it, and the ways in ------------------------------

function actionButton(className: string, text: string, action: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.dataset["action"] = action;
  return b;
}

/**
 * A machine's desktop in Devices: its state with the switch that shares it, then the ways in
 * from here (Connect, Beside, Moonlight's settings), who can view it, a device a line, and the
 * ways to pair one more: a viewer's PIN, or a code for Artemis on a phone.
 */
function createRemote(): HTMLElement {
  const block = el("section", "node-remote");
  const head = el("div", "remote-head");
  // Sharing this desktop: on, tried again, or off; the note says who can still connect, or who may have to approve the installer.
  const share = el("div", "remote-share");
  share.append(actionButton("remote-share-on", "Share this desktop", "remote-share"), actionButton("remote-retry", "Retry", "remote-share"), actionButton("remote-share-off", "Stop sharing", "remote-unshare"));
  head.append(el("h4", "remote-label", "Desktop"), el("span", "remote-words"), share);
  const connect = actionButton("remote-connect", "Connect", "remote-open");
  connect.title = "Open this desktop in Moonlight, in a window of its own";
  const beside = actionButton("remote-beside", "Beside", "remote-beside");
  beside.title = "Show this desktop beside the pane";
  // Moonlight's own window, where its settings are: once saved there, Connect follows them.
  const moonlight = actionButton("remote-moonlight", "Moonlight settings", "remote-moonlight");
  moonlight.title = "Moonlight's own window: once you save its settings, Connect uses them instead of Cophyla's picks";
  const viewing = el("div", "remote-viewing");
  viewing.append(connect, beside, moonlight);
  const who = el("div", "remote-who");
  who.append(el("p", "remote-who-head", "Who can view it"), el("div", "remote-viewers"));
  const actions = el("div", "remote-actions");
  const pinStart = actionButton("remote-pin-start", "Pair a viewer by PIN", "remote-pin");
  pinStart.title = "Moonlight on another device shows a PIN as it is added: type it here";
  const inviteStart = actionButton("remote-invite-start", "Pair Artemis on a phone", "remote-invite");
  inviteStart.title = "A code for the Artemis app on a phone, to view this desktop there";
  actions.append(pinStart, inviteStart);
  // The PIN a viewer shows when it is added: Moonlight on another machine, or Artemis without an invite.
  const form = el("form", "remote-pin-form");
  const pin = el("input", "remote-pin-code");
  pin.type = "text";
  pin.inputMode = "numeric";
  pin.autocomplete = "off";
  pin.maxLength = 4;
  pin.pattern = "\\d{4}";
  pin.required = true;
  pin.placeholder = "PIN";
  pin.setAttribute("aria-label", "the PIN the viewer shows");
  const name = el("input", "remote-pin-name");
  name.type = "text";
  name.autocomplete = "off";
  name.maxLength = 40;
  name.placeholder = "its name";
  name.setAttribute("aria-label", "a name for the viewer");
  const submit = el("button", "remote-pin-submit", "Pair");
  submit.type = "submit";
  form.append(pin, name, submit, actionButton("remote-pin-cancel", "Cancel", "remote-pin-cancel"));
  const invite = el("div", "remote-invite");
  const buttons = el("div", "remote-invite-buttons");
  buttons.append(actionButton("remote-invite-open", "Open in Artemis", "remote-invite-open"), actionButton("remote-invite-done", "Done", "remote-invite-close"));
  invite.append(el("p", "remote-invite-hint", "In Artemis on the phone, add this PC and pair with:"), el("p", "remote-invite-code"), el("p", "remote-invite-pass"), el("p", "remote-invite-left"), buttons);
  block.append(head, el("p", "remote-note"), viewing, who, actions, form, invite);
  return block;
}

/** One device that can view a desktop: what it is, how it views it or that it watches now, and Forget. */
function createViewer(): HTMLElement {
  const row = el("div", "remote-viewer");
  const main = el("div", "remote-viewer-main");
  main.append(el("span", "remote-viewer-name"), el("span", "remote-viewer-sub"));
  row.append(el("span", "who-mark"), main, actionButton("remote-viewer-forget", "Forget", "remote-revoke"));
  return row;
}

function updateViewer(node: HTMLElement, row: ViewerRow, remote: RemoteCard, state: ViewState): void {
  setData(node, "kind", row.kind);
  setData(node, "connected", row.watching ? "1" : "0");
  node.title = row.title;
  setText(node.querySelector(".remote-viewer-name")!, row.name);
  setText(node.querySelector(".remote-viewer-sub")!, row.words);
  const forget = node.querySelector<HTMLButtonElement>(".remote-viewer-forget")!;
  // A browser's session ends; a paired app is unpaired and has to pair again; off, a pairing is revoked.
  setText(forget, row.forget);
  forget.title = row.forget === "End" ? `End ${row.name}'s session` : `${row.name} can no longer view this desktop until it pairs again`;
  forget.dataset["node"] = remote.node;
  forget.dataset["viewers"] = row.ids.join(",");
  forget.disabled = !state.connected;
}

/**
 * Connect and Beside onto a node's desktop, on its card and on its line in the rail: shown
 * where this client can, Connect waiting while a viewer pairs, Beside while the desktop opens
 * or shows on this tab already; on another tab, Beside shows it here too.
 */
function updateViewButtons(connect: HTMLButtonElement, beside: HTMLButtonElement, node: NodeId, canConnect: boolean, canBeside: boolean, state: ViewState, ui: UiState): void {
  const opening = ui.opening.has(node);
  setHidden(connect, !canConnect);
  setText(connect, opening ? "Connecting…" : "Connect");
  connect.dataset["node"] = node;
  connect.disabled = !state.connected || opening;
  const view = ui.remoteView?.node === node ? ui.remoteView : undefined;
  const shownHere = view !== undefined && remoteHere(view, viewerTab(ui.selected, ui.terminal) ?? "chat", tabNode(state, ui.selected, ui.terminal));
  setHidden(beside, !canBeside);
  setText(beside, view?.phase === "opening" ? "Opening…" : "Beside");
  beside.dataset["node"] = node;
  beside.disabled = !state.connected || (shownHere && view.phase !== "failed");
}

/**
 * The desktop block: hidden when the node has no host to show; Share while it is off, Stop
 * sharing (and Retry) while it is on; Connect, Beside, Moonlight's settings, the PIN form and
 * the phone code while it serves, opening in place; who can view it, a device a line.
 */
function updateRemote(block: HTMLElement, remote: RemoteCard | undefined, state: ViewState, ui: UiState): void {
  setHidden(block, remote === undefined);
  if (!remote) return;
  setData(block, "status", remote.host.status);
  setData(block, "streaming", remote.streaming ? "1" : "0");
  const words = block.querySelector<HTMLElement>(".remote-words")!;
  setText(words, desktopWords(remote));
  words.title = `${remote.host.kind === "none" ? "no host" : remote.host.kind} · ${remote.words}`;
  const note = block.querySelector<HTMLElement>(".remote-note")!;
  setText(note, remote.note ?? "");
  setHidden(note, remote.note === undefined);
  updateViewButtons(block.querySelector<HTMLButtonElement>(".remote-connect")!, block.querySelector<HTMLButtonElement>(".remote-beside")!, remote.node, remote.connect, remote.beside, state, ui);
  const moonlight = block.querySelector<HTMLButtonElement>(".remote-moonlight")!;
  setHidden(moonlight, !remote.settings);
  moonlight.dataset["node"] = remote.node;
  moonlight.disabled = !state.connected;
  setHidden(block.querySelector<HTMLElement>(".remote-viewing")!, !remote.connect && !remote.beside && !remote.settings);
  const busy = ui.sharing.get(remote.node);
  const shareOn = block.querySelector<HTMLButtonElement>(".remote-share-on")!;
  const retry = block.querySelector<HTMLButtonElement>(".remote-retry")!;
  const shareOff = block.querySelector<HTMLButtonElement>(".remote-share-off")!;
  setHidden(shareOn, !remote.share);
  setText(shareOn, busy === "on" ? "Sharing…" : "Share this desktop");
  setHidden(retry, !remote.retry);
  setText(retry, busy === "on" ? "Retrying…" : "Retry");
  setHidden(shareOff, !remote.stop);
  setText(shareOff, busy === "off" ? "Stopping…" : "Stop sharing");
  for (const b of [shareOn, retry, shareOff]) {
    b.dataset["node"] = remote.node;
    b.disabled = !state.connected || busy !== undefined;
  }
  const rows = viewerRows(state, remote, Date.now());
  setHidden(block.querySelector<HTMLElement>(".remote-who")!, rows.length === 0);
  reconcile(block.querySelector<HTMLElement>(".remote-viewers")!, rows, (r) => r.key, createViewer, (node, r) => updateViewer(node, r, remote, state));

  const pinOpen = state.remotePin === remote.node && remote.pair;
  const invite = state.remoteInvite?.node === remote.node ? state.remoteInvite : undefined;
  const pinStart = block.querySelector<HTMLButtonElement>(".remote-pin-start")!;
  const inviteStart = block.querySelector<HTMLButtonElement>(".remote-invite-start")!;
  const noPin = !remote.pair || pinOpen;
  const noInvite = !remote.invite || invite !== undefined;
  setHidden(pinStart, noPin);
  setHidden(inviteStart, noInvite);
  for (const b of [pinStart, inviteStart]) {
    b.dataset["node"] = remote.node;
    b.disabled = !state.connected;
  }
  setHidden(block.querySelector<HTMLElement>(".remote-actions")!, noPin && noInvite);
  const form = block.querySelector<HTMLFormElement>(".remote-pin-form")!;
  setHidden(form, !pinOpen);
  form.dataset["node"] = remote.node;
  form.querySelector<HTMLButtonElement>(".remote-pin-submit")!.disabled = !state.connected;

  const panel = block.querySelector<HTMLElement>(".remote-invite")!;
  setHidden(panel, invite === undefined);
  if (!invite) return;
  const w = inviteWords(invite, Date.now());
  setText(panel.querySelector(".remote-invite-code")!, w.code);
  const pass = panel.querySelector<HTMLElement>(".remote-invite-pass")!;
  setText(pass, `passphrase ${w.passphrase}`);
  setHidden(pass, w.passphrase === "");
  const left = panel.querySelector<HTMLElement>(".remote-invite-left")!;
  setText(left, w.expired ? "that code has run out" : w.left ? `good for ${w.left}` : "");
  setHidden(left, !w.expired && w.left === "");
  // The link opens the app on the phone this view runs on; the desktop has nothing to open it with.
  setHidden(panel.querySelector<HTMLElement>(".remote-invite-open")!, state.client?.kind !== "controller" || !invite.link || w.expired);
}

/** Devices' computers: a card per machine, then Add a computer, Join another computer, and the invites still open. */
function renderComputers(section: HTMLElement, state: ViewState, ui: UiState): void {
  setHidden(section, state.nodes.size === 0);
  if (section.hidden) return;
  reconcile(section.querySelector<HTMLElement>(".node-cards")!, selectNodes(state), (c) => c.node.id, createNodeCard, (node, c) => updateNodeCard(node, c, state, ui));
  renderNodeTools(section.querySelector<HTMLElement>(".node-tools")!, state, ui);
}

/** A metered part of the plan as a meter: its name, used of its cap. */
function accountMeter(bar: AccountBar): StatusMeter {
  const label = bar.label.charAt(0).toUpperCase() + bar.label.slice(1);
  return { key: bar.label, label, percent: bar.percent, words: bar.words, level: bar.percent >= 95 ? "critical" : bar.percent >= 80 ? "warn" : "normal", title: `${label}: ${bar.words} this period` };
}

/** The backup row's passphrase form: the passphrase, typed twice when it is being set, and what the submit does. */
function createBackupForm(): HTMLFormElement {
  const form = el("form", "backup-form");
  const pass = el("input", "backup-pass");
  pass.type = "password";
  pass.name = "passphrase";
  pass.autocomplete = "off";
  pass.required = true;
  pass.minLength = 8;
  pass.placeholder = "passphrase";
  pass.setAttribute("aria-label", "the backup's passphrase");
  const again = el("input", "backup-pass-again");
  again.type = "password";
  again.name = "again";
  again.autocomplete = "off";
  again.placeholder = "again";
  again.setAttribute("aria-label", "the passphrase again");
  const submit = el("button", "backup-submit", "Turn on");
  submit.type = "submit";
  form.append(el("p", "backup-form-hint"), pass, again, submit, actionButton("backup-cancel", "Cancel", "backup-cancel"), actionButton("backup-replace", "Start over instead…", "backup-replace"));
  return form;
}

/**
 * The account card in Devices: signed out with a Sign in button; a login open with the
 * address, the code and a countdown; signed in with the link's dot, the plan, the usage bars,
 * the backup row, direct connections (a line and a switch per node) and Sign out.
 */
function renderAccount(root: HTMLElement, state: ViewState, ui: UiState): void {
  if (!root.querySelector(".account-head")) {
    const head = el("div", "account-head");
    head.append(el("span", "dot"), el("span", "account-title"), el("span", "account-id"));
    const signIn = actionButton("account-login", "Sign in", "account-login");
    const signOut = actionButton("account-logout", "Sign out", "account-logout");
    const open = actionButton("account-open", "Open the page", "account-open");
    const close = actionButton("account-login-close", "Cancel", "account-login-close");
    const panel = el("div", "account-login-panel");
    panel.append(el("p", "account-url"), el("p", "account-code"), el("p", "account-left"), open, close);
    const backup = el("div", "backup-row");
    const backupHead = el("div", "backup-head");
    backupHead.append(el("span", "backup-label", "Backup"), el("span", "backup-words"));
    const buttons = el("div", "backup-buttons");
    buttons.append(
      actionButton("backup-on", "Turn on…", "backup-on"),
      actionButton("backup-restore", "Restore…", "backup-restore"),
      actionButton("backup-takeover", "Take over…", "backup-on"),
      actionButton("backup-off", "Turn off", "backup-off"),
    );
    const progress = el("div", "backup-progress");
    progress.append(el("div", "backup-progress-fill"));
    backup.append(backupHead, progress, buttons, createBackupForm());
    const direct = el("div", "direct-row");
    const directHead = el("div", "direct-head");
    directHead.append(el("span", "direct-label", "Direct"), el("span", "direct-words"));
    direct.append(directHead, el("div", "direct-lines"));
    const details = el("div", "account-details");
    details.append(el("div", "account-bars"), backup, direct, signOut);
    // the plan in a line, or what signing in would change, under the head whatever the kind
    root.append(head, el("p", "account-sub"), details, panel, signIn);
  }
  setHidden(root, !state.scopes.includes("account"));
  const card = selectAccount(state);
  renderBackup(root.querySelector<HTMLElement>(".backup-row")!, card.backup, state, ui);
  renderDirect(root.querySelector<HTMLElement>(".direct-row")!, card.direct, state, ui);
  setData(root, "kind", card.kind);
  setText(root.querySelector(".account-title")!, card.title);
  const id = root.querySelector<HTMLElement>(".account-id")!;
  setText(id, card.id ?? "");
  setHidden(id, card.id === undefined);
  id.title = "Your account's id, as support knows it";
  setHidden(root.querySelector<HTMLElement>(".account-details")!, card.kind !== "in");
  const dot = root.querySelector<HTMLElement>(".dot")!;
  setHidden(dot, card.kind !== "in");
  setData(dot, "status", card.connected ? "connected" : "gone");
  dot.title = card.connected ? "linked to the server" : "the server link is down";
  setText(root.querySelector(".account-sub")!, card.sub);
  reconcile(root.querySelector<HTMLElement>(".account-bars")!, card.bars, (b) => b.label, createMeter, (meter, b) => updateMeter(meter, accountMeter(b)));
  const panel = root.querySelector<HTMLElement>(".account-login-panel")!;
  setHidden(panel, card.kind !== "login");
  if (state.login) {
    const words = loginWords(state.login, Date.now());
    setText(panel.querySelector(".account-url")!, state.login.verificationUrl.replace(/\?code=.*$/, ""));
    setText(panel.querySelector(".account-code")!, words.code);
    setText(panel.querySelector(".account-left")!, words.expired ? "that code has run out" : `good for ${words.left}`);
  }
  const signIn = root.querySelector<HTMLButtonElement>(".account-login")!;
  setHidden(signIn, card.kind !== "out");
  signIn.disabled = !state.connected;
  const signOut = root.querySelector<HTMLButtonElement>(".account-logout")!;
  setHidden(signOut, card.kind !== "in");
  signOut.disabled = !state.connected;
}

/** The backup row: its words, the buttons its kind offers, the passphrase form when open, a restore's progress. */
function renderBackup(row: HTMLElement, backup: BackupRow | undefined, state: ViewState, ui: UiState): void {
  setHidden(row, backup === undefined);
  if (!backup) return;
  setData(row, "kind", backup.kind);
  setData(row, "state", backup.state ?? "");
  setText(row.querySelector(".backup-words")!, backup.words);
  const busy = ui.backupBusy === true || !state.connected;
  const formOpen = ui.backupForm !== undefined;
  const on = row.querySelector<HTMLButtonElement>(".backup-on")!;
  setHidden(on, !(backup.kind === "off" || backup.kind === "available") || formOpen);
  on.disabled = busy;
  const restore = row.querySelector<HTMLButtonElement>(".backup-restore")!;
  setHidden(restore, backup.kind !== "available" || formOpen);
  restore.disabled = busy;
  const takeover = row.querySelector<HTMLButtonElement>(".backup-takeover")!;
  setHidden(takeover, !(backup.kind === "on" && backup.state === "conflict") || formOpen);
  takeover.disabled = busy;
  const off = row.querySelector<HTMLButtonElement>(".backup-off")!;
  setHidden(off, backup.kind !== "on" || formOpen);
  off.disabled = busy;
  const progress = row.querySelector<HTMLElement>(".backup-progress")!;
  setHidden(progress, backup.kind !== "restoring");
  progress.querySelector<HTMLElement>(".backup-progress-fill")!.style.width = `${backup.progress ?? 0}%`;
  const form = row.querySelector<HTMLFormElement>(".backup-form")!;
  const mode = ui.backupForm;
  setHidden(form, mode === undefined || backup.kind === "restoring" || backup.kind === "plan");
  if (mode === undefined) return;
  setData(form, "mode", mode);
  const again = form.querySelector<HTMLInputElement>(".backup-pass-again")!;
  setHidden(again, mode === "restore");
  again.required = mode !== "restore";
  const hint = form.querySelector<HTMLElement>(".backup-form-hint")!;
  const submit = form.querySelector<HTMLButtonElement>(".backup-submit")!;
  if (mode === "restore") {
    setText(hint, "The passphrase the backup was made with. What is on this computer is replaced by it.");
    setText(submit, "Restore");
  } else if (mode === "replace") {
    setText(hint, "A new passphrase. The backup on the server is dropped and made again from this computer.");
    setText(submit, "Start over");
  } else if (backup.kind === "available" || backup.state === "conflict") {
    setText(hint, "The backup's passphrase: this computer carries it on from here.");
    setText(submit, backup.state === "conflict" ? "Take over" : "Turn on");
  } else {
    setText(hint, "A passphrase only you know: the backup cannot be read without it, and it cannot be recovered.");
    setText(submit, "Turn on");
  }
  submit.disabled = busy;
  // turning on while the server holds a backup: the other way is to drop it and start over
  setHidden(form.querySelector<HTMLElement>(".backup-replace")!, !(mode === "enable" && backup.kind === "available" && backup.canReplace));
}

/** The direct connections row: the plan's refusal, or each node's line with its switch; the node's name only when there are several. */
function renderDirect(row: HTMLElement, direct: DirectRow | undefined, state: ViewState, ui: UiState): void {
  setHidden(row, direct === undefined);
  if (!direct) return;
  setData(row, "kind", direct.kind);
  setText(row.querySelector(".direct-words")!, direct.kind === "plan" || direct.lines.length === 0 ? direct.words : "");
  const named = direct.lines.length > 1;
  reconcile(row.querySelector<HTMLElement>(".direct-lines")!, direct.lines, (l) => l.node, createDirectLine, (e, l) => updateDirectLine(e, l, named, !state.connected || ui.directBusy?.has(l.node) === true));
}

function createDirectLine(): HTMLElement {
  const line = el("div", "direct-line");
  line.append(el("span", "direct-name"), el("span", "direct-state"), actionButton("direct-switch", "", "direct-switch"));
  return line;
}

function updateDirectLine(line: HTMLElement, l: DirectLine, named: boolean, busy: boolean): void {
  setData(line, "state", l.state);
  const name = line.querySelector<HTMLElement>(".direct-name")!;
  setHidden(name, !named);
  setText(name, l.name);
  setText(line.querySelector(".direct-state")!, l.words);
  const button = line.querySelector<HTMLButtonElement>(".direct-switch")!;
  button.dataset["node"] = l.node;
  button.dataset["on"] = l.on ? "1" : "0";
  setText(button, l.on ? "Turn off" : "Turn on");
  button.disabled = busy;
}

// --- grants: the invites a machine or a phone is let in with ---------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** An invite's QR code as an SVG that scales to its box: dark modules on white, the quiet zone within. */
function qrSvg(text: string, label: string): SVGSVGElement {
  const modules = qrModules(text);
  const n = modules.length;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const light = document.createElementNS(SVG_NS, "rect");
  light.setAttribute("width", String(n));
  light.setAttribute("height", String(n));
  light.setAttribute("fill", "#fff");
  const dark = document.createElementNS(SVG_NS, "path");
  dark.setAttribute("d", qrPath(modules));
  dark.setAttribute("fill", "#000");
  svg.append(light, dark);
  return svg;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = el("option", undefined, label);
  o.value = value;
  return o;
}

function endSelect(): HTMLSelectElement {
  const end = el("select", "grant-end");
  end.name = "end";
  end.setAttribute("aria-label", "How long it lasts");
  for (const e of GRANT_ENDS) end.append(option(e.key, e.key === "never" ? "Lasts until removed" : `Lasts ${e.label}`));
  end.value = "never";
  return end;
}

function nameInput(placeholder: string, label: string): HTMLInputElement {
  const name = el("input", "grant-name");
  name.name = "name";
  name.required = true;
  name.maxLength = 64;
  name.autocomplete = "off";
  name.placeholder = placeholder;
  name.setAttribute("aria-label", label);
  return name;
}

/** Add a computer: its name, hands or a full member, how long it lasts. */
function createNodeInviteForm(): HTMLFormElement {
  const form = el("form", "grant-form node-invite-form");
  const role = el("select", "grant-role");
  role.name = "role";
  role.setAttribute("aria-label", "What the machine may be");
  role.append(option("hands", "Hands: it runs what this computer asks, and reaches no other machine"), option("full", "Full member: you can make it the primary, with the chat and the tasks"));
  const submit = el("button", "grant-submit", "Make the invite");
  submit.type = "submit";
  form.append(el("p", "grant-form-head", "Add a computer"), nameInput("what to call it", "What to call the machine"), role, endSelect(), submit, actionButton("grant-form-cancel", "Cancel", "grant-form-close"));
  return form;
}

/** Join another computer: the invite it made for this one, the folders it may use here, and whose prompts are whose. */
function createJoinForm(): HTMLFormElement {
  const form = el("form", "grant-form node-join-form");
  const invite = el("textarea", "join-invite");
  invite.name = "invite";
  invite.required = true;
  invite.rows = 3;
  invite.spellcheck = false;
  invite.placeholder = "cophyla-invite:…";
  invite.setAttribute("aria-label", "The invite");
  const paths = el("textarea", "join-paths");
  paths.name = "paths";
  paths.rows = 2;
  paths.spellcheck = false;
  paths.placeholder = "Folders it may use, one per line; none shares all of this computer";
  paths.setAttribute("aria-label", "The folders it may use here");
  const here = el("label", "join-here");
  const box = el("input");
  box.type = "checkbox";
  box.name = "answerHere";
  here.append(box, el("span", undefined, "Prompts raised here are answered here only"));
  const submit = el("button", "grant-submit", "Join");
  submit.type = "submit";
  form.append(
    el("p", "grant-form-head", "Join another computer"),
    el("p", "grant-form-hint", "Paste the invite that computer made for this one. It sees and uses the folders you name here, or all of this computer if you name none."),
    invite,
    paths,
    here,
    submit,
    actionButton("grant-form-cancel", "Cancel", "grant-form-close"),
  );
  return form;
}

/** Invite a phone: its name, what it may do, perhaps kept to one machine or workspace, and how long it lasts. */
function createPhoneInviteForm(): HTMLFormElement {
  const form = el("form", "grant-form phone-invite-form");
  const preset = el("select", "grant-preset");
  preset.name = "preset";
  preset.setAttribute("aria-label", "What the phone may do");
  for (const key of Object.keys(PHONE_PRESETS)) preset.append(option(key, key === "full" ? "Everything this app does" : key === "sessions" ? "Its sessions: read, answer and send" : "Look only: read the sessions"));
  const limit = el("select", "grant-limit");
  limit.name = "limit";
  limit.setAttribute("aria-label", "Where it may do it");
  const submit = el("button", "grant-submit", "Make the invite");
  submit.type = "submit";
  form.append(el("p", "grant-form-head", "Add a phone"), nameInput("what to call the phone", "What to call the phone"), preset, limit, endSelect(), submit, actionButton("grant-form-cancel", "Cancel", "grant-form-close"));
  return form;
}

/** The phone form's limits: anywhere, or one machine or one workspace, kept as chosen while the choices stay. */
function updateLimits(select: HTMLSelectElement, state: ViewState): void {
  const choices = [{ key: "", label: "Anywhere it may" }, ...limitChoices(state)];
  const key = choices.map((c) => c.key).join("|");
  if (select.dataset["choices"] === key) return;
  const chosen = select.value;
  select.replaceChildren(...choices.map((c) => option(c.key, c.label)));
  select.dataset["choices"] = key;
  select.value = choices.some((c) => c.key === chosen) ? chosen : "";
}

/** The invite just minted, where it was asked for: its text and Copy, its QR code, how long it holds, and Done. */
function renderInvitePanel(slot: HTMLElement, state: ViewState, ui: UiState, kind: GrantKind): void {
  const invite = state.invite?.kind === kind ? state.invite : undefined;
  let panel = slot.querySelector<HTMLElement>(".invite-panel");
  if (panel && panel.dataset["grant"] !== invite?.grant) {
    panel.remove();
    panel = null;
  }
  if (!invite) return;
  if (!panel) {
    panel = el("div", "invite-panel");
    panel.dataset["grant"] = invite.grant;
    // a button: the rail's width is small for a camera, so a press shows it large over the view
    const qr = actionButton("invite-qr", "", "invite-qr-zoom");
    qr.append(qrSvg(invite.link, `The invite for ${invite.name}, as a QR code`));
    const text = el("textarea", "invite-text");
    text.readOnly = true;
    text.rows = 3;
    text.spellcheck = false;
    text.value = invite.text;
    text.setAttribute("aria-label", "The invite");
    const buttons = el("div", "invite-buttons");
    buttons.append(actionButton("invite-copy", "Copy", "invite-copy"), actionButton("invite-done", "Done", "invite-done"));
    panel.append(el("p", "invite-head"), el("p", "invite-hint"), qr, text, el("p", "invite-left"), buttons);
    slot.append(panel);
  }
  setText(panel.querySelector(".invite-head")!, `The invite for ${invite.name}`);
  setText(
    panel.querySelector(".invite-hint")!,
    kind === "node"
      ? "On that machine, give it to cophylad join, or paste it under Join another computer in its Cophyla app. It works once."
      : "Scan it with the phone's camera to open it in Cophyla, or paste the text in the app. It works once.",
  );
  const qr = panel.querySelector<HTMLButtonElement>(".invite-qr")!;
  setData(qr, "zoom", ui.qrZoom ? "1" : "0");
  qr.title = ui.qrZoom ? "Show it smaller (Esc)" : "Show it larger";
  const words = issuedWords(invite, Date.now());
  const copied = ui.copied?.grant === invite.grant ? ui.copied : undefined;
  setText(panel.querySelector(".invite-left")!, [words.expired ? "this invite has run out" : `good for ${words.left}`, copied ? (copied.ok ? "copied" : "select the text and copy it") : ""].filter(Boolean).join(" · "));
  setData(panel, "expired", words.expired ? "1" : "0");
}

/** The invites still open for machines or phones, less the one on show, each with how long it holds and Cancel. */
function renderPending(list: HTMLElement, state: ViewState, kind: GrantKind): void {
  const now = Date.now();
  const rows = selectPendingInvites(state, now).filter((p) => p.grant.kind === kind && p.grant.id !== state.invite?.grant);
  if (!list.firstChild) list.append(el("p", "invites-head", kind === "node" ? "Invited, not joined yet" : "Invited, not paired yet"), el("div", "invites-rows"));
  reconcile(
    list.querySelector<HTMLElement>(".invites-rows")!,
    rows,
    (p) => p.grant.id,
    () => {
      const row = el("div", "invite-pending");
      row.append(el("span", "invite-pending-name"), el("span", "invite-pending-left"), actionButton("invite-pending-cancel", "Cancel", "grant-cancel"));
      return row;
    },
    (row, p) => {
      setText(row.querySelector(".invite-pending-name")!, p.grant.name);
      setText(row.querySelector(".invite-pending-left")!, p.expired ? "ran out" : p.left);
      row.title = p.expired ? `The invite for ${p.grant.name} ran out` : `The invite for ${p.grant.name} holds for ${p.left} more`;
      const cancel = row.querySelector<HTMLButtonElement>(".invite-pending-cancel")!;
      cancel.dataset["grant"] = p.grant.id;
      cancel.disabled = !state.connected;
      cancel.title = `Cancel the invite for ${p.grant.name}`;
    },
  );
  setHidden(list, rows.length === 0);
}

function setFormBusy(form: HTMLFormElement, state: ViewState, ui: UiState): void {
  for (const b of form.querySelectorAll<HTMLButtonElement>("button")) b.disabled = !state.connected || ui.grantBusy === true;
}

/** Under the machines' cards: Add a computer and its invite, the invites still open, and Join another computer. */
function renderNodeTools(tools: HTMLElement, state: ViewState, ui: UiState): void {
  if (!tools.firstChild) {
    const buttons = el("div", "node-tools-buttons");
    buttons.append(actionButton("node-add", "Add a computer", "grant-form-node"), actionButton("node-join", "Join another computer", "grant-form-join"));
    tools.append(buttons, createNodeInviteForm(), createJoinForm(), el("div", "invite-slot"), el("div", "invites-pending"));
  }
  // a hands node reaches no other machine, and lets none in
  const hands = state.node !== undefined && state.nodes.get(state.node)?.hands === true;
  const canInvite = state.scopes.includes("controllers") && state.scopes.includes("nodes") && !hands;
  const joining = membershipOffer(state) === "join";
  setHidden(tools, !canInvite && !joining);
  if (tools.hidden) return;
  const add = tools.querySelector<HTMLButtonElement>(".node-add")!;
  setHidden(add, !canInvite || ui.grantForm === "node");
  add.disabled = !state.connected;
  add.title = "Let another computer join this one, with an invite it redeems once";
  const join = tools.querySelector<HTMLButtonElement>(".node-join")!;
  setHidden(join, !joining || ui.grantForm === "join");
  join.disabled = !state.connected;
  join.title = "Let another computer use this one, with the invite it made for it";
  const nodeForm = tools.querySelector<HTMLFormElement>(".node-invite-form")!;
  setHidden(nodeForm, ui.grantForm !== "node");
  setFormBusy(nodeForm, state, ui);
  const joinForm = tools.querySelector<HTMLFormElement>(".node-join-form")!;
  setHidden(joinForm, ui.grantForm !== "join");
  setFormBusy(joinForm, state, ui);
  renderInvitePanel(tools.querySelector<HTMLElement>(".invite-slot")!, state, ui, "node");
  renderPending(tools.querySelector<HTMLElement>(".invites-pending")!, state, "node");
}

/** The pairing panel: the URL to open, the code in two groups, and how long it holds. */
function renderPairing(root: HTMLElement, state: ViewState): void {
  let panel = root.querySelector<HTMLElement>(".pair-panel");
  if (!panel) {
    panel = el("div", "pair-panel");
    const done = el("button", "pair-done", "Done");
    done.type = "button";
    done.dataset["action"] = "pair-close";
    panel.append(el("p", "pair-hint", "Open this on the phone and type the code:"), el("p", "pair-url"), el("p", "pair-code"), el("p", "pair-left"), done);
    root.append(panel);
  }
  setHidden(panel, state.pairing === undefined);
  if (!state.pairing) return;
  const words = pairingWords(state.pairing, Date.now());
  setText(panel.querySelector(".pair-url")!, state.pairing.url.replace(/\?code=\d+$/, ""));
  setText(panel.querySelector(".pair-code")!, words.code);
  setText(panel.querySelector(".pair-left")!, words.expired ? "that code has run out" : `good for ${words.left}`);
}

/** The speaker beside the chat's tab: hidden until the node says, then dim, lit, playing or struck through. */
function renderSpeaker(button: HTMLButtonElement, state: ViewState): void {
  const b = speakerButton(state);
  setHidden(button, b === undefined);
  if (!b) return;
  setData(button, "look", b.look);
  button.title = b.title;
  button.setAttribute("aria-label", b.title);
  button.setAttribute("aria-pressed", b.look === "hushed" ? "true" : "false");
  button.disabled = b.disabled;
}

function renderTabs(root: HTMLElement, state: ViewState, ui: UiState): void {
  let chat = root.querySelector<HTMLButtonElement>(".tab.chat");
  if (!chat) {
    // The chat's row: its tab, and at its right the view's ⋮ menu.
    const top = el("div", "rail-top");
    chat = el("button", "tab chat");
    chat.type = "button";
    chat.dataset["action"] = "select";
    // At its very right, the line to cophylad: a dot.
    const dot = el("span", "dot link-dot");
    dot.setAttribute("role", "img");
    chat.append(el("span", "tab-title", "Cophyla Chat"), el("span", "pulse"), dot);
    // Between the two, once the node says whether the next reply is read out: the speaker, which silences it.
    const speaker = actionButton("speak-next", "", "hush");
    speaker.append(speakerIcon());
    // Then, when the node shows the brain's context: the button that lays it over the pane.
    const context = actionButton("context-open", "", "context-open");
    context.title = "Context: what the brain sees on its next turn";
    context.setAttribute("aria-label", context.title);
    context.hidden = true;
    const more = actionButton("rail-more", "", "rail-more");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-label", "More");
    more.title = "More";
    more.append(el("span", "dots-mark"));
    // Change view opens the host's picker over the view, Settings the host's settings: every view must offer both somewhere.
    const moreMenu = el("div", "rail-menu");
    moreMenu.setAttribute("role", "menu");
    const change = actionButton("rail-menu-item", "Change view", "change-view");
    change.setAttribute("role", "menuitem");
    change.title = "Show another view in this app";
    const settings = actionButton("rail-menu-item", "Settings", "settings");
    settings.setAttribute("role", "menuitem");
    settings.title = "Which account agents start under, and with what";
    moreMenu.append(change, settings, el("p", "rail-menu-note"));
    top.append(chat, speaker, context, more, moreMenu);
    const list = el("div", "tab-sessions");
    const newTerminal = el("button", "tab-new-terminal", "New terminal");
    newTerminal.type = "button";
    newTerminal.dataset["action"] = "new-terminal";
    newTerminal.title = "Start a shell on a computer, in a folder you pick, shown here";
    newTerminal.setAttribute("aria-haspopup", "true");
    // Under it, once pressed: where to start the shell, each machine's places, or a folder picked on one.
    const menu = el("div", "new-terminal-menu");
    menu.append(el("p", "new-terminal-head", "Open a terminal in"), el("p", "new-terminal-loading", "Loading workspaces…"), el("div", "new-terminal-places"), createFolderPicker());
    // The bare terminals under a heading of their own, which folds them like a folder's, by machine when there are several.
    const terminals = el("div", "tab-group terminals-group");
    const terminalsName = actionButton("tab-group-name", "Terminals", "group-fold");
    terminalsName.dataset["group"] = TERMINALS_GROUP;
    terminalsName.title = "Terminals no agent session runs in";
    terminals.append(terminalsName, el("div", "tab-terminals"), el("div", "tab-subgroups terminal-machines"));
    list.append(el("div", "tab-groups"), el("p", "tabs-empty", "Start Claude Code, Codex or Muse in a terminal and it appears here."), terminals, newTerminal, menu);
    // Under the sessions, a glance at the machines, the usage and the phones, and the way into Devices.
    const cards = createStatus();
    // While an agent's tab is selected they are the Status tab, beside its folder's files.
    const panel = el("div", "rail-panel");
    const strip = el("div", "rail-panel-tabs");
    strip.setAttribute("role", "tablist");
    strip.setAttribute("aria-label", "Under the sessions");
    for (const [tab, label, title] of [
      ["status", "Status", "The machines, the usage, the account and the phones"],
      ["files", "Files", "The folder this agent works in"],
    ] as const) {
      const b = actionButton("rail-panel-tab", label, "rail-tab");
      b.setAttribute("role", "tab");
      b.dataset["tab"] = tab;
      b.title = title;
      strip.append(b);
    }
    panel.append(strip, cards, createExplorer());
    // Between the two: a divider the user drags, or steps with the arrow keys.
    const split = el("div", "rail-split");
    split.setAttribute("role", "separator");
    split.setAttribute("aria-orientation", "horizontal");
    split.setAttribute("aria-label", "Between the sessions and the panel under them");
    split.tabIndex = 0;
    split.setAttribute("aria-valuemin", String(RAIL_SPLIT.min));
    split.setAttribute("aria-valuemax", String(RAIL_SPLIT.max));
    split.title = "Drag to share the height; double-click for the usual";
    root.append(top, list, split, panel);
  }
  const link = linkWords(state);
  const dot = chat.querySelector<HTMLElement>(".link-dot")!;
  setHidden(dot, link === undefined);
  if (link) {
    setData(dot, "status", link.status);
    dot.title = link.title;
    dot.setAttribute("aria-label", link.title);
  }
  chat.setAttribute("aria-current", ui.selected === undefined && ui.terminal === undefined ? "true" : "false");
  renderSpeaker(root.querySelector<HTMLButtonElement>(".speak-next")!, state);
  const context = root.querySelector<HTMLButtonElement>(".context-open")!;
  setHidden(context, ui.contextOn !== true);
  context.setAttribute("aria-pressed", ui.contextOpen ? "true" : "false");
  const split = String(ui.railSplit);
  if (root.style.getPropertyValue("--rail-split") !== split) root.style.setProperty("--rail-split", split);
  root.querySelector<HTMLElement>(".rail-split")!.setAttribute("aria-valuenow", split);
  renderRailMenu(root, state, ui);
  // The chat tab pulses while the orchestrator works or a reply streams, and while a phone is in a conversation.
  setHidden(chat.querySelector<HTMLElement>(".pulse")!, state.streaming.size === 0 && state.progress === undefined && !voiceBusy(state));

  const canTerminal = state.scopes.includes("terminal");
  // An agent CLI waiting for its first prompt stands with the sessions in its folder.
  const groups = selectGroups(state, canTerminal ? selectWaitingAgents(state) : []);
  reconcile(root.querySelector<HTMLElement>(".tab-groups")!, groups, (g) => g.key, createGroup, (node, g) => updateGroup(node, g, state, ui));
  setHidden(root.querySelector<HTMLElement>(".tabs-empty")!, groups.length > 0);
  renderTerminals(root.querySelector<HTMLElement>(".terminals-group")!, canTerminal ? selectTerminalTabs(state, ui.terminal).filter((t) => !waitingAgent(state, t)) : [], state, ui);
  const newTerminal = root.querySelector<HTMLButtonElement>(".tab-new-terminal")!;
  setHidden(newTerminal, !canTerminal);
  newTerminal.disabled = !state.connected;
  renderNewTerminal(root.querySelector<HTMLElement>(".new-terminal-menu")!, newTerminal, state, ui, canTerminal);

  renderPanel(root, state, ui);
  renderStatus(root.querySelector<HTMLElement>(".rail-cards")!, state, ui);
}

// --- the rail's Status: a glance at the machines, the usage and the phones ----------------------

/**
 * The Status tab: a line per machine with its readings and its desktop's way in, each login's
 * limits and spend, a line per phone, and at its foot Devices, where everything else is. A
 * machine's or a phone's name opens Devices at its card.
 */
function createStatus(): HTMLElement {
  const cards = el("div", "rail-cards");
  const machines = el("section", "status-section status-machines");
  machines.setAttribute("aria-label", "Computers");
  machines.append(el("h3", "status-heading", "Computers"), el("div", "status-machine-rows"));
  const usage = el("section", "status-section status-usage");
  usage.setAttribute("aria-label", "Usage");
  const usageHead = el("div", "status-heading-row");
  usageHead.title = "Each login's share of its session (five-hour) and weekly limits, and what its sessions spent today";
  usageHead.append(el("h3", "status-heading", "Usage"), el("span", "status-heading status-heading-aside", "Today"));
  usage.append(usageHead, el("div", "status-login-rows"));
  const phones = el("section", "status-section status-phones");
  phones.setAttribute("aria-label", "Phones");
  phones.append(el("h3", "status-heading", "Phones"), el("div", "status-phone-rows"));
  const devices = actionButton("status-devices", "", "devices-open");
  devices.title = "Every computer and phone, what each can do, and the account";
  devices.append(el("span", "status-devices-label", "Devices and account"), el("span", "status-devices-count"), el("span", "chevron-mark"));
  cards.append(machines, usage, phones, devices);
  return cards;
}

function renderStatus(cards: HTMLElement, state: ViewState, ui: UiState): void {
  const machines = selectStatusMachines(state);
  const machineSection = cards.querySelector<HTMLElement>(".status-machines")!;
  setHidden(machineSection, machines.length === 0);
  reconcile(machineSection.querySelector<HTMLElement>(".status-machine-rows")!, machines, (m) => m.node, createStatusMachine, (node, m) => updateStatusMachine(node, m, state, ui));
  const logins = state.scopes.includes("metrics:read") ? selectSpend(state) : [];
  const usage = cards.querySelector<HTMLElement>(".status-usage")!;
  setHidden(usage, logins.length === 0);
  reconcile(usage.querySelector<HTMLElement>(".status-login-rows")!, logins, (r) => r.profile, createStatusLogin, updateStatusLogin);
  const phones = state.scopes.includes("controllers") ? selectStatusPhones(state) : [];
  const phoneSection = cards.querySelector<HTMLElement>(".status-phones")!;
  setHidden(phoneSection, phones.length === 0);
  reconcile(phoneSection.querySelector<HTMLElement>(".status-phone-rows")!, phones, (p) => p.id, createStatusPhone, updateStatusPhone);
  const devices = cards.querySelector<HTMLButtonElement>(".status-devices")!;
  setHidden(devices, !devicesShown(state));
  devices.setAttribute("aria-pressed", ui.devices ? "true" : "false");
  setText(devices.querySelector(".status-devices-count")!, devicesWords(state));
}

/** A machine's line: its dot and name, which open its card in Devices; its desktop's mark while shared; its readings; what wants the user; and Connect and Beside. */
function createStatusMachine(): HTMLElement {
  const row = el("div", "status-machine");
  const head = actionButton("status-machine-head", "", "devices-open");
  head.append(el("span", "dot"), el("span", "status-machine-name"), el("span", "desktop-mark"), el("span", "status-machine-sub"));
  const actions = el("div", "status-machine-actions");
  const connect = actionButton("status-connect", "Connect", "remote-open");
  connect.title = "Open its desktop in Moonlight, in a window of its own";
  const beside = actionButton("status-beside", "Beside", "remote-beside");
  beside.title = "Show its desktop beside the pane";
  actions.append(connect, beside);
  row.append(head, el("div", "status-meters"), el("p", "status-alert"), actions);
  return row;
}

function updateStatusMachine(row: HTMLElement, m: StatusMachine, state: ViewState, ui: UiState): void {
  setData(row, "node", m.node);
  setData(row, "online", m.online ? "1" : "0");
  const head = row.querySelector<HTMLButtonElement>(".status-machine-head")!;
  head.dataset["focus"] = `node:${m.node}`;
  head.title = `${m.title}\nOpen it in Devices`;
  setData(head.querySelector<HTMLElement>(".dot")!, "status", m.online ? "connected" : "gone");
  setText(head.querySelector(".status-machine-name")!, m.name);
  setText(head.querySelector(".status-machine-sub")!, m.sub);
  const desktop = head.querySelector<HTMLElement>(".desktop-mark")!;
  setHidden(desktop, m.desktop === undefined);
  setData(desktop, "watched", m.desktop?.watched ? "1" : "0");
  desktop.title = m.desktop?.title ?? "";
  desktop.setAttribute("aria-label", m.desktop?.title ?? "");
  desktop.setAttribute("role", "img");
  const meters = row.querySelector<HTMLElement>(".status-meters")!;
  setHidden(meters, m.meters.length === 0);
  reconcile(meters, m.meters, (x) => x.key, createMeter, updateMeter);
  const alert = row.querySelector<HTMLElement>(".status-alert")!;
  setText(alert, m.alert ?? "");
  setHidden(alert, m.alert === undefined);
  const connect = row.querySelector<HTMLButtonElement>(".status-connect")!;
  const beside = row.querySelector<HTMLButtonElement>(".status-beside")!;
  updateViewButtons(connect, beside, m.node, m.connect, m.beside, state, ui);
  setHidden(row.querySelector<HTMLElement>(".status-machine-actions")!, !m.connect && !m.beside);
}

/** One reading: its label and value over a thin track. */
function createMeter(): HTMLElement {
  const meter = el("span", "status-meter");
  const track = el("span", "status-meter-track");
  track.append(el("span", "status-meter-fill"));
  meter.append(el("span", "status-meter-label"), el("span", "status-meter-value"), track);
  return meter;
}

function updateMeter(node: HTMLElement, m: StatusMeter): void {
  setData(node, "level", m.level);
  node.title = m.title;
  setText(node.querySelector(".status-meter-label")!, m.label);
  setText(node.querySelector(".status-meter-value")!, m.words);
  const fill = node.querySelector<HTMLElement>(".status-meter-fill")!;
  const width = `${m.percent}%`;
  if (fill.style.width !== width) fill.style.width = width;
}

/** A login's line: its harness's mark, its name and what its sessions spent today, then its session and weekly limits as meters. */
function createStatusLogin(): HTMLElement {
  const row = el("div", "status-login");
  const head = el("div", "status-login-head");
  const icon = el("span", "agent-icon login-mark");
  icon.dataset["tone"] = "active";
  icon.setAttribute("role", "img");
  icon.append(el("span", "agent-mark"));
  head.append(icon, el("span", "status-login-name"), el("span", "status-login-cost"));
  row.append(head, el("div", "status-meters"));
  return row;
}

function updateStatusLogin(row: HTMLElement, r: SpendRow): void {
  const now = Date.now();
  setData(row, "profile", r.profile);
  row.title = spendTitle(r, now);
  const icon = row.querySelector<HTMLElement>(".login-mark")!;
  setData(icon, "harness", r.harness ?? "");
  setHidden(icon, r.harness === undefined);
  icon.setAttribute("aria-label", r.harness ? HARNESS_NAMES[r.harness] : "");
  setText(row.querySelector(".status-login-name")!, r.label);
  setText(row.querySelector(".status-login-cost")!, costWords(r.spend.cost));
  reconcile(row.querySelector<HTMLElement>(".status-meters")!, usageMeters(r, now), (m) => m.key, createMeter, updateMeter);
}

/** A machine's bar as a meter on its card: CPU and Memory by name, a GPU by its own. */
function barMeter(bar: NodeBar): StatusMeter {
  const label = bar.label === "cpu" ? "CPU" : bar.label === "memory" ? "Memory" : bar.label;
  const level = bar.percent === undefined ? "none" : bar.percent >= 95 ? "critical" : bar.percent >= 80 ? "warn" : "normal";
  return { key: bar.label, label, percent: bar.percent ?? 0, words: bar.words, level, title: `${label} ${bar.words}` };
}

/** A phone's line, which opens its row in Devices: its dot, its name, and here now or when it was last. */
function createStatusPhone(): HTMLElement {
  const row = actionButton("status-phone", "", "devices-open");
  row.append(el("span", "dot"), el("span", "status-phone-name"), el("span", "status-phone-sub"));
  return row;
}

function updateStatusPhone(row: HTMLElement, p: StatusPhone): void {
  row.dataset["focus"] = `phone:${p.id}`;
  row.title = `${p.title}\nOpen it in Devices`;
  setData(row.querySelector<HTMLElement>(".dot")!, "status", p.connected ? "connected" : "gone");
  setText(row.querySelector(".status-phone-name")!, p.name);
  setText(row.querySelector(".status-phone-sub")!, p.words);
}

// --- Devices: every machine and phone with all they can do, and the account --------------------

/** Whether Devices has anything to show this client: machines, phones it may manage, or the account. */
export function devicesShown(state: ViewState): boolean {
  return state.nodes.size > 0 || state.scopes.includes("controllers") || state.scopes.includes("account");
}

/**
 * Devices, laid over the panes while it is open: its head with the count and Close; the last
 * error since it opened, as it covers the input that says them otherwise; then Computers (a
 * card per machine, Add a computer, Join another computer), Phones (a row per phone, Add a
 * phone, Pair with a code) and the account.
 */
function createDevices(root: HTMLElement): void {
  const head = el("header", "devices-head");
  const close = actionButton("devices-close viewer-tool viewer-close", "", "devices-close");
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close Devices");
  head.append(el("span", "devices-mark"), el("h2", "devices-title", "Devices"), el("span", "devices-meta"), close);
  const note = el("p", "devices-note");
  note.setAttribute("role", "alert");
  const body = el("div", "devices-body");
  body.tabIndex = -1;
  const column = el("div", "devices-column");
  const computers = el("section", "devices-section devices-computers");
  computers.append(sectionHead("Computers", "This computer and the ones that joined it: which is the primary, what they run, and who can view their desktops."), el("div", "node-cards"), el("div", "node-tools"));
  const phones = el("section", "devices-section devices-phones");
  const tools = el("div", "phone-tools");
  const buttons = el("div", "phone-tools-buttons");
  const add = actionButton("phone-invite", "Add a phone", "grant-form-phone");
  add.title = "An invite the phone scans or pastes, with what it may do and for how long";
  const pair = actionButton("pair-start", "Pair with a code", "pair");
  pair.title = "On this network: open an address on the phone and type the code shown here";
  buttons.append(add, pair);
  tools.append(buttons, createPhoneInviteForm(), el("div", "invite-slot"), el("div", "invites-pending"));
  phones.append(sectionHead("Phones", "The phones that use Cophyla, what each may do, and until when."), el("div", "controllers"), el("p", "devices-empty", "No phone uses Cophyla yet."), tools);
  const account = el("section", "devices-section devices-account");
  account.append(sectionHead("Account", "Your plan, its usage, the backup and direct connections."), el("div", "account-card"));
  column.append(computers, phones, account);
  body.append(column);
  root.append(head, note, body);
}

function sectionHead(title: string, lede: string): HTMLElement {
  const head = el("div", "devices-section-head");
  head.append(el("h3", "devices-heading", title), el("p", "devices-lede", lede));
  return head;
}

function renderDevices(root: HTMLElement, state: ViewState, ui: UiState): void {
  setHidden(root, ui.devices === undefined);
  if (!ui.devices) return;
  if (!root.firstChild) createDevices(root);
  setText(root.querySelector(".devices-meta")!, devicesWords(state));
  const error = state.errorsSeen > ui.devices.errorsAt ? state.errors.at(-1) : undefined;
  const note = root.querySelector<HTMLElement>(".devices-note")!;
  setText(note, error ?? "");
  setHidden(note, error === undefined);
  renderComputers(root.querySelector<HTMLElement>(".devices-computers")!, state, ui);
  renderPhones(root.querySelector<HTMLElement>(".devices-phones")!, state, ui);
  const account = root.querySelector<HTMLElement>(".devices-account")!;
  setHidden(account, !state.scopes.includes("account"));
  renderAccount(account.querySelector<HTMLElement>(".account-card")!, state, ui);
}

/** Devices' phones: a row per phone with Forget, then Add a phone, Pair with a code, the invite on show and the ones still open. */
function renderPhones(section: HTMLElement, state: ViewState, ui: UiState): void {
  setHidden(section, !state.scopes.includes("controllers"));
  if (section.hidden) return;
  const controllers = selectControllers(state);
  reconcile(section.querySelector<HTMLElement>(".controllers")!, controllers, (c) => c.id, createController, (node, c) => updateController(node, c, state));
  setHidden(section.querySelector<HTMLElement>(".devices-empty")!, controllers.length > 0);
  const tools = section.querySelector<HTMLElement>(".phone-tools")!;
  const pair = tools.querySelector<HTMLButtonElement>(".pair-start")!;
  pair.disabled = !state.connected;
  setHidden(pair, state.pairing !== undefined || ui.grantForm === "phone");
  renderPairing(tools, state);
  const invitePhone = tools.querySelector<HTMLButtonElement>(".phone-invite")!;
  setHidden(invitePhone, ui.grantForm === "phone");
  invitePhone.disabled = !state.connected;
  const phoneForm = tools.querySelector<HTMLFormElement>(".phone-invite-form")!;
  setHidden(phoneForm, ui.grantForm !== "phone");
  updateLimits(phoneForm.querySelector<HTMLSelectElement>(".grant-limit")!, state);
  setFormBusy(phoneForm, state, ui);
  renderInvitePanel(tools.querySelector<HTMLElement>(":scope > .invite-slot")!, state, ui, "controller");
  renderPending(tools.querySelector<HTMLElement>(":scope > .invites-pending")!, state, "controller");
}

/** The session whose files the rail can show: the agent whose tab is selected, where the view may read sessions. */
export function explorerSession(state: ViewState, ui: UiState): Session | undefined {
  if (!state.scopes.includes("sessions:read")) return undefined;
  return ui.selected !== undefined ? state.sessions.get(ui.selected)?.session : undefined;
}

/**
 * The rail's lower half: the status cards alone while the chat or a bare terminal shows; with
 * an agent's tab selected, its two tabs, Status and Files, and the one picked.
 */
function renderPanel(root: HTMLElement, state: ViewState, ui: UiState): void {
  const panel = root.querySelector<HTMLElement>(".rail-panel")!;
  const session = explorerSession(state, ui);
  const tab = session ? ui.railTab : "status";
  setData(panel, "tab", tab);
  setHidden(panel.querySelector<HTMLElement>(".rail-panel-tabs")!, !session);
  for (const b of Array.from(panel.querySelectorAll<HTMLButtonElement>(".rail-panel-tab"))) {
    const on = b.dataset["tab"] === tab;
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  const cards = panel.querySelector<HTMLElement>(".rail-cards")!;
  setHidden(cards, tab !== "status");
  if (session) cards.setAttribute("role", "tabpanel");
  else cards.removeAttribute("role");
  renderExplorer(panel.querySelector<HTMLElement>(".explorer")!, state, ui, tab === "files" ? session : undefined);
}

/** The Files tab: the folder's name with Refresh and Collapse, its tree, a note while it has none, and the repository's line at its foot. */
function createExplorer(): HTMLElement {
  const block = el("section", "explorer");
  block.setAttribute("role", "tabpanel");
  const head = el("div", "explorer-head");
  const refresh = actionButton("explorer-tool explorer-refresh", "", "files-refresh");
  refresh.title = "Refresh";
  refresh.setAttribute("aria-label", "Refresh the files");
  const collapse = actionButton("explorer-tool explorer-collapse", "", "files-collapse");
  collapse.title = "Collapse folders";
  collapse.setAttribute("aria-label", "Collapse every folder");
  head.append(el("span", "explorer-root"), refresh, collapse);
  const tree = el("div", "explorer-tree");
  tree.setAttribute("role", "tree");
  const git = el("div", "explorer-git");
  git.setAttribute("role", "status");
  git.append(el("span", "git-mark"), el("span", "git-branch"), el("span", "git-sync"));
  block.append(head, tree, el("p", "explorer-note"), git);
  return block;
}

const NO_FOLDERS: ReadonlySet<string> = new Set();

function renderExplorer(block: HTMLElement, state: ViewState, ui: UiState, session: Session | undefined): void {
  setHidden(block, session === undefined);
  if (!session) return;
  const place = explorerKey(state, session);
  const ex = state.explorers.get(place);
  const rootPath = ex?.root ?? session.cwd;
  const name = rootPath.split(/[\\/]/).filter((p) => p !== "").pop() ?? rootPath;
  const head = block.querySelector<HTMLElement>(".explorer-root")!;
  setText(head, name);
  head.title = rootPath;
  const tree = block.querySelector<HTMLElement>(".explorer-tree")!;
  tree.setAttribute("aria-label", `Files in ${name}`);
  const rows = ex ? selectFileRows(ex, ui.openDirs.get(place) ?? NO_FOLDERS) : [];
  const picked = ui.picked.get(place);
  // The file the tab's viewer shows, by its full path: read through this agent, another whose folder holds it, or a terminal.
  const viewing = viewingKey(state, session, ui.viewers.get(session.id));
  const platform = state.nodes.get(session.node)?.platform;
  // One row takes the Tab key, the one picked or else the first; the arrows move from it.
  const current = rows.find((r) => r.key === picked && (r.kind === "dir" || r.kind === "file"))?.key ?? rows.find((r) => r.kind === "dir" || r.kind === "file")?.key;
  reconcile(tree, rows, (r) => r.key, createFileRow, (row, r) => updateFileRow(row, r, picked, current, r.kind === "file" && viewing !== undefined && placeKey(r.path, platform) === viewing));
  const note = block.querySelector<HTMLElement>(".explorer-note")!;
  const words = explorerNote(ex);
  setText(note, words);
  setHidden(note, words === "");
  for (const b of Array.from(block.querySelectorAll<HTMLButtonElement>(".explorer-tool"))) b.disabled = !state.connected;
  const git = block.querySelector<HTMLElement>(".explorer-git")!;
  setHidden(git, ex?.git === undefined);
  if (!ex?.git) return;
  const line = gitLine(ex.git);
  setText(git.querySelector(".git-branch")!, line.branch);
  const sync = git.querySelector<HTMLElement>(".git-sync")!;
  setText(sync, line.sync);
  setHidden(sync, line.sync === "");
  setData(sync, "state", ex.git.upstream === undefined ? "none" : line.sync === "" ? "even" : "moved");
  git.title = line.title;
}

/** An explorer row: its twisty (a folder's), its mark, its name. A folder or a file is dragged by its path; the file the viewer shows is marked. */
function createFileRow(): HTMLElement {
  const row = el("div", "file-row");
  row.append(el("span", "file-twisty"), el("span", "file-mark"), el("span", "file-name"));
  return row;
}

function updateFileRow(row: HTMLElement, r: FileRow, picked: string | undefined, current: string | undefined, viewing: boolean): void {
  const item = r.kind === "dir" || r.kind === "file";
  setData(row, "kind", r.kind);
  setData(row, "viewing", viewing ? "1" : "0");
  setData(row, "rel", r.key);
  setData(row, "path", r.path);
  setData(row, "loading", r.loading ? "1" : "0");
  const depth = String(r.depth);
  if (row.style.getPropertyValue("--depth") !== depth) row.style.setProperty("--depth", depth);
  if (item) {
    setData(row, "action", "file");
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(r.depth + 1));
    row.setAttribute("aria-selected", picked === r.key ? "true" : "false");
    if (r.kind === "dir") row.setAttribute("aria-expanded", r.open ? "true" : "false");
    else row.removeAttribute("aria-expanded");
    row.draggable = true;
    row.tabIndex = r.key === current ? 0 : -1;
    row.title = r.path;
  } else {
    delete row.dataset["action"];
    row.setAttribute("role", "none");
    for (const a of ["aria-level", "aria-selected", "aria-expanded"]) row.removeAttribute(a);
    row.draggable = false;
    row.removeAttribute("tabindex");
    row.title = r.kind === "more" ? "This folder has more entries than the explorer lists" : r.path;
  }
  setText(row.querySelector(".file-name")!, r.name);
}

/**
 * The Files panel's menu, fixed where it was asked for and kept inside the frame: its one item
 * shows the row in the file manager of the computer it is on, named as that computer names it,
 * and is disabled with the reason where this view cannot (only the desktop app there can).
 */
function renderFileMenu(app: HTMLElement, state: ViewState, ui: UiState): void {
  let menu = app.querySelector<HTMLElement>(":scope > .file-menu");
  const m = ui.fileMenu;
  const session = m ? explorerSession(state, ui) : undefined;
  if (!m || !session || explorerKey(state, session) !== m.place) {
    if (menu) setHidden(menu, true);
    return;
  }
  if (!menu) {
    menu = el("div", "rail-menu file-menu");
    menu.setAttribute("role", "menu");
    const item = actionButton("rail-menu-item file-menu-reveal", "", "file-reveal");
    item.setAttribute("role", "menuitem");
    menu.append(item, el("p", "rail-menu-note"));
    app.append(menu);
  }
  const item = menu.querySelector<HTMLButtonElement>(".file-menu-reveal")!;
  const label = revealLabel(state.nodes.get(session.node)?.platform, m.kind);
  setText(item, label);
  const ex = state.explorers.get(m.place);
  item.title = joinPath(ex?.root ?? session.cwd, m.rel);
  menu.setAttribute("aria-label", m.rel === "" ? "The folder" : (m.rel.split("/").pop() ?? m.rel));
  const blocked = revealBlocked(state, session);
  item.disabled = blocked !== undefined || !state.connected || m.busy === true;
  const note = menu.querySelector<HTMLElement>(".rail-menu-note")!;
  const words = m.note ?? blocked ?? "";
  setText(note, words);
  setHidden(note, words === "");
  setHidden(menu, false);
  // Where it was asked for, moved in from an edge it would run past.
  const x = Math.max(4, Math.min(m.x, window.innerWidth - menu.offsetWidth - 4));
  const y = Math.max(4, Math.min(m.y, window.innerHeight - menu.offsetHeight - 4));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

/** The ⋮ menu beside the chat's tab: Change view and Settings, and why one did not open when it could not. */
function renderRailMenu(root: HTMLElement, state: ViewState, ui: UiState): void {
  const more = root.querySelector<HTMLButtonElement>(".rail-more")!;
  more.setAttribute("aria-expanded", ui.railMenu ? "true" : "false");
  const menu = root.querySelector<HTMLElement>(".rail-menu")!;
  setHidden(menu, !ui.railMenu);
  for (const item of menu.querySelectorAll<HTMLButtonElement>(".rail-menu-item")) item.disabled = !state.connected;
  const note = menu.querySelector<HTMLElement>(".rail-menu-note")!;
  setText(note, ui.railMenu?.note ?? "");
  setHidden(note, !ui.railMenu?.note);
}

/** The rail's own button, for a phone's width on a host with none, and the name of what the pane shows beside it. */
function renderRailbar(root: HTMLElement, state: ViewState, ui: UiState, shown: boolean): void {
  let toggle = root.querySelector<HTMLButtonElement>(".rail-toggle");
  if (!toggle) {
    toggle = el("button", "rail-toggle");
    toggle.type = "button";
    toggle.dataset["action"] = "rail-toggle";
    toggle.setAttribute("aria-label", "Sessions and machines");
    toggle.title = "Sessions and machines";
    toggle.append(el("span", "menu-mark"));
    root.append(toggle, el("span", "railbar-title"));
  }
  toggle.setAttribute("aria-expanded", shown ? "true" : "false");
  const card = ui.selected !== undefined ? state.sessions.get(ui.selected) : undefined;
  const bare = ui.terminal !== undefined ? state.terminals.get(ui.terminal) : undefined;
  setText(root.querySelector(".railbar-title")!, ui.devices ? "Devices" : card ? sessionLabel(card.session) : bare ? terminalTabLabel(state, bare) : "Cophyla Chat");
}

/** A row of New terminal's menu: a workspace, a machine's home folder, or Other folder…, which opens the picker on that machine. */
interface Place {
  key: string;
  name: string;
  path?: string;
  browse?: true;
}

/** One machine's rows of New terminal's menu, under its name when there are several. */
interface MachinePlaces {
  machine: TerminalMachine;
  places: Place[];
}

/**
 * New terminal's menu, open once pressed: each machine that starts terminals, this computer's
 * first, with its recent workspaces once the node listed them, its home folder and Other
 * folder…; Starting… on the one picked. Other folder… shows the picker in their place.
 */
function renderNewTerminal(menu: HTMLElement, button: HTMLButtonElement, state: ViewState, ui: UiState, canTerminal: boolean): void {
  const m = canTerminal && state.connected ? ui.newTerminal : undefined;
  button.setAttribute("aria-expanded", m ? "true" : "false");
  setHidden(menu, !m);
  if (!m) return;
  const browsing = m.browse !== undefined;
  setHidden(menu.querySelector<HTMLElement>(".new-terminal-head")!, browsing);
  setHidden(menu.querySelector<HTMLElement>(".new-terminal-loading")!, browsing || m.workspaces !== undefined);
  const placesNode = menu.querySelector<HTMLElement>(".new-terminal-places")!;
  setHidden(placesNode, browsing);
  const machines = terminalMachines(state);
  const several = machines.length > 1;
  const listed = m.workspaces;
  const sections: MachinePlaces[] = listed
    ? machines.map((machine) => ({
        machine,
        places: [
          ...recentWorkspaces(listed, machine.node, several ? RECENT_PER_MACHINE : RECENT_WORKSPACES).map((w) => ({ key: w.id, name: w.name, path: w.path })),
          { key: homePlace(machine.node), name: "Home folder" },
          { key: folderPlace(machine.node), name: "Other folder…", browse: true as const },
        ],
      }))
    : [];
  reconcile(placesNode, sections, (s) => s.machine.node, createMachinePlaces, (n, s) => updateMachinePlaces(n, s, several, m.starting));
  renderFolderPicker(menu.querySelector<HTMLElement>(".folder-picker")!, m);
}

function createMachinePlaces(): HTMLElement {
  const section = el("div", "new-terminal-machine");
  section.append(el("p", "new-terminal-machine-name"), el("div", "new-terminal-machine-places"));
  return section;
}

function updateMachinePlaces(node: HTMLElement, s: MachinePlaces, several: boolean, starting: string | undefined): void {
  const name = node.querySelector<HTMLElement>(".new-terminal-machine-name")!;
  setHidden(name, !several);
  setText(name, s.machine.here ? `${s.machine.name} · this computer` : s.machine.name);
  reconcile(node.querySelector<HTMLElement>(".new-terminal-machine-places")!, s.places, (p) => p.key, createPlace, (b, p) => updatePlace(b as HTMLButtonElement, p, s.machine, starting));
}

function createPlace(): HTMLElement {
  const b = actionButton("new-terminal-place", "", "new-terminal-in");
  b.append(el("span", "place-name"), el("span", "place-path"));
  return b;
}

function updatePlace(b: HTMLButtonElement, p: Place, machine: TerminalMachine, starting: string | undefined): void {
  setData(b, "action", p.browse ? "folder-browse" : "new-terminal-in");
  setData(b, "place", p.key);
  setData(b, "node", machine.node);
  setData(b, "name", machine.name);
  setText(b.querySelector(".place-name")!, p.name);
  const path = b.querySelector<HTMLElement>(".place-path")!;
  setText(path, starting === p.key ? "Starting…" : (p.path ?? ""));
  setHidden(path, starting !== p.key && p.path === undefined);
  b.title = p.path ?? (p.browse ? `Pick a folder on ${machine.name}` : `Your home folder on ${machine.name}`);
  b.disabled = starting !== undefined;
}

/** The picker: back to the places, the folder's path to type into, the home and the roots, its folders, and Open terminal here. */
function createFolderPicker(): HTMLElement {
  const picker = el("div", "folder-picker");
  const head = el("div", "folder-head");
  const back = actionButton("folder-back", "‹", "folder-back");
  back.title = "Back to the places";
  back.setAttribute("aria-label", "Back");
  head.append(back, el("span", "folder-title"));
  const form = el("form", "folder-go");
  const input = el("input", "folder-path");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Folder");
  const go = el("button", "folder-go-button", "Go");
  go.type = "submit";
  form.append(input, go);
  const list = el("div", "folder-list");
  list.setAttribute("aria-label", "Folders");
  const here = actionButton("folder-here", "Open terminal here", "new-terminal-here");
  picker.append(head, form, el("div", "folder-roots"), el("p", "folder-status"), list, here);
  return picker;
}

/** A row of the picker: a folder in the one shown, or `..`, its parent. */
interface FolderRow {
  key: string;
  name: string;
  path: string;
  up?: true;
}

function renderFolderPicker(picker: HTMLElement, m: TerminalMenu): void {
  const b = m.browse;
  setHidden(picker, !b);
  if (!b) return;
  const listing = b.listing;
  setText(picker.querySelector(".folder-title")!, `A folder on ${b.name}`);
  // The field follows the folder shown, not each keystroke: it is set when the folder changes.
  const input = picker.querySelector<HTMLInputElement>(".folder-path")!;
  const shown = listing?.path ?? "";
  if (input.dataset["shown"] !== shown) {
    input.dataset["shown"] = shown;
    input.value = shown;
    // the deepest folder in view, not the drive
    input.scrollLeft = input.scrollWidth;
  }
  const roots = listing ? [{ label: "Home", path: listing.home }, ...listing.roots.map((r) => ({ label: r, path: r }))] : [];
  reconcile(picker.querySelector<HTMLElement>(".folder-roots")!, roots, (r) => `${r.label} ${r.path}`, (r) => {
    const chip = actionButton("folder-root", r.label, "folder-open");
    chip.dataset["path"] = r.path;
    chip.title = r.path;
    return chip;
  }, (chip, r) => setData(chip, "current", String(listing?.path === r.path)));
  const status = picker.querySelector<HTMLElement>(".folder-status")!;
  const words = b.loading !== undefined ? "Loading…" : (b.error ?? (listing?.truncated ? `The first ${listing.folders.length} folders: type a path for the rest` : listing && listing.folders.length === 0 ? "No folders in here" : ""));
  setText(status, words);
  setHidden(status, words === "");
  setData(status, "error", String(b.loading === undefined && b.error !== undefined));
  const rows: FolderRow[] = listing ? [...(listing.parent !== undefined ? [{ key: "..", name: "..", path: listing.parent, up: true as const }] : []), ...listing.folders.map((f) => ({ key: f.path, name: f.name, path: f.path }))] : [];
  reconcile(picker.querySelector<HTMLElement>(".folder-list")!, rows, (r) => r.key, createFolderRow, (n, r) => updateFolderRow(n as HTMLButtonElement, r));
  const here = picker.querySelector<HTMLButtonElement>(".folder-here")!;
  setText(here, m.starting !== undefined ? "Starting…" : "Open terminal here");
  here.disabled = !listing || b.loading !== undefined || m.starting !== undefined;
  here.title = listing ? `Start a shell in ${listing.path}` : "";
}

function createFolderRow(): HTMLElement {
  const row = actionButton("folder-row", "", "folder-open");
  row.append(el("span", "folder-mark"), el("span", "folder-name"));
  return row;
}

function updateFolderRow(row: HTMLButtonElement, r: FolderRow): void {
  setData(row, "path", r.path);
  setData(row, "up", String(r.up === true));
  setText(row.querySelector(".folder-name")!, r.name);
  row.title = r.up ? `Up to ${r.path}` : r.path;
}

/** A workspace's path as a hover title on the chips that name it. */
function workspaceTitle(w: Workspace | undefined): string {
  return w?.path ?? "";
}

// --- session panes -----------------------------------------------------------------------

function createPane(): HTMLElement {
  const root = el("article", "session");
  const head = el("header", "session-head");
  const chip = el("button", "chip");
  chip.type = "button";
  chip.dataset["action"] = "focus";
  chip.append(el("span", "dot"), el("span", "chip-harness"), el("span", "chip-profile"));
  // The tether command the chip copied, on a line of its own under the head while it is fresh.
  const copied = el("p", "session-copied");
  copied.setAttribute("role", "status");
  copied.append(el("span", "session-copied-words"), el("code", "session-copied-command"));
  // Timeline | Terminal, when the session runs in a terminal the node holds.
  const modes = el("div", "pane-mode");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Show");
  for (const [mode, label] of [["timeline", "Timeline"], ["terminal", "Terminal"]] as const) {
    const b = el("button", `pane-mode-${mode}`, label);
    b.type = "button";
    b.dataset["action"] = "pane-mode";
    b.dataset["mode"] = mode;
    modes.append(b);
  }
  // Kill session, at the far end: a second press confirms it, since a session's process does not come back.
  const kill = el("div", "session-kill");
  kill.append(
    actionButton("session-kill-start", "Kill session", "session-kill"),
    el("span", "session-kill-ask", "Kill this session?"),
    actionButton("session-kill-confirm", "Kill", "session-kill-confirm"),
    actionButton("session-kill-cancel", "Cancel", "session-kill-cancel"),
  );
  const actions = el("div", "session-actions");
  actions.append(modes, kill);
  head.append(chip, el("span", "session-intent"), el("span", "session-workspace"), el("span", "session-cwd"), el("span", "session-stats"), actions, copied);
  const body = el("div", "session-body");
  const earlier = el("button", "earlier", "Show earlier");
  earlier.type = "button";
  earlier.dataset["action"] = "earlier";
  body.append(earlier, el("ol", "timeline"));
  root.append(head, body);
  return root;
}

function updatePane(node: HTMLElement, card: SessionCard, state: ViewState, ui: UiState): void {
  const s = card.session;
  setData(node, "session", s.id);
  setData(node, "status", s.status);
  setHidden(node, ui.selected !== s.id);
  const terminal = sessionTerminal(state, s);
  const mode = paneMode(ui.modes.get(s.id), terminal !== undefined);
  setData(node, "mode", mode);
  const modes = node.querySelector<HTMLElement>(".pane-mode")!;
  setHidden(modes, terminal === undefined);
  for (const b of Array.from(modes.querySelectorAll<HTMLButtonElement>("button"))) {
    setData(b, "session", s.id);
    b.setAttribute("aria-pressed", b.dataset["mode"] === mode ? "true" : "false");
  }
  updateKill(node.querySelector<HTMLElement>(".session-kill")!, s, state, ui);
  const chip = node.querySelector<HTMLElement>(".chip")!;
  setData(chip, "session", s.id);
  // The window the session runs in, raised; a session in tether that no window shows, or a
  // background job, which has none, gets the tether command that opens one copied instead.
  const copies = s.native.terminal !== undefined || s.native.job !== undefined;
  const word = copies ? "raise its terminal window, or copy the tether command that opens one" : "raise its terminal window";
  chip.setAttribute("aria-label", `${s.harness}, ${statusWord(s)}; ${word}`);
  chip.title = copies ? "Raise its terminal window, or copy the tether command that opens one" : "Raise its terminal window";
  const copied = node.querySelector<HTMLElement>(".session-copied")!;
  const c = ui.attachCopied?.session === s.id ? ui.attachCopied : undefined;
  setHidden(copied, c === undefined);
  if (c) {
    setData(copied, "ok", c.ok ? "1" : "0");
    setText(copied.querySelector(".session-copied-words")!, c.ok ? "Tether command copied: paste it in a terminal to open this session" : "Copy this tether command and run it in a terminal to open this session");
    setText(copied.querySelector(".session-copied-command")!, c.command);
  }
  setText(chip.querySelector(".chip-harness")!, s.harness);
  setText(chip.querySelector(".chip-profile")!, profileName(state, s));
  const dot = chip.querySelector<HTMLElement>(".dot")!;
  setData(dot, "status", dotStatus(s));
  dot.title = statusWord(s);
  setText(node.querySelector(".session-intent")!, s.intent ?? s.title ?? "");
  const ws = workspaceName(state, s);
  const wsEl = node.querySelector<HTMLElement>(".session-workspace")!;
  setText(wsEl, ws ?? "");
  setHidden(wsEl, ws === undefined);
  wsEl.title = workspaceTitle(s.workspace ? state.workspaces.get(s.workspace) : undefined);
  setText(node.querySelector(".session-cwd")!, s.cwd);
  const stats = node.querySelector<HTMLElement>(".session-stats")!;
  const st = s.stats;
  setText(stats, st ? `${st.turns} turn${st.turns === 1 ? "" : "s"}, ${countWords(st.tokens.in)} in, ${countWords(st.tokens.out)} out` : "");
  setHidden(stats, !st);

  const earlier = node.querySelector<HTMLButtonElement>(".earlier")!;
  const button = earlierButton(state, card);
  setData(earlier, "session", s.id);
  setHidden(earlier, button === undefined);
  if (button) {
    earlier.disabled = button.disabled;
    setText(earlier, button.label);
  }

  const timeline = node.querySelector<HTMLElement>(".timeline")!;
  const cardKey = `session:${s.id}`;
  reconcile(timeline, selectTimeline(state, card), (r) => r.key, createRow, (li, row) => updateRow(li, row, cardKey, ui));
}

/** Kill session, or, once pressed, the question and its Kill and Cancel; Killing… until the session ends. */
function updateKill(block: HTMLElement, s: Session, state: ViewState, ui: UiState): void {
  const shown = stoppable(state, s);
  setHidden(block, !shown);
  if (!shown) return;
  const phase = ui.kill?.session === s.id ? ui.kill.phase : undefined;
  for (const b of Array.from(block.querySelectorAll<HTMLButtonElement>("button"))) setData(b, "session", s.id);
  const start = block.querySelector<HTMLButtonElement>(".session-kill-start")!;
  setHidden(start, phase !== undefined);
  start.disabled = !state.connected;
  start.title = s.origin === "orchestrator" && s.native.terminal ? "End this session and the terminal it runs in" : "End this session's process";
  setHidden(block.querySelector<HTMLElement>(".session-kill-ask")!, phase !== "asking");
  const confirm = block.querySelector<HTMLButtonElement>(".session-kill-confirm")!;
  setHidden(confirm, phase === undefined);
  setText(confirm, phase === "killing" ? "Killing…" : "Kill");
  confirm.disabled = !state.connected || phase === "killing";
  setHidden(block.querySelector<HTMLElement>(".session-kill-cancel")!, phase !== "asking");
}

function createRow(): HTMLElement {
  const li = el("li", "row");
  const main = el("span", "row-main");
  main.append(el("span", "row-label"), el("span", "row-text"));
  li.append(el("span", "row-time"), main, el("button", "row-toggle"), el("pre", "row-body"));
  const toggle = li.querySelector<HTMLButtonElement>(".row-toggle")!;
  toggle.type = "button";
  toggle.dataset["action"] = "toggle";
  return li;
}

function sendWord(state: PendingSend["state"]): string {
  switch (state) {
    case "queued":
      return "queued";
    case "held":
      return "held until the session is idle";
    case "delivered":
      return "delivered";
    case "withdrawn":
      return "withdrawn: the session never picked it up";
    case "unconfirmed":
      return "unconfirmed: the session ended first";
  }
}

interface RowView {
  kind: string;
  label: string;
  text: string;
  /** A model wrote `text`: it is drawn as markdown. */
  md?: boolean;
  body?: string;
  error?: boolean;
  at?: number;
}

function describe(row: TimelineRow): RowView {
  if (row.kind === "send") {
    return { kind: "send", label: "you", text: row.send.text, body: sendWord(row.send.state), at: row.send.at };
  }
  const e: SessionEvent = row.event;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case "status":
      return { kind: "status", label: "", text: statusWord({ status: (p["status"] as Session["status"]) ?? "idle", waiting: p["waiting"] as Session["waiting"] }), at: e.at };
    case "user_turn": {
      const peer = p["source"] === "peer";
      return { kind: "user", label: peer ? "another agent" : "you", text: String(p["text"] ?? ""), md: peer, at: e.at };
    }
    case "assistant_text":
      return { kind: "assistant", label: "assistant", text: String(p["text"] ?? ""), md: true, at: e.at };
    case "tool_call":
      return { kind: "call", label: String(p["tool"] ?? "tool"), text: firstLine(p["args"]), body: pretty(p["args"]) + (p["truncated"] ? "\n…" : ""), at: e.at };
    case "tool_result":
      return {
        kind: "result",
        label: String(p["tool"] ?? "result"),
        text: firstLine(p["result"]),
        body: pretty(p["result"]) + (p["truncated"] ? "\n…" : ""),
        error: p["isError"] === true,
        at: e.at,
      };
    case "ask": {
      const { label, text } = askEventText(p, row.ask);
      return { kind: "ask", label, text, at: e.at };
    }
    case "notification": {
      const type = String(p["type"] ?? "notification");
      if (type === "message") {
        const text = row.send?.text ?? String(p["text"] ?? "");
        const state = (p["state"] as PendingSend["state"]) ?? "delivered";
        // Over the pipe, a Claude session in a terminal reads it as another agent's message.
        const body = row.asPeer && state === "delivered" ? "delivered, as another agent's message" : sendWord(state);
        return { kind: "send", label: "you", text, body, at: e.at };
      }
      if (type === "queued") return { kind: "note", label: "queued", text: String(p["text"] ?? ""), at: e.at };
      if (type === "session_end") return { kind: "note", label: "session", text: `ending (${String(p["reason"] ?? "")})`, at: e.at };
      if (type === "backgrounded") return { kind: "note", label: "session", text: "sent to the background: it goes on as a background job", at: e.at };
      return { kind: "note", label: type.replace(/_/g, " "), text: String(p["message"] ?? ""), at: e.at };
    }
    case "ended":
      return { kind: "ended", label: "", text: `session ended${p["reason"] ? ` (${String(p["reason"])})` : ""}`, at: e.at };
  }
}

function updateRow(li: HTMLElement, row: TimelineRow, cardKey: string, ui: UiState): void {
  const v = describe(row);
  setData(li, "kind", v.kind);
  setData(li, "error", v.error ? "1" : "0");
  setData(li, "md", v.md ? "1" : "0");
  setText(li.querySelector(".row-time")!, v.at !== undefined ? clock(v.at) : "");
  const label = li.querySelector<HTMLElement>(".row-label")!;
  setText(label, v.label);
  setHidden(label, v.label === "");
  renderText(li.querySelector<HTMLElement>(".row-text")!, v.text, v.md === true);
  const toggle = li.querySelector<HTMLButtonElement>(".row-toggle")!;
  const body = li.querySelector<HTMLElement>(".row-body")!;
  const key = `${cardKey}/${row.key}`;
  const collapsible = v.body !== undefined && v.body !== "" && v.kind !== "send";
  const open = ui.expanded.has(key);
  setHidden(toggle, !collapsible);
  setData(toggle, "target", key);
  setText(toggle, open ? "Hide" : "Show");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (v.kind === "send") {
    setText(body, v.body ?? "");
    setHidden(body, false);
    setData(body, "receipt", "1");
  } else {
    setText(body, open ? (v.body ?? "") : "");
    setHidden(body, !(collapsible && open));
    setData(body, "receipt", "0");
  }
}

// --- audit rows ------------------------------------------------------------------------------

function principalWord(e: AuditEntry, state: ViewState): string {
  const p = e.principal;
  switch (p.kind) {
    case "user":
      return state.client && p.client === state.client.id ? "you" : `a client (${p.client.replace(/^cli_/, "").slice(0, 6)})`;
    case "brain":
      return "the brain";
    case "node":
      return `node ${p.id.replace(/^node_/, "").slice(0, 6)}`;
    case "harness":
      return `session ${p.session.replace(/^sess_/, "").slice(0, 6)}`;
    case "system":
      return "cophylad";
  }
}

function createAudit(): HTMLElement {
  const root = el("div", "audit");
  const line = el("div", "audit-line");
  line.append(el("span", "audit-time"), el("span", "audit-who"), sessionChip("audit-session"), el("span", "audit-action"), el("span", "audit-target"), el("span", "audit-outcome"), el("span", "audit-duration"), el("button", "audit-toggle"));
  const toggle = line.querySelector<HTMLButtonElement>(".audit-toggle")!;
  toggle.type = "button";
  toggle.dataset["action"] = "toggle";
  root.append(line, el("pre", "audit-args"));
  return root;
}

function updateAudit(node: HTMLElement, entry: AuditEntry, state: ViewState, ui: UiState): void {
  setData(node, "audit", entry.id);
  setData(node, "decision", entry.decision);
  setData(node, "outcome", entry.outcome ?? "pending");
  setText(node.querySelector(".audit-time")!, clock(entry.at));
  const who = node.querySelector<HTMLElement>(".audit-who")!;
  setText(who, principalWord(entry, state));
  updateSessionChip(node.querySelector<HTMLElement>(".audit-session")!, who, entry.principal.kind === "harness" ? state.sessions.get(entry.principal.session) : undefined);
  setText(node.querySelector(".audit-action")!, entry.action);
  const target = node.querySelector<HTMLElement>(".audit-target")!;
  setText(target, entry.target ?? "");
  setHidden(target, entry.target === undefined);
  const outcome = entry.outcome ?? (entry.decision === "ask" ? "waiting for an answer" : "running");
  const decision = entry.decision === "allow" ? "" : `${entry.decision} → `;
  const summary = entry.result?.summary && entry.outcome === "error" ? `: ${firstLine(entry.result.summary, 80)}` : "";
  setText(node.querySelector(".audit-outcome")!, `${decision}${outcome}${summary}`);
  setText(node.querySelector(".audit-duration")!, entry.durationMs !== undefined ? `${entry.durationMs} ms` : "");
  const key = `audit:${entry.id}/args`;
  const open = ui.expanded.has(key);
  const args = pretty(entry.args);
  const toggle = node.querySelector<HTMLButtonElement>(".audit-toggle")!;
  const hasArgs = args !== "" && args !== "{}" && args !== "null";
  setHidden(toggle, !hasArgs);
  setData(toggle, "target", key);
  setText(toggle, open ? "Hide" : "Show");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  const pre = node.querySelector<HTMLElement>(".audit-args")!;
  setText(pre, open ? args : "");
  setHidden(pre, !open);
}

// --- the conversation --------------------------------------------------------------------

function createThread(): HTMLElement {
  const root = el("div", "thread");
  const line = el("div", "thread-line");
  line.append(el("span", "thread-time"), el("span", "thread-topic"), el("span", "thread-workspace"));
  root.append(line);
  return root;
}

function updateThread(node: HTMLElement, thread: Thread, state: ViewState): void {
  setData(node, "thread", thread.id);
  setData(node, "open", thread.endedAt === undefined ? "1" : "0");
  setText(node.querySelector(".thread-time")!, clock(thread.startedAt));
  setText(node.querySelector(".thread-topic")!, thread.topic ?? "New thread");
  const w = thread.workspace ? state.workspaces.get(thread.workspace) : undefined;
  const wsEl = node.querySelector<HTMLElement>(".thread-workspace")!;
  setText(wsEl, w?.name ?? "");
  setHidden(wsEl, w === undefined);
  wsEl.title = workspaceTitle(w);
}

function createMessage(): HTMLElement {
  const root = el("article", "message");
  const head = el("header", "message-head");
  head.append(el("span", "message-who"), el("span", "message-time"));
  root.append(head, createSteps(), el("div", "message-body"));
  return root;
}

/** What a reply's turn did, folded to one line above its words: the count and the steps, opened for the list. */
function createSteps(): HTMLElement {
  const root = el("details", "message-steps");
  const summary = el("summary");
  summary.append(el("span", "steps-count"), el("span", "steps-line"));
  root.append(summary, el("ol", "steps-list"));
  root.hidden = true;
  return root;
}

function updateSteps(node: HTMLElement, steps: TurnStep[] | undefined): void {
  const root = node.querySelector<HTMLElement>(".message-steps")!;
  setHidden(root, !steps?.length);
  if (!steps?.length) return;
  setText(root.querySelector(".steps-count")!, steps.length === 1 ? "1 step" : `${steps.length} steps`);
  setText(root.querySelector(".steps-line")!, steps.map((s) => s.text).join(" · "));
  reconcile(
    root.querySelector<HTMLElement>(".steps-list")!,
    steps.map((step, i) => ({ step, i })),
    (s) => String(s.i),
    () => {
      const li = el("li", "progress-step");
      li.append(el("span", "progress-mark"), el("span", "progress-text"));
      return li;
    },
    (li, { step }) => {
      setData(li, "status", step.status);
      setText(li.querySelector(".progress-mark")!, STEP_MARK[step.status]);
      setText(li.querySelector(".progress-text")!, step.text);
    },
  );
}

const ROLE_WORD: Record<Message["role"], string> = { user: "you", orchestrator: "Cophyla", system: "system" };

function updateMessage(node: HTMLElement, message: Message, state: ViewState): void {
  // A reply that streamed keeps its element under the same key: it stops being a stream here.
  if (node.classList.contains("streaming")) {
    node.classList.remove("streaming");
    node.querySelector(".message-head .pulse")?.remove();
  }
  setData(node, "message", message.id);
  setData(node, "role", message.role);
  setData(node, "source", message.source);
  setText(node.querySelector(".message-who")!, ROLE_WORD[message.role]);
  setText(node.querySelector(".message-time")!, clock(message.at));
  updateSteps(node, message.steps);
  renderBlocks(node.querySelector<HTMLElement>(".message-body")!, message.content, state, message.role !== "user");
}

/** A reply while it streams: a message's element with a pulse for the time, so the final message can take it over. */
function createStreaming(): HTMLElement {
  const root = el("article", "message streaming");
  const head = el("header", "message-head");
  head.append(el("span", "message-who", "Cophyla"), el("span", "message-time"), el("span", "pulse"));
  root.append(head, createSteps(), el("div", "message-body"));
  return root;
}

function updateStreaming(node: HTMLElement, streaming: Streaming, state: ViewState): void {
  setData(node, "message", streaming.id);
  setData(node, "role", "orchestrator");
  updateSteps(node, streaming.steps);
  renderBlocks(node.querySelector<HTMLElement>(".message-body")!, streaming.blocks.filter((b) => b !== undefined), state, true);
}

/** This view's utterance as it is heard: a user message's element, faint, with a pulse for the time until the message itself lands. */
function createHeard(): HTMLElement {
  const root = el("article", "message heard");
  root.setAttribute("aria-live", "polite");
  const head = el("header", "message-head");
  head.append(el("span", "message-who", "you"), el("span", "message-time"), el("span", "pulse"));
  root.append(head, el("div", "message-body"));
  return root;
}

function updateHeard(node: HTMLElement, heard: HeardWords, state: ViewState): void {
  setData(node, "role", "user");
  setData(node, "source", "voice");
  setText(node.querySelector(".message-time")!, clock(heard.at));
  renderBlocks(node.querySelector<HTMLElement>(".message-body")!, [{ type: "text", text: heard.text }], state, false);
}

/** What the orchestrator is doing while its turn runs: why it woke when the user did not wake it, each step so far, and Thinking while a model call is out. */
function createProgress(): HTMLElement {
  const root = el("div", "progress");
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "What Cophyla is doing");
  const now = el("div", "progress-now");
  now.append(el("span", "pulse"), el("span", "progress-text", "Thinking…"));
  root.append(el("div", "progress-about"), el("ol", "progress-steps"), now);
  return root;
}

const STEP_MARK: Record<TurnStep["status"], string> = { running: "", done: "✓", failed: "✕" };

function updateProgress(node: HTMLElement, progress: TurnProgress): void {
  const about = node.querySelector<HTMLElement>(".progress-about")!;
  setText(about, progress.about ?? "");
  setHidden(about, progress.about === undefined);
  const steps = node.querySelector<HTMLElement>(".progress-steps")!;
  // Steps only ever grow within a turn, and change in place from running to done.
  reconcile(
    steps,
    progress.steps.map((step, i) => ({ step, i })),
    (s) => String(s.i),
    () => {
      const li = el("li", "progress-step");
      li.append(el("span", "progress-mark"), el("span", "progress-text"));
      return li;
    },
    (li, { step }) => {
      setData(li, "status", step.status);
      const mark = li.querySelector<HTMLElement>(".progress-mark")!;
      setText(mark, STEP_MARK[step.status]);
      mark.classList.toggle("pulse", step.status === "running");
      setText(li.querySelector(".progress-text")!, step.text);
    },
  );
  setHidden(steps, progress.steps.length === 0);
  setHidden(node.querySelector<HTMLElement>(".progress-now")!, !progress.thinking);
}

function createTask(): HTMLElement {
  const root = el("div", "task");
  root.append(el("span", "task-status"), el("span", "task-title"), el("span", "task-trigger"), el("span", "task-blocker"), sessionChip("task-session"), el("span", "task-workspace"), el("span", "task-actions"));
  return root;
}

const TASK_ACTION_LABEL: Record<TaskAction, string> = { pause: "pause", resume: "resume", complete: "done" };

function blockerWord(task: Task, state: ViewState): string {
  const b = task.blocker;
  if (!b) return "";
  switch (b.kind) {
    case "user":
      return "waiting on you";
    case "ask": {
      const ask = state.asks.get(b.ask);
      return ask ? `waiting on: ${ask.title}` : "waiting on a prompt";
    }
    case "task":
      return `after ${state.tasks.get(b.task)?.title ?? "another task"}`;
    case "session": {
      const card = state.sessions.get(b.session);
      const name = card ? (card.session.title ?? card.session.intent) : undefined;
      return card ? `with ${card.session.harness}${name ? `: ${name}` : ""}` : "with an agent";
    }
  }
}

function updateTask(node: HTMLElement, task: Task, state: ViewState): void {
  setData(node, "task", task.id);
  setData(node, "status", task.status);
  setData(node, "priority", task.priority);
  setText(node.querySelector(".task-status")!, task.status);
  setText(node.querySelector(".task-title")!, task.title);
  const blocker = node.querySelector<HTMLElement>(".task-blocker")!;
  const word = blockerWord(task, state);
  setText(blocker, word);
  // Waiting with an agent still at it: the agent's chip in the words' place.
  updateSessionChip(node.querySelector<HTMLElement>(".task-session")!, blocker, task.blocker?.kind === "session" ? state.sessions.get(task.blocker.session) : undefined);
  if (word === "") setHidden(blocker, true);
  const ws = task.workspace ? state.workspaces.get(task.workspace)?.name : undefined;
  const wsEl = node.querySelector<HTMLElement>(".task-workspace")!;
  setText(wsEl, ws ?? "");
  setHidden(wsEl, ws === undefined);
  const trigger = node.querySelector<HTMLElement>(".task-trigger")!;
  const when = triggerWords(task);
  setText(trigger, when);
  setHidden(trigger, when === "");
  const actions = node.querySelector<HTMLElement>(".task-actions")!;
  const wanted = taskActions(task, state.scopes);
  const have = [...actions.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.dataset["action"]?.replace(/^task-/, ""));
  if (have.join(",") !== wanted.join(",")) {
    actions.replaceChildren(
      ...wanted.map((action) => {
        const button = el("button", "task-action", TASK_ACTION_LABEL[action]) as HTMLButtonElement;
        button.type = "button";
        button.dataset["action"] = `task-${action}`;
        button.dataset["task"] = task.id;
        return button;
      }),
    );
  }
  setHidden(actions, wanted.length === 0);
}

// --- the stream ------------------------------------------------------------------------------

function createItem(item: StreamItem): HTMLElement {
  switch (item.kind) {
    case "ask":
      return createAsk();
    case "audit":
      return createAudit();
    case "thread":
      return createThread();
    case "message":
      return createMessage();
    case "streaming":
      return createStreaming();
    case "progress":
      return createProgress();
    case "heard":
      return createHeard();
    case "task":
      return createTask();
  }
}

function updateItem(node: HTMLElement, item: StreamItem, state: ViewState, ui: UiState): void {
  switch (item.kind) {
    case "ask":
      return updateAsk(node, item.ask, state);
    case "audit":
      return updateAudit(node, item.entry, state, ui);
    case "thread":
      return updateThread(node, item.thread, state);
    case "message":
      return updateMessage(node, item.message, state);
    case "streaming":
      return updateStreaming(node, item.streaming, state);
    case "progress":
      return updateProgress(node, item.progress);
    case "heard":
      return updateHeard(node, item.heard, state);
    case "task":
      return updateTask(node, item.task, state);
  }
}

function ensureEmpty(stream: HTMLElement, state: ViewState): void {
  let empty = stream.querySelector<HTMLElement>(".empty");
  const show = state.audit.size === 0 && state.messages.size === 0 && state.streaming.size === 0 && state.tasks.size === 0 && heardText(state) === "";
  if (show && !empty) {
    empty = el("p", "empty");
    stream.prepend(empty);
  }
  if (empty) {
    setHidden(empty, !show);
    setText(empty, state.connected ? "Nothing yet. Ask about the work below." : "Waiting for cophylad.");
  }
}

/** The button at the top of the chat: Load history on a phone before anything is loaded, then Earlier; its action follows. */
function ensureEarlier(stream: HTMLElement, state: ViewState): void {
  let earlier = stream.querySelector<HTMLButtonElement>(".threads-earlier");
  if (!earlier) {
    earlier = el("button", "threads-earlier", "Earlier");
    earlier.type = "button";
    earlier.dataset["action"] = "threads-earlier";
    stream.prepend(earlier);
  }
  const button = chatButton(state);
  setHidden(earlier, button === undefined);
  if (!button) return;
  setData(earlier, "action", button.action);
  earlier.disabled = button.disabled;
  setText(earlier, button.label);
}

/** A loudspeaker with its waves, and the line that strikes it through when what was to be read out is hushed; in the button's own colour. */
function speakerIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const parts: [string, string][] = [
    ["body", "M4 9.5h3.5L12 6v12l-4.5-3.5H4z"],
    ["waves", "M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"],
    ["strike", "M4.5 4.5l15 15"],
  ];
  for (const [name, d] of parts) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", name);
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

/** A microphone, drawn in the button's own colour. */
function micIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const body = document.createElementNS(SVG_NS, "rect");
  for (const [k, v] of Object.entries({ x: "9", y: "3", width: "6", height: "11", rx: "3" })) body.setAttribute(k, v);
  const cup = document.createElementNS(SVG_NS, "path");
  cup.setAttribute("d", "M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7");
  for (const part of [body, cup]) {
    part.setAttribute("fill", "none");
    part.setAttribute("stroke", "currentColor");
    part.setAttribute("stroke-width", "1.8");
    part.setAttribute("stroke-linecap", "round");
  }
  svg.append(body, cup);
  return svg;
}

/** What the phone is doing, over the composer: the dot, the word and whose phone it is; or why a press or the microphone went wrong. */
function renderVoice(root: HTMLElement, state: ViewState): void {
  let row = root.querySelector<HTMLElement>(".voice-row");
  if (!row) {
    row = el("div", "voice-row");
    row.append(el("span", "dot"), el("span", "voice-words"));
    root.prepend(row);
  }
  const words = voiceWords(state);
  setHidden(row, words === "");
  if (words === "") return;
  setData(row.querySelector<HTMLElement>(".dot")!, "status", voiceDot(state));
  setText(row.querySelector(".voice-words")!, words);
}

/** The session whose pane shows its terminal, if the selected one's does. */
function terminalSession(state: ViewState, ui: UiState): string | undefined {
  const card = ui.selected !== undefined ? state.sessions.get(ui.selected) : undefined;
  return card !== undefined && paneMode(ui.modes.get(card.session.id), sessionTerminal(state, card.session) !== undefined) === "terminal" ? card.session.id : undefined;
}

/** A terminal fills the pane: a bare one's tab, or a session's shown on its terminal. */
function terminalShown(state: ViewState, ui: UiState): boolean {
  return ui.terminal !== undefined || terminalSession(state, ui) !== undefined;
}

/**
 * A message field: a textarea a line high, over an unseen copy of its text that grows it with
 * its lines (view.css). Enter sends, Shift+Enter starts a line.
 */
function messageField(className: string, placeholder: string): HTMLElement {
  const box = el("div", "field");
  const copy = el("div", "field-copy");
  copy.setAttribute("aria-hidden", "true");
  const input = el("textarea", className);
  input.name = "text";
  input.rows = 1;
  input.autocomplete = "off";
  input.placeholder = placeholder;
  // A phone's keyboard labels its Enter Send, which it does here.
  input.enterKeyHint = "send";
  box.append(copy, input);
  return box;
}

/** Copies a message field's text into its unseen twin, which sizes it: after it changes other than by typing too. */
export function fitField(input: HTMLTextAreaElement): void {
  const copy = input.previousElementSibling;
  // With a space after it, a last empty line is a line too.
  if (copy?.classList.contains("field-copy")) setText(copy, `${input.value} `);
}

/** The input under the pane: the chat's, or the selected session's send when its timeline shows. */
function renderComposer(root: HTMLElement, state: ViewState, ui: UiState): void {
  let form = root.querySelector<HTMLFormElement>("form.composer-form");
  if (!form) {
    form = el("form", "composer-form");
    const quick = el("button", "quick", "Quick");
    quick.type = "button";
    quick.dataset["action"] = "quick";
    quick.title = "Answer from what Cophyla already knows, with no tool calls";
    const field = messageField("composer-text", "Ask about the work");
    const button = el("button", "composer-button", "Send");
    button.type = "submit";
    // Held, Cophyla listens (`voice.ptt`); let go, what was said is sent as if typed.
    const talk = el("button", "talk");
    talk.type = "button";
    talk.append(micIcon());
    form.append(quick, field, talk, button);
    root.append(form);
  }
  // Under a terminal there is no input at all: the terminal takes the typing.
  setHidden(root, terminalShown(state, ui));
  setHidden(form, ui.selected !== undefined || ui.terminal !== undefined);
  const canChat = state.connected && state.scopes.includes("chat");
  const input = form.querySelector<HTMLTextAreaElement>(".composer-text")!;
  input.disabled = !canChat;
  input.placeholder = canChat ? (state.quick ? "Quick question" : "Ask about the work") : state.connected ? "This view may not chat" : "Waiting for cophylad";
  fitField(input);
  form.querySelector<HTMLButtonElement>(".composer-button")!.disabled = !canChat;
  const quick = form.querySelector<HTMLButtonElement>(".quick")!;
  quick.disabled = !canChat;
  quick.setAttribute("aria-pressed", state.quick ? "true" : "false");
  const talk = form.querySelector<HTMLButtonElement>(".talk")!;
  const canTalk = state.hostTalk && state.connected && state.scopes.includes("voice");
  setHidden(talk, !state.hostTalk);
  talk.disabled = !canTalk;
  talk.setAttribute("aria-pressed", ui.talking ? "true" : "false");
  const off = micOff(state);
  setData(talk, "mic", off !== undefined ? "off" : "on");
  const talkWords = !state.connected ? "Waiting for cophylad" : !canTalk ? "This view may not listen" : off !== undefined ? `The microphone is off: ${off}` : "Hold to talk";
  if (talk.title !== talkWords) {
    talk.title = talkWords;
    talk.setAttribute("aria-label", talkWords);
  }
  renderSend(root, state, ui);
  renderVoice(root, state);
  const errors = state.errors.slice(-1)[0];
  let err = root.querySelector<HTMLElement>(".composer-error");
  if (errors && !err) {
    err = el("p", "composer-error");
    root.append(err);
  }
  if (err) {
    setText(err, errors ?? "");
    setHidden(err, !errors);
  }
}

/** One send form for whichever session is selected; the draft lives in the model, so the form swaps with the tab. */
function renderSend(root: HTMLElement, state: ViewState, ui: UiState): void {
  let form = root.querySelector<HTMLFormElement>("form.send");
  if (!form) {
    form = el("form", "send");
    const button = el("button", "send-button", "Send");
    button.type = "submit";
    form.append(messageField("send-text", "Message this session"), button);
    root.prepend(form);
  }
  const card = ui.selected !== undefined ? state.sessions.get(ui.selected) : undefined;
  setHidden(form, card === undefined);
  if (!card) return;
  const s = card.session;
  const switched = form.dataset["session"] !== s.id;
  setData(form, "session", s.id);
  const input = form.querySelector<HTMLTextAreaElement>(".send-text")!;
  if (switched || (document.activeElement !== input && input.value !== card.draft)) input.value = card.draft;
  fitField(input);
  const canSend = state.connected && s.status !== "ended";
  input.disabled = !canSend;
  input.placeholder = canSend ? `Message ${s.harness}` : s.status === "ended" ? "This session has ended" : "Waiting for cophylad";
  form.querySelector<HTMLButtonElement>(".send-button")!.disabled = !canSend;
}

/** The pane that shows: the chat stream or the selected session's. */
export function activePane(roots: Roots): HTMLElement | undefined {
  if (!roots.stream.hidden) return roots.stream;
  for (const child of Array.from(roots.sessions.children) as HTMLElement[]) if (!child.hidden) return child;
  return undefined;
}

export function render(roots: Roots, state: ViewState, ui: UiState, opts: RenderOptions = {}): void {
  if (ui.selected !== undefined && !state.sessions.has(ui.selected)) ui.selected = undefined;
  if (ui.terminal !== undefined && (!state.terminals.has(ui.terminal) || !state.scopes.includes("terminal"))) ui.terminal = undefined;
  const before = activePane(roots);
  const atBottom = before !== undefined && before.scrollHeight - before.scrollTop - before.clientHeight < 8;
  const heightBefore = before?.scrollHeight ?? 0;
  const topBefore = before?.scrollTop ?? 0;

  const { pinned, items } = selectStream(state, terminalSession(state, ui));
  renderPinned(roots.pinned, pinned, state, ui);
  // The rail is put away or shown only where the user did it; the CSS keeps each width's own otherwise.
  if (ui.rail) setData(roots.app, "rail", ui.rail);
  else delete roots.app.dataset["rail"];
  setData(roots.app, "menu", state.hostMenu ? "host" : "view");
  renderRailbar(roots.railbar, state, ui, opts.railShown ?? false);
  renderTabs(roots.tabs, state, ui);
  renderFileMenu(roots.app, state, ui);
  setHidden(roots.stream, ui.selected !== undefined || ui.terminal !== undefined);
  setHidden(roots.terminal, ui.terminal === undefined);
  ensureEmpty(roots.stream, state);
  ensureEarlier(roots.stream, state);
  // Keyed children live in their own holder, so the empty-state paragraph never moves them.
  let holder = roots.stream.querySelector<HTMLElement>(".items");
  if (!holder) {
    holder = el("div", "items");
    roots.stream.append(holder);
  }
  reconcile(holder, items, keyOf, createItem, (node, item) => updateItem(node, item, state, ui));
  reconcile(roots.sessions, [...state.sessions.values()], (c) => c.session.id, createPane, (node, c) => updatePane(node, c, state, ui));
  renderComposer(roots.composer, state, ui);
  renderDevices(roots.devices, state, ui);

  // A pane just switched to opens at its newest; one that stayed keeps the user's place.
  const after = activePane(roots);
  if (!after) return;
  if (after !== before) after.scrollTop = after.scrollHeight;
  else if (opts.anchor) after.scrollTop = topBefore + (after.scrollHeight - heightBefore);
  else if (atBottom) after.scrollTop = after.scrollHeight;
}
