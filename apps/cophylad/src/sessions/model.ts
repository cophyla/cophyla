// The session model shared by `Sessions` and its adapters: the in-memory record around a
// persisted `Session`, the adapter interface, the normalised hook, and the small helpers
// that shape event payloads. Status rules and the ask lifecycle live in index.ts.

import type { Ask, ClaudeHookEvent, CodexHookEvent, HarnessKind, HarnessProfile, MuseHookEvent, NodeId, ProfileId, Session, SessionEvent, SessionEventKind, SessionOrigin, SessionStats, SessionStatus, SessionTransport, SessionWaiting, TerminalRef } from "@cophyla/protocol";
import type { HookMeta } from "../api/hooks.ts";
import type { SessionsConfig } from "../config/schema.ts";
import { redact } from "../gate/audit.ts";
import type { Logger } from "../log.ts";
import type { ProfileChange } from "./profiles.ts";
import type { HookShell } from "./shim.ts";
import type { Tail } from "./tail.ts";

export type AttachedHarness = "claude" | "codex" | "muse";

/** How `session.send` was answered by the harness: `held` means its terminal must approve the message. */
export interface SendOutcome {
  status: "queued" | "held";
}

export interface SessionHandles {
  /** Claude: the messaging pipe and the peer token from the key file. */
  pipe?: string;
  token?: string;
  /** The profile directory the session was found under. */
  configDir?: string;
  /** Claude: the process start time the registry gave, which tells the same process from a reused pid. */
  procStart?: string;
  /** Claude: when the session's current process started, by the registry. */
  startedAt?: number;
}

export interface SessionRecord {
  session: Session;
  handles: SessionHandles;
  /** Claude: the last permission mode a hook or the transcript reported. */
  permissionMode?: string;
  /** Claude: every permission mode seen, which says what the session may go on in after a plan. */
  modesSeen?: Set<string>;
  /** Codex and Muse: `hook` once a hook has been seen, else the recency heuristic over the rollout or the session log. */
  liveness: "hook" | "heuristic";
  /** Codex and Muse: the last sign of activity (the rollout or log written, the list's `updatedAt`, a hook), for the recency rule. */
  lastRolloutActivity?: number;
  tail?: Tail;
  /** Per-adapter parser state over the transcript or rollout. */
  parser?: unknown;
  /**
   * Tool results recorded from hooks, keyed on the call's id (on tool name and input when a
   * hook has no id), so the transcript does not record them twice.
   */
  hookTools: Map<string, number>;
  /** The shim's parent pid has been checked for the harness's own process among its ancestors. */
  ancestorsChecked?: boolean;
  /** Claude: what the session had spent under the ids it had before its context was cleared; its stats count on from here. */
  statsBase?: SessionStats;
  /** Claude: when the last hook came, which keeps a session with no known process alive for a grace period. */
  lastHookAt?: number;
  /**
   * Claude: its transcript says the conversation went on as a background job with session id
   * `to`, as of `at`; the record waits for the job's entry until `until`, and does not end meanwhile.
   */
  continuing?: { to: string; at: number; until: number };
  /** Claude: its transcript's rows from before this are history a background job was forked with, recorded once already. */
  copiedBefore?: number;
  /**
   * Codex: its thread runs in the shared app-server daemon, which its hooks run under: the
   * daemon is not the session's process, and its terminal is found by the CLI marked in one.
   */
  hostedBy?: "daemon";
  /** Codex: what started the thread, from its rollout (`codex-tui`, `Codex Desktop`): a desktop app's thread is in no terminal. */
  originator?: string;
}

export interface SessionSeed {
  harness: AttachedHarness;
  nativeId: string;
  profile: ProfileId;
  cwd: string;
  transport: SessionTransport;
  pid?: number;
  transcriptPath?: string;
  title?: string;
  intent?: string;
  startedAt?: number;
  status?: SessionStatus;
  handles?: SessionHandles;
  liveness?: SessionRecord["liveness"];
  /** `orchestrator` for a session cophylad spawned; `user` by default. */
  origin?: SessionOrigin;
  /** The task a spawned session serves and the workspace it was started in. */
  task?: string;
  workspace?: string;
  /** The tether terminal it runs in. */
  terminal?: TerminalRef;
  /** Claude: its job id, when it runs as a background job under the harness's daemon. */
  job?: string;
  /** When the harness last saw the session active: evidence that an ended one ran again, when it has no transcript to judge by. */
  activeAt?: number;
}

