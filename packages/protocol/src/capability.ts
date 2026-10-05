// The capability protocol: events flow into the brain, requests flow out, every request
// crosses a gate; a signal out changes nothing and crosses none. JSON-RPC over stdio between brain-link and the brain, and over /ws/node
// between primary and secondary. See architecture.md, "Capability protocol".

import { z } from "zod";
import {
  Ask,
  AskAnswer,
  AssistantHarness,
  AssistantStatus,
  ContentBlock,
  EventDefinition,
  HarnessProfile,
  Hit,
  LaunchMode,
  Memory,
  MetricsSample,
  ModelRef,
  Node,
  NodeRole,
  ProfileLimits,
  Prompt,
  TurnStep,
  Session,
  SessionEvent,
  SessionStatus,
  Task,
  TaskBlocker,
  TaskPriority,
  TaskStatus,
  TaskTrigger,
  Thread,
  Message,
  TokenCounts,
  ToolDefinition,
  Workspace,
  HarnessKind,
  Tags,
  Listener,
  ListenerSpec,
  PressureLevel,
  PressureResource,
  Terminal,
} from "./entities.ts";
import { AskId, ListenerId, MessageId, NodeId, ProfileId, SessionId, TaskId, ThreadId, Timestamp, WorkspaceId } from "./ids.ts";
import { RpcId } from "./rpc.ts";

/** The protocol version this package describes. Bumped only for incompatible change. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------
// Handshake

export const CapabilityHello = z.object({
  protocolVersion: z.number().int().positive(),
  /** The range a brain supports, so brain-link can refuse one outside its own. */
  protocolRange: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).optional(),
  brainVersion: z.string().optional(),
  platformVersion: z.string(),
  nodeId: NodeId,
  role: z.union([NodeRole, z.literal("brain")]),
  /** The platform's IANA time zone: what a cron trigger without `tz` runs in and what the brain tells the time in. */
  tz: z.string().optional(),
  /**
   * What the platform does beyond its protocol version, in its hello: a brain uses one of these
   * only when it is named, since an older platform drops what it does not know. `send.prepare`:
   * `session.send` takes `task`, `clear` and `mode`, and `session.spawn` takes `mode`;
   * `task.ready.cleared`: an unblocked `task.ready` names the blocker that cleared;
   * `task.list.parent`: `task.list` filters by `parent`; `session.git`: the brain reads a
   * session's repository; `spawn.mode`: `session.spawn` takes any of a Claude session's
   * modes, one looser than asking before each edit under the user's ask; `codex.bypass`: it
   * takes `bypassPermissions` for a Codex session too; `terminal.prompt`: the brain sees the
   * agent CLIs waiting at their first prompt (`terminal.list`, `terminal.waiting`) and gives
   * one its first prompt (`terminal.prompt`); `assistant`: the chat runs in an agent session
   * of its own, which the platform starts and types into: the brain wakes it
   * (`assistant.wake`), serves it its rules, tools and context (`brainRequests`) and hears its
   * turns (`assistant.prompted`, `assistant.step`, `assistant.replied`, `assistant.state`).
   */
  features: z.array(z.string()).optional(),
});
export type CapabilityHello = z.infer<typeof CapabilityHello>;

// ---------------------------------------------------------------------------------------
// Events → brain. Every event carries `at`; the brain reads time from nothing else.

const event = <T extends z.ZodRawShape>(shape: T) => z.object({ at: Timestamp, ...shape });

/** A file of the editable layer that did not load: its path relative to `~/.cophyla`, and why. */
export const EditableProblem = z.object({ file: z.string(), message: z.string() });
export type EditableProblem = z.infer<typeof EditableProblem>;

export const UserMessageSource = z.enum(["ui", "voice", "controller"]);
export const ActivityState = z.enum(["typing", "speaking", "idle"]);

/**
 * What the chat's own session was given as a prompt: the user's message, by the id it was
 * stored under; a wake of the brain's, by the id the brain gave it; or words typed straight
 * into its terminal, which no message stands for.
 */
