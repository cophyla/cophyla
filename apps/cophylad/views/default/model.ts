// The default view's state and its reducer, pure: no DOM, no rpc. `apply` folds what the
// host says (notifications, host.ready, host.state) and what the user does (the tab opened,
// drafts, sends, history pages) into one `ViewState`; the selectors below shape it for
// rendering, and the few decisions the view makes on the host's line (which session to
// watch, whether to load history unasked) are small functions here too. A session's card
// holds a timeline only while its tab is open: the events streamed since, and the pages
// loaded; a session that ends leaves, card and all. The rail groups the live sessions by the
// folder they work in, a workspace inside another's under it. A node's spend is the node's own totals for the day, with the live
// samples added, beside each login's plan limits as the node's latest sample carries them.
// The node's terminals are rows too: a session's own is reached from its pane, and the bare
// ones (a shell the user started here, in a workspace they picked) get tabs of their own,
// under Terminals, named by where they work; one whose agent CLI waits for its first prompt
// stands with the sessions in its folder instead.
// The grants are rows too: each phone and node with its access and its end, an invite just
// minted while its panel shows, the ones still pending, and what the desktop offers this node
// (Join a primary while it is alone, Leave once it joined one).
// A session's explorer is rows too: the folders under its directory as listed so far, kept per
// folder a session works in so the sessions there share them, and its repository as a status
// bar has it.
// This view's own utterance shows at the chat's end as it is heard (`voice.partial`), a ghost
// of the message it becomes, until that message lands; near its limit the voice row counts
// down, and one the node stopped before the user did says so until the next. The speaker
// beside the chat's tab says whether the next reply is read out (`voice.next`), and where.
// What the brain sees on its next turn (`brain.context`) is shown a block at a time, in words.
// Types come from the protocol package; nothing else does, so the file runs in the frame as is.

import type { Access, Ask, AskAnswer, AuditEntry, BackupState, BrainContext, Client, ClientNotificationParams, ContentBlock, Controller, DisplaySize, FileText, FolderListing, GitState, Grant, GrantKind, GrantRole, HarnessProfile, LimitWindow, Message, MetricsSample, Node, NodeId, Platform, ProcessOwner, ProfileLimits, RemoteHost, RemoteState, RemoteViewer, Scope, ClientSession as Session, SessionEvent, SpendTotals, Task, Terminal, ClientThread as Thread, TurnProgress, TurnStep, ViewManifest, VoiceState, VoiceStopped, VoiceUnheard, ClientWorkspace as Workspace } from "@cophyla/protocol";

/**
 * Why this view's last utterance came to less than was said: a press that came to nothing
 * (`unheard`), until the next utterance or `VOICE_NOTE_MS`; or one the node stopped hearing
 * while the user still spoke (`stopped`, at the `limit` it had), until this view's next one.
 */
export type VoiceNote = { unheard: VoiceUnheard; at: number } | { stopped: VoiceStopped; limit?: number; at: number };

/** How long the voice row says why a press came to nothing. */
export const VOICE_NOTE_MS = 8000;

/** The conversation on a controller, as the view last heard it. */
export interface VoiceRow {
  state: VoiceState;
  /** The controller it belongs to, when the platform named one. */
  client?: string;
  /** While listening: the seconds the utterance may last, counted from `at`. */
  limit?: number;
  at: number;
}

/** The words heard so far of this view's own utterance, as `voice.partial` grows them; the `message` it became, once the node names it. */
export interface HeardWords {
  text: string;
  at: number;
  message?: string;
}

/** `voice.partial`: the words after the first `from` characters of the ones before. */
export type VoicePartial = ClientNotificationParams<"voice.partial">;

export type VoiceSetup = ClientNotificationParams<"voice.setup">;
/** `voice.next`: whether the next reply or result is read out, where, and whether it was hushed. */
export type VoiceNext = ClientNotificationParams<"voice.next">;

/** The account as the node sees it: `account.state`. */
export type AccountState = ClientNotificationParams<"account.state">;
/** A node's direct connections: `direct.state`. */
export type DirectState = ClientNotificationParams<"direct.state">;

