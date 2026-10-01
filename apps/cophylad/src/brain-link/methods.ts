// The capability-protocol methods the daemon serves the brain, each behind the gate with
// `principal: {kind: brain}`. A request is parsed against the protocol's schema, gated with
// the brain instance as its session key and the last event sent as its correlation, held
// as `pending` when the gate or a `ui.ask` waits on a person, and withdrawn by `cancel`.
// Requests that belong to later milestones answer `unsupported`.

import { RpcError, sessionModeRisk } from "@cophyla/protocol";
import type { Ask, CapabilityParams, CapabilityRequestName, CapabilityResult, LaunchMode, LlmDelta, Node, ProfileLimits, RiskClass, RpcId, Session, WorkMode } from "@cophyla/protocol";
import { annotate } from "../annotate.ts";
import type { Chat } from "../chat/index.ts";
import type { MemoryFiles } from "../editable/memory.ts";
import type { EventCatalogue } from "../events/catalogue.ts";
import type { Asks } from "../gate/asks.ts";
import type { Prompts } from "../editable/prompts.ts";
import type { GateContext } from "../gate/index.ts";
import type { Listeners } from "../listeners/index.ts";
import type { Llm } from "../llm/index.ts";
import type { Metrics } from "../metrics/index.ts";
import type { SessionFiles } from "../sessions/files.ts";
import type { Sessions } from "../sessions/index.ts";
import { MODE_WORDS } from "../sessions/claude/launch.ts";
import { pairAsk } from "../api/methods.ts";
import { RESERVED_KV_NS } from "../grants/namespaces.ts";
import type { Remote } from "../remote/index.ts";
import type { Profiles } from "../sessions/profiles.ts";
import type { Store } from "../store/index.ts";
import type { Tasks } from "../tasks/index.ts";
import type { Tools } from "../tools/index.ts";
import type { Delivery } from "../voice/delivery.ts";
import type { Voice } from "../voice/index.ts";
import type { Workspaces } from "../workspaces/index.ts";
import { expandBlocks } from "./quotes.ts";
import type { QuoteLookup } from "./quotes.ts";
import type { ReplyStream } from "./stream.ts";

export interface BrainMethodContext extends GateContext {
  id: RpcId;
  signal: AbortSignal;
  /** A chunk of a completion in flight: sent to the brain as `llm.delta`, and to the view as `chat.delta` when the request is a reply. */
  delta: (delta: LlmDelta) => void;
  /** A later model route took the completion over after deltas had gone out: the provisional text is void. */
  retry?: () => void;
  /** Called when the request waits on a person. */
  onPending: (ask: Ask) => void;
}

export interface BrainMethod<N extends CapabilityRequestName> {
  target?: (params: CapabilityParams<N>) => string | undefined;
  /** Overrides the action's static risk: `tool.run` takes the tool's own. */
  risk?: (params: CapabilityParams<N>) => RiskClass | undefined;
  /** Words for the gate's ask, when the default sentence would not say what is at stake. */
  ask?: (params: CapabilityParams<N>) => { title: string; detail?: string };
  /** The request is on something the brain started itself, which a built-in rule may allow. */
  own?: (params: CapabilityParams<N>) => boolean;
  handler: (params: CapabilityParams<N>, ctx: BrainMethodContext) => Promise<CapabilityResult<N>> | CapabilityResult<N>;
}

export type BrainMethodTable = { [N in CapabilityRequestName]?: BrainMethod<N> };

export interface BrainMethodDeps {
  node: () => Node;
  asks: Asks;
  profiles: Profiles;
  sessions: Sessions;
  workspaces: Workspaces;
  chat: Chat;
  tasks: Tasks;
  prompts: Prompts;
  memory: MemoryFiles;
  tools: Tools;
  catalogue: EventCatalogue;
  llm: Llm;
  store: Store;
  quotes: QuoteLookup;
  stream: ReplyStream;
  /** Absent on a node with no voice module: `voice.speak` is then `unsupported`. */
  voice?: Voice;
  /** Where a `voice.speak` that names its message or fire is read out; absent, every one goes where the last utterance came from. */
  speech?: Pick<Delivery, "target">;
  /** Absent on a node with no metrics module: `metrics.query` is then `unsupported`. */
  metrics?: Metrics;
  /** Absent on a node with no remote module: `remote.pair` and `remote.screenshot` are then `unsupported`. */
  remote?: Remote;
  /** The profiles' plan limits, read now when old; absent where they are not read, and `profile.limits` then answers none. */
  limits?: LimitsReader;
  /** The brain's listeners; absent on a node that keeps none, and `listener.*` is then `unsupported`. */
  listeners?: Listeners;
  /** The sessions' repositories, for `session.git`; absent, it is `unsupported`. */
  files?: Pick<SessionFiles, "git">;
}