export const AssistantPrompt = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), message: MessageId }),
  z.object({ kind: z.literal("wake"), wake: z.string() }),
  z.object({ kind: z.literal("terminal") }),
]);
export type AssistantPrompt = z.infer<typeof AssistantPrompt>;

export const capabilityEvents = {
  "session.discovered": event({ session: Session }),
  /** `event` is absent when only the row changed (an annotate, a new title): nothing to wake for. */
  "session.updated": event({ session: Session, event: SessionEvent.optional() }),
  "session.ask": event({ session: SessionId, ask: Ask }),
  "session.ended": event({ session: Session }),
  /**
   * `speak`: the node's word on whether the answer is read out, by config.toml's `[speech]`,
   * decided before the brain writes it. Absent from an older node, when a spoken message's
   * answer is read out and a typed one's is not.
   */
  "user.message": event({
    text: z.string(),
    source: UserMessageSource,
    mode: z.literal("quick").optional(),
    message: MessageId.optional(),
    thread: ThreadId.optional(),
    speak: z.boolean().optional(),
  }),
  "user.activity": event({ state: ActivityState, source: UserMessageSource }),
  "voice.transcript": event({ text: z.string() }),
  /**
   * `event` is the custom event that fired an event trigger: its name and payload, so the task
   * can act on them. `cleared`, on an unblocked one, is the blocker that cleared: a task that
   * finished, an ask answered, a session that went idle or ended.
   */
  "task.ready": event({ id: TaskId, cause: z.enum(["trigger", "unblocked"]), event: z.object({ name: z.string(), payload: z.unknown() }).optional(), cleared: TaskBlocker.optional() }),
  "task.updated": event({ id: TaskId }),
  "thread.updated": event({ id: ThreadId }),
  "workspace.updated": event({ id: WorkspaceId }),
  "event.custom": event({ name: z.string(), payload: z.unknown() }),
  "node.joined": event({ node: Node }),
  "node.left": event({ node: NodeId }),
  "node.pressure": event({ node: NodeId, resource: PressureResource, level: PressureLevel }),
  /**
   * A terminal began or stopped holding an agent CLI no session stands for yet (a Codex or Muse
   * CLI before its first prompt): its row, with `harness` while it waits and without once a
   * session holds it, the CLI went or the terminal exited. Only the change is told, never a retitle.
   */
  "terminal.waiting": event({ terminal: Terminal }),
  /** `problems`: the editable files that failed to load, so the brain can hand them back to whoever wrote them. */
  "tools.changed": event({ problems: z.array(EditableProblem).optional() }),
  "prompts.changed": event({}),
  "memory.changed": event({}),
  "events.changed": event({ problems: z.array(EditableProblem).optional() }),
  "entitlement.updated": event({ token: z.string() }),
  /**
   * A listener of the brain's heard what it listens for: the event that fired it (a capability
   * event's name and params, or `metric` with the node's reading) and the listener after the
   * fire. `last`: this fire spent it and it is gone. `speak`, on a wake or notify fire of a
   * listener that serves a request (`asked`): whether the result is read out, by `[speech]`.
   */
  "listener.fired": event({ listener: Listener, event: z.object({ name: z.string(), params: z.record(z.string(), z.unknown()) }), last: z.boolean(), speak: z.boolean().optional() }),
  /** A listener is gone: spent, its `until` settled or ended, or removed by the user or the brain. */
  "listener.removed": event({ id: ListenerId, why: z.enum(["spent", "until", "user", "brain"]) }),
  /**
   * The chat's own session took a prompt: its turn begins, and the tool calls that follow
   * (`tool.call`) are that turn's. A user's message typed while a turn of theirs runs joins it.
   */
  "assistant.prompted": event({ prompt: AssistantPrompt }),
  /** It ran one of its harness's own tools (a read, a search of the web): a step of the turn, for the chat's progress. */
  "assistant.step": event({ tool: z.string(), input: z.unknown() }),
  /**
   * Its turn ended with these words, in the reply syntax: the brain says them. `prompt` is the
   * one the turn answered. `interrupted`: nothing was said, because the session could not be
   * handed the prompt or its program went under the turn; a wake is owed again.
   */
  "assistant.replied": event({ text: z.string(), prompt: AssistantPrompt.optional(), interrupted: z.boolean().optional() }),
  /** Where it stands: the brain wakes it only while it is `idle` or `busy`. */
  "assistant.state": event({ status: AssistantStatus, harness: AssistantHarness.optional(), profile: ProfileId.optional(), model: z.string().optional() }),
} as const;