/** A login the user started, with the code to type on the page, until it is used or runs out. */
export interface LoginOffer {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

/** A pairing window the user opened, with the code the phone must type. */
export interface PairingOffer {
  code: string;
  url: string;
  expiresAt: number;
}

/** A code a node's desktop host minted for a phone, shown until it runs out or is closed. */
export interface RemoteInvite {
  node: NodeId;
  otp: string;
  link?: string;
  passphrase?: string;
  expiresAt?: number;
}

/** Tokens and cost, summed. */
export interface Spend {
  in: number;
  out: number;
  cached: number;
  cost: number;
}

/** A sample's time and token deltas: all the spend needs of it. */
export type SpendDelta = Pick<MetricsSample, "at" | "profiles">;

/**
 * What one node's sessions have spent per profile, and the newest sample counted, so a
 * sample the node's totals already hold, or a replayed frame, counts once.
 */
export interface NodeSpend {
  seen: number;
  byProfile: Map<string, Spend>;
  /**
   * While the node's totals are awaited after a subscription, the samples that land meanwhile:
   * counted once the totals arrive, those they do not already hold. `byProfile` shows what it
   * showed until then.
   */
  held?: SpendDelta[];
}

export type SendState = "queued" | "held" | "delivered" | "withdrawn" | "unconfirmed";

export interface PendingSend {
  ref: string;
  text: string;
  at: number;
  state: SendState;
}

export interface SessionCard {
  session: Session;
  /**
   * The tab is open: the node streams its events here, and its history pages back from
   * `oldestSeq`. A closed tab's card holds no timeline and no pending sends, only its draft.
   */
  open: boolean;
  /** Counts the tab's openings: a history page asked for under an earlier one is dropped. */
  opened: number;
  events: Map<number, SessionEvent>;
  /** The lowest seq loaded; `session.history {before}` pages from here. */
  oldestSeq?: number;
  /** A page came back short: there is nothing earlier. */
  exhausted: boolean;
  loading: boolean;
  draft: string;
  sends: Map<string, PendingSend>;
  /** It finished its work (went idle) while its tab was not open, and the tab has not been opened since. */
  unseen: boolean;
}

/**
 * What the explorer shows of a folder a session works in: the folder as its node spells it,
 * once listed; each folder under it listed so far, by its path there (`""` the folder itself);
 * the ones asked for and not answered yet; why the last listing failed, when it did; and its
 * repository as last read, when it is in one.
 */
export interface Explorer {
  root?: string;
  dirs: Map<string, FolderListing>;
  loading: Set<string>;
  error?: string;
  git?: GitState;
}

export interface HostReady {
  client: Client;
  node: NodeId;
  protocolVersion: number;
  platformVersion: string;
  view: ViewManifest;
  scopes: Scope[];
  /** The host has a menu button of its own, under the frame, that sends `host.menu`: the phone's bar. */
  menu?: boolean;
  /** The host has a microphone and no talk button of its own: the view draws one, holding `voice.ptt`. */
  talk?: boolean;
  /** What this view last saved with `host.savePrefs` on this device. */
  prefs?: Record<string, unknown>;
  /** The host names files dropped here from the desktop (`host.filePaths`): the desktop app. */
  filePaths?: boolean;
  /** Where the host serves the document frame, in which an HTML file's scripts run apart from the view (@cophyla/protocol's docframe.ts). */
  docFrame?: string;
  /** The host lays a stream page over the view where the view places it (`host.open {embed}`, `host.place`, `host.close`): the desktop app. */
  embed?: boolean;
}

/** A reply still streaming: `chat.delta` blocks under a message id the final `chat.message` reuses, or dropped by a `chat.retract`. */
export interface Streaming {
  id: string;
  at: number;
  blocks: ContentBlock[];
  /** What the turn did before the reply began, folded above it as the stored message will have it. */
  steps?: TurnStep[];
}

export interface ViewState {
  client?: Client;
  node?: NodeId;
  platformVersion?: string;
  /** The host's own button shows and hides the rail (`host.menu`), so the view draws none. */
  hostMenu: boolean;
  /** The host has a microphone and no talk button: the composer has one (the desktop app). */
  hostTalk: boolean;
  /** Why the host's microphone is off, while it is (`host.mic`): its device went away, or none could be had. */
  hostMic?: string;
  /** The host names files dropped from the desktop, so a drop of them lands as their paths. */
  hostFilePaths: boolean;
  /** Where the host serves the document frame; none on a host too old to serve it, which draws an HTML file with no scripts. */
  hostDocFrame?: string;
  /** The host lays another node's desktop over the view, beside the pane: the desktop app. */
  hostEmbed: boolean;
  connected: boolean;
  scopes: Scope[];
  sessions: Map<string, SessionCard>;
  /** The node's terminals, from `terminal.list` and `terminal.state`, while connected. */
  terminals: Map<string, Terminal>;
  /** What each folder a session works in shows in the explorer, by `explorerKey`. */
  explorers: Map<string, Explorer>;
  asks: Map<string, Ask>;
  /** The newest AUDIT_KEEP entries by `at`. */
  audit: Map<string, AuditEntry>;
  workspaces: Map<string, Workspace>;
  profiles: Map<string, HarnessProfile>;
  threads: Map<string, Thread>;
  messages: Map<string, Message>;
  streaming: Map<string, Streaming>;
  /** The orchestrator's turn while it runs: what it has done so far and whether it is thinking. */
  progress?: TurnProgress;
  tasks: Map<string, Task>;
  /** What voice is doing now; absent when nothing is. */
  voice?: VoiceRow;
  /** Why this view's last press came to nothing, for a while after (`unheard` on its `idle`), or that the node stopped hearing it (`stopped`). */
  voiceNote?: VoiceNote;
  /** This view's own utterance as it is heard and transcribed, until the message it became lands. */
  heard?: HeardWords;
  /** An engine being set up on the node, while it runs. */
  setup?: VoiceSetup;
  /** Whether the next reply is read out, as the node last said; absent until it says, which an older node never does. */
  next?: VoiceNext;
  /** The pairing window, while it is open. */
  pairing?: PairingOffer;
  controllers: Map<string, Controller>;
  /** Every grant this node keeps, from `grant.list`: its phones and nodes, the pending ones among them. */
  grants: Map<string, Grant>;
  /** The invite just minted, while its panel shows. */
  invite?: IssuedInvite;
  /** Every node of the user, from `node.list` and `node.state`. */
  nodes: Map<NodeId, Node>;
  /** The latest sample per node, while connected. */
  metrics: Map<NodeId, MetricsSample>;
  /** Spend per node over the day: the node's totals, then each live sample; kept across a disconnect until the next totals replace it. */
  spend: Map<NodeId, NodeSpend>;
  /** Each node's desktop host and its viewers, from `remote.state`, while connected. */
  remote: Map<NodeId, RemoteState>;
  /** Each node's direct connections, from `direct.state`, while connected. */
  direct: Map<NodeId, DirectState>;
  /** The phone code the user asked a node for, while it is shown. */
  remoteInvite?: RemoteInvite;
  /** The node whose PIN form is open. */
  remotePin?: NodeId;
  /** The account: signed out until the node says otherwise. */
  account?: AccountState;
  /** The login in progress, while its code is shown. */
  login?: LoginOffer;
  /** The composer's quick toggle: the next message goes out with `mode: quick`. */
  quick: boolean;
  /** `chat.load` has answered once since connecting. */
  chatLoaded: boolean;
  /** The earliest thread loaded; `chat.load {before}` pages from here. */
  oldestThread?: string;
  /** A page came back short: there is no earlier thread. */
  threadsExhausted: boolean;
  chatLoading: boolean;
  errors: string[];
}

export type Action =
  | { type: "host.ready"; params: HostReady }
  | { type: "host.state"; params: { connected: boolean } }
  | { type: "session.state"; params: Session }
  | { type: "session.event"; params: SessionEvent }
  | { type: "terminal.state"; params: Terminal }
  | { type: "terminals"; terminals: Terminal[] }
  | { type: "workspace.state"; params: Workspace }
  | { type: "ask.state"; params: Ask }
  | { type: "audit.entry"; params: AuditEntry }
  | { type: "profiles"; profiles: HarnessProfile[] }
  /** The tab the user is on, the chat when `session` is absent: it opens afresh, and every other card drops its timeline. */
  | { type: "tab.open"; session?: string }
  | { type: "history.loading"; session: string }
  /** A page of a tab's history, asked for under its opening `opened`. */
  | { type: "history"; session: string; opened: number; events: SessionEvent[]; limit: number }
  | { type: "draft"; session: string; text: string }
  /** Folders of an explorer were asked for. */
  | { type: "files.loading"; place: string; dirs: string[] }
  /** The folders asked for came back, or why they did not (`error`). */
  | { type: "files"; place: string; asked: string[]; root?: string; dirs?: FolderListing[]; error?: string }
  /** An explorer's repository as read now; none outside one, or when it could not be read. */
  | { type: "git"; place: string; git?: GitState }
  | { type: "send.result"; session: string; ref: string; text: string; at: number; status: "queued" | "held" }
  | { type: "chat.message"; params: { message: Message } }
  | { type: "chat.delta"; params: { message: string; block: number; delta: ContentBlock } }
  /** A provisional reply was abandoned: its placeholder goes. */
  | { type: "chat.retract"; params: { message: string } }
  /** The orchestrator's turn as it goes; `turn` absent once it is over. */
  | { type: "chat.progress"; params: { turn?: TurnProgress } }
  | { type: "chat.loading" }
  /** A load that failed: nothing is marked loaded, so the button that asked for it asks again. */
  | { type: "chat.failed" }
  | { type: "chat.loaded"; threads: Thread[]; messages: Message[]; limit: number }
  | { type: "task.state"; params: Task }
  /** A thread's row changed: opened, closed, or given a topic or a workspace. Its messages stay. */
  | { type: "thread.state"; params: Thread }
  | { type: "voice.state"; params: { state: VoiceState; client?: string; unheard?: VoiceUnheard; limit?: number; stopped?: VoiceStopped } }
  | { type: "voice.partial"; params: VoicePartial }
  /** The note a press left has had its time. */
  | { type: "voice.note.expired"; at: number }
  | { type: "host.mic"; params: { error?: string } }
  | { type: "voice.setup"; params: VoiceSetup }
  | { type: "voice.next"; params: VoiceNext }
  | { type: "pairing"; offer?: PairingOffer }
  | { type: "controllers"; controllers: Controller[] }
  | { type: "controller.removed"; id: string }
  | { type: "grants"; grants: Grant[] }
  /** A grant was revoked or cancelled here: its row goes, and its invite's panel with it. */
  | { type: "grant.removed"; id: string }
  /** An invite came back from `grant.invite`, or its panel closed. */
  | { type: "invite"; invite?: IssuedInvite }
  | { type: "quick.toggle"; quick?: boolean }
  | { type: "nodes"; nodes: Node[] }
  | { type: "node.state"; params: Node }
  | { type: "metrics.sample"; params: MetricsSample }
  /** A node's samples are being subscribed to: their spend waits for the node's totals. */
  | { type: "spend.loading"; node: NodeId }
  /** A node's totals over the day, the base its spend is rebuilt on; absent when they could not be had, and the samples held count on from what is shown. */
  | { type: "metrics.spend"; node: NodeId; totals?: SpendTotals }
  | { type: "remote.state"; params: RemoteState }
  /** A code came back from `remote.invite`, or the panel closed. */
  | { type: "remote.invite"; invite?: RemoteInvite }
  /** The PIN form opened on a node's card, or closed. */
  | { type: "remote.pin"; node?: NodeId }
  | { type: "account.state"; params: AccountState }
  | { type: "direct.state"; params: DirectState }
  /** A code came back from `account.login`, or the panel closed. */
  | { type: "login"; offer?: LoginOffer }
  | { type: "error"; message: string };

export const AUDIT_KEEP = 200;
export const ERRORS_KEEP = 20;
export const HISTORY_PAGE = 50;
export const THREAD_PAGE = 1;

/** How far back the spend reaches: the node's totals over this window are its base. */
export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export function initialState(): ViewState {
  return {
    hostMenu: false,
    hostTalk: false,
    hostFilePaths: false,
    hostEmbed: false,
    connected: false,
    scopes: [],
    sessions: new Map(),
    terminals: new Map(),
    explorers: new Map(),
    asks: new Map(),
    audit: new Map(),
    workspaces: new Map(),
    profiles: new Map(),
    threads: new Map(),
    messages: new Map(),
    streaming: new Map(),
    tasks: new Map(),
    controllers: new Map(),
    grants: new Map(),
    nodes: new Map(),
    metrics: new Map(),
    spend: new Map(),
    remote: new Map(),
    direct: new Map(),
    quick: false,
    chatLoaded: false,
    threadsExhausted: false,
    chatLoading: false,
    errors: [],
  };
}

export type TerminalOutput = ClientNotificationParams<"terminal.output">;

/** The smallest font a followed terminal is drawn at, and a driven one's. */
export const FONT_MIN = 9;
export const FONT_DRIVE = 13;

export interface Size {
  width: number;
  height: number;
}

/**
 * The font size, in half points, at which a terminal drawn `drawn` big at `font` fills `room`
 * as far as its shape allows: its cells grow with the font, so it scales as a picture does.
 */
export function followFont(room: Size, drawn: Size, font: number): number {
  if (room.width <= 0 || room.height <= 0 || drawn.width <= 0 || drawn.height <= 0 || font <= 0) return font;
  const scale = Math.min(room.width / drawn.width, room.height / drawn.height);
  return Math.max(FONT_MIN, Math.floor(font * scale * 2) / 2);
}

/** The scales − and + step a terminal through, in percent of the driven font; the first stays above the floor. */
export const SCALES = [70, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

/** A font's scale, in whole percent of the driven font: what the bar shows between − and +. */
export function fontScale(font: number): number {
  return Math.round((font / FONT_DRIVE) * 100);
}

/** The font a driven terminal is drawn at, at `scale` percent. */
export function scaleFont(scale: number): number {
  return (FONT_DRIVE * scale) / 100;
}

/**
 * The next scale up (`1`) or down (`-1`) from `scale`, which may sit between two (a followed
 * terminal's); `undefined` past either end.
 */
export function stepScale(scale: number, dir: 1 | -1): number | undefined {
  return dir === 1 ? SCALES.find((s) => s > scale) : SCALES.filter((s) => s < scale).pop();
}

/** The output that came before a terminal's open was answered, kept when it goes past the repaint. */
export function pastRepaint(seq: number, held: TerminalOutput[]): TerminalOutput[] {
  return held.filter((o) => o.reset === true || o.seq > seq);
}

/** What Shift+Enter sends: ESC CR, as the binding Claude Code's `/terminal-setup` gives VS Code, so a prompt takes a new line. */
export const SHIFT_ENTER = "\x1b\r";

/** How much of the mouse a terminal reports, least first, by xterm.js's names. */
export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";
const TRACKING: MouseTracking[] = ["none", "x10", "vt200", "drag", "any"];
/** The DECSET modes that set it: X10, normal, button-event and any-event tracking. */
const TRACKING_MODES: Record<number, MouseTracking> = { 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" };

/**
 * Whether a DECSET (`CSI ? … h`) only asks again for mouse tracking the terminal already
 * reports as much of: every mode in it is a tracking mode no wider than `active`. Such a set is
 * dropped. Claude re-sends all its modes, narrowest first, as a drag starts; xterm.js keeps
 * one tracking mode, so the narrowest would take the drag's reports away, and the widest, set
 * right after, gives them back only from the next press.
 */
export function repeatsTracking(params: (number | number[])[], active: MouseTracking): boolean {
  return params.length > 0 && params.every((p) => typeof p === "number" && TRACKING_MODES[p] !== undefined && TRACKING.indexOf(TRACKING_MODES[p]) <= TRACKING.indexOf(active));
}

/**
 * The text an OSC 52 puts on the clipboard (its data after `52;`: the selections, `;`, the
 * text in base64), or undefined: a query (`?`), which is never answered, a clear, or only
 * X11's primary or secondary selection, which are not the clipboard.
 */
export function clipboardWrite(data: string): string | undefined {
  const i = data.indexOf(";");
  if (i < 0) return undefined;
  const selections = data.slice(0, i);
  const payload = data.slice(i + 1);
  if (payload === "" || payload === "?" || (selections !== "" && !/[cs0-7]/.test(selections))) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** The composer's text as `chat.send` params: a `/quick ` prefix, or the toggle, sets the mode. */
export function parseComposer(text: string, quick: boolean): { text: string; mode?: "quick" } | undefined {
  const m = /^\/quick\b\s*/i.exec(text);
  const body = (m ? text.slice(m[0].length) : text).trim();
  if (!body) return undefined;
  return m || quick ? { text: body, mode: "quick" } : { text: body };
}

function card(state: ViewState, session: Session): SessionCard {
  let c = state.sessions.get(session.id);
  if (!c) {
    c = { session, open: false, opened: 0, events: new Map(), exhausted: false, loading: false, draft: "", sends: new Map(), unseen: false };
    state.sessions.set(session.id, c);
  } else {
    c.session = session;
  }
  return c;
}

function explorer(state: ViewState, place: string): Explorer {
  let ex = state.explorers.get(place);
  if (!ex) {
    ex = { dirs: new Map(), loading: new Set() };
    state.explorers.set(place, ex);
  }
  return ex;
}

function addEvent(c: SessionCard, e: SessionEvent): void {
  c.events.set(e.seq, e);
  if (c.oldestSeq === undefined || e.seq < c.oldestSeq) c.oldestSeq = e.seq;
  if (e.kind === "notification") {
    const p = e.payload as { type?: string; ref?: string; state?: SendState } | undefined;
    if (p && p.type === "message" && typeof p.ref === "string" && p.state) {
      const send = c.sends.get(p.ref);
      if (send) send.state = p.state;
    }
  }
  // A send typed into the session's terminal lands as the user's own turn, under the send's ref.
  if (e.kind === "user_turn") {
    const p = e.payload as { ref?: string } | undefined;
    const send = p && typeof p.ref === "string" ? c.sends.get(p.ref) : undefined;
    if (send) send.state = "delivered";
  }
}

/** Folds one action in. Mutates and returns `state`; the renderer diffs the DOM. */
export function apply(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "host.ready": {
      const p = action.params;
      state.client = p.client;
      state.node = p.node;
      state.platformVersion = p.platformVersion;
      state.scopes = p.scopes;
      state.hostMenu = p.menu === true;
      state.hostTalk = p.talk === true;
      state.hostFilePaths = p.filePaths === true;
      state.hostEmbed = p.embed === true;
      if (typeof p.docFrame === "string" && p.docFrame !== "") state.hostDocFrame = p.docFrame;
      else delete state.hostDocFrame;
      return state;
    }
    case "host.state":
      state.connected = action.params.connected;
      if (!state.connected) {
        for (const c of state.sessions.values()) c.loading = false;
        state.streaming.clear();
        delete state.progress;
        state.chatLoading = false;
        state.chatLoaded = false;
        // The node is gone: whatever it was saying and whatever code it offered are stale, and so is every reading.
        delete state.voice;
        delete state.heard;
        delete state.setup;
        delete state.next;
        delete state.pairing;
        for (const [id, controller] of state.controllers) state.controllers.set(id, { ...controller, connected: false });
        state.metrics.clear();
        // The hosts' states come again after the next hello; a code or a form from before is for a line that is gone.
        state.remote.clear();
        state.direct.clear();
        delete state.remoteInvite;
        delete state.remotePin;
        // Every terminal comes again with the next `terminal.list`.
        state.terminals.clear();
      }
      return state;
    case "session.state": {
      const s = action.params;
      // A session whose process closed leaves the rail, and its tab with it.
      if (s.status === "ended") {
        state.sessions.delete(s.id);
        return state;
      }
      const was = state.sessions.get(s.id)?.session;
      const c = card(state, s);
      // Work that finished while its tab was closed waits to be looked at; at work again, it waits
      // no more. Idle while its shells run or a dialog is open is not finished.
      if (atWork(s)) c.unseen = false;
      else if (was !== undefined && atWork(was)) c.unseen = !c.open;
      return state;
    }
    case "session.event": {
      const e = action.params;
      const c = state.sessions.get(e.session);
      // One still on its way when its tab closed has nowhere to go.
      if (!c || !c.open) return state;
      addEvent(c, e);
      return state;
    }
    case "terminal.state":
      state.terminals.set(action.params.id, action.params);
      return state;
    case "terminals":
      state.terminals.clear();
      for (const t of action.terminals) state.terminals.set(t.id, t);
      return state;
    case "workspace.state":
      state.workspaces.set(action.params.id, action.params);
      return state;
    case "ask.state":
      state.asks.set(action.params.id, action.params);
      return state;
    case "audit.entry": {
      const e = action.params;
      state.audit.set(e.id, e);
      if (state.audit.size > AUDIT_KEEP) {
        const sorted = [...state.audit.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
        for (const old of sorted.slice(0, state.audit.size - AUDIT_KEEP)) state.audit.delete(old.id);
      }
      return state;
    }
    case "profiles":
      for (const p of action.profiles) state.profiles.set(p.id, p);
      return state;
    case "tab.open":
      for (const c of state.sessions.values()) {
        const open = c.session.id === action.session;
        if (!open && !c.open) continue;
        // Whatever the tab showed goes: a closed tab holds nothing, and one opened again starts
        // from what streams and loads from here, so no stretch of it is missing unsaid.
        c.events.clear();
        delete c.oldestSeq;
        c.exhausted = false;
        c.loading = false;
        c.sends.clear();
        c.open = open;
        if (open) {
          c.opened++;
          // Opening the tab is looking at what it did.
          c.unseen = false;
        }
      }
      return state;
    case "history.loading": {
      const c = state.sessions.get(action.session);
      if (c?.open) c.loading = true;
      return state;
    }
    case "history": {
      const c = state.sessions.get(action.session);
      if (!c || !c.open || c.opened !== action.opened) return state;
      c.loading = false;
      for (const e of action.events) addEvent(c, e);
      if (action.events.length < action.limit) c.exhausted = true;
      return state;
    }
    case "draft": {
      const c = state.sessions.get(action.session);
      if (c) c.draft = action.text;
      return state;
    }
    case "files.loading": {
      const ex = explorer(state, action.place);
      for (const d of action.dirs) ex.loading.add(d);
      return state;
    }
    case "files": {
      const ex = explorer(state, action.place);
      for (const d of action.asked) ex.loading.delete(d);
      if (action.error !== undefined) {
        ex.error = action.error;
        return state;
      }
      delete ex.error;
      if (action.root !== undefined) ex.root = action.root;
      for (const listing of action.dirs ?? []) ex.dirs.set(listing.dir, listing);
      return state;
    }
    case "git": {
      const ex = explorer(state, action.place);
      if (action.git) ex.git = action.git;
      else delete ex.git;
      return state;
    }
    case "send.result": {
      const c = state.sessions.get(action.session);
      if (!c) return state;
      if (c.open) c.sends.set(action.ref, { ref: action.ref, text: action.text, at: action.at, state: action.status });
      c.draft = "";
      return state;
    }
    case "chat.message": {
      const m = action.params.message;
      state.messages.set(m.id, m);
      state.streaming.delete(m.id);
      // The utterance heard is in the chat now: its message takes the ghost's place.
      if (state.heard?.message === m.id) delete state.heard;
      if (!state.threads.has(m.thread)) state.threads.set(m.thread, { id: m.thread, startedAt: m.at, sessions: [] });
      return state;
    }
    case "chat.delta": {
      const p = action.params;
      if (state.messages.has(p.message)) return state;
      let s = state.streaming.get(p.message);
      if (!s) {
        const steps = state.progress?.steps.filter((step) => step.status !== "running") ?? [];
        s = { id: p.message, at: Date.now(), blocks: [], ...(steps.length > 0 ? { steps } : {}) };
        state.streaming.set(p.message, s);
      }
      const existing = s.blocks[p.block];
      if (existing && existing.type === "text" && p.delta.type === "text") existing.text += p.delta.text;
      else s.blocks[p.block] = p.delta;
      return state;
    }
    case "chat.retract":
      state.streaming.delete(action.params.message);
      return state;
    case "chat.progress":
      if (action.params.turn) state.progress = action.params.turn;
      else delete state.progress;
      return state;
    case "chat.loading":
      state.chatLoading = true;
      return state;
    case "chat.failed":
      state.chatLoading = false;
      return state;
    case "chat.loaded": {
      state.chatLoading = false;
      state.chatLoaded = true;
      // What streamed in before the load is keyed as the load is: a thread's row replaces the
      // bare divider a live message made, a message replaces itself, and a reply the load
      // holds finished stops streaming here.
      for (const t of action.threads) state.threads.set(t.id, t);
      for (const m of action.messages) {
        state.messages.set(m.id, m);
        state.streaming.delete(m.id);
        if (state.heard?.message === m.id) delete state.heard;
      }
      // The next page starts before the earliest thread a page brought. A thread known only
      // from its state or a live message has no messages loaded, so the pages pass over it
      // in their turn rather than start behind it.
      const cursor = state.oldestThread !== undefined ? state.threads.get(state.oldestThread) : undefined;
      const oldest = [...action.threads, ...(cursor ? [cursor] : [])].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))[0];
      if (oldest) state.oldestThread = oldest.id;
      if (action.threads.length < action.limit) state.threadsExhausted = true;
      return state;
    }
    case "task.state": {
      const t = action.params;
      if (t.status === "done" || t.status === "cancelled") state.tasks.delete(t.id);
      else state.tasks.set(t.id, t);
      return state;
    }
    case "thread.state":
      state.threads.set(action.params.id, action.params);
      return state;
    case "voice.state": {
      const { state: voice, client, unheard, limit, stopped } = action.params;
      const before = state.voice;
      if (voice === "idle") delete state.voice;
      else state.voice = { state: voice, ...(client !== undefined ? { client } : {}), ...(voice === "listening" && limit !== undefined ? { limit } : {}), at: Date.now() };
      // Only this view's own utterance is its to explain. A press that came to nothing is
      // explained until whatever comes next; a stop, until the next utterance.
      const mine = client === undefined || client === state.client?.id;
      if (!mine) return state;
      const note = state.voiceNote;
      if (voice === "idle" && unheard !== undefined) state.voiceNote = { unheard, at: Date.now() };
      else if (voice === "transcribing" && stopped !== undefined) state.voiceNote = { stopped, ...(before?.limit !== undefined ? { limit: before.limit } : {}), at: Date.now() };
      else if (voice === "listening" || (voice !== "idle" && note !== undefined && "unheard" in note)) delete state.voiceNote;
      // A new utterance is heard afresh; one taken back or come to nothing leaves no words.
      if (voice === "listening" || voice === "idle") delete state.heard;
      return state;
    }
    case "voice.partial": {
      const { client, text, from, message } = action.params;
      // The node sends each client its own utterance's words alone.
      if (client !== undefined && client !== state.client?.id) return state;
      // Its message landed first: the ghost has had its time.
      if (message !== undefined && state.messages.has(message)) {
        delete state.heard;
        return state;
      }
      const before = state.heard;
      state.heard = { text: (before?.text ?? "").slice(0, from ?? 0) + text, at: before?.at ?? Date.now(), ...(message !== undefined ? { message } : {}) };
      return state;
    }
    case "voice.note.expired":
      if (state.voiceNote && "unheard" in state.voiceNote && state.voiceNote.at <= action.at) delete state.voiceNote;
      return state;
    case "host.mic":
      if (action.params.error !== undefined) state.hostMic = action.params.error;
      else delete state.hostMic;
      return state;
    case "voice.next":
      state.next = action.params;
      return state;
    case "voice.setup":
      // A step that ended says so once and then there is nothing to show; the wake word set
      // up anew (other heads picked) leaves another stage's install showing.
      if (action.params.step === "ready" || action.params.step === "failed") {
        if (!state.setup || state.setup.stage === action.params.stage) delete state.setup;
      } else state.setup = action.params;
      return state;
    case "pairing":
      if (action.offer) state.pairing = action.offer;
      else delete state.pairing;
      return state;
    case "controllers":
      state.controllers = new Map(action.controllers.map((c) => [c.id, c]));
      return state;
    case "controller.removed":
      state.controllers.delete(action.id);
      return state;
    case "grants": {
      state.grants = new Map(action.grants.map((g) => [g.id, g]));
      // the invite on show was used: its panel has done its job
      const shown = state.invite ? state.grants.get(state.invite.grant) : undefined;
      if (shown && shown.status !== "pending") delete state.invite;
      return state;
    }
    case "grant.removed":
      state.grants.delete(action.id);
      state.controllers.delete(action.id);
      if (state.invite?.grant === action.id) delete state.invite;
      return state;
    case "invite":
      if (action.invite) state.invite = action.invite;
      else delete state.invite;
      return state;
    case "quick.toggle":
      state.quick = action.quick ?? !state.quick;
      return state;
    case "nodes":
      state.nodes = new Map(action.nodes.map((n) => [n.id, n]));
      return state;
    case "node.state":
      state.nodes.set(action.params.id, action.params);
      return state;
    case "metrics.sample": {
      const s = action.params;
      const previous = state.metrics.get(s.node);
      if (previous && previous.at > s.at) return state;
      state.metrics.set(s.node, s);
      const held = state.spend.get(s.node)?.held;
      if (held) held.push({ at: s.at, profiles: s.profiles });
      else countSpend(state, s.node, [s]);
      return state;
    }
    case "spend.loading": {
      const spend = state.spend.get(action.node);
      if (spend) spend.held = [];
      else state.spend.set(action.node, { seen: 0, byProfile: new Map(), held: [] });
      return state;
    }
    case "metrics.spend": {
      const spend: NodeSpend = state.spend.get(action.node) ?? { seen: 0, byProfile: new Map() };
      const held = spend.held ?? [];
      delete spend.held;
      if (action.totals) {
        spend.seen = action.totals.at;
        spend.byProfile = new Map(Object.entries(action.totals.profiles).map(([profile, t]) => [profile, { in: t.in, out: t.out, cached: t.cached, cost: t.cost ?? 0 }]));
      }
      state.spend.set(action.node, spend);
      // What landed while the totals were on their way: the samples they hold are skipped.
      countSpend(state, action.node, held);
      return state;
    }
    case "remote.state":
      state.remote.set(action.params.node, action.params);
      // A host that stopped serving takes its open code and form with it.
      if (action.params.host.status !== "ready") {
        if (state.remoteInvite?.node === action.params.node) delete state.remoteInvite;
        if (state.remotePin === action.params.node) delete state.remotePin;
      }
      return state;
    case "remote.invite":
      if (action.invite) state.remoteInvite = action.invite;
      else delete state.remoteInvite;
      return state;
    case "account.state":
      state.account = action.params;
      // a plan arriving with a subject means the login went through: the code panel is done
      if (action.params.subject !== undefined) delete state.login;
      return state;
    case "direct.state":
      state.direct.set(action.params.node, action.params);
      return state;
    case "login":
      if (action.offer) state.login = action.offer;
      else delete state.login;
      return state;
    case "remote.pin":
      if (action.node) state.remotePin = action.node;
      else delete state.remotePin;
      return state;
    case "error":
      state.errors.push(action.message);
      if (state.errors.length > ERRORS_KEEP) state.errors.splice(0, state.errors.length - ERRORS_KEEP);
      return state;
  }
}

/** Adds the samples' per-profile deltas to a node's spend, each sample once: only what is newer than the last counted. */
function countSpend(state: ViewState, node: NodeId, samples: SpendDelta[]): void {
  let spend = state.spend.get(node);
  if (!spend) {
    spend = { seen: 0, byProfile: new Map() };
    state.spend.set(node, spend);
  }
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    if (s.at <= spend.seen) continue;
    spend.seen = s.at;
    for (const [profile, p] of Object.entries(s.profiles ?? {})) {
      const cur = spend.byProfile.get(profile) ?? { in: 0, out: 0, cached: 0, cost: 0 };
      cur.in += p.in;
      cur.out += p.out;
      cur.cached += p.cached;
      cur.cost += p.cost ?? 0;
      spend.byProfile.set(profile, cur);
    }
  }
}

// --- what streams, and what loads ------------------------------------------------------------

/**
 * Whether this client loads history unasked: the desktop app does, a tab's newest page as
 * it opens and the chat's newest thread on connect. A phone or the web app (a controller)
 * shows what streams from the moment it looks, and loads history a page per press.
 */
export function loadsHistory(state: ViewState): boolean {
  return state.client?.kind !== "controller";
}

/** The `session.watch` params for the tab shown, none for the chat; undefined while the view may not send it: offline, or without `sessions:read`. */
export function watchParams(state: ViewState, selected: string | undefined): { ids: string[] } | undefined {
  if (!state.connected || !state.scopes.includes("sessions:read")) return undefined;
  return { ids: selected !== undefined && state.sessions.has(selected) ? [selected] : [] };
}

/** A button that loads history: what it says, and whether it can be pressed now. */
export interface HistoryButton {
  label: string;
  disabled: boolean;
}

/** The button above a tab's timeline: Load history while nothing is loaded, Show earlier after; none once the start is reached. */
export function earlierButton(state: ViewState, card: SessionCard): HistoryButton | undefined {
  if (card.exhausted) return undefined;
  const label = card.loading ? "Loading…" : card.events.size === 0 ? "Load history" : "Show earlier";
  return { label, disabled: card.loading || !state.connected };
}

/**
 * The button at the top of the chat. Before a thread is loaded, a client that loads history
 * only when asked offers Load history (`chat-history`); the desktop offers nothing, since it
 * loads the newest thread itself. Once one is loaded, Earlier (`threads-earlier`) pages back
 * a thread at a time while there is an earlier one.
 */
export function chatButton(state: ViewState): (HistoryButton & { action: "chat-history" | "threads-earlier" }) | undefined {
  const disabled = state.chatLoading || !state.connected;
  if (!state.chatLoaded) {
    if (loadsHistory(state) || !state.scopes.includes("chat")) return undefined;
    return { action: "chat-history", label: state.chatLoading ? "Loading…" : "Load history", disabled };
  }
  if (state.threadsExhausted || state.oldestThread === undefined) return undefined;
  return { action: "threads-earlier", label: state.chatLoading ? "Loading…" : "Earlier", disabled };
}

// --- selectors -----------------------------------------------------------------------------

/** Where a ref's chip goes in a message's text: private-use characters no one types. */
export const SLOT_OPEN = "";
export const SLOT = /(\d+)/g;

export function slot(i: number): string {
  return `${SLOT_OPEN}${i}`;
}

/** A part of a message: a run of text and refs read as one text, or a block that stands apart. */
export type Part = { type: "flow"; text: string; refs: Extract<ContentBlock, { type: "ref" }>[] } | Extract<ContentBlock, { type: "quote" | "audio" }>;

/** A message's blocks as parts: each ref in a run of text becomes a slot in the run's text, where its chip goes, so it reads in its sentence. */
export function parts(blocks: ContentBlock[]): Part[] {
  const out: Part[] = [];
  let flow: Extract<Part, { type: "flow" }> | undefined;
  for (const block of blocks) {
    if (block.type === "text" || block.type === "ref") {
      if (!flow) out.push((flow = { type: "flow", text: "", refs: [] }));
      if (block.type === "text") flow.text += block.text;
      else {
        flow.text += slot(flow.refs.length);
        flow.refs.push(block);
      }
      continue;
    }
    flow = undefined;
    out.push(block);
  }
  return out;
}

/** Past this many characters a chip may be cut short, and its title says it whole. */
export const CHIP_CHARS = 30;

/** A chip's title: what it does, after its words when they may not all show. */
export function chipTitle(text: string, title: string): string {
  return text.length > CHIP_CHARS ? (title ? `${text}\n${title}` : text) : title;
}

export type StreamItem =
  | { kind: "ask"; at: number; ask: Ask }
  | { kind: "audit"; at: number; entry: AuditEntry }
  | { kind: "thread"; at: number; thread: Thread }
  | { kind: "message"; at: number; message: Message }
  | { kind: "streaming"; at: number; streaming: Streaming }
  | { kind: "progress"; at: number; progress: TurnProgress }
  | { kind: "heard"; at: number; heard: HeardWords }
  | { kind: "task"; at: number; task: Task };

export function openAsks(state: ViewState): Ask[] {
  return [...state.asks.values()].filter((a) => a.status === "open").sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * The asks pinned over the pane: every open one, but a session's own while its terminal is on
 * screen (`onScreen`), where the harness asks the same question itself.
 */
export function pinnedAsks(state: ViewState, onScreen?: string): Ask[] {
  return openAsks(state).filter((a) => onScreen === undefined || a.source.kind !== "harness" || a.source.session !== onScreen);
}

/**
 * The asks pinned, then thread dividers, messages, open tasks and audit rows in time order,
 * oldest at the top, then this view's utterance as it is heard, and last what the orchestrator
 * is doing while its turn runs, until the reply starts streaming: the reply is then what it is
 * doing. `onScreen` is the session whose terminal the pane shows, if any.
 */
export function selectStream(state: ViewState, onScreen?: string): { pinned: Ask[]; items: StreamItem[] } {
  const items: StreamItem[] = [];
  for (const thread of state.threads.values()) items.push({ kind: "thread", at: thread.startedAt, thread });
  for (const message of state.messages.values()) items.push({ kind: "message", at: message.at, message });
  for (const streaming of state.streaming.values()) items.push({ kind: "streaming", at: streaming.at, streaming });
  for (const task of state.tasks.values()) items.push({ kind: "task", at: task.createdAt, task });
  for (const entry of state.audit.values()) items.push({ kind: "audit", at: entry.at, entry });
  items.sort((a, b) => a.at - b.at || rank(a) - rank(b) || keyOf(a).localeCompare(keyOf(b)));
  if (heardText(state) !== "") items.push({ kind: "heard", at: state.heard!.at, heard: state.heard! });
  const p = state.progress;
  if (p && state.streaming.size === 0 && (p.thinking || p.steps.length > 0 || p.about !== undefined)) items.push({ kind: "progress", at: Number.POSITIVE_INFINITY, progress: p });
  return { pinned: pinnedAsks(state, onScreen), items };
}

/** At one instant a thread's divider precedes its messages, and a reply follows what it answers. */
function rank(item: StreamItem): number {
  switch (item.kind) {
    case "thread":
      return 0;
    case "message":
      return item.message.role === "user" ? 1 : 2;
    case "streaming":
      return 3;
    default:
      return 4;
  }
}

export function keyOf(item: StreamItem): string {
  switch (item.kind) {
    case "ask":
      return `ask:${item.ask.id}`;
    case "audit":
      return `audit:${item.entry.id}`;
    case "thread":
      return `thread:${item.thread.id}`;
    case "message":
      return `message:${item.message.id}`;
    case "streaming":
      return `message:${item.streaming.id}`;
    case "progress":
      return "progress";
    case "heard":
      return "heard";
    case "task":
      return `task:${item.task.id}`;
  }
}

/** What this view's utterance has been heard to say so far; empty when there is nothing to show. */
export function heardText(state: ViewState): string {
  return state.heard?.text.trim() ?? "";
}

/**
 * The folder a group of tabs stands for, its live sessions in the order they started, and the
 * workspaces inside it where a session is open, each a group of its own, by name.
 */
export interface SessionGroup {
  key: string;
  /** The workspace's name, or the folder's; with the machine's when it is another node's and outermost. */
  name: string;
  path: string;
  sessions: SessionCard[];
  /** The agent CLIs in terminals here that no session stands for yet (`waitingAgent`), after the sessions. */
  terminals: Terminal[];
  groups: SessionGroup[];
  /** Its tabs and every one in the groups inside it: what its heading says it holds while folded. */
  count: number;
}

/** A rail heading: its name, and while folded how many tabs it holds out of sight. */
export function groupHeading(name: string, count: number, folded: boolean): string {
  return folded ? `${name} (${count})` : name;
}

/** A path as the node's filesystem compares it: forward slashes, no trailing one, case-folded on Windows and macOS. */
export function placeKey(path: string, platform?: Platform): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const folded = platform === "windows" || platform === "macos" || (platform === undefined && /^[a-z]:\//i.test(p));
  return folded ? p.toLowerCase() : p;
}

/**
 * The rail's tabs as a tree of folders, each level by name and the tabs in each in the order
 * their sessions started, so nothing moves as sessions work. A session's folder is its
 * workspace's, or its own cwd without one. A workspace inside another folder where a live
 * session works (a worktree under its repository, a repository under a folder of them) is a
 * group under the innermost such group; a session with no workspace whose cwd is inside a
 * group's folder joins the innermost such group rather than heading one. The outermost groups
 * are the outermost folders of a node where a session is open. An agent CLI waiting in a
 * terminal (`terminals`, from `selectWaitingAgents`) is placed as a session is, by the folder
 * its terminal started in, and its tab follows the sessions' there.
 */
export function selectGroups(state: ViewState, terminals: Terminal[] = []): SessionGroup[] {
  interface Place {
    node: string;
    key: string;
    path: string;
    name: string;
    /** A workspace's folder, not only some session's cwd: inside another, it heads a group of its own. */
    workspace: boolean;
  }
  const places = new Map<string, Place>();
  const placeOf = (node: NodeId, path: string, w: Workspace | undefined): Place => {
    const key = placeKey(path, state.nodes.get(node)?.platform);
    const id = `${node}\n${key}`;
    let place = places.get(id);
    if (!place) {
      place = { node, key, path, name: w?.name ?? lastPart(path), workspace: w !== undefined };
      places.set(id, place);
    } else if (w && !place.workspace) {
      // A bare cwd met first, then the workspace at the same folder: the workspace names it.
      place.name = w.name;
      place.workspace = true;
    }
    return place;
  };
  const own = new Map<SessionCard, Place>();
  for (const card of state.sessions.values()) {
    const s = card.session;
    if (s.status === "ended") continue;
    const w = s.workspace ? state.workspaces.get(s.workspace) : undefined;
    own.set(card, placeOf(s.node, w?.path ?? s.cwd, w));
  }
  const ownTerminal = new Map<Terminal, Place>();
  for (const t of terminals) {
    const key = placeKey(t.cwd, state.nodes.get(t.node)?.platform);
    let w: Workspace | undefined;
    for (const x of state.workspaces.values()) if (x.node === t.node && placeKey(x.path, state.nodes.get(t.node)?.platform) === key) w = x;
    ownTerminal.set(t, placeOf(t.node, w?.path ?? t.cwd, w));
  }
  // Nesting is by path on one node; a folder is not inside itself.
  const inside = (inner: Place, outer: Place) => inner.node === outer.node && inner.key.startsWith(outer.key + "/");
  const innermost = (place: Place, among: Iterable<Place>): Place | undefined => {
    let best: Place | undefined;
    for (const p of among) if (inside(place, p) && (best === undefined || p.key.length > best.key.length)) best = p;
    return best;
  };
  // A workspace's folder heads a group, and so does a folder inside no other. The outermost
  // folder around any place heads one, so every place has a head at or around it.
  const heads = new Set<Place>();
  for (const p of places.values()) if (p.workspace || innermost(p, places.values()) === undefined) heads.add(p);
  const groups = new Map<Place, SessionGroup>();
  for (const head of heads) groups.set(head, { key: `${head.node}\n${head.key}`, name: head.name, path: head.path, sessions: [], terminals: [], groups: [], count: 0 });
  const headOf = (place: Place): SessionGroup => groups.get(heads.has(place) ? place : innermost(place, heads)!)!;
  for (const [card, place] of own) headOf(place).sessions.push(card);
  for (const [t, place] of ownTerminal) headOf(place).terminals.push(t);
  const roots: SessionGroup[] = [];
  for (const [head, group] of groups) {
    const parent = innermost(head, heads);
    if (parent) {
      groups.get(parent)!.groups.push(group);
      continue;
    }
    const other = head.node !== state.node ? state.nodes.get(head.node)?.name : undefined;
    if (other) group.name = `${group.name} · ${other}`;
    roots.push(group);
  }
  const byStart = (a: SessionCard, b: SessionCard) => a.session.startedAt - b.session.startedAt || (a.session.id < b.session.id ? -1 : 1);
  const byName = (a: SessionGroup, b: SessionGroup) => a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  // Each level in order, and each group's count with everything under it.
  const settle = (level: SessionGroup[]): number => {
    level.sort(byName);
    let total = 0;
    for (const g of level) {
      g.sessions.sort(byStart);
      g.terminals.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
      g.count = g.sessions.length + g.terminals.length + settle(g.groups);
      total += g.count;
    }
    return total;
  };
  settle(roots);
  return roots;
}

function lastPart(path: string): string {
  return path.split(/[\\/]/).filter((p) => p !== "").pop() ?? path;
}

/**
 * The bare terminals' tabs: the ones no session runs in, newest first. One that ended drops
 * out of the rail unless it is the one shown, which says it ended.
 */
export function selectTerminalTabs(state: ViewState, shown?: string): Terminal[] {
  const out = [...state.terminals.values()].filter((t) => (t.session === undefined || !state.sessions.has(t.session)) && (t.status === "running" || t.id === shown));
  return out.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
}

/**
 * Whether a terminal holds an agent CLI that no session stands for yet: a Codex or Muse CLI
 * before its first prompt (it starts no thread until then), or Claude's before it registers.
 * Its tab stands with the sessions in its folder (`selectGroups`), not under Terminals.
 */
export function waitingAgent(state: ViewState, t: Terminal): boolean {
  return t.status === "running" && t.harness !== undefined && t.agents === undefined && (t.session === undefined || !state.sessions.has(t.session));
}

/** The terminals whose agent CLI waits for its first prompt, for `selectGroups`. */
export function selectWaitingAgents(state: ViewState): Terminal[] {
  return [...state.terminals.values()].filter((t) => waitingAgent(state, t));
}

/**
 * A waiting agent's tab, in its folder's group: its name, or the title its CLI set (a spinner
 * before it off) unless that is only a program's path, or else its folder's name, as a
 * session's tab with no title of its own says.
 */
export function waitingLabel(t: Terminal): string {
  if (t.name) return t.name;
  const title = t.title?.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const program = (s: string) => lastPart(s).toLowerCase().replace(/\.exe$/, "");
  if (title && !/[\\/]/.test(title) && program(title) !== program(t.argv0)) return title;
  return lastPart(t.cwd);
}

/** What a terminal is called on its tab: its name, Claude's agents when it shows their screen, the title its program set, or the program. */
export function terminalLabel(t: Terminal): string {
  return t.name || (t.agents === "claude" ? "Claude agents" : undefined) || t.title || t.argv0;
}

/** The node that comes first among the machines: the computer the app runs on (a desktop app's own), else the one it talks to. */
export function hereNode(state: ViewState): NodeId | undefined {
  return state.client?.node ?? state.node;
}

/** A machine's name as the rail says it. */
export function machineName(state: ViewState, node: NodeId): string {
  return state.nodes.get(node)?.name ?? (node === state.node ? "This computer" : "Another computer");
}

/**
 * Where a bare terminal works, as its tab says it: the name of the workspace it started in,
 * or its folder's own; with the machine's when it is another node's, unless the tab stands
 * under that machine's name already (`withMachine` false).
 */
export function terminalPlace(state: ViewState, t: Terminal, withMachine = true): string {
  const platform = state.nodes.get(t.node)?.platform;
  const key = placeKey(t.cwd, platform);
  let name: string | undefined;
  for (const w of state.workspaces.values()) {
    if (w.node === t.node && placeKey(w.path, platform) === key) {
      name = w.name;
      break;
    }
  }
  name ??= lastPart(t.cwd);
  const other = withMachine && t.node !== state.node ? state.nodes.get(t.node)?.name : undefined;
  return other ? `${name} · ${other}` : name;
}

/**
 * A bare terminal's tab under Terminals: where it works, then what it is called when that
 * says more than its program does (a shell's title is often the program's own path).
 */
export function terminalTabLabel(state: ViewState, t: Terminal, withMachine = true): string {
  const place = terminalPlace(state, t, withMachine);
  const label = terminalLabel(t);
  const program = (s: string) => lastPart(s).toLowerCase().replace(/\.exe$/, "");
  return program(label) === program(t.argv0) ? place : `${place} · ${label}`;
}

/**
 * The mark a bare terminal's tab has: the harness whose agents screen it shows, or whose CLI
 * runs in it before a session stands for it (a Codex or Muse CLI before its first prompt); any other
 * program's is a prompt. With it, how the tab reads aloud.
 */
export function terminalMark(t: Terminal): { harness: string; kind: string } {
  if (t.agents) return { harness: t.agents, kind: `${t.agents} agents` };
  if (t.harness) return { harness: t.harness, kind: `${t.harness} in a terminal` };
  return { harness: "terminal", kind: "terminal" };
}

/** A machine's bare terminals, under its name in the rail. */
export interface TerminalGroup {
  node: NodeId;
  name: string;
  terminals: Terminal[];
}

/** How many machines are connected now: the cluster's nodes that are not offline. */
function machinesConnected(state: ViewState): number {
  let n = 0;
  for (const node of state.nodes.values()) if (node.status !== "offline") n++;
  return n;
}

/**
 * The bare terminals by the machine they run on, while more than one machine is connected or
 * they run on more than one: this computer's first, then the others' by name, each newest
 * first as the rail lists them. Undefined with one machine: the tabs stand under Terminals.
 */
export function terminalGroups(state: ViewState, terminals: Terminal[]): TerminalGroup[] | undefined {
  const byNode = new Map<NodeId, Terminal[]>();
  for (const t of terminals) {
    let list = byNode.get(t.node);
    if (!list) byNode.set(t.node, (list = []));
    list.push(t);
  }
  if (byNode.size <= 1 && machinesConnected(state) <= 1) return undefined;
  const here = hereNode(state);
  const groups = [...byNode].map(([node, list]) => ({ node, name: machineName(state, node), terminals: list }));
  return groups.sort((a, b) => Number(b.node === here) - Number(a.node === here) || a.name.localeCompare(b.name) || (a.node < b.node ? -1 : 1));
}

/** A machine New terminal offers to start a shell on. */
export interface TerminalMachine {
  node: NodeId;
  name: string;
  /** The computer the app runs on: a desktop app's own, never a phone's. */
  here: boolean;
}

/**
 * The machines New terminal offers, this computer's first, then the others' by name: the node
 * the view talks to, unless its row says it starts no terminal, and every other connected
 * node whose row says it does (one on an earlier version serves none of its terminals).
 */
export function terminalMachines(state: ViewState): TerminalMachine[] {
  const here = state.client?.node;
  const out: TerminalMachine[] = [];
  for (const n of state.nodes.values()) {
    const starts = n.id === state.node ? n.capabilities.terminals !== false : n.status === "online" && n.capabilities.terminals === true;
    if (starts) out.push({ node: n.id, name: n.name, here: n.id === here });
  }
  // the node the view talks to, before its row came
  if (state.node !== undefined && !state.nodes.has(state.node)) out.push({ node: state.node, name: machineName(state, state.node), here: state.node === here });
  return out.sort((a, b) => Number(b.here) - Number(a.here) || Number(b.node === state.node) - Number(a.node === state.node) || a.name.localeCompare(b.name));
}

/** How many workspaces New terminal offers on one machine, and on each of several. */
export const RECENT_WORKSPACES = 8;
export const RECENT_PER_MACHINE = 5;

/** The workspaces New terminal offers to start a shell in on a machine, the one worked in last first. */
export function recentWorkspaces(workspaces: Iterable<Workspace>, node: string | undefined, limit = RECENT_WORKSPACES): Workspace[] {
  const mine = [...workspaces].filter((w) => w.node === node);
  return mine.sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name)).slice(0, limit);
}

