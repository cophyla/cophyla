// The one event stream: the daemon's bus events as capability events, plus the custom
// events hooks raise, heard by the brain's feed, the hooks, the task scheduler and the
// recorder alike. A session event becomes `session.discovered` the first time a session is
// seen and `session.updated` every time; a session whose row alone changed (an annotate
// or a new title: the intent, summary, tags or title) becomes `session.updated` without an
// `event`; a session that ended becomes `session.ended`; an open harness ask `session.ask`;
// task, thread and workspace changes their `*.updated`; a user message, the user's
// activity, a node's pressure and the editable layer's notices pass through. `custom` turns a hook's emit into
// `event.custom` with its payload as plain JSON, carrying the hook's name as `origin` so the
// hook never hears its own, and the emit depth so a ping-pong between hooks ends. Nothing is
// announced at a brain handshake: `prime` marks the live sessions known.

import type { CapabilityEventName, CapabilityEventParams, Session } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Logger } from "../log.ts";

export type StreamEvent = { [N in CapabilityEventName]: { name: N; params: CapabilityEventParams<N>; origin?: string; depth?: number } }[CapabilityEventName];

export type StreamListener = (event: StreamEvent) => void;

export interface EventStreamDeps {
  bus: Bus;
  sessions: { get(id: string): Session | undefined; list(): Session[] };
  log?: Logger;
  now?: () => number;
}

/** Bytes of JSON a custom payload may take; a bigger one is dropped with a warning. */
export const CUSTOM_PAYLOAD_CAP = 64 * 1024;

/** The fields a `session.state` alone can change that the brain shows: the ones `annotate` writes. */
const annotation = (s: Session): string => JSON.stringify([s.intent ?? null, s.summary ?? null, s.tags, s.title ?? null]);

/**
 * The name and payload a trigger or a hook handler keys on: a custom event answers to its
 * own name and payload, a built-in one to its capability name and params.
 */
export function eventKey(e: StreamEvent): { name: string; payload: unknown } {
  if (e.name === "event.custom") return { name: e.params.name, payload: e.params.payload };
  return { name: e.name, payload: e.params };
}

export class EventStream {
  private deps: EventStreamDeps;
  private known = new Set<string>();
  /** The annotation last seen per known session, so only a change is announced. */
  private annotations = new Map<string, string>();
  private listeners = new Set<StreamListener>();
  private unsubscribe: (() => void)[] = [];

  constructor(deps: EventStreamDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Subscribes to the bus; the sessions live now are known, so none is discovered at start. */
  start(live: Session[]): void {
    this.prime(live);
    const { bus } = this.deps;
    this.unsubscribe.push(
      bus.on("session.event", (event) => {
        const session = this.deps.sessions.get(event.session);
        if (!session) return;
        if (!this.known.has(session.id) && session.status !== "ended") {
          this.known.add(session.id);
          this.emit({ name: "session.discovered", params: { at: event.at, session } });
        }
        this.annotations.set(session.id, annotation(session));
        this.emit({ name: "session.updated", params: { at: event.at, session, event } });
      }),
      bus.on("session.state", (session) => {
        if (session.status === "ended") {
          if (!this.known.has(session.id)) return;
          this.known.delete(session.id);
          this.annotations.delete(session.id);
          this.emit({ name: "session.ended", params: { at: session.endedAt ?? session.lastActivity, session } });
          return;
        }
        if (!this.known.has(session.id)) return;
        const now = annotation(session);
        if (this.annotations.get(session.id) === now) return;
        this.annotations.set(session.id, now);
        this.emit({ name: "session.updated", params: { at: this.now(), session } });
      }),
      bus.on("ask.state", (ask) => {
        if (ask.status !== "open" || ask.source.kind !== "harness") return;
        this.emit({ name: "session.ask", params: { at: ask.createdAt, session: ask.source.session, ask } });
      }),
      bus.on("task.state", (task) => this.emit({ name: "task.updated", params: { at: task.updatedAt, id: task.id } })),
      bus.on("task.ready", (e) => this.emit({ name: "task.ready", params: { at: e.at, id: e.id, cause: e.cause, ...(e.event ? { event: e.event } : {}) } })),
      bus.on("thread.state", (thread) => this.emit({ name: "thread.updated", params: { at: thread.endedAt ?? this.now(), id: thread.id } })),
      bus.on("workspace.state", (w) => this.emit({ name: "workspace.updated", params: { at: w.lastActivity, id: w.id } })),
      bus.on("user.message", (m) => this.emit({ name: "user.message", params: { at: m.at, text: m.text, source: m.source, ...(m.mode ? { mode: m.mode } : {}), message: m.message, thread: m.thread } })),
      bus.on("user.activity", (a) => this.emit({ name: "user.activity", params: { at: a.at, state: a.state, source: a.source } })),
      bus.on("voice.transcript", (t) => this.emit({ name: "voice.transcript", params: { at: t.at, text: t.text } })),
      bus.on("tools.changed", (c) => this.emit({ name: "tools.changed", params: { at: c.at, ...(c.problems ? { problems: c.problems } : {}) } })),
      bus.on("prompts.changed", (c) => this.emit({ name: "prompts.changed", params: { at: c.at } })),
      bus.on("memory.changed", (c) => this.emit({ name: "memory.changed", params: { at: c.at } })),
      bus.on("events.changed", (c) => this.emit({ name: "events.changed", params: { at: c.at, ...(c.problems ? { problems: c.problems } : {}) } })),
      bus.on("node.pressure", (p) => this.emit({ name: "node.pressure", params: { at: p.at, node: p.node, resource: p.resource, level: p.level } })),
      bus.on("node.joined", (node) => this.emit({ name: "node.joined", params: { at: this.now(), node } })),
      bus.on("node.left", (e) => this.emit({ name: "node.left", params: { at: e.at, node: e.node } })),
      bus.on("entitlement.updated", (e) => this.emit({ name: "entitlement.updated", params: { at: e.at, token: e.token } })),
    );
  }

  /** At each brain handshake: the live sessions are known, so the brain is not told of them twice. */
  prime(live: Session[]): void {
    this.known = new Set(live.map((s) => s.id));
    this.annotations = new Map(live.map((s) => [s.id, annotation(s)]));
  }

  on(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** An event that happened on another node, carried up the link: heard here like one of this node's own. */
  inject(event: StreamEvent): void {
    this.emit(event);
  }

  /**
   * A custom event: the payload is stringified once, so a cycle or an oversize payload is
   * refused here and every listener gets the same plain JSON. Returns the event sent, or
   * undefined when it was dropped.
   */
  custom(name: string, payload: unknown, opts: { at?: number; origin?: string; depth?: number } = {}): StreamEvent | undefined {
    let text: string;
    try {
      text = JSON.stringify(payload === undefined ? null : payload);
    } catch (e) {
      this.deps.log?.warn("custom event dropped: payload is not JSON", { name, origin: opts.origin, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
    if (text === undefined) text = "null";
    if (text.length > CUSTOM_PAYLOAD_CAP) {
      this.deps.log?.warn("custom event dropped: payload over the cap", { name, origin: opts.origin, bytes: text.length, cap: CUSTOM_PAYLOAD_CAP });
      return undefined;
    }
    const event: StreamEvent = {
      name: "event.custom",
      params: { at: opts.at ?? this.now(), name, payload: JSON.parse(text) as unknown },
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    };
    this.emit(event);
    return event;
  }

  private emit(event: StreamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        this.deps.log?.error("event listener failed", { event: event.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.listeners.clear();
  }
}
