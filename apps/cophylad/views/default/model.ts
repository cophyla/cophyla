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
// What the chat's session is told (`brain.context`) is shown part by part, in words.
// The group chats are rows too, each with the posts loaded so far, and so are the agents in
// focus and the user's teammates: a group's tab stands under the folder its home names, or
// under Groups; a share's broad folders (a home, a drive) are asked about before it is sent.
// The leaders are rows too: the sessions, and the chat, the user promoted to speak to a group
// of their sessions as the user, each with the sessions it leads or all of them.
// Types come from the protocol package; nothing else does, so the file runs in the frame as is.

import type { Focus, Group, GroupCandidate, GroupFile, GroupMember, GroupMemberRef, GroupNotify, GroupPhoto, GroupPost, GroupPostFrom, Leader, LeaderSpeaker, SessionStatus, TalkMessage, TalkSummary, TeamAgent, TeamClosedAgent, Teammate, TeammateConnection, TeammatePlace, TeammateShare } from "@cophyla/protocol";
import { applyTalk } from "./talkmodel.ts";
import type { TalkPage } from "./talkmodel.ts";
import type { Access, Ask, AskAnswer, AssistantHarness, AssistantState, AuditEntry, BackupState, BrainContext, Client, ClientNotificationParams, Connection, ContentBlock, ConversationSpend, Controller, DisplaySize, DoorState, FileText, FolderListing, FolderPick, GitState, Grant, GrantKind, GrantRole, HarnessProfile, LanState, LimitWindow, Message, MetricsSample, Node, NodeId, Platform, ProcessOwner, ProfileLimits, RemoteHost, RemoteState, RemoteViewer, Scope, ClientSession as Session, SessionEvent, SpendTotals, Task, Terminal, ClientThread as Thread, Transfer, TurnProgress, TurnStep, ViewManifest, VoiceState, VoiceStopped, VoiceUnheard, ClientWorkspace as Workspace } from "@cophyla/protocol";

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
/** A node's release of one component, staged or on its way: `update.state`. */
export type UpdateState = ClientNotificationParams<"update.state">;

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
  /** The host lays a stream page over the view where the view places it (`host.open {embed}`, `host.place`, `host.close`): the desktop app, and the page in a desktop browser. */
  embed?: boolean;
  /** The host is a wide window with a pointer on a computer without being the desktop app: the page in a desktop browser. */
  desk?: boolean;
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
  /** The host lays a desktop over the view, beside the pane: the desktop app, and the page in a desktop browser. */
  hostEmbed: boolean;
  /** The host is the page in a desktop browser: laid out and loaded as the desktop app is, though its client is a controller. */
  hostDesk: boolean;
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
  /** The session the chat runs in, as the node says it stands; none from a node that says nothing of one. */
  assistant?: AssistantState;
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
  /** A browser's key just minted, while its panel shows. */
  browserKey?: IssuedKey;
  /** This user's connections to other users' terminals, pending and active, from `connection.list` and `connection.state`. */
  connections: Map<string, Connection>;
  /** A connection's code just made, while its panel shows. */
  connectionCode?: IssuedCode;
  /** Files and folders on their way between the user's machines, and the ones that came, from `transfer.list` and `transfer.state`, while connected. */
  transfers: Map<string, Transfer>;
  /** The group chats this side keeps, from `group.list` and `group.state`: kept through a disconnect, until the next list replaces them. */
  groups: Map<string, Group>;
  /** Each group's posts loaded so far, by group: a group's are asked for as it opens. */
  groupPosts: Map<string, GroupPage>;
  /** Each session's conversation with other agents at a glance, from `talk.list` and `talk.state`: kept through a disconnect, until the next list replaces them. */
  talks: Map<string, TalkSummary>;
  /** Each session's messages loaded so far: a session's are asked for as its Messages pane shows. */
  talkPages: Map<string, TalkPage>;
  /** The node keeps conversations: `talk.list` answered. Refused by an older node or app (false), or not asked yet, no Messages shows. */
  talkOn?: boolean;
  /** The agents in focus now, by session, from `focus.list` and `focus.state`, while connected. */
  focus: Map<string, Focus>;
  /** The leaders, by speaker (`chat` or a session's id), from `lead.list` and `lead.state`, while connected. */
  leaders: Map<string, Leader>;
  /** The node keeps leaders: `lead.list` answered. Refused by an older node or app (false), or not asked yet, no lead control shows. */
  leadOn?: boolean;
  /** This user's teammates, pending and active, from `teammate.list` and `teammate.state`. */
  teammates: Map<string, Teammate>;
  /** A teammate's code just made, while its panel shows. */
  teammateCode?: IssuedCode;
  /** The node this client's socket is on, on its own network (`lan.info`); none from a node that does not say. */
  lan?: LanState;
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
  /** Each node's releases, from `update.state`, by `updateKey`: kept through a disconnect, which an update's restart is, until the next hello says them again. */
  updates: Map<string, UpdateState>;
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
  /** How many errors came in all, the ones dropped past `ERRORS_KEEP` too: what came since a moment is told by the count. */
  errorsSeen: number;
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
  /** Where the session the chat runs in stands. */
  | { type: "assistant.state"; params: AssistantState }
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
  /** A browser's key came back from `browser.invite`, or its panel closed. */
  | { type: "browser.key"; key?: IssuedKey }
  | { type: "connections"; connections: Connection[] }
  /** A connection was made, used, changed end, or ended (`state: ended`, which takes its row away). */
  | { type: "connection.state"; params: Connection }
  /** A connection's code came back from `connection.invite`, or its panel closed. */
  | { type: "connection.code"; code?: IssuedCode }
  | { type: "groups"; groups: Group[] }
  /** A group was made, changed, posted in or read (its counts), or this side left it (`left`, which takes it away). */
  | { type: "group.state"; params: Group & { left?: boolean } }
  | { type: "group.posts.loading"; group: string }
  | { type: "group.posts.failed"; group: string }
  /** A page of a group's posts: the latest, or (`before`) the ones before those shown. */
  | { type: "group.posts"; group: string; posts: GroupPost[]; more: boolean; before?: number }
  | { type: "group.posted"; params: { group: string; post: GroupPost } }
  /** `talk.list`'s answer; none when the node or the app refused it, being older than conversations. */
  | { type: "talks"; talks?: TalkSummary[] }
  /** A session's conversation at a glance, as a message came or the user read it. */
  | { type: "talk.state"; params: TalkSummary }
  /** A message in a session's conversation, new or changed, to a view watching that session. */
  | { type: "talk.said"; params: { message: TalkMessage } }
  | { type: "talk.page.loading"; session: string }
  | { type: "talk.page.failed"; session: string }
  /** A page of a session's conversation: the latest, or (`before`) the one before those shown. */
  | { type: "talk.page"; session: string; messages: TalkMessage[]; more: boolean; before?: number }
  | { type: "focus"; focus: { session: string; focus: Focus }[] }
  /** An agent took focus, or its focus ended (`focus` absent). */
  | { type: "focus.state"; params: { session: string; focus?: Focus } }
  /** `lead.list`'s answer; none when the node or the app refused it, being older than leaders. */
  | { type: "leaders"; leaders?: Leader[] }
  /** The leaders, every one, as one was made, changed or went. */
  | { type: "lead.state"; params: { leaders: Leader[] } }
  /** `lead.set`'s answer: a speaker's group as it stands now. */
  | { type: "leader"; leader: Leader }
  /** `lead.remove` answered: the speaker leads no more. */
  | { type: "leader.removed"; speaker: LeaderSpeaker }
  | { type: "teammates"; teammates: Teammate[] }
  /** A teammate was made, used, changed or ended (`state: ended`, which takes its row away). */
  | { type: "teammate.state"; params: Teammate }
  /** A teammate's code came back from `teammate.invite`, or its panel closed. */
  | { type: "teammate.code"; code?: IssuedCode }
  | { type: "transfers"; transfers: Transfer[] }
  /** A transfer started, moved on, ended, or was dismissed (`dismissed`, which takes its row away). */
  | { type: "transfer.state"; params: Transfer }
  /** How the node stands on its own network, from `lan.info` or the switch's answer; none when it does not say. */
  | { type: "lan"; lan?: LanState }
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
  | { type: "update.state"; params: UpdateState }
  /** A code came back from `account.login`, or the panel closed. */
  | { type: "login"; offer?: LoginOffer }
  | { type: "error"; message: string };

export const AUDIT_KEEP = 200;
export const ERRORS_KEEP = 20;
export const HISTORY_PAGE = 50;
export const THREAD_PAGE = 1;