export type CapabilityEventName = keyof typeof capabilityEvents;
export type CapabilityEventParams<N extends CapabilityEventName> = z.infer<(typeof capabilityEvents)[N]>;

// ---------------------------------------------------------------------------------------
// Requests ← brain

const Empty = z.object({});

export const SessionFilter = z.object({
  node: NodeId.optional(),
  harness: HarnessKind.optional(),
  status: z.array(SessionStatus).optional(),
  workspace: WorkspaceId.optional(),
});

export const HistoryWindow = z.object({
  before: z.number().int().nonnegative().optional(),
  around: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

export const TaskFilter = z.object({
  status: z.array(TaskStatus).optional(),
  workspace: WorkspaceId.optional(),
  blocker: z.enum(["user", "ask", "task", "session"]).optional(),
  /** A plan's steps: the tasks whose `parent` it is, finished ones included. */
  parent: TaskId.optional(),
});

export const TaskCreate = z.object({
  title: z.string(),
  detail: z.string().optional(),
  workspace: WorkspaceId.optional(),
  thread: ThreadId.optional(),
  parent: TaskId.optional(),
  priority: TaskPriority.optional(),
  trigger: TaskTrigger.optional(),
  recurring: z.boolean().optional(),
  blocker: TaskBlocker.optional(),
});

export const TaskPatch = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  trigger: TaskTrigger.nullable().optional(),
  recurring: z.boolean().optional(),
  blocker: TaskBlocker.nullable().optional(),
  sessions: z.array(SessionId).optional(),
  result: z.object({ summary: z.string() }).optional(),
});

export const ThreadFilter = z.object({
  workspace: WorkspaceId.optional(),
  since: Timestamp.optional(),
  open: z.boolean().optional(),
});

export const Annotate = z.object({
  on: z.union([SessionId, ThreadId, WorkspaceId]),
  intent: z.string().optional(),
  topic: z.string().optional(),
  workspace: WorkspaceId.optional(),
  summary: z.string().optional(),
  tags: Tags.optional(),
});

export const PromptMeta = Prompt.omit({ body: true });
export const MemoryMeta = Memory.omit({ body: true });

export const PromptWrite = z.object({
  name: z.string(),
  description: z.string().optional(),
  tags: Tags.optional(),
  variables: z.array(z.string()).optional(),
  body: z.string(),
});

export const MemoryWrite = z.object({
  name: z.string(),
  description: z.string().optional(),
  kind: Memory.shape.kind,
  tags: Tags.optional(),
  body: z.string(),
});

export const TimeRange = z.object({ from: Timestamp.optional(), to: Timestamp.optional() });

export const EventRecord = z.object({
  name: z.string(),
  node: NodeId,
  at: Timestamp,
  payload: z.unknown(),
});

export const RecallIn = z.enum(["thread", "session", "memory"]);

/** What the brain says or speaks: blocks whose quotes may cite a stored result instead of carrying text. */
export const OutBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("quote"),
    /** The request whose result holds the text, and the lines within it. */
    cite: z.object({ request: z.string(), lines: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional() }).optional(),
    /** Own text, for quoting the user or when nothing is cited. */
    text: z.string().optional(),
  }),
  ContentBlock.options[2],
]);
export type OutBlock = z.infer<typeof OutBlock>;

/**
 * An opaque provider token some models attach to a block (Gemini's thought signature). The
 * brain echoes it back unchanged on the block it came with and never reads it.
 */
