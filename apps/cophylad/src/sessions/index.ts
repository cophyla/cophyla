// `Sessions`: every live harness session in one model, driven from outside its terminal.
// Owns the records keyed by cophylad id with an index on the harness's native id, so a Claude
// session resumed under a new pid keeps its id, and one whose context is cleared in the same
// process keeps it too. An ended session is resumed only on evidence that it ran after it
// ended: a new process, its transcript grown past where it was recorded to, or a hook, which
// only a live process sends. Runs the attached adapters on a poll, routes hook events, turns a
// held PermissionRequest into an Ask (or, for an `AskUserQuestion`, one Ask per question in
// turn) and settles it, tracks sent messages until the harness shows them, and spawns and
// stops sessions: in a tether terminal when tether is here, through the ACP adapter otherwise
// (for Muse, headless on its own `muse serve` host), whose records the attached adapters never
// touch.
//
// A session in a tether terminal is typed into as the user: what the user sends from an app
// is a bracketed paste and Enter, and lands as their own turn, where the messaging pipe would
// deliver it as another agent's. The brain's messages stay on Claude's pipe unless configured
// otherwise, because the brain is an agent reading untrusted content, which is what the
// harness's framing of peer messages is for. Muse has no such channel: whatever reaches a Muse
// session in a terminal is typed.
//
// A session is the machine's or a workspace node's, decided once when its record is made: a
// session started into a workspace is that workspace's node's, one discovered is the owner's
// of the folder it runs in. What reads or acts on a session by id sees the machine's alone,
// and a workspace node's through `view`; a session of another partition is "no session" to
// it. A workspace node's sessions are started headless.
//
// One session is nobody's agent: the one the chat itself runs in (`role: assistant`), which
// the assistant module starts here (`spawnAssistant`) and types into as the user. It is in a
// partition of its own (`ASSISTANT_PART`), so no list holds it and no request by id finds it
// but the module's; nothing of it goes on the bus, none of its events are stored, and its
// hooks are answered by the module, which is told of its row's changes directly.
//
// Another agent's message (agent messaging) goes in its envelope, which names the sender, and
// is never typed into a Claude session: typed, it would read as the user's own words and skip
// the hold Claude puts on a message from a session that prompts into one that does not.

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Ask, AskAnswer, ClaudeHookEvent, CodexHookEvent, HarnessKind, HarnessProfile, ModelRef, MuseHookEvent, NodeId, Session, SessionEvent, SessionEventKind, SessionStatus, SessionWaiting, TerminalRef, WorkMode } from "@cophyla/protocol";
import { newId, RpcError, ulid } from "@cophyla/protocol";
import { submit } from "@tether-pty/client";
import type { HookHarness, HookMeta } from "../api/hooks.ts";
import { agentTurn, envelope, ENVELOPE_TAG, NOTICE_FROM, readEnvelope } from "../agentmsg/envelope.ts";
import type { EnvelopeInfo } from "../agentmsg/envelope.ts";
import type { Bus } from "../bus.ts";
import type { AcpConfig, SessionsConfig } from "../config/schema.ts";
import type { AskInput, Asks } from "../gate/asks.ts";
import { redact } from "../gate/audit.ts";
import type { Logger } from "../log.ts";
import type { SessionListFilter, Store } from "../store/index.ts";
import type { Workspaces } from "../workspaces/index.ts";
import { AcpAdapter, CODEX_ACP_FULL_ACCESS } from "./acp/adapter.ts";
import { looserOnTheWay, MODE_WORDS, permissionModeOf, readLaunch } from "./claude/launch.ts";
import { isAlive as processAlive } from "./claude/registry.ts";
import type { ClaudeLaunch, PermissionMode } from "./claude/launch.ts";
import { autoUnavailable, clearContextRow, dialogRows, footerMode, promptInput, tail, trustDialog, waitingOn } from "./claude/screen.ts";
import { contextUsed } from "./claude/transcript.ts";
import type { ClaudeTranscriptState } from "./claude/transcript.ts";
import { flagGroups, launchFlags, mirrorArgs } from "./claude/launch-args.ts";
import type { Launch } from "./claude/launch-args.ts";
import { claudeArgv, claudeEnv, newSessionId, cophyladSettings, sessionName } from "./claude/start.ts";
import { desktopOriginated, isManagedDaemon } from "./codex/adapter.ts";
import { composerUp as codexComposerUp, waitingOn as codexWaitingOn } from "./codex/screen.ts";
import { codexArgv, codexEnv, runsUnderCmd } from "./codex/start.ts";
import type { ProcessInfo, WindowRaiser } from "./focus.ts";
import { Injections, unpasted } from "./injections.ts";
import type { PendingSend } from "./injections.ts";
import { askShown, capText, normaliseHook, oneLine, rawIfSmall, stableStringify, summariseValue, toolKey, TOOL_CALL_CAP, TOOL_RESULT_CAP } from "./model.ts";
import type { AttachedHarness, HarnessAdapter, HookInstallSpec, NormalisedHook, SessionHost, SessionRecord, SessionSeed, ViewMark } from "./model.ts";
import { terminalCommand as museCommand } from "./muse/locate.ts";
import { promptInput as musePromptInput, waitingOn as museWaitingOn } from "./muse/screen.ts";
import { isWithin, pathKey } from "./paths.ts";
import { NotSettled } from "./protected.ts";
import { CLEAR, freshPlanPrompt, goOnLabel, goOnMode, goOnOption, handedOffDecision, permissionAsk, permissionDecision, planOf } from "./permissions.ts";
import type { GoOnMode, PlanOffer } from "./permissions.ts";
import type { ProfileChange, Profiles } from "./profiles.ts";
import { answersForHook, askInputFromQuestion, hookDecision, questionsFromAskUserQuestion } from "./questions.ts";
import type { HookAnswers, Question } from "./questions.ts";
import { toolResultText } from "./results.ts";
import { shimArgv, shimCommand, writeHookJson, writeShim } from "./shim.ts";
import { mtimeOf, REPLAY_BYTES, Tail } from "./tail.ts";
import { pickOpener } from "./terminals.ts";
import type { TerminalOpener } from "./terminals.ts";
import { cliOfName, TerminalClis } from "./tether/cli.ts";
import type { ProcessRow } from "./tether/cli.ts";
import type { TerminalChange, TerminalEntry, Tether } from "./tether/index.ts";
import { ASSISTANT_LABEL } from "./tether/streams.ts";
import { uuidv7Time } from "./uuidv7.ts";

export interface SessionsDeps {
  store: Store;
  bus: Bus;
  asks: Asks;
  config: SessionsConfig;
  nodeId: NodeId;
  log: Logger;
  profiles: Profiles;
  workspaces: Workspaces;
  /** Built against the host that owns them. */
  adapters: (host: SessionHost) => HarnessAdapter[];
  raiser: WindowRaiser;
  hookToken: string;
  dataDir: string;
  now?: () => number;
  /** The ACP adapter's configuration and environment; absent in a daemon that never spawns. */
  acp?: { config: AcpConfig; env: Record<string, string | undefined>; packagesDir?: string };
  /** Where a session cophylad starts is shown, most wanted first; none means it can only be started headless. */
  terminals?: TerminalOpener[];
  /** tether, when on this node: sessions cophylad starts run in it, and what the user sends them is typed. */
  tether?: Tether;
  /** The environment a session cophylad starts in tether gets: the daemon's own, scrubbed of harness markers. */
  env?: Record<string, string | undefined>;
  /** How long a session whose context was cleared waits for its new id; a test shortens it. */
  clearGraceMs?: number;
  /** How long a send that clears a context waits for the new one; a test shortens it. */
  clearWaitMs?: number;
  /** How long a hook's tool result waits for its call to be recorded first; a test shortens it. */
  resultHoldMs?: number;
  /** Prices a session's tokens when the harness states no cost of its own; undefined for a model with no price. */
  pricer?: (model: string, tokens: { in: number; out: number; cacheRead?: number; cacheWrite?: number }) => number | undefined;
  /** Ends a stopped session's process; `process.kill` unless a test records it. */
  kill?: (pid: number) => void;
  /** The home directory, whose `.claude` is Claude's own; the user's unless a test says. */
  home?: string;
  /** Runs a harness command to its end (`claude stop`); a test records it. */
  run?: (argv: string[], env: Record<string, string>, cwd: string) => Promise<{ code: number; out: string }>;
  /** One read of the process table, which finds the agent CLI running in a terminal; without it a terminal is marked by its program's name alone. */
  processes?: () => ProcessRow[] | undefined | Promise<ProcessRow[] | undefined>;
  /** Whether a process lives; a signal-0 kill unless a test says. */
  isAlive?: (pid: number) => boolean;
  /** How long a terminal waits to be looked at for its CLI, and the least time between looks; a test shortens them. */
  cliTiming?: { debounceMs?: number; gapMs?: number };
  /** Which workspace node owns a folder, and whose items the machine's own apps never see; absent, every session is the machine's. */
  owners?: SessionOwners;
}

/** The partition the chat's own session is in: the machine's lists and a workspace node's alike leave it out. */
export const ASSISTANT_PART = "assistant";

/** What the assistant module hears of the session the chat runs in. */
export interface AssistantHooks {
  /**
   * A hook of the session's: its start, a prompt it took, a tool it ran, its turn's end. `ref`
   * names the message cophylad typed, on a prompt that is one. What it answers is the hook's
   * answer.
   */
  hook(hook: NormalisedHook, info: { ref?: string }): Promise<unknown> | unknown;
  /** The session's row changed, or it ended. */
  changed(session: Session): void;
}

/** What the chat's own session is started with. */
export interface AssistantSpawn {
  profile: HarnessProfile;
  /** The folder it runs in: cophylad's own, so a clear resolves to this session alone. */
  cwd: string;
  /** The command line after the program and its session id: the model, the tools, the settings. */
  args: string[];
  /** Added to the environment the profile's sessions start in. */
  env?: Record<string, string>;
  /** The conversation to go on with, by the id it last had; a fresh one when absent. */
  resume?: string;
  timeoutMs?: number;
}

/** Which node owns what on this machine: the folders lent to workspace nodes, and the ids kept private. */
export interface SessionOwners {
  ownerOf(path: string): string | undefined;
  isPrivate(node: string): boolean;
}

/** One workspace node's sessions: what its link lists, reads, starts, messages and stops. */
export interface SessionsView {
  list(filter?: SessionListFilter): Session[];
  get(id: string): Session | undefined;
  history(id: string, opts?: { before?: number; around?: number; limit?: number }): SessionEvent[];
  annotate(id: string, patch: { intent?: string; summary?: string; tags?: string[] }): Session;
  send(id: string, text: string, opts?: SendOptions): Promise<{ status: "queued" | "held"; ref?: string }>;
  stopSession(id: string, opts?: { as?: "user" | "brain" }): Promise<void>;
  spawn(params: SpawnParams, opts: SpawnOptions): Promise<Session>;
  pids(): Map<number, string>;
}

/**
 * Who a message is from, and how the session is prepared for it: the task it works on from
 * now, its context cleared, its mode set, in that order and before the text goes.
 */
export interface SendOptions {
  from?: "user" | "brain" | "agent";
  /** With `from: agent`: who it is from, its id and what it answers, which its envelope names. */
  agent?: EnvelopeInfo;
  task?: string;
  clear?: boolean;
  mode?: WorkMode;
}

/** Where a spawn finds its profile. */
export interface SpawnOptions {
  profiles: { get(id: string): HarnessProfile | undefined; defaultFor(h: SpawnParams["harness"]): HarnessProfile | undefined; launch?(id: string): Launch | undefined };
}

/** A command run to its end, its output and error text together. */
async function runCommand(argv: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => p.kill(), 30000);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out + err };
  } finally {
    clearTimeout(timer);
  }
}

export interface SpawnParams {
  harness: "claude" | "codex" | "muse";
  workspace: string;
  prompt: string;
  model?: ModelRef;
  task?: string;
  profile?: string;
  /** A Claude session's mode, over the profile's launch: `bypassPermissions` is `--dangerously-skip-permissions`. */
  mode?: PermissionMode;
}

export type AskCloseReason = "terminal" | "expired" | "aborted" | "stopped" | "daemon_stop";

/** An `AskUserQuestion` held as one ask per question, opened in turn; the answers go back in the tool's input. */
interface HeldQuestions {
  list: Question[];
  /** The question whose ask is open. */
  index: number;
  toolInput: Record<string, unknown>;
  /** `stableStringify(toolInput.questions)`: the PostToolUse carries the answers too, so the tool key differs. */
  key: string;
  /** When the harness gives up on the hook: every ask in the sequence expires by then. */
  deadline: number;
  out: HookAnswers;
}

/** A PermissionRequest held open: the ask that stands for it (the current one of a question sequence) and its waiters. */
interface Held {
  ask: Ask;
  key: string;
  openedAt: number;
  waiters: ((answer: unknown) => void)[];
  settled: boolean;
  questions?: HeldQuestions;
  /** An `ExitPlanMode`: its answer also says which mode the session leaves plan mode in. */
  plan?: HeldPlan;
}

/** A plan held for approval: in full, for a fresh session to start from, and the mode its "Yes, and …" row goes on in. */
interface HeldPlan {
  text: string;
  /** The call as the hook was shown it; an allow hands it back. */
  input: unknown;
  goOn: GoOnMode;
  /** "Yes, clear context" is the CLI's own row, pressed in the session's terminal. */
  inPlace: boolean;
}

type HeldStatus = "needs_permission" | "needs_input";

interface LiveRecord extends SessionRecord {
  held?: Held;
  /** An Elicitation prompt, answerable only in the terminal; closed on the next event. */
  inputAsk?: Ask;
  /** Claude: what the process was started with, read once per pid. */
  launch?: { pid: number | undefined; read: Promise<ClaudeLaunch | undefined> };
  /** Messages waiting to be typed into its terminal, one after another. */
  typing?: Promise<void>;
  /** How many of those are not typed yet. */
  toType?: number;
  /** Sends that cleared its context, waiting for the record to follow it to its new id. */
  clearWaiters?: (() => void)[];
  /** Claude: a change of permission mode being pressed in its terminal; the next waits for it, and so does a message typed meanwhile. */
  moding?: Promise<void>;
  /** Claude: its context was just cleared (`SessionEnd` with reason `clear`); it ends unless its new id turns up first. */
  clearing?: ReturnType<typeof setTimeout>;
  /** Inside `end`'s last tail pass, which must not end it again. */
  draining?: boolean;
  /** Claude: its process and the process's ancestors, read once per pid; `chain` is unset while the read runs. */
  ancestry?: { pid: number; chain?: ProcessInfo[] };
  /** Hooks handled so far: tells a Stop's late settling that another hook came meanwhile. */
  hooks?: number;
  /** Claude: tool results from hooks waiting for their call to be recorded first, by the call's id. */
  pendingResults?: Map<string, PendingResult>;
  /** The ids of the tool calls recorded lately, the last `RECENT_CALLS`. */
  calls?: Set<string>;
  /** When its current life began: the record made, met again from the store, or resumed. A newer one may take an older one's CLI. */
  since?: number;
}

/** A hook's tool result, held until its call is recorded. */
interface PendingResult {
  payload: Record<string, unknown>;
  raw: unknown;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

/** A Claude Code process by its image name. */
const CLAUDE_PROCESS = /^claude(\.exe)?$/i;
/** The harnesses whose CLI runs in a terminal cophylad can find: Claude's and Muse's are typed into as well. */
const TERMINAL_HARNESSES: readonly string[] = ["claude", "codex", "muse"];
/**
 * The process a Codex or Muse record holds, by its image name, as its adapter took it up a
 * hook's ancestors (or from the CLI a daemon-hosted thread was met in): only a hook gives one.
 */
const HOOKED_PROCESS: Readonly<Record<string, RegExp>> = { codex: /codex/i, muse: /muse/i };
/** How far a process's start, as the process table says it, may fall past the last activity of the record holding it: Linux's is read to the second. */
const PROCESS_START_SLACK_MS = 2000;
/** How often the profiles' login files are looked at. */
const PROFILES_CHECK_MS = 5000;
/** The title Claude's agents screen gives its terminal, after a count of what waits (`1 awaiting input · claude agents`). */
const AGENTS_TITLE = /(?:^|·\s*)claude agents$/i;
/**
 * Among several terminals a Codex thread fits, the CLI it came from started just before the
 * thread (a CLI makes its first thread as it starts, ~0.3 s in): by no more than `CLI_LEAD_MS`
 * after it (a start time read to the second), by no more than `CLI_MAX_MS` before it, and with
 * no other CLI started within `CLI_RIVAL_MS` before it. One that started after the thread wins
 * only with no other started within `CLI_MAX_MS` before it.
 */
const CLI_LEAD_MS = 1000;
const CLI_MAX_MS = 20000;
const CLI_RIVAL_MS = 2000;

/** A process showing a harness's agents screen, and the terminal it is in once found. */
interface AgentWindow {
  harness: HarnessKind;
  ref?: TerminalRef;
}

const FOLD_MS = 2000;

/** How long a session whose context was cleared waits for its new id before it counts as ended. */
const CLEAR_GRACE_MS = 5000;
/** How long a send that types `/clear` waits for the new context. */
const CLEAR_WAIT_MS = 10000;
/**
 * How long a hook's tool result waits for its call. The transcript is read ≥150 ms after it
 * changes; a sub-agent's call, which is never in it, is known from the hook and not waited for.
 */
const RESULT_HOLD_MS = 1500;
/** Tool call ids a record remembers, so a result whose call is in already does not wait. */
const RECENT_CALLS = 256;
/** Between screen checks while a message waits to be typed. */
/** The most rows the folder trust dialog's pointer is moved before it is left alone. */
const TRUST_MOVES = 4;
const TYPE_POLL_MS = 400;
/** How long a message typed and sent waits for the harness to show it before Enter is pressed once more. */
const TYPE_VERIFY_MS = 6000;
/** How long the plan dialog is looked for once the hook is released. */
const DIALOG_WAIT_MS = 4000;
/**
 * After the hook is released, before a key goes to the dialog: the CLI draws the dialog while
 * the hook is held, and keys pressed before it has taken the hook's answer in are lost.
 */
const DIALOG_SETTLE_MS = 600;
/** How long a pressed row has to leave the screen before it is pressed again, and how often. */
const DIALOG_CONFIRM_MS = 2500;
const DIALOG_TRIES = 3;
/** How long a press of Shift+Tab has to show in the footer before it is pressed again, and how often the footer is read meanwhile. */
const MODE_PRESS_MS = 2000;
const MODE_POLL_MS = 80;
/** The most Shift+Tab is pressed for one change of mode: round the longest cycle and back, with a dropped key or two. */
const MODE_PRESSES = 8;

/** Between discovery passes while waiting for a session started in a terminal to register. */
const TERMINAL_POLL_MS = 250;

/** How long a session started in a terminal is still recognised as that session, long past the wait for it. */
const TERMINAL_EXPECT_MS = 1800000;
/** A burst of sessions registering (a daemon start) is mirrored once per profile, this long after the last. */
const MIRROR_DELAY_MS = 2000;
const BROADCAST_MS = 250;
const WATCH_DEBOUNCE_MS = 150;
const DETAIL_CHARS = 2000;
export const SEND_PREFIX = "[cophylad, relaying the user]";
/** The agents' messages a session remembers having recorded, so an echo of one is recorded once. */
const AGENT_SEEN = 200;

function nativeKey(harness: string, nativeId: string): string {
  return `${harness}:${nativeId}`;
}

function unref(t: unknown): void {
  if (t && typeof t === "object" && "unref" in t) (t as { unref(): void }).unref();
}

const sleep = (ms: number) => new Promise<void>((r) => unref(setTimeout(r, ms)));

function sameTerminal(a: TerminalRef | undefined, b: TerminalRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.host === b.host && a.id === b.id;
}

/** A terminal title or a folder name as the two are compared: any spinner or bar a CLI puts before it off, and case aside. */
function titleWord(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, "").trim().toLowerCase();
}

/**
 * The items of a terminal's title as Codex draws them, after any spinner: its thread's name and
 * its project (`Respond to greeting | work`), or the project alone before the thread has one.
 */
function titleItems(title: string | undefined): string[] {
  return title === undefined ? [] : titleWord(title).split(" | ").flatMap((p) => (p.trim() ? [p.trim()] : []));
}

/** The names a title may give a folder by: its own and each one's above it, the git repository's root being the project Codex names. */
function folderNames(path: string): Set<string> {
  return new Set(path.split(/[\\/]/).flatMap((p) => (titleWord(p) && !p.endsWith(":") ? [titleWord(p)] : [])));
}

/** Whether a title has a thread's name before a project that is none of `cwd`'s folders: the Codex CLI that drew it works elsewhere. */
function worksElsewhere(title: string | undefined, cwd: string): boolean {
  const items = titleItems(title);
  if (items.length < 2) return false;
  const names = folderNames(cwd);
  return !items.some((i) => names.has(i));
}

/** What each thing a terminal has that fits a thread counts for: they add up (`terminalFit`). */
const FIT = { name: 4, title: 2, folder: 1 } as const;

/**
 * How well a terminal whose Codex CLI no session holds fits a thread the daemon runs: its title
 * carrying the thread's name, then naming its folder (or one above), then its shell's folder
 * being the thread's. None when the title has a thread's name before a project that is none of
 * the thread's folders: that CLI works elsewhere (`cd`, `-C`), wherever its shell started.
 */
function terminalFit(entry: TerminalEntry, session: Session): number {
  if (worksElsewhere(entry.info.title, session.cwd)) return 0;
  const items = titleItems(entry.info.title);
  const names = folderNames(session.cwd);
  const named = items.some((i) => names.has(i));
  const inFolder = pathKey(entry.info.cwdReported || entry.info.cwd) === pathKey(session.cwd);
  if (!named && !inFolder) return 0;
  const thread = session.title !== undefined && items.length > 1 && items.slice(0, -1).join(" | ") === titleWord(session.title);
  return (thread ? FIT.name : 0) + (named ? FIT.title : 0) + (inFolder ? FIT.folder : 0);
}

/** The error for a raise the OS's permission stopped: refused, or still being asked (macOS's Automation). */
function raiseRefused(r: "denied" | "waiting"): RpcError {
  return r === "waiting"
    ? new RpcError("unavailable", "macOS is asking whether Cophyla may control the terminal: answer its prompt, then try again")
    : new RpcError("unavailable", "macOS has not allowed Cophyla to control the terminal: System Settings › Privacy & Security › Automation");
}

