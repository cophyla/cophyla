// In-process notifications between daemon modules. The gate raises `ask.state` and
// `audit.entry`; `sessions` raises `session.state` and `session.event`; `workspaces` raises
// `workspace.state`; `chat` raises `chat.message`, `thread.state`, `user.message` and
// `user.activity`, brain-link's reply stream `chat.delta` and `chat.retract`, and the
// brain's `chat.progress`; the assistant module raises `assistant.state`; `tasks`
// raises `task.state` and `task.ready`; `update` raises `update.state`; `editable` raises
// `tools.changed`, `prompts.changed`, `memory.changed`, `events.changed` and
// `view.changed`; `voice` raises `voice.state`, `voice.transcript` and
// `voice.setup`, and a stage of it coming up raises `node.state`; its delivery `voice.next`; `metrics` raises
// `node.pressure`; `nodes` raises `node.state`, `node.joined` and `node.left`; `remote` raises
// `remote.state`; `cloud` raises `entitlement.updated` and `account.state`; the terminal rows
// raise `terminal.state`; `listeners` raises `listener.fired` and `listener.removed`. The
// api forwards the client-protocol ones to connected clients; the event stream turns the
// rest into capability events. The machine's events and each workspace node's are kept
// apart (`Bus`).

import type { Ask, AssistantState, AuditEntry, CapabilityEventParams, ClientNotificationParams, EditableProblem, Message, Node, PressureLevel, PressureResource, Session, SessionEvent, Task, TaskBlocker, Terminal, Thread, UserMessageSource, Workspace } from "@cophyla/protocol";
import type { z } from "zod";

export interface UserMessageEvent {
  at: number;
  text: string;
  source: z.infer<typeof UserMessageSource>;
  mode?: "quick";
  message: string;
  thread: string;
  /** Whether the answer is read out, by `[speech]`; absent where no delivery decides. */
  speak?: boolean;
}

export interface UserActivityEvent {
  at: number;
  state: "typing" | "speaking" | "idle";
  source: z.infer<typeof UserMessageSource>;
}

/** Text the recogniser has so far, while the user is still speaking. */
export interface VoiceTranscriptEvent {
  at: number;
  text: string;
}

export interface TaskReadyEvent {
  at: number;
  id: string;
  cause: "trigger" | "unblocked";
  /** The custom event that fired an event trigger. */
  event?: { name: string; payload: unknown };
  /** On an unblocked one: the blocker that cleared. */
  cleared?: TaskBlocker;
}

/** A resource of this node crossed a threshold, or came back under it. */
export interface PressureEvent {
  at: number;
  node: string;
  resource: z.infer<typeof PressureResource>;
  level: z.infer<typeof PressureLevel>;
}

/** An area of the editable layer was reloaded; `problems` lists the files that did not load. */
export interface ChangedEvent {
  at: number;
  problems?: EditableProblem[];
}

export interface BusEvents {
  "ask.state": Ask;
  "audit.entry": AuditEntry;
  "session.state": Session;
  /** Every stored event as it lands, `raw` dropped; not debounced, unlike `session.state`. */
  "session.event": SessionEvent;
  "terminal.state": Terminal;
  "workspace.state": Workspace;
  "chat.message": Message;
  "chat.delta": ClientNotificationParams<"chat.delta">;
  "chat.retract": ClientNotificationParams<"chat.retract">;
  /** The brain's turn in progress, relayed from its `ui.progress` signal; `turn` absent once it is over. */
  "chat.progress": ClientNotificationParams<"chat.progress">;
  /** Where the chat's own session stands, from the assistant module, whenever it changes. */
  "assistant.state": AssistantState;
  "task.state": Task;
  "task.ready": TaskReadyEvent;
  "thread.state": Thread;
  "user.message": UserMessageEvent;
  "user.activity": UserActivityEvent;
  "update.state": ClientNotificationParams<"update.state">;
  "tools.changed": ChangedEvent;
  "prompts.changed": ChangedEvent;
  "memory.changed": ChangedEvent;
  "events.changed": ChangedEvent;
  "view.changed": ClientNotificationParams<"view.changed">;
  "voice.state": ClientNotificationParams<"voice.state">;
  "voice.setup": ClientNotificationParams<"voice.setup">;
  "voice.transcript": VoiceTranscriptEvent;
  /** Whether the next reply or result is read out, and where: the speaker button's state. */
  "voice.next": ClientNotificationParams<"voice.next">;
  /** A node's desktop host, viewers or stream changed: this node's own, or a secondary's carried up. */
  "remote.state": ClientNotificationParams<"remote.state">;
  /** A node's direct connections changed: this node's own, or a secondary's carried up. */
  "direct.state": ClientNotificationParams<"direct.state">;
  /** The node's own row changed: a voice stage came up or went down, or the desktop host did. */
  "node.state": Node;
  "node.pressure": PressureEvent;
  /** A node linked to this primary, or a link was lost. */
  "node.joined": Node;
  "node.left": { node: string; at: number };
  /** A verified entitlement token arrived or was refreshed: the brain hears it as the same event. */
  "entitlement.updated": { at: number; token: string };
  /** The account as this node sees it changed: signed in or out, the plan, the link, the usage. */
  "account.state": ClientNotificationParams<"account.state">;
  /** A listener of the brain's heard what it listens for: the brain hears it as the same event. */
  "listener.fired": CapabilityEventParams<"listener.fired">;
  /** A listener is gone, whatever took it: the brain hears it as the same event. */
  "listener.removed": CapabilityEventParams<"listener.removed">;
}