const Signature = z.string().optional();

export const LlmContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), signature: Signature }),
  z.object({ type: z.literal("image"), mime: z.string(), base64: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown(), signature: Signature }),
  z.object({ type: z.literal("tool_result"), toolUseId: z.string(), content: z.string(), isError: z.boolean().optional() }),
]);
export type LlmContent = z.infer<typeof LlmContent>;

export const LlmMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(LlmContent),
});
export type LlmMessage = z.infer<typeof LlmMessage>;

export const LlmTool = z.object({
  name: z.string(),
  description: z.string(),
  schema: z.record(z.string(), z.unknown()),
});
export type LlmTool = z.infer<typeof LlmTool>;

export const LlmComplete = z.object({
  model: ModelRef,
  system: z.string().optional(),
  messages: z.array(LlmMessage),
  tools: z.array(LlmTool).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** This call's thinking level, over the tier's. */
  thinking: z.enum(["minimal", "low", "medium", "high"]).optional(),
  /** The text may be the reply the user reads: cophylad streams it as a provisional message; absent, nothing streams. */
  reply: z.boolean().optional(),
  /**
   * A step of the caller's turn `key`, whose system prompt, tools and earlier messages are the
   * same from step to step: a provider that can caches them once for the turn. `eager` makes
   * the cache before the first step (nobody waits on the turn); otherwise beside it, for the
   * steps after.
   */
  cache: z.object({ key: z.string().min(1).max(200), eager: z.boolean().optional() }).optional(),
});
export type LlmComplete = z.infer<typeof LlmComplete>;

export const LlmResult = z.object({
  content: z.array(LlmContent),
  stopReason: z.enum(["end", "tool_use", "max_tokens", "cancelled"]),
  /** `in` is the whole prompt, the part the provider read from its cache (`cacheRead`) among it, as Gemini counts. */
  usage: TokenCounts,
  model: z.string(),
});
export type LlmResult = z.infer<typeof LlmResult>;

/**
 * The modes a message may put a Claude session in: none looser than asking before each write,
 * so a rule that lets the brain message a session never loosens it unasked. A looser mode is
 * `session.mode`'s, or a start's, under an ask of its own.
 */
export const WorkMode = z.enum(["default", "plan"]);
export type WorkMode = z.infer<typeof WorkMode>;

/** A commit as `session.git`'s `log` lists it: its short hash, its subject, and when it was made. */
export const GitCommit = z.object({ commit: z.string(), subject: z.string(), at: Timestamp });
export type GitCommit = z.infer<typeof GitCommit>;

/**
 * A repository as VS Code's status bar has it: the branch checked out (none while HEAD is
 * detached), the commit it is at (none before the first), the branch it tracks, the commits
 * it has that one lacks (`ahead`, to push) and the other way (`behind`, to pull) as of the
 * last fetch, and how many files changed or are new. `log`, when asked for, holds the last
 * commits, newest first.
 */
export const GitState = z.object({
  branch: z.string().optional(),
  commit: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  changes: z.number().int().nonnegative(),
  log: z.array(GitCommit).optional(),
});
export type GitState = z.infer<typeof GitState>;

/** The most commits `session.git` lists. */
export const GIT_LOG_MAX = 20;

/** What `session.send` answers: `held` when the harness will hold the message for approval in its own terminal. */
export const SendResult = z.object({
  status: z.enum(["queued", "held"]),
  /** Names the message in the later `notification` event that reports its delivery. */
  ref: z.string().optional(),
});
export type SendResult = z.infer<typeof SendResult>;

