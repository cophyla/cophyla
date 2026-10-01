// The client-protocol methods the daemon serves, each behind the gate. Milestone 0 has the
// foundation's; milestone 1 adds the session, workspace and profile methods; milestone 2
// the view methods; milestone 3 chat, tasks and the signals; milestone 4 the update methods;
// milestone 7 `event.list`; milestone 8 pairing, `view.stage` and the voice methods;
// milestone 9 the metrics methods; milestone 10 the remote desktop methods; milestone 11
// the account methods; milestone 12 `relay.info` and the push registration; the explorer
// `session.files` and `session.git`; the brain's listeners as the settings show them; the
// speaker button's `voice.hush` and the `voice.presence` a client says where the user is with;
// `session.mode`; `brain.context`, what the brain sees on its next turn, behind `[brain] show_context`.

import { BrainContext, RpcError, sessionModeRisk } from "@cophyla/protocol";
import type { Client, ClientParams, ClientRequestName, ClientResult, ClientSignalName, FolderPick, Node, Principal, RelayAccess, RiskClass } from "@cophyla/protocol";
import type { z } from "zod";
import type { clientSignals } from "@cophyla/protocol";
import { DOC_FRAME_PATH } from "@cophyla/protocol";
import type { BrainLink } from "../brain-link/link.ts";
import type { Activity } from "../chat/activity.ts";
import type { Chat } from "../chat/index.ts";
import type { BackupSync } from "../cloud/backup.ts";
import type { Cloud } from "../cloud/index.ts";
import type { ProviderKeyStore } from "../cloud/provider-keys.ts";
import type { EventCatalogue } from "../events/catalogue.ts";
import type { Asks } from "../gate/asks.ts";
import type { GateContext } from "../gate/index.ts";
import { intervalFor } from "../metrics/delivery.ts";
import type { Listeners } from "../listeners/index.ts";
import type { Metrics } from "../metrics/index.ts";
import { fileSummary, listingSummary } from "../sessions/files.ts";
import type { SessionFiles } from "../sessions/files.ts";
import type { Sessions } from "../sessions/index.ts";
import type { ProfilePatch, Profiles } from "../sessions/profiles.ts";
import { profileLimits } from "../brain-link/methods.ts";
import type { LimitsReader } from "../brain-link/methods.ts";
import type { TerminalRows, TerminalStreams } from "../sessions/tether/streams.ts";
import { folderSummary } from "../sessions/tether/folders.ts";
import type { TerminalViews } from "../nodes/terminals.ts";
import type { Remote } from "../remote/index.ts";
import type { PipeHub } from "../remote/pipes.ts";
import type { Tasks } from "../tasks/index.ts";
import type { Update } from "../update/index.ts";
import type { Views } from "../views/index.ts";
import type { Delivery } from "../voice/delivery.ts";
import type { Voice } from "../voice/index.ts";
import type { Workspaces } from "../workspaces/index.ts";
import type { ClientRegistry, ListenerKind } from "./clients.ts";
import type { Grants, PushDevice } from "../grants/store.ts";
import type { Pairing } from "./pairing.ts";
import type { ViewTickets } from "./tickets.ts";

export interface MethodContext extends GateContext {
  client: Client;
  principal: Principal;
  /** The origin this client reached the node on, for a URL it must be able to fetch. */
  origin: string;
  listener: ListenerKind;
  /** The client said it shows a stream page through a forwarder of its own (`hello`'s `forward`). */
  forward?: boolean;
}

export interface Method<N extends ClientRequestName> {
  /** Names what the request acts on, for rules keyed on a target. */
  target?: (params: ClientParams<N>) => string | undefined;
  /** The params as the audit row keeps them, when one carries a secret. */
  redact?: (params: ClientParams<N>) => unknown;
  /** The result as the audit row keeps it, when the answer carries a secret (a pairing code, an invite). */
  redactResult?: (result: ClientResult<N>) => unknown;
  /** Words for the gate's ask, when the default sentence would not say what is at stake. */
  ask?: (params: ClientParams<N>) => { title: string; detail?: string };
  /** The risk of this call, when it depends on what is asked (opening a terminal to type into it). */
  risk?: (params: ClientParams<N>) => RiskClass;
  handler: (params: ClientParams<N>, ctx: MethodContext) => Promise<ClientResult<N>> | ClientResult<N>;
}