/** Where the spend starts: the last local midnight, so Today is the calendar day's. */
export function spendFrom(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Milliseconds until the next local midnight, when Today starts over. */
export function untilTomorrow(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime() - now;
}

export function initialState(): ViewState {
  return {
    hostMenu: false,
    hostTalk: false,
    hostFilePaths: false,
    hostEmbed: false,
    hostDesk: false,
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
    connections: new Map(),
    transfers: new Map(),
    groups: new Map(),
    groupPosts: new Map(),
    talks: new Map(),
    talkPages: new Map(),
    focus: new Map(),
    leaders: new Map(),
    teammates: new Map(),
    nodes: new Map(),
    metrics: new Map(),
    spend: new Map(),
    remote: new Map(),
    direct: new Map(),
    updates: new Map(),
    quick: false,
    chatLoaded: false,
    threadsExhausted: false,
    chatLoading: false,
    errors: [],
    errorsSeen: 0,
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

/** How far, in CSS pixels, a finger moves on a terminal before it scrolls rather than taps. */
export const TOUCH_SLOP = 8;

/** The way a finger's drag scrolls, once it went past a tap: the way it moved most; none yet within `TOUCH_SLOP`. */
export function dragAxis(dx: number, dy: number): "x" | "y" | undefined {
  if (Math.hypot(dx, dy) < TOUCH_SLOP) return undefined;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * The whole steps a drag of `by` CSS pixels scrolls a terminal (positive: on to later lines),
 * a step `stepPx` long, with `rest`, the part of a step left from the drag before: what is
 * left of one now waits for the next move.
 */
export function dragSteps(rest: number, by: number, stepPx: number): { steps: number; rest: number } {
  if (stepPx <= 0) return { steps: 0, rest };
  const total = rest + by / stepPx;
  const steps = Math.trunc(total) || 0; // never -0
  return { steps, rest: total - steps };
}

/** The lines a program scrolls a turn of the wheel, as Claude's full screen does and vim. */
const WHEEL_LINES = 3;

/**
 * How a drag on a terminal scrolls it, and how many rows of the drag make one step: back
 * through its lines, a line a row; else with its wheel, where the program reads the wheel
 * (tracking that reports it), a turn each `WHEEL_LINES` rows, or on the alternate screen,
 * which keeps no lines to scroll back to and takes a turn as an arrow key, a turn a row.
 */
export function dragScroll(buffer: "normal" | "alternate", tracking: MouseTracking): { by: "lines" | "wheel"; rows: number } {
  if (tracking !== "none" && tracking !== "x10") return { by: "wheel", rows: WHEEL_LINES };
  return buffer === "alternate" ? { by: "wheel", rows: 1 } : { by: "lines", rows: 1 };
}

/** A fling's speed, in pixels per millisecond, slows by this much each 16 ms… */
const FLING_DECAY = 0.95;
/** …and stops below this. */
const FLING_STOP = 0.02;

/** A fling's speed `ms` after it was `speed`: slowing as a page does, and 0 once too slow to see. */
export function flingSpeed(speed: number, ms: number): number {
  const next = speed * FLING_DECAY ** (ms / 16);
  return Math.abs(next) < FLING_STOP ? 0 : next;
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

/**
 * Whether a key pressed in a message field sends what is typed: Enter does, Shift+Enter starts a
 * new line as the field would, and an Enter that ends an IME's composition only commits its
 * word (Safari tells it by key code 229 alone).
 */
export function enterSends(key: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }): boolean {
  return key.key === "Enter" && !key.shiftKey && !key.isComposing && key.keyCode !== 229;
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
  if (applyTeam(state, action) || applyLead(state, action) || applyTalk(state, action)) return state;
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
      state.hostDesk = p.desk === true;
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
        delete state.assistant;
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
        // Every terminal comes again with the next `terminal.list`, and every transfer with `transfer.list`.
        state.terminals.clear();
        state.transfers.clear();
        // The focus comes again with `focus.list`, and the leaders with `lead.list`; the posts shown stay, and are asked for again as their group shows.
        state.focus.clear();
        state.leaders.clear();
        for (const page of state.groupPosts.values()) {
          page.stale = true;
          page.loading = false;
        }
        // and the conversations shown, as their Messages pane shows
        for (const page of state.talkPages.values()) {
          page.stale = true;
          page.loading = false;
        }
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
    case "assistant.state":
      state.assistant = action.params;
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
      // and so has a key that was typed
      const typed = state.browserKey ? state.grants.get(state.browserKey.grant) : undefined;
      if (typed && typed.status !== "pending") delete state.browserKey;
      return state;
    }
    case "grant.removed":
      state.grants.delete(action.id);
      state.controllers.delete(action.id);
      if (state.invite?.grant === action.id) delete state.invite;
      if (state.browserKey?.grant === action.id) delete state.browserKey;
      return state;
    case "invite":
      if (action.invite) state.invite = action.invite;
      else delete state.invite;
      return state;
    case "connections":
      state.connections = new Map(action.connections.map((c) => [c.id, c]));
      if (state.connectionCode && state.connections.get(state.connectionCode.id)?.state !== "pending") delete state.connectionCode;
      return state;
    case "connection.state":
      if (action.params.state === "ended") state.connections.delete(action.params.id);
      else state.connections.set(action.params.id, action.params);
      // the code on show was used, or cancelled: its panel has done its job
      if (state.connectionCode?.id === action.params.id && action.params.state !== "pending") delete state.connectionCode;
      return state;
    case "connection.code":
      if (action.code) state.connectionCode = action.code;
      else delete state.connectionCode;
      return state;
    case "transfers":
      state.transfers = new Map(action.transfers.filter((t) => !t.dismissed).map((t) => [t.id, t]));
      return state;
    case "transfer.state":
      if (action.params.dismissed) state.transfers.delete(action.params.id);
      else state.transfers.set(action.params.id, action.params);
      return state;
    case "browser.key":
      if (action.key) state.browserKey = action.key;
      else delete state.browserKey;
      return state;
    case "lan":
      if (action.lan) state.lan = action.lan;
      else delete state.lan;
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
    case "update.state":
      state.updates.set(updateKey(action.params), action.params);
      return state;
    case "login":
      if (action.offer) state.login = action.offer;
      else delete state.login;
      return state;
    case "remote.pin":
      if (action.node) state.remotePin = action.node;
      else delete state.remotePin;
      return state;
    case "groups":
    case "group.state":
    case "group.posts.loading":
    case "group.posts.failed":
    case "group.posts":
    case "group.posted":
    case "focus":
    case "focus.state":
    case "teammates":
    case "teammate.state":
    case "teammate.code":
      // folded by applyTeam, above
      return state;
    case "leaders":
    case "lead.state":
    case "leader":
    case "leader.removed":
      // folded by applyLead, above
      return state;
    case "talks":
    case "talk.state":
    case "talk.said":
    case "talk.page.loading":
    case "talk.page.failed":
    case "talk.page":
      // folded by applyTalk, above
      return state;
    case "error":
      state.errors.push(action.message);
      state.errorsSeen++;
      if (state.errors.length > ERRORS_KEEP) state.errors.splice(0, state.errors.length - ERRORS_KEEP);
      return state;
  }
}

/**
 * What drawing after an action asks of the chat's items, the most of the view to draw: `none`
 * when it changed nothing an item shows (a terminal's row, a node's samples, an open tab's
 * timeline); `own` when it changed only the items it streams into, adds or takes away (a reply's
 * words as they come, the turn's progress, the words heard); `all` for the rest, any of which
 * may change what a chip or a row says (a session's name, a folder Files listed, a new thread).
 */
export type ChatDraw = "none" | "own" | "all";

export function chatDraw(action: Action): ChatDraw {
  switch (action.type) {
    case "terminal.state":
    case "terminals":
    case "metrics.sample":
    case "spend.loading":
    case "metrics.spend":
    case "session.event":
    case "history.loading":
    case "history":
    case "draft":
    case "send.result":
    case "assistant.state":
    case "update.state":
    case "transfers":
    case "transfer.state":
    case "groups":
    case "group.state":
    case "group.posts.loading":
    case "group.posts.failed":
    case "group.posts":
    case "group.posted":
    case "focus":
    case "focus.state":
    case "leaders":
    case "lead.state":
    case "leader":
    case "leader.removed":
    case "teammates":
    case "teammate.state":
    case "teammate.code":
    case "talks":
    case "talk.state":
    case "talk.said":
    case "talk.page.loading":
    case "talk.page.failed":
    case "talk.page":
      return "none";
    case "chat.delta":
    case "chat.retract":
    case "chat.progress":
    case "voice.partial":
    case "voice.state":
      return "own";
    default:
      return "all";
  }
}

const CHAT_DRAW_RANK: Record<ChatDraw, number> = { none: 0, own: 1, all: 2 };

/** The more of the chat two actions drawn together ask for. */
export function widerChatDraw(a: ChatDraw, b: ChatDraw): ChatDraw {
  return CHAT_DRAW_RANK[a] >= CHAT_DRAW_RANK[b] ? a : b;
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
 * it opens and the chat's newest thread on connect, and so does the page in a desktop browser,
 * which says what it is (`desk`; how it reaches the node cannot tell, a browser on a secondary's
 * network is relayed). A phone shows what streams from the moment it looks, and loads history a
 * page per press.
 */
export function loadsHistory(state: ViewState): boolean {
  return state.client?.kind !== "controller" || state.hostDesk;
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

/** Where a release's `update.state` is kept: by node, component and a model's name. */
export function updateKey(u: { node: NodeId; component: string; name?: string }): string {
  return `${u.node}/${u.component}/${u.name ?? ""}`;
}

/** A Cophyla release staged on the node this view talks to, which `update.apply` restarts it into. */
export interface UpdateNote {
  version: string;
  /** The machine, named when the app runs on another (a phone's view of its computer). */
  machine?: string;
  /** The user asked for it once nothing waits on Cophyla, and it waits on these: what the node says, for every view alike. */
  waiting?: string[];
  /** The node is stopping to start again on it: its last word before the line goes, kept through the disconnect. */
  restarting?: boolean;
}

/**
 * What an update waits on, as the user knows it: the node's reasons (`1 open ask`, `2 held hook
 * responses`, `the chat mid-turn`) in their words, the brain's three as one, any other as it came.
 */
export function waitingWords(reasons: string[]): string {
  const count = (r: string) => Number(/^(\d+)/.exec(r)?.[1] ?? "1");
  const n = (k: number, one: string, many: string) => (k === 1 ? one : `${k} ${many}`);
  const words: string[] = [];
  for (const r of reasons) {
    let w: string;
    if (/open asks?$/.test(r)) w = n(count(r), "a question waiting for an answer", "questions waiting for an answer");
    else if (/held hook responses?$/.test(r)) w = n(count(r), "an agent session waiting on Cophyla", "agent sessions waiting on Cophyla");
    else if (/agent prompts? in flight$/.test(r)) w = n(count(r), "an agent prompt running", "agent prompts running");
    else if (r === "brain starting" || r === "the chat mid-turn" || /brain requests? in flight$/.test(r)) w = "the chat working";
    else if (r === "a download is running") w = "a download";
    else w = r;
    if (!words.includes(w)) words.push(w);
  }
  return words.join(", ");
}

/** The rail's note of an update: a platform release staged above what runs, where this view may apply it. */
export function selectUpdateNote(state: ViewState): UpdateNote | undefined {
  if (!state.scopes.includes("updates") || state.node === undefined) return undefined;
  const p = state.updates.get(updateKey({ node: state.node, component: "platform" }));
  if (p?.staged === undefined || p.staged === p.current) return undefined;
  return {
    version: p.staged,
    ...(state.client?.node !== state.node ? { machine: machineName(state, state.node) } : {}),
    ...(p.restarting ? { restarting: true } : p.waiting !== undefined && p.waiting.length > 0 ? { waiting: p.waiting } : {}),
  };
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

/** A folder's own name: its last part, or the whole of a root. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const name = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  return name === "" || /^[a-z]:$/i.test(name) ? path : name;
}

/** The folder a path is in, as New terminal's rows show it beside the name; none for a root. */
export function parentFolder(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (at < 0) return undefined;
  const parent = trimmed.slice(0, at);
  if (parent === "") return trimmed[0];
  return /^[a-z]:$/i.test(parent) ? parent + trimmed[at] : parent;
}

/** A path typed into New terminal's filter, as a folder to start in: absolute, its quotes taken off; undefined for anything else. */
export function typedFolder(text: string): string | undefined {
  const t = text.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
  return /^([a-z]:[\\/]|[\\/])/i.test(t) ? t : undefined;
}

/** Whether a place is left by New terminal's filter: each of its words in the name or the path, in any case, with either slash. */
export function placeMatches(filter: string, name: string, path?: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, "/");
  const hay = `${norm(name)}\n${path !== undefined ? norm(path) : ""}`;
  return norm(filter.replace(/["']/g, "")).split(/\s+/).every((w) => hay.includes(w));
}

/** One row of New terminal's menu. */
export interface PlaceRow {
  /** Unique in its machine's rows. */
  key: string;
  /** The place it starts in, as `spawnParams` takes it, with the folder for `folderPlace`. */
  place: string;
  cwd?: string;
  name: string;
  /** What the row shows beside the name, dimmer: the folder a workspace is in, or the path typed. */
  hint?: string;
  /** Its full path, when the view knows it. */
  path?: string;
  /** Other folder…: it opens the picker on the machine. */
  browse?: true;
}

/** One machine's rows of New terminal's menu, under its name when there are several. */
export interface MachinePlaces {
  machine: TerminalMachine;
  places: PlaceRow[];
}

/** How many of a machine's workspaces New terminal's menu shows while its filter has words. */
export const MATCHES_PER_MACHINE = 12;

/**
 * New terminal's menu, per machine that starts terminals, this computer's first: a path typed
 * into the filter, as a place of its own; the workspaces worked in last that the filter
 * leaves, more of them while it has words; the home folder, while the filter leaves it; and
 * Other folder…, always.
 */
export function placeRows(state: ViewState, workspaces: Iterable<Workspace>, filter: string): MachinePlaces[] {
  const machines = terminalMachines(state);
  const list = [...workspaces];
  const typed = typedFolder(filter);
  const limit = filter.trim() !== "" ? MATCHES_PER_MACHINE : machines.length > 1 ? RECENT_PER_MACHINE : RECENT_WORKSPACES;
  return machines.map((machine) => {
    const places: PlaceRow[] = [];
    if (typed !== undefined) places.push({ key: `typed:${machine.node}`, place: folderPlace(machine.node), cwd: typed, name: "Open in", hint: typed, path: typed });
    const mine = recentWorkspaces(list, machine.node, Infinity).filter((w) => placeMatches(filter, w.name, w.path));
    for (const w of mine.slice(0, limit)) {
      const parent = parentFolder(w.path);
      places.push({ key: w.id, place: w.id, name: w.name, path: w.path, ...(parent !== undefined ? { hint: parent } : {}) });
    }
    if (placeMatches(filter, "Home folder")) places.push({ key: homePlace(machine.node), place: homePlace(machine.node), name: "Home folder" });
    places.push({ key: folderPlace(machine.node), place: folderPlace(machine.node), name: "Other folder…", browse: true });
    return { machine, places };
  });
}

/** Where a terminal last started from this view, as the device keeps it: one of New terminal's places, with its folder. */
export interface LastPlace {
  place: string;
  cwd?: string;
}

/** The place the device handed back, or nothing for anything else. */
export function lastPlace(value: unknown): LastPlace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { place?: unknown; cwd?: unknown };
  if (typeof v.place !== "string" || v.place === "") return undefined;
  return typeof v.cwd === "string" ? { place: v.place, cwd: v.cwd } : { place: v.place };
}

/** Where New terminal's + starts a shell at once: one of the menu's places, with its folder's name (none for the home) and path. */
export interface QuickPlace {
  place: string;
  cwd?: string;
  name?: string;
  path?: string;
  machine: TerminalMachine;
}

/**
 * Where New terminal's + starts a shell, on a machine that starts them: in the folder of the
 * tab shown (a session's workspace or its own folder, a bare terminal's), else where the last
 * one started from here, else in this computer's workspace worked in last as the view knows
 * it, else in its home. A folder that is a workspace's starts as the workspace, which moves it
 * up the menu. Undefined while no machine starts terminals.
 */
export function quickPlace(state: ViewState, shown: { session?: string; terminal?: string }, last: LastPlace | undefined): QuickPlace | undefined {
  const machines = terminalMachines(state);
  const first = machines[0];
  if (!first) return undefined;
  const on = (node: NodeId) => machines.find((m) => m.node === node);
  const inWorkspace = (w: Workspace | undefined): QuickPlace | undefined => {
    const machine = w && on(w.node);
    return w && machine ? { place: w.id, name: w.name, path: w.path, machine } : undefined;
  };
  const inFolder = (node: NodeId, cwd: string): QuickPlace | undefined => {
    const machine = on(node);
    if (!machine) return undefined;
    const key = placeKey(cwd);
    for (const w of state.workspaces.values()) if (w.node === node && placeKey(w.path) === key) return inWorkspace(w);
    return { place: folderPlace(node), cwd, name: folderName(cwd), path: cwd, machine };
  };
  const session = shown.session !== undefined ? state.sessions.get(shown.session)?.session : undefined;
  if (session) {
    const q = (session.workspace !== undefined ? inWorkspace(state.workspaces.get(session.workspace)) : undefined) ?? inFolder(session.node, session.cwd);
    if (q) return q;
  }
  const terminal = shown.terminal !== undefined ? state.terminals.get(shown.terminal) : undefined;
  if (terminal) {
    const q = inFolder(terminal.node, terminal.cwd);
    if (q) return q;
  }
  if (last) {
    const machine = last.place.startsWith("home:") ? on(last.place.slice(5)) : undefined;
    const q = machine
      ? { place: last.place, machine }
      : last.place.startsWith("folder:")
        ? last.cwd !== undefined ? inFolder(last.place.slice(7), last.cwd) : undefined
        : inWorkspace(state.workspaces.get(last.place));
    if (q) return q;
  }
  return inWorkspace(recentWorkspaces(state.workspaces.values(), first.node, 1)[0]) ?? { place: homePlace(first.node), machine: first };
}

/** What New terminal's + says it does: where, on which machine while there are several, and the folder's path under it. */
export function quickTitle(q: QuickPlace, several: boolean): string {
  const where = `New terminal in ${q.name ?? "your home folder"}${several ? ` on ${q.machine.name}` : ""}`;
  return q.path !== undefined ? `${where}\n${q.path}` : where;
}

/** The terminal a session runs in, when this node holds it and the view may open it. */
export function sessionTerminal(state: ViewState, session: Session): Terminal | undefined {
  const ref = session.native.terminal;
  if (!ref || !state.scopes.includes("terminal")) return undefined;
  const t = state.terminals.get(ref.id);
  return t && t.host === ref.host ? t : undefined;
}

/** What a session's pane can show: what it said and did, the terminal it runs in, its messages with other agents. */
export type PaneMode = "timeline" | "terminal" | "messages";

/**
 * What a session's pane shows: the terminal it runs in, when the view can open one, unless the
 * user chose the timeline, or its messages where the node keeps them.
 */
export function paneMode(chosen: PaneMode | undefined, hasTerminal: boolean, hasTalk: boolean): PaneMode {
  if (chosen === "messages" && hasTalk) return "messages";
  if (chosen === "messages") return hasTerminal ? "terminal" : "timeline";
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

/** `from`: another agent's message, labelled by who sent it (`agentLabel`). `lead`: a leader's, typed in as the user's, and who sent it (`leadNote`). */
export type TimelineRow = { kind: "event"; key: string; event: SessionEvent; ask?: Ask; send?: PendingSend; asPeer?: boolean; from?: string; lead?: string } | { kind: "send"; key: string; send: PendingSend };

/**
 * Who another agent's message to a session came from, as its turn is labelled: `@alias ·
 * harness`, and the machine when it is not the session's own; another person's agent on a
 * connection as `@login/name · harness · login's`; `cophyla` for a notice of cophyla's own
 * about a message the session sent.
 */
export function agentLabel(payload: unknown, session: Pick<Session, "node">, state: Pick<ViewState, "nodes">): string {
  const peer = (payload as { peer?: { user?: unknown; name?: unknown; harness?: unknown } } | undefined)?.peer;
  if (peer && typeof peer.user === "string" && typeof peer.name === "string") {
    const harness = typeof peer.harness === "string" ? (HARNESS_NAMES[peer.harness as keyof typeof HARNESS_NAMES] ?? peer.harness) : undefined;
    return `@${peer.user}/${peer.name}${harness ? ` · ${harness}` : ""} · ${peer.user}'s`;
  }
  const from = (payload as { from?: { alias?: unknown; harness?: unknown; node?: unknown; nodeName?: unknown } } | undefined)?.from;
  if (!from || typeof from.alias !== "string") return "cophyla";
  const harness = typeof from.harness === "string" ? (HARNESS_NAMES[from.harness as keyof typeof HARNESS_NAMES] ?? from.harness) : undefined;
  const machine = typeof from.nodeName === "string" ? from.nodeName : undefined;
  // a late echo names its machine alone
  const elsewhere = typeof from.node === "string" ? from.node !== session.node : machine !== undefined && machine !== state.nodes.get(session.node)?.name;
  return `@${from.alias}${harness ? ` · ${harness}` : ""}${elsewhere && machine ? ` on ${machine}` : ""}`;
}

/**
 * Events by seq, ask events joined to their ask, message receipts and typed turns joined to the
 * send, then sends not yet receipted. A message a Claude session in a terminal got over its
 * pipe reached it as another agent's (`asPeer`); one typed into its terminal is the user's turn,
 * and so is a leader's, which says who sent it (`lead`).
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
      const p = event.payload as { ref?: string; source?: string } | undefined;
      if (p?.source === "agent") row.from = agentLabel(p, card.session, state);
      if (p?.source === "lead") row.lead = leadNote(p);
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

/**
 * The anchors GitHub gives a markdown file's headings, from their words in order: lower-cased,
 * what is not a letter, a digit, a space, `-` or `_` dropped, and each space a `-`; one already
 * taken gets `-1`, `-2` and on after it.
 */
export function headingAnchors(headings: string[]): string[] {
  const taken = new Map<string, number>();
  return headings.map((words) => {
    const base = words.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    let anchor = base;
    while (taken.has(anchor)) {
      const n = taken.get(base)! + 1;
      taken.set(base, n);
      anchor = `${base}-${n}`;
    }
    taken.set(anchor, 0);
    return anchor;
  });
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

/** A token count in full: 26,325,495. */
export function tokenWords(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Dollars for the Context overlay: cents to two places, a fraction of a cent to two figures, so a short conversation's spend still reads. */
export function usdWords(usd: number): string {
  if (!(usd > 0)) return "$0.00";
  if (usd >= 0.01) return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${usd.toFixed(Math.min(8, 1 - Math.floor(Math.log10(usd))))}`;
}

/** A price per million tokens: two places, or as many as its first figure takes ($0.075). */
export function rateWords(perMillion: number): string {
  if (!(perMillion > 0)) return "$0.00";
  return `$${perMillion.toFixed(Math.max(2, 1 - Math.floor(Math.log10(perMillion))))}`;
}

/** One line of a model's spend: a kind of token, how many, the rate per million it is charged at, and what that came to; neither for a model with no price. */
export interface SpendLine {
  kind: "input" | "cached" | "cacheWrite" | "output";
  label: string;
  tokens: number;
  rate?: number;
  cost?: number;
}

export interface SpendModel {
  model: string;
  calls: number;
  lines: SpendLine[];
  /** USD, as the node priced it; none when the model has no price. */
  cost?: number;
  /** How much less a cached input token costs than a fresh one, 0 to 1; none without a price. */
  discount?: number;
}

/** What a conversation's model calls came to, summed over its models, for the overlay's tiles and its table. */
export interface SpendSummary {
  models: SpendModel[];
  calls: number;
  /** The first call's time; none before any. */
  since?: number;
  /** The priced models' cost. */
  cost: number;
  /** The calls to models with no price, which `cost` leaves out. */
  unpriced: number;
  /** Input tokens in all, the cached ones among them. */
  input: number;
  cached: number;
  output: number;
  /** What the cached tokens would have cost more at the input's rate. */
  saved: number;
}

const PER_MILLION = 1_000_000;

/**
 * A conversation's spend line by line: per model, the input not read from a cache, the input
 * that was (at its own rate, which is what the cache saves), cache writes where there were
 * any, and the output with its thinking; then the sums over every model.
 */
export function spendSummary(spend: ConversationSpend | undefined): SpendSummary {
  const out: SpendSummary = { models: [], calls: 0, cost: 0, unpriced: 0, input: 0, cached: 0, output: 0, saved: 0 };
  for (const m of spend?.models ?? []) {
    const cached = Math.min(m.tokens.cacheRead, m.tokens.in);
    const p = m.price;
    const line = (kind: SpendLine["kind"], label: string, tokens: number, rate: number | undefined): SpendLine =>
      rate === undefined ? { kind, label, tokens } : { kind, label, tokens, rate, cost: (tokens * rate) / PER_MILLION };
    const lines = [line("input", "Input, not cached", m.tokens.in - cached, p?.input), line("cached", "Input, from cache", cached, p ? (p.cacheRead ?? p.input) : undefined)];
    if (m.tokens.cacheWrite > 0) lines.push(line("cacheWrite", "Cache writes", m.tokens.cacheWrite, p ? (p.cacheWrite ?? p.input) : undefined));
    lines.push(line("output", "Output, with thinking", m.tokens.out, p?.output));
    const discount = p && p.input > 0 ? Math.max(0, 1 - (p.cacheRead ?? p.input) / p.input) : undefined;
    out.models.push({ model: m.model, calls: m.calls, lines, ...(m.cost !== undefined ? { cost: m.cost } : {}), ...(discount !== undefined ? { discount } : {}) });
    out.calls += m.calls;
    out.since = out.since === undefined ? m.since : Math.min(out.since, m.since);
    if (m.cost !== undefined) out.cost += m.cost;
    else out.unpriced += m.calls;
    out.input += m.tokens.in;
    out.cached += cached;
    out.output += m.tokens.out;
    if (p) out.saved += (cached * Math.max(0, p.input - (p.cacheRead ?? p.input))) / PER_MILLION;
  }
  return out;
}

/** One part of what the chat's session is told: its size, and when it is said. */
export interface ContextRow {
  key: "rules" | "tools" | "situation";
  label: string;
  tokens: number;
  note: string;
}

/** What the session is told, part by part: its rules and its tools at each start, the situation whole then and, beside a prompt, only what changed. */
export function contextRows(c: BrainContext): ContextRow[] {
  return [
    { key: "rules", label: "Rules", tokens: c.tokens.rules, note: "at each start" },
    { key: "tools", label: "Tools", tokens: c.tokens.tools, note: "at each start" },
    { key: "situation", label: "Situation", tokens: c.tokens.situation, note: "whole at a start, then what changed" },
  ];
}

/** The context a session holds against the size it is folded at. */
export interface HeldContext {
  used: number;
  limit: number;
  /** 0 to 1, and past it when over. */
  share: number;
}

/** What the session holds of its limit; none until its harness has said. */
export function heldContext(used: number | undefined, limit: number | undefined): HeldContext | undefined {
  return used !== undefined && limit !== undefined && limit > 0 ? { used, limit, share: used / limit } : undefined;
}

// --- the session the chat runs in ----------------------------------------------------------------

const HARNESS_WORDS: Record<AssistantHarness, string> = { claude: "Claude Code", codex: "Codex" };

/** The chat's head: what runs the chat, where it stands, how full its context is, and its terminal where the view may show it. */
export interface ChatHead {
  status: AssistantState["status"];
  /** The harness, its model and its effort; what is missing when nothing runs it. */
  words: string;
  /** Where it stands, when that is not simply ready. */
  note?: string;
  title: string;
  context?: HeldContext;
  /** Its terminal's id. */
  terminal?: string;
}

const STATUS_NOTE: Record<AssistantState["status"], string | undefined> = {
  off: "off",
  unavailable: "no account signed in",
  starting: "starting",
  idle: undefined,
  busy: "working",
  down: "starting again",
};

/** The chat's head, from what the node says of the session the chat runs in; none from a node that says nothing of one. */
export function chatHead(state: ViewState): ChatHead | undefined {
  const a = state.assistant;
  if (!a || !state.connected) return undefined;
  const account = a.profile !== undefined ? state.profiles.get(a.profile)?.name : undefined;
  const words = a.harness ? [HARNESS_WORDS[a.harness], a.model, a.effort !== undefined ? `${a.effort} effort` : undefined].filter((w) => w !== undefined).join(" · ") : "No agent";
  const note = STATUS_NOTE[a.status];
  const context = heldContext(a.context?.used, a.context?.limit);
  const terminal = a.terminal && state.scopes.includes("terminal") && (a.status === "idle" || a.status === "busy") ? a.terminal.id : undefined;
  const runs = a.harness ? `The chat runs in a ${HARNESS_WORDS[a.harness]} session of your own${account ? `, on the account ${account}` : ""}.` : "The chat runs in a Claude Code or Codex session of your own.";
  return {
    status: a.status,
    words,
    ...(note !== undefined ? { note } : {}),
    title: a.detail !== undefined ? `${runs} ${a.detail}` : runs,
    ...(context ? { context } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
  };
}

/** What the chat's pane shows: the conversation, or the session's own terminal once the user chose it and the view may open it. */
export function chatMode(chosen: "chat" | "terminal" | undefined, state: ViewState): "chat" | "terminal" {
  return chosen === "terminal" && chatHead(state)?.terminal !== undefined ? "terminal" : "chat";
}

/** Whether the chat's session can be started again from here: the node runs one, and this view may. */
export function canRestartChat(state: ViewState): boolean {
  const a = state.assistant;
  return state.connected && a !== undefined && a.status !== "off" && state.scopes.includes("nodes");
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
  /** The account's id, once signed in: what support knows it by, small beside the title. */
  id?: string;
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

/**
 * A machine's agent messaging in Devices: whether its Claude sessions that run without
 * permission prompts take other agents' messages at once, and the switch. None for a machine
 * that runs no agent messaging, one lent to this cluster (its owner's to set), or a view that
 * may not set it.
 */
export interface AgentsCard {
  node: NodeId;
  accept: boolean;
  words: string;
}

export function selectAgents(state: Pick<ViewState, "scopes">, node: Node): AgentsCard | undefined {
  const agents = node.capabilities.agents;
  if (!agents || node.hands === true || !state.scopes.includes("sessions:write")) return undefined;
  return {
    node: node.id,
    accept: agents.acceptInBypass,
    words: agents.acceptInBypass ? "Sessions that skip permission prompts take other agents' messages at once" : "Sessions that skip permission prompts hold other agents' messages until you allow each",
  };
}

/** The direct connections row: `plan` when the plan has none, else a line per node that said where it stands. */
export interface DirectRow {
  kind: "plan" | "nodes";
  words: string;
  lines: DirectLine[];
}

const METRIC_LABELS: Record<string, string> = { llm_tokens_in: "tokens in", llm_tokens_out: "tokens out", stt_seconds: "speech in", tts_chars: "speech out", embed_tokens: "embeddings", relay_messages: "relay", push_count: "pushes", relayed_nodes: "relayed nodes", backup_bytes: "backup", turn_credentials: "TURN credentials" };

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
  return { kind: "in", title: "Signed in", id: a.subject, sub, connected: a.connected ?? false, bars, ...(backup ? { backup } : {}), ...(direct ? { direct } : {}) };
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
  const access = presetAccess(form.preset, form.limit);
  if ("error" in access) return access;
  const end = GRANT_ENDS.find((e) => e.key === form.end);
  return { kind: "controller", name, access, ...(end && "ms" in end ? { expiresIn: end.ms } : {}) };
}

/** A preset as an access, perhaps kept to one node or one workspace. */
function presetAccess(key: PhonePreset, limit: string | undefined): Access | { error: string } {
  const preset = PHONE_PRESETS[key];
  const access: Access = { scopes: [...preset.scopes], messages: key === "full" ? "send" : "none" };
  if (limit) {
    if (key === "full") return { error: "everything reaches every node: pick its sessions or a look to keep it to one" };
    const [kind, id] = [limit.slice(0, limit.indexOf(":")), limit.slice(limit.indexOf(":") + 1)];
    if (kind === "node") access.nodes = [id as NodeId];
    else if (kind === "workspace") access.workspaces = [id as Workspace["id"]];
    else return { error: "no such limit" };
  }
  return access;
}

/** A browser's key just minted, as its panel shows it: whose, the key to type, the address to type it at, the link its QR code holds, until when. */
export interface IssuedKey {
  grant: string;
  name: string;
  key: string;
  address: string;
  link: string;
  expiresAt: number;
  /** For a shared computer: nothing is kept in that browser, and its access ends with its tab. */
  session: boolean;
}

// --- connections: this user's terminals joined to other users' -----------------------------------

/** A connection's code just made, as its panel shows it: which connection, the code, until when, and whose alone. */
export interface IssuedCode {
  id: string;
  code: string;
  expiresAt: number;
  for?: string;
}

/** One connection as Devices shows it. */
export interface ConnectionRowView {
  id: string;
  pending: boolean;
  /** This end: the agent there now, or the terminal; the machine. */
  mine: string;
  /** The other end: `login/name`, or who the code is for while pending. */
  theirs: string;
  /** The rest on one line: their agent, the counts, the last message, what waits, the time an invite has left. */
  words: string;
  /** The dot: the far end has an agent now (`live`), has none (`idle`), or not used yet (`pending`). */
  tone: "live" | "idle" | "pending";
  title: string;
}

/** Every connection, the live ones first, oldest first within each. */
export function selectConnections(state: Pick<ViewState, "connections" | "sessions" | "nodes" | "connectionCode">, now: number): ConnectionRowView[] {
  const rows = [...state.connections.values()].filter((c) => c.state !== "ended").sort((a, b) => (a.state === b.state ? a.createdAt - b.createdAt : a.state === "active" ? -1 : 1));
  return rows.map((c) => {
    const card = c.session ? state.sessions.get(c.session) : undefined;
    const machine = state.nodes.get(c.node)?.name;
    const here = card ? `${c.name ?? sessionLabel(card.session)} (${HARNESS_NAMES[card.session.harness]})` : (c.name ?? "a terminal");
    const mine = `${here}${machine ? ` on ${machine}` : ""}`;
    if (c.state === "pending") {
      const left = c.expiresAt !== undefined ? leftWords(c.expiresAt, now) : undefined;
      const shown = state.connectionCode?.id === c.id;
      return {
        id: c.id,
        pending: true,
        mine,
        theirs: c.by === "agent" ? "invited by its agent" : "invited",
        words: [left ? (left.expired ? "the code ran out" : `the code holds ${left.left}`) : "", shown ? "" : "not used yet"].filter(Boolean).join(" · "),
        tone: "pending",
        title: `A code for ${mine}${c.by === "agent" ? ", made by its agent" : ""}: whoever uses it connects a terminal of theirs to this one.`,
      };
    }
    const peer = c.peer;
    const theirs = peer ? `${peer.user}/${peer.name}` : "someone";
    const agent = peer?.live === false ? "no agent there now" : peer?.harness ? `${HARNESS_NAMES[peer.harness]} at ${peer.user}'s` : "";
    const counts = c.sent + c.received > 0 ? `${c.sent} sent, ${c.received} received` : "no messages yet";
    const last = c.lastAt !== undefined ? `last ${agoWords(c.lastAt, now)}` : "";
    const waiting = c.queued ? `${c.queued} waiting` : "";
    return {
      id: c.id,
      pending: false,
      mine,
      theirs,
      words: [agent, counts, last, waiting].filter(Boolean).join(" · "),
      tone: peer?.live === false ? "idle" : "live",
      title: `${mine} and ${theirs}${peer ? `, ${peer.user} as the Cophyla server vouched for them` : ""}: their agent and yours may message each other until the terminal closes or either of you ends it.`,
    };
  });
}

/** The connections a session is an end of, by the names its agent sends to: what its pane's head shows. */
export function sessionConnections(state: Pick<ViewState, "connections">, session: string): string[] {
  return [...state.connections.values()].filter((c) => c.state === "active" && c.session === session && c.peer).map((c) => `${c.peer!.user}/${c.peer!.name}`);
}

/** The sessions a connection may be made for: live agent sessions, not the chat's own, newest first. */
export function connectableSessions(state: Pick<ViewState, "sessions" | "nodes">): { id: string; label: string }[] {
  return [...state.sessions.values()]
    .map((c) => c.session)
    .filter((s) => s.status !== "ended" && s.role !== "assistant")
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => {
      const machine = state.nodes.get(s.node)?.name;
      return { id: s.id, label: `${sessionLabel(s)} (${HARNESS_NAMES[s.harness]}${machine ? ` on ${machine}` : ""})` };
    });
}

/** The code's panel: how long it holds. */
export function codeWords(code: IssuedCode, now: number): { left: string; expired: boolean } {
  return leftWords(code.expiresAt, now);
}

/** What making a code (`invite`) or using one (`accept`) for a session means, said under the form. */
export function connectNote(kind: "invite" | "accept", session: Pick<Session, "mode"> | undefined): string {
  const what = kind === "invite" ? "Whoever uses the code within fifteen minutes connects a terminal of theirs to this session's. It works once." : "Their agent and this session's will be able to message each other.";
  const bypass = session?.mode === "bypassPermissions" ? " That session runs without permission prompts: their agent's messages will reach it as they are." : "";
  return `${what} The connection lasts as long as the terminal.${bypass}`;
}

/** Whether a session's header offers Connect: a live agent session of the user's, not the chat's own, to a client that sees connections. */
export function headConnectOffered(state: Pick<ViewState, "scopes">, s: Pick<Session, "status" | "role">): boolean {
  return state.scopes.includes("controllers") && s.status !== "ended" && s.role !== "assistant";
}

/** The Connect panel under a session's header, open: its mode, the connection it made once it made one, and why the last try failed. */
export interface HeadConnect {
  session: string;
  mode: "invite" | "accept";
  made?: string;
  error?: string;
  /** Someone else (a code) opened by the user while it would be folded. */
  others?: boolean;
}

/**
 * A connection request that failed, in words the user can act on. An app built before
 * connections refuses the request itself ("unknown method"), and a daemon from before them
 * answers `unsupported`: both mean updating, which the bare message does not say.
 */
export function connectionFailure(code: string | undefined, message: string): string {
  if (code === "unsupported" && /^unknown method connection\./.test(message)) return "This Cophyla app is older than connections: update it, or open it again after an update, then try again.";
  if (code === "unsupported" && /connection\./.test(message)) return "Cophyla on this computer is older than connections: update it, then try again.";
  return message;
}

/** What the Connect panel shows: why this client makes none; the form; the code it made; or who it connected to. */
export type HeadConnectView =
  | { kind: "blocked"; why: string }
  | { kind: "form"; mode: "invite" | "accept"; note: string; error?: string }
  | { kind: "code"; code: IssuedCode; left: string; expired: boolean }
  | { kind: "connected"; peer: string };

export function headConnectView(state: Pick<ViewState, "client" | "controllers" | "connections" | "connectionCode">, session: Pick<Session, "mode">, open: Omit<HeadConnect, "session">, now: number): HeadConnectView {
  const blocked = connectionBlock(state);
  if (blocked !== undefined) return { kind: "blocked", why: blocked };
  const made = open.made !== undefined ? state.connections.get(open.made) : undefined;
  if (made?.state === "active" && made.peer) return { kind: "connected", peer: `${made.peer.user}/${made.peer.name}` };
  const code = state.connectionCode;
  if (open.made !== undefined && code?.id === open.made) {
    const words = codeWords(code, now);
    return { kind: "code", code, left: words.left, expired: words.expired };
  }
  return { kind: "form", mode: open.mode, note: connectNote(open.mode, session), ...(open.error !== undefined ? { error: open.error } : {}) };
}

/**
 * Why this client makes and uses no connection, when it does not: a connection has no end of
 * its own, so a browser's or a phone's access that ends, or a shared computer's session, may
 * end one but never make one. Undefined for the desktop app and a device whose access lasts.
 */
export function connectionBlock(state: Pick<ViewState, "client" | "controllers">): string | undefined {
  const id = state.client?.controller;
  const own = id !== undefined ? state.controllers.get(id) : undefined;
  if (!own) return undefined;
  if (own.session) return "A shared computer's session makes no connection. Make one in the desktop app.";
  if (own.expiresAt !== undefined) return `This ${own.form === "browser" ? "browser's" : "phone's"} access ends, and a connection lasts as long as its terminal: make one in the desktop app, or on a device whose access does not end. You can end one here.`;
  return undefined;
}

/** How long a browser's access lasts, thirty days first: a browser's grant always ends, ninety days at the most. */
export const BROWSER_ENDS = [
  { key: "30d", label: "30 days", ms: 30 * 86_400_000 },
  { key: "7d", label: "1 week", ms: 7 * 86_400_000 },
  { key: "1d", label: "1 day", ms: 86_400_000 },
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "90d", label: "90 days", ms: 90 * 86_400_000 },
] as const;
export type BrowserEnd = (typeof BROWSER_ENDS)[number]["key"];

/** What a browser's key asks for: a preset, perhaps kept to one node or one workspace, an end, or one session on a shared computer. */
export interface BrowserInviteForm {
  name: string;
  preset: PhonePreset;
  limit?: string;
  end: BrowserEnd;
  session: boolean;
}

/** The `browser.invite` params a browser's form gives. One session has no length to pick: it ends with its tab. */
export function browserInviteParams(form: BrowserInviteForm): { name: string; access: Access; expiresIn?: number; session?: true } | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "name the browser" };
  const access = presetAccess(form.preset, form.limit);
  if ("error" in access) return access;
  if (form.session) return { name, access, session: true };
  const end = BROWSER_ENDS.find((e) => e.key === form.end) ?? BROWSER_ENDS[0];
  return { name, access, expiresIn: end.ms };
}

/** The key panel's words: how long the key can still be typed. */
export function keyWords(key: IssuedKey, now: number): { left: string; expired: boolean } {
  return leftWords(key.expiresAt, now);
}

/**
 * What this client's own access means for what it adds, when it is a paired device whose
 * access ends: nothing it adds outlives it, and a shared computer's session adds nothing.
 */
export function minterWords(state: ViewState, now: number): { blocked: boolean; words: string } | undefined {
  const id = state.client?.controller;
  const own = id !== undefined ? state.controllers.get(id) : undefined;
  if (!own) return undefined;
  if (own.session) return { blocked: true, words: "This is a shared computer's session: it adds no device." };
  const end = endWords(own.expiresAt, now);
  if (end === undefined) return undefined;
  return { blocked: false, words: `A device added from this ${own.form === "browser" ? "browser" : "phone"} keeps its access no longer than this one's own, which ${end}.` };
}

// --- the node on its own network ----------------------------------------------------------------

/** The node this client's socket is on, on its own network, as Devices says it. */
export interface LanCard {
  state: LanState["state"];
  /** How it stands, in a line. */
  words: string;
  /** What a person types into a browser on another computer, best first. */
  addresses: string[];
  /** What else there is to say, a line each: the firewall's ports, the certificate's fingerprint, the user's own certificate, the stream port's trouble, the last request turned away. */
  notes: { key: string; text: string; trouble?: boolean }[];
  /** The switch, offered where the app is on the machine itself. */
  turnOn: boolean;
  turnOff: boolean;
}

export function selectLan(state: ViewState, now: number, locale?: string): LanCard | undefined {
  const lan = state.lan;
  if (!lan || !state.scopes.includes("controllers")) return undefined;
  // turning it on opens the machine to its network, so it is asked on the machine itself: where the desktop app is
  const here = state.client?.kind === "ui";
  const where = here ? "this computer" : "the computer this page comes from";
  let words: string;
  switch (lan.state) {
    case "on":
      words = `On: phones and browsers on this network reach Cophyla on ${where}.`;
      break;
    case "nodes":
      words = `Off for phones and browsers. Your other computers still link to ${where}.`;
      break;
    case "off":
      words = `Off: nothing on this network reaches Cophyla on ${where}.`;
      break;
    case "failed":
      words = `It could not start: ${lan.reason ?? "its port could not be opened"}.`;
      break;
  }
  const notes: LanCard["notes"] = [];
  if (lan.state === "on") {
    const ports = [lan.port, lan.stream?.port].filter((n): n is number => n !== undefined);
    if (ports.length > 0) notes.push({ key: "firewall", text: `If another device cannot open it, allow TCP ${ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.join(" and ")}`} on private networks in the firewall of ${where}.` });
    if (lan.fingerprints) notes.push({ key: "fingerprint", text: `Opened by address, a browser warns the first time: the certificate is one this computer made for itself. Its SHA-256 fingerprint is ${lan.fingerprints.certificate}` });
  }
  const own = lan.certificate;
  if (own) {
    const names = own.names.join(", ");
    if (own.error !== undefined) notes.push({ key: "certificate", text: names ? `The certificate for ${names} stays in use; the one on disk now does not pass: ${own.error}.` : `Your own certificate is not in use: ${own.error}.`, trouble: true });
    else if (names) notes.push({ key: "certificate", text: `Your own certificate serves ${names}${own.validTo !== undefined ? `, until ${new Date(own.validTo).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" })}` : ""}: opened under that name, no browser warns.` });
  }
  if (lan.stream?.error !== undefined) notes.push({ key: "stream", text: `A desktop cannot be shown in a browser: ${lan.stream.error}.`, trouble: true });
  if (lan.refused) notes.push({ key: "refused", text: `Turned away ${agoWords(lan.refused.at, now)}: ${lan.refused.detail}.` });
  return { state: lan.state, words, addresses: lan.addresses, notes, turnOn: here && !lan.enabled, turnOff: here && lan.enabled };
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

/** Whether the join asks about this machine's sign-in door: a Windows machine whose Cophyla has one (its desktop's state says `door`). */
export function joinAsksDoor(state: ViewState): boolean {
  const self = state.node === undefined ? undefined : state.nodes.get(state.node);
  return self?.platform === "windows" && state.remote.get(self.id)?.door !== undefined;
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

/** The phones among them: everything that is not a browser on another computer. */
export function selectPhones(state: ViewState): Controller[] {
  return selectControllers(state).filter((c) => c.form !== "browser");
}

/** The browsers on other computers, paired with a key. */
export function selectBrowsers(state: ViewState): Controller[] {
  return selectControllers(state).filter((c) => c.form === "browser");
}

/** When a controller was last seen, in words; `self` is the controller this client is, which its own row says. */
export function controllerWords(controller: Controller, now: number, self?: string): string {
  const mine = self !== undefined && controller.id === self ? (controller.form === "browser" ? "this browser" : "this phone") : "";
  const last = controller.connected ? "connected" : controller.lastSeen === undefined ? "never connected" : `last seen ${ago(controller.lastSeen, now)}`;
  // a shared computer's: kept nowhere, gone with its tab
  const seen = [mine, last, controller.session ? "a shared computer's session" : ""].filter(Boolean).join(" · ");
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

/** Its link's frames go through the relay now: it joined through it, and no data channel carries them. */
export function relayed(node: Node): boolean {
  return node.via === "relay" && !node.p2p;
}

/**
 * One card per node: the computer the app runs on first (the one it talks to, from a phone),
 * then the primary, then the others by name, the offline ones last; its bars from the latest
 * sample and its processes summed by owner. The line beside the name says which is this
 * computer (a desktop app's own, never a phone's) and each one's role.
 */
export function selectNodes(state: ViewState): NodeCard[] {
  const first = hereNode(state);
  const own = state.client?.node;
  const nodes = [...state.nodes.values()].sort(
    (a, b) =>
      Number(b.id === first) - Number(a.id === first) ||
      Number(b.role === "primary") - Number(a.role === "primary") ||
      Number(a.status === "offline") - Number(b.status === "offline") ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : 1),
  );
  return nodes.map((node) => {
    const sample = state.metrics.get(node.id);
    const sub = [node.id === own ? "this computer" : "", node.role, relayed(node) ? "via relay" : "", node.status === "online" ? "" : node.status].filter(Boolean).join(" · ");
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
  /** What the row is kept by: its account's mark, or its profile's id while the account is not known. */
  key: string;
  /** The profile the row is named after. */
  profile: string;
  name: string;
  /** The harness the login is for, once `profile.list` said: its mark goes beside the name. */
  harness?: HarnessProfile["harness"];
  /** The name, with its machine's when another login of the same harness has the same name; the harness's mark tells the rest apart. */
  label: string;
  /** The account's email, once a profile signed in as it says: the row shows it in the name's place unless the user chose the names. */
  email?: string;
  /** One account signed in on several machines or in several directories: where, in words. */
  where?: string;
  spend: Spend;
  /** The login's plan limits, from the latest sample that read them. */
  limits?: ProfileLimits;
}

/**
 * Spend per login summed over every node, with its plan limits beside it, the costliest first;
 * a login with limits and nothing spent has a row too. A subscription signed in on several
 * machines, or in several directories of one, is one row: its profiles share
 * `HarnessProfile.account`, their spend adds up and the newest reading of its limits stands.
 * Profiles named as `profile.list` has them.
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
  const logins = new Map<string, string[]>();
  for (const profile of new Set([...total.keys(), ...limits.keys()])) {
    const key = state.profiles.get(profile)?.account ?? profile;
    logins.set(key, [...(logins.get(key) ?? []), profile]);
  }
  const rows: SpendRow[] = [];
  const members = new Map<SpendRow, HarnessProfile[]>();
  for (const [key, ids] of logins) {
    const spend: Spend = { in: 0, out: 0, cached: 0, cost: 0 };
    let l: ProfileLimits | undefined;
    for (const id of ids) {
      const s = total.get(id);
      if (s) {
        spend.in += s.in;
        spend.out += s.out;
        spend.cached += s.cached;
        spend.cost += s.cost;
      }
      const read = limits.get(id);
      if (read && (!l || read.at > l.at)) l = read;
    }
    if (spend.in + spend.out + spend.cached + spend.cost === 0 && !l?.session && !l?.weekly) continue;
    // Every profile signed in as the account, those with nothing to count too, so the row says where it is.
    const account = state.profiles.get(ids[0]!)?.account;
    const known = account ? [...state.profiles.values()].filter((p) => p.account === account) : ids.flatMap((id) => state.profiles.get(id) ?? []);
    const p = [...known].sort((a, b) => nameRank(a) - nameRank(b) || a.name.localeCompare(b.name))[0];
    const profile = p?.id ?? ids[0]!;
    const name = p?.name ?? profile.replace(/^prof_/, "").slice(0, 6);
    const row: SpendRow = { key, profile, name, ...(p ? { harness: p.harness } : {}), label: name, spend, ...(l ? { limits: l } : {}) };
    const email = p?.email ?? known.find((k) => k.email)?.email;
    if (email) row.email = email;
    if (known.length > 1) row.where = whereWords(state, known);
    members.set(row, known);
    rows.push(row);
  }
  // Two logins of one name are told apart by their harness's mark (each harness's "default"), and of one harness too by their machine.
  for (const row of rows) {
    const twins = rows.filter((r) => r.name === row.name && r.harness === row.harness);
    if (twins.length < 2 || state.nodes.size < 2) continue;
    const machines = [...new Set(members.get(row)!.filter((p) => p.name === row.name).flatMap((p) => state.nodes.get(p.node)?.name ?? []))];
    if (machines.length > 0) row.label = `${row.name} · ${machines.join(", ")}`;
  }
  return rows.sort((a, b) => b.spend.cost - a.spend.cost || b.spend.in + b.spend.out - (a.spend.in + a.spend.out) || a.label.localeCompare(b.label));
}

/** Which of an account's profiles names its row: one the user declared, then one not called "default". */
function nameRank(p: HarnessProfile): number {
  return p.origin === "user" ? 0 : p.name !== "default" ? 1 : 2;
}

/** Where one account is signed in: "Signed in on Desk and Laptop", or with each profile's name where they differ. */
function whereWords(state: ViewState, profiles: HarnessProfile[]): string {
  const machine = (p: HarnessProfile) => state.nodes.get(p.node)?.name ?? "another machine";
  const sorted = [...profiles].sort((a, b) => machine(a).localeCompare(machine(b)) || a.name.localeCompare(b.name));
  const sameName = sorted.every((p) => p.name === sorted[0]!.name);
  const parts = sameName ? [...new Set(sorted.map(machine))] : sorted.map((p) => `${machine(p)} as ${p.name}`);
  return `Signed in on ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}`;
}

/** Each harness as the user knows it. */
export const HARNESS_NAMES: Record<HarnessProfile["harness"], string> = { claude: "Claude", codex: "Codex", acp: "ACP", muse: "Muse" };

// --- the rail's Status: a line per machine, the usage, a line per phone ------------------------

/** One reading as a share, a value over a track: a machine's cpu, memory or busiest GPU, or a metered part of the plan. */
export interface StatusMeter {
  /** What it reads: cpu, memory, gpu, or the plan's metric. */
  key: string;
  label: string;
  percent: number;
  words: string;
  /** `none` while the reading is not known: a dash over an empty track. */
  level: "none" | "normal" | "warn" | "critical";
  /** The reading in full, on hover: the GPU's name, memory used of total. */
  title: string;
}

/** A machine's line in the rail's Status: a glance, all it can do waits in Devices but its desktop. */
export interface StatusMachine {
  node: NodeId;
  name: string;
  online: boolean;
  /** At the line's right: this computer, the primary, how it is reached, or since when it is offline. */
  sub: string;
  title: string;
  /** Online, once a sample came: cpu, memory, and the busiest GPU. */
  meters: StatusMeter[];
  /** Its desktop while it is shared: whether someone is watching it, and who. */
  desktop?: { watched: boolean; title: string };
  /** What wants the user in Devices: invite it again, its desktop host failed. */
  alert?: string;
  /** This client can open its desktop: in Moonlight, or beside the view. */
  connect: boolean;
  beside: boolean;
}

/** A phone's line in the rail's Status: here now, or when it was last. */
export interface StatusPhone {
  id: string;
  name: string;
  connected: boolean;
  words: string;
  title: string;
}

function meterLevel(percent: number): "normal" | "warn" | "critical" {
  return percent >= 95 ? "critical" : percent >= 80 ? "warn" : "normal";
}

/** A machine's three readings from its latest sample: cpu, memory, and the busiest of its GPUs. */
export function statusMeters(sample: MetricsSample): StatusMeter[] {
  const meter = (key: StatusMeter["key"], label: string, percent: number, title: string, words?: string): StatusMeter => {
    const p = clamp(percent);
    return { key, label, percent: p, words: words ?? `${Math.round(p)}%`, level: meterLevel(p), title };
  };
  const out = [meter("cpu", "CPU", sample.cpu, `CPU ${percentWords(sample.cpu)}`)];
  // memory as used of total, its track the share
  const { used, total } = sample.memory;
  out.push(meter("memory", "RAM", total > 0 ? (used / total) * 100 : 0, `Memory ${usedWords(used, total)}`, memoryWords(used, total)));
  const gpu = [...(sample.gpu ?? [])].sort((a, b) => b.util - a.util)[0];
  if (gpu) out.push(meter("gpu", "GPU", gpu.util, `${gpu.name} ${percentWords(gpu.util)}${gpu.vramTotal > 0 ? ` · ${usedWords(gpu.vramUsed, gpu.vramTotal)}` : ""}`));
  return out;
}

/** The user's machines that watch a desktop now, by name; a browser's session by its own; "someone" for a client no name says. */
function watchers(state: ViewState, viewers: RemoteViewer[]): string[] {
  const names = new Set<string>();
  for (const v of viewers) {
    if (v.connected !== true) continue;
    const owner = viewerOwner(state, v);
    names.add(owner ? (state.nodes.get(owner.node)?.name ?? "another computer") : (v.name ?? "someone"));
  }
  return [...names];
}

/**
 * A line per machine, in the cards' order: this computer first, then the primary, then by
 * name. What it is (this computer, the primary), how it is reached, its readings, its desktop
 * while shared, and what wants the user in Devices.
 */
export function selectStatusMachines(state: ViewState, now = Date.now()): StatusMachine[] {
  const own = state.client?.node;
  return selectNodes(state).map(({ node, sample }) => {
    const online = node.status === "online";
    const grant = nodeGrant(state, node.id);
    const remote = state.scopes.includes("remote") && online ? state.remote.get(node.id) : undefined;
    const card = selectRemote(state, node);
    // offline, since when is on hover and in Devices: beside a long name the line keeps the word
    // at its sign-in screen it says so before anything else: its desktop is all there is of it
    const sub = online ? [node.door ? atDoorWords(node.door) : "", node.id === own ? "this computer" : "", node.role === "primary" ? "primary" : "", node.hands ? "hands" : "", relayed(node) ? "via relay" : ""].filter(Boolean).join(" · ") : node.status;
    const row: StatusMachine = {
      node: node.id,
      name: node.name,
      online,
      sub,
      title: `${node.name} · ${PLATFORM_NAMES[node.platform]} · ${online ? (node.door ? atDoorWords(node.door) : "online") : node.status === "offline" ? `last seen ${ago(node.lastSeen, now)}` : node.status}`,
      meters: online && sample ? statusMeters(sample) : [],
      connect: card?.connect ?? false,
      beside: card?.beside ?? false,
    };
    if (remote && remote.host.status !== "off") {
      const who = watchers(state, remote.viewers);
      row.desktop = { watched: remote.streaming, title: remote.streaming ? (who.length > 0 ? `Its desktop: ${who.join(", ")} watching` : "Its desktop: being watched") : "Its desktop is shared" };
    }
    if (grant?.status === "reinvite") row.alert = "invite it again";
    else if (remote?.host.status === "unavailable") row.alert = "its desktop could not start";
    return row;
  });
}

/** A line per phone, the connected first: here now, or when it was last. */
export function selectStatusPhones(state: ViewState, now = Date.now()): StatusPhone[] {
  return selectControllers(state).map((c) => {
    const words = c.connected ? "connected" : c.lastSeen === undefined ? "never connected" : ago(c.lastSeen, now);
    return { id: c.id, name: c.name, connected: c.connected, words, title: `${c.name} · ${controllerWords(c, now)}` };
  });
}

/** Devices' count in words, as the rail's link and the page's head say it: 2 computers · 1 phone. */
export function devicesWords(state: ViewState): string {
  const computers = state.nodes.size;
  const browsers = selectBrowsers(state).length;
  const phones = state.controllers.size - browsers;
  const count = (n: number, what: string) => (n > 0 ? `${n} ${what}${n === 1 ? "" : "s"}` : "");
  return [count(computers, "computer"), count(phones, "phone"), count(browsers, "browser")].filter(Boolean).join(" · ");
}

export const PLATFORM_NAMES: Record<Platform, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

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
  /** This client can show the desktop beside its view: its host lays it over the view. The desktop app onto another node's; the page in a desktop browser onto any, the node it is served from included. */
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
  /** The machine is at its sign-in screen (or locked, with Cophyla not running), reached through its door: its desktop alone. */
  atDoor?: "signin" | "locked";
  /** Its sign-in door, where it can have one: a Windows machine, not the primary, its desktop shared. */
  door?: DoorCard;
}

/** A machine's sign-in door on its desktop block: the switch, where the door stands, and Remove. */
export interface DoorCard {
  node: NodeId;
  /** Switched on: the user's own devices may reach this desktop at its sign-in screen. */
  on: boolean;
  state: DoorState["state"];
  words: string;
  /** Its service is on the machine and the door is off: it can be taken off. */
  remove: boolean;
  /** A machine lent as hands, seen from another: its owner switches its door on the machine itself, as its sharing; here it is only shown. */
  lent?: true;
}

/** Where a sign-in door stands, in words. */
export function doorWords(door: DoorState): string {
  switch (door.state) {
    case "off":
      return "off";
    case "installing":
      return "installing";
    case "preparing":
      return "getting ready";
    case "ready":
      return "ready: your devices can reach it at its sign-in screen";
    case "serving":
      return "holding its desktop at the sign-in screen";
    case "unavailable":
      return door.reason ? `unavailable: ${door.reason}` : "unavailable";
  }
}

/** A machine reached through its door, in words: the sign-in screen, or locked with Cophyla not running. */
export function atDoorWords(at: "signin" | "locked"): string {
  return at === "signin" ? "At the sign-in screen" : "Locked, Cophyla not running";
}

/**
 * A node's sign-in door block, or undefined where it has none: not Windows, the primary, sharing
 * off, a node older than the door, or one at its door now. A hands node's is switched only in an
 * app of its own (`here`): from another it is shown, `lent`, with no switch and no Remove.
 */
export function selectDoor(node: Node, remote: RemoteState, here = false): DoorCard | undefined {
  const door = remote.door;
  if (!door || node.platform !== "windows" || node.role === "primary" || node.door || remote.host.status === "off") return undefined;
  const lent = node.hands === true && !here;
  return { node: node.id, on: door.state !== "off", state: door.state, words: doorWords(door), remove: !lent && door.state === "off" && door.version !== undefined, ...(lent ? { lent: true as const } : {}) };
}

/**
 * A node's desktop block, or undefined when there is none to show: without the `remote`
 * scope, or for a node that is not online. Off, it offers to share the desktop. A controller
 * opens any node's desktop in a page, and beside its view where its host lays one there (a
 * desktop browser); the desktop app opens a window, or shows it beside the view, and never
 * onto the desktop it runs on.
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
  const controller = client?.kind === "controller";
  const viewer = controller || elsewhere;
  // Off, a host that runs anyway (a Windows service) still lists who it would let in.
  const viewers = off ? remote.viewers.filter((v) => v.kind === "native") : remote.viewers;
  // The installer's prompt comes up on the machine itself: someone there may have to answer it.
  const away = !(client?.kind === "ui" && client.node === node.id);
  // an app of the machine's own: its daemon serves it
  const door = selectDoor(node, remote, client?.node === node.id);
  const note = remoteNote(remote.host, { paired: off ? viewers.length : 0, ...(away ? { at: node.name } : {}), ...(remote.door ? { door: remote.door } : {}) });
  // at its sign-in screen only the desktop is reached: no switch, no pairing, the ways in kept
  const at = node.door;
  return {
    node: node.id,
    host: remote.host,
    words: at ? atDoorWords(at) : remoteWords(remote.host, remote.streaming),
    ...(note !== undefined ? { note } : {}),
    streaming: remote.streaming,
    connect: ready && viewer,
    beside: ready && (elsewhere || controller) && state.hostEmbed,
    settings: ready && elsewhere,
    pair: ready && !at,
    invite: ready && remote.host.kind === "apollo" && !at,
    share: off && !at,
    stop: !off && !at,
    retry: status === "unavailable" && !at,
    viewers: [...viewers].sort((a, b) => Number(b.connected === true) - Number(a.connected === true) || b.since - a.since),
    ...(at ? { atDoor: at } : {}),
    ...(door ? { door } : {}),
  };
}

/**
 * Whether Connect asks for the page seeded as Beside's is (a few frames behind, at the host's
 * screen size, the pointer hidden): the page in a desktop browser, where Connect shows the same
 * stream over the whole page. A phone's page is left as the viewer has it.
 */
export function connectEmbeds(state: ViewState): boolean {
  return state.client?.kind === "controller" && state.hostEmbed;
}

/** What Connect does, for its button: Moonlight's window in the desktop app, the desktop over the whole page elsewhere. */
export function connectTitle(state: ViewState): string {
  return state.client?.kind === "controller" ? "Show this desktop over the whole page" : "Open this desktop in Moonlight, in a window of its own";
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

/** Whether a desktop is shared, as its block in Devices says it: shared, watched now, coming up or failing, or not shared; or the sign-in screen it is reached at. */
export function desktopWords(remote: Pick<RemoteCard, "host" | "streaming"> & { atDoor?: "signin" | "locked" }): string {
  if (remote.atDoor) return remote.streaming ? `${atDoorWords(remote.atDoor)} · being watched` : atDoorWords(remote.atDoor);
  if (remote.host.status === "off") return "Not shared";
  if (remote.host.status === "ready") return remote.streaming ? "Shared · being watched" : "Shared";
  return `Shared · ${remoteWords(remote.host, remote.streaming)}`;
}

/**
 * What more there is to say of a host: off, that the devices still paired with one that runs
 * anyway (a Windows service) can still connect to it; installing on a machine away from this
 * client, that the installer may wait on someone there.
 */
export function remoteNote(host: RemoteHost, more: { paired?: number; at?: string; door?: DoorState }): string | undefined {
  const n = more.paired ?? 0;
  if (host.status === "off" && n > 0) return `${n} paired device${n === 1 ? "" : "s"} can still connect until revoked`;
  if (host.status === "installing" && more.at !== undefined) return `someone at ${more.at} may need to approve the installer`;
  // the door's service is installed as an administrator, the prompt on the machine's own screen
  if (more.door?.state === "installing") return more.at !== undefined ? `Windows asks for an administrator's approval on ${more.at}'s own screen` : "Windows asks for an administrator's approval on this screen";
  return undefined;
}

/** How long after a stream to a machine at its sign-in screen was opened it is opened again, once someone signed in and Cophyla took the desktop over. */
export const DOOR_REOPEN_MS = 180_000;

/** A stream this view opened to a machine at its sign-in screen: beside the view, or a page; its id once known. */
export interface DoorStream {
  node: NodeId;
  how: "beside" | "page";
  stream?: string;
  at: number;
}

/**
 * Whether a stream opened while its machine was at its sign-in screen opens again now: once,
 * when the machine is itself again (online, no longer at its door) and its host is ready,
 * within DOOR_REOPEN_MS of when it was opened; given up after that.
 */
export function doorReopenStep(s: DoorStream, state: Pick<ViewState, "nodes" | "remote">, now: number): "wait" | "reopen" | "drop" {
  if (now - s.at > DOOR_REOPEN_MS) return "drop";
  const node = state.nodes.get(s.node);
  if (!node || node.status !== "online" || node.door) return "wait";
  return state.remote.get(s.node)?.host.status === "ready" ? "reopen" : "wait";
}

/** Why the sign-in door's switch did nothing, in words to act on: this app, or the machine, is older than the door; the node's own words otherwise. */
export function doorErrorWords(message: string, name: string): string {
  if (/^unknown method remote\.door/.test(message)) return "this app is older than the sign-in door: update it";
  if (/remote\.door is not served|unknown method/.test(message)) return `Cophyla on ${name} is older than the sign-in door: update it there`;
  return message;
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
  if (code === "unsupported" && message.includes("over the relay")) return "a desktop opens on the node's Wi-Fi, or from anywhere once Direct connections is on, under Account in Devices";
  if (code === "unavailable" && /direct connections/i.test(message)) return `${message}: turn Direct connections on for it, under Account in Devices`;
  // a shell from before streams went through its own window
  if (code === "unsupported" && message.includes("has no host.open")) return "this app cannot show a desktop it has no route to: update the app";
  return message;
}

/**
 * Whose viewer a client paired with a host is: the machine its node says paired it, or, from a
 * node older than that, the machine whose name it carries, as cophylad pairs a machine's
 * Moonlight under its name and its web viewer under the name and " web". A web session, or a
 * client paired by hand or by another app, is nobody's.
 */
export function viewerOwner(state: Pick<ViewState, "nodes">, viewer: RemoteViewer): { node: NodeId; browser: boolean } | undefined {
  if (viewer.kind !== "native") return undefined;
  if (viewer.pairedBy !== undefined) return { node: viewer.pairedBy, browser: viewer.browser === true };
  const name = viewer.name;
  if (!name) return undefined;
  for (const n of state.nodes.values()) {
    if (n.name === name) return { node: n.id, browser: false };
    if (`${n.name} web` === name) return { node: n.id, browser: true };
  }
  return undefined;
}

/**
 * One line under a desktop's "Who can view it": a machine of the user's, its Moonlight and its
 * web viewer as one; the host's own web viewer, which its phones and browsers watch through; a
 * browser watching now; or a client paired by hand or by another app. Forget lets go of every
 * viewer the line stands for.
 */
export interface ViewerRow {
  key: string;
  kind: "machine" | "browsers" | "session" | "app";
  /** The viewers' ids, which Forget revokes. */
  ids: string[];
  name: string;
  words: string;
  title: string;
  watching: boolean;
  /** End for a browser's session; Revoke for a pairing while sharing is off, which it can still use; Forget otherwise. */
  forget: "End" | "Revoke" | "Forget";
}

/**
 * Who can view a desktop, a line per device: the user's machines by name (Moonlight, and the
 * web viewer that shows it beside their view), the host's own web viewer as its phones and
 * browsers, each browser watching now, then whatever else is paired. Watching first.
 */
export function viewerRows(state: Pick<ViewState, "nodes" | "client">, remote: RemoteCard, now: number): ViewerRow[] {
  const forget = remote.share ? "Revoke" : "Forget";
  const machines = new Map<string, { node: NodeId; moonlight: RemoteViewer[]; web: RemoteViewer[] }>();
  const rows: ViewerRow[] = [];
  for (const v of remote.viewers) {
    const owner = viewerOwner(state, v);
    if (v.kind === "web") {
      const name = v.name ?? "A browser";
      rows.push({ key: `session:${v.id}`, kind: "session", ids: [v.id], name, words: v.connected ? "watching now in a browser" : `in a browser, opened ${ago(v.since, now)}`, title: `${name}'s browser session on this desktop`, watching: v.connected === true, forget: "End" });
      continue;
    }
    if (!owner) {
      const name = v.name ?? v.id.slice(0, 8);
      rows.push({ key: `app:${v.id}`, kind: "app", ids: [v.id], name, words: v.connected ? "watching now" : "paired by hand or by another app", title: `${name}: a viewer paired outside Cophyla, or by an older version`, watching: v.connected === true, forget });
      continue;
    }
    const key = owner.node === remote.node && owner.browser ? `browsers:${owner.node}` : `machine:${owner.node}`;
    const m = machines.get(key) ?? { node: owner.node, moonlight: [], web: [] };
    (owner.browser ? m.web : m.moonlight).push(v);
    machines.set(key, m);
  }
  for (const [key, m] of machines) {
    const all = [...m.moonlight, ...m.web];
    const watching = all.some((v) => v.connected === true);
    const name = state.nodes.get(m.node)?.name ?? "Another computer";
    if (key.startsWith("browsers:")) {
      const through = m.node === state.client?.node ? "this computer's" : `${name}'s`;
      rows.push({ key, kind: "browsers", ids: all.map((v) => v.id), name: "Phones and browsers", words: watching ? "watching now" : `through ${through} web viewer`, title: "Phones and browsers watch this desktop through the web viewer on this machine; forgotten, it pairs again the next time one opens it", watching, forget });
      continue;
    }
    const ways = [m.moonlight.length > 0 ? "Moonlight" : "", m.web.length > 0 ? "Beside" : ""].filter(Boolean).join(" and ");
    rows.push({ key, kind: "machine", ids: all.map((v) => v.id), name, words: watching ? `watching now · ${ways}` : ways, title: `${name} views this desktop with ${ways === "Beside" ? "Beside, in its app" : ways === "Moonlight" ? "Moonlight" : "Moonlight, and Beside in its app"}`, watching, forget });
  }
  const order: Record<ViewerRow["kind"], number> = { machine: 0, browsers: 1, session: 2, app: 3 };
  return rows.sort((a, b) => Number(b.watching) - Number(a.watching) || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** A viewer's second line: watching now, or since when it has been paired or open. */
export function viewerWords(viewer: RemoteViewer, now: number): string {
  if (viewer.kind === "web") return viewer.connected ? "watching in a browser" : `browser, opened ${ago(viewer.since, now)}`;
  return viewer.connected ? "watching" : `paired ${ago(viewer.since, now)}`;
}

/** A machine's head in Devices: what it is, as tags beside its name, and a line of facts under it. */
export interface MachineFacts {
  tags: { key: "self" | "primary" | "hands" | "reinvite"; label: string; title: string }[];
  /** Its platform, Cophyla's version there, how it is reached or when it was last seen, and when its grant ends. */
  line: string;
}

export function machineFacts(state: ViewState, node: Node, now: number): MachineFacts {
  const grant = nodeGrantWords(state, node, now);
  const tags: MachineFacts["tags"] = [];
  if (node.id === state.client?.node) tags.push({ key: "self", label: "This computer", title: "The computer this app runs on" });
  if (node.role === "primary") tags.push({ key: "primary", label: "Primary", title: "It runs the brain, the chat and the tasks; the others follow it" });
  if (grant.badge === "hands") tags.push({ key: "hands", label: "Hands", title: "It runs what the primary asks, and reaches no other machine" });
  if (grant.reinvite) tags.push({ key: "reinvite", label: "Invite it again", title: "Its key went with a removed machine: invite it again" });
  const status = node.status === "online" ? (relayed(node) ? "online through the relay" : "online") : node.status === "offline" ? `offline, last seen ${ago(node.lastSeen, now)}` : node.status;
  const line = [PLATFORM_NAMES[node.platform], `Cophyla ${node.versions.platform}`, status, grant.end ?? ""].filter(Boolean).join(" · ");
  return { tags, line };
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

/** Memory used of total, short enough for the rail: whole gigabytes, to one place on a machine of under 4 GB. */
export function memoryWords(used: number, total: number): string {
  const gb = (n: number) => (total >= 4 * 1024 ** 3 ? String(Math.round(n / 1024 ** 3)) : (n / 1024 ** 3).toFixed(1));
  return `${gb(used)}/${gb(total)} GB`;
}

/** Today's cost as the rail's column has room for: cents under a hundred dollars, whole dollars from there. */
export function shortCost(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : costWords(usd);
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

/** An email as a Usage row shows it: its first 6 letters and "..." once it has 7 or more; the hover title has it whole. */
export function shortEmail(email: string): string {
  const letters = [...email];
  return letters.length >= 7 ? `${letters.slice(0, 6).join("")}...` : email;
}

/** How old a login's limits are before its row's hover title says when they were read. */
const LIMITS_AGED_MS = 3_600_000;

/** A spend row's hover title: its name and email, each limit with when it starts over and, once an hour old, when it was read, then the day's cost and tokens. */
export function spendTitle(row: SpendRow, now: number): string {
  const window = (label: string, w: LimitWindow | undefined) => {
    if (!w) return `${label}: not known`;
    const left = w.resetsAt !== undefined && w.resetsAt > now ? `, starts over in ${durationWords(w.resetsAt - now)}` : "";
    return `${label}: ${Math.round(w.percent)}% used${left}`;
  };
  const lines = [row.email ? `${row.name} · ${row.email}` : row.name];
  if (row.where) lines.push(row.where);
  if (row.limits) lines.push(window("Session limit", row.limits.session), window("Weekly limit", row.limits.weekly));
  // A login unused for a while keeps its last reading (for ten days): say how old it is.
  if (row.limits && now - row.limits.at >= LIMITS_AGED_MS) lines.push(`Limits as of ${durationWords(now - row.limits.at)} ago`);
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

// --- transfers -------------------------------------------------------------------------------

/** A transfer's row under Transfers: what it is and why, who sent it between which machines, how far, and what may be done with it. */
export interface TransferRow {
  id: string;
  /** The file's or the folder's own name. */
  name: string;
  /** Why it was sent, when the sender said. */
  reason?: string;
  /** Its path where it came from, and the folder it goes to: the row's hover. */
  title: string;
  /** Who sent it, from which machine to which, and once it ended how big it is: `fauna-core · ansar → Agha · 552 KB`. */
  meta: string;
  /** When it ended; none while it is under way. */
  endedAt?: number;
  state: Transfer["state"];
  /** How far it is, 0 to 1. */
  done: number;
  /** What came of how much, with the speed and the time left while it runs; why it waits or failed; nothing once it landed. */
  words: string;
  /** Its bytes ride the server's relay. */
  relay: boolean;
  cancel: boolean;
  retry: boolean;
  dismiss: boolean;
  /** It landed on this computer, whose file manager the desktop app here can show it in. */
  reveal: boolean;
}

/** The ones under way first, the latest of each kind first. */
const TRANSFER_ORDER: Record<Transfer["state"], number> = { running: 0, waiting: 1, queued: 2, failed: 3, done: 4, cancelled: 5 };

/** Between which machines a transfer goes, by their names. */
export function transferRoute(state: ViewState, t: Pick<Transfer, "from" | "to">): string {
  const to = machineName(state, t.to.node);
  return t.from.node === t.to.node ? to : `${machineName(state, t.from.node)} → ${to}`;
}

/** The time a transfer has left, at the speed it goes. */
export function etaWords(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 && m < 60 ? `${h} h ${m} min left` : `${h} h left`;
}

/** A transfer that ended: landed, failed or cancelled. Dismiss takes it off the list. */
export function transferEnded(t: Pick<Transfer, "state">): boolean {
  return t.state === "done" || t.state === "failed" || t.state === "cancelled";
}

/** How big a transfer is: its bytes, and a folder's files. */
function transferSize(t: Transfer): string {
  return `${bytesWords(t.total)}${t.files && t.files.total > 1 ? `, ${t.files.total} files` : ""}`;
}

/** What a transfer's row says under its bar: nothing once it landed, its size being in the line above. */
export function transferWords(t: Transfer): string {
  const of = `${bytesWords(t.bytes)} of ${bytesWords(t.total)}`;
  const files = t.files && t.files.total > 1 ? ` · ${t.files.done} of ${t.files.total} files` : "";
  switch (t.state) {
    case "running": {
      const rate = t.rate !== undefined && t.rate > 0 ? t.rate : undefined;
      const left = rate ? etaWords((t.total - t.bytes) / rate) : "";
      return [`${of}${files}`, ...(rate ? [`${bytesWords(rate)}/s`] : []), ...(left ? [left] : [])].join(" · ");
    }
    case "queued":
      return `${transferSize(t)} · after the one before it`;
    case "waiting":
      return `${t.error ? t.error.charAt(0).toUpperCase() + t.error.slice(1) : "Waiting"} · ${of}${files}`;
    case "done":
      return "";
    case "failed":
      return `Failed: ${t.error ?? "it did not finish"}`;
    case "cancelled":
      return "Cancelled";
  }
}

/** Who sent a transfer, from which machine to which, and once it ended how big it is. */
export function transferMeta(state: ViewState, t: Transfer): string {
  // from another person: who sent it, and from them to the machine it goes to
  const who = t.peer ? (t.peer.agent ? `${t.peer.user}/${t.peer.agent}` : t.peer.user) : t.by.kind === "agent" ? t.by.alias : "You";
  const route = t.peer ? `${t.peer.user} → ${machineName(state, t.to.node)}` : transferRoute(state, t);
  return [who, route, ...(transferEnded(t) ? [transferSize(t)] : [])].join(" · ");
}

/** Every transfer as the rail lists them. */
export function selectTransfers(state: ViewState): TransferRow[] {
  const here = state.client?.node;
  return [...state.transfers.values()]
    .sort((a, b) => TRANSFER_ORDER[a.state] - TRANSFER_ORDER[b.state] || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || (a.id < b.id ? -1 : 1))
    .map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.reason ? { reason: t.reason } : {}),
      title: `${t.from.path}\n→ ${t.to.path ?? t.to.dir}`,
      meta: transferMeta(state, t),
      ...(transferEnded(t) && t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
      state: t.state,
      done: t.state === "done" ? 1 : t.total > 0 ? Math.min(1, t.bytes / t.total) : 0,
      words: transferWords(t),
      relay: t.via === "relay",
      cancel: t.state === "queued" || t.state === "running" || t.state === "waiting",
      retry: t.state === "failed",
      dismiss: transferEnded(t),
      reveal: t.state === "done" && state.hostFilePaths && here !== undefined && t.to.node === here && t.to.path !== undefined,
    }));
}

/** A machine a file can be sent to: its id, its name, and whether it is the one this app runs on. */
export interface SendTarget {
  node: NodeId;
  name: string;
  here: boolean;
}

/**
 * The machines a file on `source` can go to: every other one there now that takes files, hands
 * ones too, never one that shares some folders alone; this computer first, the rest by name.
 */
export function sendTargets(state: ViewState, source: NodeId): SendTarget[] {
  const here = state.client?.node;
  return [...state.nodes.values()]
    .filter((n) => n.id !== source && n.status === "online" && n.capabilities.files === true && n.scope.kind !== "workspaces")
    .map((n) => ({ node: n.id, name: n.name, here: n.id === here }))
    .sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
}

/** Why a file on `source` cannot be sent from here, or undefined when it can. */
export function sendBlocked(state: ViewState, source: NodeId): string | undefined {
  const row = state.nodes.get(source);
  if (!state.scopes.includes("terminal")) return "This app may not send files";
  if (row && row.capabilities.files !== true) return `${row.name} runs an older Cophyla, which sends no files: update it`;
  return undefined;
}

/** The Downloads folder in a home folder's listing, where Send to… starts. */
export function downloadsIn(listing: Pick<FolderPick, "folders">): string | undefined {
  return listing.folders.find((f) => f.name.toLowerCase() === "downloads")?.path;
}

// --- group chats, focus and teammates ---------------------------------------------------------

/** A group's posts as loaded so far, oldest first: whether earlier ones are left, a page on its way, and whether a lost line left them behind. */
export interface GroupPage {
  posts: GroupPost[];
  more: boolean;
  loaded: boolean;
  loading?: boolean;
  /** The line dropped since they were loaded: the latest page is asked for again when the group shows. */
  stale?: boolean;
}

type PersonMember = Extract<GroupMember, { kind: "person" }>;
type AgentMember = Extract<GroupMember, { kind: "agent" }>;

const byNumber = (a: GroupPost, b: GroupPost) => a.n - b.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Posts in number order, each once: a later copy of one (its thumbs, its answer) over an earlier. */
function mergePosts(...lists: GroupPost[][]): GroupPost[] {
  const out = new Map<string, GroupPost>();
  for (const list of lists) for (const p of list) out.set(p.id, p);
  return [...out.values()].sort(byNumber);
}

/** Folds a group, focus or teammate action in; false when the action is none of them. */
function applyTeam(state: ViewState, action: Action): boolean {
  switch (action.type) {
    case "groups":
      state.groups = new Map(action.groups.map((g) => [g.id, g]));
      for (const id of [...state.groupPosts.keys()]) if (!state.groups.has(id)) state.groupPosts.delete(id);
      return true;
    case "group.state": {
      const { left, ...g } = action.params;
      if (left) {
        state.groups.delete(g.id);
        state.groupPosts.delete(g.id);
      } else state.groups.set(g.id, g);
      return true;
    }
    case "group.posts.loading": {
      const page = state.groupPosts.get(action.group) ?? { posts: [], more: false, loaded: false };
      page.loading = true;
      state.groupPosts.set(action.group, page);
      return true;
    }
    case "group.posts.failed": {
      const page = state.groupPosts.get(action.group);
      if (page) page.loading = false;
      return true;
    }
    case "group.posts": {
      const page = state.groupPosts.get(action.group);
      if (action.before !== undefined && page?.loaded && !page.stale) {
        // a page from before the ones shown
        page.posts = mergePosts(action.posts, page.posts);
        page.more = action.more;
        page.loading = false;
        return true;
      }
      // The latest page: what came in while it was asked for, newer than any in it, stays too.
      const last = action.posts.reduce((n, p) => Math.max(n, p.n), 0);
      const since = page ? page.posts.filter((p) => p.n > last) : [];
      state.groupPosts.set(action.group, { posts: mergePosts(action.posts, since), more: action.more, loaded: true });
      return true;
    }
    case "group.posted": {
      // Kept where the group's posts are loaded or on their way; a group never opened loads them when it is.
      const page = state.groupPosts.get(action.params.group);
      if (page) page.posts = mergePosts(page.posts, [action.params.post]);
      return true;
    }
    case "focus":
      state.focus = new Map(action.focus.map((f) => [f.session, f.focus]));
      return true;
    case "focus.state":
      if (action.params.focus) state.focus.set(action.params.session, action.params.focus);
      else state.focus.delete(action.params.session);
      return true;
    case "teammates":
      state.teammates = new Map(action.teammates.filter((t) => t.state !== "ended").map((t) => [t.id, t]));
      if (state.teammateCode && state.teammates.get(state.teammateCode.id)?.state !== "pending") delete state.teammateCode;
      return true;
    case "teammate.state":
      if (action.params.state === "ended") state.teammates.delete(action.params.id);
      else state.teammates.set(action.params.id, action.params);
      // the code on show was used, or cancelled: its panel has done its job
      if (state.teammateCode?.id === action.params.id && action.params.state !== "pending") delete state.teammateCode;
      return true;
    case "teammate.code":
      if (action.code) state.teammateCode = action.code;
      else delete state.teammateCode;
      return true;
    default:
      return false;
  }
}

/** This side's user in a group: the person member marked `me`. */
export function groupMe(g: Pick<Group, "members">): PersonMember | undefined {
  return g.members.find((m): m is PersonMember => m.kind === "person" && m.me === true);
}

/** Whether this side's user made the group: the maker alone ends it, and may take anyone out. */
export function groupMaker(g: Pick<Group, "members" | "by">): boolean {
  const me = groupMe(g);
  return me !== undefined && g.by === me.user;
}

/** Whether End group is offered: to its maker, while it runs. */
export function canEndGroup(g: Pick<Group, "members" | "by" | "ended">): boolean {
  return g.ended === undefined && groupMaker(g);
}

/** A group's tab: its hover, and the words its mark is read as. */
export function groupTabWords(g: Group): { title: string; label: string } {
  const counts = [g.ended ? "ended, read only" : "", g.unread > 0 ? `${g.unread} unread` : "", g.tagged > 0 ? "you are tagged" : ""].filter((w) => w !== "");
  const label = ["Group chat", ...counts].join(", ");
  const people = g.members.filter((m) => m.kind === "agent" && !m.gone).length;
  const title = [g.purpose ? `${g.name}: ${g.purpose}` : g.name, `${people} agent${people === 1 ? "" : "s"}${counts.length > 0 ? ` · ${counts.join(" · ")}` : ""}`].join("\n");
  return { title, label };
}

/**
 * Where each group chat's tab stands in the rail: under the folder group its home names, the
 * innermost one at or around that folder on its machine, counted in that group's heading and
 * in every heading around it; with no home, or no group there now, under Groups. In the order
 * they were made, so nothing moves as they are posted in. `groups` is `selectGroups`' tree, whose
 * counts this adds to.
 */
export function placeGroupChats(state: Pick<ViewState, "groups" | "nodes">, groups: SessionGroup[]): { placed: Map<string, Group[]>; loose: Group[] } {
  const placed = new Map<string, Group[]>();
  const loose: Group[] = [];
  const chats = [...state.groups.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const chat of chats) {
    const home = chat.home;
    const path = home ? groupPathTo(groups, home.node, placeKey(home.path, state.nodes.get(home.node)?.platform)) : [];
    const at = path.at(-1);
    if (!at) {
      loose.push(chat);
      continue;
    }
    const list = placed.get(at.key) ?? [];
    list.push(chat);
    placed.set(at.key, list);
    for (const g of path) g.count += 1;
  }
  return { placed, loose };
}

/** The folder groups from the outermost to the innermost that hold folder `key` on `node`. */
function groupPathTo(level: SessionGroup[], node: string, key: string): SessionGroup[] {
  for (const g of level) {
    const cut = g.key.indexOf("\n");
    const gNode = g.key.slice(0, cut);
    const gKey = g.key.slice(cut + 1);
    if (gNode !== node || (key !== gKey && !key.startsWith(gKey + "/"))) continue;
    return [g, ...groupPathTo(g.groups, node, key)];
  }
  return [];
}

/** Who wrote a post, as its head says it: an agent's handle with its harness, a person's login, or cophyla. */
export interface PostWriter {
  kind: GroupPostFrom["kind"];
  name: string;
  harness?: string;
  title: string;
}

export function postWriter(from: GroupPostFrom): PostWriter {
  if (from.kind === "cophyla") return { kind: "cophyla", name: "cophyla", title: "Cophyla, saying who joined or left" };
  if (from.kind === "person") return { kind: "person", name: from.user, title: `${from.user}, a person` };
  const harness = HARNESS_NAMES[from.harness as keyof typeof HARNESS_NAMES] ?? from.harness;
  return { kind: "agent", name: from.handle, harness: from.harness, title: `${from.handle}: ${harness}${from.user ? `, ${from.user}'s` : ""}` };
}

/** A tag in a post: the words as written, and whether it names this side's user (themselves, every person, or everyone). */
export interface PostTag {
  label: string;
  own: boolean;
}

/** What a group's posts may tag, lowercased, longest first, each with whether it names this side's user. */
function tagLabels(g: Pick<Group, "members">): [string, boolean][] {
  const me = groupMe(g)?.user;
  const labels = new Map<string, boolean>();
  for (const m of g.members) {
    if (m.kind === "agent") labels.set(m.handle.toLowerCase(), labels.get(m.handle.toLowerCase()) ?? false);
    else labels.set(m.user.toLowerCase(), m.user === me);
  }
  labels.set("agents", false);
  labels.set("users", true);
  labels.set("everyone", true);
  return [...labels.entries()].sort((a, b) => b[0].length - a[0].length);
}

/** A tag goes on past `len` characters: a handle's next character, not the punctuation after it. */
const continues = (rest: string, len: number): boolean => /^(?:[\w/-]|\.\w)/.test(rest.slice(len));

/**
 * A post's text with each tag in it a slot (`slot(i)`), outside code: an `@` not after a word,
 * then a member's handle or login, or agents, users or everyone, the longest that fits; and the
 * tags in their order, each with the words as written and whether it is this side's user's.
 */
export function tagSlots(text: string, g: Pick<Group, "members">): { text: string; tags: PostTag[] } {
  const labels = tagLabels(g);
  const tags: PostTag[] = [];
  // Odd parts are code: a fenced block, or a span in backticks.
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    let s = "";
    let at = 0;
    for (;;) {
      const tag = part.indexOf("@", at);
      if (tag < 0) return s + part.slice(at);
      s += part.slice(at, tag);
      const before = tag > 0 ? part[tag - 1]! : "";
      const rest = part.slice(tag + 1);
      const lower = rest.toLowerCase();
      const hit = /[\w@/.-]/.test(before) ? undefined : labels.find(([l]) => lower.startsWith(l) && !continues(rest, l.length));
      if (!hit) {
        s += "@";
        at = tag + 1;
        continue;
      }
      tags.push({ label: `@${rest.slice(0, hit[0].length)}`, own: hit[1] });
      s += slot(tags.length - 1);
      at = tag + 1 + hit[0].length;
    }
  });
  return { text: out.join(""), tags };
}

/** The agents a post tags that have not read it yet, by handle: its writer aside, and the ones gone. */
export function unreadBy(g: Pick<Group, "members">, post: Pick<GroupPost, "mentions" | "from" | "n">): string[] {
  const tagged = new Set<string>();
  let all = false;
  for (const m of post.mentions) {
    if ("member" in m) tagged.add(m.member);
    else if (m.all === "everyone" || m.all === "agents") all = true;
  }
  const writer = post.from.kind === "cophyla" ? undefined : post.from.key;
  return g.members.filter((m): m is AgentMember => m.kind === "agent" && !m.gone && m.key !== writer && (all || tagged.has(m.key)) && m.readTo < post.n).map((m) => m.handle);
}

/** A post as the group's pane draws it. */
export interface PostView {
  id: string;
  n: number;
  writer: PostWriter;
  at: number;
  /** Its text with the tags as slots, and the tags. */
  text: string;
  tags: PostTag[];
  /** The post it answers: who wrote it and how it starts, or that it is further back than what is loaded. */
  quote?: { name?: string; excerpt: string };
  /** It asked for a reply and none came yet. */
  awaiting: boolean;
  /** Its thumbs up: how many, who, and whether this side's user gave one. */
  acks: number;
  ackTitle: string;
  acked: boolean;
  /** The agents it tags that have not read it yet. */
  unreadBy: string[];
  /** This side's user wrote it. */
  mine: boolean;
  /** What it carries. */
  photos: GroupPhoto[];
  files: GroupFile[];
}

/** A text's first line without its markdown's bold and code marks, cut to `max` characters. */
export function postExcerpt(text: string, max = 120): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "").replace(/\*\*|__|`/g, "");
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function postView(g: Group, post: GroupPost, page: Pick<GroupPage, "posts"> | undefined): PostView {
  const me = groupMe(g)?.user;
  const { text, tags } = tagSlots(post.text, g);
  let quote: PostView["quote"];
  if (post.replyTo !== undefined) {
    const answered = page?.posts.find((p) => p.id === post.replyTo);
    quote = answered ? { name: postWriter(answered.from).name, excerpt: postExcerpt(answered.text) } : { excerpt: "an earlier post" };
  }
  return {
    id: post.id,
    n: post.n,
    writer: postWriter(post.from),
    at: post.at,
    text,
    tags,
    ...(quote ? { quote } : {}),
    awaiting: post.expectsReply === true && post.answered !== true,
    acks: post.acks.length,
    ackTitle: post.acks.length === 0 ? "Thumbs up" : `Thumbs up from ${post.acks.join(", ")}`,
    acked: me !== undefined && post.acks.includes(me),
    unreadBy: unreadBy(g, post),
    mine: post.from.kind === "person" && post.from.user === me && me !== undefined,
    photos: post.photos ?? [],
    files: post.files ?? [],
  };
}

/** The number of the last post loaded, when this side's user has not read up to it. */
export function readUpTo(g: Pick<Group, "members">, page: Pick<GroupPage, "posts"> | undefined): number | undefined {
  const last = page?.posts.at(-1)?.n;
  if (last === undefined) return undefined;
  const me = groupMe(g);
  return me === undefined || me.readTo < last ? last : undefined;
}

/** An hour of the day, as `HH:MM`. */
function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** An agent's focus in words: until when, and why. */
export function focusWords(f: Pick<Focus, "until" | "reason">): string {
  return `Focus until ${hhmm(f.until)} — ${f.reason}`;
}

/** A session's focus while it holds: none once its hour has passed, whatever the node said last. */
export function sessionFocus(state: Pick<ViewState, "focus">, session: string, now: number): Focus | undefined {
  const f = state.focus.get(session);
  return f && f.until > now ? f : undefined;
}

/** A member as the group's head shows it: a chip with what it is doing, and what may be done with it. */
export interface MemberChip {
  key: string;
  kind: "agent" | "person";
  name: string;
  harness?: string;
  /** An agent's: working, idle, its session ended, or not known here (a teammate's); a person's own. */
  status: "busy" | "idle" | "gone" | "unknown" | "person";
  focus?: string;
  held: boolean;
  unread: number;
  /** One of this side's user's agents: how it is told is set here. */
  mine: boolean;
  notify?: GroupNotify;
  /** This side's user. */
  me: boolean;
  /** Remove is offered: on one's own agents, and on any agent for the group's maker, while the group runs. */
  removable: boolean;
  title: string;
}

export function memberChips(state: Pick<ViewState, "sessions" | "focus">, g: Group, now: number): MemberChip[] {
  const maker = groupMaker(g);
  const open = g.ended === undefined;
  return g.members.map((m): MemberChip => {
    if (m.kind === "person") {
      return { key: m.key, kind: "person", name: m.user, status: "person", held: false, unread: 0, mine: false, me: m.me === true, removable: false, title: m.me ? `${m.user}, you` : `${m.user}, a person` };
    }
    const own = state.sessions.get(m.session)?.session;
    const status: MemberChip["status"] = m.gone ? "gone" : own ? (own.status === "ended" ? "gone" : own.status === "idle" ? "idle" : "busy") : "unknown";
    const f = m.focus && m.focus.until > now ? m.focus : sessionFocus(state, m.session, now);
    const harness = HARNESS_NAMES[m.harness as keyof typeof HARNESS_NAMES] ?? m.harness;
    const statusWord = status === "gone" ? "its session ended" : status === "busy" ? "working" : status === "idle" ? "idle" : "";
    const title = [
      `${m.handle}: ${harness}${m.user && !m.mine ? `, ${m.user}'s` : ""}${m.workspace ? ` in ${m.workspace}` : ""}`,
      statusWord,
      f ? focusWords(f) : "",
      m.held ? "its notices wait in its terminal until it lets messages in" : "",
      m.unread > 0 ? `${m.unread} unread` : "",
      m.mine ? (m.notify === "all" ? "told of every post" : "told of the posts that tag it") : "",
    ].filter((w) => w !== "");
    return {
      key: m.key,
      kind: "agent",
      name: m.handle,
      harness: m.harness,
      status,
      ...(f ? { focus: focusWords(f) } : {}),
      held: m.held === true,
      unread: m.unread,
      mine: m.mine === true,
      notify: m.notify,
      me: false,
      removable: open && !m.gone && (m.mine === true || maker),
      title: title.join("\n"),
    };
  });
}

/**
 * What the composer offers for the `@` just typed before the caret: the agents' handles, the
 * other people's logins, then agents, users and everyone, those that start with what follows
 * the `@`, at most eight. None once what is typed is the one it would offer.
 */
export function tagCompletion(g: Pick<Group, "members">, text: string, caret: number): { start: number; options: string[] } | undefined {
  const m = /(^|[^\w@/.-])@([\w./-]*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  const typed = m[2]!;
  const query = typed.toLowerCase();
  const me = groupMe(g)?.user;
  const names = [
    ...g.members.filter((x): x is AgentMember => x.kind === "agent" && !x.gone).map((x) => x.handle),
    ...g.members.filter((x): x is PersonMember => x.kind === "person" && x.user !== me).map((x) => x.user),
    "agents",
    "users",
    "everyone",
  ];
  const options = [...new Set(names)].filter((n) => n.toLowerCase().startsWith(query)).slice(0, 8);
  if (options.length === 0 || (options.length === 1 && options[0]!.toLowerCase() === query)) return undefined;
  return { start: caret - typed.length - 1, options };
}

/** The text with the tag being typed (from `start` to the caret) completed to `choice`, a space after it, and where the caret goes. */
export function completeTag(text: string, start: number, caret: number, choice: string): { text: string; caret: number } {
  const tag = `@${choice} `;
  return { text: text.slice(0, start) + tag + text.slice(caret), caret: start + tag.length };
}

/** What a picker keeps an agent by: its own session, a teammate's agent by name, or the teammate by themselves. */
export function candidateKey(ref: GroupMemberRef): string {
  return "session" in ref ? `s:${ref.session}` : "name" in ref ? `t:${ref.teammate}:${ref.name}` : `p:${ref.teammate}`;
}

/** An agent in the picker, or a teammate by themselves (`person`), and its heading: the user's own by machine and folder, a teammate's under their login. */
export interface CandidateItem {
  key: string;
  ref: GroupMemberRef;
  handle: string;
  harness?: string;
  person?: boolean;
  words: string;
}

export interface CandidateGroup {
  key: string;
  title: string;
  own: boolean;
  /** Why a teammate's heading cannot be picked from now: they are not a teammate of someone in the group or picked. */
  blocked?: string;
  items: CandidateItem[];
}

/**
 * The picker's agents under their headings, the user's own first, and each teammate first by
 * themselves; one already in `g` is left out, by its session: a teammate's agent renamed since
 * it was put in is the same agent. A node from before teammates' sessions came with them is
 * matched by handle. Everyone in a group is a teammate of everyone else, so a teammate who is
 * not a teammate of someone in `g`, or of a teammate with something `picked`, is blocked, saying
 * who; one whose side could not say (no `peers`) only joins a group of the user's and theirs.
 */
export function candidateGroups(cands: GroupCandidate[], g?: Pick<Group, "members">, picked: Iterable<string> = []): CandidateGroup[] {
  const sessions = new Set<string>();
  const handles = new Set<string>();
  const people = new Set<string>();
  for (const m of g?.members ?? []) {
    if (m.kind === "person") {
      if (!m.me) people.add(m.user);
      continue;
    }
    sessions.add(m.session);
    if (!m.gone) handles.add(m.handle);
  }
  const inGroup = new Set(people);
  const chosen = new Set(picked);
  for (const c of cands) if (!("session" in c.ref) && c.user && chosen.has(candidateKey(c.ref))) people.add(c.user);
  const groups = new Map<string, CandidateGroup>();
  for (const c of cands) {
    const own = "session" in c.ref;
    const session = "session" in c.ref ? c.ref.session : c.session;
    if (c.person ? c.user !== undefined && inGroup.has(c.user) : session !== undefined ? sessions.has(session) : handles.has(c.handle)) continue;
    const folder = c.folder ?? c.workspace;
    const key = own ? `own:${c.node ?? ""}\n${folder ?? ""}` : `user:${c.user ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, own, title: own ? `${folder ?? "No folder"}${c.machine ? ` · ${c.machine}` : ""}` : `${c.user ?? "A teammate"} and their agents`, items: [] };
      if (!own) {
        const missing = [...people].filter((u) => u !== c.user && !(c.peers ?? []).includes(u));
        if (missing.length > 0) group.blocked = c.peers === undefined ? `${c.user ?? "They"} can join a group with ${wordList(missing)} once their Cophyla is updated.` : `${c.user ?? "They"} is not a teammate of ${wordList(missing)}, and everyone in a group is a teammate of everyone else.`;
      }
      groups.set(key, group);
    }
    const harness = c.harness ? (HARNESS_NAMES[c.harness as keyof typeof HARNESS_NAMES] ?? c.harness) : undefined;
    const words = c.person ? "Just them, without an agent" : [harness, c.status, own ? undefined : c.workspace, c.intent].filter((w): w is string => w !== undefined && w !== "").join(" · ");
    const item: CandidateItem = { key: candidateKey(c.ref), ref: c.ref, handle: c.handle, ...(c.harness ? { harness: c.harness } : {}), ...(c.person ? { person: true } : {}), words };
    if (c.person) group.items.unshift(item);
    else group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => Number(b.own) - Number(a.own) || a.title.localeCompare(b.title));
}