/** What `profile.limits` reads: `PlanLimits.fresh`. */
export interface LimitsReader {
  fresh(ids: readonly string[]): Promise<Record<string, ProfileLimits>>;
}

/** This node's profiles' plan limits, read now where the last reading is old. */
export async function profileLimits(profiles: Profiles, limits: LimitsReader | undefined, node: string): Promise<Record<string, ProfileLimits>> {
  if (!limits) return {};
  return limits.fresh(profiles.list(node).map((p) => p.id));
}

const A_HARNESS: Record<string, string> = { claude: "a Claude", codex: "a Codex", muse: "a Muse", acp: "an ACP" };

/** The spawn ask's words, for a node whose rules ask before the brain starts a session. */
export function spawnAsk(p: { harness: string; workspace: string; prompt: string }, workspace: string | undefined): { title: string; detail: string } {
  return { title: `Start ${A_HARNESS[p.harness] ?? `a ${p.harness}`} session in ${workspace ?? p.workspace}?`, detail: p.prompt };
}

/** What a session does in each mode, for the ask before the brain puts it there. */
const IN_MODE: Record<LaunchMode, string> = {
  default: "It will ask before each edit and command.",
  acceptEdits: "It will edit files without asking; commands still ask.",
  plan: "It will only read and plan, changing nothing.",
  auto: "It will act without asking, a reviewer model screening each action.",
  bypassPermissions: "It will run every tool without asking.",
  dontAsk: "It will refuse whatever is not allowed already, asking nothing.",
};

/** A session as an ask names it: its title, else its folder's name. */
function sessionName(session: Session | undefined, id: string): string {
  return session?.title ?? session?.cwd.split(/[\\/]/).filter(Boolean).pop() ?? id;
}

/**
 * The words of the ask before the brain messages a session of the user's: what will happen to
 * it, in order, and the message. One request is one decision, however many steps it takes.
 */
export function sendAsk(p: { id: string; text: string; clear?: boolean; mode?: WorkMode }, session: Session | undefined): { title: string; detail: string } {
  const steps = [...(p.clear ? ["clear its context"] : []), ...(p.mode ? [`put it in ${MODE_WORDS[p.mode]} mode`] : [])];
  const name = sessionName(session, p.id);
  const first = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (steps.length === 0) return { title: `Message ${name}?`, detail: p.text };
  if (p.text === "") return { title: `Prepare ${name}?`, detail: `${first(steps.join(", then "))}; nothing is sent.` };
  return { title: `Prepare ${name} and message it?`, detail: `${first(steps.join(", "))}, then send:\n\n${p.text}` };
}

/** The words of the ask a node's rules open before the brain changes a session's mode. */
export function modeAsk(p: { id: string; mode: LaunchMode }, session: Session | undefined): { title: string; detail: string } {
  const name = sessionName(session, p.id);
  return { title: `Put ${name} in ${MODE_WORDS[p.mode]} mode?`, detail: IN_MODE[p.mode] };
}

const unsupported = (name: string) => (): never => {
  throw new RpcError("unsupported", `${name} arrives in a later milestone`);
};