/** One shape for every harness's hook bodies. Names are the PascalCase ones on the wire. */
export interface NormalisedHook {
  harness: AttachedHarness;
  name: string;
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  permissionMode?: string;
  /** `prompt_id` on Claude, `turn_id` on Codex and Muse: the same duplicate-folding role. */
  promptId?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  toolUseId?: string;
  /** Claude: a PostToolUseFailure's error, which it sends in place of a response. */
  error?: string;
  /** Claude: the sub-agent that ran the tool, whose own transcript holds the call. */
  agentId?: string;
  message?: string;
  notificationType?: string;
  source?: string;
  reason?: string;
  title?: string;
  model?: string;
  lastAssistantMessage?: string;
  raw: unknown;
}

const CODEX_NAMES: Record<string, string> = {
  preToolUse: "PreToolUse",
  permissionRequest: "PermissionRequest",
  postToolUse: "PostToolUse",
  preCompact: "PreCompact",
  postCompact: "PostCompact",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  userPromptSubmit: "UserPromptSubmit",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  stop: "Stop",
  interrupt: "Interrupt",
};

export function normaliseHook(harness: AttachedHarness, e: ClaudeHookEvent | CodexHookEvent | MuseHookEvent): NormalisedHook {
  const n: NormalisedHook = { harness, name: CODEX_NAMES[e.hook_event_name] ?? e.hook_event_name, sessionId: e.session_id, raw: e };
  const set = <K extends keyof NormalisedHook>(key: K, value: NormalisedHook[K] | null | undefined) => {
    if (value !== undefined && value !== null) n[key] = value;
  };
  set("cwd", e.cwd);
  // A Codex sub-agent's hooks come under its parent thread's id, with the sub-agent's own
  // rollout: the hook is the parent's, the rollout is not its transcript.
  if (harness !== "codex" || !otherThreadsRollout(e.transcript_path, e.session_id)) set("transcriptPath", e.transcript_path);
  set("permissionMode", e.permission_mode);
  set("prompt", e.prompt);
  set("toolName", e.tool_name);
  set("toolInput", e.tool_input);
  set("toolResponse", e.tool_response);
  set("source", e.source);
  set("reason", e.reason);
  set("lastAssistantMessage", e.last_assistant_message);
  set("model", e.model);
  set("toolUseId", e.tool_use_id);
  if (harness === "claude") {
    const c = e as ClaudeHookEvent;
    set("error", c.error);
    set("agentId", c.agent_id);
    set("promptId", c.prompt_id);
    set("message", c.message);
    set("notificationType", c.notification_type);
    set("title", c.session_title);
  } else {
    const x = e as CodexHookEvent | MuseHookEvent;
    set("promptId", x.turn_id);
    if (harness === "muse") set("message", (e as MuseHookEvent).message);
  }
  return n;
}

/** Whether a path is a Codex rollout, `rollout-<time>-<threadId>.jsonl`, of a thread other than `threadId`. */
function otherThreadsRollout(path: string | null | undefined, threadId: string): boolean {
  if (!path) return false;
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  return name.startsWith("rollout-") && name.endsWith(".jsonl") && !name.endsWith(`-${threadId.toLowerCase()}.jsonl`);
}

/** What cophylad installs: the http endpoint, or the command that runs the shim. */
export interface HookInstallSpec {
  url: string;
  token: string;
  timeoutS: number;
  /** The command form of the hook for a harness and profile, quoted and forward-slashed for `shell` (`sh` unless given). */
  command(harness: AttachedHarness, profileId: string, shell?: HookShell): string;
  /** The argument-vector form, which no shell reads: the daemon's runtime running a copy of the shim at `shim`, told where `hook.json` is. */
  argv(harness: AttachedHarness, profileId: string, shim: string): string[];
  /** Claude: `http` unless the profile says `command`. */
  mode(profileId: string): "http" | "command";
}

