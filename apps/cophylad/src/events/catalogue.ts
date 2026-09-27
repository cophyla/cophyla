// The event catalogue behind `event.list`: the built-in events the platform raises and the
// custom ones the hooks declare, each named by the hook that owns it. A hook may not claim
// a built-in name or another hook's; an event a hook emits without declaring is added under
// that hook with a stock description, so `event.list` is always complete. Every change
// raises `events.changed` once: a whole reload of the hooks is one batch.

import type { EditableProblem, EventDefinition, JSONSchema } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Logger } from "../log.ts";

export interface HookEvent {
  name: string;
  description: string;
  payload?: JSONSchema;
}

export interface EventCatalogueDeps {
  node: string;
  bus: Bus;
  log?: Logger;
  now?: () => number;
}

/** The events the platform itself raises, in the order `event.list` shows them. */
export function builtinEvents(node: string): EventDefinition[] {
  const def = (name: string, description: string): EventDefinition => ({ name, description, source: "builtin", node });
  return [
    def("session.discovered", "a session was attached or spawned"),
    def("session.updated", "a session recorded an event"),
    def("session.ask", "a session needs a permission, an input or a choice"),
    def("session.ended", "a session is gone"),
    def("task.ready", "a task's trigger fired or its blocker cleared"),
    def("task.updated", "a task changed"),
    def("thread.updated", "a thread changed"),
    def("workspace.updated", "a workspace changed"),
    def("user.message", "the user said something"),
    def("user.activity", "the user is typing or speaking"),
    def("voice.transcript", "what the user has said so far, while they are still speaking"),
    def("event.custom", "a hook raised an event of its own; the event's name and payload are inside"),
    def("tools.changed", "the editable tools were reloaded"),
    def("prompts.changed", "a prompt file changed"),
    def("memory.changed", "a memory file changed"),
    def("events.changed", "the hooks, and so the custom events, were reloaded"),
    def("node.pressure", "a node crossed a resource threshold"),
    def("node.joined", "a node came"),
    def("node.left", "a node went"),
    def("listener.fired", "a listener of the brain's heard what it listens for; the listener and the event that fired it are inside"),
    def("listener.removed", "a listener of the brain's is gone: spent, its task or session over, or removed"),
  ];
}

export class EventCatalogue {
  private deps: EventCatalogueDeps;
  private builtin: EventDefinition[];
  private builtinNames: Set<string>;
  /** Hook name → its events by event name. */
  private hooks = new Map<string, Map<string, HookEvent>>();
  private batching = false;
  private dirty = false;

  constructor(deps: EventCatalogueDeps) {
    this.deps = deps;
    this.builtin = builtinEvents(deps.node);
    this.builtinNames = new Set(this.builtin.map((e) => e.name));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  list(): EventDefinition[] {
    const custom: EventDefinition[] = [];
    for (const [hook, events] of this.hooks) {
      for (const e of events.values()) {
        const def: EventDefinition = { name: e.name, description: e.description, source: { hook }, node: this.deps.node };
        if (e.payload !== undefined) def.payload = e.payload;
        custom.push(def);
      }
    }
    custom.sort((a, b) => a.name.localeCompare(b.name));
    return [...this.builtin, ...custom];
  }

  has(name: string): boolean {
    return this.builtinNames.has(name) || this.ownerOf(name) !== undefined;
  }

  /** The hook that declared an event, if any. */
  ownerOf(name: string): string | undefined {
    for (const [hook, events] of this.hooks) if (events.has(name)) return hook;
    return undefined;
  }

  /**
   * Replaces a hook's declared events. A name that is built in or belongs to another hook
   * is refused and returned, so the hook's problem can say which.
   */
  setHook(hook: string, events: HookEvent[]): { refused: string[] } {
    const refused: string[] = [];
    const next = new Map<string, HookEvent>();
    for (const e of events) {
      const owner = this.ownerOf(e.name);
      if (this.builtinNames.has(e.name) || (owner !== undefined && owner !== hook)) {
        refused.push(e.name);
        continue;
      }
      next.set(e.name, e);
    }
    const before = this.hooks.get(hook);
    const same = before !== undefined && before.size === next.size && [...next.values()].every((e) => JSON.stringify(before.get(e.name)) === JSON.stringify(e));
    this.hooks.set(hook, next);
    if (!same) this.changed();
    return { refused };
  }

  removeHook(hook: string): boolean {
    if (!this.hooks.delete(hook)) return false;
    this.changed();
    return true;
  }

  /** An event a hook emits without declaring it: added under the hook. True when it was new. */
  ensure(name: string, hook: string): boolean {
    if (this.has(name)) return false;
    let events = this.hooks.get(hook);
    if (!events) {
      events = new Map();
      this.hooks.set(hook, events);
    }
    events.set(name, { name, description: `raised by the ${hook} hook` });
    this.changed();
    return true;
  }

  /**
   * Runs `fn` with every change inside it folded into one `events.changed`, sent when
   * something changed or `force` says so, carrying `problems` when given; `silent` sends
   * nothing, for the first load at start.
   */
  async batch(fn: () => void | Promise<void>, opts: { problems?: () => EditableProblem[]; force?: boolean; silent?: boolean } = {}): Promise<void> {
    this.batching = true;
    this.dirty = false;
    try {
      await fn();
    } finally {
      this.batching = false;
      const send = !opts.silent && (this.dirty || opts.force === true);
      this.dirty = false;
      if (send) {
        const problems = opts.problems?.() ?? [];
        this.deps.bus.emit("events.changed", { at: this.now(), ...(problems.length > 0 ? { problems } : {}) });
      }
    }
  }

  private changed(): void {
    if (this.batching) {
      this.dirty = true;
      return;
    }
    this.deps.bus.emit("events.changed", { at: this.now() });
  }
}