export const capabilityRequests = {
  "node.list": { params: Empty, result: z.object({ nodes: z.array(Node) }) },
  "profile.list": { params: z.object({ node: NodeId.optional() }), result: z.object({ profiles: z.array(HarnessProfile) }) },
  /** Each profile's plan limits, read now when the last reading is old; a node's alone when one is named. */
  "profile.limits": { params: z.object({ node: NodeId.optional() }), result: z.object({ limits: z.record(ProfileId, ProfileLimits) }) },
  "session.list": { params: z.object({ filter: SessionFilter.optional() }), result: z.object({ sessions: z.array(Session) }) },
  "session.history": {
    params: z.object({ id: SessionId, ...HistoryWindow.shape }),
    result: z.object({ events: z.array(SessionEvent) }),
  },
  "session.send": {
    params: z.object({
      id: SessionId,
      text: z.string(),
      /**
       * Whose words these are, set by a primary forwarding the message to the node that owns
       * the session: a user's are typed into a session in a tether terminal, the brain's go as
       * the harness says. The brain sending for itself cannot set it.
       */
      as: z.enum(["user", "brain"]).optional(),
      /** The task the session works on from this message: it becomes the session's `task`. */
      task: TaskId.optional(),
      /**
       * Clears the session's context first: `/clear` typed into a Claude session cophylad types
       * into, idle with nothing waiting, and the new context awaited. `mode` is set next, then
       * the text goes. Empty text with any of the three only prepares the session.
       */
      clear: z.boolean().optional(),
      mode: WorkMode.optional(),
    }),
    result: SendResult,
  },
  "session.spawn": {
    params: z.object({
      harness: HarnessKind,
      agent: z.string().optional(),
      workspace: WorkspaceId,
      prompt: z.string(),
      model: ModelRef.optional(),
      task: TaskId.optional(),
      /** The installation to start under; the harness's default profile on that node when absent. */
      profile: ProfileId.optional(),
      /**
       * A Claude session's mode, over the profile's launch: `bypassPermissions` starts it with
       * `--dangerously-skip-permissions`. A Codex session takes `default` or `bypassPermissions`,
       * `--dangerously-bypass-approvals-and-sandbox`, and only in a terminal. One looser than
       * asking before each edit (`sessionModeRisk` says `exec`) is never allowed by the built-in
       * rule that lets the brain start a session: it asks, unless the user's own rules say otherwise.
       */
      mode: LaunchMode.optional(),
    }),
    result: z.object({ id: SessionId }),
  },
  /** The terminals, as the client protocol's `terminal.list` has them: a row whose `harness` is set holds an agent CLI waiting at its first prompt. */
  "terminal.list": { params: Empty, result: z.object({ terminals: z.array(Terminal) }) },
  /**
   * Types a first prompt into a terminal whose agent CLI waits at its prompt with no session
   * yet, as the user would type it, and waits for the session it then becomes, which carries
   * `task`. The CLI and its terminal stay the user's.
   */
  "terminal.prompt": {
    params: z.object({ terminal: z.string(), text: z.string().min(1), task: TaskId.optional() }),
    result: z.object({ id: SessionId }),
  },
  "session.stop": {
    params: z.object({
      id: SessionId,
      /**
       * Who asked, set by a primary forwarding a stop to the node that owns the session: the
       * user may end a session of their own, the brain only one cophylad started. The brain
       * stopping one for itself cannot set it.
       */
      as: z.enum(["user", "brain"]).optional(),
    }),
    result: Empty,
  },
  /**
   * The repository a session's working directory is in, as the client protocol's `session.git`
   * has it, with its last `log` commits when asked; none outside one, or without git.
   */
  "session.git": { params: z.object({ id: SessionId, log: z.number().int().positive().max(GIT_LOG_MAX).optional() }), result: z.object({ git: GitState.optional() }) },
  /** Puts a Claude session in a permission mode, as the client protocol's `session.mode` does. */
  "session.mode": { params: z.object({ id: SessionId, mode: LaunchMode }), result: z.object({ mode: LaunchMode }) },
  "ask.answer": {
    params: z.object({ id: AskId, option: z.string(), options: z.array(z.string()).optional(), text: z.string().optional() }),
    result: Empty,
  },
  "workspace.list": { params: Empty, result: z.object({ workspaces: z.array(Workspace) }) },
  "workspace.put": {
    params: z.object({ id: WorkspaceId.optional(), node: NodeId, path: z.string(), name: z.string() }),
    result: z.object({ id: WorkspaceId }),
  },
  annotate: { params: Annotate, result: Empty },
  "task.list": { params: z.object({ filter: TaskFilter.optional() }), result: z.object({ tasks: z.array(Task) }) },
  "task.get": { params: z.object({ id: TaskId }), result: z.object({ task: Task }) },
  "task.create": { params: TaskCreate, result: z.object({ id: TaskId }) },
  "task.update": { params: z.object({ id: TaskId, patch: TaskPatch }), result: Empty },
  "prompt.list": { params: Empty, result: z.object({ prompts: z.array(PromptMeta) }) },
  "prompt.search": { params: z.object({ query: z.string() }), result: z.object({ prompts: z.array(PromptMeta) }) },
  "prompt.read": { params: z.object({ name: z.string() }), result: z.object({ prompt: Prompt }) },
  "prompt.write": { params: PromptWrite, result: Empty },
  "prompt.delete": { params: z.object({ name: z.string() }), result: Empty },
  "memory.list": { params: Empty, result: z.object({ memories: z.array(MemoryMeta) }) },
  "memory.read": { params: z.object({ name: z.string() }), result: z.object({ memory: Memory }) },
  "memory.write": { params: MemoryWrite, result: Empty },
  "memory.delete": { params: z.object({ name: z.string() }), result: Empty },
  "event.list": { params: Empty, result: z.object({ events: z.array(EventDefinition) }) },
  "event.history": {
    params: z.object({ name: z.string().optional(), node: NodeId.optional(), range: TimeRange.optional() }),
    result: z.object({ events: z.array(EventRecord) }),
  },
  "tool.list": { params: Empty, result: z.object({ tools: z.array(ToolDefinition) }) },
  "tool.run": {
    params: z.object({ name: z.string(), args: z.unknown(), node: NodeId.optional() }),
    result: z.object({ result: z.unknown() }),
  },
  recall: {
    params: z.object({
      query: z.string(),
      in: z.array(RecallIn).optional(),
      /** Owner filters, joined at query time; a memory hit answers only to `in`, `since`/`until` and `tags`. */
      workspace: WorkspaceId.optional().describe("the owning thread's or session's workspace; memory ignores it"),
      node: NodeId.optional().describe("the owning session's node; threads and memory ignore it"),
      harness: HarnessKind.optional().describe("the owning session's harness; threads and memory ignore it"),
      session: SessionId.optional().describe("one session's events; threads and memory ignore it"),
      thread: ThreadId.optional().describe("one thread's messages; sessions and memory ignore it"),
      task: TaskId.optional().describe("the owning session's task; threads and memory ignore it"),
      since: Timestamp.optional(),
      until: Timestamp.optional(),
      tags: Tags.optional().describe("every tag, on the owner (or the memory file) or on the owner's workspace"),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({ hits: z.array(Hit) }),
  },
  /**
   * `asked` is the user's message the words answer, and `fire` the listener's fire (its count
   * after it) whose result they are: the node reads them out where that request's rule says,
   * and not at all once the user hushed it. Without either, to the last controller that spoke.
   */
  "voice.speak": {
    params: z.object({
      blocks: z.array(OutBlock),
      interrupt: z.boolean(),
      asked: MessageId.optional(),
      fire: z.object({ listener: ListenerId, n: z.number().int().positive() }).optional(),
    }),
    result: Empty,
  },
  /** `steps`: what the turn did to get here, kept with the reply. */
  "ui.say": { params: z.object({ blocks: z.array(OutBlock), steps: z.array(TurnStep).max(64).optional() }), result: z.object({ message: MessageId }) },
  "ui.ask": {
    params: z.object({
      question: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
      allowsText: z.boolean().optional(),
      task: TaskId.optional(),
    }),
    result: z.object({ answer: AskAnswer }),
  },
  "thread.start": {
    params: z.object({ topic: z.string().optional(), workspace: WorkspaceId.optional() }),
    result: z.object({ id: ThreadId }),
  },
  "thread.list": { params: z.object({ filter: ThreadFilter.optional() }), result: z.object({ threads: z.array(Thread) }) },
  "thread.history": {
    params: z.object({ id: ThreadId, ...HistoryWindow.shape }),
    result: z.object({ messages: z.array(Message) }),
  },
  "llm.complete": { params: LlmComplete, result: LlmResult },
  "compute.embed": {
    params: z.object({ texts: z.array(z.string()) }),
    result: z.object({ vectors: z.array(z.array(z.number())), model: z.string() }),
  },
  "store.get": { params: z.object({ ns: z.string(), key: z.string() }), result: z.object({ value: z.unknown() }) },
  "store.put": { params: z.object({ ns: z.string(), key: z.string(), value: z.unknown() }), result: Empty },
  "store.delete": { params: z.object({ ns: z.string(), key: z.string() }), result: Empty },
  "store.list": {
    params: z.object({ ns: z.string(), prefix: z.string().optional() }),
    result: z.object({ keys: z.array(z.string()) }),
  },
  "metrics.query": {
    params: z.object({ node: NodeId, range: TimeRange.optional() }),
    result: z.object({ samples: z.array(MetricsSample) }),
  },
  "remote.pair": { params: z.object({ node: NodeId, pin: z.string(), name: z.string().optional() }), result: Empty },
  /** One frame of a display on `node`, scaled to the node's `screenshot_width`; needs no host running. */
  "remote.screenshot": {
    params: z.object({ node: NodeId, display: z.number().int().nonnegative().optional() }),
    result: z.object({
      image: z.object({ mime: z.string(), base64: z.string() }),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      display: z.number().int().nonnegative(),
      at: Timestamp,
    }),
  },
  /** What the brain listens for beyond the user: the platform matches events against it and counts the fires. */
  "listener.add": { params: ListenerSpec, result: z.object({ listener: Listener }) },
  "listener.remove": { params: z.object({ id: ListenerId }), result: Empty },
  "listener.list": { params: Empty, result: z.object({ listeners: z.array(Listener) }) },
  /**
   * Hands the chat's own session a prompt of the brain's, typed into it as the user's are: a
   * `wake` (something it listens for, a task that is due), a `notify` (to tell the user, with
   * no tools), or the `result` of a request of its own that was held on a person. `about` is
   * why the turn runs, for the chat's progress line. One at a time: `queued` is false while
   * the session is not up, and the brain keeps the wake.
   */
  "assistant.wake": {
    params: z.object({ id: z.string().min(1).max(64), text: z.string().min(1), kind: z.enum(["wake", "notify", "result"]), about: z.string().max(200).optional() }),
    result: z.object({ queued: z.boolean() }),
  },
  cancel: { params: z.object({ id: RpcId }), result: Empty },
} as const;

export type CapabilityRequestName = keyof typeof capabilityRequests;
export type CapabilityParams<N extends CapabilityRequestName> = z.infer<(typeof capabilityRequests)[N]["params"]>;
export type CapabilityResult<N extends CapabilityRequestName> = z.infer<(typeof capabilityRequests)[N]["result"]>;

// ---------------------------------------------------------------------------------------
// Requests → brain. The platform asks these of the brain for the chat's own session: what it
// is started with, the tools it may call, each call it makes, and what it is told at a
// session's start and with every prompt. They cross no gate themselves; the capability
// requests a tool makes while it runs do.

/** A picture a tool hands the model beside its text. */
export const ToolImage = z.object({ mime: z.string(), base64: z.string() });
export type ToolImage = z.infer<typeof ToolImage>;

/** A tool's result as the session's harness is handed it. */
export const ToolCallResult = z.object({ content: z.string(), isError: z.boolean().optional(), image: ToolImage.optional() });
export type ToolCallResult = z.infer<typeof ToolCallResult>;

/**
 * What the session would be told now, for the Context overlay, with nothing taken or moved:
 * its rules, the situation whole, the notes waiting for its next prompt, its tools by name,
 * and the estimated tokens of each.
 */
export const AssistantPreview = z.object({
  rules: z.string(),
  situation: z.string(),
  notes: z.array(z.string()),
  tools: z.array(z.string()),
  tokens: z.object({ rules: z.number(), situation: z.number(), tools: z.number() }),
});
export type AssistantPreview = z.infer<typeof AssistantPreview>;

export const brainRequests = {
  /** What the session is started with on a harness: its system prompt, and the short form its tool server states as instructions. */
  "assistant.setup": { params: z.object({ harness: AssistantHarness }), result: z.object({ system: z.string(), instructions: z.string() }) },
  /** The tools the session may call, as the brain declares them. */
  "tools.list": { params: Empty, result: z.object({ tools: z.array(LlmTool) }) },
  /** One call of the session's, run by the brain in the turn the last `assistant.prompted` began. */
  "tool.call": { params: z.object({ tool: z.string(), input: z.unknown() }), result: ToolCallResult },
  /**
   * What the session is told beside a prompt. `start`: at a session's start, after a clear, a
   * compaction or a resume (`source` says which), the situation whole. `prompt`: with a prompt,
   * what changed in the situation since `have`, the last answer's `seq` that reached the
   * session, or the whole of it again when that is not the brain's last. Both carry the notes
   * held for the session and what the turn's kind asks of the reply. `preview` takes nothing
   * and answers `preview` instead of `text`.
   */
  "assistant.context": {
    params: z.object({ kind: z.enum(["start", "prompt", "preview"]), source: z.string().optional(), prompt: AssistantPrompt.optional(), have: z.number().int().nonnegative().optional() }),
    result: z.object({ text: z.string(), seq: z.number().int().nonnegative().optional(), preview: AssistantPreview.optional() }),
  },
} as const;

export type BrainRequestName = keyof typeof brainRequests;
export type BrainRequestParams<N extends BrainRequestName> = z.infer<(typeof brainRequests)[N]["params"]>;
export type BrainRequestResult<N extends BrainRequestName> = z.infer<(typeof brainRequests)[N]["result"]>;

// ---------------------------------------------------------------------------------------
// Notices → brain, about a request in flight

export const LlmDelta = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), inputJson: z.string() }),
]);