/** New terminal's places beside the workspaces (by their ids): a machine's home folder, and a folder picked on it. */
export const homePlace = (node: NodeId): string => `home:${node}`;
export const folderPlace = (node: NodeId): string => `folder:${node}`;

/**
 * What `terminal.spawn` is asked for one of New terminal's places: a workspace's folder, on
 * whichever node holds it; a machine's home; a folder picked on it (`cwd`). The node the view
 * talks to is named by nothing, as an earlier node takes it.
 */
export function spawnParams(state: ViewState, place: string, cwd?: string): { workspace?: string; node?: NodeId; cwd?: string } {
  const on = (node: string): { node?: NodeId } => (node === state.node ? {} : { node });
  if (place.startsWith("home:")) return on(place.slice(5));
  if (place.startsWith("folder:")) return { ...on(place.slice(7)), ...(cwd !== undefined ? { cwd } : {}) };
  return { workspace: place };
}

/** The terminal a session runs in, when this node holds it and the view may open it. */
export function sessionTerminal(state: ViewState, session: Session): Terminal | undefined {
  const ref = session.native.terminal;
  if (!ref || !state.scopes.includes("terminal")) return undefined;
  const t = state.terminals.get(ref.id);
  return t && t.host === ref.host ? t : undefined;
}

/** What a session's pane shows: the terminal it runs in, when the view can open one, unless the user chose the timeline. */
export function paneMode(chosen: "timeline" | "terminal" | undefined, hasTerminal: boolean): "timeline" | "terminal" {
  return hasTerminal ? (chosen ?? "terminal") : "timeline";
}

