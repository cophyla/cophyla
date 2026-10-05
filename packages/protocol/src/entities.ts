// The shared entities from entities.md, one schema each. Objects strip unknown fields on
// parse rather than rejecting them, which is how "evolution is additive" holds on the wire.

import { z } from "zod";
import {
  AskId,
  AuditId,
  ClientId,
  ControllerId,
  GrantRef,
  ListenerId,
  MessageId,
  NodeId,
  ProfileId,
  SessionId,
  TaskId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "./ids.ts";
import { ErrorCode } from "./rpc.ts";

// ---------------------------------------------------------------------------------------
// Small shared vocabularies

export const HarnessKind = z.enum(["claude", "codex", "acp", "muse"]);
export type HarnessKind = z.infer<typeof HarnessKind>;

export const HarnessCapabilities = z.object({
  attach: z.boolean(),
  inject: z.boolean(),
  hooks: z.boolean(),
  spawn: z.boolean(),
  answerAsks: z.boolean(),
});
export type HarnessCapabilities = z.infer<typeof HarnessCapabilities>;

export const Platform = z.enum(["windows", "macos", "linux"]);
export type Platform = z.infer<typeof Platform>;

export const NodeRole = z.enum(["primary", "secondary"]);
export type NodeRole = z.infer<typeof NodeRole>;

export const NodeStatus = z.enum(["online", "offline", "degraded"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const Via = z.enum(["direct", "relay"]);
export type Via = z.infer<typeof Via>;

export const RiskClass = z.enum(["read", "write", "exec", "network"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const Tags = z.array(z.string());

/** A JSON Schema document. Kept opaque here; the consumer validates it. */
export const JSONSchema = z.record(z.string(), z.unknown());
export type JSONSchema = z.infer<typeof JSONSchema>;

export const Principal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), client: ClientId }),
  z.object({ kind: z.literal("brain") }),
  z.object({ kind: z.literal("node"), id: NodeId }),
  z.object({ kind: z.literal("harness"), session: SessionId }),
  z.object({ kind: z.literal("system") }),
]);
export type Principal = z.infer<typeof Principal>;

export const PrincipalKind = z.enum(["user", "brain", "node", "harness", "system"]);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

// ---------------------------------------------------------------------------------------
// Node

export const NodeScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine") }),
  z.object({ kind: z.literal("workspaces"), paths: z.array(z.string()) }),
]);
export type NodeScope = z.infer<typeof NodeScope>;

export const NodeCapabilities = z.object({
  harnesses: z.array(HarnessKind),
  voice: z.object({ wake: z.boolean(), stt: z.boolean(), tts: z.boolean() }),
  remote: z.boolean(),
  brain: z.boolean(),
  /** It starts terminals and serves them to the primary's clients: tether is on it, and it shares the whole machine. */
  terminals: z.boolean().optional(),
});
export type NodeCapabilities = z.infer<typeof NodeCapabilities>;

export const NodeVersions = z.object({
  platform: z.string(),
  protocol: z.number().int(),
  brain: z.string().optional(),
});
export type NodeVersions = z.infer<typeof NodeVersions>;

export const Node = z.object({
  id: NodeId,
  name: z.string(),
  role: NodeRole,
  status: NodeStatus,
  backup: z.boolean().optional(),
  via: Via,
  platform: Platform,
  scope: NodeScope,
  capabilities: NodeCapabilities,
  versions: NodeVersions,
  lastSeen: Timestamp,
  /** Joined as hands only: the primary drives it, and it can reach no other node. */
  hands: z.boolean().optional(),
});
export type Node = z.infer<typeof Node>;

// ---------------------------------------------------------------------------------------
// Workspace

export const WorkspaceOrigin = z.enum(["scope", "discovered", "user", "brain"]);
export type WorkspaceOrigin = z.infer<typeof WorkspaceOrigin>;

export const Workspace = z.object({
  id: WorkspaceId,
  node: NodeId,
  path: z.string(),
  name: z.string(),
  origin: WorkspaceOrigin,
  repo: z.object({ root: z.string(), remote: z.string().optional() }).optional(),
  summary: z.string().optional(),
  tags: Tags,
  lastActivity: Timestamp,
});
export type Workspace = z.infer<typeof Workspace>;

// ---------------------------------------------------------------------------------------
// HarnessProfile: one installation of a harness, with its own login

export const ProfileOrigin = z.enum(["discovered", "user"]);
export type ProfileOrigin = z.infer<typeof ProfileOrigin>;

export const ProfileStatus = z.enum(["ok", "unauthenticated", "missing"]);
export type ProfileStatus = z.infer<typeof ProfileStatus>;

/**
 * A Claude session's permission mode: the one it starts in (`--permission-mode`, or
 * `--dangerously-skip-permissions` for `bypassPermissions`), and the one it is in now.
 */
export const LaunchMode = z.enum(["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"]);
export type LaunchMode = z.infer<typeof LaunchMode>;

/** Where a profile's launch comes from: set in the app, `[[profiles]].args` in config, or the user's own last session under it. */
export const LaunchSource = z.enum(["you", "config", "mirrored"]);
export type LaunchSource = z.infer<typeof LaunchSource>;

/** How cophylad starts a Claude session under a profile: a mode and the other flags, in order. */
export const ProfileLaunch = z.object({
  mode: LaunchMode.optional(),
  /** Flags beyond the mode, as the command line has them. */
  args: z.array(z.string()),
  source: LaunchSource,
  /** A mirrored launch: when the session it was read from started. */
  at: Timestamp.optional(),
});
export type ProfileLaunch = z.infer<typeof ProfileLaunch>;

