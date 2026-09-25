// Hooks: `~/.cophyla/hooks/<name>.ts` exports `{name?, events?, on}`. `on.start(ctx)` runs when
// the hook is loaded and may return a disposer for when it is unloaded; every other key of
// `on` is an event name, built in or custom, whose handler gets `(payload, ctx)`. A hook
// raises its own events with `ctx.emit(name, payload)`, which reach the brain as
// `event.custom`, the other hooks, the task triggers and the history; the events it
// declares in `events` are listed in `event.list` under its name, and one it emits without
// declaring is added there with a stock description. A hook never hears its own emit; an
// emit made while handling an emit carries a depth, and past the cap it is dropped, so two
// hooks answering each other stop; a hook that emits in a burst is throttled. Handlers run
// detached: a throw is logged and the next handler still runs. Hooks run in the daemon, with
// its rights: loading one is never gated, and the README says so.

import type { EventCatalogue, HookEvent } from "../events/catalogue.ts";
import { eventKey } from "../events/stream.ts";
import type { EventStream } from "../events/stream.ts";
import type { Logger } from "../log.ts";
import { NAME } from "./files.ts";
import { stemOf } from "./modules.ts";
import { TOOL_NAME } from "./tools.ts";

export interface HookContext {
  emit(name: string, payload?: unknown): void;
  log: Logger;
  home: string;
  node: string;
}

type Handler = (payload: unknown, ctx: HookContext) => unknown;
type Starter = (ctx: HookContext) => unknown;

interface Loaded {
  name: string;
  file: string;
  events: HookEvent[];
  handlers: Map<string, Handler>;
  dispose?: () => unknown;
  /** Emit times inside the burst window. */
  emits: number[];
  burstWarnedAt?: number;
  undeclared: Set<string>;
}

export interface HooksDeps {
  stream: EventStream;
  catalogue: EventCatalogue;
  log: Logger;
  home: string;
  node: string;
  now?: () => number;
}

export type LoadedHook = { hook: { name: string; events: string[] } } | { problem: string };