/**
 * What End asks before a teammate is ended: their agents leave every group, and since everyone
 * in a group is a teammate of everyone else, they leave the groups with someone else in them too,
 * for everyone in them, whoever made them, and the user stays.
 */
export function teamEndWords(who: string, groups: Iterable<Pick<Group, "name" | "members">>): string {
  const leave: string[] = [];
  for (const g of groups) {
    const people = g.members.filter((m) => m.kind === "person");
    if (!groupMe(g) || people.length < 3 || !people.some((m) => !m.me && m.user === who)) continue;
    leave.push(`#${g.name}`);
  }
  const words = [`End ${who} as a teammate? Their agents leave every group, and nothing reaches either side any more.`];
  if (leave.length > 0) words.push(`${who} leaves ${wordList(leave)} too, for everyone in ${leave.length === 1 ? "it" : "them"}, since everyone in a group is a teammate of everyone else.`);
  return words.join(" ");
}

/** Names as words: a, a and b, a, b and c. */
function wordList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What `group.create` is sent from New group's form, or why it is not: a group needs a name. */
export function groupCreateParams(
  form: { name: string; purpose: string; notify: GroupNotify; picked: Iterable<string> },
  cands: GroupCandidate[],
): { params: { name: string; purpose?: string; notify: GroupNotify; members: GroupMemberRef[] } } | { error: string } {
  const name = form.name.trim();
  if (name === "") return { error: "Name the group." };
  const picked = new Set(form.picked);
  const members = cands.filter((c) => picked.has(candidateKey(c.ref))).map((c) => c.ref);
  if (members.length > 32) return { error: "A group takes at most 32 agents at a time." };
  const purpose = form.purpose.trim();
  return { params: { name, ...(purpose ? { purpose } : {}), notify: form.notify, members } };
}