/** Why a profile is its harness's usual one: picked in the app, `default = true` in config, the user's latest session, or discovery. */
export const DefaultBy = z.enum(["you", "config", "recent", "discovered"]);
export type DefaultBy = z.infer<typeof DefaultBy>;

export const HarnessProfile = z.object({
  id: ProfileId,
  node: NodeId,
  harness: HarnessKind,
  /** The user's label: work, personal. */
  name: z.string(),
  /** Where its sessions, keys and credentials live. */
  configDir: z.string(),
  /** Which binary; the one on PATH by default. */
  exec: z.object({ command: z.string(), args: z.array(z.string()) }).optional(),
  /** CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME and XDG_DATA_HOME for Muse, a vendor key. */
  env: z.record(z.string(), z.string()),
  origin: ProfileOrigin,
  /** What session.spawn uses when none is named: its harness's usual account on the node. */
  default: z.boolean().optional(),
  /** On the default profile: why it is the one. */
  defaultBy: DefaultBy.optional(),
  /** On the profile cophylad picks as the usual account when none is picked in the app, and why; the default too unless another was picked. */
  automatic: DefaultBy.optional(),
  status: ProfileStatus,
  /** Claude: what a session cophylad starts under it is started with; absent when nothing is set. */
  launch: ProfileLaunch.optional(),
});
export type HarnessProfile = z.infer<typeof HarnessProfile>;

// ---------------------------------------------------------------------------------------
// Session and SessionEvent

export const SessionStatus = z.enum(["idle", "busy", "needs_input", "needs_permission", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** How cophylad reads and drives a session: Claude's messaging pipe, a Codex app-server, an ACP child, or a `muse serve` host (MSP). */
export const SessionTransport = z.enum(["pipe", "app-server", "acp", "msp"]);
export type SessionTransport = z.infer<typeof SessionTransport>;

export const SessionOrigin = z.enum(["user", "orchestrator"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const TokenCounts = z.object({
  in: z.number().int().nonnegative(),
  out: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
});
export type TokenCounts = z.infer<typeof TokenCounts>;

export const SessionStats = z.object({
  turns: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  tokens: TokenCounts,
  context: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }).optional(),
  /** The model the counters are priced at, as the harness names it. */
  model: z.string().optional(),
});
export type SessionStats = z.infer<typeof SessionStats>;

/**
 * What an idle session is waiting on, when it is not done: `shell`, background shells of its own
 * that will wake it when they end; `user`, a dialog open in its terminal (`detail` says which).
 */
export const SessionWaiting = z.object({
  on: z.enum(["shell", "user"]),
  detail: z.string().optional(),
});
export type SessionWaiting = z.infer<typeof SessionWaiting>;

/** A terminal a tether host holds: the host's id and the host's own id for the terminal. */
export const TerminalRef = z.object({ host: z.string(), id: z.string() });
export type TerminalRef = z.infer<typeof TerminalRef>;

export const Session = z.object({
  id: SessionId,
  node: NodeId,
  harness: HarnessKind,
  /** The installation the session was found under. */
  profile: ProfileId,
  native: z.object({
    id: z.string(),
    pid: z.number().int().positive().optional(),
    transport: SessionTransport,
    /** The terminal the session runs in, when a tether host holds it; it outlives a change of `id`. */
    terminal: TerminalRef.optional(),
    /** The harness's job id, when the session runs as a background job under the harness's own daemon, with no window of its own. */
    job: z.string().optional(),
  }),
  origin: SessionOrigin,
  workspace: WorkspaceId.optional(),
  task: TaskId.optional(),
  cwd: z.string(),
  title: z.string().optional(),
  intent: z.string().optional(),
  summary: z.string().optional(),
  tags: Tags,
  status: SessionStatus,
  /** Set only while `status` is `idle`: the session is not done, it waits on its own shells or on the user. */
  waiting: SessionWaiting.optional(),
  /**
   * A Claude session's permission mode, as its hooks, its transcript or its terminal last
   * said. It is not stored: a restart learns it again from the session's next hook.
   */
  mode: LaunchMode.optional(),
  ask: AskId.optional(),
  startedAt: Timestamp,
  lastActivity: Timestamp,
  endedAt: Timestamp.optional(),
  stats: SessionStats.optional(),
  transcript: z.object({ path: z.string() }).optional(),
  /**
   * `assistant`: the session the chat itself runs in, started and typed into by cophylad. It is
   * no agent of the user's: no list shows it, no event of it reaches a client or the brain.
   */
  role: z.literal("assistant").optional(),
});
export type Session = z.infer<typeof Session>;

/** The harnesses the chat's own session runs on. */
export const AssistantHarness = z.enum(["claude", "codex"]);
export type AssistantHarness = z.infer<typeof AssistantHarness>;

/**
 * Where the chat's own session stands: `off` on a node that runs no brain, `unavailable` with
 * no signed-in profile to run it under, `starting` until its harness is up, `idle` or `busy`
 * while it runs, `down` when its program went and is being started again.
 */
export const AssistantStatus = z.enum(["off", "unavailable", "starting", "idle", "busy", "down"]);
export type AssistantStatus = z.infer<typeof AssistantStatus>;

/**
 * The chat's own session as a view shows it: the harness and the account it runs under, the
 * model and effort it was started with, the context it has used against the size it compacts
 * at, and the terminal it runs in when it has one. `chosen` is what the user picked in the
 * app, each part absent while cophylad picks it.
 */
export const AssistantState = z.object({
  status: AssistantStatus,
  harness: AssistantHarness.optional(),
  profile: ProfileId.optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  context: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }).optional(),
  terminal: TerminalRef.optional(),
  chosen: z.object({ harness: AssistantHarness.optional(), profile: ProfileId.optional() }).optional(),
  /** Why it is unavailable or down, in a line for the user. */
  detail: z.string().optional(),
});
export type AssistantState = z.infer<typeof AssistantState>;