/** An emit made while handling an emit made while handling… stops here. */
export const MAX_EMIT_DEPTH = 8;
/** Emits one hook may make inside the window before the rest are dropped. */
export const BURST_CAP = 200;
export const BURST_WINDOW_MS = 10_000;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export class Hooks {
  private deps: HooksDeps;
  private byFile = new Map<string, Loaded>();
  private unsubscribe?: () => void;

  constructor(deps: HooksDeps) {
    this.deps = deps;
    this.unsubscribe = deps.stream.on((e) => {
      const key = eventKey(e);
      const depth = e.depth ?? 0;
      for (const hook of [...this.byFile.values()]) {
        if (e.origin === hook.name) continue;
        const handler = hook.handlers.get(key.name);
        if (!handler) continue;
        this.run(hook, key.name, () => handler(key.payload, this.context(hook, depth + 1)));
      }
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The hooks loaded now, by name. */
  list(): { name: string; file: string; events: string[] }[] {
    return [...this.byFile.values()].map((h) => ({ name: h.name, file: h.file, events: h.events.map((e) => e.name) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Loads the hook a module declares, replacing the one loaded from the same file. A module
   * that is not a hook, that takes a name or an event another hook holds, or whose `start`
   * throws, leaves nothing loaded from its file and yields a problem naming it.
   */
  async load(file: string, mod: Record<string, unknown>): Promise<LoadedHook> {
    const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
    const fail = (message: string): LoadedHook => ({ problem: `${base}: ${message}` });
    const source = isRecord(mod["default"]) ? mod["default"] : mod;
    const name = source["name"] === undefined ? stemOf(file) : source["name"];
    if (typeof name !== "string" || !NAME.test(name)) return fail("name must be lower-case letters, digits, dots, dashes or underscores");
    const on = source["on"];
    if (!isRecord(on)) return fail("export an `on` object: {start?, [event]: handler}");
    const declared = source["events"] ?? [];
    if (!Array.isArray(declared)) return fail("events must be an array of {name, description, payload?}");
    const events: HookEvent[] = [];
    for (const e of declared) {
      if (!isRecord(e) || typeof e["name"] !== "string") return fail("each event needs a string name");
      if (!TOOL_NAME.test(e["name"])) return fail(`event name ${JSON.stringify(e["name"])} must be namespaced, like my.file_arrived`);
      const description = typeof e["description"] === "string" && e["description"].trim() !== "" ? e["description"] : `raised by the ${name} hook`;
      const ev: HookEvent = { name: e["name"], description };
      if (isRecord(e["payload"])) ev.payload = e["payload"];
      events.push(ev);
    }
    const handlers = new Map<string, Handler>();
    let starter: Starter | undefined;
    for (const [key, value] of Object.entries(on)) {
      if (typeof value !== "function") return fail(`on.${key} must be a function`);
      if (key === "start") starter = value as Starter;
      else handlers.set(key, value as Handler);
    }
    for (const other of this.byFile.values()) {
      if (other.file !== file && other.name === name) return fail(`hook name ${name} is taken by ${other.file.replace(/\\/g, "/").split("/").pop()}`);
    }
    await this.unload(file);
    const { refused } = this.deps.catalogue.setHook(name, events);
    if (refused.length > 0) {
      this.deps.catalogue.removeHook(name);
      return fail(`event ${refused[0]} is built in or belongs to another hook`);
    }
    const hook: Loaded = { name, file, events, handlers, emits: [], undeclared: new Set() };
    this.byFile.set(file, hook);
    if (starter) {
      try {
        const result = await starter(this.context(hook, 0));
        if (typeof result === "function") hook.dispose = result as () => unknown;
      } catch (e) {
        this.byFile.delete(file);
        this.deps.catalogue.removeHook(name);
        return fail(`start failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { hook: { name, events: events.map((e) => e.name) } };
  }

  /** Runs the hook's disposer and forgets it and its events. False when nothing was loaded from the file. */
  async unload(file: string): Promise<boolean> {
    const hook = this.byFile.get(file);
    if (!hook) return false;
    this.byFile.delete(file);
    this.deps.catalogue.removeHook(hook.name);
    if (hook.dispose) {
      try {
        await hook.dispose();
      } catch (e) {
        this.log(hook).warn("dispose failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return true;
  }

  private log(hook: Loaded): Logger {
    return this.deps.log.child(hook.name);
  }

  private context(hook: Loaded, depth: number): HookContext {
    return {
      emit: (name, payload) => this.emit(hook, name, payload, depth),
      log: this.log(hook),
      home: this.deps.home,
      node: this.deps.node,
    };
  }

  private run(hook: Loaded, event: string, fn: () => unknown): void {
    Promise.resolve()
      .then(fn)
      .catch((e: unknown) => this.log(hook).error("handler failed", { event, error: e instanceof Error ? e.message : String(e) }));
  }

  private emit(hook: Loaded, name: string, payload: unknown, depth: number): void {
    if (!this.byFile.has(hook.file) || this.byFile.get(hook.file) !== hook) return;
    const log = this.log(hook);
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      log.warn("emit dropped: the event name must be namespaced, like my.file_arrived", { name: String(name) });
      return;
    }
    if (depth > MAX_EMIT_DEPTH) {
      log.warn("emit dropped: too deep a chain of emits", { name, depth });
      return;
    }
    const now = this.now();
    hook.emits = hook.emits.filter((t) => now - t < BURST_WINDOW_MS);
    if (hook.emits.length >= BURST_CAP) {
      if (hook.burstWarnedAt === undefined || now - hook.burstWarnedAt >= BURST_WINDOW_MS) {
        hook.burstWarnedAt = now;
        log.warn("emit dropped: over the burst cap", { name, cap: BURST_CAP, windowMs: BURST_WINDOW_MS });
      }
      return;
    }
    hook.emits.push(now);
    if (!this.deps.catalogue.has(name)) {
      this.deps.catalogue.ensure(name, hook.name);
      if (!hook.undeclared.has(name)) {
        hook.undeclared.add(name);
        log.warn("event emitted without being declared; listed with a stock description", { name });
      }
    }
    this.deps.stream.custom(name, payload, { at: now, origin: hook.name, depth });
  }

  /** Unloads every hook. */
  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const file of [...this.byFile.keys()]) await this.unload(file);
  }
}