export type LlmDelta = z.infer<typeof LlmDelta>;

export const capabilityNotices = {
  /** The request is waiting on a person. `at` is when it was held, for the brain's clock. */
  pending: z.object({ id: RpcId, ask: Ask, at: Timestamp.optional() }),
  /** A chunk of an `llm.complete` in flight. */
  "llm.delta": z.object({ id: RpcId, delta: LlmDelta }),
} as const;

export type CapabilityNoticeName = keyof typeof capabilityNotices;

// ---------------------------------------------------------------------------------------
// Signals → platform: what the brain says without a request. No response, no gate and no
// audit row, because a signal changes nothing: it is shown and forgotten.

/** The turn the brain is running, as the chat shows it while the user waits. */
export const TurnProgress = z.object({
  /** Why the turn runs when the user did not start it: a scheduled task, something the loop was listening for, an answer coming back. */
  about: z.string().max(200).optional(),
  /** What the turn has done so far, oldest first; the last may still be running. */
  steps: z.array(TurnStep).max(64),
  /** A model call is in flight: the loop is thinking about what to do or say next. */
  thinking: z.boolean(),
});
export type TurnProgress = z.infer<typeof TurnProgress>;

export const capabilitySignals = {
  /** The turn in progress, whole each time; `turn` absent once it is over. */
  "ui.progress": z.object({ turn: TurnProgress.optional() }),
} as const;

export type CapabilitySignalName = keyof typeof capabilitySignals;

/** Error codes the capability protocol returns, and where each comes from. */
export const capabilityErrors = {
  denied: "from the gate",
  quota_exceeded: "from the server meter",
  unavailable: "the provider is not reachable",
  cancelled: "after cancel",
} as const;