/**
 * A group or teammate request that failed, in words the user can act on: an app built before
 * them refuses the request itself ("unknown method"), and a daemon from before them answers
 * `unsupported` too; both mean updating, as with connections.
 */
export function teamworkFailure(code: string | undefined, message: string): string {
  if (code === "unsupported" && /^unknown method group\.(upload|photo|file\.save)/.test(message)) return "This Cophyla app is older than photos and files in group chats: update it, or open it again after an update, then try again.";
  if (code === "unsupported" && /group\.(upload|photo|file\.save)/.test(message)) return "Cophyla on this computer is older than photos and files in group chats: update it, then try again.";
  if (code === "unsupported" && /^unknown method (group|focus|teammate)\./.test(message)) return "This Cophyla app is older than group chats and teammates: update it, or open it again after an update, then try again.";
  if (code === "unsupported" && /(group|focus|teammate)\./.test(message)) return "Cophyla on this computer is older than group chats and teammates: update it, then try again.";
  return message;
}

/** Why this view makes no teammate, when it does not: one that may not manage devices, or a node signed out of its account. */
export function teamBlock(state: Pick<ViewState, "scopes" | "account">): string | undefined {
  if (!state.scopes.includes("controllers")) return "This device may not manage teammates.";
  if (state.account?.subject === undefined) return "Teammates need a Cophyla account: sign in under Devices → Account, then invite someone or enter their code.";
  return undefined;
}