/**
 * Whether the user can kill a session from its pane: one still running whose end the node can
 * bring about, a child it spawned, a terminal it started, a session it runs on a harness's own
 * host, or a process it knows.
 */
export function stoppable(state: ViewState, session: Session): boolean {
  if (session.status === "ended" || !state.scopes.includes("sessions:write")) return false;
  const n = session.native;
  return n.transport === "acp" || n.pid !== undefined || (session.origin === "orchestrator" && (n.terminal !== undefined || n.transport === "msp"));
}

/**
 * How a tab's mark shows the session: `active` while it works (its own colours), `ask` while
 * it waits on the user, an ask or a dialog open in its terminal (its colours and a yellow dot),
 * `shell` while its turn is over but its own shells still run, and will wake it (its colours
 * and a hollow ring), `done` once it finished work the user has not looked at (grey and a
 * green dot), and `quiet` otherwise (grey).
 */
export type TabTone = "ask" | "active" | "shell" | "done" | "quiet";

export function tabTone(card: SessionCard): TabTone {
  const s = card.session;
  if (s.status === "needs_input" || s.status === "needs_permission" || s.ask !== undefined || s.waiting?.on === "user") return "ask";
  if (s.status === "busy") return "active";
  if (s.waiting?.on === "shell") return "shell";
  return card.unseen ? "done" : "quiet";
}

/** A session still at its work: running, asking, or idle while its shells run or a dialog is open. */
export function atWork(s: Session): boolean {
  return s.status !== "idle" || s.waiting !== undefined;
}

/** The session runs in a terminal a tether host holds: its mark is framed as one. */
export function inTether(session: Session): boolean {
  return session.native.terminal !== undefined;
}

/** What a session is called on its tab: its title (the harness's own name for it), its intent, or the last part of its cwd. */
export function sessionLabel(session: Session): string {
  if (session.title) return session.title;
  if (session.intent) return session.intent;
  return lastPart(session.cwd);
}

/** What a chip naming a session says: its harness, and its title or intent when it has one. */
export function sessionWho(session: Session): string {
  const name = session.title ?? session.intent;
  return `${session.harness}${name ? `: ${name}` : ""}`;
}

export type TimelineRow = { kind: "event"; key: string; event: SessionEvent; ask?: Ask; send?: PendingSend; asPeer?: boolean } | { kind: "send"; key: string; send: PendingSend };

/**
 * Events by seq, ask events joined to their ask, message receipts and typed turns joined to the
 * send, then sends not yet receipted. A message a Claude session in a terminal got over its
 * pipe reached it as another agent's (`asPeer`); one typed into its terminal is the user's turn.
 */
export function selectTimeline(state: ViewState, card: SessionCard): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const receipted = new Set<string>();
  const piped = card.session.harness === "claude" && card.session.native.transport === "pipe";
  const events = [...card.events.values()].sort((a, b) => a.seq - b.seq);
  for (const event of events) {
    const row: TimelineRow = { kind: "event", key: `e${event.seq}`, event };
    if (event.kind === "ask") {
      const p = event.payload as { ask?: string } | undefined;
      const ask = p && typeof p.ask === "string" ? state.asks.get(p.ask) : undefined;
      if (ask) row.ask = ask;
    } else if (event.kind === "notification") {
      const p = event.payload as { type?: string; ref?: string } | undefined;
      if (p && p.type === "message" && typeof p.ref === "string") {
        const send = card.sends.get(p.ref);
        if (send) {
          row.send = send;
          receipted.add(p.ref);
        }
      }
      if (p && p.type === "message" && piped) row.asPeer = true;
    } else if (event.kind === "user_turn") {
      const p = event.payload as { ref?: string } | undefined;
      const send = p && typeof p.ref === "string" ? card.sends.get(p.ref) : undefined;
      if (send) {
        row.send = send;
        receipted.add(send.ref);
      }
    }
    rows.push(row);
  }
  const pending = [...card.sends.values()].filter((s) => !receipted.has(s.ref)).sort((a, b) => a.at - b.at);
  for (const send of pending) rows.push({ kind: "send", key: `s${send.ref}`, send });
  return rows;
}

export function workspaceName(state: ViewState, session: Session): string | undefined {
  return session.workspace ? state.workspaces.get(session.workspace)?.name : undefined;
}

// --- the explorer ------------------------------------------------------------------------------

/** How many folders one listing asks for: the protocol's cap. */
export const FOLDERS_PER_ASK = 64;

/** The folder a session's explorer shows, as a key: sessions in one folder of one node share it, and what the user opened there. */
export function explorerKey(state: ViewState, session: Session): string {
  return `${session.node}\n${placeKey(session.cwd, state.nodes.get(session.node)?.platform)}`;
}

/** The folders to list again: the folder itself, then each one the user opened whose every parent is open too, as many as one ask takes. */
export function openFolders(open: ReadonlySet<string>): string[] {
  const shown = [...open].filter((dir) => {
    const parts = dir.split("/");
    for (let i = 1; i < parts.length; i++) if (!open.has(parts.slice(0, i).join("/"))) return false;
    return true;
  });
  shown.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
  return ["", ...shown].slice(0, FOLDERS_PER_ASK);
}

/**
 * Where the Files panel can show a file of `node`: the live session whose folder holds it, the
 * innermost such folder first and then the session worked in last, with the file's path under
 * that folder as the explorer keys it. A relative path, or one no session's folder holds, has none.
 * The session `prefer` names comes first whenever its folder holds the file.
 */
export function fileHome(state: ViewState, node: string, path: string, prefer?: string): { session: Session; rel: string } | undefined {
  if (!/^([A-Za-z]:)?[\\/]/.test(path)) return undefined;
  const platform = state.nodes.get(node)?.platform;
  const key = placeKey(path, platform);
  let best: { session: Session; root: string } | undefined;
  let preferred: { session: Session; root: string } | undefined;
  for (const card of state.sessions.values()) {
    const s = card.session;
    if (s.node !== node || s.status === "ended") continue;
    const root = placeKey(s.cwd, platform);
    if (key !== root && !key.startsWith(`${root}/`)) continue;
    if (s.id === prefer) preferred = { session: s, root };
    if (!best || root.length > best.root.length || (root.length === best.root.length && s.lastActivity > best.session.lastActivity)) best = { session: s, root };
  }
  best = preferred ?? best;
  if (!best) return undefined;
  // The rest of the path as it was written: the folded key only chose the folder.
  return { session: best.session, rel: relUnder(best.session.cwd, path, platform) ?? "" };
}