export interface HarnessAdapter {
  readonly harness: AttachedHarness;
  /** Installs hooks when a spec is given, then starts discovery and any children. */
  start(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined): Promise<void>;
  /** The harness's profiles were rebuilt and something changed: a new installation gets what `start` gives one, a new login what it needs. */
  sync?(profiles: HarnessProfile[], hooks: HookInstallSpec | undefined, change: ProfileChange): Promise<void>;
  stop(): Promise<void>;
  /** One discovery and tail pass. */
  tick(now: number): Promise<void>;
  send(rec: SessionRecord, text: string, ref: string): Promise<SendOutcome>;
  /** Takes a message back when no receipt came. Codex only. */
  withdraw?(rec: SessionRecord, ref: string): Promise<void>;
  /** Says a session with this id is starting in a terminal, so the record it makes carries what it was started for. Claude only. */
  expect?(sessionId: string, what: { workspace?: string; task?: string; intent?: string; terminal?: TerminalRef; expiresAt: number }): void;
  /** Stops waiting for one that never arrived. Claude only. */
  unexpect?(sessionId: string): void;
  /**
   * Says a session is starting in a tether terminal whose own id the harness picks (Muse): the
   * record its hooks make is claimed for the terminal by the process tree, and carries what it
   * was started for.
   */
  expectTerminal?(ref: TerminalRef, what: TerminalExpectation): void;
  /** The record a terminal's session was claimed as, once it has been. */
  claimed?(ref: TerminalRef): SessionRecord | undefined;
  /** Whether a profile's sessions report through cophylad's hooks, which alone find one in a terminal. Muse only. */
  hooked?(profileId: string): Promise<boolean>;
  /** Sessions the adapter runs itself, headless, through the harness's own host. Muse only. */
  headless?: HeadlessRunner;
  /**
   * Resolves the record for a hook, creating it when the harness is known only from the hook,
   * and refreshes its handles. `null`: the hook is not a session's (a child's, one cophylad runs
   * itself), and is answered `{}` at once.
   */
  onHook(hook: NormalisedHook, rec: SessionRecord | undefined, meta: HookMeta): SessionRecord | undefined | null;
  /** One tail pass over a record about to end, so its transcript's last lines are recorded before the end. */
  drain?(rec: SessionRecord, now: number): void;
  /**
   * A synchronous catch-up read of the session's log, before a hook's tool result is recorded:
   * what the log holds before the result, its call included, is recorded first. Claude and
   * Codex only; Muse's view is read over RPC and gives a call and its result together.
   */
  readNow?(rec: SessionRecord, now: number): void;
  /**
   * Claude: what a session whose turn just stopped waits on. The harness writes that about when
   * the Stop hook fires, sometimes just after: a promise while it has not said yet.
   */
  afterStop?(rec: SessionRecord): SessionWaiting | undefined | Promise<SessionWaiting | undefined>;
}

/** A session starting in a tether terminal, before its harness has named it. */
export interface TerminalExpectation {
  /** The terminal's own process, which the session's process runs below. */
  pid?: number;
  workspace?: string;
  task?: string;
  intent?: string;
  expiresAt: number;
}

/** What a headless session is started with. */
export interface HeadlessSpawn {
  profile: HarnessProfile;
  cwd: string;
  workspace: string;
  prompt: string;
  task?: string;
  model?: string;
  intent?: string;
}

/** An adapter's own headless sessions: started, prompted, cancelled and stopped through it. */
export interface HeadlessRunner {
  owns(rec: SessionRecord): boolean;
  spawn(input: HeadlessSpawn): Promise<SessionRecord>;
  /** Queues a message behind the turn in flight; resolves once the harness took it. */
  prompt(rec: SessionRecord, text: string, ref: string): Promise<void>;
  /** Cancels the turn in flight without ending the session. */
  cancel(rec: SessionRecord): boolean;
  stop(rec: SessionRecord): Promise<void>;
  /** Turns in flight over every session it runs. */
  inFlight(): number;
}

/** How far a view-read session (Muse) has been recorded: its log, the log's size then, and the view's cursor. */
export interface ViewMark {
  path: string;
  offset: number;
  cursor?: string;
}

