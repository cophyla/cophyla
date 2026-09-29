// The brain's listeners: what it hears beyond the user's messages. The brain adds one with
// `listener.add` (on which kinds of event, with which filters, delivered as a turn now, a
// note for its next turn or a notification) and removes it with `listener.remove`; the user
// sees them in the app's settings (`listener.list`) and may remove one. They live on the
// primary, one key each in the store's `listeners` namespace, so a brain restart keeps their
// counts and a backup that takes over has them; the brain's store methods refuse the
// namespace. At most `MAX_LISTENERS`.
//
// Every event on the stream is matched against them (`match.ts`). A fire counts down
// `times`, keeps `cooldownS` between fires, stamps `fired` and `lastFiredAt`, and is raised
// as `listener.fired` on the bus a microtask later, so the brain has the event itself, and
// its state from it, first; the fire that spends a listener says `last` and removes it. A
// wake or notify fire of a listener that serves a request of the user's (`asked`) says whether
// its result is read out (`speak`), as the delivery of speech decides at the fire; and every
// listener added, fired or gone is told to it, for the speaker button. A listener `until` a
// task goes when the task is done or cancelled, one `until` a session when the session ends.
// Every removal, whatever its cause, is raised as `listener.removed`.
//
// A metric listener watches its node's samples (`metric.ts`): this node's through an
// in-process watcher of the metrics module, which samples faster only while one exists,
// another node's through the link's metrics watch under the client id `listener:<id>`, its
// samples handed back through `sample`. A node that links again is watched again.
// `start` and `stop` follow the primary role, as the task scheduler does.

import { newId, Listener as ListenerSchema, RpcError } from "@cophyla/protocol";
import type { Listener, ListenerSpec, MetricsSample, Session, Task } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { EventStream, StreamEvent } from "../events/stream.ts";
import type { Logger } from "../log.ts";
import { LISTENERS_NS } from "../grants/namespaces.ts";
import type { Store } from "../store/index.ts";
import { matches, strayFilters } from "./match.ts";
import type { MatchContext } from "./match.ts";
import { intervalFor, MetricWatch } from "./metric.ts";

export { LISTENERS_NS };
export const MAX_LISTENERS = 50;
/** The metrics watch client id a listener's node is watched under. */
export const CLIENT_PREFIX = "listener:";

export type RemovedWhy = "spent" | "until" | "user" | "brain";

/** The delivery of speech, as the listeners tell it of their fires and changes. */
export interface ListenerSpeech {
  /** A wake or notify fire, the listener as it is after it: whether its result is read out; undefined when that is not asked. */
  fired(l: Listener, event: { name: string; params: Record<string, unknown> }): boolean | undefined;
  /** A listener was added, fired or removed. */
  changed(): void;
}

export interface ListenersDeps {
  store: Store;
  bus: Bus;
  stream: EventStream;
  /** This node: a metric listener that names no node watches this one. */
  nodeId: string;
  /** Whether a custom event of this name is declared: a listener on an unknown name is refused. */
  knownEvent: (name: string) => boolean;
  /** Whether a node is in the cluster; absent, only this node is known. */
  knownNode?: (id: string) => boolean;
  session: (id: string) => Session | undefined;
  task: (id: string) => Task | undefined;
  /** This node's samples; absent, or with metrics off, a metric listener on this node is refused. */
  metrics?: { enabled: boolean; watchInternal(id: string, intervalMs: number, on: (sample: MetricsSample) => void): () => void };
  /** Another node's samples, over the link. */
  remote?: { watch(client: string, node: string, intervalMs: number): Promise<unknown>; unwatch(client: string): Promise<void> };
  log: Logger;
  now?: () => number;
}

interface Watch {
  watch: MetricWatch;
  node: string;
  /** Ends this node's in-process watch; absent for a remote one, unwatched by client id. */
  off?: () => void;
}

export class Listeners {
  private deps: ListenersDeps;
  private listeners = new Map<string, Listener>();
  private watches = new Map<string, Watch>();
  private unsubscribe: (() => void)[] = [];
  private started = false;
  /** Events for the bus, raised together one microtask after the event that caused them. */
  private queued: (() => void)[] = [];
  /** Set once the delivery of speech is up. */
  speech?: ListenerSpeech;