/** A path under a folder, spelled as its node spells paths: a Windows folder's with backslashes. */
export function joinPath(root: string, rel: string): string {
  if (rel === "") return root;
  const windows = /^[A-Za-z]:/.test(root) || root.startsWith("\\\\");
  const sep = windows ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel.split("/").join(sep)}`;
}

/** A path as it is dropped into a chat or a terminal: in double quotes when it has a space in it, so it stays one word. */
export function dropText(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** Paths dropped together, as they land: each as `dropText` spells it, a space between them. */
export function dropTexts(paths: readonly string[]): string {
  return paths.map(dropText).join(" ");
}

/**
 * One line of the explorer: a folder or a file under the folder the explorer shows, indented
 * by `depth`; a folder open or closed, and being listed; its full path, which is what a drag
 * carries. A folder that could not be read has a `note` line under it saying why, and one cut
 * short a `more` line.
 */
export interface FileRow {
  /** Its path under the folder shown, `/` between names; a note's and a `more`'s are their folder's with a suffix no name has. */
  key: string;
  name: string;
  kind: "dir" | "file" | "note" | "more";
  depth: number;
  open: boolean;
  loading: boolean;
  path: string;
}

/** The explorer's lines, in order: each listed folder's folders, then its files, and under each open folder what it holds. */
export function selectFileRows(ex: Explorer, open: ReadonlySet<string>): FileRow[] {
  const rows: FileRow[] = [];
  const root = ex.root;
  if (root === undefined) return rows;
  const walk = (dir: string, depth: number): void => {
    const listing = ex.dirs.get(dir);
    if (!listing) return;
    if (listing.error !== undefined) {
      // The folder itself says why under the rows; an open one inside says it under its own row.
      if (dir !== "") rows.push({ key: `${dir}\n!`, name: listing.error, kind: "note", depth, open: false, loading: false, path: joinPath(root, dir) });
      return;
    }
    for (const e of listing.entries ?? []) {
      const key = dir === "" ? e.name : `${dir}/${e.name}`;
      const opened = e.kind === "dir" && open.has(key);
      rows.push({ key, name: e.name, kind: e.kind, depth, open: opened, loading: ex.loading.has(key), path: joinPath(root, key) });
      if (opened) walk(key, depth + 1);
    }
    if (listing.truncated) rows.push({ key: `${dir}\n+`, name: "More not shown", kind: "more", depth, open: false, loading: false, path: joinPath(root, dir) });
  };
  walk("", 0);
  return rows;
}

/** What the explorer says under its rows: that it is loading, why it cannot list, or that the folder is empty; nothing once rows show. */
export function explorerNote(ex: Explorer | undefined): string {
  if (ex?.error !== undefined) return ex.error;
  const top = ex?.dirs.get("");
  if (!top) return "Loading…";
  if (top.error !== undefined) return `This folder cannot be read: ${top.error}.`;
  return top.entries && top.entries.length > 0 ? "" : "This folder is empty.";
}

/** Why a listing failed, in the explorer's words: an app or a node too old to list files, a refusal, or the node's own words. */
export function filesErrorWords(code: string | undefined, message: string): string {
  if (code === "unsupported") return /unknown method/.test(message) ? "This app cannot show files yet: update it." : "That computer cannot show its files yet: update Cophyla there.";
  if (code === "denied") return "This view may not list these files.";
  if (code === "unavailable") return "That computer is not connected.";
  if (code === "timeout") return "The listing did not come back.";
  return message;
}

/**
 * The repository line at the foot of the explorer, as VS Code's status bar has it: the branch
 * (the commit while HEAD is detached) with a star when files changed, and the commits to pull
 * and to push as `1↓ 2↑` when there are any, or that the branch tracks nothing; the whole of
 * it in words for its title.
 */
export function gitLine(git: GitState): { branch: string; sync: string; title: string } {
  const name = git.branch ?? git.commit ?? "no commits yet";
  const branch = git.changes > 0 ? `${name}*` : name;
  const counted = git.upstream !== undefined && git.ahead !== undefined && git.behind !== undefined;
  const sync = counted ? (git.ahead! + git.behind! > 0 ? `${git.behind}↓ ${git.ahead}↑` : "") : git.branch !== undefined && git.upstream === undefined ? "not published" : "";
  const where = git.branch !== undefined ? `On ${git.branch}` : git.commit !== undefined ? `Detached at ${git.commit}` : "No commits yet";
  const against = counted
    ? `${commits(git.behind!)} to pull and ${commits(git.ahead!)} to push, against ${git.upstream} as of the last fetch`
    : git.upstream !== undefined
      ? `tracking ${git.upstream}, which is gone`
      : git.branch !== undefined
        ? "tracking nothing: not published"
        : "";
  const changed = git.changes === 0 ? "no changes" : `${git.changes} changed file${git.changes === 1 ? "" : "s"}`;
  return { branch, sync, title: [where, against, changed].filter(Boolean).join("; ") };
}

function commits(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

// --- the file viewer ---------------------------------------------------------------------------

/** What the viewer reads a file through: an agent's session (its folder), or a bare terminal (the folder it started in). */
export type ViewerSource = { session: string } | { terminal: string };

/**
 * A file open in the viewer of a tab, an agent's or a bare terminal's: what it is read through,
 * its path under that one's folder, `/` between the names, a line to show first, and which
 * opening this is, so one opened again is read afresh and goes back to its line.
 */
export interface ViewerFile {
  from: ViewerSource;
  rel: string;
  line?: number;
  opened: number;
}

/** The tab a viewer belongs to, by key: an agent's by its session id, a bare terminal's by its own; none for the chat. */
export function viewerTab(selected: string | undefined, terminal: string | undefined): string | undefined {
  return terminal !== undefined ? `terminal:${terminal}` : selected;
}

/** The folder a viewer's file is read under, while the view may read it: an agent's with `sessions:read`, a bare terminal's with `terminal`. */
export function sourceRoot(state: ViewState, from: ViewerSource): string | undefined {
  if ("session" in from) return state.scopes.includes("sessions:read") ? state.sessions.get(from.session)?.session.cwd : undefined;
  return state.scopes.includes("terminal") ? state.terminals.get(from.terminal)?.cwd : undefined;
}

/** Where a file read through `from` is: its node, and its full path as that node spells it; none while the view may not read it. */
export function viewedPath(state: ViewState, from: ViewerSource, rel: string): { node: NodeId; path: string } | undefined {
  const root = sourceRoot(state, from);
  const node = "session" in from ? state.sessions.get(from.session)?.session.node : state.terminals.get(from.terminal)?.node;
  return root !== undefined && node !== undefined ? { node, path: joinPath(root, rel) } : undefined;
}

/**
 * The file a tab's viewer shows, as the explorer of `session` compares its rows' paths
 * (`placeKey`), when it is on that session's node: however it was read, through this agent,
 * another agent whose folder holds it, or a bare terminal. Undefined with none.
 */
export function viewingKey(state: ViewState, session: Session, open: ViewerFile | undefined): string | undefined {
  const at = open ? viewedPath(state, open.from, open.rel) : undefined;
  return at && at.node === session.node ? placeKey(at.path, state.nodes.get(session.node)?.platform) : undefined;
}

/** The Files panel's menu item for a row: the file shown selected in the file manager of the computer it is on, or the folder opened there, as that computer names its file manager. */
export function revealLabel(platform: Platform | undefined, kind: "file" | "dir"): string {
  if (platform === "windows") return kind === "file" ? "Reveal in File Explorer" : "Open in File Explorer";
  if (platform === "macos") return kind === "file" ? "Reveal in Finder" : "Open in Finder";
  return "Open in file manager";
}

/**
 * Why this view cannot show a session's files in the file manager, when it cannot: the window
 * opens on the session's computer, so only the desktop app there may (`session.reveal`).
 */
export function revealBlocked(state: ViewState, session: Session): string | undefined {
  if (state.client?.kind === "ui" && state.client.node === session.node) return undefined;
  return `Only from Cophyla on ${state.nodes.get(session.node)?.name ?? "that computer"}`;
}

/** What an explorer's listing says a path under its folder is: a folder or a file, once the folder holding it was listed; undefined before, or for no such name. */
export function listedKind(ex: Explorer | undefined, rel: string): "dir" | "file" | undefined {
  if (rel === "") return ex?.root !== undefined ? "dir" : undefined;
  const slash = rel.lastIndexOf("/");
  const name = rel.slice(slash + 1);
  return ex?.dirs.get(slash === -1 ? "" : rel.slice(0, slash))?.entries?.find((e) => e.name === name)?.kind;
}

/**
 * Whether a relative path's first name is a folder the explorer listed at its root: `src/lib`
 * is a path there, `and/or` and `1/2` are words. None for a path that is not relative.
 */
export function underListedFolder(ex: Explorer | undefined, path: string): boolean {
  const rel = relativeFile(path.replace(/[\\/]+$/, ""));
  const first = rel?.split("/")[0];
  return first !== undefined && (ex?.dirs.get("")?.entries?.some((e) => e.kind === "dir" && e.name === first) ?? false);
}

/** Where the viewer sits on a wide window: over the pane, or beside it. A narrow one always lays it over. */
export type ViewerDock = "over" | "beside";

/** The viewer's share of the width beside the pane, in percent: the usual, and the least and most its divider goes to. */
export const VIEWER_WIDTH = { usual: 48, min: 20, max: 80 } as const;

/** A share for the viewer's divider: a number held to its bounds, anything else the usual. */
export function viewerWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return VIEWER_WIDTH.usual;
  return Math.round(Math.min(VIEWER_WIDTH.max, Math.max(VIEWER_WIDTH.min, value)) * 10) / 10;
}

/** A path under a folder, as the explorer keys it (`/` between the names, spelled as written); undefined for one outside it. */
export function relUnder(root: string, path: string, platform?: Platform): string | undefined {
  const key = placeKey(path, platform);
  const r = placeKey(root, platform);
  if (key !== r && !key.startsWith(`${r}/`)) return undefined;
  return path.replace(/\\/g, "/").replace(/\/+$/, "").slice(r.length).replace(/^\/+/, "");
}

/**
 * The images the viewer draws, by extension, and what each kind is called; SVG comes as text
 * and is drawn from it, and a TIFF or a HEIC comes as the PNG its node's codecs make of it.
 */
const IMAGE_KINDS: Readonly<Record<string, string>> = {
  png: "PNG",
  apng: "APNG",
  jpg: "JPEG",
  jpeg: "JPEG",
  jfif: "JPEG",
  gif: "GIF",
  webp: "WebP",
  bmp: "BMP",
  ico: "ICO",
  avif: "AVIF",
  svg: "SVG",
  tif: "TIFF",
  tiff: "TIFF",
  heic: "HEIC",
  heif: "HEIF",
};

/** What kind of image a path names, or undefined for one that names none. */
export function imageKind(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(IMAGE_KINDS, ext) ? IMAGE_KINDS[ext] : undefined;
}

/**
 * Where a link or an image in a file points, under the folder the viewer reads the file from:
 * `href` resolved against the file's own folder (a leading `/` from the folder's top), without
 * its query or its fragment and with `%20` and its kin decoded. Undefined for one with a
 * scheme (the web, `data:`, a drive), for one that climbs out of the folder, and for none.
 */
export function resolveRel(fileRel: string, href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
  let path = href.replace(/[?#].*$/s, "");
  if (path === "") return undefined;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Left as written.
  }
  const parts = path.startsWith("/") || path.startsWith("\\") ? [] : fileRel.split("/").slice(0, -1);
  for (const part of path.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return undefined;
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

/** Past this many matches a search stops counting: marking more costs and helps nobody. */
export const FIND_MAX = 5000;

/** A match of a search in a file's lines: its line's index and where in it. */
export interface LineMatch {
  line: number;
  start: number;
  end: number;
}

/** A search's pattern: the words as written, any case unless `matchCase`. */
export function findPattern(query: string, matchCase: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
}

/** Where a search matches in a file's lines, in order, `FIND_MAX` of them at most. */
export function findInLines(lines: readonly string[], query: string, matchCase: boolean): LineMatch[] {
  const out: LineMatch[] = [];
  if (query === "") return out;
  const re = findPattern(query, matchCase);
  for (let line = 0; line < lines.length && out.length < FIND_MAX; line++) {
    re.lastIndex = 0;
    for (let m = re.exec(lines[line]!); m && out.length < FIND_MAX; m = re.exec(lines[line]!)) out.push({ line, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** What a search's count says: which match of how many, none, or that it stopped counting. */
export function findWords(query: string, count: number, current: number): string {
  if (query === "") return "";
  if (count === 0) return "No results";
  return `${current + 1} of ${count >= FIND_MAX ? `${FIND_MAX}+` : count}`;
}

/** The grammars the viewer colours with (vendor/shj/), by name, and what each language is called. */
export const GRAMMARS: Readonly<Record<string, string>> = {
  asm: "Assembly",
  bash: "Shell",
  c: "C",
  css: "CSS",
  diff: "Diff",
  docker: "Dockerfile",
  go: "Go",
  html: "HTML",
  ini: "INI",
  java: "Java",
  js: "JavaScript",
  jsdoc: "JSDoc",
  json: "JSON",
  log: "Log",
  lua: "Lua",
  make: "Makefile",
  md: "Markdown",
  py: "Python",
  regex: "Regex",
  rs: "Rust",
  sql: "SQL",
  todo: "Text",
  toml: "TOML",
  ts: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

/** Other names a language goes by: a file's extension, or a fenced block's info string in markdown. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  python: "py",
  pyi: "py",
  pyw: "py",
  markdown: "md",
  mdx: "md",
  typescript: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  javascript: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ipynb: "json",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  fish: "bash",
  console: "bash",
  ps1: "bash",
  psm1: "bash",
  powershell: "bash",
  bat: "bash",
  cmd: "bash",
  rust: "rs",
  golang: "go",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  "c++": "c",
  cs: "java",
  csharp: "java",
  kt: "java",
  kts: "java",
  kotlin: "java",
  scala: "java",
  htm: "html",
  xhtml: "html",
  svelte: "html",
  vue: "html",
  svg: "xml",
  xaml: "xml",
  csproj: "xml",
  plist: "xml",
  scss: "css",
  less: "css",
  yml: "yaml",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  editorconfig: "ini",
  gitattributes: "ini",
  gitignore: "ini",
  npmrc: "ini",
  patch: "diff",
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  mk: "make",
  txt: "todo",
  text: "todo",
};

/** A grammar by a name a language goes by, whatever its case; undefined for one there is none for. */
export function grammarName(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  if (Object.hasOwn(GRAMMARS, n)) return n;
  return Object.hasOwn(LANGUAGE_ALIASES, n) ? LANGUAGE_ALIASES[n] : undefined;
}

/** The grammar a file is coloured with, by its whole name (`Dockerfile`, `.gitignore`) or else its extension; undefined for none. */
export function fileLanguage(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const whole = grammarName(name.replace(/^\./, ""));
  if (whole !== undefined && (name.startsWith(".") || !name.includes("."))) return whole;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? grammarName(name.slice(dot + 1)) : undefined;
}

/** A file's lines, as a viewer numbers them: any line ending, and none after the last line's own. */
export function fileLines(text: string): string[] {
  const lines = text.split(/\r\n?|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A file's size as the viewer says it: to a tenth under ten, so a file a little over what shows reads as more. */
function fileSizeWords(n: number): string {
  for (const [unit, size] of [
    ["GB", 1024 ** 3],
    ["MB", 1024 ** 2],
    ["KB", 1024],
  ] as const) {
    if (n < size) continue;
    const v = n / size;
    return `${v < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v))} ${unit}`;
  }
  return `${n} B`;
}

/** The most of a file its node sends whole (the daemon's WHOLE_MAX): past it, there is nothing to draw. */
export const WHOLE_SENT_MAX = 64 * 1024 * 1024;

/** A PDF, by its extension: the viewer draws it (pdfview.ts). */
export function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** An HTML page, by its extension: the viewer draws it, its scripts running in the document frame (htmldoc.ts). */
export function isHtml(path: string): boolean {
  return /\.(html?|xhtml)$/i.test(path);
}

/** Base64 as its bytes, a slice at a time, so a big file's never makes one string of it all. */
export function bytesOf(base64: string): Uint8Array {
  const out = new Uint8Array(Math.floor((base64.replace(/=+$/, "").length * 3) / 4));
  const SLICE = 4 * 1024 * 1024;
  let at = 0;
  for (let i = 0; i < base64.length; i += SLICE) {
    const part = atob(base64.slice(i, i + SLICE));
    for (let j = 0; j < part.length; j++) out[at++] = part.charCodeAt(j);
  }
  return out;
}

/** Whether the viewer reads a file whole to draw it, a piece at a time: an image but SVG (which comes as text), or a PDF. */
export function readsWhole(path: string): boolean {
  const image = imageKind(path);
  return (image !== undefined && image !== "SVG") || isPdf(path);
}

/**
 * What the viewer's head says of a file: its language or its kind of image, an image's size in
 * pixels once drawn (as its node's codecs drew it, for a TIFF or a HEIC), how many lines, or a
 * PDF's pages once it is open, and how big.
 */
export function viewerMeta(file: FileText, lines: number | undefined, pixels?: { width: number; height: number }, pages?: number): string {
  const language = fileLanguage(file.path);
  const image = imageKind(file.path);
  const kind = image ?? (isPdf(file.path) ? "PDF" : file.binary ? "Binary" : language !== undefined && language !== "todo" ? GRAMMARS[language] : "Text");
  const converted = image !== undefined && image !== "PNG" && file.mime === "image/png";
  const drawn = pixels ? `${converted ? "shown at " : ""}${pixels.width} × ${pixels.height}` : undefined;
  const counted = lines !== undefined && !file.binary && file.text !== undefined ? `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}${file.truncated ? " shown" : ""}` : pages !== undefined ? `${pages.toLocaleString()} page${pages === 1 ? "" : "s"}` : undefined;
  return [kind, drawn, counted, fileSizeWords(file.size)].filter(Boolean).join(" · ");
}

/** What the viewer says over a file it shows only part of, or none of; nothing for one shown whole. */
export function viewerNote(file: FileText): string {
  if (file.base64 !== undefined) return "";
  if (file.note !== undefined) return file.note;
  if (readsWhole(file.path) && (file.binary || file.text !== undefined)) {
    const what = isPdf(file.path) ? "PDF" : "image";
    return file.size > WHOLE_SENT_MAX ? `This ${what} is too big to show here: ${fileSizeWords(file.size)}, past ${fileSizeWords(WHOLE_SENT_MAX)}.` : `That computer's Cophyla is too old to show this ${what}: update it there.`;
  }
  if (file.binary) return "This file is not text, so there is nothing to show.";
  if (file.truncated) return `Only the first ${fileSizeWords(new TextEncoder().encode(file.text ?? "").length)} of ${fileSizeWords(file.size)} shows.`;
  return "";
}

/** Why a file could not be shown, in the viewer's words: an app or a node too old to read files, a refusal, or what the node said. */
export function fileErrorWords(code: string | undefined, message: string): string {
  if (code === "unsupported") return /unknown method/.test(message) ? "This app cannot show files yet: update it." : "That computer cannot show its files yet: update Cophyla there.";
  if (code === "not_found") return "There is no such file, or it has gone.";
  if (code === "unavailable") return "That computer is not connected.";
  if (code === "timeout") return "The file did not come back.";
  if (code === "invalid" && / a folder$/.test(message)) return "That is a folder, not a file.";
  return message;
}

/** A path in a terminal's row: where it stands in the row's text, the path, and the line written after it. */
export interface PathInText {
  start: number;
  end: number;
  path: string;
  line?: number;
  /** It ends in a separator: a folder. */
  folder?: true;
  /** Its last name has no extension and no separator follows it: a folder, a file such as `Makefile`, or no path at all (`and/or`, `1/2`). */
  plain?: true;
}

const PATH_IN_TEXT = /(?<path>(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*(?:(?<file>[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,11})|[\w@+-](?:[\w.@+-]*[\w@+-])?)?)(?::(?<line>\d+)(?::\d+)?)?/g;

/**
 * The paths a terminal's row names that the view could open, as Claude Code and a compiler
 * write them (`src/app.py`, `C:\repo\x.ts:12`, `apps/web/`): a name with an extension, in
 * folders or not, with the line after it when there is one; or names with a separator among
 * them and no extension, a folder's as often as not, marked `folder` when a separator ends
 * them and `plain` otherwise. A bare name counts only when its extension is a language's, so
 * `e.g.` and `v1.2` are none; one inside a URL or a longer word is left alone.
 */
export function pathsIn(text: string): PathInText[] {
  const out: PathInText[] = [];
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    const path = m.groups!["path"]!;
    if (m.index > 0 && /[\w.@+\\/:-]/.test(text[m.index - 1]!)) continue;
    // A root alone (`/`, `C:\`, `./`) names nothing.
    if (path.replace(/^(?:[A-Za-z]:|\.{1,2})?[\\/]/, "") === "") continue;
    const named = m.groups!["file"] !== undefined;
    if (!/[\\/]/.test(path) && (!named || fileLanguage(path) === undefined)) continue;
    const folder = /[\\/]$/.test(path);
    const line = m.groups!["line"] !== undefined ? Number(m.groups!["line"]) : undefined;
    out.push({ start: m.index, end: m.index + m[0].length, path, ...(line !== undefined && line > 0 ? { line } : {}), ...(folder ? { folder: true as const } : !named ? { plain: true as const } : {}) });
  }
  return out;
}

/** A relative path as the explorer keys it, `/` between the names and no `./` before; undefined for one that climbs out, or is absolute. */
export function relativeFile(path: string): string | undefined {
  if (/^([A-Za-z]:)?[\\/]/.test(path)) return undefined;
  const parts = path.split(/[\\/]/).filter((p) => p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "" || p === "..")) return undefined;
  return parts.join("/");
}

/** The text between two points of a file's lines, each a line's index and a column in it: what a copy of what is selected takes. */
export function linesBetween(lines: readonly string[], from: readonly [number, number], to: readonly [number, number]): string {
  const [l1, c1] = from;
  const [l2, c2] = to;
  if (l2 < l1 || (l1 === l2 && c2 <= c1)) return "";
  if (l1 === l2) return (lines[l1] ?? "").slice(c1, c2);
  return [(lines[l1] ?? "").slice(c1), ...lines.slice(l1 + 1, l2), (lines[l2] ?? "").slice(0, c2)].join("\n");
}

// --- the brain's context -----------------------------------------------------------------------

/** The Context overlay's head: each tier's estimated tokens, then the total. */
export function contextTokenWords(t: BrainContext["tokens"]): string {
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  return `situation ${n(t.situation)} · log ${n(t.log)} · working ${n(t.working)} · loaded ${n(t.loaded)} · ${n(t.total)} tokens`;
}

/** One block of what the brain sends, as the Context overlay shows it: whose, what kind, and its text. */
export interface ContextBlock {
  role: "user" | "assistant";
  label: string;
  text: string;
}

/** The brain's messages a block at a time: text as it is, a tool call by name with its input, a result as the model reads it (a collapsed one its stub), a picture by kind. */
export function contextBlocks(messages: BrainContext["messages"]): ContextBlock[] {
  const out: ContextBlock[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          // The empty text a model sends beside its tool calls says nothing.
          if (b.text.trim()) out.push({ role: m.role, label: m.role, text: b.text });
          break;
        case "tool_use":
          out.push({ role: m.role, label: `${m.role} · calls ${b.name}`, text: JSON.stringify(b.input ?? {}, null, 2) });
          break;
        case "tool_result":
          out.push({ role: m.role, label: `${m.role} · result${b.isError ? ", an error" : ""}`, text: b.content });
          break;
        case "image":
          out.push({ role: m.role, label: `${m.role} · picture`, text: `[${b.mime}]` });
          break;
      }
    }
  }
  return out;
}

