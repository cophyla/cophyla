// A Muse session's view, the normalised record `muse serve` pages out (`view/page`) and
// pushes to a host that has the session loaded: `{method, params}` pairs, each at an opaque,
// increasing `viewCursor`. This parser turns them into normalised items and keeps the running
// stats: `session/tokenUsage` carries the session's cumulative counts, which replace rather
// than add, and `session/contextUsage` the context window's. Reasoning, reminder and subagent
// children, compactions and workflows are not recorded; a child's id is kept, so its hooks
// are known for a child's. Items arrive complete in a page; live, only `item/completed` and a
// tool call's `item/started` are read.

import type { SessionStats } from "@cophyla/protocol";

export type MuseItem =
  | { kind: "user_turn"; text: string; turnId?: string; commandId?: string; at: number }
  | { kind: "assistant_text"; text: string; turnId?: string; at: number }
  | { kind: "tool_call"; callId: string; tool: string; args: unknown; at: number }
  | { kind: "tool_result"; callId: string; tool: string; output: unknown; isError: boolean; at: number }
  | { kind: "turn_started"; turnId: string; at: number }
  | { kind: "turn_completed"; turnId: string; terminal: string; reason?: string; error?: string; at: number };

export interface MuseViewState {
  /** The last event read. */
  cursor?: string;
  stats: SessionStats;
  statsChanged: boolean;
  /** Tool calls announced, by item id. */
  calls: Set<string>;
  /** Tool calls whose result is recorded, by item id. */
  results: Set<string>;
  /** Turns started and not completed, by id. */
  open: Set<string>;
  /** Reminder and subagent children's session ids. */
  children: Set<string>;
  turnsSeen: number;
}

export function newMuseState(cursor?: string): MuseViewState {
  return {
    ...(cursor !== undefined ? { cursor } : {}),
    stats: { turns: 0, cost: 0, tokens: { in: 0, out: 0 } },
    statsChanged: false,
    calls: new Set(),
    results: new Set(),
    open: new Set(),
    children: new Set(),
    turnsSeen: 0,
  };
}

export interface ViewEvent {
  method: string;
  params: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A string that holds JSON, parsed; anything else as it is. */
export function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return v;
  }
}

const DONE = new Set(["completed", "failed", "cancelled", "rejected", "timedOut"]);

function toolItems(state: MuseViewState, item: Row, at: number, completed: boolean): MuseItem[] {
  const itemId = str(item["itemId"]);
  if (!itemId) return [];
  const callId = str(item["callId"]) ?? itemId;
  const tool = str(item["tool"]) ?? "tool";
  const out: MuseItem[] = [];
  if (!state.calls.has(itemId)) {
    state.calls.add(itemId);
    out.push({ kind: "tool_call", callId, tool, args: parseJson(item["args"]), at });
  }
  const status = str(item["status"]) ?? "";
  if (completed && DONE.has(status) && !state.results.has(itemId)) {
    state.results.add(itemId);
    const output = item["visibleOutput"] ?? item["failureReason"] ?? item["reason"] ?? null;
    out.push({ kind: "tool_result", callId, tool, output: parseJson(output), isError: status !== "completed", at });
  }
  return out;
}

/** The items one view event stands for. `now` stands in for events that carry no time of their own. */
export function applyMuseEvent(state: MuseViewState, e: ViewEvent, now: number): MuseItem[] {
  const p = e.params ?? {};
  const cursor = str(p["viewCursor"]);
  if (cursor !== undefined) state.cursor = cursor;
  switch (e.method) {
    case "item/started":
    case "item/completed": {
      const item = p["item"] as Row | undefined;
      if (!item || typeof item !== "object") return [];
      const recorded = str(item["recordedAt"]);
      const parsed = recorded !== undefined ? Date.parse(recorded) : NaN;
      const at = Number.isFinite(parsed) ? parsed : now;
      const completed = e.method === "item/completed";
      switch (item["kind"]) {
        case "userMessage": {
          if (!completed) return [];
          const text = str(item["text"]) ?? str(item["displayText"]) ?? "";
          if (!text.trim()) return [];
          const out: MuseItem = { kind: "user_turn", text, at };
          const turnId = str(item["turnId"]);
          const commandId = str(item["commandId"]);
          if (turnId) out.turnId = turnId;
          if (commandId) out.commandId = commandId;
          return [out];
        }
        case "agentMessage": {
          if (!completed) return [];
          const text = str(item["text"]) ?? "";
          if (!text.trim()) return [];
          const turnId = str(item["turnId"]);
          return [{ kind: "assistant_text", text, ...(turnId ? { turnId } : {}), at }];
        }
        case "toolCall":
          return toolItems(state, item, at, completed);
        case "reminderChild":
        case "subagent": {
          const child = str(item["childSessionId"]);
          if (child) state.children.add(child);
          return [];
        }
        default:
          return [];
      }
    }
    case "turn/started": {
      const turnId = str(p["turnId"]) ?? "";
      state.open.add(turnId);
      state.turnsSeen += 1;
      if (state.turnsSeen > state.stats.turns) {
        state.stats.turns = state.turnsSeen;
        state.statsChanged = true;
      }
      return [{ kind: "turn_started", turnId, at: now }];
    }
    case "turn/completed": {
      const turnId = str(p["turnId"]) ?? "";
      state.open.delete(turnId);
      const error = p["error"] as Row | undefined;
      const out: MuseItem = { kind: "turn_completed", turnId, terminal: str(p["terminal"]) ?? "completed", at: now };
      const reason = str(p["reason"]);
      if (reason) out.reason = reason;
      if (error && typeof error === "object" && str(error["message"])) out.error = str(error["message"])!;
      return [out];
    }
    case "session/tokenUsage": {
      const c = p["cumulative"] as Row | undefined;
      const inTokens = num(c?.["promptTokens"]);
      const outTokens = num(c?.["outputTokens"]);
      if (inTokens !== undefined && outTokens !== undefined) state.stats.tokens = { in: inTokens, out: outTokens };
      const model = str(p["modelId"]);
      if (model) state.stats.model = model;
      state.statsChanged = true;
      return [];
    }
    case "session/contextUsage": {
      const used = num(p["usedTokens"]);
      const limit = num(p["windowTokens"]);
      if (used !== undefined && limit !== undefined && limit > 0) {
        state.stats.context = { used, limit };
        state.statsChanged = true;
      }
      return [];
    }
    default:
      return [];
  }
}

export function statsFor(state: MuseViewState): SessionStats {
  const s = state.stats;
  const out: SessionStats = { turns: s.turns, cost: 0, tokens: { ...s.tokens } };
  if (s.context && s.context.limit > 0) out.context = { ...s.context };
  if (s.model !== undefined) out.model = s.model;
  return out;
}

/**
 * What of a page is real yet. A page of a session live in another process closes the turn in
 * flight as `failed`, `incomplete`, and the items still open before it; a later page has the
 * real events at those cursors. So such a page is taken only up to the item closes that end
 * it: a real close among them is only put off to the next read, which starts after the last
 * event kept.
 */
export function settledEvents(events: ViewEvent[]): ViewEvent[] {
  const last = events.at(-1);
  if (!last || last.method !== "turn/completed" || last.params["reason"] !== "incomplete") return events;
  let end = events.length - 1;
  while (end > 0 && events[end - 1]!.method === "item/completed") end--;
  return events.slice(0, end);
}

/** The time a UUIDv7 carries, in milliseconds; `undefined` for any other id (a child's is a v4). */
export function uuidv7Time(id: string): number | undefined {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id);
  if (!m) return undefined;
  return parseInt(m[1]! + m[2]!, 16);
}