export type MethodTable = { [N in ClientRequestName]?: Method<N> };

export interface MethodDeps {
  asks: Asks;
  node: () => Node;
  /** Hands the primary role to a backup; absent in a daemon without the nodes module. */
  promote?: (id: string) => Promise<void>;
  rename?: (id: string, name: string) => Promise<void>;
  /** Stops this daemon and starts it again; throws `conflict` while busy unless forced. */
  restart?: (force: boolean, by: string) => void;
}

export function foundationMethods(deps: MethodDeps): MethodTable {
  return {
    "node.list": {
      handler: () => ({ nodes: [deps.node()] }),
    },
    "node.promote": {
      target: (p) => p.id,
      handler: async (p) => {
        if (!deps.promote) throw new RpcError("unsupported", "this node has no peers");
        await deps.promote(p.id);
        return {};
      },
    },
    "node.rename": {
      target: (p) => p.id,
      handler: async (p) => {
        if (!deps.rename) throw new RpcError("unsupported", "this node names no machine");
        await deps.rename(p.id, p.name);
        return {};
      },
    },
    "node.restart": {
      handler: (p, ctx) => {
        if (!deps.restart) throw new RpcError("unsupported", "this daemon cannot restart itself");
        deps.restart(p.force ?? false, ctx.client.id);
        return {};
      },
    },
    "ask.answer": {
      target: (p) => p.id,
      handler: (p, ctx) => {
        const input: Parameters<Asks["answer"]>[1] = { option: p.option };
        if (p.options !== undefined) input.options = p.options;
        if (p.text !== undefined) input.text = p.text;
        if (p.remember !== undefined) input.remember = p.remember;
        deps.asks.answer(p.id, input, ctx.principal);
        return {};
      },
    },
  };
}

export interface AttachDeps {
  sessions: Sessions;
  workspaces: Workspaces;
  profiles: Profiles;
  /** The profiles' plan limits, read now when old; absent where they are not read. */
  limits?: LimitsReader;
  /** This node's id: the profiles `profile.limits` answers for. */
  nodeId: string;
  /** Who hears which session's events: `session.watch` sets a client's sessions there. */
  clients: Pick<ClientRegistry, "watch">;
  /** A client's tabs changed: what is in front of the user may have. */
  onWatch?: (client: string) => void;
}

/** `profile.update`'s patch as the profiles take it: only what was sent. */
export function updatePatch(patch: ClientParams<"profile.update">["patch"]): ProfilePatch {
  const out: ProfilePatch = {};
  if (patch.usual !== undefined) out.usual = patch.usual;
  if (patch.launch !== undefined) out.launch = patch.launch === null ? null : { ...(patch.launch.mode ? { mode: patch.launch.mode } : {}), args: patch.launch.args };
  return out;
}