// --- voice and controllers ---------------------------------------------------------------------

/** A conversation is running, or an engine is being set up: the chat tab pulses. */
export function voiceBusy(state: ViewState): boolean {
  return state.voice !== undefined || state.setup !== undefined;
}

/** The speaker beside the chat's tab, as it looks: nothing to read out, the next reply read out, one being read now, or what was pending hushed. */
export type SpeakerLook = "dim" | "lit" | "playing" | "hushed";

export interface SpeakerButton {
  look: SpeakerLook;
  /** Its tooltip, which names where the reply is read out. */
  title: string;
  /** What a press sends: `voice.hush {on}`. */
  on: boolean;
  disabled: boolean;
}

/**
 * The speaker button, from the node's `voice.next`: hidden until the node says, since an older
 * node never will. A press stops what is being read out, silences what is pending, or, once
 * silenced, reads it out after all; with nothing to read out, it turns speech on here, for
 * what is pending and the next reply.
 */
export function speakerButton(state: ViewState): SpeakerButton | undefined {
  const next = state.next;
  if (!next || !state.scopes.includes("voice")) return undefined;
  const disabled = !state.connected;
  const where = next.target !== undefined && next.target === state.client?.id ? "here" : next.name !== undefined ? `on ${next.name}` : "";
  if (state.voice?.state === "speaking") return { look: "playing", title: "Reading a reply out: press to stop", on: true, disabled };
  if (next.hushed) return { look: "hushed", title: "Replies are shown, not read out: press to read them out again", on: false, disabled };
  if (next.speak) return { look: "lit", title: `The next reply will be read out${where ? ` ${where}` : ""}: press to show it only`, on: true, disabled };
  return { look: "dim", title: "Nothing is waiting to be read out: press to hear the next reply here", on: false, disabled };
}

/**
 * This view's own utterance is being heard or transcribed, however it began (the wake word, the
 * talk key or the talk button), so Escape can take it back. Another client's is not this one's to drop.
 */
export function voiceCancellable(state: ViewState): boolean {
  const v = state.voice;
  if (!v || (v.state !== "listening" && v.state !== "transcribing")) return false;
  return state.connected && state.scopes.includes("voice") && (v.client === undefined || v.client === state.client?.id);
}

/**
 * What the voice row says: the state, the phone it belongs to, the time left near the
 * utterance's limit, and that the node stopped hearing it; or the setup step; with none of
 * those, why this view's last utterance came to less than was said, then why the host's
 * microphone is off.
 */
export function voiceWords(state: ViewState, now = Date.now()): string {
  if (state.setup) {
    const percent = state.setup.progress === undefined ? "" : ` ${Math.round(state.setup.progress * 100)}%`;
    const step = SETUP_WORD[state.setup.step] ?? state.setup.step;
    return `${state.setup.engine}: ${step}${percent}`;
  }
  const note = state.voiceNote;
  if (state.voice) {
    const who = state.voice.client ? namedController(state) : undefined;
    const left = timeLeft(state.voice, now);
    const words = [state.voice.state, who, left !== undefined ? `${left} left` : undefined];
    if (note && "stopped" in note) words.push(stoppedWords(note.stopped, note.limit));
    return words.filter((w) => w !== undefined).join(" · ");
  }
  if (note) return "stopped" in note ? stoppedWords(note.stopped, note.limit) : unheardWords(note.unheard, micOff(state));
  const off = micOff(state);
  return off !== undefined ? `The microphone is off: ${off}` : "";
}

/** The voice row's dot: the voice state, an engine set up, or trouble when a press or the microphone went wrong, or a stop cut what was said. */
export function voiceDot(state: ViewState): string {
  if (state.setup) return "setup";
  if (state.voice) return state.voice.state;
  const note = state.voiceNote;
  if (note) return "stopped" in note || note.unheard === "no-audio" || note.unheard === "silence" ? "trouble" : "idle";
  return micOff(state) !== undefined ? "trouble" : "idle";
}

/** How long before an utterance's limit the voice row counts down: the last 30 s of a long one, the last 10 s of a short one. */
export function countdownFrom(limit: number): number {
  return limit >= 120 ? 30 : 10;
}