export class Sessions implements SessionHost {
  readonly nodeId: NodeId;
  readonly config: SessionsConfig;
  readonly log: Logger;
  private deps: SessionsDeps;
  private byId = new Map<string, LiveRecord>();
  private byNative = new Map<string, string>();
  private askOwners = new Map<string, LiveRecord>();
  private adapters = new Map<AttachedHarness, HarnessAdapter>();
  private acp?: AcpAdapter;
  private injections: Injections;
  private interval?: ReturnType<typeof setInterval>;
  private ticking = false;
  private tickAgain = false;
  private watchers = new Map<string, FSWatcher>();
  private watchTimer?: ReturnType<typeof setTimeout>;
  private broadcasts = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void)[] = [];
  /** Per session, the agents' messages recorded in it lately: an echo of one is not recorded again. */
  private agentMessages = new Map<string, Set<string>>();
  /** The nonce each ACP spawn gave its agents' MCP server, to the session it is. */
  private nonces = new Map<string, string>();
  /** Records waiting for their process's ancestors, read together once the read running ends. */
  private ancestryWanted = new Set<LiveRecord>();
  private ancestryReading = false;
  /** The user's own Claude sessions whose launches wait to be mirrored: the latest per profile. */
  private mirrorQueue = new Map<string, { rec: LiveRecord; at: number }>();
  private mirrorTimer?: ReturnType<typeof setTimeout>;
  /** Processes showing an agents screen, by pid. */
  private agentPids = new Map<number, AgentWindow>();
  /** The terminal a conversation's record was in when it went on as a job, by the window's pid: the window may stay, on the agents screen. */
  private leftBehind = new Map<number, TerminalRef>();
  private agentsListeners = new Set<(ref: TerminalRef) => void>();
  /** The agent CLIs in terminals no session holds yet. */
  private clis?: TerminalClis;
  /** Terminals a first prompt went into for a harness that names its sessions itself (Codex), and the record each became. */
  private firstPrompts: { ref: TerminalRef; harness: AttachedHarness; origin: "orchestrator" | "user"; workspace?: string; task?: string; intent?: string; since: number; expiresAt: number; rec?: SessionRecord }[] = [];
  /** What cophylad installs in a harness's settings, kept for a profile that comes later. */
  private spec?: HookInstallSpec;
  private profilesCheckedAt = -Infinity;
  /** Profile changes handed to the adapters, one after another. */
  private syncing: Promise<void> = Promise.resolve();
  private stopped = false;
  private started = false;
  /** The assistant module, once it is up: what the chat's own session's hooks and changes go to. */
  private assistant?: AssistantHooks;
  /** The native ids the chat's own session was started or resumed under: a record met under one is its. */
  private assistantIds = new Set<string>();

  constructor(deps: SessionsDeps) {
    this.deps = deps;
    this.nodeId = deps.nodeId;
    this.config = deps.config;
    this.log = deps.log;
    for (const a of deps.adapters(this)) this.adapters.set(a.harness, a);
    if (deps.acp) {
      this.acp = new AcpAdapter({
        host: this,
        asks: deps.asks,
        config: deps.acp.config,
        env: deps.acp.env,
        log: deps.log.child("acp"),
        askTimeoutS: deps.config.hook_timeout_s,
        ...(deps.acp.packagesDir !== undefined ? { packagesDir: deps.acp.packagesDir } : {}),
        ...(deps.home !== undefined ? { home: deps.home } : {}),
      });
    }
    this.injections = new Injections({
      timeoutMs: deps.config.receipt_timeout_ms,
      now: () => this.now(),
      schedule: (fn, ms) => {
        const t = setTimeout(fn, ms);
        unref(t);
        return t;
      },
      cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      onTimeout: (p) => this.onReceiptTimeout(p),
    });
    // a held hook is released by its ask's answer, whichever partition answered it
    this.unsubscribe.push(deps.bus.onAll("ask.state", (ask) => this.onAskState(ask)));
    if (deps.tether) {
      const tether = deps.tether;
      this.clis = new TerminalClis({
        list: () => tether.list(),
        get: (ref) => tether.get(ref),
        ...(deps.processes ? { processes: deps.processes } : {}),
        held: (ref) => this.sessionOfTerminal(ref) !== undefined,
        isAlive: deps.isAlive ?? processAlive,
        changed: (ref) => this.cliChanged(ref),
        log: deps.log.child("clis"),
        now: () => this.now(),
        ...(deps.cliTiming ?? {}),
      });
      this.unsubscribe.push(tether.onChange((c) => this.onTerminal(c)));
    }
  }

  now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- lifecycle ------------------------------------------------------------------------

  async start(opts: { port: number }): Promise<void> {
    if (this.started) return;
    this.started = true;
    const shimPath = writeShim(this.deps.dataDir);
    const hookJson = writeHookJson(this.deps.dataDir, { port: opts.port, token: this.deps.hookToken });

    this.load();

    this.spec = this.config.install_hooks
      ? {
          url: `http://127.0.0.1:${opts.port}/hooks/`,
          token: this.deps.hookToken,
          timeoutS: this.config.hook_timeout_s,
          command: (harness, profileId, shell) => shimCommand(shimPath, harness, profileId, { shell }),
          argv: (harness, profileId, shim) => shimArgv(process.execPath, shim, harness, profileId, hookJson),
          mode: (profileId) => this.deps.profiles.hooksMode(profileId),
        }
      : undefined;

    for (const adapter of this.adapters.values()) {
      try {
        await adapter.start(this.deps.profiles.byHarness(adapter.harness), this.spec);
      } catch (e) {
        this.log.error("adapter failed to start", { harness: adapter.harness, error: e });
      }
    }
    this.unsubscribe.push(this.deps.profiles.onChange((change) => this.syncProfiles(change)));
    this.unsubscribe.push(this.deps.workspaces.onSettled((root) => this.workspacesSettled(root)));
    this.clis?.start();
    await this.tick();
    // A session met again from the store, whose terminal tether adopted before the record was loaded.
    for (const rec of this.byId.values()) this.terminalAbove(rec);
    this.interval = setInterval(() => void this.tick(), this.config.poll_ms);
    unref(this.interval);
  }

  /**
   * A macOS protected folder may be read now (the user answered its prompt, or had before): the
   * sessions met in it meanwhile get their workspace, without counting as activity.
   */
  private workspacesSettled(root: string): void {
    if (this.stopped) return;
    for (const rec of this.byId.values()) {
      if (rec.session.workspace || rec.session.status === "ended" || !isWithin(rec.session.cwd, root)) continue;
      try {
        this.patch(rec, { workspace: this.deps.workspaces.fromSession(rec.session.cwd, rec.session.node).id }, rec.session.lastActivity);
      } catch (e) {
        this.log.warn("workspace lookup failed", { cwd: rec.session.cwd, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.scheduleTick();
  }

  /** Releases every held hook, stops the adapters and clears timers, before the store closes. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.clis?.stop();
    if (this.mirrorTimer) clearTimeout(this.mirrorTimer);
    this.mirrorQueue.clear();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const rec of this.byId.values()) {
      if (rec.held) this.closeHeld(rec, "daemon_stop");
      if (rec.inputAsk) this.closeInput(rec, "daemon_stop");
      if (rec.clearing) clearTimeout(rec.clearing);
      this.flushResults(rec);
    }
    await this.syncing;
    if (this.acp) await this.acp.stopAll();
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch (e) {
        this.log.warn("adapter failed to stop", { harness: adapter.harness, error: e });
      }
    }
    for (const [id, t] of this.broadcasts) {
      clearTimeout(t);
      this.broadcasts.delete(id);
    }
    this.injections.dispose();
    for (const off of this.unsubscribe) off();
  }

  /**
   * Records from the store; asks left open by the previous run were already closed. A
   * spawned session's child died with the previous daemon, so its record is ended.
   */
  private load(): void {
    const now = this.now();
    const held: LiveRecord[] = [];
    for (const session of this.deps.store.sessions.listLive()) {
      const rec = this.adopt(session, now);
      if (session.native.transport === "acp") {
        this.end(rec, "daemon_restart", now);
        continue;
      }
      if (session.ask !== undefined || session.status === "needs_permission" || session.status === "needs_input") {
        delete rec.session.ask;
        rec.session.status = "busy";
        this.deps.store.sessions.update(rec.session);
      }
      if (session.native.pid !== undefined && HOOKED_PROCESS[session.harness]) held.push(rec);
    }
    this.log.info("sessions loaded", { count: this.byId.size });
    this.keepProcesses(held);
  }

  /**
   * Codex and Muse records met again holding a process: only a hook gave them one, so they are
   * judged by it as before the restart, not by their rollout's or log's recency, which ends a CLI
   * left idle a while. The process is read once: one of another name, or started after the
   * record was last active (its pid taken again, as after a reboot), is not the session's, which
   * lets it go and lives by recency again. One gone or not read is left to the adapter's checks.
   */
  private keepProcesses(recs: LiveRecord[]): void {
    if (recs.length === 0) return;
    const last = new Map(recs.map((rec) => [rec, rec.session.lastActivity]));
    for (const rec of recs) rec.liveness = "hook";
    void this.chainsOf([...new Set(recs.map((rec) => rec.session.native.pid!))])
      .then((chains) => {
        for (const rec of recs) {
          const pid = rec.session.native.pid;
          const self = pid === undefined ? undefined : chains.get(pid)?.[0];
          if (this.stopped || rec.session.status === "ended" || !self || self.pid !== pid) continue;
          const named = HOOKED_PROCESS[rec.session.harness]!.test(self.name);
          const before = self.startedAt === undefined || self.startedAt <= last.get(rec)! + PROCESS_START_SLACK_MS;
          if (named && before) continue;
          rec.liveness = "heuristic";
          const { pid: _other, ...native } = rec.session.native;
          this.patch(rec, { native }, rec.session.lastActivity);
          this.log.info("a session met again holds a process not its own; let go", { id: rec.session.id, pid, name: self.name, startedAt: self.startedAt });
        }
      })
      .catch((e: unknown) => this.log.warn("the processes of sessions met again were not read", { error: e instanceof Error ? e.message : String(e) }));
  }

  private adopt(session: Session, since = this.now()): LiveRecord {
    const rec: LiveRecord = { session, handles: {}, liveness: "heuristic", hookTools: new Map(), since };
    this.byId.set(session.id, rec);
    this.byNative.set(nativeKey(session.harness, session.native.id), session.id);
    return rec;
  }

  /** One discovery and tail pass over every adapter. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      const now = this.now();
      // A login file that changed rebuilds the profiles; the adapters take any change before they tick.
      if (now - this.profilesCheckedAt >= PROFILES_CHECK_MS) {
        this.profilesCheckedAt = now;
        this.deps.profiles.check();
      }
      await this.syncing;
      this.clis?.tick();
      for (const adapter of this.adapters.values()) {
        try {
          await adapter.tick(now);
        } catch (e) {
          this.log.error("adapter tick failed", { harness: adapter.harness, error: e });
        }
      }
    } finally {
      this.ticking = false;
      if (this.tickAgain) {
        this.tickAgain = false;
        setTimeout(() => void this.tick(), 0);
      }
    }
  }

  /** The profiles were rebuilt and something changed: each adapter takes its harness's profiles as they are now. */
  private syncProfiles(change: ProfileChange): void {
    this.syncing = this.syncing.then(async () => {
      for (const adapter of this.adapters.values()) {
        if (!adapter.sync || this.stopped) continue;
        try {
          await adapter.sync(this.deps.profiles.byHarness(adapter.harness), this.spec, change);
        } catch (e) {
          this.log.error("adapter failed to take the profiles", { harness: adapter.harness, error: e });
        }
      }
    });
  }

  openTail(rec: SessionRecord, path: string): Tail {
    const recorded = this.deps.store.sessions.tail(rec.session.id);
    rec.tail = new Tail(path, { replayBytes: REPLAY_BYTES, ...(recorded && recorded.path === path ? { recordedTo: recorded.offset } : {}) });
    return rec.tail;
  }

  tailed(rec: SessionRecord): void {
    if (rec.tail) this.deps.store.sessions.setTail(rec.session.id, rec.tail.path, rec.tail.consumed);
  }

  viewMark(rec: SessionRecord): ViewMark | undefined {
    const t = this.deps.store.sessions.tail(rec.session.id);
    return t ? { path: t.path, offset: t.offset, ...(t.cursor !== undefined ? { cursor: t.cursor } : {}) } : undefined;
  }

  setViewMark(rec: SessionRecord, mark: ViewMark): void {
    this.deps.store.sessions.setTail(rec.session.id, mark.path, mark.offset, mark.cursor);
  }

  watch(dir: string): void {
    let key: string;
    try {
      key = realpathSync(dir);
    } catch {
      return;
    }
    if (this.watchers.has(key) || this.stopped) return;
    try {
      const w = watch(key, { persistent: false }, () => this.scheduleTick());
      w.on("error", () => {
        this.watchers.delete(key);
      });
      this.watchers.set(key, w);
    } catch (e) {
      this.log.debug("watch failed", { dir: key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private scheduleTick(): void {
    if (this.watchTimer || this.stopped) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.tick();
    }, WATCH_DEBOUNCE_MS);
    unref(this.watchTimer);
  }

  // --- records ----------------------------------------------------------------------------

  find(harness: AttachedHarness, nativeId: string): SessionRecord | undefined {
    const id = this.byNative.get(nativeKey(harness, nativeId));
    return id ? this.byId.get(id) : undefined;
  }

  /** Harness hook responses held open for an ask: work the daemon must not stop under. */
  heldCount(): number {
    let n = 0;
    for (const rec of this.byId.values()) if (rec.held && !rec.held.settled) n++;
    return n;
  }

  /** The root pid of every live session of a partition (the machine's unless named) that has one, by session id. */
  pids(part?: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const rec of this.byId.values()) {
      const pid = rec.session.native.pid;
      if (rec.session.status !== "ended" && pid !== undefined && this.inPart(rec.session, part)) out.set(pid, rec.session.id);
    }
    return out;
  }

  /** Every partition's: what the metrics tree walk claims from. The chat's own session is no one's to show: its processes count to the machine alone. */
  pidsAll(): Map<number, string> {
    const out = new Map<number, string>();
    for (const rec of this.byId.values()) {
      const pid = rec.session.native.pid;
      if (rec.session.role === "assistant") continue;
      if (rec.session.status !== "ended" && pid !== undefined) out.set(pid, rec.session.id);
    }
    return out;
  }

  /** Whether a session is in a partition: a workspace node's own (`part`), or, unset, the machine's. The chat's own session is in neither. */
  private inPart(s: Pick<Session, "node" | "role">, part?: string): boolean {
    if (s.role === "assistant" || part === ASSISTANT_PART) return s.role === "assistant" && part === ASSISTANT_PART;
    return part === undefined ? !(this.deps.owners?.isPrivate(s.node) ?? false) : s.node === part;
  }

  /** The node a new session belongs to: the one its workspace is on when it was started into one, else the owner of the folder it runs in. */
  private ownerFor(seed: SessionSeed): NodeId {
    if (seed.workspace !== undefined) {
      const w = this.deps.workspaces.getAny(seed.workspace);
      if (w) return w.node;
    }
    return this.deps.owners?.ownerOf(seed.cwd) ?? this.nodeId;
  }

  /** Prompts in flight or queued on the sessions cophylad spawned, over ACP or on a harness's own host. */
  acpInFlight(): number {
    let n = this.acp?.inFlightCount() ?? 0;
    for (const adapter of this.adapters.values()) n += adapter.headless?.inFlight() ?? 0;
    return n;
  }

  records(harness: AttachedHarness): SessionRecord[] {
    return [...this.byId.values()].filter((r) => r.session.harness === harness && r.session.status !== "ended" && r.session.native.transport !== "acp");
  }

  alias(rec: SessionRecord, nativeId: string): void {
    this.byNative.set(nativeKey(rec.session.harness, nativeId), rec.session.id);
  }

  /**
   * The same process now goes by another session id. The record follows it: origin, task,
   * workspace and terminal stay, the old id stays an alias so a late hook still finds it,
   * and the transcript starts over at the new one's. The intent goes: the new conversation's
   * first prompt, or the plan it was cleared to carry out, says what it is for now. A name
   * the user gave stays, as the id does: the new conversation's generated title never
   * replaces it. What the session spent under the old id is kept as the base its stats count
   * on from.
   */
  rekey(rec: SessionRecord, nativeId: string, at = this.now()): void {
    const live = rec as LiveRecord;
    const from = rec.session.native.id;
    if (from === nativeId) return;
    if (live.clearing) {
      clearTimeout(live.clearing);
      live.clearing = undefined;
    }
    // The old transcript is read no further.
    this.flushResults(live);
    this.byNative.set(nativeKey(rec.session.harness, nativeId), rec.session.id);
    rec.session.native = { ...rec.session.native, id: nativeId };
    if (rec.session.stats) rec.statsBase = rec.session.stats;
    delete rec.session.intent;
    delete rec.session.transcript;
    rec.tail = undefined;
    // The adapter reads the new transcript with a parser of its own; only the name carries over.
    rec.parser = (rec.parser as { named?: boolean } | undefined)?.named === true ? { named: true } : undefined;
    rec.session.lastActivity = Math.max(rec.session.lastActivity, at);
    this.deps.store.sessions.update(rec.session);
    this.log.info("session re-keyed", { id: rec.session.id, from, to: nativeId });
    this.event(rec, "notification", { type: "context_cleared", from, to: nativeId }, undefined, at);
    this.broadcast(rec, true);
    const waiters = live.clearWaiters;
    live.clearWaiters = undefined;
    for (const w of waiters ?? []) w();
  }

  /**
   * The conversation went on as a background job, under `nativeId`. The record follows it as it
   * follows a cleared context: what it is and what it was started for stay, and the old id stays
   * an alias. The window's process and terminal stay behind (it exits, or shows the agents
   * screen), and the job's entry gives the record its own when it registers. The job's
   * transcript opens with a copy of the history, which was recorded under the old id: only its
   * later rows are recorded, while the stats count the copy in place of the old transcript.
   */
  background(rec: SessionRecord, nativeId: string, at = this.now()): void {
    const live = rec as LiveRecord;
    const from = rec.session.native.id;
    if (from === nativeId) return;
    if (live.clearing) {
      clearTimeout(live.clearing);
      live.clearing = undefined;
    }
    if (live.held) this.closeHeld(live, "stopped", rec.session.status === "ended" ? "ended" : "idle");
    if (live.inputAsk) this.closeInput(live, "stopped");
    this.flushResults(live);
    const { pid, terminal } = rec.session.native;
    if (pid !== undefined && terminal) this.leftBehind.set(pid, terminal);
    this.byNative.set(nativeKey(rec.session.harness, nativeId), rec.session.id);
    rec.session.native = { id: nativeId, transport: rec.session.native.transport };
    rec.copiedBefore = rec.continuing?.at;
    delete rec.continuing;
    delete rec.session.transcript;
    rec.tail = undefined;
    rec.parser = undefined;
    rec.handles = rec.handles.configDir ? { configDir: rec.handles.configDir } : {};
    rec.ancestorsChecked = false;
    live.launch = undefined;
    live.ancestry = undefined;
    rec.session.lastActivity = Math.max(rec.session.lastActivity, at);
    this.deps.store.sessions.update(rec.session);
    this.log.info("session went on as a background job", { id: rec.session.id, from, to: nativeId });
    this.event(rec, "notification", { type: "backgrounded", from, to: nativeId }, undefined, at);
    this.broadcast(rec, true);
  }

  /**
   * The job a conversation went on as has a record of its own already: it takes over what the
   * conversation's record was for (who started it, its workspace, task and intent, where it has
   * none of its own), and the conversation's record ends.
   */
  merge(from: SessionRecord, into: SessionRecord, at = this.now()): void {
    const f = from.session;
    const s = into.session;
    // What one partition started is never another's to take on.
    if (f.node !== s.node) {
      this.log.info("a job and the conversation it went on from are on different nodes; not merged", { from: f.id, into: s.id });
      return;
    }
    const patch: Partial<Session> = {};
    if (f.origin === "orchestrator" && s.origin !== "orchestrator") patch.origin = "orchestrator";
    if (f.workspace !== undefined && s.workspace === undefined) patch.workspace = f.workspace;
    if (f.task !== undefined && s.task === undefined) patch.task = f.task;
    if (f.intent !== undefined && s.intent === undefined) patch.intent = f.intent;
    if (Object.keys(patch).length > 0) this.patch(into, patch, at);
    if (f.native.pid !== undefined && f.native.terminal) this.leftBehind.set(f.native.pid, f.native.terminal);
    delete from.continuing;
    this.event(into, "notification", { type: "backgrounded", from: f.native.id, to: s.native.id, session: f.id }, undefined, at);
    this.end(from, "backgrounded", at);
  }

  /**
   * The processes showing a harness's agents screen: their terminals are marked as that, found
   * by the terminal a session of theirs was in, by pid, or up the process's ancestors. A mark
   * goes when its process leaves the screen or ends.
   */
  agentWindows(harness: AttachedHarness, windows: { pid: number }[]): void {
    const pids = new Set(windows.map((w) => w.pid));
    for (const [pid, w] of this.agentPids) {
      if (w.harness !== harness || pids.has(pid)) continue;
      this.agentPids.delete(pid);
      if (w.ref) this.agentsChanged(w.ref);
    }
    for (const pid of pids) {
      const known = this.agentPids.get(pid);
      if (known?.ref) continue;
      const w: AgentWindow = known ?? { harness };
      this.agentPids.set(pid, w);
      // The terminal its conversation's record was in, once the record has moved on to the job.
      const ref = this.leftBehind.get(pid) ?? this.deps.tether?.byPid(pid)?.ref;
      if (ref) {
        w.ref = ref;
        this.agentsChanged(ref);
        continue;
      }
      // Up its ancestors, once: skipped while its record still holds the terminal.
      if (known || !this.deps.tether?.available) continue;
      void this.deps.raiser
        .ancestors(pid)
        .then((chain) => {
          const above = this.agentPids.get(pid) === w ? this.terminalAboveOf(chain) : undefined;
          if (!above) return;
          w.ref = above.ref;
          this.agentsChanged(above.ref);
        })
        .catch(() => undefined);
    }
    for (const pid of [...this.leftBehind.keys()]) if (!pids.has(pid)) this.leftBehind.delete(pid);
  }

  /**
   * Whose agents screen a terminal shows, when it shows one: a window parked on it, or a
   * terminal titled as the screen titles it (`claude agents` typed in a shell registers nothing).
   */
  agentsOf(ref: TerminalRef): HarnessKind | undefined {
    for (const w of this.agentPids.values()) if (sameTerminal(w.ref, ref)) return w.harness;
    const title = this.deps.tether?.get(ref)?.info.title;
    return title !== undefined && AGENTS_TITLE.test(title.trim()) ? "claude" : undefined;
  }

  /** Called with a terminal whose agents mark or CLI mark came or went. */
  onAgents(fn: (ref: TerminalRef) => void): () => void {
    this.agentsListeners.add(fn);
    return () => this.agentsListeners.delete(fn);
  }

  private agentsChanged(ref: TerminalRef): void {
    for (const fn of this.agentsListeners) fn(ref);
  }

  /** The agent CLI marked in a terminal: what a terminal no session holds yet is running. */
  cliOf(ref: TerminalRef): HarnessKind | undefined {
    return this.clis?.markOf(ref)?.harness;
  }

  /**
   * A terminal's CLI mark came or went: its row changes, and a thread the daemon runs may have
   * one terminal to take now, the CLI it waits for having come, or a second fit gone.
   */
  private cliChanged(ref: TerminalRef): void {
    this.agentsChanged(ref);
    this.relinkHosted();
  }

  /**
   * Every live Codex record lets go a terminal titled for another folder, and each with no
   * terminal then looks for its CLI's, the one active last first: one the daemon hosts, and one
   * with no process that no hook has told apart since the daemon started (`linkMarked`).
   */
  private relinkHosted(): void {
    this.letGoAllElsewhere();
    const waiting = [...this.byId.values()].filter((r) => r.session.harness === "codex" && r.session.status !== "ended" && !r.session.native.terminal && (r.hostedBy === "daemon" || this.untold(r)));
    for (const rec of waiting.sort((a, b) => b.session.lastActivity - a.session.lastActivity)) this.linkMarked(rec);
  }

  /** A Codex thread with no process that no hook has told apart yet: the daemon may host it, and only its name in a CLI's title says which CLI shows it. */
  private untold(rec: SessionRecord): boolean {
    return rec.session.harness === "codex" && rec.hostedBy === undefined && rec.session.native.pid === undefined && rec.session.native.transport === "app-server";
  }

  /**
   * A Codex thread gives back the terminal it holds once that terminal's title says its CLI
   * works in another folder (`worksElsewhere`): taken before the title said so, by the first
   * CLI a restart marked, say, and kept by the record from before it, or left for a thread
   * elsewhere (`/resume`). It lets the CLI go with it and lives on by its rollout's recency, as
   * a thread handed over does. The terminal is looked at again: one held since the daemon
   * started was never marked.
   */
  private letGoElsewhere(rec: SessionRecord): boolean {
    const term = rec.session.native.terminal;
    const entry = term ? this.deps.tether?.get(term) : undefined;
    if (!term || !entry || rec.session.harness !== "codex" || rec.session.status === "ended" || !worksElsewhere(entry.info.title, rec.session.cwd)) return false;
    const { terminal: _terminal, pid: _pid, ...native } = rec.session.native;
    this.patch(rec, { native });
    this.log.info("a codex session's terminal is titled for another folder; let go", { id: rec.session.id, terminal: term.id, project: titleItems(entry.info.title).at(-1) });
    this.clis?.reconsider(term);
    return true;
  }

  /** Every live record that holds a terminal titled for another folder lets it go (`letGoElsewhere`); whether any did. */
  private letGoAllElsewhere(): boolean {
    let any = false;
    for (const rec of this.byId.values()) if (this.letGoElsewhere(rec)) any = true;
    return any;
  }

  /**
   * A Codex thread the app-server daemon runs: its hooks come from under the daemon, which says
   * nothing of the CLI the user typed in. That CLI is the one marked in a terminal no session
   * holds whose title or shell's folder fits the thread (`terminalFit`; Codex titles its
   * terminal with the thread's name and its project): the record takes it, and the CLI as its
   * process, which it then ends with. Of several, the one that fits best is taken; of several
   * that fit as well, the CLI that started just before the thread (its id says when), and none
   * when two started too close together to tell. A terminal titled for another folder is never
   * taken, and one held is let go (`letGoElsewhere`). A thread a desktop app started takes none.
   * One no hook has told apart since the daemon started (`untold`) takes only a terminal whose
   * title carries its name, and lives with the CLI as one a hook told of does.
   *
   * A CLI goes on to another thread (`/new`, `/resume`) with no word to the one it leaves until
   * the daemon ends that one about a minute later: at the new thread's first hook (`handOver`),
   * with no free terminal that fits and the one that does held by an older thread through the
   * same CLI, that thread lets the terminal and the CLI go, living on by its rollout's recency,
   * and the new one takes them. With two such terminals held, the new thread waits for the end.
   */
  linkMarked(rec: SessionRecord, opts: { handOver?: boolean } = {}): void {
    const tether = this.deps.tether;
    const clis = this.clis;
    if (!tether || !clis || rec.session.status === "ended" || desktopOriginated(rec.originator)) return;
    if (rec.session.native.terminal) {
      if (this.letGoElsewhere(rec)) this.relinkHosted();
      return;
    }
    // A terminal it fits may be held by a thread its CLI left for this folder.
    if (this.letGoAllElsewhere()) {
      this.relinkHosted();
      return;
    }
    const ranked = tether.list().flatMap((e) => {
      if (e.info.status !== "running" || clis.markOf(e.ref)?.harness !== rec.session.harness) return [];
      const fit = terminalFit(e, rec.session);
      return fit > 0 ? [{ e, fit }] : [];
    });
    const free = ranked.filter((r) => !this.sessionOfTerminal(r.e.ref));
    if (free.length === 0) {
      if (opts.handOver) this.handOver(rec as LiveRecord, ranked.map((r) => r.e));
      return;
    }
    const best = Math.max(...free.map((r) => r.fit));
    if (rec.hostedBy !== "daemon" && best < FIT.name) return;
    const fits = free.filter((r) => r.fit === best).map((r) => r.e);
    const entry = fits.length === 1 ? fits[0] : this.startedJustBefore(rec, fits);
    if (!entry) {
      this.log.info("more than one terminal fits a daemon-hosted session as well, and its time tells none; none is taken", { id: rec.session.id, terminals: fits.map((e) => e.ref.id) });
      return;
    }
    const pid = clis.markOf(entry.ref)!.pid;
    rec.liveness = "hook";
    this.patch(rec, { native: { ...rec.session.native, terminal: entry.ref, pid } });
    this.log.info("session met in the terminal its CLI runs in", { id: rec.session.id, terminal: entry.ref.id, pid, of: free.length, by: best >= FIT.name ? "name" : best >= FIT.title ? "title" : "folder", hosted: rec.hostedBy === "daemon" });
  }

  /** Of several terminals that fit a thread, the one whose CLI started just before it, by the thread's id; none when that cannot be told. */
  private startedJustBefore(rec: SessionRecord, fits: TerminalEntry[]): TerminalEntry | undefined {
    const t = uuidv7Time(rec.session.native.id);
    const starts = fits.map((e) => ({ e, at: this.clis?.markOf(e.ref)?.startedAt }));
    if (t === undefined || starts.some((s) => s.at === undefined)) return undefined;
    let best: { e: TerminalEntry; at: number } | undefined;
    for (const s of starts as { e: TerminalEntry; at: number }[]) if (s.at <= t + CLI_LEAD_MS && (!best || s.at > best.at)) best = s;
    if (!best || t - best.at > CLI_MAX_MS) return undefined;
    const from = best.at > t ? t - CLI_MAX_MS : t - CLI_RIVAL_MS;
    if (starts.some((s) => s !== best && s.at! > from && s.at! <= t + CLI_LEAD_MS)) return undefined;
    return best.e;
  }

  /** The new thread a CLI went on to takes the CLI's terminal from the older one it held (`linkMarked`). */
  private handOver(rec: LiveRecord, fitting: TerminalEntry[]): void {
    if (fitting.length !== 1) return;
    const entry = fitting[0]!;
    const mark = this.clis?.markOf(entry.ref);
    const holder = this.recordOfTerminal(entry.ref);
    if (!mark || !holder || holder === rec || holder.hostedBy !== "daemon" || holder.session.native.pid !== mark.pid) return;
    if (holder.since === undefined || rec.since === undefined || holder.since >= rec.since) return;
    const { terminal: _terminal, pid: _pid, ...native } = holder.session.native;
    this.patch(holder, { native });
    this.patch(rec, { native: { ...rec.session.native, terminal: entry.ref, pid: mark.pid } });
    this.log.info("a CLI went on to another thread, which takes its terminal", { id: rec.session.id, from: holder.session.id, terminal: entry.ref.id, pid: mark.pid });
  }

  /**
   * A record whose context was just cleared, for a Claude hook under an id nobody has: the
   * one session in the hook's directory waiting for its new id. With more than one such, no
   * guess is made and the registry settles it.
   */
  private clearingFor(harness: AttachedHarness, hook: NormalisedHook): LiveRecord | undefined {
    if (harness !== "claude" || !hook.cwd) return undefined;
    const waiting = [...this.byId.values()].filter((r) => r.clearing && r.session.harness === "claude" && r.session.status !== "ended" && r.session.cwd === hook.cwd);
    if (waiting.length !== 1) return undefined;
    this.rekey(waiting[0]!, hook.sessionId);
    return waiting[0];
  }

  /** The tether terminal a harness CLI runs in, by its pid. */
  private terminalOf(harness: string, pid: number | undefined): TerminalRef | undefined {
    if (!TERMINAL_HARNESSES.includes(harness) || pid === undefined) return undefined;
    return this.deps.tether?.byPid(pid)?.ref;
  }

  /**
   * The tether terminal a Claude, Codex or Muse session runs in, or below rather than in: a
   * wrapper script, a shim, a shell or Muse's own launcher stands between the terminal's
   * process and the session's. The process's ancestors are read once per pid, and only while a
   * running terminal that no live session holds is there to be found.
   */
  private terminalAbove(rec: LiveRecord): void {
    const tether = this.deps.tether;
    const pid = rec.session.native.pid;
    if (!tether?.available || !TERMINAL_HARNESSES.includes(rec.session.harness) || rec.session.status === "ended" || pid === undefined || rec.session.native.terminal) return;
    // A process learned after its record was made (from a hook) may be the terminal's own.
    const own = tether.byPid(pid);
    if (own && !this.sessionOfTerminal(own.ref)) {
      this.patch(rec, { native: { ...rec.session.native, terminal: own.ref } });
      return;
    }
    if (!tether.list().some((e) => e.info.status === "running" && !this.sessionOfTerminal(e.ref))) return;
    if (rec.ancestry?.pid === pid) {
      if (rec.ancestry.chain) this.linkAbove(rec, rec.ancestry.chain);
      return;
    }
    rec.ancestry = { pid };
    this.ancestryWanted.add(rec);
    void this.readAncestry();
  }

  /** The ancestors of every record waiting for them, in one read of the process table where the platform has one. */
  private async readAncestry(): Promise<void> {
    if (this.ancestryReading) return;
    this.ancestryReading = true;
    try {
      while (this.ancestryWanted.size > 0 && !this.stopped) {
        const batch = [...this.ancestryWanted].flatMap((rec) => (rec.ancestry && !rec.ancestry.chain ? [{ rec, ancestry: rec.ancestry }] : []));
        this.ancestryWanted.clear();
        const chains = await this.chainsOf([...new Set(batch.map((b) => b.ancestry.pid))]);
        for (const { rec, ancestry } of batch) {
          // A new process was taken on while this read: its own read is queued.
          if (rec.ancestry !== ancestry) continue;
          ancestry.chain = chains.get(ancestry.pid) ?? [];
          if (!this.stopped) this.linkAbove(rec, ancestry.chain);
        }
      }
    } finally {
      this.ancestryReading = false;
    }
  }

  /** The ancestors of each pid, nearest first, in one read of the process table where the platform has one; none where the read failed. */
  private chainsOf(pids: number[]): Promise<Map<number, ProcessInfo[]>> {
    const tree = this.deps.raiser;
    return (tree.ancestorsOf ? tree.ancestorsOf(pids) : Promise.all(pids.map(async (pid) => [pid, await tree.ancestors(pid)] as const)).then((e) => new Map(e))).catch(() => new Map<number, ProcessInfo[]>());
  }

  /**
   * The nearest terminal up the chain that no live session holds. An agent CLI on the way up
   * means this one was started by another session (a tool's `claude -p`, say), and a terminal
   * above that is the other session's, not this one's.
   */
  private linkAbove(rec: LiveRecord, chain: ProcessInfo[]): void {
    if (rec.session.status === "ended" || rec.session.native.terminal || chain[0]?.pid !== rec.session.native.pid) return;
    const others = new Set<number>();
    for (const r of this.byId.values()) if (r !== rec && r.session.status !== "ended" && r.session.native.pid !== undefined) others.add(r.session.native.pid);
    const above = this.terminalAboveOf(chain, others);
    if (!above) return;
    this.patch(rec, { native: { ...rec.session.native, terminal: above.ref } });
    this.log.info("session met in the terminal it runs below", { id: rec.session.id, pid: rec.session.native.pid, terminal: above.ref.id, via: above.via });
  }

  /**
   * The nearest terminal up a process's ancestors (`chain[0]` is the process) that no live
   * session holds, short of another agent CLI or another session's process on the way.
   */
  private terminalAboveOf(chain: ProcessInfo[], others: Set<number> = new Set()): { ref: TerminalRef; via: string } | undefined {
    for (const p of chain.slice(1)) {
      if (cliOfName(p.name) || others.has(p.pid)) return undefined;
      const entry = this.deps.tether?.byPid(p.pid);
      if (!entry || this.sessionOfTerminal(entry.ref)) continue;
      return { ref: entry.ref, via: p.name };
    }
    return undefined;
  }

  /** The session running in a terminal, when one is. */
  sessionOfTerminal(ref: TerminalRef): Session | undefined {
    const rec = this.recordOfTerminal(ref);
    return rec ? { ...rec.session } : undefined;
  }

  private recordOfTerminal(ref: TerminalRef): LiveRecord | undefined {
    for (const rec of this.byId.values()) if (rec.session.status !== "ended" && sameTerminal(rec.session.native.terminal, ref)) return rec;
    return undefined;
  }

  /** A terminal came, changed or went: the session in it learns of it, and so does its CLI mark. */
  private onTerminal(change: TerminalChange): void {
    const ref = change.entry.ref;
    this.clis?.onTerminal(change);
    if (change.gone || change.entry.info.status === "exited") {
      for (const rec of this.byId.values()) {
        if (!sameTerminal(rec.session.native.terminal, ref) || rec.session.status === "ended") continue;
        const { terminal: _gone, ...native } = rec.session.native;
        this.patch(rec, { native });
      }
      for (const w of this.agentPids.values()) if (sameTerminal(w.ref, ref)) delete w.ref;
      return;
    }
    // A job's attach terminal gone on to the agents screen (←) shows the job no more, and
    // what is typed there would start a job of its own.
    if (this.agentsOf(ref)) {
      for (const rec of this.byId.values()) {
        if (rec.session.native.job === undefined || rec.session.status === "ended" || !sameTerminal(rec.session.native.terminal, ref)) continue;
        const { terminal: _left, ...native } = rec.session.native;
        this.patch(rec, { native });
        this.log.info("a job's terminal went to the agents screen", { id: rec.session.id, terminal: ref.id });
      }
    }
    // A CLI gone on to a thread in another folder retitles its terminal: the thread it left lets it go.
    const holder = this.recordOfTerminal(ref);
    if (holder && this.letGoElsewhere(holder)) this.relinkHosted();
    const pid = change.entry.info.pid;
    if (pid === undefined) return;
    for (const rec of this.byId.values()) {
      if (!TERMINAL_HARNESSES.includes(rec.session.harness) || rec.session.status === "ended" || rec.session.native.pid !== pid || rec.session.native.terminal) continue;
      this.patch(rec, { native: { ...rec.session.native, terminal: ref } });
    }
    for (const rec of this.byId.values()) this.terminalAbove(rec);
  }

  /** Whether a native id belongs to a session the ACP adapter owns. */
  ownedByAcp(harness: AttachedHarness, nativeId: string): boolean {
    const rec = this.find(harness, nativeId);
    return rec !== undefined && rec.session.native.transport === "acp" && rec.session.status !== "ended";
  }

  ensure(seed: SessionSeed): SessionRecord {
    const now = this.now();
    let rec = this.find(seed.harness, seed.nativeId) as LiveRecord | undefined;
    let revived = false;
    // An attached adapter that meets a spawned session in a registry or thread list leaves it alone.
    if (rec && rec.session.native.transport === "acp" && seed.transport !== "acp" && rec.session.status !== "ended") return rec;
    // The reverse race: the harness wrote its registry entry before `session/new` returned and an
    // attached adapter met it first. The ACP adapter takes the record over, so events come from one
    // place and the session carries its origin, task and workspace.
    if (rec && seed.transport === "acp" && rec.session.native.transport !== "acp" && rec.session.status !== "ended") {
      this.claim(rec, seed, now);
      return rec;
    }
    if (!rec) {
      const stored = this.deps.store.sessions.getByNative(seed.harness, seed.nativeId);
      if (stored) {
        rec = this.adopt(stored);
        if (stored.status === "ended") {
          // Still ended: the caller skips it.
          if (!this.ranAfterEnd(rec, seed)) return rec;
          this.revive(rec, seed, now);
          revived = true;
        }
      } else {
        // The chat's own session, met under the id it was started with: stamped before anything is told of it.
        const assistant = this.assistantIds.has(seed.nativeId);
        const node = assistant ? this.nodeId : this.ownerFor(seed);
        const session: Session = {
          id: newId("session", now),
          node,
          harness: seed.harness,
          profile: seed.profile,
          native: { id: seed.nativeId, transport: seed.transport },
          origin: assistant ? "orchestrator" : (seed.origin ?? "user"),
          cwd: seed.cwd,
          tags: [],
          status: seed.status ?? "idle",
          startedAt: seed.startedAt ?? now,
          lastActivity: now,
        };
        if (seed.pid !== undefined) session.native.pid = seed.pid;
        if (seed.job !== undefined) session.native.job = seed.job;
        const terminal = seed.terminal ?? this.terminalOf(seed.harness, seed.pid);
        if (terminal) session.native.terminal = terminal;
        if (seed.title !== undefined) session.title = seed.title;
        if (seed.name !== undefined) session.name = seed.name;
        if (seed.intent !== undefined) session.intent = seed.intent;
        if (seed.task !== undefined) session.task = seed.task;
        if (seed.transcriptPath !== undefined) session.transcript = { path: seed.transcriptPath };
        if (assistant) session.role = "assistant";
        if (seed.workspace !== undefined) session.workspace = seed.workspace;
        // Its folder is cophylad's own, and no workspace of the user's.
        else if (!assistant) {
          try {
            session.workspace = this.deps.workspaces.fromSession(seed.cwd, node).id;
          } catch (e) {
            // macOS has yet to ask the user about the folder: the workspace follows once it has (`workspacesSettled`).
            if (e instanceof NotSettled) this.log.info("the session's folder waits on macOS's permission prompt", { cwd: seed.cwd, folder: e.root });
            else this.log.warn("workspace lookup failed", { cwd: seed.cwd, error: e instanceof Error ? e.message : String(e) });
          }
        }
        this.deps.store.sessions.insert(session);
        rec = this.adopt(session);
        if (seed.liveness) rec.liveness = seed.liveness;
        Object.assign(rec.handles, seed.handles ?? {});
        this.log.info("session discovered", { id: session.id, harness: session.harness, native: session.native.id, cwd: session.cwd, profile: session.profile });
        this.event(rec, "status", { status: session.status, ...(session.native.pid !== undefined ? { pid: session.native.pid } : {}) }, undefined, now);
        this.broadcast(rec);
        this.terminalAbove(rec);
        this.queueMirror(rec, session.startedAt);
        return rec;
      }
    } else if (rec.session.status === "ended") {
      if (!this.ranAfterEnd(rec, seed)) return rec;
      this.revive(rec, seed, now);
      revived = true;
    }
    // Refresh handles and the parts of the seed that can change.
    Object.assign(rec.handles, seed.handles ?? {});
    if (seed.liveness === "hook") rec.liveness = "hook";
    const patch: Partial<Session> = {};
    const relaunched = seed.pid !== undefined && rec.session.native.pid !== seed.pid;
    if (relaunched) patch.native = { ...rec.session.native, pid: seed.pid };
    if (seed.job !== undefined && rec.session.native.job !== seed.job) patch.native = { ...(patch.native ?? rec.session.native), job: seed.job };
    if (!rec.session.native.terminal) {
      const terminal = seed.terminal ?? this.terminalOf(seed.harness, seed.pid ?? rec.session.native.pid);
      if (terminal) patch.native = { ...(patch.native ?? rec.session.native), terminal };
    }
    if (seed.transcriptPath !== undefined && rec.session.transcript?.path !== seed.transcriptPath) patch.transcript = { path: seed.transcriptPath };
    if (seed.title !== undefined && rec.session.title === undefined) patch.title = seed.title;
    // Kept from the first time it is met: what other agents address the session by does not move.
    if (seed.name !== undefined && rec.session.name === undefined) patch.name = seed.name;
    if (seed.intent !== undefined && rec.session.intent === undefined) patch.intent = seed.intent;
    if (seed.cwd && rec.session.cwd !== seed.cwd) patch.cwd = seed.cwd;
    if (Object.keys(patch).length > 0) this.patch(rec, patch, now);
    this.terminalAbove(rec);
    if (relaunched) this.queueMirror(rec, now);
    // A daemon-hosted thread resumed with no word of its CLI (a thread list has none): the CLI's terminal is looked for again.
    if (revived && rec.hostedBy) this.linkMarked(rec);
    return rec;
  }

  /** An attached record becomes the ACP adapter's: transport, origin, task and workspace from the seed; the tail dropped. */
  private claim(rec: LiveRecord, seed: SessionSeed, now: number): void {
    rec.tail = undefined;
    rec.parser = undefined;
    rec.handles = {};
    const s = rec.session;
    s.native = { id: s.native.id, transport: "acp", ...(seed.pid !== undefined ? { pid: seed.pid } : {}) };
    s.origin = seed.origin ?? "orchestrator";
    s.profile = seed.profile;
    if (seed.task !== undefined) s.task = seed.task;
    if (seed.workspace !== undefined) s.workspace = seed.workspace;
    if (seed.intent !== undefined) s.intent = seed.intent;
    if (seed.status !== undefined) s.status = seed.status;
    s.lastActivity = now;
    this.deps.store.sessions.update(s);
    this.log.info("session claimed by acp", { id: s.id, native: s.native.id, task: s.task });
    this.broadcast(rec);
  }

  /**
   * Whether a seed for an ended session shows that it ran after it ended: a process other
   * than the one it ended with, a complete line in its transcript past where it was recorded
   * to (or, for a file no tail has recorded, a change after the end), or, with no transcript
   * to judge by, the harness's own word that it was active since. A listing or a registry
   * that still shows a finished session is no evidence.
   */
  private ranAfterEnd(rec: LiveRecord, seed: SessionSeed): boolean {
    const s = rec.session;
    const endedAt = s.endedAt ?? s.lastActivity;
    if (seed.pid !== undefined && seed.pid !== s.native.pid) return true;
    const path = seed.transcriptPath ?? s.transcript?.path;
    if (path) {
      const recorded = this.deps.store.sessions.tail(s.id);
      if (recorded && recorded.path === path) return Tail.lineAfter(path, recorded.offset);
      const mtime = mtimeOf(path);
      if (mtime !== undefined) return mtime > endedAt;
    }
    return seed.activeAt !== undefined && seed.activeAt > endedAt;
  }

  /** A session seen running again after it ended: a resume keeps the id. */
  private revive(rec: LiveRecord, seed: SessionSeed, now: number): void {
    delete rec.session.endedAt;
    rec.session.status = seed.status ?? "idle";
    rec.session.lastActivity = now;
    rec.since = now;
    if (seed.pid !== undefined) rec.session.native.pid = seed.pid;
    else delete rec.session.native.pid;
    if (seed.job !== undefined) rec.session.native.job = seed.job;
    else delete rec.session.native.job;
    // Resumed in whichever terminal it was resumed in.
    const terminal = seed.terminal ?? this.terminalOf(seed.harness, seed.pid);
    if (terminal) rec.session.native.terminal = terminal;
    else delete rec.session.native.terminal;
    rec.session.profile = seed.profile;
    rec.tail = undefined;
    rec.parser = undefined;
    // A new process may be behind it: the next hook looks for it again.
    rec.ancestorsChecked = false;
    this.deps.store.sessions.update(rec.session);
    this.log.info("session resumed", { id: rec.session.id, native: rec.session.native.id, pid: seed.pid });
    this.event(rec, "status", { status: rec.session.status, ...(seed.pid !== undefined ? { pid: seed.pid } : {}), resumed: true }, undefined, now);
    this.broadcast(rec);
    this.queueMirror(rec, now);
  }

  /**
   * A Claude session the user started, under a new process: its launch is mirrored onto its
   * profile, what cophylad then starts sessions there with unless the user set one or config
   * does. Read off the process's command line once, a while after a burst of registrations
   * settles, and only when it is newer than the launch already recorded.
   */
  private queueMirror(rec: LiveRecord, at: number): void {
    const s = rec.session;
    // A workspace node's session is the other cluster's: its launch is no model for the machine's profile.
    if (s.harness !== "claude" || s.origin !== "user" || s.native.pid === undefined || this.stopped || !this.inPart(s)) return;
    const was = this.deps.profiles.mirroredAt(s.profile);
    if (was !== undefined && was >= at) return;
    const queued = this.mirrorQueue.get(s.profile);
    if (queued && queued.at >= at) return;
    this.mirrorQueue.set(s.profile, { rec, at });
    if (!this.mirrorTimer) {
      this.mirrorTimer = setTimeout(() => void this.mirrorNow(), MIRROR_DELAY_MS);
      unref(this.mirrorTimer);
    }
  }

  private async mirrorNow(): Promise<void> {
    this.mirrorTimer = undefined;
    const queued = [...this.mirrorQueue.entries()];
    this.mirrorQueue.clear();
    for (const [profile, { rec, at }] of queued) {
      const pid = rec.session.native.pid;
      if (pid === undefined || rec.session.status === "ended" || this.stopped) continue;
      const argv = await this.deps.raiser.commandLine(pid).catch(() => undefined);
      const launch = argv ? mirrorArgs(argv, rec.session.cwd, join(this.deps.dataDir, "claude")) : undefined;
      if (launch && !this.stopped) this.deps.profiles.mirror(profile, launch, at, rec.session.id);
    }
  }

  patch(rec: SessionRecord, patch: Partial<Session>, at = this.now()): void {
    const before = rec.session.native.pid;
    const terminalBefore = rec.session.native.terminal;
    // A harness that reports tokens but no cost gets one from the price table, when its model is known.
    if (patch.stats && patch.stats.cost === 0 && patch.stats.model && this.deps.pricer) {
      const cost = this.deps.pricer(patch.stats.model, patch.stats.tokens);
      if (cost !== undefined) patch = { ...patch, stats: { ...patch.stats, cost: Math.round(cost * 1e6) / 1e6 } };
    }
    Object.assign(rec.session, patch);
    rec.session.lastActivity = Math.max(rec.session.lastActivity, at);
    this.deps.store.sessions.update(rec.session);
    if (patch.native && patch.native.pid !== before) {
      this.event(rec, "status", { status: rec.session.status, ...(rec.session.native.pid !== undefined ? { pid: rec.session.native.pid } : {}) }, undefined, at);
    }
    this.broadcast(rec);
    // A process learned from a hook's ancestors may run below a terminal.
    if (patch.native && patch.native.pid !== before) this.terminalAbove(rec as LiveRecord);
    // A terminal taken may be the one a first prompt went into.
    if (rec.session.native.terminal && !sameTerminal(rec.session.native.terminal, terminalBefore)) this.claimTerminal(rec);
  }

  /** The permission mode a session is in: every one seen is kept, and a Claude session's shows as its `mode`. */
  noteMode(rec: SessionRecord, mode: string, at = this.now()): void {
    rec.permissionMode = mode;
    (rec.modesSeen ??= new Set()).add(mode);
    const known = rec.session.harness === "claude" ? permissionModeOf(mode) : undefined;
    if (known && known !== rec.session.mode) this.patch(rec, { mode: known }, at);
  }

  /**
   * A status, and for an idle session what it waits on. `waiting` is the harness's word, read
   * from its registry; a status from a hook leaves it as it is, since a hook does not say.
   * Anything but idle clears it. It is not stored: a restart reads it again. `said` is what
   * the hook that brought the status adds to its event (a Stop's last words) and the hook as
   * raw, so a turn's end is one event. True when the status changed and its event was recorded.
   */
  setStatus(rec: SessionRecord, status: SessionStatus, at = this.now(), opts?: { waiting: SessionWaiting | undefined }, said?: { payload: Record<string, unknown>; raw?: unknown }): boolean {
    const live = rec as LiveRecord;
    if (status === "ended") {
      this.end(rec, "status", at);
      return false;
    }
    // Only a resume brings an ended session back, never a status read underneath it.
    if (rec.session.status === "ended") return false;
    if (live.held && !live.held.settled) {
      // A prompt is being held: only the session's own hooks (PostToolUse, Stop, SessionEnd) can say it is gone.
      // A registry or rollout that reads busy or idle underneath changes nothing.
      rec.session.lastActivity = Math.max(rec.session.lastActivity, at);
      return false;
    }
    if (live.inputAsk && status === "idle") this.closeInput(live, "stopped");
    const waiting = status !== "idle" ? undefined : opts ? opts.waiting : rec.session.waiting;
    if (rec.session.status === status && stableStringify(rec.session.waiting ?? null) === stableStringify(waiting ?? null)) {
      rec.session.lastActivity = Math.max(rec.session.lastActivity, at);
      return false;
    }
    const was = rec.session.status;
    rec.session.status = status;
    if (waiting) rec.session.waiting = waiting;
    else delete rec.session.waiting;
    rec.session.lastActivity = Math.max(rec.session.lastActivity, at);
    this.deps.store.sessions.update(rec.session);
    this.event(rec, "status", { status, ...(waiting ? { waiting } : {}), ...(rec.session.native.pid !== undefined ? { pid: rec.session.native.pid } : {}), ...(said?.payload ?? {}) }, said?.raw, at);
    if (status === "idle" && was !== "idle") this.injections.rearm(rec.session.id);
    this.broadcast(rec);
    return true;
  }

  event(rec: SessionRecord, kind: SessionEventKind, payload: unknown, raw?: unknown, at = this.now()): SessionEvent {
    // The chat's own session's turns are the chat's messages already: its events are neither stored, recalled nor told.
    if (rec.session.role === "assistant") {
      if (at > rec.session.lastActivity) rec.session.lastActivity = at;
      this.broadcast(rec);
      if (kind === "tool_call") this.called(rec as LiveRecord, payload);
      return { session: rec.session.id, seq: -1, at, kind, payload };
    }
    const e = this.deps.store.sessionEvents.append({ session: rec.session.id, at, kind, payload, ...(raw !== undefined ? { raw } : {}) });
    if (at > rec.session.lastActivity) {
      rec.session.lastActivity = at;
      this.deps.store.sessions.update(rec.session);
    }
    if (rec.session.workspace) this.deps.workspaces.touch(rec.session.workspace, at);
    // The event itself goes out at once so a timeline can grow live; the debounced
    // `session.state` follows with the row.
    if (!this.stopped) {
      const { raw: _raw, ...wire } = e;
      this.deps.bus.emit("session.event", wire);
    }
    this.broadcast(rec);
    if (kind === "tool_call") this.called(rec as LiveRecord, payload);
    return e;
  }

  /** A call was recorded: a hook's result waiting for it follows it at once. */
  private called(rec: LiveRecord, payload: unknown): void {
    const id = payload !== null && typeof payload === "object" ? (payload as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || id === "") return;
    const calls = (rec.calls ??= new Set());
    calls.add(id);
    if (calls.size > RECENT_CALLS) calls.delete(calls.values().next().value!);
    this.flushResult(rec, id);
  }

  /** The adapter's catch-up read of a record's log, where it has one. */
  private readNow(rec: LiveRecord, adapter: HarnessAdapter | undefined, now: number): void {
    if (!adapter?.readNow || rec.session.status === "ended") return;
    try {
      adapter.readNow(rec, now);
    } catch (e) {
      this.log.warn("catch-up read failed", { id: rec.session.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** A hook's tool result waits for its call: recorded right after it, or once the hold is up, the log read once more first. */
  private holdResult(rec: LiveRecord, id: string, payload: Record<string, unknown>, raw: unknown, at: number): void {
    // The same id again: the first goes in now.
    this.flushResult(rec, id);
    const timer = setTimeout(() => {
      if (!rec.pendingResults?.has(id)) return;
      if (!this.stopped) this.readNow(rec, this.adapters.get(rec.session.harness as AttachedHarness), this.now());
      this.flushResult(rec, id);
    }, this.deps.resultHoldMs ?? RESULT_HOLD_MS);
    unref(timer);
    (rec.pendingResults ??= new Map()).set(id, { payload, raw, at, timer });
  }

  private flushResult(rec: LiveRecord, id: string): void {
    const p = rec.pendingResults?.get(id);
    if (!p) return;
    rec.pendingResults!.delete(id);
    clearTimeout(p.timer);
    this.event(rec, "tool_result", p.payload, p.raw, p.at);
  }

  /** Every result still waiting, recorded now: the record ends, or leaves its log behind. */
  private flushResults(rec: LiveRecord): void {
    for (const id of [...(rec.pendingResults?.keys() ?? [])]) this.flushResult(rec, id);
  }

  end(rec: SessionRecord, reason: string, at = this.now()): void {
    const live = rec as LiveRecord;
    if (rec.session.status === "ended" || live.draining) return;
    // The transcript's last lines are recorded before the end, and where they stop is where a
    // resume will be told apart from a finished session.
    const adapter = rec.session.native.transport === "acp" ? undefined : this.adapters.get(rec.session.harness as AttachedHarness);
    if (adapter?.drain) {
      live.draining = true;
      try {
        adapter.drain(rec, at);
      } catch (e) {
        this.log.warn("last tail pass failed", { id: rec.session.id, error: e instanceof Error ? e.message : String(e) });
      } finally {
        live.draining = false;
      }
    }
    // A result whose call the last pass did not find goes in without it.
    this.flushResults(live);
    // Its transcript's last lines say the conversation went on as a background job: its window
    // exiting is not its end, and the record waits for the job.
    if (rec.continuing) {
      this.log.info("session not ended: it goes on as a background job", { id: rec.session.id, reason, job: rec.continuing.to });
      return;
    }
    if (live.held) this.closeHeld(live, "stopped", "ended");
    if (live.inputAsk) this.closeInput(live, "stopped");
    rec.session.status = "ended";
    rec.session.endedAt = at;
    rec.session.lastActivity = Math.max(rec.session.lastActivity, at);
    delete rec.session.ask;
    this.deps.store.sessions.update(rec.session);
    for (const p of this.injections.pending(rec.session.id)) {
      const settled = this.injections.settle(p.ref, "unconfirmed");
      if (settled) this.event(rec, "notification", { type: "message", ref: p.ref, state: "unconfirmed" }, undefined, at);
    }
    this.event(rec, "ended", { reason }, undefined, at);
    this.log.info("session ended", { id: rec.session.id, harness: rec.session.harness, reason });
    this.broadcast(rec, true);
    // The terminal it held is free: its CLI is looked for again (one started anew in it kept its
    // title), and a daemon-hosted thread waiting for a terminal may take it.
    const term = rec.session.native.terminal;
    if (term && !this.stopped) {
      this.clis?.reconsider(term);
      this.relinkHosted();
    }
  }

  /**
   * `session.state` at most once per 250 ms per session, on the trailing edge. The ends and
   * the prompts go out at once: a client must not learn of them a tick late.
   */
  private broadcast(rec: SessionRecord, immediate = false): void {
    const id = rec.session.id;
    if (this.stopped) return;
    // Waiting is an idle session's alone, whichever way the status moved.
    if (rec.session.status !== "idle") delete rec.session.waiting;
    if (immediate) {
      const pending = this.broadcasts.get(id);
      if (pending) {
        clearTimeout(pending);
        this.broadcasts.delete(id);
      }
      this.tell(rec.session);
      return;
    }
    if (this.broadcasts.has(id)) return;
    const t = setTimeout(() => {
      this.broadcasts.delete(id);
      const current = this.byId.get(id);
      if (current) this.tell(current.session);
    }, BROADCAST_MS);
    unref(t);
    this.broadcasts.set(id, t);
  }

  /** A session's row as it stands: on the bus, or, the chat's own, to the assistant module alone. */
  private tell(session: Session): void {
    if (session.role === "assistant") this.assistant?.changed({ ...session });
    else this.deps.bus.emit("session.state", { ...session });
  }

  // --- queries ------------------------------------------------------------------------

  /** The live sessions of a partition, the machine's unless named. */
  list(filter: SessionListFilter = {}, part?: string): Session[] {
    return [...this.byId.values()]
      .filter((r) => r.session.status !== "ended" && this.inPart(r.session, part))
      .map((r) => ({ ...r.session }))
      .filter((s) => filter.node === undefined || s.node === filter.node)
      .filter((s) => filter.harness === undefined || s.harness === filter.harness)
      .filter((s) => filter.workspace === undefined || s.workspace === filter.workspace)
      .filter((s) => filter.profile === undefined || s.profile === filter.profile)
      .filter((s) => !filter.status || filter.status.length === 0 || filter.status.includes(s.status))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * The one-line fields the brain and the user may write. A session that ended before this
   * run is annotated in the store and announced from its row.
   */
  annotate(id: string, patch: { intent?: string; summary?: string; tags?: string[] }, part?: string): Session {
    const p: Partial<Session> = {};
    if (patch.intent !== undefined) p.intent = oneLine(patch.intent);
    if (patch.summary !== undefined) p.summary = oneLine(patch.summary, 500);
    if (patch.tags !== undefined) p.tags = patch.tags;
    const rec = this.byId.get(id);
    if (rec) {
      if (!this.inPart(rec.session, part)) throw new RpcError("not_found", `no session ${id}`);
      this.patch(rec, p);
      return { ...rec.session };
    }
    const stored = this.deps.store.sessions.get(id);
    if (!stored || !this.inPart(stored, part)) throw new RpcError("not_found", `no session ${id}`);
    const next: Session = { ...stored, ...p };
    this.deps.store.sessions.update(next);
    if (!this.stopped) this.deps.bus.emit("session.state", { ...next });
    return next;
  }

  /** A session of the machine's, or of the partition named. */
  get(id: string, part?: string): Session | undefined {
    const s = this.getAny(id);
    return s && this.inPart(s, part) ? s : undefined;
  }

  /** A session of any partition: for what follows it wherever it is. */
  getAny(id: string): Session | undefined {
    const rec = this.byId.get(id);
    return rec ? { ...rec.session } : this.deps.store.sessions.get(id);
  }

  history(id: string, opts: { before?: number; around?: number; limit?: number } = {}, part?: string): SessionEvent[] {
    if (!this.get(id, part)) throw new RpcError("not_found", `no session ${id}`);
    return this.deps.store.sessionEvents.history(id, { limit: opts.limit ?? 50, ...(opts.before !== undefined ? { before: opts.before } : {}), ...(opts.around !== undefined ? { around: opts.around } : {}) });
  }

  private must(id: string, part?: string): LiveRecord {
    const rec = this.byId.get(id);
    if (!rec || !this.inPart(rec.session, part)) throw new RpcError("not_found", `no session ${id}`);
    if (rec.session.status === "ended") throw new RpcError("conflict", `session ${id} has ended`);
    return rec;
  }

  // --- agent messaging: who is calling, and how it runs ---------------------------------------

  /** A live session of the machine's by its harness's own id: a Codex thread, a Claude session (aliases after `/clear` too). */
  live(harness: AttachedHarness, nativeId: string): Session | undefined {
    const rec = this.find(harness, nativeId);
    return rec && rec.session.status !== "ended" && this.inPart(rec.session) ? { ...rec.session } : undefined;
  }

  /** The live Claude session of the machine's whose messaging pipe this is. */
  byPipe(pipe: string): Session | undefined {
    for (const rec of this.byId.values()) if (rec.handles.pipe === pipe && rec.session.status !== "ended" && this.inPart(rec.session)) return { ...rec.session };
    return undefined;
  }

  /** The live session of the machine's whose root process this is. */
  byPid(pid: number): Session | undefined {
    const id = this.pids().get(pid);
    return id !== undefined ? this.get(id) : undefined;
  }

  /** The live session of the machine's in the tether terminal with this id, when one alone is. */
  byTerminalId(id: string): Session | undefined {
    const found = [...this.byId.values()].filter((r) => r.session.native.terminal?.id === id && r.session.status !== "ended" && this.inPart(r.session));
    return found.length === 1 ? { ...found[0]!.session } : undefined;
  }

  /** The session a spawn over ACP gave this nonce to its MCP server. */
  byNonce(nonce: string): Session | undefined {
    const id = this.nonces.get(nonce);
    return id !== undefined ? this.get(id) : undefined;
  }

  /** Names the session a spawn's nonce stands for, once its record is made. */
  noteNonce(nonce: string, session: string): void {
    this.nonces.set(nonce, session);
  }

  /**
   * Whether a live session runs with no permission prompts: a Claude session in bypass, a
   * Codex one whose turns run with approval `never` and full access. Undefined when nothing
   * has said yet, or for a harness whose mode cophylad cannot read.
   */
  bypasses(id: string): boolean | undefined {
    const rec = this.byId.get(id);
    if (!rec || rec.session.status === "ended") return undefined;
    if (rec.session.harness === "claude") {
      if (rec.permissionMode === undefined && rec.session.mode === undefined) return undefined;
      return rec.permissionMode === "bypassPermissions" || rec.session.mode === "bypassPermissions";
    }
    if (rec.session.harness === "codex") return rec.permissionMode === undefined ? undefined : rec.permissionMode === "never" && rec.sandbox === "danger-full-access";
    return undefined;
  }

  /** Whether a Claude session's settings take any session's message in at once, which one in bypass otherwise holds. */
  acceptsInbound(id: string): boolean {
    const rec = this.byId.get(id);
    if (!rec || rec.session.harness !== "claude") return false;
    return this.adapters.get("claude")?.acceptsInbound?.(rec) === true;
  }

  /** One workspace node's sessions, as its link serves them: the machine's own are none of its. */
  view(node: string): SessionsView {
    return {
      list: (filter = {}) => this.list(filter, node),
      get: (id) => this.get(id, node),
      history: (id, opts = {}) => this.history(id, opts, node),
      annotate: (id, patch) => this.annotate(id, patch, node),
      send: (id, text, opts = {}) => this.send(id, text, opts, node),
      stopSession: (id, opts = {}) => this.stopSession(id, opts, node),
      spawn: (params, opts) => this.spawn(params, opts, node),
      pids: () => this.pids(node),
    };
  }

  /**
   * Ends every live session of a workspace node that is going: the ones started for its
   * cluster stop; one the user started in the folder runs on, and its record ends.
   */
  async endAll(node: string): Promise<void> {
    for (const rec of [...this.byId.values()]) {
      if (rec.session.node !== node || rec.session.status === "ended") continue;
      try {
        await this.stopSession(rec.session.id, { as: "brain" }, node);
      } catch (e) {
        this.log.debug("a workspace node's session could not be stopped; its record ends", { id: rec.session.id, error: e instanceof Error ? e.message : String(e) });
      }
      this.end(rec, "stopped");
    }
  }

  /** A workspace node's data was taken away: its records, ended, leave memory too; the store keeps their tombstones. */
  forget(node: string): void {
    for (const [id, rec] of [...this.byId]) {
      if (rec.session.node !== node || rec.session.status !== "ended") continue;
      this.byId.delete(id);
      for (const [key, value] of [...this.byNative]) if (value === id) this.byNative.delete(key);
    }
  }

  // --- the chat's own session ---------------------------------------------------------------

  /** The assistant module comes up, or goes: the hooks and the changes of the chat's own session go to it. */
  setAssistant(hooks: AssistantHooks | undefined): void {
    this.assistant = hooks;
  }

  /** The chat's own session in its terminal, live, when there is one. A Codex thread of the chat's is no terminal's, and is not it. */
  assistantSession(): Session | undefined {
    for (const rec of this.byId.values()) if (rec.session.role === "assistant" && rec.session.harness === "claude" && rec.session.status !== "ended") return { ...rec.session };
    return undefined;
  }

  /** The context the chat's own session holds, in tokens, as its transcript's last turn counted it; none before its first. */
  assistantContext(): number | undefined {
    for (const rec of this.byId.values()) {
      if (rec.session.role !== "assistant" || rec.session.harness !== "claude" || rec.session.status === "ended") continue;
      // Between a cleared context and its transcript's first row the record holds no parser of its own.
      const parser = rec.parser as Partial<ClaudeTranscriptState> | undefined;
      return parser?.stats ? contextUsed(parser as ClaudeTranscriptState) : undefined;
    }
    return undefined;
  }

  /**
   * A native id the chat's own session runs under on a host that is not a terminal (a Codex
   * thread on cophylad's own app-server): a record met under it is the chat's, and one an
   * adapter met a moment too soon leaves the lists.
   */
  claimAssistant(harness: AttachedHarness, nativeId: string): void {
    this.assistantIds.add(nativeId);
    const rec = this.find(harness, nativeId) as LiveRecord | undefined;
    if (!rec || rec.session.role === "assistant") return;
    const was = { ...rec.session };
    rec.session.role = "assistant";
    rec.session.origin = "orchestrator";
    delete rec.session.workspace;
    this.deps.store.sessions.update(rec.session);
    if (!this.stopped) this.deps.bus.emit("session.state", { ...was, status: "ended", endedAt: this.now() });
  }

  /**
   * Starts the chat's own session: the Claude Code CLI itself in a tether terminal, under a
   * profile of the user's, with the command line the assistant module built and no window. Its
   * id is decided here, so the record is the chat's from the moment it is met; `resume` goes
   * on with a conversation by the id it last had. Nothing is typed: the module does that.
   */
  async spawnAssistant(p: AssistantSpawn): Promise<Session> {
    const tether = this.deps.tether;
    if (!tether?.available) throw new RpcError("unavailable", "tether is not on this node, and the chat's session runs in a terminal");
    const adapter = this.adapters.get("claude");
    const sessionId = p.resume ?? newSessionId();
    this.assistantIds.add(sessionId);
    const argv = [this.claudeBinary(p.profile), ...(p.resume ? ["--resume", sessionId] : ["--session-id", sessionId]), ...p.args];
    const env = { ...this.claudeSpawnEnv(p.profile), ...(p.env ?? {}) };
    const term = (await tether.spawn({ argv, cwd: p.cwd, env, labels: { app: "cophylad", [ASSISTANT_LABEL]: "1", "cophylad.session": sessionId } })).ref;
    adapter?.expect?.(sessionId, { intent: "Cophyla", terminal: term, expiresAt: this.now() + TERMINAL_EXPECT_MS });
    const timeoutMs = p.timeoutMs ?? this.deps.acp?.config.spawn_timeout_ms ?? 60000;
    const deadline = this.now() + timeoutMs;
    let met = false;
    const trusting = this.trustOwnFolder(term, () => met || this.now() >= deadline || tether.get(term)?.info.status === "exited");
    const rec = await this.awaitTerminalSession("claude", () => {
      const found = this.find("claude", sessionId);
      return found && found.session.status !== "ended" ? found : undefined;
    }, timeoutMs, term);
    met = true;
    await trusting;
    if (!rec) {
      adapter?.unexpect?.(sessionId);
      const screen = await tether.screen(term, "text").catch(() => undefined);
      const on = screen ? waitingOn(screen) : undefined;
      const why = on ? `it is waiting on ${on}` : screen ? `its screen ends:\n${tail(screen)}` : "its terminal cannot be read";
      await tether.kill(term).catch(() => undefined);
      throw new RpcError("unavailable", `the chat's session did not start within ${Math.round(timeoutMs / 1000)}s: ${why}`);
    }
    // A record kept from before it had a role: marked now.
    if (rec.session.role !== "assistant") {
      rec.session.role = "assistant";
      rec.session.origin = "orchestrator";
      delete rec.session.workspace;
      this.deps.store.sessions.update(rec.session);
    }
    this.log.info("the chat's session started in tether", { session: rec.session.id, terminal: term.id, resumed: p.resume !== undefined, profile: p.profile.id });
    return { ...rec.session };
  }

  /**
   * Answers the folder trust dialog of the chat's own session while it starts. The folder is
   * cophylad's own, made by it and holding nothing it did not write, and the terminal has no
   * window for the user to answer in, so an account that meets the folder for the first time
   * is answered here. Only that row is ever pressed: any other question is left as it is, and
   * the start fails saying what it waits on.
   */
  private async trustOwnFolder(term: TerminalRef, done: () => boolean): Promise<void> {
    const tether = this.deps.tether!;
    // The pointer is moved a row at a time and read again; Enter is pressed only once it is seen on the row that trusts.
    let moves = 0;
    while (!done()) {
      const screen = await tether.screen(term).catch(() => undefined);
      const dialog = screen ? trustDialog(screen) : undefined;
      if (!dialog || (!dialog.selected && moves >= TRUST_MOVES)) {
        await sleep(400);
        continue;
      }
      try {
        if (dialog.selected) {
          await tether.keys(term, ["Enter"]);
          this.log.info("the chat's own folder was trusted for its session", { terminal: term.id });
          // Read afresh before anything more is pressed: a dialog that has gone was answered.
          await sleep(600);
        } else {
          moves++;
          await tether.keys(term, [dialog.move]);
          await sleep(200);
        }
      } catch (e) {
        this.log.debug("the folder trust dialog was not answered", { terminal: term.id, error: e instanceof Error ? e.message : String(e) });
        await sleep(400);
      }
    }
  }

  /** A hook of the chat's own session, handed to the assistant module; what it answers, or nothing when it fails. */
  private async assistantHook(hook: NormalisedHook, info: { ref?: string } = {}): Promise<unknown> {
    if (!this.assistant) return {};
    try {
      return (await this.assistant.hook(hook, info)) ?? {};
    } catch (e) {
      this.log.warn("the assistant did not answer its session's hook", { event: hook.name, error: e instanceof Error ? e.message : String(e) });
      return {};
    }
  }

  // --- spawn and stop ---------------------------------------------------------------------

  /**
   * Starts a session in a workspace on this node, under a profile: the one named, else its
   * harness's usual account here. `sessions.launch` says where it runs: a terminal of its own,
   * which is the harness's own interface and is attached to like a session of the user's, or
   * a child speaking ACP with no window (a Muse session: on its own `muse serve` host). A node
   * with no terminal to open — a secondary with no display — starts it headless either way. A
   * Claude session starts with the profile's launch (a mode and flags), and the model the brain
   * named over the launch's own.
   */
  async spawn(params: SpawnParams, opts: SpawnOptions, part?: string): Promise<Session> {
    if (!this.acp) throw new RpcError("unsupported", "this daemon does not spawn sessions");
    const workspace = this.deps.workspaces.get(params.workspace, part);
    if (!workspace) throw new RpcError("not_found", `no workspace ${params.workspace}`);
    if (workspace.node !== (part ?? this.nodeId)) throw new RpcError("unsupported", `workspace ${params.workspace} is on another node`);
    // A folder lent to a workspace node is the other cluster's: what starts there would be theirs.
    if (part === undefined && this.deps.owners?.ownerOf(workspace.path) !== undefined) throw new RpcError("conflict", `${workspace.path} is lent to a workspace node: a session started there would be the other cluster's`);
    // A workspace node's sessions run headless: no window, no terminal of the owner's.
    const headless = part !== undefined;
    if (params.mode !== undefined && params.harness === "codex" && params.mode !== "default" && params.mode !== "bypassPermissions") throw new RpcError("unsupported", `a Codex session starts in default or bypassPermissions mode, not ${params.mode}`);
    if (params.mode !== undefined && params.harness !== "claude" && params.harness !== "codex") throw new RpcError("unsupported", `only a Claude Code or Codex session starts in a mode: ${params.harness} has none`);
    let profile: HarnessProfile | undefined;
    if (params.profile !== undefined) {
      profile = opts.profiles.get(params.profile);
      if (!profile) throw new RpcError("not_found", `no profile ${params.profile}`);
      if (profile.harness !== params.harness) throw new RpcError("invalid", `profile ${params.profile} is a ${profile.harness} profile`);
    } else {
      profile = opts.profiles.defaultFor(params.harness);
      if (!profile) throw new RpcError("unavailable", `no ${params.harness} profile on this node`);
    }
    if (profile.status === "missing") throw new RpcError("unavailable", `profile ${profile.name} has no configuration directory`);
    const model = params.model && "model" in params.model ? params.model.model.slice(params.model.model.indexOf("/") + 1) : undefined;
    if (params.harness === "muse") return this.spawnMuse(params, workspace, profile, model, headless);
    if (params.harness === "codex") return this.spawnCodex(params, workspace, profile, model, headless);
    const profileLaunch = params.harness === "claude" ? opts.profiles.launch?.(profile.id) : undefined;
    // The mode asked for replaces the launch's own; the launch's other flags stay.
    const launch = params.mode !== undefined ? { ...(profileLaunch ?? { args: [] }), mode: params.mode } : profileLaunch;
    if (params.harness === "claude" && this.config.launch === "terminal" && !headless) {
      const started = await this.spawnInTerminal(params, workspace, profile, launch, model);
      if (started) return started;
    }
    const rec = await this.acp.spawn({
      harness: params.harness,
      profile,
      cwd: workspace.path,
      workspace: workspace.id,
      prompt: params.prompt,
      ...(params.task !== undefined ? { task: params.task } : {}),
      ...(model !== undefined ? { model } : {}),
      // Over ACP a launch is its mode alone: the adapter is started, not the CLI.
      ...(launch?.mode ? { mode: launch.mode } : {}),
    });
    return { ...rec.session };
  }

  /**
   * Starts a Codex session: its CLI in a tether terminal when `sessions.launch` says a terminal,
   * tether is here and the profile's threads report through cophylad's hooks, which alone find
   * a thread in its terminal; headless over ACP otherwise, or when the terminal cannot be had.
   * Bypass permissions is the CLI's `--dangerously-bypass-approvals-and-sandbox`, and the ACP
   * adapter's full-access mode.
   */
  private async spawnCodex(params: SpawnParams, workspace: { id: string; path: string }, profile: HarnessProfile, model: string | undefined, headless: boolean): Promise<Session> {
    if (this.config.launch === "terminal" && this.deps.tether?.available && !headless) {
      if (await this.adapters.get("codex")?.hooked?.(profile.id)) {
        const started = await this.spawnCodexInTether(params, workspace, profile, model);
        if (started) return started;
      } else {
        this.log.warn("Codex has not trusted cophylad's hooks, which alone find a thread in a terminal; starting it headless", { profile: profile.id, workspace: workspace.id });
      }
    }
    const rec = await this.acp!.spawn({
      harness: "codex",
      profile,
      cwd: workspace.path,
      workspace: workspace.id,
      prompt: params.prompt,
      ...(params.task !== undefined ? { task: params.task } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(params.mode === "bypassPermissions" ? { mode: CODEX_ACP_FULL_ACCESS } : {}),
    });
    return { ...rec.session };
  }

  /**
   * Starts a Codex session in a tether terminal, running `codex` as the user does with the
   * first prompt as its argument (`codex/start.ts`), typed instead when the CLI is a batch
   * file. Codex picks the thread's id itself, at that first prompt: the terminal is expected,
   * and the record that takes it (by the CLI's pid, or by its mark when the shared app-server
   * daemon runs the thread) is the session, carrying what it was started for. A session that
   * does not arrive is reported with what its screen waits on, and left alone: the
   * expectation outlives the wait, so one answered later still arrives knowing its task.
   * `undefined` when tether cannot start it, and the caller starts it headless.
   */
  private async spawnCodexInTether(params: SpawnParams, workspace: { id: string; path: string }, profile: HarnessProfile, model: string | undefined): Promise<Session | undefined> {
    const tether = this.deps.tether!;
    const intent = capText(params.prompt.replace(/\s+/g, " ").trim(), 200);
    const title = sessionName(intent) || "cophylad session";
    const timeoutMs = this.deps.acp?.config.spawn_timeout_ms ?? 60000;
    const command = profile.exec?.command ?? Bun.which("codex") ?? "codex";
    const typed = runsUnderCmd(command);
    const argv = codexArgv({ command, ...(profile.exec ? { args: profile.exec.args } : {}), ...(model ? { model } : {}), bypass: params.mode === "bypassPermissions", ...(typed ? {} : { prompt: params.prompt }) });
    const since = this.now();
    let term: TerminalRef;
    try {
      term = (await tether.spawn({ argv, cwd: workspace.path, env: this.codexSpawnEnv(profile), labels: { app: "cophylad", "cophylad.spawn": ulid(since) } })).ref;
    } catch (e) {
      this.log.warn("tether could not start the Codex session; starting it headless", { workspace: workspace.id, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
    this.expectFirstPrompt(term, "codex", { origin: "orchestrator", workspace: workspace.id, ...(params.task !== undefined ? { task: params.task } : {}), intent }, since);
    const window = tether.windowOnStart
      ? await this.openWindow(term, title, workspace.path).catch((e: unknown) => {
          this.log.warn("no window opened on the session; it runs with none", { terminal: term.id, error: e instanceof Error ? e.message : String(e) });
          return undefined;
        })
      : undefined;
    const deadline = this.now() + timeoutMs;
    const rec = typed ? await this.typeIntoCodex(term, params.prompt, deadline) : await this.awaitTerminalSession("codex", () => this.claimedBy(term), timeoutMs, term);
    if (!rec) {
      const screen = await tether.screen(term, "text").catch(() => undefined);
      const on = screen ? codexWaitingOn(screen) : undefined;
      this.log.warn("a Codex session started in tether has not registered", { workspace: workspace.id, terminal: term.id, typed, waiting: on });
      const why = on ? `it is waiting on ${on}` : screen ? `its screen ends:\n${tail(screen)}` : "its terminal cannot be read";
      throw new RpcError("unavailable", `a Codex session started in ${workspace.path} did not register within ${Math.round(timeoutMs / 1000)}s: ${why}`);
    }
    this.log.info("codex session started in tether", { session: rec.session.id, terminal: term.id, host: term.host, window, workspace: workspace.id, bypass: params.mode === "bypassPermissions" });
    return { ...rec.session };
  }

  /**
   * Types a first prompt into a Codex CLI once its composer is up, and waits for the thread
   * it makes to take the terminal (`expectFirstPrompt`). The text pasted and Enter pressed, as
   * `submit` does; Enter once more when no thread came within a few seconds, since a TUI still
   * drawing can take the first as a newline, and an empty composer ignores it. The record, or
   * `undefined` when none came by the deadline.
   */
  private async typeIntoCodex(term: TerminalRef, text: string, deadline: number): Promise<SessionRecord | undefined> {
    const tether = this.deps.tether!;
    while (this.now() < deadline && !this.stopped) {
      if (tether.get(term)?.info.status === "exited") return undefined;
      const screen = await tether.screen(term).catch(() => undefined);
      if (screen && codexComposerUp(screen)) break;
      await sleep(TYPE_POLL_MS);
    }
    if (this.now() >= deadline || this.stopped) return undefined;
    await submit(await tether.client(term.host), term.id, text);
    const first = await this.awaitTerminalSession("codex", () => this.claimedBy(term), Math.min(TYPE_VERIFY_MS, Math.max(0, deadline - this.now())), term);
    if (first) return first;
    if (tether.get(term)?.info.status === "exited" || this.now() >= deadline) return undefined;
    await tether.keys(term, ["Enter"]).catch(() => undefined);
    this.log.info("Enter pressed again: no thread came of the first prompt yet", { terminal: term.id });
    return this.awaitTerminalSession("codex", () => this.claimedBy(term), Math.max(0, deadline - this.now()), term);
  }

  /**
   * Gives an agent CLI waiting at its first prompt in a terminal (`cliOf`: no session holds
   * it, a Codex or Muse CLI before its first prompt) that prompt, typed as the user would type
   * it, and waits for the session it becomes, which carries `task`. The CLI and its terminal
   * stay the user's, and so does the session.
   */
  async promptTerminal(id: string, text: string, opts: { task?: string } = {}): Promise<Session> {
    const tether = this.deps.tether;
    if (!tether?.available) throw new RpcError("unsupported", "tether is not on this node");
    const entry = tether.list().find((e) => e.ref.id === id);
    if (!entry || entry.info.status !== "running") throw new RpcError("not_found", `no running terminal ${id}`);
    const held = this.sessionOfTerminal(entry.ref);
    if (held) throw new RpcError("conflict", `terminal ${id} holds session ${held.id}: send to it instead`);
    const harness = this.clis?.markOf(entry.ref)?.harness;
    if (harness !== "codex" && harness !== "muse") throw new RpcError("conflict", `terminal ${id} holds no agent CLI waiting at its first prompt`);
    const ref = entry.ref;
    const cwd = entry.info.cwdReported || entry.info.cwd;
    // A terminal in a lent folder is the other cluster's.
    if (this.deps.owners?.ownerOf(entry.info.cwd) !== undefined) throw new RpcError("not_found", `no running terminal ${id}`);
    const workspace = this.deps.workspaces.list({ node: this.nodeId }).find((w) => pathKey(w.path) === pathKey(cwd))?.id;
    const intent = capText(text.replace(/\s+/g, " ").trim(), 200);
    const timeoutMs = this.deps.acp?.config.spawn_timeout_ms ?? 60000;
    const deadline = this.now() + timeoutMs;
    const what = { ...(workspace !== undefined ? { workspace } : {}), ...(opts.task !== undefined ? { task: opts.task } : {}), intent };
    let rec: SessionRecord | undefined;
    if (harness === "codex") {
      this.expectFirstPrompt(ref, "codex", { origin: "user", ...what });
      rec = await this.typeIntoCodex(ref, text, deadline);
    } else {
      const adapter = this.adapters.get("muse");
      if (!adapter?.expectTerminal) throw new RpcError("unsupported", "this daemon does not run Muse sessions");
      const pid = this.clis?.markOf(ref)?.pid ?? entry.info.pid;
      adapter.expectTerminal(ref, { ...(pid !== undefined ? { pid } : {}), ...what, expiresAt: this.now() + TERMINAL_EXPECT_MS });
      const typed = (await this.awaitMusePrompt(ref, deadline)) && (await this.typeFirstPrompt(ref, text, deadline));
      rec = typed ? await this.awaitTerminalSession("muse", () => adapter.claimed?.(ref), Math.max(0, deadline - this.now()), ref) : undefined;
    }
    if (!rec) {
      const screen = await tether.screen(ref, "text").catch(() => undefined);
      const on = screen ? (harness === "codex" ? codexWaitingOn(screen) : museWaitingOn(screen)) : undefined;
      this.log.warn("a first prompt typed into a waiting CLI made no session", { terminal: id, harness, waiting: on });
      const why = on ? `it is waiting on ${on}` : screen ? `its screen ends:\n${tail(screen)}` : "its terminal cannot be read";
      throw new RpcError("unavailable", `the ${harness} CLI in ${cwd} made no session within ${Math.round(timeoutMs / 1000)}s: ${why}`);
    }
    this.log.info("a waiting CLI took its first prompt", { session: rec.session.id, terminal: id, harness, task: opts.task });
    return { ...rec.session };
  }

  /**
   * A first prompt goes into a terminal for a harness that names its sessions itself (Codex):
   * the record that next takes the terminal is that session (`claimTerminal`). One per terminal.
   */
  private expectFirstPrompt(ref: TerminalRef, harness: AttachedHarness, what: { origin: "orchestrator" | "user"; workspace?: string; task?: string; intent?: string }, since = this.now()): void {
    this.firstPrompts = this.firstPrompts.filter((x) => !sameTerminal(x.ref, ref) && x.expiresAt > this.now());
    this.firstPrompts.push({ ...what, ref, harness, since, expiresAt: this.now() + TERMINAL_EXPECT_MS });
  }

  /** The record a first prompt into this terminal became, once one has. */
  private claimedBy(ref: TerminalRef): SessionRecord | undefined {
    const rec = this.firstPrompts.find((x) => sameTerminal(x.ref, ref))?.rec;
    return rec && rec.session.status !== "ended" ? rec : undefined;
  }

  /**
   * A record just took a terminal a first prompt went into: it is that session, and carries
   * what the prompt was for. The first record of the harness to take it whose thread the
   * prompt made, once: a thread older than the prompt (its UUIDv7 says when it was made) is
   * another CLI's, which a lone marked terminal in its folder can draw (`linkMarked`). One whose
   * expectation ran out claims nothing.
   */
  private claimTerminal(rec: SessionRecord): void {
    const term = rec.session.native.terminal;
    const x = this.firstPrompts.find((e) => sameTerminal(e.ref, term) && e.harness === rec.session.harness);
    if (!x || x.rec || x.expiresAt < this.now() || rec.session.status === "ended") return;
    const made = uuidv7Time(rec.session.native.id);
    if (made !== undefined && made < x.since - CLI_LEAD_MS) {
      this.log.info("a thread older than the first prompt took its terminal; not claimed", { session: rec.session.id, terminal: term!.id });
      return;
    }
    x.rec = rec;
    const s = rec.session;
    const patch: Partial<Session> = {};
    if (x.origin === "orchestrator" && s.origin !== "orchestrator") patch.origin = "orchestrator";
    if (x.workspace !== undefined && s.workspace !== x.workspace) patch.workspace = x.workspace;
    if (x.task !== undefined && s.task !== x.task) patch.task = x.task;
    if (x.intent !== undefined && s.intent === undefined) patch.intent = x.intent;
    if (Object.keys(patch).length > 0) this.patch(rec, patch);
    this.log.info("session met in the terminal its first prompt went into", { session: s.id, native: s.native.id, terminal: term!.id, origin: s.origin, task: s.task });
  }

  /** The environment a Codex CLI cophylad starts in tether gets: the daemon's own, scrubbed, under the profile (`codexEnv`). */
  private codexSpawnEnv(profile: HarnessProfile): Record<string, string> {
    const dir = codexEnv(profile.configDir, this.deps.home);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(this.deps.env ?? {}), ...dir.set, ...(profile.env as Record<string, string> | undefined) })) if (v !== undefined) env[k] = v;
    for (const k of dir.unset) delete env[k];
    return env;
  }

  /**
   * Starts a Claude session in a terminal of its own. The session id is settled here, so the
   * entry the harness writes is known to be this session and not one of the user's, and the
   * adapter is told to expect it before the terminal opens — a session registers in about a
   * second and a half, which is well inside a discovery pass. The prompt is never on the
   * command line, where a terminal's own parser would get at it first. `undefined` when no
   * terminal can be had, and the caller starts it headless instead.
   *
   * A session that never registers is reported but left alone: a harness waiting on its own
   * question — a directory it has not been trusted with, an account it wants signed in — is a
   * window the user can answer, and closing it would throw that away. cophylad never answers such
   * a question itself. The expectation outlives the wait by a long way, so a session unblocked
   * minutes later still arrives knowing what it was started for.
   */
  private async spawnInTerminal(params: SpawnParams, workspace: { id: string; path: string }, profile: HarnessProfile, launch: Launch | undefined, model: string | undefined): Promise<Session | undefined> {
    if (this.deps.tether?.available) {
      const started = await this.spawnInTether(params, workspace, profile, launch, model);
      if (started) return started;
    }
    const opener = await pickOpener(this.deps.terminals ?? []);
    if (!opener) {
      this.log.info("no terminal to open; starting the session headless", { workspace: workspace.id });
      return undefined;
    }
    const adapter = this.adapters.get("claude");
    const sessionId = newSessionId();
    const intent = capText(params.prompt.replace(/\s+/g, " ").trim(), 200);
    const timeoutMs = this.deps.acp?.config.spawn_timeout_ms ?? 60000;
    const command = profile.exec?.command ?? Bun.which("claude") ?? "claude";
    const env = claudeEnv(profile.configDir, this.deps.home);
    adapter?.expect?.(sessionId, {
      workspace: workspace.id,
      ...(params.task !== undefined ? { task: params.task } : {}),
      intent,
      expiresAt: this.now() + TERMINAL_EXPECT_MS,
    });
    try {
      await opener.open({
        argv: this.claudeCommand({ command, sessionId, intent, profile, cwd: workspace.path, launch: this.terminalLaunch(launch), model }),
        cwd: workspace.path,
        env: { ...env.set, ...(profile.env as Record<string, string> | undefined) },
        ...(env.unset.length > 0 ? { unset: env.unset } : {}),
        title: sessionName(intent) || "cophylad session",
      });
    } catch (e) {
      adapter?.unexpect?.(sessionId);
      this.log.warn("a terminal would not open; starting the session headless", { workspace: workspace.id, opener: opener.kind, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
    const rec = await this.awaitTerminalSession("claude", () => this.find("claude", sessionId), timeoutMs);
    if (!rec) {
      // The expectation stands: the window is open, and what it is waiting for can still be
      // answered, after which the session arrives knowing its workspace and task.
      this.log.warn("a terminal opened but its session has not registered; it may be waiting to be answered", { workspace: workspace.id, cwd: workspace.path, opener: opener.kind, native: sessionId });
      throw new RpcError("unavailable", `a terminal opened in ${workspace.path} but its session did not start within ${Math.round(timeoutMs / 1000)}s; the window may be waiting to be answered`);
    }
    this.log.info("session started in a terminal", { session: rec.session.id, opener: opener.kind, workspace: workspace.id, cwd: workspace.path });
    // The first prompt is the session's own task, not a message relayed into it, so it goes
    // in unprefixed and the harness records it as the user turn it is.
    if (adapter) await adapter.send(rec, params.prompt, `cophylad-start-${sessionId}`);
    return { ...rec.session };
  }

  /**
   * The command line a Claude session cophylad starts runs: its id and name, the profile's launch,
   * the model the brain named, and cophylad's settings file with the launch's own folded in.
   */
  private claudeCommand(o: { command: string; sessionId: string; intent: string; profile: HarnessProfile; cwd: string; launch: Launch | undefined; model: string | undefined }): string[] {
    const value = launchFlags(o.launch).settings;
    return [
      ...claudeArgv({ command: o.command, sessionId: o.sessionId, name: o.intent, ...(o.launch ? { launch: o.launch } : {}), ...(o.model ? { model: o.model } : {}) }),
      "--settings",
      cophyladSettings(this.deps.dataDir, o.profile.id, value !== undefined ? { settings: value, cwd: o.cwd } : undefined),
    ];
  }

  /**
   * A launch as a terminal's command line can carry it: a flag whose value holds a double
   * quote or a control character is left off, since `cmd` and a terminal's own parser would
   * mangle it. tether takes the arguments as they are.
   */
  private terminalLaunch(launch: Launch | undefined): Launch | undefined {
    if (!launch) return undefined;
    const args: string[] = [];
    for (const group of flagGroups(launch.args)) {
      if (group.some((w) => /["\x00-\x1f]/.test(w))) {
        this.log.warn("a launch flag cannot go on a terminal's command line; left off", { flag: group[0] });
        continue;
      }
      args.push(...group);
    }
    return { ...launch, args };
  }

  /**
   * Starts a Claude session in a tether terminal. It shows in the apps, as a terminal the
   * user opens there does; a window opens on it only when `[tether].window_on_start` says so,
   * or when the user raises it (`focus`). The session runs with cophylad's own settings file,
   * which turns on the plan dialog's clear-context row. Once it registers, the first prompt is
   * typed, as the user would type it. `undefined` when tether cannot start it, and the caller
   * tries a terminal of its own.
   */
  private async spawnInTether(params: SpawnParams, workspace: { id: string; path: string }, profile: HarnessProfile, launch: Launch | undefined, model: string | undefined): Promise<Session | undefined> {
    const tether = this.deps.tether!;
    const adapter = this.adapters.get("claude");
    const sessionId = newSessionId();
    const intent = capText(params.prompt.replace(/\s+/g, " ").trim(), 200);
    const title = sessionName(intent) || "cophylad session";
    const timeoutMs = this.deps.acp?.config.spawn_timeout_ms ?? 60000;
    const command = profile.exec?.command ?? Bun.which("claude") ?? "claude";
    const argv = this.claudeCommand({ command, sessionId, intent, profile, cwd: workspace.path, launch, model });
    const env = this.claudeSpawnEnv(profile);
    let term: TerminalRef;
    try {
      term = (await tether.spawn({ argv, cwd: workspace.path, env, labels: { app: "cophylad", "cophylad.session": sessionId } })).ref;
    } catch (e) {
      this.log.warn("tether could not start the session; opening a terminal of its own", { workspace: workspace.id, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
    adapter?.expect?.(sessionId, {
      workspace: workspace.id,
      ...(params.task !== undefined ? { task: params.task } : {}),
      intent,
      terminal: term,
      expiresAt: this.now() + TERMINAL_EXPECT_MS,
    });
    const window = tether.windowOnStart
      ? await this.openWindow(term, title, workspace.path).catch((e: unknown) => {
          this.log.warn("no window opened on the session; it runs with none", { terminal: term.id, error: e instanceof Error ? e.message : String(e) });
          return undefined;
        })
      : undefined;
    const rec = await this.awaitTerminalSession("claude", () => this.find("claude", sessionId), timeoutMs, term);
    if (!rec) {
      const screen = await tether.screen(term, "text").catch(() => undefined);
      const on = screen ? waitingOn(screen) : undefined;
      this.log.warn("a session started in tether has not registered", { workspace: workspace.id, terminal: term.id, native: sessionId, waiting: on });
      const why = on ? `it is waiting on ${on}` : screen ? `its screen ends:\n${tail(screen)}` : "its terminal cannot be read";
      throw new RpcError("unavailable", `a session started in ${workspace.path} did not register within ${Math.round(timeoutMs / 1000)}s: ${why}`);
    }
    this.log.info("session started in tether", { session: rec.session.id, terminal: term.id, host: term.host, window, workspace: workspace.id });
    // The first prompt is the session's own task: typed, it is the user turn it is.
    this.queueTyped(rec as LiveRecord, params.prompt, `cophylad-start-${sessionId}`);
    return { ...rec.session };
  }

  /**
   * A window on a session's terminal: the editor's panel when a VS Code window has the folder
   * open, else the platform's terminal as `[tether].window` says. Which one opened, or
   * `undefined` when none was to.
   */
  private async openWindow(term: TerminalRef, title: string, cwd: string): Promise<string | undefined> {
    const tether = this.deps.tether!;
    const editor = (this.deps.terminals ?? []).find((o) => o.kind === "vscode");
    if (editor && (await editor.available().catch(() => false))) {
      try {
        await editor.open({ argv: tether.attachArgv(term, title), cwd, env: {}, title });
        return "vscode";
      } catch (e) {
        this.log.debug("no editor window has the folder; opening the platform's", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (tether.window === "none") return undefined;
    return tether.openWindow(term, { title, cwd, terminal: tether.window });
  }

  /**
   * Waits for a session started in a terminal to register, discovering eagerly: a Claude
   * session by the id cophylad gave it, a Muse one as the adapter claims it for the terminal. A
   * tether terminal whose program exits meanwhile ends the wait.
   */
  private async awaitTerminalSession(harness: AttachedHarness, found: () => SessionRecord | undefined, timeoutMs: number, term?: TerminalRef): Promise<SessionRecord | undefined> {
    const adapter = this.adapters.get(harness);
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const rec = found();
      if (rec) return rec;
      await adapter?.tick(this.now()).catch(() => undefined);
      const after = found();
      if (after) return after;
      if (term && this.deps.tether?.get(term)?.info.status === "exited") return undefined;
      await new Promise((r) => unref(setTimeout(r, TERMINAL_POLL_MS)));
    }
    return undefined;
  }

  /**
   * Starts a Muse session: in a tether terminal, which is Muse's own interface, when
   * `sessions.launch` says a terminal and tether is here; headless on the profile's own
   * `muse serve` host otherwise, or when the terminal cannot be had.
   */
  private async spawnMuse(params: SpawnParams, workspace: { id: string; path: string }, profile: HarnessProfile, model: string | undefined, headless = false): Promise<Session> {
    const adapter = this.adapters.get("muse");
    if (!adapter?.headless) throw new RpcError("unsupported", "this daemon does not run Muse sessions");
    if (this.config.launch === "terminal" && this.deps.tether?.available && !headless) {
      if (await adapter.hooked?.(profile.id)) {
        const started = await this.spawnMuseInTether(adapter, params, workspace, profile, model);
        if (started) return started;
      } else {
        this.log.warn("Muse has not approved cophylad's hooks, which alone find a session in a terminal; starting it headless", { profile: profile.id, workspace: workspace.id });
      }
    }
    const rec = await adapter.headless.spawn({
      profile,
      cwd: workspace.path,
      workspace: workspace.id,
      prompt: params.prompt,
      ...(params.task !== undefined ? { task: params.task } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    return { ...rec.session };
  }

  /**
   * Starts a Muse session in a tether terminal, running `muse` as the user does, launcher and
   * all. Muse makes a session only at its first prompt, and picks its id itself: the prompt is
   * typed once the TUI shows its own, as the user would type it, and the adapter, told a
   * session is starting in the terminal, claims the one whose process runs below the
   * terminal's (its SessionStart hook says which). `undefined` when tether cannot start it,
   * and the caller starts it headless.
   */
  private async spawnMuseInTether(adapter: HarnessAdapter, params: SpawnParams, workspace: { id: string; path: string }, profile: HarnessProfile, model: string | undefined): Promise<Session | undefined> {
    const tether = this.deps.tether!;
    const intent = capText(params.prompt.replace(/\s+/g, " ").trim(), 200);
    const title = sessionName(intent) || "cophylad session";
    const timeoutMs = this.deps.acp?.config.spawn_timeout_ms ?? 60000;
    const key = ulid(this.now());
    const argv = [...museCommand(profile), ...(model ? ["--model", model] : [])];
    let term: TerminalRef;
    let pid: number | undefined;
    try {
      const started = await tether.spawn({ argv, cwd: workspace.path, env: this.museSpawnEnv(profile), labels: { app: "cophylad", "cophylad.spawn": key } });
      term = started.ref;
      pid = started.pid ?? tether.get(term)?.info.pid;
    } catch (e) {
      this.log.warn("tether could not start the Muse session; starting it headless", { workspace: workspace.id, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
    adapter.expectTerminal?.(term, {
      ...(pid !== undefined ? { pid } : {}),
      workspace: workspace.id,
      ...(params.task !== undefined ? { task: params.task } : {}),
      intent,
      expiresAt: this.now() + TERMINAL_EXPECT_MS,
    });
    const window = tether.windowOnStart
      ? await this.openWindow(term, title, workspace.path).catch((e: unknown) => {
          this.log.warn("no window opened on the session; it runs with none", { terminal: term.id, error: e instanceof Error ? e.message : String(e) });
          return undefined;
        })
      : undefined;
    const deadline = this.now() + timeoutMs;
    const typed = (await this.awaitMusePrompt(term, deadline)) && (await this.typeFirstPrompt(term, params.prompt, deadline));
    const rec = typed ? await this.awaitTerminalSession("muse", () => adapter.claimed?.(term), Math.max(0, deadline - this.now()), term) : undefined;
    if (!rec) {
      const screen = await tether.screen(term, "text").catch(() => undefined);
      const on = screen ? museWaitingOn(screen) : undefined;
      this.log.warn("a Muse session started in tether has not registered", { workspace: workspace.id, terminal: term.id, typed, waiting: on });
      const why = on ? `it is waiting on ${on}` : screen ? `its screen ends:\n${tail(screen)}` : "its terminal cannot be read";
      throw new RpcError("unavailable", `a Muse session started in ${workspace.path} did not register within ${Math.round(timeoutMs / 1000)}s: ${why}`);
    }
    this.log.info("muse session started in tether", { session: rec.session.id, terminal: term.id, host: term.host, window, workspace: workspace.id, key });
    return { ...rec.session };
  }

  /** Waits for a Muse TUI to show its prompt, empty. False when the terminal exits or the deadline passes first. */
  private async awaitMusePrompt(term: TerminalRef, deadline: number): Promise<boolean> {
    const tether = this.deps.tether!;
    while (this.now() < deadline && !this.stopped) {
      if (tether.get(term)?.info.status === "exited") return false;
      const screen = await tether.screen(term).catch(() => undefined);
      if (screen && musePromptInput(screen) === "") return true;
      await sleep(TYPE_POLL_MS);
    }
    return false;
  }

  /**
   * Types a Muse session's first prompt, as `typeNow` types a message, and sees it leave the
   * prompt: Enter is pressed once more when the text still sits there, as a TUI still starting
   * can swallow it. Nothing is receipted, since no session exists to receipt it until the
   * prompt makes one; its prompt hook records it as the user's turn.
   */
  private async typeFirstPrompt(term: TerminalRef, text: string, deadline: number): Promise<boolean> {
    const tether = this.deps.tether!;
    await submit(await tether.client(term.host), term.id, text);
    const verifyBy = Math.min(deadline, this.now() + TYPE_VERIFY_MS);
    while (this.now() < verifyBy && !this.stopped) {
      const screen = await tether.screen(term).catch(() => undefined);
      if (screen && musePromptInput(screen) === "") return true;
      await sleep(TYPE_POLL_MS);
    }
    const screen = await tether.screen(term).catch(() => undefined);
    if (screen && (musePromptInput(screen) ?? "") !== "") {
      await tether.keys(term, ["Enter"]);
      this.log.info("Enter pressed again: the first prompt was still in Muse's prompt", { terminal: term.id });
    }
    return true;
  }

  /** The environment a Muse process cophylad starts in tether gets: the daemon's own, scrubbed, under the profile (its `XDG_*` homes). */
  private museSpawnEnv(profile: HarnessProfile): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(this.deps.env ?? {}), ...(profile.env as Record<string, string> | undefined) })) if (v !== undefined) env[k] = v;
    return env;
  }

  /**
   * Ends a session cophylad started. One running headless is stopped through the adapter that
   * owns its child; one in a tether terminal is ended by its host, and the windows on it say
   * so; one started straight in a terminal has no child to stop, so its process is ended and
   * its window goes with it. A session of the user's is theirs: `unsupported`, unless the user
   * asked (`as: user`), when it ends with the terminal it runs in if cophylad started that
   * terminal, the shell of a New terminal the session was typed into included; in a window of
   * the user's own, its process ends and their shell stays. A Codex thread with no terminal
   * whose process is the app-server daemon, or may be, is `unsupported`: the daemon runs every
   * CLI's threads.
   */
  async stopSession(id: string, opts: { as?: "user" | "brain" } = {}, part?: string): Promise<void> {
    const rec = this.must(id, part);
    if (rec.session.native.transport === "acp") {
      if (!this.acp) throw new RpcError("unsupported", "only a session cophylad started can be stopped");
      await this.acp.stop(id);
      return;
    }
    const headless = this.adapters.get(rec.session.harness as AttachedHarness)?.headless;
    if (headless?.owns(rec)) {
      await headless.stop(rec);
      return;
    }
    if (rec.session.origin !== "orchestrator" && opts.as !== "user") throw new RpcError("unsupported", "only a session cophylad started can be stopped");
    if (rec.session.native.job !== undefined && rec.session.harness === "claude") {
      await this.stopJob(rec, rec.session.native.job);
      delete rec.continuing;
      this.end(rec, "stopped", this.now());
      return;
    }
    const term = rec.session.native.terminal;
    if (term && this.deps.tether?.available && (rec.session.origin === "orchestrator" || this.deps.tether.startedHere(term))) {
      try {
        await this.deps.tether.kill(term);
        this.end(rec, "stopped", this.now());
        return;
      } catch (e) {
        // The host has it no more: fall back to the process itself.
        this.log.debug("tether could not end the terminal", { session: id, terminal: term.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const pid = rec.session.native.pid;
    if (pid === undefined) throw new RpcError("unsupported", "the session's process is not known");
    // A Codex thread whose CLI is not known runs in the app-server daemon, which every CLI shares: never ended for one thread.
    if (rec.session.harness === "codex" && !rec.session.native.terminal) {
      const argv = rec.hostedBy ? undefined : await this.deps.raiser.commandLine(pid).catch(() => undefined);
      if (argv === undefined || isManagedDaemon(argv)) throw new RpcError("unsupported", "the session runs in Codex's shared app-server, and its CLI is not known");
    }
    try {
      if (this.deps.kill) this.deps.kill(pid);
      else process.kill(pid);
    } catch (e) {
      // Already gone: the next discovery pass would have ended the record anyway.
      this.log.debug("the session's process was already gone", { session: id, pid, error: e instanceof Error ? e.message : String(e) });
    }
    this.end(rec, "stopped", this.now());
  }

  /** Cancels the turn in flight of a spawned session. */
  cancelTurn(id: string): boolean {
    const rec = this.byId.get(id);
    const headless = rec ? this.adapters.get(rec.session.harness as AttachedHarness)?.headless : undefined;
    if (rec && headless?.owns(rec)) return headless.cancel(rec);
    return this.acp?.cancel(id) ?? false;
  }

  // --- permission mode ------------------------------------------------------------------

  /**
   * Puts a Claude session in a permission mode. One cophylad runs over ACP is set there; one in
   * a tether terminal has Shift+Tab pressed until the footer under its prompt names the mode.
   * `dontAsk` is off the cycle, and so is any other harness's session.
   */
  async setMode(id: string, mode: PermissionMode, part?: string): Promise<{ mode: PermissionMode }> {
    const rec = this.must(id, part);
    if (rec.session.harness !== "claude") throw new RpcError("unsupported", "only a Claude Code session's permission mode can be set");
    if (mode === "dontAsk") throw new RpcError("unsupported", "Shift+Tab never reaches don't-ask mode: a session is started in it or not at all");
    if (rec.session.native.transport === "acp") {
      if (!this.acp) throw new RpcError("unsupported", "no ACP adapter");
      if (mode === "bypassPermissions" && !rec.modesSeen?.has(mode)) throw new RpcError("unsupported", "bypassing permissions is offered only to a session started in it");
      await this.acp.setMode(id, mode);
      return { mode };
    }
    if (!this.typesInto(rec)) throw new RpcError("unsupported", "the session runs where cophylad cannot type: Shift+Tab in its own window changes its mode");
    const run = (rec.moding ?? Promise.resolve()).then(() => this.pressMode(rec, mode));
    rec.moding = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Presses Shift+Tab in a session's terminal until the footer names the mode, reading the
   * footer after each press rather than counting presses: the cycle holds bypassing
   * permissions only for a session whose launch opens it, and auto only on a model that has
   * it, so coming round to a mode already passed means the one asked for is not on offer. A
   * press the footer does not show within a moment is pressed again. Nothing is pressed while
   * an ask is open, whose dialog would take the key, or while no prompt shows; nor while the
   * session works when the way there passes a mode looser than both ends, where a tool call
   * made meanwhile could run unasked.
   */
  private async pressMode(rec: LiveRecord, mode: PermissionMode): Promise<{ mode: PermissionMode }> {
    const tether = this.deps.tether!;
    const term = rec.session.native.terminal;
    if (rec.session.status === "ended" || !term) throw new RpcError("conflict", "the session ended before its mode could be set");
    const asking = () => (rec.held !== undefined && !rec.held.settled) || rec.inputAsk !== undefined;
    if (asking()) throw new RpcError("conflict", "the session is asking something: its mode can be set once that is answered");
    const screenOf = () => tether.screen(term).catch(() => undefined);
    const first = await screenOf();
    const from = first ? footerMode(first) : undefined;
    if (!first || !from) throw new RpcError("conflict", "no prompt shows in the session's terminal (a dialog or a menu has it): its mode can be set once the prompt is back");
    this.noteMode(rec, from);
    if (from === mode) return { mode };
    const launch = await this.launchOf(rec);
    const bypass = !launch || launch.bypass || rec.modesSeen?.has("bypassPermissions") === true;
    let noAuto = autoUnavailable(first);
    if (mode === "bypassPermissions" && !bypass) throw new RpcError("unsupported", "bypassing permissions is offered only to a session started allowing it (--allow-dangerously-skip-permissions)");
    if (mode === "auto" && noAuto) throw new RpcError("unsupported", "auto mode is unavailable for the session's model");
    if (rec.session.status === "busy") {
      const looser = looserOnTheWay(from, mode, (m) => (m !== "bypassPermissions" || bypass) && (m !== "auto" || !noAuto));
      if (looser) throw new RpcError("conflict", `the session is working, and Shift+Tab reaches ${MODE_WORDS[mode]} from ${MODE_WORDS[from]} only through ${MODE_WORDS[looser]}, where a tool could run unasked: try again once its turn ends`);
    }
    const passed: PermissionMode[] = [from];
    let current = from;
    for (let presses = 0; presses < MODE_PRESSES; presses++) {
      if (asking()) throw new RpcError("conflict", `the session asked something while its mode was being set: it is in ${MODE_WORDS[current]} mode`);
      await tether.keys(term, ["S-Tab"]);
      let next: PermissionMode | undefined = current;
      for (const by = this.now() + MODE_PRESS_MS; next === current && this.now() < by; ) {
        await sleep(MODE_POLL_MS);
        const s = await screenOf();
        next = s ? footerMode(s) : undefined;
        if (s && autoUnavailable(s)) noAuto = true;
      }
      if (next === undefined) throw new RpcError("conflict", `the prompt left the session's terminal while its mode was being set: it was last in ${MODE_WORDS[current]} mode`);
      if (next === current) continue;
      current = next;
      this.noteMode(rec, current);
      if (current === mode) {
        this.log.info("session mode set", { session: rec.session.id, from, mode, presses: presses + 1 });
        return { mode };
      }
      if (passed.includes(current)) {
        const why = mode === "bypassPermissions" ? " (it was not started allowing it)" : mode === "auto" && noAuto ? " (its model has no auto mode)" : "";
        throw new RpcError("unsupported", `${MODE_WORDS[mode]} mode is not on offer in this session${why}: Shift+Tab goes round ${passed.map((m) => MODE_WORDS[m]).join(", ")}`);
      }
      passed.push(current);
    }
    throw new RpcError("unavailable", `the session's terminal did not take Shift+Tab: it is in ${MODE_WORDS[current]} mode`);
  }

  // --- send and receipts ----------------------------------------------------------------

  /**
   * Sends a message into a session. Into a Claude session in a tether terminal, the user's
   * words are typed, and so are the brain's when `[sessions].brain_sends` is `typed`; into a
   * Muse session in one, everyone's are, as Muse has no other way in. A session cophylad runs
   * headless is prompted through what runs it. Anything else goes over the harness's own
   * channel, which a Claude session reads as another agent's message.
   *
   * The session is prepared first, as asked: its context cleared (`/clear` typed, whatever
   * `brain_sends` says, since it is terminal control like Shift+Tab, and the new context
   * awaited), then its mode set, then the task it works on from now written on it; what it
   * cannot take is refused before anything is typed. The task goes on last, so the new
   * context's start is not heard as the task's session going idle. Empty text with any of
   * these only prepares.
   */
  async send(id: string, text: string, opts: SendOptions = {}, part?: string): Promise<{ status: "queued" | "held"; ref?: string }> {
    const rec = this.must(id, part);
    const prepares = opts.clear === true || opts.mode !== undefined || opts.task !== undefined;
    if (opts.clear === true || opts.mode !== undefined) this.canPrepare(rec, opts);
    if (opts.clear === true) await this.clearContext(rec);
    if (opts.mode !== undefined) await this.setMode(id, opts.mode, part);
    if (opts.task !== undefined && rec.session.task !== opts.task) this.patch(rec, { task: opts.task });
    if (prepares && text === "") return { status: "queued" };
    const agent = opts.from === "agent" ? opts.agent : undefined;
    if (opts.from === "agent" && !agent) throw new RpcError("invalid", "an agent's message says who it is from");
    // An agent's message reaches Muse typed, which has no other way in, and never a Claude session.
    const typed = this.typesInto(rec) && (agent ? rec.session.harness === "muse" : opts.from !== "brain" || this.config.brain_sends === "typed" || rec.session.harness === "muse");
    const wrapped = agent ? { info: agent, text } : undefined;
    const wire = agent ? envelope(agent, text) : text;
    if (typed) {
      const ref = `cophylad-${ulid(this.now())}`;
      this.queueTyped(rec, wire, ref, wrapped);
      this.log.info("message queued to be typed", { session: id, ref, from: opts.from ?? "user" });
      return { status: "queued", ref };
    }
    if (rec.session.native.transport === "acp") {
      if (!this.acp) throw new RpcError("unsupported", "no ACP adapter");
      const ref = `cophylad-${ulid(this.now())}`;
      const { sent } = this.acp.prompt(id, wire, ref, wrapped);
      void sent.then(() => {
        if (rec.session.status === "ended") return;
        // An agent's message was recorded as its turn as it went.
        if (!agent) this.event(rec, "notification", { type: "message", ref, state: "delivered" });
        this.log.info("prompt sent", { session: id, ref });
      });
      return { status: "queued", ref };
    }
    const adapter = this.adapters.get(rec.session.harness as AttachedHarness);
    if (!adapter) throw new RpcError("unsupported", `no adapter for ${rec.session.harness}`);
    if (adapter.headless?.owns(rec)) {
      const ref = `cophylad-${ulid(this.now())}`;
      await adapter.headless.prompt(rec, wire, ref, wrapped);
      if (rec.session.status !== "ended" && !agent) this.event(rec, "notification", { type: "message", ref, state: "delivered" });
      this.log.info("prompt sent", { session: id, ref });
      return { status: "queued", ref };
    }
    const ref = `cophylad-${ulid(this.now())}`;
    // An agent's envelope names its sender, so it needs no prefix of cophylad's.
    const body = agent ? wire : `${SEND_PREFIX}\n${text}`;
    const pending = this.injections.add({ ref, session: rec.session.id, harness: adapter.harness, text, body, at: this.now(), ...(agent ? { agent } : {}) });
    try {
      const r = await adapter.send(rec, body, ref);
      this.log.info("message sent", { session: id, ref, status: r.status });
      return { status: r.status, ref };
    } catch (e) {
      this.injections.settle(pending.ref, "withdrawn");
      throw e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Refuses a clear or a mode a session cannot take, before anything is done: only a Claude
   * session has either; a clear needs one cophylad types into, idle with nothing waiting and
   * nothing still being typed; a mode, one it types into or runs over ACP.
   */
  private canPrepare(rec: LiveRecord, opts: { clear?: boolean; mode?: WorkMode }): void {
    if (rec.session.status === "ended") throw new RpcError("conflict", "the session has ended");
    if (rec.session.harness !== "claude") throw new RpcError("unsupported", `only a Claude Code session's context is cleared or its mode set: this is a ${rec.session.harness} session`);
    if (opts.clear === true) {
      if (!this.typesInto(rec)) throw new RpcError("unsupported", "the session runs where cophylad cannot type: /clear in its own window clears its context");
      const s = rec.session;
      if (s.status !== "idle" || s.waiting !== undefined) {
        const doing = s.status === "busy" ? "working" : s.status === "needs_permission" ? "asking for permission" : s.status === "needs_input" ? "waiting for an answer" : `waiting on ${s.waiting?.on === "shell" ? "its shells" : "the user"}`;
        throw new RpcError("conflict", `the session is ${doing}: its context can be cleared once it is idle`);
      }
      const typing = (rec.toType ?? 0) > 0 || this.injections.pending(s.id).some((p) => p.typed === true);
      if (typing || (rec.held !== undefined && !rec.held.settled) || rec.inputAsk !== undefined) throw new RpcError("conflict", "a message is still going into the session: its context can be cleared once it has landed");
      return;
    }
    if (rec.session.native.transport !== "acp" && !this.typesInto(rec)) throw new RpcError("unsupported", "the session runs where cophylad cannot type: Shift+Tab in its own window changes its mode");
  }

  /**
   * Clears a Claude session's context from its terminal: `/clear` typed as a message is, and
   * the record followed to the process's new id (`rekey`). Fails when that has not happened
   * within `CLEAR_WAIT_MS` of the typing being queued.
   */
  private async clearContext(rec: LiveRecord): Promise<void> {
    const ref = `cophylad-clear-${ulid(this.now())}`;
    let release!: () => void;
    const cleared = new Promise<"cleared">((r) => (release = () => r("cleared")));
    (rec.clearWaiters ??= []).push(release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitMs = this.deps.clearWaitMs ?? CLEAR_WAIT_MS;
    const late = new Promise<"late">((r) => {
      timer = setTimeout(() => r("late"), waitMs);
      unref(timer);
    });
    this.queueTyped(rec, "/clear", ref);
    try {
      if ((await Promise.race([cleared, late])) === "late") {
        const withdrawn = this.injections.get(ref)?.state === "withdrawn";
        throw new RpcError("unavailable", withdrawn ? "/clear could not be typed into the session" : `the session's context was not cleared within ${Math.round(waitMs / 1000)}s of /clear`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      rec.clearWaiters = rec.clearWaiters?.filter((w) => w !== release);
      if (rec.clearWaiters?.length === 0) rec.clearWaiters = undefined;
    }
    this.log.info("context cleared for a message", { session: rec.session.id, native: rec.session.native.id });
  }

  /** Whether a message to this session is typed into its terminal rather than sent over the pipe. */
  private typesInto(rec: LiveRecord): boolean {
    const terminal = rec.session.native.terminal !== undefined && this.deps.tether?.available === true;
    if (rec.session.harness === "muse") return terminal;
    return rec.session.harness === "claude" && rec.session.native.transport === "pipe" && terminal;
  }

  /** What the prompt of a session's terminal holds, read the way its harness draws it. */
  private promptOf(rec: LiveRecord, screen: Parameters<typeof promptInput>[0]): string | undefined {
    return rec.session.harness === "muse" ? musePromptInput(screen) : promptInput(screen);
  }

  /** Types a message once those before it are typed; a message that cannot be typed is withdrawn. `agent`: an agent's, typed in its envelope. */
  private queueTyped(rec: LiveRecord, text: string, ref: string, agent?: { info: EnvelopeInfo; text: string }): void {
    const prev = rec.typing ?? Promise.resolve();
    rec.toType = (rec.toType ?? 0) + 1;
    rec.typing = prev
      .then(() => this.typeNow(rec, text, ref, agent))
      .catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        this.log.warn("message not typed", { session: rec.session.id, ref, error });
        const p = this.injections.get(ref);
        if (p) this.injections.settle(ref, "withdrawn");
        if (rec.session.status !== "ended" && !this.stopped) this.event(rec, "notification", { type: "message", ref, state: "withdrawn", message: error });
      })
      .finally(() => {
        rec.toType = Math.max(0, (rec.toType ?? 1) - 1);
      });
  }

  /**
   * Types one message into a session's terminal once it can take one: with no ask open, where
   * the keys would answer the dialog, and nothing half typed in the prompt, which is the
   * user's and would go along with it. A busy session is typed into anyway: the harness queues
   * what is sent while it works. Then the message is pasted, Enter pressed on its own, and its
   * landing awaited; when the text still sits in the prompt, Enter is pressed once more.
   */
  private async typeNow(rec: LiveRecord, text: string, ref: string, agent?: { info: EnvelopeInfo; text: string }): Promise<void> {
    const tether = this.deps.tether!;
    const deadline = this.now() + this.config.hook_timeout_s * 1000;
    let term: TerminalRef | undefined;
    for (;;) {
      // Not in the middle of Shift+Tab presses, whose passing modes the turn would start in.
      if (rec.moding) await rec.moding;
      if (rec.session.status === "ended" || this.stopped) throw new Error("the session ended before the message could be typed");
      term = rec.session.native.terminal;
      if (!term) throw new Error("the session's terminal is gone");
      const asking = (rec.held !== undefined && !rec.held.settled) || rec.inputAsk !== undefined;
      if (!asking && this.promptOf(rec, await tether.screen(term)) === "") break;
      if (this.now() > deadline) throw new Error("the session's prompt was never free to type into");
      await sleep(TYPE_POLL_MS);
    }
    const at = term;
    this.injections.add({ ref, session: rec.session.id, harness: rec.session.harness as AttachedHarness, text: agent?.text ?? text, body: text, at: this.now(), typed: true, ...(agent ? { agent: agent.info } : {}) });
    await submit(await tether.client(at.host), at.id, text);
    this.log.info("message typed", { session: rec.session.id, ref, terminal: at.id });
    // The next message waits only for the prompt to be free; this one's landing is watched apart.
    void this.watchTyped(rec, at, text, ref);
  }

  /**
   * Watches a typed message land: its prompt hook or transcript row settles it. A slash
   * command the CLI runs itself fires no prompt hook, so it has landed once the prompt lets go
   * of it. When nothing shows and the text still sits in the prompt, Enter was swallowed (a
   * TUI still starting does that) and is pressed once more.
   */
  private async watchTyped(rec: LiveRecord, at: TerminalRef, text: string, ref: string): Promise<void> {
    const tether = this.deps.tether!;
    const landed = () => this.injections.get(ref)?.state !== "queued";
    const slash = text.trimStart().startsWith("/");
    const until = this.now() + TYPE_VERIFY_MS;
    try {
      while (this.now() < until && !this.stopped) {
        if (landed()) return;
        if (slash && this.promptOf(rec, await tether.screen(at)) === "") {
          const p = this.injections.get(ref);
          if (p) this.delivered(rec, p);
          return;
        }
        await sleep(TYPE_POLL_MS);
      }
      if (landed() || this.stopped) return;
      if ((this.promptOf(rec, await tether.screen(at)) ?? "") !== "") {
        await tether.keys(at, ["Enter"]);
        this.log.info("Enter pressed again: the message was still in the prompt", { session: rec.session.id, ref });
      }
    } catch (e) {
      this.log.debug("a typed message could not be watched", { session: rec.session.id, ref, error: e instanceof Error ? e.message : String(e) });
    }
  }

  receiptByText(rec: SessionRecord, text: string, promptId?: string): boolean {
    const p = this.injections.matchText(rec.session.id, text, promptId);
    if (!p) return false;
    this.delivered(rec, p, promptId);
    return true;
  }

  receiptByRef(rec: SessionRecord, ref: string): boolean {
    const p = this.injections.get(ref);
    if (!p || p.session !== rec.session.id) return false;
    this.delivered(rec, p);
    return true;
  }

  /** Whether a prompt is one of cophylad's own: a message it sent, or any agent's envelope, which only cophylad writes. */
  isOwnText(rec: SessionRecord, text: string, promptId?: string): boolean {
    return text.includes(SEND_PREFIX) || text.includes(ENVELOPE_TAG) || this.injections.matchText(rec.session.id, text, promptId) !== undefined;
  }

  /**
   * An agent's message that showed up with no send waiting for it (one sent before a restart,
   * or past the sends' retention): recorded from its envelope as the agent's turn it is, once,
   * and never as the user's. False when the text holds no envelope.
   */
  agentEcho(rec: SessionRecord, text: string, raw?: unknown, at = this.now()): boolean {
    const read = readEnvelope(unpasted(text));
    if (!read) return false;
    if (this.agentSeen(rec.session.id, read.messageId)) return true;
    const notice = read.from.alias === NOTICE_FROM && read.from.harness === undefined;
    this.event(rec, "user_turn", { source: "agent", ...(notice ? {} : { from: read.from }), messageId: read.messageId, ...(read.replyTo ? { replyTo: read.replyTo } : {}), text: capText(read.text), late: true }, raw, at);
    return true;
  }

  /** Marks an agent's message seen in a session; true when it was already. */
  private agentSeen(session: string, messageId: string): boolean {
    let seen = this.agentMessages.get(session);
    if (!seen) this.agentMessages.set(session, (seen = new Set()));
    if (seen.has(messageId)) return true;
    seen.add(messageId);
    if (seen.size > AGENT_SEEN) seen.delete(seen.values().next().value!);
    return false;
  }

  /**
   * A sent message showed up in the session. A typed one is the user's own turn, and is
   * recorded as one, with the ref the sender holds; one sent over the pipe is a delivery.
   */
  private delivered(rec: SessionRecord, p: PendingSend, promptId?: string): void {
    if (promptId !== undefined && p.promptId === undefined) p.promptId = promptId;
    const settled = this.injections.settle(p.ref, "delivered");
    if (!settled) return;
    this.log.info("message delivered", { session: rec.session.id, ref: p.ref, typed: p.typed === true, ...(p.agent ? { agent: p.agent.messageId } : {}) });
    if (p.agent) {
      // Another agent's turn, with who it is from: never the user's, and nothing of what the session is for.
      if (!this.agentSeen(rec.session.id, p.agent.messageId)) this.event(rec, "user_turn", agentTurn(p.agent, p.text, p.ref));
    } else if (p.typed) {
      this.event(rec, "user_turn", { text: capText(p.text), source: "typed", ref: p.ref, ...(promptId !== undefined ? { promptId } : {}) });
      // A slash command the CLI runs itself (`/clear`) says nothing of what the session is for.
      if (rec.session.intent === undefined && p.text.trim() && !p.text.trimStart().startsWith("/")) this.patch(rec, { intent: oneLine(p.text) });
    } else {
      this.event(rec, "notification", { type: "message", ref: p.ref, state: "delivered" });
    }
  }

  private onReceiptTimeout(p: PendingSend): void {
    const rec = this.byId.get(p.session);
    if (!rec || this.stopped) return;
    if (p.harness === "codex") {
      if (rec.session.status === "busy" || rec.session.status === "needs_permission") {
        this.injections.hold(p);
        return;
      }
      const adapter = this.adapters.get("codex");
      const done = () => {
        const settled = this.injections.settle(p.ref, "withdrawn");
        if (settled) {
          this.log.info("message withdrawn: no receipt", { session: p.session, ref: p.ref });
          this.event(rec, "notification", { type: "message", ref: p.ref, state: "withdrawn" });
        }
      };
      if (adapter?.withdraw) adapter.withdraw(rec, p.ref).then(done, (e) => {
        this.log.warn("withdraw failed", { ref: p.ref, error: e instanceof Error ? e.message : String(e) });
        done();
      });
      else done();
      return;
    }
    const settled = this.injections.settle(p.ref, "unconfirmed");
    if (settled) this.event(rec, "notification", { type: "message", ref: p.ref, state: "unconfirmed" });
  }

  // --- focus ------------------------------------------------------------------------------

  /**
   * Raises the window a session is shown in. A session in a tether terminal is raised through
   * the window used on it most recently, and gets a window when none is on it; any other is
   * raised through the window that owns its process. With `open: false` no window is opened:
   * where none shows a session in tether, or a background job attached into one, the answer is
   * the command that attaches one (`attach`), for the user to run in a terminal of their own.
   */
  async focus(id: string, opts: { open?: false } = {}): Promise<{ attach?: string }> {
    const rec = this.must(id);
    const term = rec.session.native.terminal;
    const tether = this.deps.tether;
    if (term && tether?.available) {
      await tether.info(term).catch(() => undefined);
      for (const w of tether.windows(term)) {
        if (w.pid === undefined) continue;
        const r = await this.deps.raiser.raise(w.pid);
        if (r === "raised") return {};
        // a second window opened while the permission's prompt is still up would be one too many
        if (r === "waiting") throw raiseRefused(r);
      }
      if (opts.open === false) return { attach: tether.attachCommand(term) };
      const opened = await this.openWindow(term, rec.session.title ?? (sessionName(rec.session.intent ?? "") || this.where(rec)), rec.session.cwd);
      if (!opened) throw new RpcError("not_found", "no window shows the session, and [tether].window opens none");
      return {};
    }
    if (rec.session.native.job !== undefined && rec.session.harness === "claude") {
      const attached = await this.attachJob(rec, rec.session.native.job, opts);
      return opts.open === false ? { attach: tether!.attachCommand(attached) } : {};
    }
    const pid = rec.session.native.pid;
    if (pid === undefined) throw new RpcError("unsupported", "the session's process is not known");
    const r = await this.deps.raiser.raise(pid);
    if (r === "unsupported") throw new RpcError("unsupported", "raising windows is not supported on this platform");
    if (r === "denied" || r === "waiting") throw raiseRefused(r);
    if (r === "not_found") throw new RpcError("not_found", "no window owns the session's process");
    return {};
  }

  /**
   * A background job has no window of its own: `claude attach <job>` in a tether terminal is one
   * on it, and becomes the session's terminal, shown in the apps and typed into as the user.
   * A window opens on it when `[tether].window` says to, unless the caller opens none (`open: false`).
   */
  private async attachJob(rec: LiveRecord, job: string, opts: { open?: false } = {}): Promise<TerminalRef> {
    const tether = this.deps.tether;
    const profile = this.deps.profiles.get(rec.session.profile);
    if (!tether?.available || !profile) throw new RpcError("unsupported", `this node cannot open a terminal on a background job; run \`claude attach ${job}\``);
    const title = rec.session.title ?? (sessionName(rec.session.intent ?? "") || this.where(rec));
    const term = (await tether.spawn({ argv: [this.claudeBinary(profile), "attach", job], cwd: rec.session.cwd, env: this.claudeSpawnEnv(profile), labels: { app: "cophylad", "cophylad.attach": job } })).ref;
    if (rec.session.status !== "ended") this.patch(rec, { native: { ...rec.session.native, terminal: term } });
    this.log.info("background job attached in a terminal", { session: rec.session.id, job, terminal: term.id });
    if (opts.open === false) return term;
    await this.openWindow(term, title, rec.session.cwd).catch((e: unknown) => {
      this.log.warn("no window opened on the job's terminal", { terminal: term.id, error: e instanceof Error ? e.message : String(e) });
    });
    return term;
  }

  /**
   * Stops a background job the way its harness does (`claude stop <job>`): its daemon would
   * start a process that was merely killed again.
   */
  private async stopJob(rec: LiveRecord, job: string): Promise<void> {
    const profile = this.deps.profiles.get(rec.session.profile);
    if (!profile) throw new RpcError("unavailable", `no profile ${rec.session.profile} to stop the job under`);
    const argv = [this.claudeBinary(profile), "stop", job];
    const r = await (this.deps.run ?? runCommand)(argv, this.claudeSpawnEnv(profile), rec.session.cwd);
    if (r.code !== 0) throw new RpcError("unavailable", `claude stop ${job} failed: ${r.out.trim() || `exit ${r.code}`}`);
  }

  /**
   * The Claude binary for a subcommand: `claude <flags> attach` is taken for a prompt, so a
   * profile's own command counts only when it is the binary itself, not a wrapper that puts
   * flags before what it is given.
   */
  private claudeBinary(profile: HarnessProfile): string {
    const own = profile.exec?.command;
    if (own && CLAUDE_PROCESS.test(own.split(/[\\/]/).pop() ?? "")) return own;
    return Bun.which("claude") ?? own ?? "claude";
  }

  /** The environment a Claude process cophylad starts in tether gets: the daemon's own, scrubbed, under the profile. */
  private claudeSpawnEnv(profile: HarnessProfile): Record<string, string> {
    const dir = claudeEnv(profile.configDir, this.deps.home);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(this.deps.env ?? {}), ...dir.set, ...(profile.env as Record<string, string> | undefined) })) if (v !== undefined) env[k] = v;
    for (const k of dir.unset) delete env[k];
    return env;
  }

  // --- hooks --------------------------------------------------------------------------

  async onHook(harness: HookHarness, event: ClaudeHookEvent | CodexHookEvent | MuseHookEvent, meta: HookMeta): Promise<unknown> {
    const hook = normaliseHook(harness, event);
    const adapter = this.adapters.get(harness);
    if (!adapter) return {};
    // A new id from a session that just cleared its context is that session, whatever the registry says yet.
    let rec = (this.find(harness, hook.sessionId) ?? this.clearingFor(harness, hook)) as LiveRecord | undefined;
    // A hook from a spawned session (spike 08: the hook's id is the ACP session id): the ACP
    // stream is that session's source of truth, and a PermissionRequest answered with no
    // decision falls through to ACP.
    if (rec && rec.session.native.transport === "acp") {
      this.log.debug("hook for a spawned session ignored", { harness, event: hook.name, session: rec.session.id });
      return {};
    }
    const now = this.now();
    // A hook comes from a live process: a session that had ended is running again. Not a bare
    // Notification: an agents screen sends those under the id of a conversation it sent away.
    const revives = hook.name !== "SessionEnd" && hook.name !== "Notification";
    if (rec && rec.session.status === "ended" && revives) this.reviveOnHook(rec, hook, now);
    const resolved = adapter.onHook(hook, rec, meta);
    // A child's hook, or one from a session the adapter runs itself: no session of its own here.
    if (resolved === null) return {};
    rec = resolved as LiveRecord | undefined;
    if (!rec) {
      this.log.warn("hook for an unknown session", { harness, event: hook.name, session: hook.sessionId });
      return {};
    }
    // One the adapter found ended in the store.
    if (rec.session.status === "ended" && revives) this.reviveOnHook(rec, hook, now);
    if (rec.session.status === "ended" && hook.name === "Notification") return {};
    rec.hooks = (rec.hooks ?? 0) + 1;
    const raw = rawIfSmall(hook.raw);
    if (hook.permissionMode) {
      this.noteMode(rec, hook.permissionMode, now);
      // A planning session will ask to leave plan mode: read what it was started with now,
      // so the ask need not wait on it.
      if (hook.permissionMode === "plan") void this.launchOf(rec);
    }
    if (hook.transcriptPath && rec.session.transcript?.path !== hook.transcriptPath) this.patch(rec, { transcript: { path: hook.transcriptPath } }, now);

    // Any event past an Elicitation means the terminal answered it.
    if (rec.inputAsk && hook.name !== "Elicitation") this.closeInput(rec, "stopped");
    const own = rec.session.role === "assistant";

    switch (hook.name) {
      case "SessionStart": {
        const patch: Partial<Session> = {};
        if (hook.title && rec.session.title === undefined) patch.title = hook.title;
        if (Object.keys(patch).length) this.patch(rec, patch, now);
        // A session that starts again while it works (a context cleared by its plan's row, a
        // compaction) is still at it: its record's status is what the event says, not idle.
        const status = rec.session.status === "busy" ? "busy" : "idle";
        this.event(rec, "status", { status, source: hook.source }, raw, now);
        this.setStatus(rec, status, now);
        // The chat's own session is told the situation as it starts.
        return own ? this.assistantHook(hook) : {};
      }
      case "UserPromptSubmit": {
        const prompt = hook.prompt ?? "";
        // Which message of cophylad's own the prompt is, read before its receipt settles it.
        const sent = own ? this.injections.matchText(rec.session.id, prompt, hook.promptId) : undefined;
        if (!this.receiptByText(rec, prompt, hook.promptId)) {
          if (this.isOwnText(rec, prompt, hook.promptId)) {
            if (!this.agentEcho(rec, prompt, raw, now)) this.event(rec, "notification", { type: "message", state: "delivered", text: capText(prompt) }, raw, now);
          } else {
            this.event(rec, "user_turn", { text: capText(prompt), source: "hook" }, raw, now);
            if (rec.session.intent === undefined && prompt.trim()) this.patch(rec, { intent: oneLine(prompt) }, now);
          }
        }
        this.setStatus(rec, "busy", now);
        return own ? this.assistantHook(hook, sent ? { ref: sent.ref } : {}) : {};
      }
      case "PermissionRequest":
        return this.holdPermission(rec, hook, meta, raw, now);
      case "Elicitation":
        return this.openInput(rec, hook, raw, now);
      case "PostToolUse":
      case "PostToolUseFailure": {
        const key = toolKey(hook.toolName, hook.toolInput);
        // A sub-agent's tool is in its own transcript: the session's never records it a second time.
        if (!hook.agentId) rec.hookTools.set(hook.toolUseId ?? key, now);
        if (rec.held && !rec.held.settled && (rec.held.key.endsWith(key) || this.sameQuestions(rec.held, hook))) this.closeHeld(rec, "terminal");
        // What the log holds before this result, its call included, is recorded first; the
        // result's own row there, if written yet, is skipped by the mark above.
        this.readNow(rec, adapter, now);
        const input = summariseValue(hook.toolInput, TOOL_CALL_CAP);
        const result = summariseValue(toolResultText(hook.harness, hook.toolName, hook.toolResponse, hook.error), TOOL_RESULT_CAP);
        const payload = {
          tool: hook.toolName,
          ...(hook.toolUseId ? { id: hook.toolUseId } : {}),
          input: input.value,
          result: result.value,
          ...(result.truncated ? { truncated: true } : {}),
          ...(hook.name === "PostToolUseFailure" ? { isError: true } : {}),
        };
        // Claude writes a call's row to its transcript with the result's, just after the hook:
        // the result waits for its call, unless a sub-agent ran it or the call is in already.
        const waits = hook.harness === "claude" && hook.toolUseId !== undefined && !hook.agentId && rec.session.transcript !== undefined && !rec.calls?.has(hook.toolUseId);
        if (waits) this.holdResult(rec, hook.toolUseId!, payload, raw, now);
        else this.event(rec, "tool_result", payload, raw, now);
        if (rec.session.status !== "needs_permission" && rec.session.status !== "needs_input") this.setStatus(rec, "busy", now);
        if (own) void this.assistantHook(hook);
        return {};
      }
      case "Notification": {
        this.event(rec, "notification", { type: hook.notificationType ?? "notification", message: hook.message }, raw, now);
        if (hook.notificationType === "permission_prompt" && !(rec.held && !rec.held.settled)) this.setStatus(rec, "needs_permission", now);
        else if (hook.notificationType === "idle_prompt") this.setStatus(rec, "idle", now);
        return {};
      }
      case "Stop": {
        // The turn ended, so a prompt still held was answered in the terminal.
        if (rec.held && !rec.held.settled) this.closeHeld(rec, "stopped", "idle");
        const stopped = rec;
        const hooks = rec.hooks;
        const settle = (waiting: SessionWaiting | undefined) => {
          if (this.stopped || stopped.session.status === "ended") return;
          // Room for an agent's closing report whole: the brain's wake carries it, and one it had to cut sends it to read the history.
          const words = hook.lastAssistantMessage ? { lastAssistantMessage: capText(hook.lastAssistantMessage, 2000) } : {};
          // One event for the turn's end: the status it brings, with the last words. A hook since
          // (the next turn's prompt) says more than this one did, and a status the registry read
          // first changes nothing: the Stop's own event still carries the words.
          if (stopped.hooks === hooks && this.setStatus(stopped, "idle", now, adapter.afterStop ? { waiting } : undefined, { payload: words, raw })) return;
          this.event(stopped, "status", { status: "idle", ...(waiting ? { waiting } : {}), ...words }, raw, now);
        };
        // Idle, or waiting on its own shells or on a dialog: the harness says which about as
        // the hook fires, and a session still said to be busy is waited for, the hook answered meanwhile.
        // The chat's own session ended its turn: its last words are the reply.
        if (own) void this.assistantHook(hook);
        const waiting = adapter.afterStop?.(rec);
        if (waiting instanceof Promise) {
          void waiting.then(settle, (e: unknown) => {
            this.log.debug("the status after a Stop was not read", { session: stopped.session.id, error: e instanceof Error ? e.message : String(e) });
            settle(undefined);
          });
        } else settle(waiting);
        return {};
      }
      case "SessionEnd": {
        // A late hook under an id the record has already left behind ends nothing.
        if (hook.sessionId !== rec.session.native.id) return {};
        this.event(rec, "notification", { type: "session_end", reason: hook.reason }, raw, now);
        if (hook.reason === "clear" && !rec.clearing) {
          // The process goes on under a new id: the record waits for it.
          const cleared = rec;
          rec.clearing = setTimeout(() => {
            cleared.clearing = undefined;
            if (cleared.session.native.id === hook.sessionId) this.end(cleared, "clear", this.now());
          }, this.deps.clearGraceMs ?? CLEAR_GRACE_MS);
          unref(rec.clearing);
          return {};
        }
        this.end(rec, hook.reason ?? "exit", now);
        return {};
      }
      default:
        this.event(rec, "notification", { type: hook.name }, raw, now);
        return {};
    }
  }

  /** The process behind the hook is not known yet: the adapter looks for it, and until then the record has none. */
  private reviveOnHook(rec: LiveRecord, hook: NormalisedHook, now: number): void {
    const s = rec.session;
    this.revive(rec, { harness: s.harness as AttachedHarness, nativeId: s.native.id, profile: s.profile, cwd: s.cwd, transport: s.native.transport, status: hook.name === "SessionStart" ? "idle" : "busy" }, now);
  }

  // --- asks -----------------------------------------------------------------------------

  private foldKey(hook: NormalisedHook): string {
    return [hook.harness, hook.sessionId, hook.name, hook.promptId ?? ""].join("\u0000") + "\u0000" + toolKey(hook.toolName, hook.toolInput);
  }

  /**
   * A PermissionRequest is held until an ask settles it: a permission ask for a tool, or, for
   * an `AskUserQuestion`, one choice ask per question opened in turn, the answers released
   * together in the tool's input.
   */
  private holdPermission(rec: LiveRecord, hook: NormalisedHook, meta: HookMeta, raw: unknown, now: number): Promise<unknown> {
    const key = this.foldKey(hook);
    let held = rec.held;
    if (held && !held.settled && held.key === key && now - held.openedAt <= FOLD_MS) {
      this.log.debug("duplicate PermissionRequest joined the open ask", { session: rec.session.id, ask: held.ask.id });
      return this.waitHeld(rec, held, meta);
    }
    if (held && !held.settled) this.closeHeld(rec, "stopped");
    const list = hook.toolName === "AskUserQuestion" ? questionsFromAskUserQuestion(hook.toolInput) : undefined;
    if (list) {
      const questions: HeldQuestions = {
        list,
        index: 0,
        toolInput: hook.toolInput as Record<string, unknown>,
        key: stableStringify((hook.toolInput as Record<string, unknown>)["questions"]),
        deadline: now + this.config.hook_timeout_s * 1000,
        out: { answers: {}, annotations: {} },
      };
      held = this.openHeldAsk(rec, key, this.questionAsk(rec, questions, now), "needs_input", { tool: hook.toolName, question: 1, of: list.length }, raw, now, questions);
      return this.waitHeld(rec, held, meta);
    }
    const plan = planOf(hook.toolName, hook.toolInput);
    if (plan !== undefined) return this.holdPlan(rec, hook, meta, raw, key, plan);
    const shape = permissionAsk(hook.toolName, hook.toolInput, this.where(rec), DETAIL_CHARS);
    held = this.openHeldAsk(rec, key, this.permissionInput(rec, shape, now), "needs_permission", { tool: hook.toolName }, raw, now);
    return this.waitHeld(rec, held, meta);
  }

  /**
   * An `ExitPlanMode`. Its ask offers the rows the terminal shows, and which "Yes, and …" row
   * that is depends on what the session was started with, so the ask waits for that to be
   * read (it usually was, when the session went into plan mode). A duplicate that arrived
   * meanwhile joins the ask the first one opens; a request given up meanwhile opens none.
   */
  private async holdPlan(rec: LiveRecord, hook: NormalisedHook, meta: HookMeta, raw: unknown, key: string, plan: string): Promise<unknown> {
    const launch = await this.launchOf(rec);
    const now = this.now();
    if (meta.signal?.aborted || rec.session.status === "ended") return {};
    const open = rec.held;
    if (open && !open.settled && open.key === key && now - open.openedAt <= FOLD_MS) return this.waitHeld(rec, open, meta);
    if (open && !open.settled) this.closeHeld(rec, "stopped");
    const goOn = goOnMode(launch, rec.modesSeen);
    const context = rec.session.stats?.context;
    const inPlace = this.typesInto(rec) && launch?.clearRow === true;
    const offer: PlanOffer = {
      goOn,
      clear: inPlace || this.canStartFresh(rec),
      inPlace,
      ...(context && context.limit > 0 ? { used: Math.max(0, Math.min(100, Math.round((context.used / context.limit) * 100))) } : {}),
    };
    const shape = permissionAsk(hook.toolName, hook.toolInput, this.where(rec), DETAIL_CHARS, offer);
    const input = this.permissionInput(rec, shape, now);
    // A plan is answered with what to change as often as with yes or no.
    input.allowsText = true;
    const held = this.openHeldAsk(rec, key, input, "needs_permission", { tool: hook.toolName }, raw, now, undefined, undefined, { text: plan, input: hook.toolInput, goOn, inPlace });
    return this.waitHeld(rec, held, meta);
  }

  private where(rec: LiveRecord): string {
    return rec.session.title ?? rec.session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? rec.session.cwd;
  }

  private permissionInput(rec: LiveRecord, shape: { title: string; detail: string; options: AskInput["options"] }, now: number): AskInput {
    return {
      type: "permission",
      source: { kind: "harness", session: rec.session.id },
      title: shape.title,
      detail: shape.detail,
      options: shape.options,
      answerableBy: ["user", "brain"],
      expiresAt: now + this.config.hook_timeout_s * 1000,
    };
  }

  /**
   * What a Claude session was started with: its flags, read from its process's command line,
   * and the settings files it read. Read once per pid; `undefined` for any other harness, or
   * when the read fails.
   */
  private launchOf(rec: LiveRecord): Promise<ClaudeLaunch | undefined> {
    if (rec.session.harness !== "claude") return Promise.resolve(undefined);
    const pid = rec.session.native.pid;
    if (rec.launch && rec.launch.pid === pid) return rec.launch.read;
    const configDir = this.deps.profiles.get(rec.session.profile)?.configDir;
    const cwd = rec.session.cwd;
    const read = (async () => {
      const argv = pid !== undefined ? await this.deps.raiser.commandLine(pid) : undefined;
      return readLaunch({ ...(argv ? { argv } : {}), ...(configDir ? { configDir } : {}), cwd });
    })().catch((e: unknown) => {
      this.log.warn("launch not read", { session: rec.session.id, pid, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    });
    rec.launch = { pid, read };
    return read;
  }

  /** A plan can go on in a fresh session: cophylad spawns Claude sessions, under this one's profile. */
  private canStartFresh(rec: LiveRecord): boolean {
    const profile = this.deps.profiles.get(rec.session.profile);
    return this.acp !== undefined && rec.session.harness === "claude" && profile !== undefined && profile.status !== "missing";
  }

  /**
   * "Yes, clear context": the CLI clears a context only from its own dialog, so the plan goes
   * on in a session cophylad starts in the same directory, under the same profile and in the
   * mode the row named, with the plan as its first message; the old session's turn ends. The
   * task the old session worked on goes with the plan: the new one carries it out, and the
   * old one only planned. When no session can be started, the plan goes on where it is, in
   * that mode.
   */
  private async buildInFreshSession(rec: LiveRecord, plan: HeldPlan, answer: AskAnswer): Promise<Record<string, unknown>> {
    try {
      const profile = this.deps.profiles.get(rec.session.profile);
      if (!this.acp || !profile) throw new Error("this node cannot start a session under the profile");
      // the fresh session is on the node this one is on: its workspace's
      if (!rec.session.workspace) await this.deps.workspaces.settle(rec.session.cwd);
      const workspace = rec.session.workspace ?? this.deps.workspaces.fromSession(rec.session.cwd, rec.session.node).id;
      const fresh = await this.acp.spawn({
        harness: "claude",
        profile,
        cwd: rec.session.cwd,
        workspace,
        prompt: freshPlanPrompt(plan.text, rec.session.transcript?.path, answer.text?.trim() || undefined),
        mode: plan.goOn,
        ...(rec.session.task !== undefined ? { task: rec.session.task } : {}),
      });
      if (rec.session.task !== undefined) {
        delete rec.session.task;
        this.patch(rec, {});
      }
      this.event(rec, "notification", { type: "plan_continued", session: fresh.session.id, mode: plan.goOn, message: "The plan is being built in a new session with a clear context" });
      this.log.info("plan continues in a fresh session", { session: rec.session.id, fresh: fresh.session.id, mode: plan.goOn });
      return handedOffDecision();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn("fresh session not started; the plan goes on in its own", { session: rec.session.id, mode: plan.goOn, error });
      this.event(rec, "notification", { type: "plan_continued", mode: plan.goOn, message: `A new session could not start, so the plan is built here: ${error}` });
      return permissionDecision({ ...answer, option: goOnOption(plan.goOn) }, plan);
    }
  }

  /**
   * "Yes, clear context", pressed in the session's own dialog. The hook is released empty
   * first, so the dialog is there whether or not the CLI draws it while the hook is held. The
   * CLI draws it while the hook is held and drops the keys pressed before it has taken the
   * hook's answer in, so the press waits a moment, and counts only once the row has left the
   * screen; a row still there is pressed again, the screen read afresh first, so a key never
   * lands in the prompt that follows. The row's digit is read from the screen rather than
   * assumed, pressed, seen selected, and confirmed with Enter. The CLI then clears the
   * context, sets the mode, and sends its own first message, in the terminal the user is
   * watching, and the record follows it to its new id. A note given with the answer is typed
   * after it, as the user's. When the row is not on the screen, the plan goes on in its own
   * context by the row that names the same mode, and when there is no dialog at all it is left
   * to the terminal.
   */
  private async pressClearRow(rec: LiveRecord, held: Held, plan: HeldPlan, answer: AskAnswer): Promise<void> {
    const tether = this.deps.tether!;
    const term = rec.session.native.terminal;
    this.release(rec, held, {}, "busy");
    if (!term) return;
    const screenOf = () => tether.screen(term).catch(() => undefined);
    const deadline = this.now() + DIALOG_WAIT_MS;
    let screen = await screenOf();
    while (screen && !clearContextRow(screen) && dialogRows(screen).length === 0 && this.now() < deadline) {
      await sleep(150);
      screen = await screenOf();
    }
    const row = screen ? clearContextRow(screen) : undefined;
    if (!row) {
      const go = screen ? dialogRows(screen).find((r) => r.label.startsWith(goOnLabel(plan.goOn))) : undefined;
      if (go) {
        await tether.keys(term, [String(go.digit), "Enter"]);
        this.event(rec, "notification", { type: "plan_continued", mode: plan.goOn, message: "The terminal offered no clear context, so the plan is built here" });
      } else {
        this.event(rec, "notification", { type: "plan_continued", mode: plan.goOn, message: "The plan waits for an answer in its terminal" });
      }
      this.log.warn("no clear-context row on the screen", { session: rec.session.id, pressed: go?.digit });
      return;
    }
    await sleep(DIALOG_SETTLE_MS);
    let pressed = false;
    for (let attempt = 1; attempt <= DIALOG_TRIES && !pressed; attempt++) {
      // Afresh each time: a row that has gone since was pressed, and nothing more is typed.
      const now = await screenOf();
      const current = now ? clearContextRow(now) : undefined;
      if (!current) {
        pressed = attempt > 1;
        break;
      }
      await tether.keys(term, [String(current.digit)]);
      const selectedBy = this.now() + 1500;
      for (let s = await screenOf(); s && !clearContextRow(s)?.selected && this.now() < selectedBy; s = await screenOf()) await sleep(100);
      await tether.keys(term, ["Enter"]);
      const goneBy = this.now() + DIALOG_CONFIRM_MS;
      for (let s = await screenOf(); s && clearContextRow(s) && this.now() < goneBy; s = await screenOf()) await sleep(150);
      const after = await screenOf();
      pressed = after !== undefined && !clearContextRow(after);
      this.log.info("clear-context row pressed", { session: rec.session.id, digit: current.digit, mode: plan.goOn, attempt, taken: pressed });
    }
    if (!pressed) {
      this.log.warn("the clear-context row stayed on the screen", { session: rec.session.id });
      this.event(rec, "notification", { type: "plan_continued", mode: plan.goOn, message: "The plan waits for an answer in its terminal" });
      return;
    }
    this.event(rec, "notification", { type: "plan_continued", mode: plan.goOn, message: "The plan is being built in this terminal with a clear context" });
    const note = answer.text?.trim();
    if (note) this.queueTyped(rec, `User feedback on this plan: ${note}`, `cophylad-note-${ulid(this.now())}`);
  }

  /** The ask for the question at `questions.index`; none of the sequence outlives the hook's deadline. */
  private questionAsk(rec: LiveRecord, questions: HeldQuestions, now: number): AskInput {
    const q = questions.list[questions.index]!;
    return askInputFromQuestion(q, {
      session: rec.session.id,
      index: questions.index,
      count: questions.list.length,
      expiresAt: Math.min(now + this.config.hook_timeout_s * 1000, questions.deadline),
    });
  }

  /**
   * Opens the ask that stands for a held request and marks the session with it. With
   * `existing`, the next question of a sequence takes the held record over from the ask
   * before it.
   */
  private openHeldAsk(rec: LiveRecord, key: string, input: AskInput, status: HeldStatus, opened: Record<string, unknown>, raw: unknown, now: number, questions?: HeldQuestions, existing?: Held, plan?: HeldPlan): Held {
    const ask = this.deps.asks.open(input, now);
    let held: Held;
    if (existing) {
      this.askOwners.delete(existing.ask.id);
      existing.ask = ask;
      held = existing;
    } else {
      held = { ask, key, openedAt: now, waiters: [], settled: false, ...(questions ? { questions } : {}), ...(plan ? { plan } : {}) };
      rec.held = held;
    }
    this.askOwners.set(ask.id, rec);
    rec.session.status = status;
    rec.session.ask = ask.id;
    rec.session.lastActivity = now;
    this.deps.store.sessions.update(rec.session);
    this.event(rec, "ask", { ask: ask.id, phase: "opened", ...opened, ...askShown(ask) }, raw, now);
    this.event(rec, "status", { status, ask: ask.id }, undefined, now);
    this.broadcast(rec, true);
    this.log.info("harness ask opened", { session: rec.session.id, ask: ask.id, type: input.type, ...opened });
    return held;
  }

  /** The hook's response, once the held record settles; the request's abort closes it. */
  private waitHeld(rec: LiveRecord, held: Held, meta: HookMeta): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const onAbort = () => {
        if (!held.settled) this.closeHeld(rec, "aborted");
      };
      held.waiters.push((answer) => {
        meta.signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      });
      if (meta.signal?.aborted) onAbort();
      else meta.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The PostToolUse of a held `AskUserQuestion`: its input carries the answers, so the questions alone are compared. */
  private sameQuestions(held: Held, hook: NormalisedHook): boolean {
    const input = hook.toolInput;
    if (!held.questions || hook.toolName !== "AskUserQuestion" || input === null || typeof input !== "object") return false;
    return stableStringify((input as Record<string, unknown>)["questions"]) === held.questions.key;
  }

  /** The PermissionRequest answer; Muse takes `behavior` and `message` alone. */
  private hookOutput(decision: Record<string, unknown>, harness: string = "claude"): unknown {
    if (harness === "muse") {
      const { behavior, message } = decision;
      return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, ...(typeof message === "string" ? { message } : {}) } } };
    }
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  }

  /**
   * Every held response is released with `{}`; the session returns to `next`, busy by default.
   * Of a question sequence only the open ask is cancelled: the answered ones stay answered,
   * and the answers gathered so far go nowhere.
   */
  private closeHeld(rec: LiveRecord, reason: AskCloseReason, next: SessionStatus = "busy"): void {
    const held = rec.held;
    if (!held || held.settled) return;
    held.settled = true;
    rec.held = undefined;
    this.askOwners.delete(held.ask.id);
    const now = this.now();
    if (this.deps.asks.getAny(held.ask.id)?.status === "open") this.deps.asks.cancel(held.ask.id);
    this.event(rec, "ask", { ask: held.ask.id, phase: "closed", reason }, undefined, now);
    this.log.info("harness ask closed", { session: rec.session.id, ask: held.ask.id, type: held.ask.type, reason });
    for (const w of held.waiters) w({});
    held.waiters = [];
    this.afterHeld(rec, next, now);
  }

  private answeredHeld(rec: LiveRecord, ask: Ask): void {
    const held = rec.held;
    if (!held || held.settled || held.ask.id !== ask.id) return;
    const now = this.now();
    this.event(rec, "ask", { ask: ask.id, phase: "answered", answer: ask.answer }, undefined, now);
    this.log.info("harness ask answered", { session: rec.session.id, ask: ask.id, type: ask.type, option: ask.answer?.option, by: ask.answer?.by.kind });
    let decision: unknown;
    const questions = held.questions;
    if (questions && ask.answer) {
      answersForHook(questions.list[questions.index]!, ask.answer, questions.out);
      questions.index += 1;
      if (questions.index < questions.list.length) {
        // The next question takes the held record over; the request stays held.
        this.openHeldAsk(rec, held.key, this.questionAsk(rec, questions, now), "needs_input", { tool: "AskUserQuestion", question: questions.index + 1, of: questions.list.length }, undefined, now, questions, held);
        return;
      }
      decision = hookDecision(questions.toolInput, questions.out);
    } else if (held.plan && ask.answer?.option === CLEAR) {
      const plan = held.plan;
      const answer = ask.answer;
      held.settled = true;
      rec.held = undefined;
      this.askOwners.delete(ask.id);
      if (plan.inPlace) {
        void this.pressClearRow(rec, held, plan, answer);
        return;
      }
      // The request stays held while the fresh session starts; nothing else may settle it.
      void this.buildInFreshSession(rec, plan, answer).then((d) => this.release(rec, held, this.hookOutput(d), d["behavior"] === "allow" ? "busy" : "idle"));
      return;
    } else {
      decision = this.hookOutput(permissionDecision(ask.answer, held.plan), rec.session.harness);
    }
    held.settled = true;
    rec.held = undefined;
    this.askOwners.delete(ask.id);
    this.release(rec, held, decision, "busy");
  }

  /** Answers the held request's waiters; the session goes on as `next`. */
  private release(rec: LiveRecord, held: Held, decision: unknown, next: SessionStatus): void {
    for (const w of held.waiters) w(decision);
    held.waiters = [];
    this.afterHeld(rec, next, this.now());
  }

  private afterHeld(rec: LiveRecord, next: SessionStatus, now: number): void {
    delete rec.session.ask;
    if (next === "ended" || rec.session.status === "ended") {
      this.deps.store.sessions.update(rec.session);
      return;
    }
    if (rec.session.status === "needs_permission" || rec.session.status === "needs_input") {
      rec.session.status = next;
      rec.session.lastActivity = now;
      this.deps.store.sessions.update(rec.session);
      this.event(rec, "status", { status: next }, undefined, now);
      if (next === "idle") this.injections.rearm(rec.session.id);
    } else {
      this.deps.store.sessions.update(rec.session);
    }
    this.broadcast(rec);
  }

  private onAskState(ask: Ask): void {
    if (ask.status === "open") return;
    const rec = this.askOwners.get(ask.id);
    if (!rec) return;
    if (rec.inputAsk?.id === ask.id) {
      this.closeInput(rec, ask.status === "expired" ? "expired" : "stopped");
      return;
    }
    if (ask.status === "answered") this.answeredHeld(rec, ask);
    else if (ask.status === "expired") this.closeHeld(rec, "expired");
    else this.closeHeld(rec, "aborted");
  }

  /** An Elicitation is answerable only in the terminal: the Ask shows it, `{}` lets the prompt through. */
  private openInput(rec: LiveRecord, hook: NormalisedHook, raw: unknown, now: number): unknown {
    if (rec.held && !rec.held.settled) {
      // A held request owns the session's ask; the prompt is recorded and left to the terminal.
      this.event(rec, "notification", { type: "elicitation", ...(hook.message ? { message: hook.message } : {}) }, raw, now);
      return {};
    }
    if (rec.inputAsk) this.closeInput(rec, "stopped");
    const ask = this.deps.asks.open(
      {
        type: "input",
        source: { kind: "harness", session: rec.session.id },
        title: `${rec.session.title ?? rec.session.cwd} is asking for input`,
        detail: hook.message ?? capText(JSON.stringify(redact(hook.raw)), DETAIL_CHARS),
        options: [],
        allowsText: true,
        answerableBy: [],
        expiresAt: now + this.config.hook_timeout_s * 1000,
      },
      now,
    );
    rec.inputAsk = ask;
    this.askOwners.set(ask.id, rec);
    rec.session.status = "needs_input";
    rec.session.ask = ask.id;
    rec.session.lastActivity = now;
    this.deps.store.sessions.update(rec.session);
    this.event(rec, "ask", { ask: ask.id, phase: "opened", kind: "input", ...askShown(ask) }, raw, now);
    this.event(rec, "status", { status: "needs_input", ask: ask.id }, undefined, now);
    this.broadcast(rec, true);
    return {};
  }

  private closeInput(rec: LiveRecord, reason: AskCloseReason): void {
    const ask = rec.inputAsk;
    if (!ask) return;
    rec.inputAsk = undefined;
    this.askOwners.delete(ask.id);
    const now = this.now();
    if (this.deps.asks.getAny(ask.id)?.status === "open") this.deps.asks.cancel(ask.id);
    this.event(rec, "ask", { ask: ask.id, phase: "closed", reason }, undefined, now);
    if (rec.session.ask === ask.id) delete rec.session.ask;
    if (rec.session.status === "needs_input") {
      rec.session.status = "busy";
      this.event(rec, "status", { status: "busy" }, undefined, now);
    }
    this.deps.store.sessions.update(rec.session);
    this.broadcast(rec);
  }
}
