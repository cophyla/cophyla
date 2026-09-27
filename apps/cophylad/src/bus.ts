// In-process notifications between daemon modules. The gate raises `ask.state` and
// `audit.entry`; `sessions` raises `session.state` and `session.event`; `workspaces` raises
// `workspace.state`; `chat` raises `chat.message`, `thread.state`, `user.message` and
// `user.activity`, and brain-link's reply stream `chat.delta` and `chat.retract`; `tasks`
// raises `task.state` and `task.ready`; `update` raises `update.state`; `editable` raises
// `tools.changed`, `prompts.changed`, `memory.changed`, `events.changed` and
// `view.changed`; `voice` raises `voice.state`, `voice.transcript` and
// `voice.setup`, and a stage of it coming up raises `node.state`; `metrics` raises
// `node.pressure`; `nodes` raises `node.state`, `node.joined` and `node.left`; `remote` raises
// `remote.state`; `cloud` raises `entitlement.updated` and `account.state`; the terminal rows
// raise `terminal.state`; `listeners` raises `listener.fired` and `listener.removed`. The
// api forwards the client-protocol ones to connected clients; the event stream turns the
// rest into capability events.

import type { Ask, AuditEntry, CapabilityEventParams, ClientNotificationParams, EditableProblem, Message, Node, PressureLevel, PressureResource, Session, SessionEvent, Task, Terminal, Thread, UserMessageSource, Workspace } from "@cophyla/protocol";
import type { z } from "zod";

export interface UserMessageEvent {
  at: number;
  text: string;
  source: z.infer<typeof UserMessageSource>;
  mode?: "quick";
  message: string;
  thread: string;
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

export class Bus {
  private handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

  on<K extends keyof BusEvents>(name: K, handler: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) (h as Handler<BusEvents[K]>)(payload);
  }
}