type Handler<T> = (payload: T) => void;

/** The partition of the machine's own node. */
export const MACHINE = "machine";
/** A handler that hears every partition. */
const ALL = "*";

/**
 * How an event's partition is told: which node ids are a workspace node's (or were: a removed
 * one's stay private), and the node of a session, for `session.event`.
 */
export interface Partitions {
  isPrivate(node: string): boolean;
  sessionNode(id: string): string | undefined;
}

/** The bus as one workspace node's components use it: they hear and raise their own partition's events alone. */
export interface ScopedBus {
  on<K extends keyof BusEvents>(name: K, handler: Handler<BusEvents[K]>): () => void;
  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void;
}

interface Entry {
  scope: string;
  fn: Handler<never>;
}

/**
 * Split by partition, private by default. `on` hears the machine's own events alone, so every
 * consumer that sends to the machine's clients, its brain, its phones or its store is kept
 * from a workspace node's. `emit` tells an event's partition by its payload: its `node`, its
 * `id`, or, for `session.event`, the session's node. A workspace node's own components (its
 * registry, event stream and link) hear and raise through `for(node)`, whose events never
 * reach `on` whatever ids they carry. `onAll` hears every partition: for what must follow an
 * item wherever it is (a held hook released by its ask's answer). Handlers run in the order
 * they were added, across partitions.
 */
export class Bus {
  private handlers = new Map<keyof BusEvents, Set<Entry>>();
  /** Unset, every event is the machine's. */
  partitions?: Partitions;

  on<K extends keyof BusEvents>(name: K, handler: Handler<BusEvents[K]>): () => void {
    return this.add(name, MACHINE, handler);
  }

  /** Every partition's events: only for what follows an item wherever it is. */
  onAll<K extends keyof BusEvents>(name: K, handler: Handler<BusEvents[K]>): () => void {
    return this.add(name, ALL, handler);
  }

  /** One workspace node's partition. */
  for(node: string): ScopedBus {
    return {
      on: (name, handler) => this.add(name, node, handler),
      emit: (name, payload) => this.deliver(name, payload, node),
    };
  }

  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    this.deliver(name, payload, this.partitionOf(name, payload));
  }

  /** The partition an event is in, by what its payload says. */
  partitionOf<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): string {
    const p = this.partitions;
    if (!p || payload === null || typeof payload !== "object") return MACHINE;
    const o = payload as { node?: unknown; id?: unknown; session?: unknown };
    if (name === "session.event") {
      const node = typeof o.session === "string" ? p.sessionNode(o.session) : undefined;
      return node !== undefined && p.isPrivate(node) ? node : MACHINE;
    }
    if (typeof o.node === "string" && p.isPrivate(o.node)) return o.node;
    if (typeof o.id === "string" && p.isPrivate(o.id)) return o.id;
    return MACHINE;
  }

  private add<K extends keyof BusEvents>(name: K, scope: string, handler: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    const entry: Entry = { scope, fn: handler as Handler<never> };
    set.add(entry);
    return () => set!.delete(entry);
  }

  private deliver<K extends keyof BusEvents>(name: K, payload: BusEvents[K], scope: string): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) if (h.scope === ALL || h.scope === scope) (h.fn as Handler<BusEvents[K]>)(payload);
  }
}
