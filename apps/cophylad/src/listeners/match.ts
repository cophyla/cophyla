// What a listener hears: the listener kinds a capability event is, and whether a listener's
// filters take it. A session's events are read by what they say: `session.discovered` is
// `session.started`; a `session.updated` status idle is `session.idle`, or `session.waiting`
// while the session waits on its shells or the user; its assistant text is `session.said`
// and its tool call `session.tool`. A filter applies to the kinds it can: `session`,
// `workspace`, `harness`, `origin`, `node` and `task` to a session's events (`task` being the
// task the session was started for); `task`, `workspace` and `session` (a session the task is
// served by) to `task.ready`; `node` to the node events and a metric; `tool` to a tool call;
// `level` to pressure; `name` and `match` to a custom event, by name and, key by key, by
// equality with the payload's field, as a task's event trigger. Where a filter cannot apply
// it is not asked. `applies` is the same table for `listener.add`, which refuses a filter
// that applies to none of the kinds.

import type { Listener, ListenerKind, ListenerSpec, Session, SessionEvent, Task } from "@cophyla/protocol";
import type { StreamEvent } from "../events/stream.ts";

export const SESSION_KINDS: readonly ListenerKind[] = ["session.started", "session.idle", "session.waiting", "session.ask", "session.said", "session.tool", "session.ended"];

type Filter = "session" | "workspace" | "harness" | "origin" | "node" | "task" | "tool" | "level" | "name" | "match" | "metric";

/** The kinds each filter applies to. */
export const APPLIES: Record<Filter, readonly ListenerKind[]> = {
  session: [...SESSION_KINDS, "task.ready"],
  workspace: [...SESSION_KINDS, "task.ready"],
  harness: SESSION_KINDS,
  origin: SESSION_KINDS,
  node: [...SESSION_KINDS, "node.pressure", "node.joined", "node.left", "metric"],
  task: [...SESSION_KINDS, "task.ready"],
  tool: ["session.tool"],
  level: ["node.pressure"],
  name: ["custom"],
  match: ["custom"],
  metric: ["metric"],
};

/** The filters set on a listener that apply to none of the kinds it listens on. */
export function strayFilters(spec: ListenerSpec): Filter[] {
  return (Object.keys(APPLIES) as Filter[]).filter((f) => spec[f] !== undefined && !APPLIES[f].some((k) => spec.on.includes(k)));
}

export interface MatchContext {
  /** A session by id, for an event that names one only by id (`session.ask`). */
  session(id: string): Session | undefined;
  task(id: string): Task | undefined;
}

/** The kind an event is to a listener, or none; a metric is not an event, and is watched apart. */
export function kindOf(e: StreamEvent): ListenerKind | undefined {
  switch (e.name) {
    case "session.discovered":
      return "session.started";
    case "session.updated": {
      const ev = e.params.event;
      if (!ev) return undefined;
      return sessionEventKind(ev);
    }
    case "session.ask":
      return "session.ask";
    case "session.ended":
      return "session.ended";
    case "task.ready":
      return "task.ready";
    case "node.pressure":
    case "node.joined":
    case "node.left":
      return e.name;
    case "event.custom":
      return "custom";
    default:
      return undefined;
  }
}

function sessionEventKind(ev: SessionEvent): ListenerKind | undefined {
  switch (ev.kind) {
    case "status": {
      const payload = (ev.payload ?? {}) as { status?: unknown; waiting?: unknown };
      if (payload.status !== "idle") return undefined;
      return payload.waiting !== undefined && payload.waiting !== null ? "session.waiting" : "session.idle";
    }
    case "assistant_text":
      return "session.said";
    case "tool_call":
      return "session.tool";
    default:
      return undefined;
  }
}

/** The session an event is about: the row it carries, or the one its id names. */
export function sessionOf(e: StreamEvent, ctx: MatchContext): Session | undefined {
  switch (e.name) {
    case "session.discovered":
    case "session.updated":
    case "session.ended":
      return e.params.session;
    case "session.ask":
      return ctx.session(e.params.session);
    default:
      return undefined;
  }
}

/** Whether a listener hears an event: its kind is one the listener is on, and every filter that applies to the kind takes it. */
export function matches(l: Listener, e: StreamEvent, ctx: MatchContext): boolean {
  const kind = kindOf(e);
  if (kind === undefined || !l.on.includes(kind)) return false;
  if (SESSION_KINDS.includes(kind)) {
    const s = sessionOf(e, ctx);
    const id = s?.id ?? (e.name === "session.ask" ? e.params.session : undefined);
    if (l.session !== undefined && l.session !== id) return false;
    // A filter on the session's row cannot be checked without the row: it does not match.
    if (l.workspace !== undefined && s?.workspace !== l.workspace) return false;
    if (l.harness !== undefined && s?.harness !== l.harness) return false;
    if (l.origin !== undefined && s?.origin !== l.origin) return false;
    if (l.node !== undefined && s?.node !== l.node) return false;
    if (l.task !== undefined && s?.task !== l.task) return false;
    if (kind === "session.tool" && l.tool !== undefined) {
      const ev = e.name === "session.updated" ? e.params.event : undefined;
      if ((ev?.payload as { tool?: unknown } | undefined)?.tool !== l.tool) return false;
    }
    return true;
  }
  switch (e.name) {
    case "task.ready": {
      if (l.task !== undefined && e.params.id !== l.task) return false;
      if (l.workspace === undefined && l.session === undefined) return true;
      const t = ctx.task(e.params.id);
      if (l.workspace !== undefined && t?.workspace !== l.workspace) return false;
      if (l.session !== undefined && !(t?.sessions.includes(l.session) || (t?.blocker?.kind === "session" && t.blocker.session === l.session))) return false;
      return true;
    }
    case "node.pressure":
      return (l.node === undefined || e.params.node === l.node) && (l.level === undefined || e.params.level === l.level);
    case "node.joined":
      return l.node === undefined || e.params.node.id === l.node;
    case "node.left":
      return l.node === undefined || e.params.node === l.node;
    case "event.custom": {
      if (l.name !== undefined && e.params.name !== l.name) return false;
      if (!l.match) return true;
      const payload = e.params.payload !== null && typeof e.params.payload === "object" ? (e.params.payload as Record<string, unknown>) : {};
      for (const [key, want] of Object.entries(l.match)) {
        if (JSON.stringify(payload[key] ?? null) !== JSON.stringify(want ?? null)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}