export const TerminalStatus = z.enum(["running", "exited"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

/**
 * A program a tether host holds in a pseudo-terminal on a node: a harness session's own
 * terminal, or any program at all. Its screen can be opened in a view.
 */
export const Terminal = z.object({
  /** The host's own id for it. */
  id: z.string(),
  node: NodeId,
  host: z.string(),
  name: z.string().optional(),
  argv0: z.string(),
  cwd: z.string(),
  pid: z.number().int().positive().optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** The title its program set, without the spinner an agent CLI turns before it: a title that only spins is not a change. */
  title: z.string().optional(),
  status: TerminalStatus,
  exitCode: z.number().int().optional(),
  /** The harness session running in it, when one is. */
  session: SessionId.optional(),
  /** It shows that harness's agents screen (its background jobs), not a session. */
  agents: HarnessKind.optional(),
  /** An agent CLI runs in it that no session stands for yet: a Codex or Muse CLI before its first prompt. */
  harness: HarnessKind.optional(),
  /** Terminal windows attached to it. */
  windows: z.number().int().nonnegative(),
  startedAt: Timestamp,
});
export type Terminal = z.infer<typeof Terminal>;

export const SessionEventKind = z.enum([
  "status",
  "user_turn",
  "assistant_text",
  "tool_call",
  "tool_result",
  "ask",
  "notification",
  "ended",
]);
export type SessionEventKind = z.infer<typeof SessionEventKind>;

export const SessionEvent = z.object({
  session: SessionId,
  seq: z.number().int().nonnegative(),
  at: Timestamp,
  kind: SessionEventKind,
  payload: z.unknown(),
  raw: z.unknown().optional(),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

// ---------------------------------------------------------------------------------------
// Task

export const TaskStatus = z.enum(["pending", "ready", "active", "paused", "blocked", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(["low", "normal", "high"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: Timestamp }),
  /** `tz` is an IANA zone; the platform's own when absent. */
  z.object({ kind: z.literal("cron"), expr: z.string(), tz: z.string().optional() }),
  z.object({ kind: z.literal("event"), name: z.string(), match: z.record(z.string(), z.unknown()).optional() }),
]);
export type TaskTrigger = z.infer<typeof TaskTrigger>;

export const TaskBlocker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("ask"), ask: AskId }),
  z.object({ kind: z.literal("task"), task: TaskId }),
  z.object({ kind: z.literal("session"), session: SessionId }),
]);
export type TaskBlocker = z.infer<typeof TaskBlocker>;

export const Task = z.object({
  id: TaskId,
  title: z.string(),
  detail: z.string().optional(),
  workspace: WorkspaceId.optional(),
  thread: ThreadId.optional(),
  parent: TaskId.optional(),
  createdBy: Principal,
  status: TaskStatus,
  priority: TaskPriority,
  trigger: TaskTrigger.optional(),
  recurring: z.boolean().optional(),
  blocker: TaskBlocker.optional(),
  sessions: z.array(SessionId),
  result: z.object({ summary: z.string() }).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.optional(),
});
export type Task = z.infer<typeof Task>;

// ---------------------------------------------------------------------------------------
// Listener

/** A node resource, as pressure and metric conditions name it. */
export const PressureResource = z.enum(["cpu", "memory", "gpu", "vram"]);
export const PressureLevel = z.enum(["normal", "warn", "critical"]);

/**
 * What a listener hears. The session kinds are read off the session's events: `session.idle`
 * is idle and done, `session.waiting` idle but waiting on its shells or the user, `session.said`
 * its assistant text, `session.tool` a tool call. `metric` is a condition on the node's samples,
 * `custom` an event a hook raised.
 */
export const ListenerKind = z.enum([
  "session.started",
  "session.idle",
  "session.waiting",
  "session.ask",
  "session.said",
  "session.tool",
  "session.ended",
  "task.ready",
  "node.pressure",
  "node.joined",
  "node.left",
  "metric",
  "custom",
]);
export type ListenerKind = z.infer<typeof ListenerKind>;

/** What a fire does: a turn now, a note for the brain's next turn, or a turn with no tools that tells the user in a line or two. */
export const ListenerDelivery = z.enum(["wake", "note", "notify"]);
export type ListenerDelivery = z.infer<typeof ListenerDelivery>;

/** A resource past a line for a while: every sample of the last `forS` seconds above (or below) `pct` percent. */
export const MetricCondition = z.object({
  resource: PressureResource,
  above: z.number().min(0).max(100).optional(),
  below: z.number().min(0).max(100).optional(),
  forS: z.number().int().positive().max(3600),
});
export type MetricCondition = z.infer<typeof MetricCondition>;