export function attachMethods(deps: AttachDeps): MethodTable {
  return {
    "session.list": {
      handler: () => ({ sessions: deps.sessions.list() }),
    },
    "session.history": {
      target: (p) => p.id,
      handler: (p) => ({
        events: deps.sessions.history(p.id, { ...(p.before !== undefined ? { before: p.before } : {}), ...(p.around !== undefined ? { around: p.around } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }),
      }),
    },
    "session.send": {
      target: (p) => p.id,
      handler: (p) => deps.sessions.send(p.id, p.text, { from: "user" }),
    },
    "session.focus": {
      target: (p) => p.id,
      handler: (p) => deps.sessions.focus(p.id, p.open === false ? { open: false } : {}),
    },
    "session.stop": {
      target: (p) => p.id,
      handler: async (p) => {
        await deps.sessions.stopSession(p.id, { as: "user" });
        return {};
      },
    },
    "session.mode": {
      target: (p) => p.id,
      risk: (p) => sessionModeRisk(p.mode),
      handler: (p) => deps.sessions.setMode(p.id, p.mode),
    },
    "session.watch": {
      handler: (p, ctx) => {
        deps.clients.watch(ctx.client.id, p.ids);
        deps.onWatch?.(ctx.client.id);
        return {};
      },
    },
    "workspace.list": {
      handler: () => ({ workspaces: deps.workspaces.list() }),
    },
    "workspace.put": {
      target: (p) => p.path,
      handler: (p) => ({ id: deps.workspaces.put(p).id }),
    },
    "profile.list": {
      handler: (p) => {
        deps.profiles.refresh();
        return { profiles: deps.profiles.list(p.node) };
      },
    },
    "profile.limits": {
      target: (p) => p.node,
      handler: async () => ({ limits: await profileLimits(deps.profiles, deps.limits, deps.nodeId) }),
    },
    // Another node's profile was forwarded to it before this runs.
    "profile.update": {
      target: (p) => p.id,
      handler: (p) => ({ profile: deps.profiles.update(p.id, updatePatch(p.patch)) }),
    },
  };
}

export interface FileMethodDeps {
  files: Pick<SessionFiles, "list" | "git" | "read" | "reveal">;
  /** This node: only the desktop app on it may open its file manager. */
  nodeId: string;
}

/**
 * A session's folders, its repository and a file in it, for a view's file explorer and its
 * viewer: reads, answered by the session's node (another node's session is forwarded there
 * first). The audit row keeps what was listed and how much, not every name, and which file was
 * read and how much of it, not its text. `session.reveal` opens this computer's file manager,
 * so only the desktop app on this computer may ask it, for a session of this node's: it is
 * never forwarded, and anywhere else it is `unsupported`.
 */
export function fileMethods(deps: FileMethodDeps): MethodTable {
  return {
    "session.files": {
      target: (p) => p.id,
      redactResult: (r) => listingSummary(r),
      handler: (p) => deps.files.list(p.id, p.dirs),
    },
    "session.git": {
      target: (p) => p.id,
      handler: async (p) => {
        const git = await deps.files.git(p.id, p.log);
        return git ? { git } : {};
      },
    },
    "session.file": {
      target: (p) => p.id,
      redactResult: (r) => fileSummary(r),
      handler: (p) => deps.files.read(p.id, p.path, { image: p.image === true, whole: p.whole === true, ...(p.at !== undefined ? { at: p.at } : {}) }),
    },
    "session.reveal": {
      target: (p) => p.id,
      handler: async (p, ctx) => {
        if (ctx.client.kind !== "ui" || ctx.client.node !== deps.nodeId || ctx.listener !== "loopback") throw new RpcError("unsupported", "only Cophyla on the computer that holds the file can show it in its file manager");
        await deps.files.reveal(p.id, p.path);
        return {};
      },
    },
  };
}

export interface ViewDeps {
  views: Views;
}

export function viewMethods(deps: ViewDeps): MethodTable {
  return {
    "view.list": {
      handler: () => ({ views: deps.views.list() }),
    },
    "view.get": {
      target: (p) => p.id,
      handler: (p) => deps.views.get(p.id),
    },
    "view.setDefault": {
      target: (p) => p.id,
      handler: (p) => {
        deps.views.setDefault(p.id);
        return {};
      },
    },
  };
}

export interface ChatDeps {
  chat: Chat;
}

export function chatMethods(deps: ChatDeps): MethodTable {
  return {
    "chat.send": {
      handler: (p, ctx) => {
        const input: Parameters<Chat["userMessage"]>[0] = { text: p.text, source: ctx.client.kind === "controller" ? "controller" : "ui", client: ctx.client.id };
        if (p.mode) input.mode = p.mode;
        return { message: deps.chat.userMessage(input).id };
      },
    },
    "chat.load": {
      handler: (p) => deps.chat.load({ ...(p.before !== undefined ? { before: p.before } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) }),
    },
  };
}

export interface TaskDeps {
  tasks: Tasks;
}

export function taskMethods(deps: TaskDeps): MethodTable {
  return {
    "task.list": {
      handler: (p) => ({ tasks: deps.tasks.list(p.filter ?? {}) }),
    },
    "task.create": {
      handler: (p, ctx) => ({ id: deps.tasks.create(p, ctx.principal).id }),
    },
    "task.update": {
      target: (p) => p.id,
      handler: (p, ctx) => {
        deps.tasks.update(p.id, p.patch, ctx.principal);
        return {};
      },
    },
  };
}

export interface ListenerDeps {
  listeners?: Pick<Listeners, "list" | "remove">;
}

/** What the brain listens for, which the user sees in the settings and may take away. */
export function listenerMethods(deps: ListenerDeps): MethodTable {
  const need = () => {
    if (!deps.listeners) throw new RpcError("unsupported", "this node keeps no listeners");
    return deps.listeners;
  };
  return {
    "listener.list": { handler: () => ({ listeners: need().list() }) },
    "listener.remove": {
      target: (p) => p.id,
      handler: (p) => {
        if (!need().remove(p.id, "user")) throw new RpcError("not_found", `no listener ${p.id}`);
        return {};
      },
    },
  };
}

/** How long the brain has to build its context for the Context button. */
const PREVIEW_TIMEOUT_MS = 10_000;

export interface BrainContextDeps {
  /** `[brain] show_context`: off, no client sees the brain's context. */
  show: boolean;
  /** The link to the brain, when this node runs one. */
  brain: () => Pick<BrainLink, "request"> | undefined;
}

/** What the brain sees on its next turn, for the chat's Context button: its `context.preview`, asked for now. */
export function brainContextMethods(deps: BrainContextDeps): MethodTable {
  return {
    "brain.context": {
      // The answer is the brain's whole prompt: the audit row keeps its thread and sizes, not another copy.
      redactResult: (r) => (r.context ? { context: { thread: r.context.thread, at: r.context.at, tokens: r.context.tokens } } : r),
      handler: async (p) => {
        if (!deps.show) throw new RpcError("unsupported", "the brain's context is not shown on this node: turn on [brain] show_context in config.toml and restart it");
        if (p.check) return {};
        const brain = deps.brain();
        if (!brain) throw new RpcError("unavailable", "no brain runs on this node");
        const parsed = BrainContext.safeParse(await brain.request("context.preview", {}, PREVIEW_TIMEOUT_MS));
        if (!parsed.success) throw new RpcError("unavailable", `the brain answered context.preview with something else: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300)}`);
        return { context: parsed.data };
      },
    },
  };
}

export interface EventDeps {
  catalogue: EventCatalogue;
}

export function eventMethods(deps: EventDeps): MethodTable {
  return {
    "event.list": {
      handler: () => ({ events: deps.catalogue.list() }),
    },
  };
}

export interface UpdateDeps {
  update: Update;
}

/** `update.check` answers once the feed is evaluated; staging goes on behind it. `update.apply` needs an idle daemon. */
export function updateMethods(deps: UpdateDeps): MethodTable {
  return {
    "update.check": {
      handler: async () => {
        await deps.update.trigger("request").evaluated;
        return {};
      },
    },
    "update.apply": {
      target: (p) => (p.name !== undefined ? `${p.component ?? "model"}:${p.name}` : p.component),
      handler: async (p) => {
        await deps.update.apply(p.component, p.name);
        return {};
      },
    },
  };
}

export interface PairingDeps {
  pairing: Pairing;
  grants: Grants;
  registry: ClientRegistry;
  /** The URL a phone opens for a code; the controller listener's origin with the code in the query. */
  url: (code: string) => string;
  /** The relay access for one of this node's controllers, minted through the cloud; absent in a daemon without it. */
  relayAccess?: (controller: string, name: string) => Promise<RelayAccess>;
  /** A controller was revoked: its relay grant and push device are told to the server, best effort. */
  onRevoke?: (controller: string) => void;
  /** The push module: a device registered or forgotten on a controller. */
  push?: { register(controller: string, device: PushDevice): void; unregister(controller: string): void };
  now?: () => number;
}

/** Pairing and the controllers it makes: the desktop opens a window, lists what is paired and revokes one; a phone asks for its relay access and registers for push. */
export function pairingMethods(deps: PairingDeps): MethodTable {
  const controllerOf = (ctx: MethodContext): string => {
    if (!ctx.client.controller) throw new RpcError("denied", "only a paired controller may ask this");
    return ctx.client.controller;
  };
  return {
    "pair.start": {
      // The code is for the screen that shows it, not for the audit table.
      redactResult: (r) => ({ ...r, code: "[redacted]" }),
      handler: () => deps.pairing.start(deps.url),
    },
    "controller.list": {
      handler: () => ({ controllers: deps.grants.controllers() }),
    },
    "controller.revoke": {
      target: (p) => p.id,
      handler: (p) => {
        if (!deps.grants.controller(p.id)) throw new RpcError("not_found", `no controller ${p.id}`);
        deps.grants.revoke(p.id);
        // Its token is gone; the sockets it authenticated are closed behind it, and the server forgets it.
        for (const entry of deps.registry.byController(p.id)) deps.registry.close(entry.client.id, 4401, "controller revoked");
        deps.onRevoke?.(p.id);
        return {};
      },
    },
    "relay.info": {
      handler: async (_p, ctx) => {
        const id = controllerOf(ctx);
        if (!deps.relayAccess) throw new RpcError("unavailable", "this node has no relay", { provider: "node" });
        const access = await deps.relayAccess(id, ctx.client.name ?? deps.grants.controller(id)?.name ?? id);
        deps.grants.setRelay(id, true);
        return access;
      },
    },
    "push.register": {
      redact: (p) => ({ ...p, token: "[redacted]" }),
      handler: (p, ctx) => {
        const id = controllerOf(ctx);
        const device: PushDevice = { platform: p.platform, token: p.token, registeredAt: (deps.now ?? Date.now)(), pending: true };
        deps.grants.setPush(id, device);
        deps.push?.register(id, device);
        return {};
      },
    },
    "push.unregister": {
      handler: (_p, ctx) => {
        const id = controllerOf(ctx);
        deps.grants.setPush(id, undefined);
        deps.push?.unregister(id);
        return {};
      },
    },
  };
}

export interface ViewStageDeps {
  views: Views;
  tickets: ViewTickets;
}

/** `view.stage`: the view's files, served to this client's frame under a ticket of its own. */
export function viewStageMethods(deps: ViewStageDeps): MethodTable {
  return {
    "view.stage": {
      target: (p) => p.id,
      handler: (p, ctx) => {
        const content = deps.views.get(p.id);
        const { ticket, version } = deps.tickets.stage(ctx.client.id, content);
        return { base: `${ctx.origin}/view/${ticket}/`, version, docFrame: `${ctx.origin}${DOC_FRAME_PATH}` };
      },
    },
  };
}

export interface VoiceDeps {
  voice: Voice;
  /** Where replies are read out; absent, or stopped off the primary, the button has nothing to hush. */
  speech?: Pick<Delivery, "hush" | "presence">;
}

/** Push-to-talk: the button on the controller, held and released, or let go taking back what was said; and the wake word, when the phone hears it itself. */
export function voiceMethods(deps: VoiceDeps): MethodTable {
  return {
    "voice.ptt": {
      handler: (p, ctx) => {
        if (p.cancel) deps.voice.cancel(ctx.client);
        else deps.voice.ptt(ctx.client, p.active);
        return {};
      },
    },
    "voice.wakeword": {
      handler: (p, ctx) => deps.voice.wakeword(ctx.client, p.heads),
    },
    "voice.wake": {
      handler: (p, ctx) => {
        deps.voice.wake(ctx.client, p.score, p.head, p.lead);
        return {};
      },
    },
    "voice.settings": { handler: () => deps.voice.settings() },
    "voice.configure": {
      handler: (p) =>
        deps.voice.configure({
          ...(p.tts !== undefined ? { tts: p.tts } : {}),
          ...(p.voice !== undefined ? { voice: p.voice } : {}),
          ...(p.speed !== undefined ? { speed: p.speed } : {}),
          ...(p.stt !== undefined ? { stt: p.stt } : {}),
          ...(p.sttRoute !== undefined ? { sttRoute: p.sttRoute } : {}),
          ...(p.ttsRoute !== undefined ? { ttsRoute: p.ttsRoute } : {}),
          ...(p.wake !== undefined ? { wake: p.wake } : {}),
        }),
    },
    "voice.install": { target: (p) => p.engine, handler: (p) => deps.voice.install(p.engine) },
    "voice.preview": {
      handler: (p, ctx) => {
        deps.voice.preview(ctx.client, p.text);
        return {};
      },
    },
    "voice.hush": {
      handler: (p, ctx) => {
        if (!deps.speech) throw new RpcError("unavailable", "this node reads nothing out");
        return deps.speech.hush(p.on, ctx.client);
      },
    },
  };
}

export interface MetricsMethodDeps {
  metrics: Metrics;
}

/**
 * Live samples to this client at its interval (a controller's floored at five seconds), with
 * the spend over a range as the subscription starts, and the stored history of a node. A
 * peer's node is forwarded before it gets here.
 */
export function metricsMethods(deps: MetricsMethodDeps): MethodTable {
  return {
    "metrics.subscribe": {
      target: (p) => p.node,
      handler: (p, ctx) => {
        const spend = deps.metrics.subscribe(ctx.client.id, intervalFor(ctx.client.kind, p.intervalMs), p.processes, p.spend);
        return spend ? { spend } : {};
      },
    },
    "metrics.unsubscribe": {
      handler: (_p, ctx) => {
        deps.metrics.unsubscribe(ctx.client.id);
        return {};
      },
    },
    "metrics.history": {
      target: (p) => p.node,
      handler: (p) => ({ samples: deps.metrics.history(p.node, p.range) }),
    },
  };
}

export interface RemoteMethodDeps {
  remote: Remote;
  /** The pipes a stream page's connections ride from a phone with no route to its desktop. */
  pipes?: PipeHub;
}

/** The words the host's gate uses when a viewer asks to pair: what is granted, to whom. */
export const pairAsk = (name: string | undefined): { title: string; detail: string } => ({
  title: `Let ${name ?? "a viewer"} view and control this desktop?`,
  detail: `${name ?? "A viewer"} asked to pair with this node's desktop host. Allowing gives it the screen, the mouse, the keyboard and the clipboard until it is revoked.`,
});

/** The words the gate uses when a viewer of this desktop is taken back from elsewhere: by the name the host knows it under. */
export const revokeAsk = (name: string): { title: string; detail: string } => ({
  title: `Revoke ${name}?`,
  detail: `${name} can no longer view or control this desktop until it pairs again, and a stream it has open ends.`,
});

/** The words the gate uses when sharing this desktop is switched on or off from elsewhere. */
export const shareAsk = (on: boolean): { title: string; detail: string } =>
  on
    ? {
        title: "Share this desktop?",
        detail: "Its streaming host starts, and is installed first when it is missing. Viewers still need a pairing of their own, which is asked for separately.",
      }
    : {
        title: "Stop sharing this desktop?",
        detail: "The streams going on end. Paired viewers stay paired; where the host runs as a service they can still connect to it directly until they are revoked.",
      };

/**
 * Remote desktop. `remote.pair`, `remote.invite`, `remote.revoke`, `remote.enable` and
 * `remote.disable` act on the node they name (this one without it, for the switch) and are
 * forwarded there; `remote.open` is answered by the node this socket is on, which runs the
 * viewer: a window for a desktop client, or a loopback page it shows beside its view, a
 * stream page for a controller, or with `settings` moonlight-qt's own window for the desktop
 * app on this machine; `remote.close` ends a stream it opened; `remote.pipe.open`
 * opens one connection of a stream page toward the node whose desktop it shows, for the
 * phone's own forwarder.
 */
export function remoteMethods(deps: RemoteMethodDeps): MethodTable {
  return {
    "remote.pair": {
      target: (p) => p.name,
      ask: (p) => pairAsk(p.name),
      handler: (p) => deps.remote.pair(p.pin, p.name),
    },
    "remote.invite": {
      target: (p) => p.node,
      handler: () => deps.remote.invite(),
    },
    "remote.open": {
      target: (p) => p.node,
      handler: (p, ctx) =>
        p.settings ? deps.remote.settings(ctx.client) : deps.remote.open(p.node, { client: ctx.client, origin: ctx.origin, listener: ctx.listener, forward: p.forward ?? ctx.forward === true, ...(p.embed ? { embed: true } : {}), ...(p.display ? { display: p.display } : {}) }),
    },
    "remote.close": {
      target: (p) => p.stream,
      handler: (p, ctx) => deps.remote.close(p.stream, ctx.client.id),
    },
    "remote.revoke": {
      target: (p) => p.viewer,
      handler: (p) => deps.remote.revoke(p.viewer),
    },
    "remote.enable": {
      target: (p) => p.node,
      ask: () => shareAsk(true),
      handler: () => {
        deps.remote.enable();
        return {};
      },
    },
    "remote.disable": {
      target: (p) => p.node,
      ask: () => shareAsk(false),
      handler: async () => {
        await deps.remote.disable();
        return {};
      },
    },
    "remote.pipe.open": {
      target: (p) => p.node,
      handler: async (p, ctx) => {
        const pipes = deps.pipes;
        if (!pipes) throw new RpcError("unsupported", "this node carries no pipes");
        try {
          return await pipes.openForClient(ctx.client.id, p.node);
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
        }
      },
    },
  };
}

export interface AccountMethodDeps {
  cloud: Cloud;
  /** The vendors' keys typed in the app. */
  keys: ProviderKeyStore;
}

/**
 * The account: the device-code login and the logout. The browser is opened for the desktop
 * app (a `ui` client on the loopback listener, which is on this machine); a phone or a
 * remote client gets the URL and the code to type. The audit row keeps the code redacted.
 * And the vendors' keys the user types in Settings, kept on this node; the audit row says
 * which vendor and whether a key was given, never the key, and the answer only its last four.
 */
export function accountMethods(deps: AccountMethodDeps): MethodTable {
  return {
    "account.login": {
      handler: (_p, ctx) => deps.cloud.login({ openBrowser: ctx.client.kind === "ui" && ctx.listener === "loopback" }),
    },
    "account.logout": {
      handler: async () => {
        await deps.cloud.logout();
        return {};
      },
    },
    "account.apiKey": {
      target: (p) => p.provider,
      redact: (p) => ({ provider: p.provider, key: p.apiKey === null ? "cleared" : "given" }),
      handler: (p) => deps.keys.set(p.provider, p.apiKey),
    },
  };
}

export interface BackupMethodDeps {
  sync: BackupSync;
}

/** The cloud backup: on with a passphrase (the audit row keeps it redacted), off, and a restore onto this node. */
export function backupMethods(deps: BackupMethodDeps): MethodTable {
  return {
    "backup.enable": {
      handler: async (p) => {
        await deps.sync.enable(p.passphrase, p.replace ?? false);
        return {};
      },
    },
    "backup.disable": {
      handler: async (p) => {
        await deps.sync.disable(p.forget ?? false);
        return {};
      },
    },
    "backup.restore": {
      handler: async (p) => {
        await deps.sync.restore(p.passphrase);
        return {};
      },
    },
  };
}

export interface TerminalDeps {
  /** The rows and screens of this node's tether; none without tether, where only another node's terminals open. */
  rows?: TerminalRows;
  streams?: TerminalStreams;
  /** Reads a file under the folder a terminal started in, for `terminal.file`. */
  files?: Pick<SessionFiles, "readUnder">;
  /** Lists a folder of this computer for New terminal's picker. */
  folders: (path: string | undefined) => Promise<FolderPick>;
}

/** What starting a program in a terminal asks the user, here and on a node the request was forwarded to. */
export function terminalSpawnAsk(p: { argv?: string[] }): { title: string; detail?: string } {
  return p.argv ? { title: `Start ${p.argv[0]} in a terminal?`, detail: p.argv.join(" ") } : { title: "Start a shell in a terminal?" };
}

/**
 * The node's terminals; another node's are forwarded to it (nodes/forward.ts). Watching one
 * is a read; typing into it or ending it is `exec`, and so is starting a program in one: raw
 * keys reach what `session.send` cannot. Listing a folder for the picker is a read, under the
 * terminal's scope: a shell started there reaches as far.
 */
export function terminalMethods(deps: TerminalDeps): MethodTable {
  const tether = () => {
    if (!deps.rows || !deps.streams) throw new RpcError("unsupported", "tether is not on this node");
    return { rows: deps.rows, streams: deps.streams };
  };
  return {
    "terminal.list": {
      handler: () => ({ terminals: deps.rows?.list() ?? [] }),
    },
    "terminal.spawn": {
      target: (p) => p.argv?.[0],
      ask: (p) => terminalSpawnAsk(p),
      handler: async (p) => ({ terminal: await tether().rows.spawn(p) }),
    },
    "terminal.open": {
      target: (p) => p.terminal,
      risk: (p) => (p.input || p.drive ? "exec" : "read"),
      handler: (p, ctx) => tether().streams.open(ctx.client.id, p.terminal, { ...(p.input !== undefined ? { input: p.input } : {}), ...(p.drive ? { drive: p.drive } : {}) }),
    },
    "terminal.close": {
      target: (p) => p.terminal,
      risk: (p) => (p.end ? "exec" : "read"),
      handler: async (p, ctx) => {
        await tether().streams.close(ctx.client.id, p.terminal, p.end === true);
        return {};
      },
    },
    // A file under the folder the terminal started in, for the viewer of its tab; audited as a session's file is, without the text.
    "terminal.file": {
      target: (p) => p.terminal,
      redactResult: (r) => fileSummary(r),
      handler: (p) => {
        const row = deps.rows?.list().find((t) => t.id === p.terminal);
        if (!row) throw new RpcError("not_found", `no terminal ${p.terminal}`);
        if (!deps.files) throw new RpcError("unsupported", "this node reads no files");
        return deps.files.readUnder(row.cwd, p.path, { image: p.image === true, whole: p.whole === true, ...(p.at !== undefined ? { at: p.at } : {}) });
      },
    },
    // The folder and how many folders it holds are audited, not their names.
    "terminal.folders": {
      target: (p) => p.path,
      redactResult: (r) => folderSummary(r),
      handler: (p) => deps.folders(p.path),
    },
  };
}

/** A signal handler: no response, no audit row. */
export type SignalHandler<N extends ClientSignalName> = (client: Client, params: z.infer<(typeof clientSignals)[N]>) => void;
export type SignalTable = { [N in ClientSignalName]?: SignalHandler<N> };

export function chatSignals(deps: { activity: Activity }): SignalTable {
  return {
    "chat.typing": (client, p) => deps.activity.typingSignal(client, p.active),
  };
}

/**
 * Keys and sizes for the terminals a client opened to type into: streams, like audio, so no
 * audit row per key; the open was audited. A terminal of another node's goes down its link.
 */
export function terminalSignals(deps: { streams?: TerminalStreams; remote?: Pick<TerminalViews, "input" | "resize"> }): SignalTable {
  return {
    "terminal.input": (client, p) => {
      if (!deps.remote?.input(client.id, p.terminal, p.data)) deps.streams?.input(client.id, p.terminal, p.data);
    },
    "terminal.resize": (client, p) => {
      const size = { cols: p.cols, rows: p.rows };
      if (!deps.remote?.resize(client.id, p.terminal, size)) deps.streams?.resize(client.id, p.terminal, size);
    },
  };
}

/** A stream page's bytes, window and end on the pipes a phone opened: a stream, so no audit row per frame; the open was audited. */
export function pipeSignals(deps: { pipes: PipeHub }): SignalTable {
  return {
    "remote.pipe.data": (client, p) => deps.pipes.data(`client:${client.id}`, p.pipe, p.data),
    "remote.pipe.ack": (client, p) => deps.pipes.ack(`client:${client.id}`, p.pipe, p.bytes),
    "remote.pipe.close": (client, p) => deps.pipes.closed(`client:${client.id}`, p.pipe, p.reason),
  };
}

/** Microphone audio from a controller, and where the user is: streams, so no response and no audit row per frame. */
export function voiceSignals(deps: VoiceDeps): SignalTable {
  return {
    "voice.audio": (client, p) => deps.voice.onAudio(client, p),
    "voice.played": (client, p) => deps.voice.onPlayed(client, p),
    "voice.presence": (client, p) => deps.speech?.presence(client, p),
  };
}