  constructor(deps: ListenersDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- lifecycle -------------------------------------------------------------------------

  /** Loads the stored listeners, hears the stream and the tasks, and watches the metric ones. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.listeners = this.load();
    this.unsubscribe.push(
      this.deps.stream.on((e) => this.onEvent(e)),
      this.deps.bus.on("task.state", (t) => {
        if (t.status === "done" || t.status === "cancelled") this.untilSettled(t.id);
      }),
    );
    for (const l of this.listeners.values()) this.arm(l);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const id of [...this.watches.keys()]) this.disarm(id);
    this.listeners.clear();
  }

  private load(): Map<string, Listener> {
    const out = new Map<string, Listener>();
    for (const key of this.deps.store.kv.list(LISTENERS_NS)) {
      const parsed = ListenerSchema.safeParse(this.deps.store.kv.get(LISTENERS_NS, key));
      if (parsed.success) out.set(parsed.data.id, parsed.data);
      else this.deps.log.warn("stored listener unreadable; dropped", { key });
    }
    return out;
  }

  // --- the requests ------------------------------------------------------------------------

  /** The listeners, oldest first. */
  list(): Listener[] {
    const all = this.started ? [...this.listeners.values()] : [...this.load().values()];
    return all.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  get(id: string): Listener | undefined {
    return this.started ? this.listeners.get(id) : this.load().get(id);
  }

  /** A new listener, checked so the model is told what to change: the filters it can use, the metric it needs, a name that exists. */
  add(spec: ListenerSpec): Listener {
    this.validate(spec);
    const count = this.started ? this.listeners.size : this.load().size;
    if (count >= MAX_LISTENERS) throw new RpcError("conflict", `already ${MAX_LISTENERS} listeners: remove one first (listener.list shows them)`);
    const now = this.now();
    const l: Listener = { ...spec, id: newId("listener", now), createdAt: now, fired: 0 };
    // A metric watches a node: this one, named, when the listener named none.
    if (spec.on.includes("metric") && l.node === undefined) l.node = this.deps.nodeId;
    this.put(l);
    if (this.started) {
      this.listeners.set(l.id, l);
      this.arm(l);
    }
    this.deps.log.info("listener added", { id: l.id, on: l.on, deliver: l.deliver, ...(l.times !== undefined ? { times: l.times } : {}), ...(l.until ? { until: l.until } : {}), ...(l.asked ? { asked: l.asked } : {}) });
    this.speech?.changed();
    return l;
  }

  /** Removes a listener; false when there is none by that id. */
  remove(id: string, why: RemovedWhy): boolean {
    const known = this.get(id);
    if (!known) return false;
    this.drop(id, why);
    this.flush();
    return true;
  }

  private validate(spec: ListenerSpec): void {
    const hasMetric = spec.on.includes("metric");
    if (hasMetric && !spec.metric) throw new RpcError("invalid", "a listener on metric needs metric: {resource, above or below, forS}");
    if (spec.metric && (spec.metric.above === undefined) === (spec.metric.below === undefined)) throw new RpcError("invalid", "metric needs exactly one of above and below");
    const stray = strayFilters(spec);
    if (stray.length > 0) throw new RpcError("invalid", `${stray.join(", ")} ${stray.length === 1 ? "applies" : "apply"} to none of ${spec.on.join(", ")}: drop ${stray.length === 1 ? "it" : "them"} or listen on a kind ${stray.length === 1 ? "it applies" : "they apply"} to`);
    if (spec.name !== undefined && !this.deps.knownEvent(spec.name)) throw new RpcError("invalid", `no event named ${spec.name}: event.list names the ones the hooks raise`);
    if (spec.node !== undefined && spec.node !== this.deps.nodeId && !(this.deps.knownNode?.(spec.node) ?? false)) throw new RpcError("not_found", `no node ${spec.node} in this cluster`);
    if (hasMetric) {
      const node = spec.node ?? this.deps.nodeId;
      if (node === this.deps.nodeId && !this.deps.metrics?.enabled) throw new RpcError("unsupported", "metrics are off on this node");
      if (node !== this.deps.nodeId && !this.deps.remote) throw new RpcError("unsupported", "another node's metrics cannot be watched from here");
    }
    if (spec.until !== undefined) {
      if (spec.until.startsWith("task_")) {
        const t = this.deps.task(spec.until);
        if (!t) throw new RpcError("not_found", `no task ${spec.until}`);
        if (t.status === "done" || t.status === "cancelled") throw new RpcError("invalid", `task ${spec.until} is ${t.status} already`);
      } else if (this.deps.session(spec.until)?.status === "ended") throw new RpcError("invalid", `session ${spec.until} has ended already`);
    }
  }

  // --- matching ------------------------------------------------------------------------------

  private readonly ctx: MatchContext = {
    session: (id) => this.deps.session(id),
    task: (id) => this.deps.task(id),
  };

  private onEvent(e: StreamEvent): void {
    // A node linked again: its metric listeners watch it again (the link's watch went with the old link).
    if (e.name === "node.joined") for (const l of this.listeners.values()) if (l.on.includes("metric") && l.node === e.params.node.id) this.rewatch(l);
    for (const l of [...this.listeners.values()]) {
      if (!matches(l, e, this.ctx)) continue;
      this.fire(l, { name: e.name, params: e.params as Record<string, unknown> });
    }
    if (e.name === "session.ended") this.untilSettled(e.params.session.id);
    this.flush();
  }

  /** Counts a fire and queues its event; false when the cooldown holds it back. */
  private fire(l: Listener, event: { name: string; params: Record<string, unknown> }): boolean {
    const at = this.now();
    if (l.cooldownS !== undefined && l.lastFiredAt !== undefined && at - l.lastFiredAt < l.cooldownS * 1000) return false;
    const next: Listener = { ...l, fired: l.fired + 1, lastFiredAt: at, ...(l.times !== undefined ? { times: Math.max(0, l.times - 1) } : {}) };
    const last = next.times === 0;
    const speak = next.deliver === "note" ? undefined : this.speech?.fired(next, event);
    this.queued.push(() => this.deps.bus.emit("listener.fired", { at, listener: next, event, last, ...(speak !== undefined ? { speak } : {}) }));
    if (last) this.drop(l.id, "spent");
    else {
      this.listeners.set(l.id, next);
      this.put(next);
      this.speech?.changed();
    }
    return true;
  }

  /** The listeners `until` a task that settled or a session that ended. */
  private untilSettled(id: string): void {
    for (const l of [...this.listeners.values()]) if (l.until === id) this.drop(l.id, "until");
    this.flush();
  }

  private drop(id: string, why: RemovedWhy): void {
    this.disarm(id);
    this.listeners.delete(id);
    this.deps.store.kv.delete(LISTENERS_NS, id);
    const at = this.now();
    this.queued.push(() => this.deps.bus.emit("listener.removed", { at, id, why }));
    this.deps.log.info("listener removed", { id, why });
    this.speech?.changed();
  }

  private put(l: Listener): void {
    this.deps.store.kv.put(LISTENERS_NS, l.id, l, this.now());
  }

  /** Raises what is queued a microtask later, in order: the event that caused it reaches every listener of the stream first. */
  private flush(): void {
    if (this.queued.length === 0) return;
    const batch = this.queued;
    this.queued = [];
    queueMicrotask(() => {
      for (const emit of batch) {
        try {
          emit();
        } catch (e) {
          this.deps.log.error("listener event failed", { error: e instanceof Error ? e.message : String(e) });
        }
      }
    });
  }

  // --- metrics ---------------------------------------------------------------------------------

  private arm(l: Listener): void {
    if (!l.on.includes("metric") || !l.metric || this.watches.has(l.id)) return;
    const node = l.node ?? this.deps.nodeId;
    const w: Watch = { watch: new MetricWatch(l.metric), node };
    this.watches.set(l.id, w);
    const ms = intervalFor(l.metric.forS);
    if (node === this.deps.nodeId) {
      if (this.deps.metrics) w.off = this.deps.metrics.watchInternal(CLIENT_PREFIX + l.id, ms, (s) => this.onSample(l.id, s));
      return;
    }
    this.rewatch(l);
  }

  /** Watches another node's samples over the link; a node not linked now is watched when it joins. */
  private rewatch(l: Listener): void {
    const node = l.node;
    if (!l.metric || node === undefined || node === this.deps.nodeId || !this.deps.remote) return;
    this.deps.remote.watch(CLIENT_PREFIX + l.id, node, intervalFor(l.metric.forS)).catch((e: unknown) => this.deps.log.debug("metric listener waits for its node", { id: l.id, node, error: e instanceof Error ? e.message : String(e) }));
  }

  private disarm(id: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    this.watches.delete(id);
    if (w.off) w.off();
    else if (w.node !== this.deps.nodeId) void this.deps.remote?.unwatch(CLIENT_PREFIX + id).catch(() => undefined);
  }

  /** A sample for a watch under `listener:<id>`, from the link; false when the listener is gone, so the watch goes too. */
  sample(client: string, sample: MetricsSample): boolean {
    if (!client.startsWith(CLIENT_PREFIX)) return false;
    return this.onSample(client.slice(CLIENT_PREFIX.length), sample);
  }

  private onSample(id: string, sample: MetricsSample): boolean {
    const l = this.listeners.get(id);
    const w = this.watches.get(id);
    if (!l || !w || !l.metric) return false;
    if (sample.node !== w.node) return true;
    const value = w.watch.offer(sample);
    if (value === undefined) return true;
    const m = l.metric;
    const params = { node: sample.node, resource: m.resource, value: Math.round(value * 10) / 10, forS: m.forS, ...(m.above !== undefined ? { above: m.above } : { below: m.below }) };
    if (this.fire(l, { name: "metric", params })) w.watch.fired();
    this.flush();
    return true;
  }
}