/** Whether `inner` is `outer` or inside it, on one machine, as that machine compares paths. */
export function samePlaceOrUnder(inner: TeammatePlace, outer: TeammatePlace, platform?: Platform): boolean {
  if (inner.node !== outer.node) return false;
  const i = placeKey(inner.path, platform);
  const o = placeKey(outer.path, platform);
  return i === o || i.startsWith(o + "/");
}

/** Two places as one machine compares them. */
export function sameFolder(a: TeammatePlace, b: TeammatePlace, platform?: Platform): boolean {
  return a.node === b.node && placeKey(a.path, platform) === placeKey(b.path, platform);
}

/** A shared folder by name: its workspace's, else its last part; with its machine's where there are several. */
export function placeName(state: Pick<ViewState, "workspaces" | "nodes" | "node">, place: TeammatePlace): string {
  const platform = state.nodes.get(place.node)?.platform;
  let name: string | undefined;
  for (const w of state.workspaces.values()) if (sameFolder(w, place, platform)) name = w.name;
  name ??= lastPart(place.path);
  return state.nodes.size > 1 ? `${name} on ${machineName(state as ViewState, place.node)}` : name;
}

/** What one side shares, in words: which folders, how open, and how many wait shared closed. */
export function teamShareWords(state: Pick<ViewState, "workspaces" | "nodes" | "node">, share: TeammateShare): string {
  const names = share.folders.map((f) => placeName(state, f));
  const what =
    share.mode === "include" ? (names.length === 0 ? "nothing yet" : `${names.join(", ")}, and every folder under them`) : names.length === 0 ? "every workspace" : `every workspace but ${names.join(", ")}`;
  const closed = share.closed?.length ?? 0;
  return [what, share.open === "always" ? "always open" : "opened by hand", closed > 0 ? `${closed} shared closed` : ""].filter((w) => w !== "").join(" · ");
}