export function brainMethods(deps: BrainMethodDeps): BrainMethodTable {
  const nodeId = () => deps.node().id;
  return {
    "node.list": { handler: () => ({ nodes: [deps.node()] }) },
    // Discovery again first: it only looks at files, and a login or a first run in the seconds
    // since the last look shows now rather than at the next.
    "profile.list": {
      handler: (p) => {
        deps.profiles.refresh();
        return { profiles: deps.profiles.list(p.node) };
      },
    },
    "profile.limits": { target: (p) => p.node, handler: async () => ({ limits: await profileLimits(deps.profiles, deps.limits, nodeId()) }) },
    "session.list": { handler: (p) => ({ sessions: deps.sessions.list(p.filter ?? {}) }) },
    "session.history": {
      target: (p) => p.id,
      handler: (p) => ({
        events: deps.sessions.history(p.id, { ...(p.before !== undefined ? { before: p.before } : {}), ...(p.around !== undefined ? { around: p.around } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }),
      }),
    },
    "session.send": {
      target: (p) => p.id,
      // A session the brain started is its own to message; the user's are asked about.
      own: (p) => deps.sessions.get(p.id)?.origin === "orchestrator",
      ask: (p) => sendAsk(p, deps.sessions.get(p.id)),
      handler: (p) => deps.sessions.send(p.id, p.text, sendOptions(p, "brain")),
    },
    "session.spawn": {
      target: (p) => p.workspace,
      ask: (p) => spawnAsk(p, deps.workspaces.get(p.workspace)?.name),
      handler: async (p) => {
        if (p.harness === "acp") throw new RpcError("unsupported", "a generic ACP agent arrives in a later milestone");
        const session = await deps.sessions.spawn(
          { harness: p.harness, workspace: p.workspace, prompt: p.prompt, ...(p.model ? { model: p.model } : {}), ...(p.task !== undefined ? { task: p.task } : {}), ...(p.profile !== undefined ? { profile: p.profile } : {}), ...(p.mode !== undefined ? { mode: p.mode } : {}) },
          { profiles: deps.profiles },
        );
        const thread = deps.chat.peek();
        if (thread) deps.chat.touchSession(thread.id, session.id);
        return { id: session.id };
      },
    },
    "session.stop": {
      target: (p) => p.id,
      // A session the brain started is its own to stop; the user's are asked about.
      own: (p) => deps.sessions.get(p.id)?.origin === "orchestrator",
      handler: async (p) => {
        await deps.sessions.stopSession(p.id);
        return {};
      },
    },
    "session.git": {
      target: (p) => p.id,
      handler: async (p) => {
        if (!deps.files) throw new RpcError("unsupported", "this node reads no repositories");
        const git = await deps.files.git(p.id, p.log);
        return git ? { git } : {};
      },
    },
    "session.mode": {
      target: (p) => p.id,
      risk: (p) => sessionModeRisk(p.mode),
      ask: (p) => modeAsk(p, deps.sessions.get(p.id)),
      handler: (p) => deps.sessions.setMode(p.id, p.mode),
    },
    "ask.answer": {
      target: (p) => p.id,
      handler: (p) => {
        // `answerableBy` on the ask is what lets the brain answer it; the session that raised it settles on the state change.
        const input: { option: string; options?: string[]; text?: string } = { option: p.option };
        if (p.options !== undefined) input.options = p.options;
        if (p.text !== undefined) input.text = p.text;
        deps.asks.answer(p.id, input, { kind: "brain" });
        return {};
      },
    },
    "workspace.list": { handler: () => ({ workspaces: deps.workspaces.list() }) },
    "workspace.put": {
      target: (p) => p.path,
      handler: (p) => ({ id: deps.workspaces.put(p).id }),
    },
    annotate: {
      target: (p) => p.on,
      handler: (p) => {
        annotate(deps, p);
        return {};
      },
    },
    "task.list": { handler: (p) => ({ tasks: deps.tasks.list(p.filter ?? {}) }) },
    "task.get": { target: (p) => p.id, handler: (p) => ({ task: deps.tasks.must(p.id) }) },
    "task.create": { handler: (p) => ({ id: deps.tasks.create(p, { kind: "brain" }).id }) },
    "task.update": {
      target: (p) => p.id,
      handler: (p) => {
        deps.tasks.update(p.id, p.patch, { kind: "brain" });
        return {};
      },
    },
    "prompt.list": { handler: () => ({ prompts: deps.prompts.list() }) },
    "prompt.search": { handler: (p) => ({ prompts: deps.prompts.search(p.query) }) },
    "prompt.read": { target: (p) => p.name, handler: (p) => ({ prompt: deps.prompts.read(p.name) }) },
    "prompt.write": {
      target: (p) => p.name,
      handler: (p) => {
        deps.prompts.write(p);
        return {};
      },
    },
    "prompt.delete": {
      target: (p) => p.name,
      handler: (p) => {
        if (!deps.prompts.delete(p.name)) throw new RpcError("not_found", `no prompt ${p.name}`);
        return {};
      },
    },
    "memory.list": { handler: () => ({ memories: deps.memory.list() }) },
    "memory.read": { target: (p) => p.name, handler: (p) => ({ memory: deps.memory.read(p.name) }) },
    "memory.write": {
      target: (p) => p.name,
      handler: (p) => {
        deps.memory.write(p);
        return {};
      },
    },
    "memory.delete": {
      target: (p) => p.name,
      handler: (p) => {
        if (!deps.memory.delete(p.name)) throw new RpcError("not_found", `no memory ${p.name}`);
        return {};
      },
    },
    "event.list": { handler: () => ({ events: deps.catalogue.list() }) },
    "event.history": {
      handler: (p) => ({
        events: deps.store.events.history({
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.node !== undefined ? { node: p.node } : {}),
          ...(p.range?.from !== undefined ? { from: p.range.from } : {}),
          ...(p.range?.to !== undefined ? { to: p.range.to } : {}),
        }),
      }),
    },
    "tool.list": { handler: () => ({ tools: deps.tools.list() }) },
    "tool.run": {
      target: (p) => p.name,
      risk: (p) => deps.tools.risk(p.name),
      handler: async (p, ctx) => ({ result: await deps.tools.run(p.name, p.args, { signal: ctx.signal }) }),
    },
    // A read: allowed by the brain's class default. The whole result is audited under the cap, so its hits can be cited.
    recall: { handler: (p) => deps.store.index.recall(p).then((hits) => ({ hits })) },
    // Queued, not awaited: the reply is out as soon as the speech is on its way. One that names
    // the message it answers or the fire it reports goes where `[speech]` chose, or nowhere.
    "voice.speak": {
      handler: (p) => {
        if (!deps.voice) throw new RpcError("unsupported", "this node has no voice");
        const to = deps.speech ? deps.speech.target({ ...(p.asked !== undefined ? { asked: p.asked } : {}), ...(p.fire ? { fire: p.fire } : {}) }) : "legacy";
        if (to === undefined) return {};
        deps.voice.speak(expandBlocks(p.blocks, deps.quotes, nodeId()), { interrupt: p.interrupt, ...(to !== "legacy" ? { client: to.client } : {}) });
        return {};
      },
    },
    "ui.say": {
      handler: (p) => {
        const blocks = expandBlocks(p.blocks, deps.quotes, nodeId());
        const streamed = deps.stream.take();
        const message = deps.chat.say(blocks, { ...(streamed ? { message: streamed } : {}), ...(p.steps?.length ? { steps: p.steps } : {}) });
        return { message: message.id };
      },
    },
    "ui.ask": {
      handler: async (p, ctx) => {
        const input: Parameters<Chat["ask"]>[0] = { question: p.question, options: p.options };
        if (p.allowsText) input.allowsText = true;
        if (p.task !== undefined) input.task = p.task;
        return deps.chat.ask(input, { signal: ctx.signal, onPending: ctx.onPending });
      },
    },
    "thread.start": {
      handler: (p) => ({ id: deps.chat.startThread({ ...(p.topic !== undefined ? { topic: p.topic } : {}), ...(p.workspace !== undefined ? { workspace: p.workspace } : {}) }).id }),
    },
    "thread.list": { handler: (p) => ({ threads: deps.chat.listThreads(p.filter ?? {}) }) },
    "thread.history": {
      target: (p) => p.id,
      handler: (p) => ({ messages: deps.chat.history(p.id, { ...(p.before !== undefined ? { before: p.before } : {}), ...(p.around !== undefined ? { around: p.around } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }) }),
    },
    "llm.complete": {
      target: (p) => ("tier" in p.model ? p.model.tier : p.model.model),
      handler: async (p, ctx) => {
        const { route, ...r } = await deps.llm.complete(p, { signal: ctx.signal, onDelta: ctx.delta, ...(ctx.retry ? { onRetry: ctx.retry } : {}) });
        // Counted by the model that answered, as `vendor/model`, for the next metrics sample; the
        // hosted route counts as `server/<model>`, since the plan pays for it, not a key.
        const model = route === "server" ? `server/${r.model.slice(r.model.indexOf("/") + 1)}` : `${deps.llm.resolve(p.model).vendor}/${r.model}`;
        deps.metrics?.countLlm(model, { in: r.usage.in, out: r.usage.out });
        return r;
      },
    },
    "compute.embed": { handler: unsupported("compute.embed") },
    // The grants' namespaces are the daemon's own: a key there is a phone's or a node's secret.
    "store.get": {
      target: (p) => `${p.ns}/${p.key}`,
      handler: (p) => {
        ownNamespace(p.ns);
        const value = deps.store.kv.get(p.ns, p.key);
        return { value: value === undefined ? null : value };
      },
    },
    "store.put": {
      target: (p) => `${p.ns}/${p.key}`,
      handler: (p) => {
        ownNamespace(p.ns);
        deps.store.kv.put(p.ns, p.key, p.value ?? null);
        return {};
      },
    },
    "store.delete": {
      target: (p) => `${p.ns}/${p.key}`,
      handler: (p) => {
        ownNamespace(p.ns);
        deps.store.kv.delete(p.ns, p.key);
        return {};
      },
    },
    "store.list": {
      target: (p) => p.ns,
      handler: (p) => {
        ownNamespace(p.ns);
        return { keys: deps.store.kv.list(p.ns, p.prefix ?? "") };
      },
    },
    "metrics.query": {
      target: (p) => p.node,
      handler: (p) => {
        if (!deps.metrics) throw new RpcError("unsupported", "this node keeps no metrics");
        return { samples: deps.metrics.query(p.node, p.range) };
      },
    },
    "listener.add": {
      target: (p) => p.on.join(","),
      handler: (p) => ({ listener: listenersOf(deps).add(p) }),
    },
    "listener.remove": {
      target: (p) => p.id,
      handler: (p) => {
        if (!listenersOf(deps).remove(p.id, "brain")) throw new RpcError("not_found", `no listener ${p.id}`);
        return {};
      },
    },
    "listener.list": { handler: () => ({ listeners: listenersOf(deps).list() }) },
    // The host's own gate asks: the viewer's name is the target, so an answer can be remembered per viewer.
    "remote.pair": {
      target: (p) => p.name,
      ask: (p) => pairAsk(p.name),
      handler: (p, ctx) => {
        if (!deps.remote) throw new RpcError("unsupported", "this node has no remote module");
        return deps.remote.pair(p.pin, p.name, { signal: ctx.signal });
      },
    },
    "remote.screenshot": {
      target: (p) => p.node,
      handler: (p) => {
        if (!deps.remote) throw new RpcError("unsupported", "this node has no remote module");
        return deps.remote.screenshot(p.display);
      },
    },
    // `cancel` is served by the link itself, before the table.
  };
}

/** What a `session.send` asks of the session beyond its text, as `Sessions.send` takes it. */
export function sendOptions(p: { task?: string; clear?: boolean; mode?: WorkMode }, from: "user" | "brain"): { from: "user" | "brain"; task?: string; clear?: boolean; mode?: WorkMode } {
  return { from, ...(p.task !== undefined ? { task: p.task } : {}), ...(p.clear ? { clear: true } : {}), ...(p.mode !== undefined ? { mode: p.mode } : {}) };
}

function listenersOf(deps: { listeners?: Listeners }): Listeners {
  if (!deps.listeners) throw new RpcError("unsupported", "this node keeps no listeners");
  return deps.listeners;
}

/** Refuses a store request on a namespace the daemon keeps for itself. */
function ownNamespace(ns: string): void {
  if (RESERVED_KV_NS.includes(ns)) throw new RpcError("denied", `the ${ns} namespace is the daemon's own`);
}

/** Every request name the protocol declares has a row here, so a new one cannot be forgotten. */
type Missing = Exclude<CapabilityRequestName, keyof ReturnType<typeof brainMethods> | "cancel">;
const _missing: Missing extends never ? true : Missing = true;
void _missing;