/** What a listener hears, without the platform's bookkeeping: what `listener.add` takes. */
export const ListenerSpec = z.object({
  on: z.array(ListenerKind).min(1),
  /** Filters, all optional; an absent one matches anything. */
  session: SessionId.optional(),
  workspace: WorkspaceId.optional(),
  harness: HarnessKind.optional(),
  origin: SessionOrigin.optional(),
  node: NodeId.optional(),
  task: TaskId.optional(),
  /** `session.tool`: the tool's name. */
  tool: z.string().optional(),
  /** `node.pressure`: the level reached. */
  level: PressureLevel.optional(),
  /** `custom`: the event's name, and the payload values it must have (a shallow match, as a task trigger's). */
  name: z.string().optional(),
  match: z.record(z.string(), z.unknown()).optional(),
  /** Required when `on` has `metric`; its node is `node`, the primary when absent. */
  metric: MetricCondition.optional(),
  deliver: ListenerDelivery,
  /** Fires left; unlimited when absent. The listener is removed when it reaches 0. */
  times: z.number().int().nonnegative().optional(),
  /** The fewest seconds between two fires. */
  cooldownS: z.number().int().nonnegative().optional(),
  /** A task or session id: the listener is removed when that task settles or that session ends. */
  until: z.union([TaskId, SessionId]).optional(),
  /** One line from the brain: why it listens, shown in the fire's seed and in the app's settings. */
  why: z.string().min(1).max(200),
  /**
   * The user's message this listener serves: the request whose result its fires bring back.
   * Set by the brain, not the model; the node reads a fire's result out by how and where that
   * message was asked (config.toml's `[speech]`).
   */
  asked: MessageId.optional(),
});
export type ListenerSpec = z.infer<typeof ListenerSpec>;

export const Listener = ListenerSpec.extend({
  id: ListenerId,
  createdAt: Timestamp,
  fired: z.number().int().nonnegative(),
  lastFiredAt: Timestamp.optional(),
});
export type Listener = z.infer<typeof Listener>;

// ---------------------------------------------------------------------------------------
// Thread, Message, Source, Hit

export const Thread = z.object({
  id: ThreadId,
  topic: z.string().optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  workspace: WorkspaceId.optional(),
  summary: z.string().optional(),
  tags: Tags,
  sessions: z.array(SessionId),
});
export type Thread = z.infer<typeof Thread>;

export const LineRange = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

export const Source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), node: NodeId, path: z.string(), lines: LineRange.optional() }),
  z.object({ kind: z.literal("session"), session: SessionId, seq: LineRange.optional() }),
  z.object({ kind: z.literal("thread"), thread: ThreadId, message: MessageId.optional() }),
  z.object({ kind: z.literal("memory"), name: z.string(), lines: LineRange.optional() }),
]);
export type Source = z.infer<typeof Source>;

export const FileRef = z.object({ node: NodeId, path: z.string(), line: z.number().int().positive().optional() });
export type FileRef = z.infer<typeof FileRef>;

export const MessageRole = z.enum(["user", "orchestrator", "system"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageSource = z.enum(["ui", "controller", "voice", "brain", "gate"]);
export type MessageSource = z.infer<typeof MessageSource>;

/** A block as stored and streamed: quotes carry their expanded text and source. */
export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("quote"),
    text: z.string(),
    source: Source.optional(),
    /** The citation did not resolve; `text` is the block's own and a view marks it. */
    unresolved: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("ref"),
    session: SessionId.optional(),
    thread: ThreadId.optional(),
    task: TaskId.optional(),
    ask: AskId.optional(),
    audit: AuditId.optional(),
    file: FileRef.optional(),
  }),
  z.object({ type: z.literal("audio") }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

/** One thing an orchestrator's turn did or is doing, in the user's words: "Reading plan.md" while it runs, "Read plan.md" once it has. */
export const TurnStep = z.object({
  text: z.string().max(200),
  status: z.enum(["running", "done", "failed"]),
});
export type TurnStep = z.infer<typeof TurnStep>;

export const Message = z.object({
  id: MessageId,
  thread: ThreadId,
  at: Timestamp,
  role: MessageRole,
  source: MessageSource,
  content: z.array(ContentBlock),
  streaming: z.boolean().optional(),
  /** An orchestrator's reply: what its turn did to get there, oldest first. */
  steps: z.array(TurnStep).optional(),
});
export type Message = z.infer<typeof Message>;

export const Corpus = z.enum(["thread", "session", "memory"]);
export type Corpus = z.infer<typeof Corpus>;

export const Hit = z.object({
  corpus: Corpus,
  source: Source,
  workspace: WorkspaceId.optional(),
  at: Timestamp,
  snippet: z.string(),
  tags: Tags,
  score: z.number(),
});
export type Hit = z.infer<typeof Hit>;

// ---------------------------------------------------------------------------------------
// Ask

export const AskType = z.enum(["permission", "input", "choice"]);
export type AskType = z.infer<typeof AskType>;

export const AskSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("harness"), session: SessionId }),
  z.object({ kind: z.literal("gate"), action: z.string(), principal: Principal }),
  z.object({ kind: z.literal("brain"), task: TaskId.optional() }),
]);
export type AskSource = z.infer<typeof AskSource>;

export const AskOption = z.object({
  id: z.string(),
  label: z.string(),
  /** One line under the label. */
  description: z.string().optional(),
  style: z.enum(["primary", "danger", "default"]).optional(),
});
export type AskOption = z.infer<typeof AskOption>;

/** The reserved option id of a free-text answer on an ask that `allowsText`; the text rides in `AskAnswer.text`. */
export const ASK_TEXT_OPTION = "text";

export const AskStatus = z.enum(["open", "answered", "expired", "cancelled"]);
export type AskStatus = z.infer<typeof AskStatus>;

export const AskAnswerer = z.enum(["user", "brain"]);
export type AskAnswerer = z.infer<typeof AskAnswerer>;

export const Remember = z.enum(["once", "session", "always"]);
export type Remember = z.infer<typeof Remember>;

export const AskAnswer = z.object({
  /** The chosen option id; the reserved id `"text"` (`ASK_TEXT_OPTION`) is a free-text answer carried in `text`. */
  option: z.string(),
  /** Every chosen option id on a `multiple` ask, `option` first. */
  options: z.array(z.string()).optional(),
  text: z.string().optional(),
  by: Principal,
  at: Timestamp,
});
export type AskAnswer = z.infer<typeof AskAnswer>;