/** The time an utterance being heard has left as `m:ss`, once it is within `countdownFrom` of its limit. */
export function timeLeft(row: VoiceRow, now: number): string | undefined {
  if (row.state !== "listening" || row.limit === undefined) return undefined;
  const left = Math.max(0, Math.ceil(row.limit - (now - row.at) / 1000));
  if (left > countdownFrom(row.limit)) return undefined;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** That the node stopped hearing an utterance while the user still spoke: at its limit, or with the month's allowance used up. */
export function stoppedWords(stopped: VoiceStopped, limit?: number): string {
  if (stopped === "quota") return "Stopped: this month's transcription allowance is used up — what came after wasn't recorded";
  const minutes = limit === undefined ? 0 : limit % 60 === 30 ? `${Math.floor(limit / 60)}½` : String(Math.round(limit / 60));
  const at = limit === undefined ? "the limit" : limit >= 60 ? `the ${minutes}-minute limit` : `the ${Math.round(limit)}-second limit`;
  return `Stopped at ${at} — what came after wasn't recorded`;
}

/** Why the host's microphone is off, where the host draws no talk button of its own and so says. */
export function micOff(state: ViewState): string | undefined {
  return state.hostTalk ? state.hostMic : undefined;
}

/**
 * Why a press came to nothing, in words: what the node heard of it, and, when no sound came,
 * why the host's microphone is off when the host said.
 */
export function unheardWords(unheard: VoiceUnheard, off?: string): string {
  switch (unheard) {
    case "no-audio":
      return off !== undefined ? `Nothing was heard: the microphone is off (${off})` : "Nothing was heard: no sound came from the microphone";
    case "silence":
      return off !== undefined ? `Nothing was heard: the microphone is off (${off})` : "Nothing was heard: the microphone sent only silence. Is it unplugged or muted?";
    case "no-speech":
      return "No speech was heard";
    case "no-words":
      return "Nothing could be made out of what was said";
  }
}

/**
 * The phone a conversation is on, when the view can say which. `voice.state` names the
 * client, and `controller.list` is keyed by controller, and a view holds no list of clients
 * to join them on — so the name is shown only while one controller is connected, which is
 * the usual case and the one where a name helps.
 */
export function namedController(state: ViewState): string | undefined {
  const connected = [...state.controllers.values()].filter((c) => c.connected);
  return connected.length === 1 ? connected[0]!.name : undefined;
}

const SETUP_WORD: Record<string, string> = {
  uv: "fetching the package tool",
  venv: "making the environment",
  deps: "installing",
  weights: "fetching the weights",
  starting: "starting",
  ready: "ready",
  failed: "failed",
};

/** The code in two groups and the time left, for the pairing panel. */
export function pairingWords(offer: PairingOffer, now: number): { code: string; left: string; expired: boolean } {
  return { code: `${offer.code.slice(0, 3)} ${offer.code.slice(3)}`, ...leftWords(offer.expiresAt, now) };
}

/** The login code as the page wants it and the time left, for the account card. */
export function loginWords(offer: LoginOffer, now: number): { code: string; left: string; expired: boolean } {
  return { code: offer.userCode, ...leftWords(offer.expiresAt, now) };
}

// --- the account ------------------------------------------------------------------------------

export interface AccountBar {
  label: string;
  percent: number;
  words: string;
}

/**
 * The backup row under the bars. `plan`: the plan has none. `off`: nothing on the server,
 * Turn on offered. `available`: the server holds a backup this node has no key for (a
 * fresh install), Restore and Turn on offered, the latter able to start over. `on`: this
 * node keeps it, `state` how the sender is doing, Turn off offered (and Take over when
 * another node owns it). `restoring`: the progress, nothing offered.
 */
export interface BackupRow {
  kind: "plan" | "off" | "available" | "on" | "restoring";
  /** The line that says how it stands. */
  words: string;
  state?: BackupState["state"];
  /** What the server holds, in words: when, how many, how big. */
  remote?: string;
  /** The turn-on form may offer to start over: the server holds a backup already. */
  canReplace: boolean;
  /** A restore's progress, 0 to 100. */
  progress?: number;
}

export interface AccountCard {
  /** Signed out, a login open, or signed in. */
  kind: "out" | "login" | "in";
  title: string;
  /** The plan and what it grants, in a line. */
  sub: string;
  /** The link, when signed in. */
  connected?: boolean;
  /** One bar per metered metric with a cap; nothing while the caps are unknown. */
  bars: AccountBar[];
  /** The cloud backup, once signed in. */
  backup?: BackupRow;
  /** Direct connections, once signed in. */
  direct?: DirectRow;
}

/** One node's direct connections on the account card: its switch and how it stands. */
export interface DirectLine {
  node: NodeId;
  name: string;
  on: boolean;
  state: DirectState["state"];
  words: string;
}

/** The direct connections row: `plan` when the plan has none, else a line per node that said where it stands. */
export interface DirectRow {
  kind: "plan" | "nodes";
  words: string;
  lines: DirectLine[];
}

const METRIC_LABELS: Record<string, string> = { llm_tokens_in: "tokens in", llm_tokens_out: "tokens out", stt_seconds: "speech in", tts_chars: "speech out", embed_tokens: "embeddings", relay_messages: "relay", push_count: "pushes", relayed_nodes: "relayed nodes", backup_bytes: "backup" };

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** How long ago, in words: just now, 3 min ago, 2 h ago, 4 d ago. */
export function agoWords(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** The backup row from the account's backup state and the plan. */
export function selectBackup(a: AccountState, now: number): BackupRow | undefined {
  const b = a.backup;
  if (!b) return undefined;
  const hosted = (a.limits as { hosted?: { backup?: boolean } }).hosted;
  const remote = b.remote ? `a backup${b.remote.updatedAt !== undefined ? ` from ${new Date(b.remote.updatedAt).toLocaleDateString()}` : ""}, ${b.remote.objects} items, ${bytesWords(b.remote.bytes)}` : undefined;
  if (b.state === "restoring") {
    const p = b.progress;
    return { kind: "restoring", words: p && p.total > 0 ? `Restoring, ${p.done} of ${p.total}` : "Restoring…", state: b.state, canReplace: false, progress: p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0 };
  }
  if (!hosted?.backup) return { kind: "plan", words: "Not on this plan.", canReplace: false };
  if (!b.enabled) {
    if (remote) return { kind: "available", words: `The server holds ${remote}.`, remote, canReplace: true };
    return { kind: "off", words: "Off. Memory, prompts, the chat and tasks stay on this computer alone.", canReplace: false };
  }
  let words: string;
  switch (b.state) {
    case "syncing":
      words = `Syncing${b.pending !== undefined ? `, ${b.pending} to go` : "…"}`;
      break;
    case "conflict":
      words = "Another computer keeps the backup now.";
      break;
    case "full":
      words = "The plan's backup space is full.";
      break;
    case "paused":
      words = `Paused${b.error ? `: ${b.error}` : ""}`;
      break;
    default:
      words = `Synced${b.bytes !== undefined ? `, ${bytesWords(b.bytes)}` : ""}${b.lastSyncAt !== undefined ? `, ${agoWords(b.lastSyncAt, now)}` : ""}`;
  }
  return { kind: "on", words, state: b.state, ...(remote !== undefined ? { remote } : {}), canReplace: true };
}

/** The account card: signed out, the login's code, or the subject, plan, link and usage. */
export function selectAccount(state: ViewState, now = Date.now()): AccountCard {
  const a = state.account;
  if (state.login) return { kind: "login", title: "Sign in on the page that opened", sub: "or open the address below and type the code", bars: [] };
  if (!a || a.subject === undefined) return { kind: "out", title: "Not signed in", sub: "The free plan: your own model key, up to 2 agents at once.", bars: [] };
  const limits = a.limits as { sessions?: number; memoryTier?: string; hosted?: { llm?: boolean; voice?: boolean; relay?: boolean; push?: boolean } };
  const hosted = [limits.hosted?.llm ? "hosted model" : "", limits.hosted?.voice ? "hosted voice" : "", limits.hosted?.relay ? "relay" : "", limits.hosted?.push ? "push" : ""].filter(Boolean).join(", ");
  const sub = `${a.plan}${hosted ? ` · ${hosted}` : ""}${limits.sessions !== undefined ? ` · ${limits.sessions} agents` : ""}${limits.memoryTier ? ` · memory ${limits.memoryTier}` : ""}`;
  const bars: AccountBar[] = [];
  for (const [metric, m] of Object.entries(a.usage?.metrics ?? {})) {
    if (!(m.cap > 0)) continue;
    bars.push({ label: METRIC_LABELS[metric] ?? metric, percent: Math.min(100, Math.round((m.used / m.cap) * 100)), words: `${compact(m.used)} / ${compact(m.cap)}` });
  }
  const backup = selectBackup(a, now);
  const direct = selectDirect(state);
  return { kind: "in", title: a.subject, sub, connected: a.connected ?? false, bars, ...(backup ? { backup } : {}), ...(direct ? { direct } : {}) };
}

const MAPPING_NAMES: Record<string, string> = { upnp: "UPnP", pcp: "PCP", "nat-pmp": "NAT-PMP" };

/** How a node's direct connections stand, in a line: off, starting, why not, or on with the router's mapping and each channel open now. */
export function directWords(s: DirectState, state: Pick<ViewState, "controllers" | "nodes">): string {
  switch (s.state) {
    case "off":
      return "Off: away from home, phones and other computers go through the relay.";
    case "starting":
      return s.reason ? `Starting: ${s.reason}` : "Starting…";
    case "unavailable":
      return s.reason ? `Unavailable: ${s.reason}` : "Unavailable";
    case "ready": {
      const parts = ["On"];
      if (s.mapping?.status === "mapped") parts.push(`the router maps its port${s.mapping.protocols?.length ? ` (${s.mapping.protocols.map((p) => MAPPING_NAMES[p] ?? p).join(", ")})` : ""}`);
      else if (s.mapping?.status === "probing") parts.push("asking the router for a port");
      for (const p of s.peers) {
        const name = p.kind === "controller" ? (state.controllers.get(p.id)?.name ?? "a phone") : (state.nodes.get(p.id)?.name ?? "a computer");
        parts.push(`${name} ${p.path === "relay" ? "through TURN" : "direct"}${p.rttMs !== undefined ? `, ${Math.round(p.rttMs)} ms` : ""}`);
      }
      return parts.join(" · ");
    }
  }
}

/** The direct connections row: nothing while signed out, the plan's refusal, or a line per node, this one first. */
export function selectDirect(state: ViewState): DirectRow | undefined {
  const a = state.account;
  if (!a || a.subject === undefined) return undefined;
  const hosted = (a.limits as { hosted?: { direct?: boolean } }).hosted;
  if (!hosted?.direct) return { kind: "plan", words: "Not on this plan.", lines: [] };
  const self = state.node;
  const lines = [...state.direct.values()]
    .map((s): DirectLine => ({ node: s.node, name: state.nodes.get(s.node)?.name ?? s.node, on: s.state !== "off", state: s.state, words: directWords(s, state) }))
    .sort((x, y) => Number(y.node === self) - Number(x.node === self) || x.name.localeCompare(y.name));
  return { kind: "nodes", words: "Phones and computers on other networks reach a node straight, not through the relay.", lines };
}

/** The time until `expiresAt` as m:ss, and whether it has passed. */
function leftWords(expiresAt: number, now: number): { left: string; expired: boolean } {
  const left = Math.max(0, expiresAt - now);
  const seconds = Math.floor(left / 1000);
  return { left: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`, expired: left <= 0 };
}

// --- grants: invites, phones' access, nodes' roles ------------------------------------------------

/** An invite just minted, as its panel shows it: whose, the text to paste, the link its QR code holds, until when. */
export interface IssuedInvite {
  grant: string;
  kind: GrantKind;
  name: string;
  text: string;
  link: string;
  expiresAt: number;
}

/** What a phone may be given: everything, its sessions, or a look. The protocol's presets (`ACCESS_PRESETS`); the frame imports types only. */
export const PHONE_PRESETS = {
  full: { label: "Everything", scopes: ["chat", "sessions:read", "sessions:write", "tasks:read", "tasks:write", "asks:answer", "voice", "views", "controllers", "nodes", "audit:read", "metrics:read", "account", "updates", "remote", "terminal"] },
  sessions: { label: "Its sessions", scopes: ["sessions:read", "sessions:write", "asks:answer", "views", "metrics:read"] },
  view: { label: "Look only", scopes: ["sessions:read", "views", "metrics:read"] },
} as const satisfies Record<string, { label: string; scopes: readonly Scope[] }>;
export type PhonePreset = keyof typeof PHONE_PRESETS;

/** How long a new grant lasts: an hour, a day, a week, a month, or until it is removed. */
export const GRANT_ENDS = [
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "1d", label: "1 day", ms: 86_400_000 },
  { key: "7d", label: "1 week", ms: 7 * 86_400_000 },
  { key: "30d", label: "30 days", ms: 30 * 86_400_000 },
  { key: "never", label: "No end" },
] as const;
export type GrantEnd = (typeof GRANT_ENDS)[number]["key"];

/** What a phone's invite asks for: a preset, perhaps kept to one node or one workspace, and an end. */
export interface PhoneInviteForm {
  name: string;
  preset: PhonePreset;
  /** `node:<id>` or `workspace:<id>`; the whole of what the preset reaches when absent. */
  limit?: string;
  end: GrantEnd;
}

/**
 * The `grant.invite` params a phone's form gives. Everything cannot be kept to a node or a
 * workspace (limited access holds no global scope), so a limit on it is refused here, as the
 * node would refuse it.
 */
export function phoneInviteParams(form: PhoneInviteForm): { kind: "controller"; name: string; access: Access; expiresIn?: number } | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "name the phone" };
  const preset = PHONE_PRESETS[form.preset];
  const access: Access = { scopes: [...preset.scopes], messages: form.preset === "full" ? "send" : "none" };
  if (form.limit) {
    if (form.preset === "full") return { error: "everything reaches every node: pick its sessions or a look to keep it to one" };
    const [kind, id] = [form.limit.slice(0, form.limit.indexOf(":")), form.limit.slice(form.limit.indexOf(":") + 1)];
    if (kind === "node") access.nodes = [id as NodeId];
    else if (kind === "workspace") access.workspaces = [id as Workspace["id"]];
    else return { error: "no such limit" };
  }
  const end = GRANT_ENDS.find((e) => e.key === form.end);
  return { kind: "controller", name, access, ...(end && "ms" in end ? { expiresIn: end.ms } : {}) };
}

/** What a node's invite asks for: a name, whether the node is hands or a full member, and an end. */
export interface NodeInviteForm {
  name: string;
  role: GrantRole;
  end: GrantEnd;
}

export function nodeInviteParams(form: NodeInviteForm): { kind: "node"; name: string; role: GrantRole; expiresIn?: number } | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "name the machine" };
  const end = GRANT_ENDS.find((e) => e.key === form.end);
  return { kind: "node", name, role: form.role, ...(end && "ms" in end ? { expiresIn: end.ms } : {}) };
}

/** What a phone may be kept to: this node and the others, and each workspace, by name. */
export function limitChoices(state: ViewState): { key: string; label: string }[] {
  const nodes = [...state.nodes.values()].sort((a, b) => Number(b.id === state.node) - Number(a.id === state.node) || a.name.localeCompare(b.name));
  const workspaces = [...state.workspaces.values()].sort((a, b) => a.name.localeCompare(b.name));
  const nodeName = (id: NodeId) => state.nodes.get(id)?.name ?? id;
  return [
    ...nodes.map((n) => ({ key: `node:${n.id}`, label: `only ${n.name}` })),
    ...workspaces.map((w) => ({ key: `workspace:${w.id}`, label: `only ${w.name}${nodes.length > 1 ? ` on ${nodeName(w.node)}` : ""}` })),
  ];
}

/** An access in words, as a phone's row says it: the preset it matches, and what it is kept to. */
export function accessWords(access: Access | undefined, state: ViewState): string {
  if (!access) return "everything";
  const has = (scopes: readonly string[]) => scopes.length === access.scopes.length && scopes.every((s) => access.scopes.includes(s as Scope));
  const preset = (Object.keys(PHONE_PRESETS) as PhonePreset[]).find((k) => has(PHONE_PRESETS[k].scopes));
  const what = preset === "full" ? "everything" : preset === "sessions" ? "its sessions" : preset === "view" ? "look only" : `${access.scopes.length} scope${access.scopes.length === 1 ? "" : "s"}`;
  const kept = [
    ...(access.nodes ?? []).map((n) => state.nodes.get(n)?.name ?? n),
    ...(access.workspaces ?? []).map((w) => state.workspaces.get(w)?.name ?? w),
    ...(access.paths ?? []),
  ];
  return kept.length > 0 ? `${what} · only ${kept.join(", ")}` : what;
}

/** When a grant ends, in words: in how long, or that it has; nothing for one with no end. */
export function endWords(expiresAt: number | undefined, now: number): string | undefined {
  if (expiresAt === undefined) return undefined;
  const left = expiresAt - now;
  if (left <= 0) return "ended";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `ends in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `ends in ${hours}h`;
  return `ends in ${Math.round(hours / 24)}d`;
}

/** The invites still waiting to be redeemed, the soonest to run out first, with how long each holds. */
export function selectPendingInvites(state: ViewState, now: number): { grant: Grant; left: string; expired: boolean }[] {
  return [...state.grants.values()]
    .filter((g) => g.status === "pending")
    .sort((a, b) => (a.inviteExpiresAt ?? Infinity) - (b.inviteExpiresAt ?? Infinity) || a.name.localeCompare(b.name))
    .map((grant) => ({ grant, ...leftWords(grant.inviteExpiresAt ?? now, now) }));
}

/** The invite panel's words: how long it holds. */
export function issuedWords(invite: IssuedInvite, now: number): { left: string; expired: boolean } {
  return leftWords(invite.expiresAt, now);
}

/** A node's grant: the row its invite was redeemed into, bound to it. */
export function nodeGrant(state: ViewState, node: NodeId): Grant | undefined {
  for (const g of state.grants.values()) if (g.kind === "node" && g.node === node) return g;
  return undefined;
}

/**
 * What a node's card says of its grant: hands or a full member, when it ends, and whether it
 * must be invited again; and whether the desktop may remove it (any node but this one, whose
 * grant this node keeps), with what removing it would do.
 */
export function nodeGrantWords(state: ViewState, node: Node, now: number): { badge?: GrantRole; end?: string; reinvite: boolean; removable: boolean; removeWords: string } {
  const grant = nodeGrant(state, node.id);
  const badge = node.hands ? "hands" : grant?.role;
  const end = endWords(grant?.expiresAt, now);
  const removable = grant !== undefined && node.id !== state.node && state.scopes.includes("controllers");
  const removeWords = node.backup ? `Remove ${node.name}? It can no longer reach this node, and the other nodes get new keys, since it held them all.` : `Remove ${node.name}? It can no longer reach this node.`;
  return { ...(badge ? { badge } : {}), ...(end ? { end } : {}), reinvite: grant?.status === "reinvite", removable, removeWords };
}

/**
 * What the desktop offers this node itself: Join a primary while it is alone (no other node in
 * the list), Leave once it is a secondary. A phone is never offered either: joining and leaving
 * are asked on the machine itself.
 */
export function membershipOffer(state: ViewState): "join" | "leave" | undefined {
  if (state.client?.kind !== "ui" || !state.scopes.includes("nodes") || state.node === undefined) return undefined;
  const self = state.nodes.get(state.node);
  if (!self) return undefined;
  if (self.role === "secondary" && [...state.nodes.values()].some((n) => n.role === "primary" && n.id !== self.id)) return "leave";
  if ([...state.nodes.keys()].every((id) => id === self.id)) return "join";
  return undefined;
}

/** The folders a join shares, one per line as typed: blank lines and stray spaces dropped. */
export function joinPaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The paired controllers, the connected ones first, then by when they were paired. */
export function selectControllers(state: ViewState): Controller[] {
  return [...state.controllers.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || b.pairedAt - a.pairedAt);
}

/** When a controller was last seen, in words. */
export function controllerWords(controller: Controller, now: number): string {
  const seen = controller.connected ? "connected" : controller.lastSeen === undefined ? "never connected" : `last seen ${ago(controller.lastSeen, now)}`;
  // what the phone can do from elsewhere: reach this node through the relay, and be told of an ask by a push
  const can = [controller.relay ? "relay" : "", controller.push ? `push (${controller.push.platform})` : ""].filter(Boolean).join(" · ");
  // and how it came to be paired, when that was the account rather than a code
  const how = controller.account !== undefined ? `paired through ${controller.account}` : "";
  return [seen, can, how].filter(Boolean).join(" · ");
}

function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// --- asks ------------------------------------------------------------------------------------

/** The reserved option id of a free-text answer (`ASK_TEXT_OPTION` in the protocol; the view imports types only). */
const TEXT_OPTION = "text";

/** What the user has picked and typed on an ask's form. */
export interface AskDraft {
  selected: string[];
  text: string;
  remember?: string;
}

export interface AnswerParams {
  id: string;
  option: string;
  options?: string[];
  text?: string;
  remember?: "session" | "always";
}

/**
 * The `ask.answer` params a draft makes, or `undefined` when there is nothing to send: a
 * clicked or ticked option (every one on a `multiple` ask), else the text alone under the
 * reserved `text` id when the ask allows it. Text beside a pick rides along as a note.
 */
export function answerParams(ask: Ask, draft: AskDraft): AnswerParams | undefined {
  const declared = new Set(ask.options.map((o) => o.id));
  const selected = [...new Set(draft.selected)].filter((id) => declared.has(id));
  const text = draft.text.trim();
  const params: AnswerParams = { id: ask.id, option: "" };
  if (selected.length > 0) {
    params.option = selected[0]!;
    if (ask.multiple) params.options = selected;
  } else if (text && ask.allowsText === true) {
    params.option = TEXT_OPTION;
  } else {
    return undefined;
  }
  if (text) params.text = text;
  if (draft.remember === "session" || draft.remember === "always") params.remember = draft.remember;
  return params;
}

/** An answer in words: the labels of what was chosen, the text quoted when it is the answer, else appended as a note. */
export function answerWords(ask: Ask, answer: AskAnswer): string {
  const labels: string[] = [];
  for (const id of answer.options ?? [answer.option]) {
    const declared = ask.options.find((o) => o.id === id);
    if (declared) labels.push(declared.label);
    else if (id !== TEXT_OPTION) labels.push(id);
  }
  const text = answer.text?.trim();
  if (labels.length === 0) return text ? `“${text}”` : answer.option;
  return labels.join(", ") + (text ? `: ${text}` : "");
}

/** The words of an `ask` event on a timeline: a question or a prompt, and what became of it. */
export function askEventText(payload: Record<string, unknown>, ask: Ask | undefined): { label: "question" | "prompt"; text: string } {
  const phase = String(payload["phase"] ?? "");
  const question = ask ? ask.type !== "permission" : payload["tool"] === "AskUserQuestion" || payload["question"] !== undefined;
  const title = ask?.title ?? (question ? "a question" : payload["tool"] ? `${String(payload["tool"])} permission` : "a prompt");
  let text = title;
  if (phase === "opened") text = `${title}: waiting`;
  else if (phase === "answered") {
    const answer = (payload["answer"] as AskAnswer | undefined) ?? ask?.answer;
    let words = "answered";
    if (answer && ask) words = answerWords(ask, answer);
    else if (answer) words = answer.option === TEXT_OPTION && answer.text ? `“${answer.text.trim()}”` : (answer.options ?? [answer.option]).join(", ");
    text = `${title}: ${words}`;
  } else if (phase === "closed") text = `${title}: closed${payload["reason"] ? ` (${String(payload["reason"])})` : ""}`;
  return { label: question ? "question" : "prompt", text };
}

/** The words of a message's blocks, for a list. */
export function messageText(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === "text" || b.type === "quote" ? b.text : "")).join(" ").trim();
}

/** The profile's label, or a short form of its id until `profile.list` has answered. */
export function profileName(state: ViewState, session: Session): string {
  return state.profiles.get(session.profile)?.name ?? session.profile.replace(/^prof_/, "").slice(0, 6);
}

export type TaskAction = "pause" | "resume" | "complete";

/**
 * What the user may do to an open task from the stream, given the view's scopes: pause a
 * scheduled task that waits or is ready, resume a paused one, and mark any open task done.
 */
export function taskActions(task: Task, scopes: Scope[]): TaskAction[] {
  if (!scopes.includes("tasks:write")) return [];
  const out: TaskAction[] = [];
  if (task.trigger && (task.status === "pending" || task.status === "ready")) out.push("pause");
  if (task.status === "paused") out.push("resume");
  if (task.status !== "done" && task.status !== "cancelled") out.push("complete");
  return out;
}

// --- nodes and metrics ---------------------------------------------------------------------

export interface NodeBar {
  /** cpu, memory, or a GPU's name. */
  label: string;
  /** 0–100, or undefined when there is no reading. */
  percent?: number;
  /** The reading in words: a percentage, or used of total. */
  words: string;
}

/** The processes of one owner summed: a session named as its tab is, the platform, the brain, a sidecar, or the rest. */
export interface OwnerRow {
  key: string;
  label: string;
  kind: ProcessOwner["kind"];
  cpu: number;
  memory: number;
}

export interface NodeCard {
  node: Node;
  /** The node's role and state in words, beside its name. */
  sub: string;
  sample?: MetricsSample;
  bars: NodeBar[];
  owners: OwnerRow[];
}

/**
 * Whether a node's card offers Restart: the node this client is connected to, from the
 * desktop app. A phone's host does not know the request, and a machine seen through the
 * primary is not the one this client would restart.
 */
export function restartable(state: ViewState, node: Node): boolean {
  return node.id === state.node && state.client?.kind === "ui" && state.scopes.includes("nodes");
}

/**
 * What a machine's card offers to make it the primary, or nothing: the role moves only by the
 * user's choice. From an app that sees the primary, any other connected machine holding the
 * replica, which the primary hands the role to. From an app on a secondary that reaches no
 * primary, that computer itself: it takes the role, and the old primary, back, follows it.
 */
export function promoteOffer(state: ViewState, node: Node): { title: string; ask: string } | undefined {
  if (!state.scopes.includes("nodes") || node.hands || node.role === "primary" || state.node === undefined) return undefined;
  const talking = state.nodes.get(state.node);
  if (!talking) return undefined;
  if (talking.role === "primary") {
    if (node.status !== "online" || !node.backup) return undefined;
    return { title: `Make ${node.name} the primary: the brain, the chat and the tasks move there`, ask: `Make ${node.name} the primary? The brain, the chat and the tasks move there, and ${talking.name} becomes a secondary.` };
  }
  // the app sees a secondary on its own: its primary is out of reach
  if (node.id !== talking.id) return undefined;
  const old = [...state.nodes.values()].find((n) => n.role === "primary" && n.id !== node.id)?.name ?? "The primary";
  return { title: `${old} cannot be reached: make ${node.name} the primary`, ask: `Make ${node.name} the primary? ${old} cannot be reached now; when it is back, it follows ${node.name} as a secondary.` };
}

/** Whether a machine's card offers Rename: an app with the nodes scope, and a machine it reaches (itself, or a connected one through the primary) that is not lent as hands. */
export function renamable(state: ViewState, node: Node): boolean {
  if (!state.scopes.includes("nodes") || node.hands || state.node === undefined) return false;
  if (node.id === state.node) return true;
  return state.nodes.get(state.node)?.role === "primary" && node.status === "online";
}

/** What a restart would cut off, when the node refused it for that. */
export function restartWords(reasons: string[]): string {
  return reasons.length === 0 ? "Busy." : `Busy: ${reasons.join(", ")}. Restarting now cuts ${reasons.length === 1 ? "it" : "them"} off.`;
}

/**
 * The dot at the right of the chat tab: green while the line to cophylad is open, a ring while it is
 * not, the node and its platform on hover. The desktop app has no status line of its own; a
 * phone's chrome shows the line itself, so there is none there.
 */
export function linkWords(state: ViewState): { status: "connected" | "gone"; title: string } | undefined {
  if (state.client?.kind === "controller") return undefined;
  if (!state.connected) return { status: "gone", title: "Not connected to cophylad" };
  const name = state.node !== undefined ? (state.nodes.get(state.node)?.name ?? state.node) : undefined;
  const about = [name, state.platformVersion !== undefined ? `platform ${state.platformVersion}` : undefined].filter(Boolean).join(" · ");
  return { status: "connected", title: about ? `Connected to cophylad — ${about}` : "Connected to cophylad" };
}

/**
 * One card per node: the computer the app runs on first (the one it talks to, from a phone),
 * then the primary, then by name; its bars from the latest sample and its processes summed by
 * owner. The line beside the name says which is this computer (a desktop app's own, never a
 * phone's) and each one's role.
 */
export function selectNodes(state: ViewState): NodeCard[] {
  const first = hereNode(state);
  const own = state.client?.node;
  const nodes = [...state.nodes.values()].sort((a, b) => Number(b.id === first) - Number(a.id === first) || Number(b.role === "primary") - Number(a.role === "primary") || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  return nodes.map((node) => {
    const sample = state.metrics.get(node.id);
    const sub = [node.id === own ? "this computer" : "", node.role, node.via === "relay" ? "via relay" : "", node.status === "online" ? "" : node.status].filter(Boolean).join(" · ");
    const card: NodeCard = { node, sub, bars: [], owners: [] };
    if (!sample) {
      card.bars.push({ label: "cpu", words: "—" }, { label: "memory", words: "—" });
      return card;
    }
    card.sample = sample;
    card.bars.push({ label: "cpu", percent: clamp(sample.cpu), words: percentWords(sample.cpu) });
    const memoryPct = sample.memory.total > 0 ? (sample.memory.used / sample.memory.total) * 100 : 0;
    card.bars.push({ label: "memory", percent: clamp(memoryPct), words: usedWords(sample.memory.used, sample.memory.total) });
    for (const gpu of sample.gpu ?? []) {
      const vram = gpu.vramTotal > 0 ? ` · ${usedWords(gpu.vramUsed, gpu.vramTotal)}` : "";
      card.bars.push({ label: gpu.name, percent: clamp(gpu.util), words: `${percentWords(gpu.util)}${vram}` });
    }
    const owners = new Map<string, OwnerRow>();
    for (const p of sample.processes) {
      const key = ownerKey(p.owner);
      let row = owners.get(key);
      if (!row) {
        row = { key, label: ownerLabel(state, p.owner), kind: p.owner.kind, cpu: 0, memory: 0 };
        owners.set(key, row);
      }
      row.cpu += p.cpu;
      row.memory += p.memory;
    }
    card.owners = [...owners.values()].sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || a.label.localeCompare(b.label));
    return card;
  });
}

function clamp(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function ownerKey(owner: ProcessOwner): string {
  switch (owner.kind) {
    case "session":
      return `session:${owner.session}`;
    case "sidecar":
      return `sidecar:${owner.name}`;
    default:
      return owner.kind;
  }
}

function ownerLabel(state: ViewState, owner: ProcessOwner): string {
  switch (owner.kind) {
    case "session": {
      const card = state.sessions.get(owner.session);
      return card ? sessionLabel(card.session) : owner.session.replace(/^sess_/, "").slice(0, 6);
    }
    case "platform":
      return "cophylad";
    case "brain":
      return "brain";
    case "sidecar":
      return owner.name;
    case "other":
      return "everything else";
  }
}

export interface SpendRow {
  profile: string;
  name: string;
  spend: Spend;
  /** The login's plan limits, from its node's latest sample. */
  limits?: ProfileLimits;
}

/**
 * Spend per profile summed over every node, with each login's plan limits beside it, the
 * costliest first; a profile with limits and nothing spent has a row too. Profiles named as
 * `profile.list` has them.
 */
export function selectSpend(state: ViewState): SpendRow[] {
  const total = new Map<string, Spend>();
  for (const node of state.spend.values()) {
    for (const [profile, s] of node.byProfile) {
      const cur = total.get(profile) ?? { in: 0, out: 0, cached: 0, cost: 0 };
      cur.in += s.in;
      cur.out += s.out;
      cur.cached += s.cached;
      cur.cost += s.cost;
      total.set(profile, cur);
    }
  }
  const limits = new Map<string, ProfileLimits>();
  for (const sample of state.metrics.values()) for (const [profile, l] of Object.entries(sample.limits ?? {})) limits.set(profile, l);
  const rows: SpendRow[] = [];
  for (const profile of new Set([...total.keys(), ...limits.keys()])) {
    const spend = total.get(profile) ?? { in: 0, out: 0, cached: 0, cost: 0 };
    const l = limits.get(profile);
    if (spend.in + spend.out + spend.cached + spend.cost === 0 && !l?.session && !l?.weekly) continue;
    rows.push({ profile, name: state.profiles.get(profile)?.name ?? profile.replace(/^prof_/, "").slice(0, 6), spend, ...(l ? { limits: l } : {}) });
  }
  return rows.sort((a, b) => b.spend.cost - a.spend.cost || b.spend.in + b.spend.out - (a.spend.in + a.spend.out) || a.name.localeCompare(b.name));
}

// --- remote desktop ------------------------------------------------------------------------

/** The desktop block of a node's card: the host's state and what this client may do with it. */
export interface RemoteCard {
  node: NodeId;
  host: RemoteHost;
  /** The host's state in words: what it is doing, or why it cannot serve. */
  words: string;
  /** A line under them, when there is more to say: who can still connect while it is off, who may have to approve the installer. */
  note?: string;
  streaming: boolean;
  /** This client can open a viewer on the node: the host serves, and it is not the desktop the app runs on. */
  connect: boolean;
  /** This client can show the desktop beside its view: the desktop app, whose host lays it over the view, onto another node's. */
  beside: boolean;
  /** This client can open Moonlight's own window, where its settings are: the desktop app, whose Connect opens Moonlight. */
  settings: boolean;
  /** The host takes a viewer's PIN. */
  pair: boolean;
  /** The host mints a code for a phone; only Apollo does. */
  invite: boolean;
  /** Sharing is off: Share this desktop. */
  share: boolean;
  /** Sharing is on, whether the host is up, coming up or failing: Stop sharing. */
  stop: boolean;
  /** The host could not come up: Retry. */
  retry: boolean;
  /** Watching first, then the newest; while sharing is off, the devices still paired with a host that runs anyway. */
  viewers: RemoteViewer[];
}

/**
 * A node's desktop block, or undefined when there is none to show: without the `remote`
 * scope, or for a node that is not online. Off, it offers to share the desktop. A controller
 * opens any node's desktop in a page; the desktop app opens a window, or shows it beside the
 * view, and never onto the desktop it runs on.
 */
export function selectRemote(state: ViewState, node: Node): RemoteCard | undefined {
  if (!state.scopes.includes("remote") || node.status !== "online") return undefined;
  const remote = state.remote.get(node.id);
  if (!remote) return undefined;
  const status = remote.host.status;
  const ready = status === "ready";
  const off = status === "off";
  const client = state.client;
  const elsewhere = client?.kind === "ui" && client.node !== undefined && client.node !== node.id;
  const viewer = client?.kind === "controller" || elsewhere;
  // Off, a host that runs anyway (a Windows service) still lists who it would let in.
  const viewers = off ? remote.viewers.filter((v) => v.kind === "native") : remote.viewers;
  // The installer's prompt comes up on the machine itself: someone there may have to answer it.
  const away = !(client?.kind === "ui" && client.node === node.id);
  const note = remoteNote(remote.host, { paired: off ? viewers.length : 0, ...(away ? { at: node.name } : {}) });
  return {
    node: node.id,
    host: remote.host,
    words: remoteWords(remote.host, remote.streaming),
    ...(note !== undefined ? { note } : {}),
    streaming: remote.streaming,
    connect: ready && viewer,
    beside: ready && elsewhere && state.hostEmbed,
    settings: ready && elsewhere,
    pair: ready,
    invite: ready && remote.host.kind === "apollo",
    share: off,
    stop: !off,
    retry: status === "unavailable",
    viewers: [...viewers].sort((a, b) => Number(b.connected === true) - Number(a.connected === true) || b.since - a.since),
  };
}

/** What a desktop host is doing, in words. */
export function remoteWords(host: RemoteHost, streaming: boolean): string {
  switch (host.status) {
    case "off":
      return "off";
    case "installing":
    case "starting": {
      const percent = host.progress === undefined ? "" : ` ${Math.round(host.progress * 100)}%`;
      return `${host.step ?? host.status}${percent}`;
    }
    case "ready":
      return streaming ? "being viewed" : "ready";
    case "unavailable":
      return host.reason ? `unavailable: ${host.reason}` : "unavailable";
  }
}

/**
 * What more there is to say of a host: off, that the devices still paired with one that runs
 * anyway (a Windows service) can still connect to it; installing on a machine away from this
 * client, that the installer may wait on someone there.
 */
export function remoteNote(host: RemoteHost, more: { paired?: number; at?: string }): string | undefined {
  const n = more.paired ?? 0;
  if (host.status === "off" && n > 0) return `${n} paired device${n === 1 ? "" : "s"} can still connect until revoked`;
  if (host.status === "installing" && more.at !== undefined) return `someone at ${more.at} may need to approve the installer`;
  return undefined;
}

/**
 * Why Share or Stop sharing did nothing, in words to act on: this app, or the machine it
 * would reach, is from before the switch; the node's own words otherwise.
 */
export function shareWords(message: string, name: string): string {
  // this app's own bridge, built before the switch, knows no such request
  if (/^unknown method remote\.(enable|disable)/.test(message)) return "this app is older than desktop sharing: update it";
  // the machine it goes to answers neither: it is older
  if (/remote\.(enable|disable) is not served|unknown method/.test(message)) return `Cophyla on ${name} is older than desktop sharing from here: update it there`;
  return message;
}

// --- the desktop beside the view ---------------------------------------------------------------

/**
 * Another node's desktop shown beside the view, one at a time: whose, the tab it was opened or
 * last shown on, the stream once its page is up with its picture's size, and how far it got.
 * Kept across tab switches, shown on the tabs of that machine and its own (`remoteHere`);
 * gone when it closes, its stream ends or the line to the node goes.
 */
export interface RemoteView {
  node: NodeId;
  name: string;
  /** The tab it was opened or last shown on, by `viewerTab`'s key; `chat` for the chat. */
  from: string;
  stream?: string;
  /** The picture's size, for its aspect, when the node said. */
  video?: DisplaySize;
  phase: "opening" | "open" | "failed";
  error?: string;
}

export type RemoteViewEvent =
  | { type: "open"; node: NodeId; name: string; from: string }
  | { type: "opened"; node: NodeId; stream: string; video?: DisplaySize }
  | { type: "failed"; node: NodeId; error: string }
  /** Beside again from a tab it does not show on: it shows there too, as that tab's. */
  | { type: "show"; from: string }
  /** The host says a stream it showed is gone. */
  | { type: "ended"; stream: string }
  /** The line to the node went. */
  | { type: "lost" }
  | { type: "close" };

/** The panel after an event; an answer for a desktop the panel no longer shows changes nothing. */
export function remoteViewStep(view: RemoteView | undefined, ev: RemoteViewEvent): RemoteView | undefined {
  switch (ev.type) {
    case "open":
      return { node: ev.node, name: ev.name, from: ev.from, phase: "opening" };
    case "opened":
      return view?.node === ev.node && view.phase === "opening" ? { node: view.node, name: view.name, from: view.from, stream: ev.stream, ...(ev.video ? { video: ev.video } : {}), phase: "open" } : view;
    case "failed":
      return view?.node === ev.node && view.phase === "opening" ? { node: view.node, name: view.name, from: view.from, phase: "failed", error: ev.error } : view;
    case "show":
      return view ? { ...view, from: ev.from } : view;
    case "ended":
      return view?.stream === ev.stream ? undefined : view;
    case "lost":
    case "close":
      return undefined;
  }
}

/** The machine a tab is on: an agent's node, a bare terminal's; none for the chat. */
export function tabNode(state: ViewState, selected: string | undefined, terminal: string | undefined): NodeId | undefined {
  if (terminal !== undefined) return state.terminals.get(terminal)?.node;
  return selected !== undefined ? state.sessions.get(selected)?.session.node : undefined;
}

/**
 * Whether the desktop shows on the selected tab (`tab`, `viewerTab`'s key or `chat`, on
 * `node`): on that machine's tabs, and on the one it was opened or last shown on, so Beside
 * from the chat or another machine's tab shows it there. Elsewhere it hides, its stream kept.
 */
export function remoteHere(view: RemoteView, tab: string, node: NodeId | undefined): boolean {
  return node === view.node || tab === view.from;
}

/** The desktop panel's share of the width beside the pane, in percent: the usual, and the least and most its divider goes to. */
export const REMOTE_VIEW_WIDTH = { usual: 50, min: 25, max: 80 } as const;

/** A share for the desktop panel's divider: a number held to its bounds, anything else the usual. */
export function remoteViewWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return REMOTE_VIEW_WIDTH.usual;
  return Math.round(Math.min(REMOTE_VIEW_WIDTH.max, Math.max(REMOTE_VIEW_WIDTH.min, value)) * 10) / 10;
}

/** A rectangle in the view's own coordinates: an element's bounding box. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the host is to put the desktop: its slot in the view's coordinates, whole pixels. */
export interface RemotePlace {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The least of the slot worth showing the desktop in. */
const PLACE_MIN = 40;

function crosses(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Where the desktop goes, or `null` to hide it: the host lays it over the view, where nothing
 * of the view can be drawn over it. Hidden while the panel is not shown, while something of
 * the view lies over it (the invite's QR code, a menu crossing it); cut below the pinned
 * prompts where they cross its top.
 */
export function remotePlace(slot: Box | undefined, over: { shown: boolean; covered?: boolean; menus?: Box[]; pinned?: Box }): RemotePlace | null {
  if (!over.shown || over.covered || !slot) return null;
  if ((over.menus ?? []).some((m) => crosses(m, slot))) return null;
  let top = slot.top;
  const pinned = over.pinned;
  if (pinned && pinned.width > 0 && pinned.height > 0 && crosses(pinned, slot)) top = Math.max(top, pinned.top + pinned.height + 6);
  const x = Math.round(slot.left);
  const y = Math.round(top);
  const width = Math.round(slot.left + slot.width) - x;
  const height = Math.round(slot.top + slot.height) - y;
  if (width < PLACE_MIN || height < PLACE_MIN) return null;
  return { x, y, width, height };
}

/**
 * The place fitted to a picture of `aspect` (width over height): as wide as the place, at its
 * top, and narrower, centred across, only where its height runs out. The page then has the
 * picture's own shape and draws no bands; below it shows the panel. Unchanged with no aspect.
 */
export function fitPlace(place: RemotePlace, aspect: number | undefined): RemotePlace {
  if (aspect === undefined || !Number.isFinite(aspect) || aspect <= 0) return place;
  let width = place.width;
  let height = Math.round(width / aspect);
  if (height > place.height) {
    height = place.height;
    width = Math.round(height * aspect);
  }
  return { x: place.x + Math.floor((place.width - width) / 2), y: place.y, width, height };
}

/** The same place, or both hidden: the host is asked again only when it moved. */
export function samePlace(a: RemotePlace | null | undefined, b: RemotePlace | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Why Connect opened no desktop, in words to act on: away from the node's LAN a phone reaches
 * a desktop only with Direct connections on; the node's own words otherwise.
 */
export function connectWords(code: string | undefined, message: string): string {
  if (code === "unsupported" && message.includes("over the relay")) return "a desktop opens on the node's Wi-Fi, or from anywhere once Direct connections is on in the account card";
  if (code === "unavailable" && /direct connections/i.test(message)) return `${message}: turn Direct connections on in the host's account card`;
  // a shell from before streams went through its own window
  if (code === "unsupported" && message.includes("has no host.open")) return "this app cannot show a desktop it has no route to: update the app";
  return message;
}

/** A viewer's second line: watching now, or since when it has been paired or open. */
export function viewerWords(viewer: RemoteViewer, now: number): string {
  if (viewer.kind === "web") return viewer.connected ? "watching in a browser" : `browser, opened ${ago(viewer.since, now)}`;
  return viewer.connected ? "watching" : `paired ${ago(viewer.since, now)}`;
}

/** The phone code in words: the code, the passphrase to type beside it, and the time left. */
export function inviteWords(invite: RemoteInvite, now: number): { code: string; passphrase: string; left: string; expired: boolean } {
  const time = invite.expiresAt === undefined ? { left: "", expired: false } : leftWords(invite.expiresAt, now);
  return { code: invite.otp, passphrase: invite.passphrase ?? "", ...time };
}

/** Used of total, short: both in GB when the total is, else each in its own unit. */
export function usedWords(used: number, total: number): string {
  if (total >= 1024 ** 3) return `${(used / 1024 ** 3).toFixed(1)}/${(total / 1024 ** 3).toFixed(1)} GB`;
  return `${bytesWords(used)}/${bytesWords(total)}`;
}

/** Bytes in words: whole KB and MB, GB to one place. */
export function bytesWords(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/** A percentage to the nearest whole, and to one place under ten. */
export function percentWords(n: number): string {
  const v = Math.max(0, n);
  return v > 0 && v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}

/** A cost in dollars: cents when there are some, a fraction of a cent when that is all. */
export function costWords(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** A plan window's share used, whole; a dash while it is not known. */
export function limitWords(w: LimitWindow | undefined): string {
  return w ? `${Math.round(w.percent)}%` : "—";
}

/** How close a window is to its cap, for its colour, at a machine's bars' thresholds. */
export function limitLevel(w: LimitWindow | undefined): "none" | "normal" | "warn" | "critical" {
  if (!w) return "none";
  return w.percent >= 95 ? "critical" : w.percent >= 80 ? "warn" : "normal";
}

/** A spend row's hover title: each limit with when it starts over, then the day's cost and tokens. */
export function spendTitle(row: SpendRow, now: number): string {
  const window = (label: string, w: LimitWindow | undefined) => {
    if (!w) return `${label}: not known`;
    const left = w.resetsAt !== undefined && w.resetsAt > now ? `, starts over in ${durationWords(w.resetsAt - now)}` : "";
    return `${label}: ${Math.round(w.percent)}% used${left}`;
  };
  const lines = [row.name];
  if (row.limits) lines.push(window("Session limit", row.limits.session), window("Weekly limit", row.limits.weekly));
  lines.push(`Today: ${costWords(row.spend.cost)}, ${countWords(row.spend.in)} in, ${countWords(row.spend.out)} out, ${countWords(row.spend.cached)} cached`);
  return lines.join("\n");
}

/** A span in words, its two largest units: 3 d 4 h, 2 h 40 min, 12 min. */
export function durationWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`;
}

/** A count, short: 1.2k, 34k, 1.5M. */
export function countWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number | string) => String(n).padStart(2, "0");

/** A trigger in words: when a task runs, or what it waits for; empty for a task with none. */
export function triggerWords(task: Task): string {
  const t = task.trigger;
  if (!t) return "";
  switch (t.kind) {
    case "at": {
      const d = new Date(t.at);
      return `at ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    case "cron": {
      const expr = t.expr.trim();
      const zone = t.tz ? ` (${t.tz})` : "";
      if (expr === "* * * * *") return `every minute${zone}`;
      const [minute, hour, dom, month, dow] = expr.split(/\s+/);
      if (minute !== undefined && hour !== undefined && /^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*") {
        const time = `${pad2(hour)}:${pad2(minute)}`;
        if (dow === "*") return `${task.recurring ? "daily" : "at"} ${time}${zone}`;
        if (dow === "1-5") return `weekdays ${time}${zone}`;
      }
      return `cron ${expr}${zone}`;
    }
    case "event":
      return `on ${t.name}`;
  }
}