/** How long a code holds, in words: hours while there are some, then minutes. */
export function holdWords(until: number, now: number): { words: string; expired: boolean } {
  const left = until - now;
  if (left <= 0) return { words: "ran out", expired: true };
  const minutes = Math.ceil(left / 60_000);
  return { words: minutes >= 60 ? `${Math.floor(minutes / 60)} h left` : `${minutes} min left`, expired: false };
}

/** A teammate as the Teammates page shows it. */
export interface TeammateRow {
  id: string;
  state: "pending" | "active";
  who: string;
  /** What this side shares with them. */
  share: string;
  /** What they share with this side, once they said. */
  theirs?: string;
  words: string;
  expired: boolean;
}

/** The teammates: the active ones by login, then the codes not used yet, newest first. */
export function selectTeammates(state: Pick<ViewState, "teammates" | "workspaces" | "nodes" | "node">, now: number): TeammateRow[] {
  const all = [...state.teammates.values()].filter((t) => t.state !== "ended");
  const active = all.filter((t) => t.state === "active").sort((a, b) => (a.user ?? "").localeCompare(b.user ?? "") || (a.id < b.id ? -1 : 1));
  const pending = all.filter((t) => t.state === "pending").sort((a, b) => b.createdAt - a.createdAt);
  return [...active, ...pending].map((t): TeammateRow => {
    if (t.state === "pending") {
      const hold = t.expiresAt !== undefined ? holdWords(t.expiresAt, now) : { words: "", expired: false };
      return { id: t.id, state: "pending", who: "A code not used yet", share: teamShareWords(state, t.share), words: hold.expired ? "the code ran out" : hold.words ? `the code holds, ${hold.words}` : "", expired: hold.expired };
    }
    const theirs = t.theirs ? `${t.theirs.workspaces.length === 0 ? "nothing yet" : t.theirs.workspaces.join(", ")} · ${t.theirs.open === "always" ? "always open" : "opened by hand"}` : undefined;
    const words = [`${t.sent} sent, ${t.received} received`, t.queued ? `${t.queued} waiting` : ""].filter((w) => w !== "").join(" · ");
    return { id: t.id, state: "active", who: t.user ?? "A teammate", share: teamShareWords(state, t.share), ...(theirs !== undefined ? { theirs } : {}), words, expired: false };
  });
}