/** What `Sessions` offers its adapters. */
export interface SessionHost {
  readonly nodeId: NodeId;
  readonly config: SessionsConfig;
  readonly log: Logger;
  now(): number;
  ensure(seed: SessionSeed): SessionRecord;
  find(harness: AttachedHarness, nativeId: string): SessionRecord | undefined;
  /** Live records of a harness that the attached adapter owns: never the ACP-spawned ones. */
  records(harness: AttachedHarness): SessionRecord[];
  /** A second native id for a record, when a harness names a spawned session differently in its hooks. */
  alias(rec: SessionRecord, nativeId: string): void;
  /**
   * Claude: the same process now goes by another session id (its context was cleared, or it
   * resumed another session): the record follows it, keeping what it is and where it runs.
   */
  rekey(rec: SessionRecord, nativeId: string, at?: number): void;
  /**
   * Claude: the conversation went on as a background job, under session id `nativeId`: the
   * record follows it there, keeping what it is, and leaves its process and terminal behind.
   */
  background(rec: SessionRecord, nativeId: string, at?: number): void;
  /** Claude: the job a conversation went on as already has a record of its own: it takes over what `from` was for, and `from` ends. */
  merge(from: SessionRecord, into: SessionRecord, at?: number): void;
  /** Claude: the processes showing the agents screen now, each with the terminal it was a session's in when known. */
  agentWindows(harness: AttachedHarness, windows: { pid: number; terminal?: TerminalRef }[]): void;
  /**
   * Codex: a record hosted by the daemon is given the terminal whose CLI stands for it: the one
   * that fits, or of several the one whose CLI started just before the thread. With `handOver`
   * (its first hook since it was made or resumed), a CLI that went on to this thread from an
   * older one's hands its terminal over.
   */
  linkMarked(rec: SessionRecord, opts?: { handOver?: boolean }): void;
  patch(rec: SessionRecord, patch: Partial<Session>, at?: number): void;
  /** The permission mode a session is in, as its harness said; a Claude session's shows as its `mode`. */
  noteMode(rec: SessionRecord, mode: string, at?: number): void;
  /**
   * A status; anything but `idle` clears `waiting`. With `opts`, `waiting` is what the
   * harness says now (undefined: waiting on nothing); without, an idle session keeps its own.
   */
  setStatus(rec: SessionRecord, status: SessionStatus, at?: number, opts?: { waiting: SessionWaiting | undefined }): void;
  event(rec: SessionRecord, kind: SessionEventKind, payload: unknown, raw?: unknown, at?: number): SessionEvent;
  end(rec: SessionRecord, reason: string, at?: number): void;
  /** Claude: a delivered prompt that carries one of cophylad's own messages, as the prompt `promptId`. True when it matched a pending send. */
  receiptByText(rec: SessionRecord, text: string, promptId?: string): boolean;
  /** Codex: a rollout UserMessage whose client_id is one of cophylad's refs. */
  receiptByRef(rec: SessionRecord, ref: string): boolean;
  /** Whether a delivered turn is one of cophylad's own sends, recorded when the send was. */
  isOwnText(rec: SessionRecord, text: string, promptId?: string): boolean;
  /** A tail over the record's transcript that records only what no earlier tail of the file recorded. */
  openTail(rec: SessionRecord, path: string): Tail;
  /** After a read: remembers how far the record's tail has recorded, for the next tail of the file. */
  tailed(rec: SessionRecord): void;
  /** Muse: how far the record's view was recorded, by this run or one before. */
  viewMark(rec: SessionRecord): ViewMark | undefined;
  /** Muse: after a read, where the next one starts. */
  setViewMark(rec: SessionRecord, mark: ViewMark): void;
  /** Watches a directory for changes and runs a tail pass soon after one. */
  watch(dir: string): void;
}

// ---------------------------------------------------------------------------------------
// Payload shaping

export const TOOL_CALL_CAP = 1024;
export const TOOL_RESULT_CAP = 4096;
export const TEXT_CAP = 8192;
export const RAW_CAP = 16384;
export const INTENT_CAP = 200;
export const ASK_DETAIL_CAP = 1024;

/**
 * What an opened `ask` event carries of the ask: its question, the detail under it and the
 * option labels. The ask closes and is not part of the history, so without these a reader
 * of the session's events (the brain's History, recall) sees that the agent asked, and not what.
 */
export function askShown(ask: Pick<Ask, "title" | "detail" | "options">): { title: string; detail?: string; options?: string[] } {
  return {
    title: ask.title,
    ...(ask.detail ? { detail: capText(ask.detail, ASK_DETAIL_CAP) } : {}),
    ...(ask.options.length > 0 ? { options: ask.options.map((o) => o.label) } : {}),
  };
}

/** JSON with keys sorted, so equal inputs compare equal whatever their key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The value redacted, whole when its JSON fits the cap and as a cut string past it. */
export function summariseValue(value: unknown, cap: number): { value: unknown; truncated?: true } {
  const clean = redact(value);
  const text = typeof clean === "string" ? clean : JSON.stringify(clean) ?? "null";
  if (text.length <= cap) return { value: clean };
  return { value: text.slice(0, cap - 1) + "…", truncated: true };
}

export function capText(text: string, cap = TEXT_CAP): string {
  return text.length > cap ? text.slice(0, cap - 1) + "…" : text;
}

/** One line for `intent`. */
export function oneLine(text: string, cap = INTENT_CAP): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > cap ? line.slice(0, cap - 1) + "…" : line;
}

/** The harness row for `raw`, when it is small enough to keep. */
export function rawIfSmall(row: unknown): unknown {
  const text = JSON.stringify(row);
  return text !== undefined && text.length <= RAW_CAP ? row : undefined;
}

/** The key a PermissionRequest and its PostToolUse share: tool name plus input. */
export function toolKey(toolName: string | undefined, toolInput: unknown): string {
  return `${toolName ?? ""} ${stableStringify(toolInput ?? null)}`;
}