export const Ask = z.object({
  id: AskId,
  node: NodeId,
  type: AskType,
  source: AskSource,
  title: z.string(),
  detail: z.string().optional(),
  options: z.array(AskOption),
  /** Several options may be chosen at once. */
  multiple: z.boolean().optional(),
  allowsText: z.boolean().optional(),
  answerableBy: z.array(AskAnswerer),
  status: AskStatus,
  answer: AskAnswer.optional(),
  remember: Remember.optional(),
  createdAt: Timestamp,
  expiresAt: Timestamp.optional(),
});
export type Ask = z.infer<typeof Ask>;

// ---------------------------------------------------------------------------------------
// AuditEntry

export const Decision = z.enum(["allow", "deny", "ask"]);
export type Decision = z.infer<typeof Decision>;

export const Outcome = z.enum(["ok", "error", "denied", "cancelled"]);
export type Outcome = z.infer<typeof Outcome>;

export const AuditResult = z.object({
  summary: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  body: z.unknown().optional(),
});
export type AuditResult = z.infer<typeof AuditResult>;

export const AuditEntry = z.object({
  id: AuditId,
  node: NodeId,
  at: Timestamp,
  principal: Principal,
  via: ClientId.optional(),
  action: z.string(),
  target: z.string().optional(),
  args: z.unknown(),
  decision: Decision,
  ask: AskId.optional(),
  outcome: Outcome.optional(),
  result: AuditResult.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  thread: ThreadId.optional(),
  task: TaskId.optional(),
  correlation: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ---------------------------------------------------------------------------------------
// Metrics

export const ProcessOwner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), session: SessionId }),
  z.object({ kind: z.literal("platform") }),
  z.object({ kind: z.literal("brain") }),
  z.object({ kind: z.literal("sidecar"), name: z.string() }),
  z.object({ kind: z.literal("other") }),
]);
export type ProcessOwner = z.infer<typeof ProcessOwner>;

/** One profile's harness tokens and cost, over a sample's span or a range. */
export const ProfileTokens = z.object({
  in: z.number().int().nonnegative(),
  out: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  cost: z.number().nonnegative().optional(),
});
export type ProfileTokens = z.infer<typeof ProfileTokens>;

/** One of a plan's usage windows: the share of it the login has used, and when it starts over. */
export const LimitWindow = z.object({
  percent: z.number().min(0),
  resetsAt: Timestamp.optional(),
});
export type LimitWindow = z.infer<typeof LimitWindow>;

/** A profile's plan limits as the vendor last reported them: the session (five-hour) window and the weekly one. */
export const ProfileLimits = z.object({
  /** When the vendor reported them. */
  at: Timestamp,
  session: LimitWindow.optional(),
  weekly: LimitWindow.optional(),
});
export type ProfileLimits = z.infer<typeof ProfileLimits>;