/** A workspace shared closed with a teammate: one that appeared after an exclude share, which their agents see none of until the user opens or excludes it. */
export interface ClosedPlace {
  key: string;
  teammate: string;
  login: string;
  place: TeammatePlace;
  words: string;
}

export function closedPlaces(state: Pick<ViewState, "teammates" | "workspaces" | "nodes" | "node">): ClosedPlace[] {
  const out: ClosedPlace[] = [];
  for (const t of state.teammates.values()) {
    if (t.state !== "active") continue;
    const login = t.user ?? "a teammate";
    for (const place of t.share.closed ?? []) out.push({ key: `${t.id}\n${place.node}\n${place.path}`, teammate: t.id, login, place, words: `${placeName(state, place)} is shared closed with ${login}` });
  }
  return out.sort((a, b) => a.words.localeCompare(b.words));
}

/** A share with `place` open: off the closed list. */
export function openPlace(share: TeammateShare, place: TeammatePlace, platform?: Platform): TeammateShare {
  return { ...share, closed: (share.closed ?? []).filter((p) => !sameFolder(p, place, platform)) };
}

/** A share with `place` excluded: among the folders an exclude share names, and off the closed list. */
export function excludePlace(share: TeammateShare, place: TeammatePlace, platform?: Platform): TeammateShare {
  const folders = share.folders.some((f) => sameFolder(f, place, platform)) ? share.folders : [...share.folders, place];
  return { ...share, mode: "exclude", folders, closed: (share.closed ?? []).filter((p) => !sameFolder(p, place, platform)) };
}

/** Whether a folder is in what a share shares at all: under one it names, or under none it excludes. */
export function inShare(share: TeammateShare, folder: TeammatePlace, platform?: Platform): boolean {
  const named = share.folders.some((f) => samePlaceOrUnder(folder, f, platform));
  return share.mode === "include" ? named : !named;
}

// --- a session's Connect panel ------------------------------------------------------------------

/** A teammate's agents as the Connect panel last had them (`teammate.agents`): when they came, while asked, and why they could not be had. */
export interface TeamAgentsSeen {
  at?: number;
  agents: TeamAgent[];
  closed: TeamClosedAgent[];
  loading?: boolean;
  error?: string;
}

/** The folder a session works in: its workspace's, else its own. */
export function sessionFolder(state: Pick<ViewState, "workspaces">, s: Pick<Session, "node" | "cwd" | "workspace">): { place: TeammatePlace; name: string } {
  const w = s.workspace ? state.workspaces.get(s.workspace) : undefined;
  const path = w?.path ?? s.cwd;
  return { place: { node: s.node, path }, name: w?.name ?? folderName(path) };
}

/** How a session stands with one teammate, in words: the first ones said strongly, what changes it named by `kind`. */
export interface ConnectStanding {
  /**
   * `outside`: its folder is in nothing this side shares with them (Share it…); `shared-closed`:
   * in a workspace shared closed (Open | Exclude); `always`: open with the rest (nothing to
   * press); `opened`: opened by hand (Close); `closed`: shared but closed (Open to all).
   */
  kind: "outside" | "shared-closed" | "always" | "opened" | "closed";
  lead: string;
  rest: string;
  /** The button's words, when there is one to press besides Open | Exclude. */
  label?: string;
  /** `shared-closed`: the Status line's key, which Open and Exclude act on. */
  placeKey?: string;
}

export function connectStanding(state: Pick<ViewState, "workspaces" | "nodes">, t: Teammate, s: Pick<Session, "id" | "node" | "cwd" | "workspace">): ConnectStanding {
  const login = t.user ?? "them";
  const { place, name } = sessionFolder(state, s);
  const platform = state.nodes.get(s.node)?.platform;
  const opened = t.share.opened?.includes(s.id) === true;
  if (!inShare(t.share, place, platform)) return { kind: "outside", lead: `Not shared with ${login}.`, rest: `This agent works in ${name}, which you don't share with them.`, label: `Share ${name} with ${login}…` };
  if (opened) return { kind: "opened", lead: `Open to ${login}.`, rest: "All their agents can message this one.", label: "Close" };
  const closedAt = (t.share.closed ?? []).find((p) => samePlaceOrUnder(place, p, platform));
  if (closedAt) return { kind: "shared-closed", lead: `${name} is shared closed with ${login}.`, rest: "Their agents reach none of yours in it until you open it or exclude it.", placeKey: `${t.id}\n${closedAt.node}\n${closedAt.path}` };
  if (t.share.open === "always") return { kind: "always", lead: `Open to ${login}.`, rest: `You share every agent in ${name} with them.` };
  return { kind: "closed", lead: `Closed to ${login}.`, rest: "Only the agents you connect can message this one.", label: `Open to all of ${login}'s agents` };
}

/** One of a teammate's agents in the Connect panel: what it is, and what pressing its row does or how it stands with this agent. */
export interface ConnectAgentRow {
  key: string;
  /** Its session on their side, which Connect names it by; an open one from a Cophyla too old to say has none. */
  session?: string;
  name: string;
  /** "Claude · api" */
  meta: string;
  /** The dot: how it stands, or `closed`. */
  tone: "busy" | "idle" | "waiting" | "closed" | "unknown";
  /** "working", "idle", "closed: bob decides"… */
  doing: string;
  intent?: string;
  open: boolean;
  /** `connect` or `ask` to press; or how it stands with this agent already. */
  action?: { kind: "connect" | "ask"; label: string } | { kind: "state"; words: string; tone: "ok" | "wait" | "no" };
}

function statusDoing(status: SessionStatus | undefined): { tone: ConnectAgentRow["tone"]; doing: string } {
  if (status === "busy") return { tone: "busy", doing: "working" };
  if (status === "idle") return { tone: "idle", doing: "idle" };
  if (status === "needs_permission" || status === "needs_input") return { tone: "waiting", doing: "waiting on its user" };
  if (status === "ended") return { tone: "unknown", doing: "ended" };
  return { tone: "unknown", doing: "" };
}

/** The teammate connection between a session of this side's and one of theirs, if any. */
export function connectionBetween(t: Pick<Teammate, "connections">, session: string, agent: string): TeammateConnection | undefined {
  return (t.connections ?? []).find((c) => c.session === session && c.agent.session === agent);
}

/** A teammate's agents as rows for one session of this side's: the open ones, then the closed ones, each by name; `filter` keeps those whose name, harness or workspace holds it. */
export function connectAgentRows(t: Teammate, s: Pick<Session, "id">, seen: Pick<TeamAgentsSeen, "agents" | "closed">, filter = ""): ConnectAgentRow[] {
  const login = t.user ?? "them";
  const rows: ConnectAgentRow[] = [];
  const action = (agent: string | undefined, open: boolean): ConnectAgentRow["action"] => {
    const c = agent ? connectionBetween(t, s.id, agent) : undefined;
    if (c?.state === "active") return { kind: "state", words: "Connected", tone: "ok" };
    if (c?.state === "asked") return { kind: "state", words: c.by === "us" ? "Asked" : "Asks you", tone: "wait" };
    if (c?.state === "declined") return { kind: "state", words: "Declined", tone: "no" };
    if (!agent) return undefined;
    return open ? { kind: "connect", label: "Connect" } : { kind: "ask", label: `Ask ${login}` };
  };
  const withAction = (act: ConnectAgentRow["action"]): Pick<ConnectAgentRow, "action"> => (act ? { action: act } : {});
  const meta = (harness?: string, workspace?: string) => [harness ? (HARNESS_NAMES[harness as keyof typeof HARNESS_NAMES] ?? harness) : "", workspace ?? ""].filter(Boolean).join(" · ");
  const seenSessions = new Set<string>();
  for (const a of [...seen.agents].sort((x, y) => x.name.localeCompare(y.name))) {
    const st = statusDoing(a.status);
    if (a.session) seenSessions.add(a.session);
    rows.push({
      key: a.session ?? `name:${a.name}`,
      ...(a.session ? { session: a.session } : {}),
      name: a.name,
      meta: meta(a.harness, a.workspace),
      tone: st.tone,
      doing: a.focus ? "in focus" : st.doing,
      ...(a.intent ? { intent: a.intent } : {}),
      open: true,
      ...withAction(action(a.session, true)),
    });
  }
  for (const a of [...seen.closed].sort((x, y) => x.name.localeCompare(y.name))) {
    if (seenSessions.has(a.session)) continue;
    const st = statusDoing(a.status);
    const known = a.connected === true && a.status !== undefined;
    rows.push({
      key: a.session,
      session: a.session,
      name: a.name,
      meta: meta(a.harness, a.workspace),
      tone: known ? st.tone : "closed",
      doing: known ? st.doing : `closed: ${login} decides`,
      ...(a.connected && a.intent ? { intent: a.intent } : {}),
      open: false,
      ...withAction(action(a.session, false)),
    });
  }
  const f = filter.trim().toLowerCase();
  return f === "" ? rows : rows.filter((r) => `${r.name} ${r.meta}`.toLowerCase().includes(f));
}

/** A row under Connected: a connection made with a code, or a teammate connection, with what may be pressed on it. */
export type ConnectedRow =
  | { kind: "code"; id: string; who: string; words: string }
  | {
      kind: "teammate";
      id: string;
      teammate: string;
      state: TeammateConnection["state"];
      by: TeammateConnection["by"];
      who: string;
      words: string;
      /** For a yes on an ask the teammate made: the two agents. */
      session: string;
      agent: string;
      buttons: ("end" | "cancel" | "connect" | "decline" | "dismiss")[];
    };

/** What a session is joined to, and what waits: its code connections, then its teammate connections, the live ones first. */
export function connectedRows(state: Pick<ViewState, "connections" | "teammates">, s: Pick<Session, "id">): ConnectedRow[] {
  const out: ConnectedRow[] = [];
  for (const c of state.connections.values()) {
    if (c.state !== "active" || c.session !== s.id || !c.peer) continue;
    const agent = c.peer.live === false ? "no agent in their terminal now" : c.peer.harness ? HARNESS_NAMES[c.peer.harness] : "";
    out.push({ kind: "code", id: c.id, who: `${c.peer.user}/${c.peer.name}`, words: [agent, "connected with a code"].filter(Boolean).join(" · ") });
  }
  const order = { active: 0, asked: 1, declined: 2 } as const;
  const teams: Extract<ConnectedRow, { kind: "teammate" }>[] = [];
  for (const t of state.teammates.values()) {
    if (t.state !== "active") continue;
    const login = t.user ?? "a teammate";
    for (const c of t.connections ?? []) {
      if (c.session !== s.id) continue;
      const theirs = `${login}/${c.agent.name}`;
      const where = [c.agent.harness ? HARNESS_NAMES[c.agent.harness] : "", c.agent.workspace ?? ""].filter(Boolean).join(" · ");
      const base = { kind: "teammate" as const, id: c.id, teammate: t.id, state: c.state, by: c.by, session: c.session, agent: c.agent.session };
      if (c.state === "active") teams.push({ ...base, who: theirs, words: [where, "connected both ways"].filter(Boolean).join(" · "), buttons: ["end"] });
      else if (c.state === "asked" && c.by === "us") teams.push({ ...base, who: theirs, words: `asked ${login} · waiting for their answer`, buttons: ["cancel"] });
      else if (c.state === "asked") teams.push({ ...base, who: theirs, words: `${login} asks to connect their agent ${c.agent.name} to this one${where ? ` (${where})` : ""}`, buttons: ["connect", "decline"] });
      else teams.push({ ...base, who: theirs, words: c.by === "us" ? `${login} declined${c.reason && !/declined$/.test(c.reason) ? `: ${c.reason}` : ""}` : `you declined ${login}'s ask`, buttons: ["dismiss"] });
    }
  }
  teams.sort((a, b) => order[a.state] - order[b.state] || a.who.localeCompare(b.who));
  return [...out, ...teams];
}

