// The capability protocol: events flow into the brain, requests flow out, every request
// crosses a gate; a signal out changes nothing and crosses none. JSON-RPC over stdio between brain-link and the brain, and over /ws/node
// between primary and secondary. See architecture.md, "Capability protocol".

import { z } from "zod";
import {
  Ask,
  AskAnswer,
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
  /** `event` is the custom event that fired an event trigger: its name and payload, so the task can act on them. */
  "task.ready": event({ id: TaskId, cause: z.enum(["trigger", "unblocked"]), event: z.object({ name: z.string(), payload: z.unknown() }).optional() }),
  "task.updated": event({ id: TaskId }),
  "thread.updated": event({ id: ThreadId }),
  "workspace.updated": event({ id: WorkspaceId }),
  "event.custom": event({ name: z.string(), payload: z.unknown() }),
  "node.joined": event({ node: Node }),
  "node.left": event({ node: NodeId }),
  "node.pressure": event({ node: NodeId, resource: PressureResource, level: PressureLevel }),
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
});
export type LlmComplete = z.infer<typeof LlmComplete>;

export const LlmResult = z.object({
  content: z.array(LlmContent),
  stopReason: z.enum(["end", "tool_use", "max_tokens", "cancelled"]),
  usage: TokenCounts,
  model: z.string(),
});
export type LlmResult = z.infer<typeof LlmResult>;

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
    }),
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
  cancel: { params: z.object({ id: RpcId }), result: Empty },
} as const;

export type CapabilityRequestName = keyof typeof capabilityRequests;
export type CapabilityParams<N extends CapabilityRequestName> = z.infer<(typeof capabilityRequests)[N]["params"]>;
export type CapabilityResult<N extends CapabilityRequestName> = z.infer<(typeof capabilityRequests)[N]["result"]>;

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