export const MetricsSample = z.object({
  node: NodeId,
  at: Timestamp,
  cpu: z.number().min(0),
  memory: z.object({ used: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  gpu: z
    .array(
      z.object({
        name: z.string(),
        util: z.number().min(0),
        vramUsed: z.number().int().nonnegative(),
        vramTotal: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  processes: z.array(
    z.object({
      pid: z.number().int().nonnegative(),
      parent: z.number().int().nonnegative(),
      name: z.string(),
      cpu: z.number().min(0),
      memory: z.number().int().nonnegative(),
      vram: z.number().int().nonnegative().optional(),
      owner: ProcessOwner,
    }),
  ),
  llm: z.record(z.string(), z.object({ in: z.number().int().nonnegative(), out: z.number().int().nonnegative() })),
  /** Harness session tokens and cost per profile since the previous sample; a rollup sums them over its minute. */
  profiles: z.record(ProfileId, ProfileTokens).optional(),
  /** Each profile's plan limits, the latest known, on every sample: not a delta. */
  limits: z.record(ProfileId, ProfileLimits).optional(),
});
export type MetricsSample = z.infer<typeof MetricsSample>;

/** What each profile's sessions spent over a range, summed on the node: the spend panel's base, which live samples add to. */
export const SpendTotals = z.object({
  /** The newest sample the sums include; a sample at or before it is already counted. */
  at: Timestamp,
  profiles: z.record(ProfileId, ProfileTokens),
});
export type SpendTotals = z.infer<typeof SpendTotals>;

// ---------------------------------------------------------------------------------------
// Tools, events, prompts, memory, views

export const ToolSource = z.enum(["builtin", "editable"]);
export type ToolSource = z.infer<typeof ToolSource>;

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  schema: JSONSchema,
  source: ToolSource,
  node: NodeId,
  risk: RiskClass,
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const EventDefinition = z.object({
  name: z.string(),
  description: z.string(),
  payload: JSONSchema.optional(),
  source: z.union([z.literal("builtin"), z.object({ hook: z.string() })]),
  node: NodeId,
});
export type EventDefinition = z.infer<typeof EventDefinition>;

export const Prompt = z.object({
  name: z.string(),
  description: z.string().optional(),
  tags: Tags,
  variables: z.array(z.string()).optional(),
  body: z.string(),
  updatedAt: Timestamp,
});
export type Prompt = z.infer<typeof Prompt>;

export const MemoryKind = z.enum(["user", "preference", "decision", "summary", "entity"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const Memory = z.object({
  name: z.string(),
  description: z.string().optional(),
  kind: MemoryKind.optional(),
  tags: Tags,
  body: z.string(),
  updatedAt: Timestamp,
});
export type Memory = z.infer<typeof Memory>;

export const Scope = z.enum([
  "chat",
  "sessions:read",
  "sessions:write",
  "tasks:read",
  "tasks:write",
  "asks:answer",
  "voice",
  "views",
  "controllers",
  "nodes",
  "audit:read",
  "metrics:read",
  "account",
  "updates",
  "remote",
  "terminal",
]);
export type Scope = z.infer<typeof Scope>;

export const ViewManifest = z.object({
  id: z.string(),
  name: z.string(),
  entry: z.string(),
  default: z.boolean(),
  source: ToolSource,
  scopes: z.array(Scope).optional(),
  version: z.string().optional(),
});
export type ViewManifest = z.infer<typeof ViewManifest>;

// ---------------------------------------------------------------------------------------
// Access and grants

/** A grant's say in agent messaging: nothing, answering what reached it, or starting a conversation too. */
export const MessagesRule = z.enum(["none", "reply", "send"]);
export type MessagesRule = z.infer<typeof MessagesRule>;

/**
 * What one credential may do: its scopes, and, when it is limited, the nodes, workspaces and
 * paths it may reach. Access with any of the three is limited and never holds a global scope
 * (see access.ts); `messages` is what it may do in agent messaging.
 */
export const Access = z.object({
  scopes: z.array(Scope),
  nodes: z.array(NodeId).optional(),
  workspaces: z.array(WorkspaceId).optional(),
  paths: z.array(z.string().min(1)).optional(),
  messages: MessagesRule,
});
export type Access = z.infer<typeof Access>;

// ---------------------------------------------------------------------------------------
// Client

export const ClientKind = z.enum(["ui", "controller"]);
export type ClientKind = z.infer<typeof ClientKind>;

/** How `voice.audio` carries its samples: Opus packets, or raw little-endian int16. */
export const AudioCodec = z.enum(["opus", "pcm"]);
export type AudioCodec = z.infer<typeof AudioCodec>;

/**
 * What a client does with audio: a microphone (`in`), a speaker (`out`), the codecs it
 * speaks, best first (PCM alone when absent), and whether it says when a reply finished
 * playing (`played`, with `voice.played`).
 */
export const AudioCapabilities = z.object({
  in: z.boolean(),
  out: z.boolean(),
  codecs: z.array(AudioCodec).optional(),
  played: z.boolean().optional(),
});

/**
 * How a client that crossed networks reaches the node: `direct` on a data channel of its own
 * (a hole punched through both NATs, a predicted port, the router's mapping), `turn` on one
 * relayed by a TURN server. A client without it came in on the LAN or through the relay.
 */
export const ClientPath = z.enum(["direct", "turn"]);
export type ClientPath = z.infer<typeof ClientPath>;

export const Client = z.object({
  id: ClientId,
  kind: ClientKind,
  name: z.string().optional(),
  node: NodeId.optional(),
  /** The paired controller this connection authenticated as, for a `kind: controller` client. */
  controller: ControllerId.optional(),
  scopes: z.array(Scope),
  /** What the client may reach, from its grant: the scopes again, and the limits when it has any. */
  access: Access.optional(),
  via: Via,
  /** A data channel under a `via: relay` client: the relay stays its fallback. */
  path: ClientPath.optional(),
  audio: AudioCapabilities,
  connectedAt: Timestamp,
});
export type Client = z.infer<typeof Client>;

export const PushPlatform = z.enum(["android", "ios"]);
export type PushPlatform = z.infer<typeof PushPlatform>;

/**
 * A paired controller: a phone or browser that claimed a pairing code once and holds a
 * token of its own from then on. It outlives its connections; `connected` says whether
 * one is open now. `relay` says the server relay was granted to it, so it reaches the
 * node from any network; `push` names the device it registered for push notifications
 * (the device token itself stays in the node's store). `account` is the GitHub login a
 * phone signed in with when it paired through the account rather than with a code.
 */
export const Controller = z.object({
  id: ControllerId,
  name: z.string(),
  pairedAt: Timestamp,
  lastSeen: Timestamp.optional(),
  connected: z.boolean(),
  relay: z.boolean().optional(),
  push: z.object({ platform: PushPlatform, registeredAt: Timestamp }).optional(),
  account: z.string().optional(),
  /** What the phone may do; absent on a node from before grants, where every phone had it all. */
  access: Access.optional(),
  /** When the phone's grant ends by itself. */
  expiresAt: Timestamp.optional(),
  /** How its connection reaches the node now, or last did: the LAN, the relay, a data channel direct or through TURN. */
  path: z.enum(["lan", "relay", "direct", "turn"]).optional(),
});
export type Controller = z.infer<typeof Controller>;

/** What a grant lets in: a phone (its controller id) or a node (a `grt_` id). */
export const GrantKind = z.enum(["controller", "node"]);
export type GrantKind = z.infer<typeof GrantKind>;

/** What a node grant makes the node: a full member, which can hold the replica and take over, or hands the primary drives and nothing else. */
export const GrantRole = z.enum(["full", "hands"]);
export type GrantRole = z.infer<typeof GrantRole>;

/**
 * `pending` until its invite is redeemed; `active` from then on; `reinvite` when a key it
 * held went with a node that held the replica and the grant could not be re-keyed over a
 * live link, so the machine must be invited again.
 */
export const GrantStatus = z.enum(["pending", "active", "reinvite"]);
export type GrantStatus = z.infer<typeof GrantStatus>;

/**
 * One credential that reaches this node from outside: a phone or a node, with its own key
 * and its own access. Its secrets never leave the node that keeps it: a client sees the row.
 * `node` is the node id a node grant was bound to when it was redeemed; `local` marks one
 * minted on this node alone rather than on the primary.
 */
export const Grant = z.object({
  id: GrantRef,
  kind: GrantKind,
  name: z.string(),
  access: Access,
  status: GrantStatus,
  role: GrantRole.optional(),
  node: NodeId.optional(),
  createdAt: Timestamp,
  expiresAt: Timestamp.optional(),
  /** Until when a pending grant's invite may be redeemed. */
  inviteExpiresAt: Timestamp.optional(),
  lastSeen: Timestamp.optional(),
  connected: z.boolean(),
  relay: z.boolean().optional(),
  push: z.object({ platform: PushPlatform, registeredAt: Timestamp }).optional(),
  account: z.string().optional(),
  local: z.boolean().optional(),
});
export type Grant = z.infer<typeof Grant>;

/** A workspace node's membership: in no cluster, seeking its primary, linked, or its daemon stopping. */
export const GuestState = z.enum(["unlinked", "seeking", "linked", "stopped"]);
export type GuestState = z.infer<typeof GuestState>;

/**
 * A workspace node as the terminal on its machine lists it: one folder of the machine, lent
 * to another person's cluster as a hands node of it. Never shown to the machine's own apps.
 */
export const GuestInfo = z.object({
  id: NodeId,
  name: z.string(),
  /** The folder it owns, absolute. */
  folder: z.string(),
  /** The profile its sessions run on; absent, each harness's usual one on the machine. */
  profile: ProfileId.optional(),
  state: GuestState,
  /** The cluster it is in, and the primary it joined. */
  cluster: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  primary: z.object({ id: NodeId, name: z.string() }).optional(),
  /** How it reaches its primary, while linked. */
  via: Via.optional(),
  /** When its grant ends by itself. */
  expiresAt: Timestamp.optional(),
});
export type GuestInfo = z.infer<typeof GuestInfo>;

// ---------------------------------------------------------------------------------------
// Entitlement, usage, releases

export const BrainChannel = z.enum(["stable", "beta"]);

export const Entitlement = z.object({
  subject: z.string(),
  plan: z.string(),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  graceSeconds: z.number().int().nonnegative(),
  limits: z.object({
    sessions: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
    memoryTier: z.string(),
    planning: z.array(z.string()),
    /** The bytes of ciphertext the backup may hold; absent, none (tokens issued before the backup carry no field). */
    backupBytes: z.number().int().nonnegative().optional(),
  }),
  hosted: z.object({
    llm: z.boolean(),
    voice: z.boolean(),
    compute: z.boolean(),
    relay: z.boolean(),
    push: z.boolean(),
    /** The cloud backup; absent means no, so a token issued before it still parses. */
    backup: z.boolean().optional(),
    /** Direct connections: data channels across networks, and TURN when no direct path opens. */
    direct: z.boolean().optional(),
  }),
  brainChannel: BrainChannel,
});
export type Entitlement = z.infer<typeof Entitlement>;

/**
 * What a node has with no account, a forged token or one past its grace: the same object
 * in the daemon, the brain and the server, so the three never disagree about the floor.
 * Nothing hosted; two agents at once; memory limited to the recent tier; every planning
 * mode, since milestone 7 shipped them free. The timestamps are zero: it was never issued
 * and never expires.
 */
export const FREE_ENTITLEMENT: Entitlement = {
  subject: "",
  plan: "free",
  issuedAt: 0,
  expiresAt: 0,
  graceSeconds: 0,
  limits: { sessions: 2, nodes: 0, memoryTier: "recent", planning: ["now", "at", "cron", "event", "recurring", "steps"] },
  hosted: { llm: false, voice: false, compute: false, relay: false, push: false },
  brainChannel: "stable",
};

/**
 * The metered usage: what `Usage.metrics` is keyed by, counted per calendar month (UTC).
 * `relayed_nodes` and `backup_bytes` are gauges rather than counters: the nodes linked
 * through the relay right now against the plan's `limits.nodes`, and the ciphertext the
 * backup holds against its `limits.backupBytes`. `turn_credentials` counts the TURN
 * credentials minted, since the TURN service reports no bytes per credential.
 */
export const USAGE_METRICS = [
  "llm_tokens_in",
  "llm_tokens_out",
  "stt_seconds",
  "tts_chars",
  "embed_tokens",
  "relay_messages",
  "push_count",
  "relayed_nodes",
  "backup_bytes",
  "turn_credentials",
] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const Usage = z.object({
  period: z.string(),
  metrics: z.record(z.string(), z.object({ used: z.number().nonnegative(), cap: z.number().nonnegative() })),
});
export type Usage = z.infer<typeof Usage>;

/**
 * The cloud backup as this node sees it. `enabled` with the key in hand; `state` what the
 * sender is doing: `idle` when everything is on the server, `syncing` while objects are on
 * their way (`pending` how many), `paused` while the link, the plan or the role keep it
 * from sending, `conflict` when another node owns the account's backup, `full` when the
 * plan's bytes are spent, `restoring` while a restore runs (`progress` counts the objects).
 * `remote` describes the backup the server holds even when this node has no key for it,
 * which is how a fresh install offers a restore.
 */
export const BackupState = z.object({
  enabled: z.boolean(),
  keyId: z.string().optional(),
  state: z.enum(["idle", "syncing", "paused", "conflict", "full", "restoring"]),
  pending: z.number().int().nonnegative().optional(),
  lastSyncAt: Timestamp.optional(),
  bytes: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  remote: z
    .object({
      objects: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      updatedAt: Timestamp.optional(),
      node: NodeId.optional(),
    })
    .optional(),
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  error: z.string().optional(),
});
export type BackupState = z.infer<typeof BackupState>;

// ---------------------------------------------------------------------------------------
// Direct connections

/** A STUN or TURN server as WebRTC's `RTCIceServer` has it; TURN ones carry short-lived credentials. */
export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

/**
 * How a data channel's selected pair reaches the far end, as the node's helper sees it:
 * `host` both ends' own addresses, `srflx` through a NAT's address STUN saw, `prflx` through
 * one the far end's own checks taught, `predicted` through a port the node predicted for a
 * sequential NAT, `mapped` through the mapping the node's router keeps, `relay` through a
 * TURN server the far end uses.
 */
export const DirectPathType = z.enum(["host", "srflx", "prflx", "predicted", "mapped", "relay"]);
export type DirectPathType = z.infer<typeof DirectPathType>;

/** One data channel a node holds now: a phone (by its controller) or another node. */
export const DirectPeer = z.object({
  kind: z.enum(["controller", "node"]),
  id: z.string(),
  path: DirectPathType,
  rttMs: z.number().nonnegative().optional(),
  since: Timestamp,
});
export type DirectPeer = z.infer<typeof DirectPeer>;

/**
 * A node's direct connections: `off` while its owner has not switched them on, `starting`
 * while the helper comes up, `ready` when phones and nodes may open data channels to it,
 * `unavailable` when switched on but it cannot run (`reason`: signed out, a plan without
 * them, a helper that keeps failing). `port` is the helper's UDP port, `mapping` what the
 * node's router answered, `ipv6` whether a global IPv6 address is among its own.
 */
export const DirectState = z.object({
  node: NodeId,
  state: z.enum(["off", "starting", "ready", "unavailable"]),
  reason: z.string().optional(),
  port: z.number().int().min(0).max(65535).optional(),
  mapping: z.object({ status: z.enum(["off", "probing", "none", "mapped"]), protocols: z.array(z.string()).optional() }).optional(),
  ipv6: z.boolean().optional(),
  peers: z.array(DirectPeer),
});
export type DirectState = z.infer<typeof DirectState>;

/** A day's path counts, as a node reports them: no ids, no addresses, only how often each path won. */
export const DirectReport = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "expected YYYY-MM-DD" }),
  counts: z
    .array(
      z.object({
        kind: z.enum(["client", "node"]),
        path: z.union([DirectPathType, z.literal("failed")]),
        count: z.number().int().positive().max(1_000_000),
      }),
    )
    .max(64),
});
export type DirectReport = z.infer<typeof DirectReport>;

export const Release = z.object({
  component: z.enum(["platform", "brain", "model"]),
  name: z.string().optional(),
  version: z.string(),
  channel: BrainChannel,
  os: Platform.optional(),
  arch: z.string().optional(),
  protocol: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
  url: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string(),
  publishedAt: Timestamp,
});
export type Release = z.infer<typeof Release>;

/** One channel's feed for one OS and architecture, at `<feed>/<channel>/<os>-<arch>.json`. */
export const ReleaseFeed = z.object({
  generatedAt: Timestamp.optional(),
  releases: z.array(Release),
});
export type ReleaseFeed = z.infer<typeof ReleaseFeed>;

// ---------------------------------------------------------------------------------------
// Misc

export const ProtocolErrorEntity = z.object({
  code: ErrorCode,
  message: z.string(),
  data: z.unknown().optional(),
  retryable: z.boolean(),
});

export const ModelRef = z.union([
  z.object({ tier: z.enum(["tiny", "fast", "smart", "local"]) }),
  z.object({ model: z.string().regex(/^[^/]+\/.+$/, { message: "expected provider/name" }) }),
]);
export type ModelRef = z.infer<typeof ModelRef>;

export const VoiceState = z.enum(["idle", "listening", "transcribing", "thinking", "speaking"]);
export type VoiceState = z.infer<typeof VoiceState>;

/**
 * Why an utterance the button held came to nothing, sent with the `idle` that ends it: no audio
 * reached the node from the microphone (`no-audio`), only digital silence did, as from a
 * microphone unplugged or muted (`silence`), sound with no speech in it did (`no-speech`), or
 * speech did and the recogniser made no words of it (`no-words`).
 */
export const VoiceUnheard = z.enum(["no-audio", "silence", "no-speech", "no-words"]);
export type VoiceUnheard = z.infer<typeof VoiceUnheard>;

/**
 * Why an utterance stopped being recorded while the user was still speaking: it reached the
 * most one utterance may last (`limit`), or the account's transcription allowance ran out
 * (`quota`). What came after was not heard.
 */
export const VoiceStopped = z.enum(["limit", "quota"]);
export type VoiceStopped = z.infer<typeof VoiceStopped>;

/** Every entity schema by the name entities.md uses, for fixtures and the JSON Schema dump. */
export const entities = {
  Node,
  Workspace,
  HarnessKind,
  HarnessCapabilities,
  HarnessProfile,
  Session,
  SessionEvent,
  Terminal,
  Task,
  Listener,
  Thread,
  Message,
  Source,
  Hit,
  Ask,
  AuditEntry,
  MetricsSample,
  ProfileTokens,
  ProfileLimits,
  SpendTotals,
  ProcessOwner,
  ToolDefinition,
  EventDefinition,
  Prompt,
  Memory,
  ViewManifest,
  Principal,
  Client,
  Controller,
  Access,
  MessagesRule,
  Grant,
  GrantKind,
  GrantRole,
  GrantStatus,
  GuestState,
  GuestInfo,
  PushPlatform,
  Scope,
  Entitlement,
  Usage,
  BackupState,
  IceServer,
  DirectState,
  DirectReport,
  Release,
  ReleaseFeed,
  Error: ProtocolErrorEntity,
  ModelRef,
  AssistantHarness,
  AssistantStatus,
  AssistantState,
  VoiceState,
} as const;