/** The names a session's head pill gives: its code connections' and its live teammate connections'. */
export function sessionLinks(state: Pick<ViewState, "connections" | "teammates">, session: string): string[] {
  const names = sessionConnections(state, session);
  for (const t of state.teammates.values()) {
    if (t.state !== "active") continue;
    for (const c of t.connections ?? []) if (c.session === session && c.state === "active") names.push(`${t.user ?? "teammate"}/${c.agent.name}`);
  }
  return names;
}

/** A teammate's block in the Connect panel: who, what they share, how this agent stands with them, and their agents when it may reach any. */
export interface ConnectTeamBlock {
  teammate: string;
  login: string;
  theirs: string;
  standing: ConnectStanding;
  /** Their agents, when this agent is in what this side shares; with why there are none, or are not here yet. */
  agents?: { rows: ConnectAgentRow[]; total: number; words?: string; filter: boolean };
}

/** Past this many agents, a teammate's block has a filter. */
export const CONNECT_FILTER_AT = 8;

/** The active teammates, by login, each as its block for session `s`. */
export function connectTeamBlocks(state: Pick<ViewState, "teammates" | "workspaces" | "nodes">, s: Pick<Session, "id" | "node" | "cwd" | "workspace">, seen: ReadonlyMap<string, TeamAgentsSeen>, filters: ReadonlyMap<string, string> = new Map()): ConnectTeamBlock[] {
  const active = [...state.teammates.values()].filter((t) => t.state === "active" && t.user).sort((a, b) => a.user!.localeCompare(b.user!));
  return active.map((t) => {
    const login = t.user!;
    const theirs = t.theirs
      ? [t.theirs.workspaces.length === 0 ? "shares nothing yet" : `shares ${t.theirs.workspaces.slice(0, 4).join(", ")}${t.theirs.workspaces.length > 4 ? ` +${t.theirs.workspaces.length - 4}` : ""}`, t.theirs.open === "always" ? "every agent open" : "opens agents by hand"].join(" · ")
      : "";
    const standing = connectStanding(state, t, s);
    const block: ConnectTeamBlock = { teammate: t.id, login, theirs, standing };
    if (standing.kind === "outside") return block;
    const got = seen.get(t.id);
    const all = got ? connectAgentRows(t, s, got) : [];
    const rows = got ? connectAgentRows(t, s, got, filters.get(t.id) ?? "") : [];
    const words =
      got === undefined || (got.loading && got.at === undefined)
        ? `Asking ${login}'s Cophyla…`
        : got.error !== undefined && got.at === undefined
          ? got.error
          : all.length === 0
            ? `None of ${login}'s agents is in what they share now.`
            : rows.length === 0
              ? "None matches."
              : undefined;
    block.agents = { rows, total: all.length, ...(words !== undefined ? { words } : {}), filter: all.length > CONNECT_FILTER_AT };
    return block;
  });
}

/** Why a Connect panel has no teammate to offer: none yet, or no account; undefined while there are. */
export function connectNoTeam(state: Pick<ViewState, "teammates" | "account">): string | undefined {
  if ([...state.teammates.values()].some((t) => t.state === "active" && t.user)) return undefined;
  if (state.account?.subject === undefined) return "Teammates need a Cophyla account.";
  return "Teammates connect agents without a code.";
}

/** Whether Someone else (a code) is folded to its heading: while the user has a teammate, unless they opened it or a code or its error shows. */
export function connectElseFolded(state: Pick<ViewState, "teammates">, open: Pick<HeadConnect, "others" | "made" | "error">): boolean {
  if (open.others === true || open.made !== undefined || open.error !== undefined) return false;
  return [...state.teammates.values()].some((t) => t.state === "active" && t.user);
}

/** A teammate's connections as the Teammates page lists them under the teammate: which agent of this side's, joined to which of theirs, and what may be pressed. */
export interface TeamConnectionRow {
  id: string;
  teammate: string;
  words: string;
  state: TeammateConnection["state"];
  session: string;
  agent: string;
  buttons: ("end" | "cancel" | "connect" | "decline" | "dismiss")[];
}

export function teamConnectionRows(state: Pick<ViewState, "teammates" | "sessions">, teammate: string): TeamConnectionRow[] {
  const t = state.teammates.get(teammate);
  if (!t || t.state !== "active") return [];
  const login = t.user ?? "them";
  const mine = (session: string) => {
    const card = state.sessions.get(session);
    return card ? sessionLabel(card.session) : "an agent of yours";
  };
  const order = { active: 0, asked: 1, declined: 2 } as const;
  return [...(t.connections ?? [])]
    .sort((a, b) => order[a.state] - order[b.state] || a.createdAt - b.createdAt)
    .map((c): TeamConnectionRow => {
      const pair = `${mine(c.session)} ⇄ ${login}/${c.agent.name}`;
      const base = { id: c.id, teammate: t.id, state: c.state, session: c.session, agent: c.agent.session };
      if (c.state === "active") return { ...base, words: pair, buttons: ["end"] };
      if (c.state === "asked" && c.by === "us") return { ...base, words: `${pair} · asked, waiting for ${login}`, buttons: ["cancel"] };
      if (c.state === "asked") return { ...base, words: `${pair} · ${login} asks you`, buttons: ["connect", "decline"] };
      return { ...base, words: `${pair} · ${c.by === "us" ? `${login} declined` : "you declined"}`, buttons: ["dismiss"] };
    });
}

/**
 * The share a form makes: the folders picked, each once, how open; a share being changed keeps
 * the agents opened by hand, and (excluding) the closed folders it does not now exclude.
 */
export function buildShare(mode: TeammateShare["mode"], picked: TeammatePlace[], open: TeammateShare["open"], keep?: TeammateShare): TeammateShare {
  const folders: TeammatePlace[] = [];
  for (const p of picked) if (!folders.some((f) => sameFolder(f, p))) folders.push({ node: p.node, path: p.path });
  const share: TeammateShare = { mode, folders, open };
  if (keep?.opened && keep.opened.length > 0) share.opened = keep.opened;
  if (mode === "exclude" && keep?.closed) {
    const closed = keep.closed.filter((c) => !folders.some((f) => sameFolder(f, c)));
    if (closed.length > 0) share.closed = closed;
  }
  return share;
}

/** A folder that holds a whole machine's projects: its home folder, or a drive's root. */
export interface BroadPlace {
  node: string;
  path: string;
  kind: "home" | "root";
}

/** The usual home folders, as `placeKey` writes them: `C:/Users/<name>`, `/home/<name>`, `/Users/<name>`, `/root`. */
const USUAL_HOME = /^(?:[a-z]:\/users\/[^/]+|\/home\/[^/]+|\/users\/[^/]+|\/root)$/i;

/**
 * The folders an Include share names that open every project on a machine: its home folder or
 * a drive's root (`C:\`, `/`), asked about before the share is sent. A machine's home and roots
 * are known from its folder listing (`homes`, as New terminal's picker lists them); without
 * one, the usual homes are taken for it. An Exclude share names what is kept back, so none.
 */
export function broadShares(share: Pick<TeammateShare, "mode" | "folders">, homes: ReadonlyMap<string, { home: string; roots?: string[] }>, platformOf: (node: string) => Platform | undefined = () => undefined): BroadPlace[] {
  if (share.mode !== "include") return [];
  const out: BroadPlace[] = [];
  for (const f of share.folders) {
    const platform = platformOf(f.node);
    const key = placeKey(f.path, platform);
    const known = homes.get(f.node);
    const root = key === "" || /^[a-z]:$/i.test(key) || (known?.roots ?? []).some((r) => placeKey(r, platform) === key);
    const home = known ? placeKey(known.home, platform) === key : USUAL_HOME.test(key);
    if (root) out.push({ node: f.node, path: f.path, kind: "root" });
    else if (home) out.push({ node: f.node, path: f.path, kind: "home" });
  }
  return out;
}

/** The question a broad share asks before it is sent, naming whom it is shared with (`login`; whoever uses the code without one). */
export function broadWords(places: BroadPlace[], login: string | undefined, several = false, machine: (node: string) => string = () => ""): string {
  const who = login ?? "whoever uses the code";
  const on = (p: BroadPlace) => (several && machine(p.node) ? ` on ${machine(p.node)}` : "");
  const named = places.map((p) => (p.kind === "home" ? `your whole home folder${on(p)}` : `all of ${p.path}${on(p)}`));
  if (places.length === 1) return `Share ${named[0]} with ${who}? Every project ${places[0]!.kind === "home" ? "under" : "on"} it is open to them.`;
  return `Share ${named.slice(0, -1).join(", ")} and ${named.at(-1)} with ${who}? Every project under them is open to them.`;
}

// --- leaders -----------------------------------------------------------------------------------

/** The most sessions a leader's group names: the protocol's cap. */
export const LEAD_TARGETS_MAX = 64;

/** What Cophyla's own chat is called where it leads. */
const CHAT_NAME = "Cophyla";

/** Folds a leaders' action in; false when the action is none of them. */
function applyLead(state: ViewState, action: Action): boolean {
  switch (action.type) {
    case "leaders":
      state.leadOn = action.leaders !== undefined;
      state.leaders = new Map((action.leaders ?? []).map((l) => [l.speaker, l]));
      return true;
    case "lead.state":
      state.leadOn = true;
      state.leaders = new Map(action.params.leaders.map((l) => [l.speaker, l]));
      return true;
    case "leader":
      state.leaders.set(action.leader.speaker, action.leader);
      return true;
    case "leader.removed":
      state.leaders.delete(action.speaker);
      return true;
    default:
      return false;
  }
}

/** A machine that lends another person's folders as hands: its sessions neither lead nor are led. */
function lendsFolders(node: Node | undefined): boolean {
  return node?.hands === true && node.scope.kind === "workspaces";
}

/**
 * Whether a session may lead, or be in a leader's group: one of the user's own live agent
 * sessions, not the one the chat runs in, on a machine of theirs rather than one that lends
 * another person's folders.
 */
export function leadable(state: Pick<ViewState, "nodes">, s: Session): boolean {
  return s.status !== "ended" && s.role !== "assistant" && !lendsFolders(state.nodes.get(s.node));
}

/** Why a leader cannot type into a session: a Claude session read over its pipe, in no terminal Cophyla holds. */
export function untypeable(s: Pick<Session, "harness" | "native">): string | undefined {
  return s.harness === "claude" && s.native.transport === "pipe" && s.native.terminal === undefined ? "outside a Cophyla terminal: Reopen it here to include it" : undefined;
}

/** Whether the lead controls show: the node keeps leaders, and this view may change them. */
export function leadOffered(state: Pick<ViewState, "leadOn" | "scopes">): boolean {
  return state.leadOn === true && state.scopes.includes("sessions:write");
}

/** Whether a speaker's Lead shows: the chat's wherever the controls do, a session's while it may lead. */
export function canLead(state: Pick<ViewState, "leadOn" | "scopes" | "sessions" | "nodes">, speaker: string): boolean {
  if (!leadOffered(state)) return false;
  if (speaker === "chat") return true;
  const s = state.sessions.get(speaker)?.session;
  return s !== undefined && leadable(state, s);
}

/** Whether `leader` leads `s`, as the node decides it: named in its group, or with `all` any session it may lead but itself. */
export function leadsSession(state: Pick<ViewState, "nodes">, leader: Leader, s: Session): boolean {
  if (leader.speaker === s.id || !leadable(state, s)) return false;
  return leader.targets === "all" || leader.targets.includes(s.id);
}

/**
 * Why a leader's words reach a session it leads as another agent's after all, as the node
 * decides it: a machine that shares some folders alone, one whose Cophyla is older than
 * leaders, or a session nothing can type into. Its leader still answers its questions as the user.
 */
export function leadFallback(state: Pick<ViewState, "nodes">, s: Session): string | undefined {
  const n = state.nodes.get(s.node);
  if (n && n.scope.kind === "workspaces") return `${n.name} shares some folders alone`;
  if (n && n.capabilities.lead !== true) return `${n.name} runs an older Cophyla`;
  return untypeable(s);
}

/** What a speaker is called: Cophyla for the chat, else its session's name; none for a session not here. */
export function speakerName(state: Pick<ViewState, "sessions">, speaker: string): string | undefined {
  if (speaker === "chat") return CHAT_NAME;
  const s = state.sessions.get(speaker)?.session;
  return s ? sessionLabel(s) : undefined;
}

/** A chip in a head: its words, and its hover. */
export interface LeadChip {
  text: string;
  title: string;
}

/** A leader's chip: how many sessions it leads, or every agent, with their names in its hover; none while it leads no one. */
export function leaderChip(state: Pick<ViewState, "leaders" | "sessions">, speaker: string): LeadChip | undefined {
  const l = state.leaders.get(speaker);
  if (!l) return undefined;
  const as = "its messages reach them as your own words, and it may answer their questions as you";
  if (l.targets === "all") return { text: "Leads every agent", title: `Leads every agent of yours, now and later: ${as}.` };
  const names = l.targets.map((id) => speakerName(state, id)).filter((n): n is string => n !== undefined);
  const gone = l.targets.length - names.length;
  const who = [...names, ...(gone > 0 ? [`${gone} not open now`] : [])].join(", ");
  return { text: `Leads ${l.targets.length}`, title: `Leads ${who}: ${as}.` };
}

/** A led session's chip: every leader whose group holds it, the agents first and Cophyla last; none while no one leads it. */
export function ledByChip(state: Pick<ViewState, "leaders" | "sessions" | "nodes">, s: Session): LeadChip | undefined {
  const by = [...state.leaders.values()].filter((l) => leadsSession(state, l, s)).sort((a, b) => Number(a.speaker === "chat") - Number(b.speaker === "chat") || a.since - b.since);
  const names = by.map((l) => speakerName(state, l.speaker)).filter((n): n is string => n !== undefined);
  if (names.length === 0) return undefined;
  const one = names.length === 1;
  const text = `Led by ${names.join(", ")}`;
  const why = leadFallback(state, s);
  const words = why ? `as another agent's (${why})` : "as your own words";
  return { text, title: `${text}: ${one ? "its" : "their"} messages reach this session ${words}, and ${one ? "it" : "they"} may answer its questions as you.` };
}

/**
 * A session in a leader's list: its name, its harness, what it is doing; why it cannot be picked
 * when it cannot (`blocked`), or why a leader's words would reach it as another agent's (`note`).
 */
export interface LeadItem {
  id: string;
  label: string;
  harness: string;
  words: string;
  blocked?: string;
  note?: string;
}

/** A heading of the list, a folder group of the rail's, and the sessions under it. */
export interface LeadGroup {
  key: string;
  title: string;
  items: LeadItem[];
}

const LEAD_STATUS: Record<Session["status"], string> = { idle: "idle", busy: "working", needs_input: "waiting for you", needs_permission: "waiting for you", ended: "ended" };

/**
 * The sessions a speaker's group may name, under the rail's folder headings and in its order, a
 * folder inside another named under it: the speaker itself, and the sessions no leader may lead,
 * left out; one nothing can type into there, but blocked; one on a machine that takes no
 * leader's words as its user's there, with why.
 */
export function leadTargets(state: ViewState, speaker: string): LeadGroup[] {
  const out: LeadGroup[] = [];
  const walk = (level: SessionGroup[], over: string): void => {
    for (const g of level) {
      const title = over ? `${over} › ${g.name}` : g.name;
      const items = g.sessions
        .map((c) => c.session)
        .filter((s) => s.id !== speaker && leadable(state, s))
        .map((s): LeadItem => {
          const blocked = untypeable(s);
          const why = blocked === undefined ? leadFallback(state, s) : undefined;
          const note = why ? `${why}: it reads them as another agent's` : undefined;
          return { id: s.id, label: sessionLabel(s), harness: s.harness, words: blocked ?? note ?? `${HARNESS_NAMES[s.harness]} · ${LEAD_STATUS[s.status]}`, ...(blocked ? { blocked } : {}), ...(note ? { note } : {}) };
        });
      if (items.length > 0) out.push({ key: g.key, title, items });
      walk(g.groups, title);
    }
  };
  walk(selectGroups(state), "");
  return out;
}

/** The list as it opens: the speaker's group as it stands, nothing picked for one that leads no one yet. */
export function leadDraft(state: Pick<ViewState, "leaders">, speaker: string): { all: boolean; picked: Set<string> } {
  const l = state.leaders.get(speaker);
  return { all: l?.targets === "all", picked: new Set(l && l.targets !== "all" ? l.targets : []) };
}

/** What `lead.set` is sent from the list, or why it is not: every agent, or the sessions picked that may still be, at most `LEAD_TARGETS_MAX`. */
export function leadSetParams(state: ViewState, form: { speaker: LeaderSpeaker; all: boolean; picked: Iterable<string> }): { params: { speaker: LeaderSpeaker; targets: "all" | string[] } } | { error: string } {
  if (form.all) return { params: { speaker: form.speaker, targets: "all" } };
  const open = new Set(leadTargets(state, form.speaker).flatMap((g) => g.items.filter((i) => i.blocked === undefined).map((i) => i.id)));
  const targets = [...form.picked].filter((id) => open.has(id));
  if (targets.length === 0) return { error: "Pick the agents it leads, or Every agent." };
  if (targets.length > LEAD_TARGETS_MAX) return { error: `A leader names at most ${LEAD_TARGETS_MAX} agents: pick Every agent instead.` };
  return { params: { speaker: form.speaker, targets } };
}

/** Whether the list says what the speaker's group already is: Save would send nothing new. */
export function leadUnchanged(state: ViewState, form: { speaker: LeaderSpeaker; all: boolean; picked: Iterable<string> }): boolean {
  const l = state.leaders.get(form.speaker);
  const made = leadSetParams(state, form);
  if (!l || "error" in made) return false;
  const t = made.params.targets;
  if (t === "all" || l.targets === "all") return t === l.targets;
  const had = l.targets;
  return t.length === had.length && t.every((id) => had.includes(id));
}

/**
 * A lead request that failed, in words the user can act on: an app from before leaders refuses
 * the request itself ("unknown method"), and a node from before them answers `unsupported` too.
 */
export function leadFailure(code: string | undefined, message: string): string {
  if (code === "unsupported" && /^unknown method lead\./.test(message)) return "This Cophyla app is older than leaders: update it, or open it again after an update, then try again.";
  if (code === "unsupported") return "Cophyla on this computer is older than leaders: update it, then try again.";
  return message;
}

/** Who sent a leader's message typed into a session as the user's: Cophyla for the chat, else the leading agent's alias. */
export function leadNote(payload: unknown): string {
  const by = (payload as { by?: unknown } | undefined)?.by;
  const alias = by !== null && typeof by === "object" ? (by as { alias?: unknown }).alias : undefined;
  const who = by === "chat" ? CHAT_NAME : typeof alias === "string" ? alias : "a leader";
  return `sent by ${who} as you`;
}
